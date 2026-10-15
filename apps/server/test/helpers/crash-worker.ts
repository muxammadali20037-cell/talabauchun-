// Child process for the worker-restart test: runs one resumable job and is then killed with SIGKILL by the parent.
import { createDb } from "../../src/db/index";
import { JobWorker } from "../../src/jobs/queue";
import { resumableJob } from "./resumable-job";

const sql = createDb(process.env.DATABASE_URL!, 2);
const worker = new JobWorker(sql, { test_resumable: resumableJob({ holdMs: 60_000 }) }, { concurrency: 1, leaseSec: Number(process.env.LEASE_SEC ?? 2) });
await worker.runOnce();
