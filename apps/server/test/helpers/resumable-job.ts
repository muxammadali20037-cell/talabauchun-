import type { JobHandler } from "../../src/jobs/queue";

/**
 * Two-step test job: step 1 is recorded in the checkpoint, then the job waits
 * (long enough to be killed mid-way). A worker that picks it up after a crash
 * skips step 1 and finishes, reporting which process did step 1.
 */
export const resumableJob = (opts: { holdMs: number }): JobHandler => async (ctx) => {
  if (!ctx.checkpoint.step1By) {
    await ctx.stage("extracting", { step1By: process.pid });
    await new Promise((r) => setTimeout(r, opts.holdMs));
  }
  await ctx.stage("generating");
  return { result: { step1By: ctx.checkpoint.step1By, finishedBy: process.pid }, creditsUsed: 1 };
};
