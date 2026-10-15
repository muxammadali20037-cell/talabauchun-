import { useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newIdempotencyKey } from "../../lib/api";
import { useMe } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { Badge, Banner, Empty, ErrorState, Field, Loading, Screen, Sheet, Toggle, toast } from "../../components/ui";

/** Operator panel. Aggregates only; every change is audited and needs a fresh sign-in (handled by the API client). */
export function AdminRoutes() {
  const me = useMe();
  if (me.user.platformRole !== "admin") return <Navigate to="/" replace />;
  return (
    <Routes>
      <Route index element={<AdminHome />} />
      <Route path="jobs" element={<Jobs />} />
      <Route path="plans" element={<Plans />} />
      <Route path="models" element={<Models />} />
      <Route path="flags" element={<Flags />} />
      <Route path="reports" element={<Reports />} />
      <Route path="tickets" element={<Tickets />} />
      <Route path="users" element={<Users />} />
      <Route path="payments" element={<Payments />} />
      <Route path="audit" element={<Audit />} />
    </Routes>
  );
}

function useAct() {
  const t = useT();
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, keys: string[][] = []) => {
    try {
      await fn();
      toast(t("common.done"));
      for (const k of keys) await qc.invalidateQueries({ queryKey: k });
    } catch (e) {
      toast(errorMessage(e, t));
    }
  };
}

type Overview = {
  users: Record<string, number>; workspaces: { groups: number; personal: number }; successRate24h: number | null;
  queue: { status: string; n: number; oldestSec: number | null }[]; timing: { kind: string; n: number; waitAvgSec: number; waitP95Sec: number; runAvgSec: number; runP95Sec: number }[];
  failures7d: { kind: string; error_code: string | null; n: number }[]; providers24h: { model: string | null; calls: number; errors: number; costUsd: number | null; p95Ms: number | null }[];
  aiCostUsd: { d1: number; d7: number; d30: number }; ocrPages30d: number; credits: Record<string, number>; payments30d: { status: string; n: number; stars: number }[];
  support: { open: number; payOpen: number }; reportsOpen: number; outbox: { pending: number; failed1d: number };
};
type Metrics = { measured: Record<string, unknown> & { firstUsefulResult: { users: number; medianMinutes: number | null; p75Minutes: number | null }; retention: { day: number; cohort: number; retained: number; rate: number | null }[]; exports30d: { format: string; ready: number; failed: number; successRate: number | null }[]; groupReuse30d: { sharedQuizzes: number; reusedQuizzes: number }; costPerCompletedJobUsd: number | null }; targets: Record<string, number> | null };

const Stat = ({ label, value }: { label: string; value: string | number | null | undefined }) => (
  <div className="card stat"><span className="caption">{label}</span><strong>{value ?? "—"}</strong></div>
);

function AdminHome() {
  const t = useT();
  const ov = useQuery({ queryKey: ["admin", "overview"], queryFn: () => api.get<Overview>("/api/admin/overview"), refetchInterval: 30_000 });
  const m = useQuery({ queryKey: ["admin", "metrics"], queryFn: () => api.get<Metrics>("/api/admin/metrics") });
  const sections = [["jobs", "⚙️"], ["reports", "🚩"], ["tickets", "💬"], ["users", "👤"], ["payments", "⭐"], ["plans", "🏷"], ["models", "🧠"], ["flags", "🎚"], ["audit", "🧾"]] as const;
  return (
    <Screen title={t("admin.title")}>
      <div className="stack-l">
        <nav className="chips" aria-label={t("admin.sections")}>
          {sections.map(([k, ico]) => <Link key={k} className="chip" to={`/admin/${k}`}>{ico} {t(`admin.nav_${k}`)}</Link>)}
        </nav>
        {ov.isLoading ? <Loading /> : ov.isError ? <ErrorState error={ov.error} onRetry={() => ov.refetch()} /> : (() => {
          const o = ov.data!;
          return (
            <>
              <section className="stack">
                <h2 className="section-title">{t("admin.usage")}</h2>
                <div className="stat-grid">
                  <Stat label={t("admin.usersTotal")} value={o.users.total} />
                  <Stat label={t("admin.active1d")} value={o.users.active_1d} />
                  <Stat label={t("admin.active7d")} value={o.users.active_7d} />
                  <Stat label={t("admin.groups")} value={o.workspaces.groups} />
                </div>
              </section>
              <section className="stack">
                <h2 className="section-title">{t("admin.jobs")}</h2>
                <div className="stat-grid">
                  <Stat label={t("admin.successRate")} value={o.successRate24h == null ? null : `${o.successRate24h}%`} />
                  <Stat label={t("admin.queue")} value={o.queue.reduce((s, q) => s + q.n, 0)} />
                  <Stat label={t("admin.oldestQueued")} value={o.queue.find((q) => q.status === "queued")?.oldestSec ?? 0} />
                  <Stat label={t("admin.outbox")} value={o.outbox.pending} />
                </div>
                {o.timing.length > 0 && (
                  <div className="scroll-x"><table className="data-table small">
                    <thead><tr><th>{t("admin.kind")}</th><th>n</th><th>{t("admin.waitP95")}</th><th>{t("admin.runP95")}</th></tr></thead>
                    <tbody>{o.timing.map((x) => <tr key={x.kind}><td>{x.kind}</td><td>{x.n}</td><td>{x.waitP95Sec}s</td><td>{x.runP95Sec}s</td></tr>)}</tbody>
                  </table></div>
                )}
                {o.failures7d.length > 0 && <p className="caption">{t("admin.topFailures")}: {o.failures7d.slice(0, 5).map((f) => `${f.kind}/${f.error_code} ×${f.n}`).join(", ")}</p>}
              </section>
              <section className="stack">
                <h2 className="section-title">{t("admin.aiAndMoney")}</h2>
                <div className="stat-grid">
                  <Stat label={t("admin.aiCost1d")} value={`$${o.aiCostUsd.d1.toFixed(2)}`} />
                  <Stat label={t("admin.aiCost30d")} value={`$${o.aiCostUsd.d30.toFixed(2)}`} />
                  <Stat label={t("admin.creditsSpent30d")} value={o.credits.spent_30d} />
                  <Stat label={t("admin.paid30d")} value={`⭐ ${o.payments30d.find((p) => p.status === "paid")?.stars ?? 0}`} />
                </div>
                {o.providers24h.map((p) => <p key={p.model ?? "?"} className="caption">{p.model}: {p.calls} · {t("admin.errors")} {p.errors} · p95 {p.p95Ms ?? "—"} ms</p>)}
              </section>
              <section className="stack">
                <h2 className="section-title">{t("admin.attention")}</h2>
                <div className="stat-grid">
                  <Link to="/admin/tickets" className="card stat card-link"><span className="caption">{t("admin.openTickets")}</span><strong>{o.support.open}</strong></Link>
                  <Link to="/admin/reports" className="card stat card-link"><span className="caption">{t("admin.openReports")}</span><strong>{o.reportsOpen}</strong></Link>
                </div>
              </section>
            </>
          );
        })()}
        {m.data && (
          <section className="stack">
            <h2 className="section-title">{t("admin.product")}</h2>
            <p className="caption">{t("admin.measuredNote")}</p>
            <div className="stat-grid">
              <Stat label={t("admin.firstResultMedian")} value={m.data.measured.firstUsefulResult.medianMinutes == null ? null : `${m.data.measured.firstUsefulResult.medianMinutes} min`} />
              <Stat label={t("admin.publishedQuizzes")} value={m.data.measured.published_quizzes_30d as number} />
              <Stat label={t("admin.finishedAttempts")} value={m.data.measured.finished_attempts_30d as number} />
              <Stat label={t("admin.costPerJob")} value={m.data.measured.costPerCompletedJobUsd == null ? null : `$${m.data.measured.costPerCompletedJobUsd}`} />
            </div>
            <p className="small">{t("admin.retention")}: {m.data.measured.retention.map((r) => `D${r.day} ${r.rate == null ? "—" : r.rate + "%"} (${r.retained}/${r.cohort})`).join(" · ")}</p>
            <p className="small">{t("admin.exports")}: {m.data.measured.exports30d.map((e) => `${e.format.toUpperCase()} ${e.successRate ?? "—"}%`).join(" · ") || "—"} · {t("admin.groupReuse")}: {m.data.measured.groupReuse30d.reusedQuizzes}/{m.data.measured.groupReuse30d.sharedQuizzes}</p>
            <div className="evidence"><span className="caption">{t("admin.targets")}</span><p className="small">{m.data.targets ? Object.entries(m.data.targets).map(([k, v]) => `${k}: ${v}`).join(" · ") : t("admin.noTargets")}</p></div>
          </section>
        )}
      </div>
    </Screen>
  );
}

function Jobs() {
  const t = useT();
  const act = useAct();
  const [status, setStatus] = useState("failed");
  const q = useQuery({ queryKey: ["admin", "jobs", status], queryFn: () => api.get<{ id: string; kind: string; status: string; error_code: string | null; attempts: number; created_at: string; last_error: string | null }[]>(`/api/admin/jobs?status=${status}`) });
  return (
    <Screen title={t("admin.nav_jobs")}>
      <div className="stack">
        <select className="select" aria-label={t("admin.status")} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["failed", "queued", "generating", "extracting", "rendering", "completed", "cancelled"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {q.isLoading ? <Loading /> : !q.data?.length ? <Empty text={t("admin.nothing")} /> : (
          <div className="list">{q.data.map((j) => (
            <div key={j.id} className="list-item">
              <div className="grow">
                <div className="small"><strong>{j.kind}</strong> · {j.status} · {t("admin.attempts", { n: j.attempts })}</div>
                <div className="meta break">{new Date(j.created_at).toLocaleString()} {j.error_code ? `· ${j.error_code}` : ""}</div>
              </div>
              {j.status === "failed" && <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.post(`/api/admin/jobs/${j.id}/retry`), [["admin", "jobs", status]])}>{t("admin.retry")}</button>}
            </div>
          ))}</div>
        )}
      </div>
    </Screen>
  );
}

type PlanRow = { code: string; title: Record<string, string>; price_stars: number; credits: number; period_days: number | null; limits: Record<string, number>; active: boolean; version: number };
function Plans() {
  const t = useT();
  const q = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.get<PlanRow[]>("/api/admin/plans") });
  const [edit, setEdit] = useState<PlanRow | null>(null);
  return (
    <Screen title={t("admin.nav_plans")}>
      <div className="stack">
        <Banner kind="info">{t("admin.plansNote")}</Banner>
        {q.isLoading ? <Loading /> : q.data?.map((p) => (
          <button key={p.code} className="card stack" style={{ textAlign: "left" }} onClick={() => setEdit(p)}>
            <div className="row between"><strong>{p.title.uz ?? p.code}</strong><Badge kind={p.active ? "success" : "neutral"}>{p.active ? t("admin.active") : t("admin.inactive")} · v{p.version}</Badge></div>
            <span className="small">⭐ {p.price_stars} · {p.credits} {t("admin.credits")} · {p.period_days ?? "—"} {t("admin.days")}</span>
            <span className="caption">{Object.entries(p.limits).map(([k, v]) => `${k}=${v}`).join(", ")}</span>
          </button>
        ))}
      </div>
      {edit && <PlanSheet plan={edit} onClose={() => setEdit(null)} />}
    </Screen>
  );
}
function PlanSheet({ plan, onClose }: { plan: PlanRow; onClose: () => void }) {
  const t = useT();
  const act = useAct();
  const [price, setPrice] = useState(plan.price_stars);
  const [credits, setCredits] = useState(plan.credits);
  const [days, setDays] = useState(plan.period_days ?? 30);
  const [active, setActive] = useState(plan.active);
  const [limits, setLimits] = useState(plan.limits);
  return (
    <Sheet open onClose={onClose} title={plan.title.uz ?? plan.code}>
      <div className="stack">
        <div className="grid-2">
          <Field label={t("admin.priceStars")}>{(id) => <input id={id} className="input" type="number" min={0} value={price} disabled={plan.code === "free"} onChange={(e) => setPrice(Number(e.target.value))} />}</Field>
          <Field label={t("admin.credits")}>{(id) => <input id={id} className="input" type="number" min={0} value={credits} onChange={(e) => setCredits(Number(e.target.value))} />}</Field>
          <Field label={t("admin.days")}>{(id) => <input id={id} className="input" type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} />}</Field>
          {Object.entries(limits).map(([k, v]) => <Field key={k} label={k}>{(id) => <input id={id} className="input" type="number" min={0} value={v} onChange={(e) => setLimits({ ...limits, [k]: Number(e.target.value) })} />}</Field>)}
        </div>
        <Toggle label={t("admin.activeForSale")} checked={active} onChange={setActive} />
        <p className="caption">{t("admin.versionNote")}</p>
        <button className="btn btn-primary btn-block" onClick={() => act(() => api.put(`/api/admin/plans/${plan.code}`, { priceStars: price, credits, periodDays: days, active, limits }), [["admin", "plans"]]).then(onClose)}>{t("common.save")}</button>
      </div>
    </Sheet>
  );
}

function Models() {
  const t = useT();
  const act = useAct();
  const q = useQuery({ queryKey: ["admin", "models"], queryFn: () => api.get<{ task: string; override: { model: string; effort: string | null; max_tokens: number; enabled: boolean; previous: { model: string } | null } | null; default: { strong: string; fast: string } }[]>("/api/admin/models") });
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <Screen title={t("admin.nav_models")}>
      <div className="stack">
        <p className="caption">{t("admin.modelsNote")}</p>
        {q.isLoading ? <Loading /> : q.data?.map((m) => (
          <article key={m.task} className="card stack">
            <div className="row between wrap"><strong>{m.task}</strong>{m.override ? <Badge kind={m.override.enabled ? "primary" : "danger"}>{m.override.enabled ? m.override.model : t("admin.disabled")}</Badge> : <Badge kind="neutral">{t("admin.default")}</Badge>}</div>
            <div className="row wrap">
              <input className="input grow" aria-label={t("admin.model")} placeholder={m.override?.model ?? m.default.strong} value={draft[m.task] ?? ""} onChange={(e) => setDraft({ ...draft, [m.task]: e.target.value })} />
              <button className="btn btn-secondary btn-sm" disabled={!draft[m.task]} onClick={() => act(() => api.put(`/api/admin/models/${m.task}`, { model: draft[m.task] }), [["admin", "models"]])}>{t("common.save")}</button>
            </div>
            <div className="row wrap">
              {m.override?.enabled !== false && <button className="btn btn-danger btn-sm" onClick={() => act(() => api.put(`/api/admin/models/${m.task}`, { model: m.override?.model ?? m.default.strong, enabled: false }), [["admin", "models"]])}>{t("admin.switchOff")}</button>}
              {m.override && <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post(`/api/admin/models/${m.task}/rollback`), [["admin", "models"]])}>↩ {t("admin.rollback")}{m.override.previous ? ` (${m.override.previous.model})` : ""}</button>}
            </div>
          </article>
        ))}
      </div>
    </Screen>
  );
}

function Flags() {
  const t = useT();
  const act = useAct();
  const q = useQuery({ queryKey: ["admin", "flags"], queryFn: () => api.get<{ key: string; enabled: boolean; data: Record<string, unknown> }[]>("/api/admin/flags") });
  const keys = ["pricing", "targets", "ai_generation", "web_search", "public_templates", "signup_open"];
  const [json, setJson] = useState<Record<string, string>>({});
  return (
    <Screen title={t("admin.nav_flags")}>
      <div className="stack">
        {q.isLoading ? <Loading /> : keys.map((k) => {
          const f = q.data?.find((x) => x.key === k);
          const text = json[k] ?? JSON.stringify(f?.data ?? {});
          return (
            <article key={k} className="card stack">
              <Toggle label={k} checked={!!f?.enabled} onChange={(v) => act(() => api.put(`/api/admin/flags/${k}`, { enabled: v, data: f?.data ?? {} }), [["admin", "flags"]])} />
              <textarea className="textarea mono" rows={2} aria-label={`${k} data`} value={text} onChange={(e) => setJson({ ...json, [k]: e.target.value })} />
              <button className="btn btn-secondary btn-sm" onClick={() => {
                let data: unknown;
                try { data = JSON.parse(text); } catch { toast(t("admin.badJson")); return; }
                void act(() => api.put(`/api/admin/flags/${k}`, { enabled: !!f?.enabled, data }), [["admin", "flags"]]);
              }}>{t("common.save")}</button>
            </article>
          );
        })}
      </div>
    </Screen>
  );
}

function Reports() {
  const t = useT();
  const act = useAct();
  const q = useQuery({ queryKey: ["admin", "reports"], queryFn: () => api.get<{ id: string; reason: string; comment: string | null; question_text: string; quiz_title: string; visibility: string; reports_on_question: number }[]>("/api/admin/reports") });
  return (
    <Screen title={t("admin.nav_reports")}>
      <div className="stack">
        {q.isLoading ? <Loading /> : !q.data?.length ? <Empty icon="✅" text={t("admin.nothing")} /> : q.data.map((r) => (
          <article key={r.id} className="card stack">
            <div className="row between wrap"><Badge kind="warn">{t(`report.${r.reason}` as never)}</Badge><span className="caption">{r.quiz_title} · {r.visibility} · ×{r.reports_on_question}</span></div>
            <p className="break">{r.question_text}</p>
            {r.comment && <p className="caption break">“{r.comment}”</p>}
            <div className="row wrap">
              <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.post(`/api/admin/reports/${r.id}/resolve`, { status: "resolved" }), [["admin", "reports"]])}>{t("admin.resolve")}</button>
              {r.visibility !== "private" && <button className="btn btn-danger btn-sm" onClick={() => act(() => api.post(`/api/admin/reports/${r.id}/resolve`, { status: "resolved", unpublishQuiz: true }), [["admin", "reports"]])}>{t("admin.unpublish")}</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post(`/api/admin/reports/${r.id}/resolve`, { status: "rejected" }), [["admin", "reports"]])}>{t("admin.reject")}</button>
            </div>
          </article>
        ))}
      </div>
    </Screen>
  );
}

function Tickets() {
  const t = useT();
  const act = useAct();
  const q = useQuery({ queryKey: ["admin", "tickets"], queryFn: () => api.get<{ id: string; kind: string; body: string; status: string; resolution: string | null; created_at: string; user_name: string }[]>("/api/admin/tickets") });
  const [reply, setReply] = useState<Record<string, string>>({});
  return (
    <Screen title={t("admin.nav_tickets")}>
      <div className="stack">
        {q.isLoading ? <Loading /> : !q.data?.length ? <Empty icon="✅" text={t("admin.nothing")} /> : q.data.map((x) => (
          <article key={x.id} className="card stack">
            <div className="row between wrap"><span className="caption">#{x.id} · {x.kind} · {x.user_name} · {new Date(x.created_at).toLocaleString()}</span><Badge kind={x.status === "resolved" ? "success" : "warn"}>{t(`support.status_${x.status}` as never)}</Badge></div>
            <p className="break small">{x.body}</p>
            {x.resolution && <div className="evidence"><p className="small break">{x.resolution}</p></div>}
            {x.status !== "resolved" && (
              <>
                <textarea className="textarea" rows={2} aria-label={t("admin.reply")} value={reply[x.id] ?? ""} onChange={(e) => setReply({ ...reply, [x.id]: e.target.value })} />
                <div className="row wrap">
                  <button className="btn btn-primary btn-sm" disabled={!reply[x.id]?.trim()} onClick={() => act(() => api.post(`/api/admin/tickets/${x.id}/reply`, { text: reply[x.id], status: "resolved" }), [["admin", "tickets"]])}>{t("admin.replyResolve")}</button>
                  <button className="btn btn-ghost btn-sm" disabled={!reply[x.id]?.trim()} onClick={() => act(() => api.post(`/api/admin/tickets/${x.id}/reply`, { text: reply[x.id], status: "in_progress" }), [["admin", "tickets"]])}>{t("admin.replyOnly")}</button>
                </div>
              </>
            )}
          </article>
        ))}
      </div>
    </Screen>
  );
}

function Users() {
  const t = useT();
  const act = useAct();
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["admin", "users", q], queryFn: () => api.get<{ id: string; telegram_id: string | null; username: string | null; name: string; created_at: string; deleted_at: string | null; balance: number; plan: string | null; documents: number; quizzes: number }[]>(`/api/admin/users?q=${encodeURIComponent(q)}`) });
  const [adj, setAdj] = useState<{ id: string; name: string } | null>(null);
  const [amount, setAmount] = useState(10);
  const [reason, setReason] = useState("");
  return (
    <Screen title={t("admin.nav_users")}>
      <div className="stack">
        <input className="input" type="search" placeholder={t("admin.searchUsers")} aria-label={t("admin.searchUsers")} value={q} onChange={(e) => setQ(e.target.value)} />
        {list.isLoading ? <Loading /> : list.data?.map((u) => (
          <div key={u.id} className="list-item">
            <div className="grow">
              <div className="small"><strong>{u.deleted_at ? t("admin.deletedUser") : u.name}</strong>{u.username ? ` @${u.username}` : ""}</div>
              <div className="meta">{u.plan ?? "free"} · {t("admin.balanceN", { n: u.balance })} · 📄 {u.documents} · 📝 {u.quizzes}</div>
            </div>
            {!u.deleted_at && <button className="btn btn-secondary btn-sm" onClick={() => setAdj({ id: u.id, name: u.name })}>± {t("admin.credits")}</button>}
          </div>
        ))}
      </div>
      <Sheet open={!!adj} onClose={() => setAdj(null)} title={`${t("admin.adjustCredits")}: ${adj?.name ?? ""}`}>
        <div className="stack">
          <Field label={t("admin.amount")}>{(id) => <input id={id} className="input" type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />}</Field>
          <Field label={t("admin.reason")}>{(id) => <input id={id} className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />}</Field>
          <button className="btn btn-primary btn-block" disabled={!amount || reason.trim().length < 3} onClick={() => act(() => api.post(`/api/admin/users/${adj!.id}/credits`, { amount, reason, idempotencyKey: newIdempotencyKey("adj") }), [["admin", "users", q]]).then(() => setAdj(null))}>{t("common.save")}</button>
        </div>
      </Sheet>
    </Screen>
  );
}

function Payments() {
  const t = useT();
  const act = useAct();
  const q = useQuery({ queryKey: ["admin", "payments"], queryFn: () => api.get<{ id: string; plan_code: string; amount: number; credits: number; status: string; created_at: string; user_name: string }[]>("/api/admin/payments") });
  return (
    <Screen title={t("admin.nav_payments")}>
      <div className="stack">
        {q.isLoading ? <Loading /> : !q.data?.length ? <Empty icon="⭐" text={t("admin.nothing")} /> : q.data.map((p) => (
          <div key={p.id} className="list-item">
            <div className="grow">
              <div className="small"><strong>⭐ {p.amount}</strong> · {p.plan_code} · {p.user_name}</div>
              <div className="meta">{new Date(p.created_at).toLocaleString()} · {t(`admin.payment_${p.status}` as never)}</div>
            </div>
            {p.status === "paid" && <button className="btn btn-danger btn-sm" onClick={() => {
              if (window.confirm(t("admin.refundConfirm", { n: p.amount }))) void act(() => api.post(`/api/admin/payments/${p.id}/refund`), [["admin", "payments"]]);
            }}>{t("admin.refund")}</button>}
          </div>
        ))}
      </div>
    </Screen>
  );
}

function Audit() {
  const t = useT();
  const q = useQuery({ queryKey: ["admin", "audit"], queryFn: () => api.get<{ id: string; action: string; target_type: string | null; target_id: string | null; ip: string | null; created_at: string; actor: string | null }[]>("/api/admin/audit") });
  if (q.isError) return <Screen title={t("admin.nav_audit")}><ErrorState error={q.error} onRetry={() => q.refetch()} /></Screen>;
  return (
    <Screen title={t("admin.nav_audit")}>
      {q.isLoading ? <Loading /> : (
        <div className="list">{q.data?.map((a) => (
          <div key={a.id} className="list-item">
            <div className="grow">
              <div className="small"><strong>{a.action}</strong> · {a.target_type} {a.target_id?.slice(0, 8)}</div>
              <div className="meta">{a.actor ?? "system"} · {new Date(a.created_at).toLocaleString()}{a.ip ? ` · ${a.ip}` : ""}</div>
            </div>
          </div>
        ))}</div>
      )}
    </Screen>
  );
}
