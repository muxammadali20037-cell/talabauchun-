import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type JobView = {
  id: string; kind: string; status: "queued" | "extracting" | "indexing" | "generating" | "validating" | "rendering" | "completed" | "failed" | "cancelled";
  stagesDone: number; stagesTotal: number; errorCode: string | null; result: Record<string, unknown> | null; targetId: string | null; cancelRequested: boolean;
};

export const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Polls real job state (stage-based progress, no invented percentages). */
export function useJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ["job", jobId],
    enabled: !!jobId,
    queryFn: () => api.get<JobView>(`/api/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : 1500),
  });
}
