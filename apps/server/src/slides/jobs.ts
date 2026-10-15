import type { Deps } from "../deps";
import type { JobHandler } from "../jobs/queue";
import { exportDeckHandler, generateDeckHandler, regenerateSlideHandler } from "./generate";

/** Background job kinds of Presentation Studio (wired into the worker by worker-main.ts). */
export function slideJobHandlers(deps: Deps): Record<string, JobHandler> {
  return {
    generate_deck: generateDeckHandler(deps),
    regenerate_slide: regenerateSlideHandler(deps),
    export_deck: exportDeckHandler(deps),
  };
}
