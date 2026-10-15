import type { Deps } from "../deps";
import type { JobHandler } from "../jobs/queue";

export function slideJobHandlers(_deps: Deps): Record<string, JobHandler> {
  return {};
}
