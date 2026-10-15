import type { Deps } from "../deps";
import type { JobHandler } from "./queue";
import { ingestHandler } from "../ingest/pipeline";
import { quizGenerateHandler } from "../quiz/pipeline";

/** All background job kinds. Slide jobs are registered by the slides module. */
export function jobHandlers(deps: Deps, extra: Record<string, JobHandler> = {}): Record<string, JobHandler> {
  return {
    ingest_document: ingestHandler(deps),
    generate_quiz: quizGenerateHandler(deps),
    ...extra,
  };
}
