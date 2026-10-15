import type { Deps } from "../../src/deps";
import { ingestHandler } from "../../src/ingest/pipeline";
import { JobWorker, type JobHandler } from "../../src/jobs/queue";
import { quizGenerateHandler } from "../../src/quiz/pipeline";
import { slideJobHandlers } from "../../src/slides/jobs";

export function testWorker(deps: Deps, extra: Record<string, JobHandler> = {}) {
  return new JobWorker(deps.sql, { ingest_document: ingestHandler(deps), generate_quiz: quizGenerateHandler(deps), ...slideJobHandlers(deps), ...extra }, { concurrency: 1, leaseSec: 60 });
}
