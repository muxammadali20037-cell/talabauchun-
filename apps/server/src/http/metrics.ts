import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps";
import { safeEqual } from "../lib/crypto";
import { resolveSession } from "../auth/sessions";

const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Minimal Prometheus exposition: request latency histograms in-process, queue/outbox/AI gauges read from Postgres at scrape time. */
export function registerMetrics(app: FastifyInstance, deps: Deps, opts: { connections?: () => number } = {}) {
  const hist = new Map<string, { buckets: number[]; sum: number; count: number }>();
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    const key = `${req.method}|${route}|${Math.floor(reply.statusCode / 100)}xx`;
    let h = hist.get(key);
    if (!h) hist.set(key, (h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
    const sec = reply.elapsedTime / 1000;
    BUCKETS.forEach((b, i) => { if (sec <= b) h!.buckets[i]!++; });
    h.sum += sec;
    h.count++;
  });

  app.get("/metrics", async (req, reply) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const tokenOk = !!deps.cfg.METRICS_TOKEN && safeEqual(token, deps.cfg.METRICS_TOKEN);
    if (!tokenOk) {
      const user = await resolveSession(deps.sql, token).catch(() => null);
      if (user?.platform_role !== "admin") return reply.status(401).send({ error: { code: "unauthorized" } });
    }
    const lines: string[] = [];
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push("# HELP talaba_http_request_duration_seconds HTTP request latency", "# TYPE talaba_http_request_duration_seconds histogram");
    for (const [key, h] of hist) {
      const [method, route, status] = key.split("|");
      const l = `method="${method}",route="${esc(route!)}",status="${status}"`;
      BUCKETS.forEach((b, i) => lines.push(`talaba_http_request_duration_seconds_bucket{${l},le="${b}"} ${h.buckets[i]}`));
      lines.push(`talaba_http_request_duration_seconds_bucket{${l},le="+Inf"} ${h.count}`, `talaba_http_request_duration_seconds_sum{${l}} ${h.sum.toFixed(6)}`, `talaba_http_request_duration_seconds_count{${l}} ${h.count}`);
    }
    const jobs = await deps.sql<{ kind: string; status: string; n: number }[]>`select kind, status, count(*)::int as n from generation_jobs where status not in ('completed','failed','cancelled') group by 1, 2`;
    lines.push("# HELP talaba_jobs_open Jobs not yet finished", "# TYPE talaba_jobs_open gauge");
    for (const j of jobs) lines.push(`talaba_jobs_open{kind="${esc(j.kind)}",status="${j.status}"} ${j.n}`);
    const [oldest] = await deps.sql<{ sec: number | null }[]>`select extract(epoch from now() - min(created_at))::int as sec from generation_jobs where status = 'queued' and run_after <= now()`;
    lines.push("# TYPE talaba_jobs_oldest_queued_seconds gauge", `talaba_jobs_oldest_queued_seconds ${oldest?.sec ?? 0}`);
    const finished = await deps.sql<{ status: string; n: number }[]>`select status, count(*)::int as n from generation_jobs where finished_at > now() - interval '5 minutes' group by 1`;
    lines.push("# TYPE talaba_jobs_finished_5m gauge");
    for (const f of finished) lines.push(`talaba_jobs_finished_5m{status="${f.status}"} ${f.n}`);
    const [outbox] = await deps.sql<{ pending: number; dead: number }[]>`select count(*) filter (where status in ('pending','sending'))::int as pending, count(*) filter (where status = 'dead' and created_at > now() - interval '1 hour')::int as dead from notifications`;
    lines.push("# TYPE talaba_outbox_pending gauge", `talaba_outbox_pending ${outbox?.pending ?? 0}`, "# TYPE talaba_outbox_dead_1h gauge", `talaba_outbox_dead_1h ${outbox?.dead ?? 0}`);
    const ai = await deps.sql<{ model: string | null; calls: number; errors: number; cost: number | null }[]>`
      select model, count(*)::int as calls, count(*) filter (where not ok)::int as errors, sum(cost_usd)::float as cost from usage_events where kind = 'ai_tokens' and created_at > now() - interval '5 minutes' group by 1`;
    lines.push("# TYPE talaba_ai_calls_5m gauge", "# TYPE talaba_ai_errors_5m gauge", "# TYPE talaba_ai_cost_usd_5m gauge");
    for (const a of ai) {
      const l = `model="${esc(a.model ?? "unknown")}"`;
      lines.push(`talaba_ai_calls_5m{${l}} ${a.calls}`, `talaba_ai_errors_5m{${l}} ${a.errors}`, `talaba_ai_cost_usd_5m{${l}} ${a.cost ?? 0}`);
    }
    lines.push("# TYPE talaba_ws_connections gauge", `talaba_ws_connections ${opts.connections?.() ?? 0}`);
    lines.push("# TYPE talaba_process_resident_bytes gauge", `talaba_process_resident_bytes ${process.memoryUsage().rss}`);
    reply.header("content-type", "text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });
}
