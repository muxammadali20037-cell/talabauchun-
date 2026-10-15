import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Sql, Tx } from "../db/index";
import { captureCredits, releaseCredits, reserveCredits } from "../billing/credits";

export const JOB_STATUSES = ["queued", "extracting", "indexing", "generating", "validating", "rendering", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobStage = Exclude<JobStatus, "queued" | "completed" | "failed" | "cancelled">;
export const TERMINAL: JobStatus[] = ["completed", "failed", "cancelled"];

export type JobRow = {
  id: string;
  kind: string;
  user_id: string;
  workspace_id: string;
  target_id: string | null;
  status: JobStatus;
  stages: JobStage[];
  stage_index: number;
  idempotency_key: string;
  pipeline_version: number;
  input: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  cancel_requested: boolean;
  run_after: Date;
  lease_expires_at: Date | null;
  credit_reservation_id: string | null;
  notify_chat_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

/** Error with a stable code. `retryable` errors are retried with backoff up to max_attempts. */
export class JobError extends Error {
  constructor(public readonly code: string, public readonly retryable = false, message?: string) {
    super(message ?? code);
  }
}
export class JobCancelled extends Error {}

export type EnqueueInput = {
  kind: string;
  userId: string;
  workspaceId: string;
  targetId?: string | null;
  idempotencyKey: string;
  input?: Record<string, unknown>;
  stages: JobStage[];
  credits?: number;
  notifyChatId?: string | number | null;
  maxAttempts?: number;
  pipelineVersion?: number;
};

/**
 * Creates a job (and its credit reservation) atomically. A repeated call with
 * the same idempotency key returns the existing job instead of a duplicate, so
 * double taps never create two orders or two debits.
 */
export async function enqueueJob(tx: Tx, e: EnqueueInput): Promise<{ job: JobRow; created: boolean }> {
  const [existing] = await tx<JobRow[]>`select * from generation_jobs where idempotency_key = ${e.idempotencyKey}`;
  if (existing) return { job: existing, created: false };
  const id = randomUUID();
  const reservationId = e.credits && e.credits > 0 ? await reserveCredits(tx, e.userId, e.credits, e.idempotencyKey, null) : null;
  const [job] = await tx<JobRow[]>`
    insert into generation_jobs (id, kind, user_id, workspace_id, target_id, stages, idempotency_key, input,
      credit_reservation_id, notify_chat_id, max_attempts, pipeline_version)
    values (${id}, ${e.kind}, ${e.userId}, ${e.workspaceId}, ${e.targetId ?? null}, ${e.stages}, ${e.idempotencyKey},
      ${tx.json((e.input ?? {}) as never)}, ${reservationId}, ${e.notifyChatId == null ? null : String(e.notifyChatId)},
      ${e.maxAttempts ?? 3}, ${e.pipelineVersion ?? 1})
    returning *`;
  if (reservationId) await tx`update credit_ledger set job_id = ${id} where reservation_id = ${reservationId}`;
  await tx`insert into job_events (job_id, type, status, message) values (${id}, 'created', 'queued', ${e.kind})`;
  await tx`select pg_notify('jobs', ${id})`;
  return { job: job!, created: true };
}

export async function requestCancel(sql: Sql, jobId: string) {
  await sql`update generation_jobs set cancel_requested = true, updated_at = now() where id = ${jobId} and status not in ('completed','failed','cancelled')`;
}

export async function getJob(sql: Sql | Tx, id: string): Promise<JobRow | null> {
  const [j] = await sql<JobRow[]>`select * from generation_jobs where id = ${id}`;
  return j ?? null;
}

/** Public view: real stage progress only (no invented percentages). */
export function jobView(j: JobRow) {
  const total = j.stages.length;
  const done = j.status === "completed" ? total : Math.min(j.stage_index, total);
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    stage: j.status,
    stagesDone: done,
    stagesTotal: total,
    errorCode: j.error_code,
    result: j.status === "completed" ? j.result : null,
    cancelRequested: j.cancel_requested,
    attempts: j.attempts,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    targetId: j.target_id,
  };
}

export type JobContext = {
  job: JobRow;
  sql: Sql;
  /** Persisted between attempts; handlers use it to skip completed stages after a restart. */
  checkpoint: Record<string, unknown>;
  stage(status: JobStage, checkpoint?: Record<string, unknown>): Promise<void>;
  saveCheckpoint(patch: Record<string, unknown>): Promise<void>;
  throwIfCancelled(): Promise<void>;
  event(type: string, message?: string, data?: unknown): Promise<void>;
};

export type JobResult = { result: Record<string, unknown>; creditsUsed?: number };
export type JobHandler = (ctx: JobContext) => Promise<JobResult>;
export type JobHooks = {
  onFinished?: (job: JobRow, outcome: "completed" | "failed" | "cancelled") => Promise<void>;
};

export class JobWorker {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private active = 0;
  private stopped = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private listener: { unlisten: () => Promise<void> } | null = null;
  private inflight = new Set<Promise<void>>();

  constructor(
    private readonly sql: Sql,
    private readonly handlers: Record<string, JobHandler>,
    private readonly opts: { concurrency: number; leaseSec: number; hooks?: JobHooks; log?: (o: object, m: string) => void },
  ) {}

  async start() {
    this.stopped = false;
    this.listener = await this.sql.listen("jobs", () => void this.fill());
    this.pollTimer = setInterval(() => void this.fill(), 1000);
    void this.fill();
  }

  async stop(graceMs = 10_000) {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.listener?.unlisten().catch(() => {});
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, graceMs))]);
  }

  /** Runs at most one job synchronously (used by tests). Returns false when nothing was runnable. */
  async runOnce(): Promise<boolean> {
    await this.reapExhausted();
    const job = await this.claim();
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  async drain(maxJobs = 100) {
    let n = 0;
    while (n < maxJobs && (await this.runOnce())) n++;
    return n;
  }

  /**
   * A job whose worker died on its last allowed attempt would otherwise be
   * re-claimed forever: once its lease has expired it is failed and its
   * credit reservation released.
   */
  async reapExhausted(): Promise<number> {
    const kinds = Object.keys(this.handlers);
    const dead = await this.sql<JobRow[]>`
      select * from generation_jobs where status not in ('completed','failed','cancelled') and lease_expires_at < now()
        and attempts >= max_attempts and kind in ${this.sql(kinds)} limit 20`;
    for (const job of dead) {
      await this.sql.begin(async (tx) => {
        const r = await tx`update generation_jobs set status = 'failed', error_code = 'worker_lost', error_message = 'worker_lost', finished_at = now(),
          locked_by = null, lease_expires_at = null, updated_at = now() where id = ${job.id} and status not in ('completed','failed','cancelled') returning id`;
        if (!r.length) return;
        if (job.credit_reservation_id) await releaseCredits(tx, job.credit_reservation_id, "failed");
        await tx`insert into job_events (job_id, type, status, message) values (${job.id}, 'finished', 'failed', 'worker_lost')`;
        await tx`select pg_notify('job_status', ${job.id})`;
      });
      await this.opts.hooks?.onFinished?.({ ...job, status: "failed", error_code: "worker_lost" }, "failed").catch(() => {});
    }
    return dead.length;
  }

  private lastReap = 0;
  private async fill() {
    if (Date.now() - this.lastReap > 15_000) {
      this.lastReap = Date.now();
      await this.reapExhausted().catch(() => 0);
    }
    while (!this.stopped && this.active < this.opts.concurrency) {
      const job = await this.claim().catch(() => null);
      if (!job) return;
      this.active++;
      const p = this.execute(job).finally(() => {
        this.active--;
        this.inflight.delete(p);
        void this.fill();
      });
      this.inflight.add(p);
    }
  }

  private async claim(): Promise<JobRow | null> {
    const kinds = Object.keys(this.handlers);
    // Jobs whose lease expired (worker crashed/restarted) are picked up again and resume from their checkpoint.
    const [job] = await this.sql<JobRow[]>`
      update generation_jobs set locked_by = ${this.workerId},
        lease_expires_at = now() + make_interval(secs => ${this.opts.leaseSec}),
        attempts = attempts + 1, started_at = coalesce(started_at, now()), updated_at = now()
      where id = (
        select id from generation_jobs
        where status not in ('completed','failed','cancelled') and run_after <= now()
          and (lease_expires_at is null or lease_expires_at < now()) and attempts < max_attempts and kind in ${this.sql(kinds)}
        order by created_at for update skip locked limit 1)
      returning *`;
    return job ?? null;
  }

  private async execute(job: JobRow) {
    const sql = this.sql;
    const log = this.opts.log ?? (() => {});
    const heartbeat = setInterval(() => {
      void sql`update generation_jobs set lease_expires_at = now() + make_interval(secs => ${this.opts.leaseSec}) where id = ${job.id} and locked_by = ${this.workerId}`;
    }, Math.max(1000, (this.opts.leaseSec * 1000) / 3));
    const checkpoint: Record<string, unknown> = { ...(job.checkpoint ?? {}) };
    const ctx: JobContext = {
      job,
      sql,
      checkpoint,
      stage: async (status, patch) => {
        if (patch) Object.assign(checkpoint, patch);
        const idx = Math.max(0, job.stages.indexOf(status));
        await sql`update generation_jobs set status = ${status}, stage_index = ${idx}, checkpoint = ${sql.json(checkpoint as never)}, updated_at = now() where id = ${job.id}`;
        await sql`insert into job_events (job_id, type, status) values (${job.id}, 'stage', ${status})`;
        await sql`select pg_notify('job_status', ${job.id})`;
      },
      saveCheckpoint: async (patch) => {
        Object.assign(checkpoint, patch);
        await sql`update generation_jobs set checkpoint = ${sql.json(checkpoint as never)}, updated_at = now() where id = ${job.id}`;
      },
      throwIfCancelled: async () => {
        const [r] = await sql<{ cancel_requested: boolean }[]>`select cancel_requested from generation_jobs where id = ${job.id}`;
        if (r?.cancel_requested) throw new JobCancelled();
      },
      event: async (type, message, data) => {
        await sql`insert into job_events (job_id, type, message, data) values (${job.id}, ${type}, ${message ?? null}, ${data == null ? null : sql.json(data as never)})`;
      },
    };
    try {
      if (job.cancel_requested) throw new JobCancelled();
      const handler = this.handlers[job.kind];
      if (!handler) throw new JobError("unknown_job_kind");
      const { result, creditsUsed } = await handler(ctx);
      await sql.begin(async (tx) => {
        await tx`update generation_jobs set status = 'completed', stage_index = array_length(stages, 1), result = ${tx.json(result as never)},
          finished_at = now(), locked_by = null, lease_expires_at = null, updated_at = now() where id = ${job.id}`;
        if (job.credit_reservation_id) await captureCredits(tx, job.credit_reservation_id, creditsUsed ?? Number.MAX_SAFE_INTEGER);
        await tx`insert into job_events (job_id, type, status) values (${job.id}, 'finished', 'completed')`;
        await tx`select pg_notify('job_status', ${job.id})`;
      });
      await this.opts.hooks?.onFinished?.({ ...job, status: "completed", result }, "completed").catch((e) => log({ err: String(e) }, "onFinished hook failed"));
    } catch (e) {
      if (e instanceof JobCancelled) {
        await sql.begin(async (tx) => {
          await tx`update generation_jobs set status = 'cancelled', finished_at = now(), locked_by = null, lease_expires_at = null, updated_at = now() where id = ${job.id}`;
          if (job.credit_reservation_id) await releaseCredits(tx, job.credit_reservation_id, "cancelled");
          await tx`insert into job_events (job_id, type, status) values (${job.id}, 'finished', 'cancelled')`;
          await tx`select pg_notify('job_status', ${job.id})`;
        });
        await this.opts.hooks?.onFinished?.({ ...job, status: "cancelled" }, "cancelled").catch(() => {});
        return;
      }
      const code = e instanceof JobError ? e.code : "internal_error";
      const retryable = e instanceof JobError ? e.retryable : true;
      const [fresh] = await sql<{ attempts: number }[]>`select attempts from generation_jobs where id = ${job.id}`;
      const attempts = fresh?.attempts ?? job.attempts;
      // Internal details go to job_events (operators), never to the student-facing error_message.
      await ctx.event("error", code, { message: e instanceof Error ? e.message.slice(0, 500) : String(e), attempt: attempts });
      log({ jobId: job.id, kind: job.kind, code, attempt: attempts }, "job attempt failed");
      if (retryable && attempts < job.max_attempts) {
        const backoffSec = Math.min(300, 5 * 3 ** (attempts - 1));
        await sql`update generation_jobs set status = 'queued', locked_by = null, lease_expires_at = null,
          run_after = now() + make_interval(secs => ${backoffSec}), error_code = ${code}, updated_at = now() where id = ${job.id}`;
      } else {
        await sql.begin(async (tx) => {
          await tx`update generation_jobs set status = 'failed', error_code = ${code}, error_message = ${code}, finished_at = now(),
            locked_by = null, lease_expires_at = null, updated_at = now() where id = ${job.id}`;
          if (job.credit_reservation_id) await releaseCredits(tx, job.credit_reservation_id, "failed");
          await tx`insert into job_events (job_id, type, status, message) values (${job.id}, 'finished', 'failed', ${code})`;
          await tx`select pg_notify('job_status', ${job.id})`;
        });
        await this.opts.hooks?.onFinished?.({ ...job, status: "failed", error_code: code }, "failed").catch(() => {});
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
