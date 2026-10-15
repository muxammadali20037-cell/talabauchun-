import { z } from "zod";

export const RoomSettings = z.object({
  timePerQuestionSec: z.number().int().min(5).max(300).default(30),
  speedBonus: z.boolean().default(false),
  speedBonusMax: z.number().int().min(0).max(50).default(50),
  showLeaderboard: z.boolean().default(true),
  shuffleOptions: z.boolean().default(true),
  mode: z.enum(["individual", "teams", "async", "live"]).default("live"),
  /** Quiz Battle: number of teams (members are balanced automatically) */
  teamCount: z.number().int().min(2).max(4).default(2),
  revealExplanation: z.enum(["after_question", "after_quiz"]).default("after_question"),
  autoAdvance: z.boolean().default(false),
  hostGraceSec: z.number().int().min(5).max(120).default(20),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

/** Client -> server messages over the room WebSocket. */
export const RoomClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(10).max(200), roomId: z.string().uuid() }),
  z.object({ type: z.literal("answer"), questionId: z.string().uuid(), optionIds: z.array(z.string().uuid()).min(1).max(12), clientMsgId: z.string().max(64) }),
  z.object({ type: z.literal("host"), action: z.enum(["start", "next", "reveal", "pause", "resume", "finish"]), clientMsgId: z.string().max(64) }),
  z.object({ type: z.literal("ping"), t: z.number() }),
  z.object({ type: z.literal("sync") }),
]);
export type RoomClientMessage = z.infer<typeof RoomClientMessage>;

export type PublicOption = { id: string; text: string };
export type PublicQuestion = { id: string; index: number; total: number; text: string; type: string; options: PublicOption[]; multiple: boolean };

export type RoomStateView = {
  roomId: string;
  title: string;
  status: "lobby" | "running" | "paused" | "finished" | "cancelled";
  phase: "question" | "reveal" | null;
  isHost: boolean;
  /** join code, only sent to the host */
  code: string | null;
  serverNow: number;
  deadline: number | null;
  pausedRemainingMs: number | null;
  participants: { userId: string; name: string; connected: boolean; isHost: boolean; isCoHost?: boolean }[];
  question: PublicQuestion | null;
  myAnswer: { questionId: string; optionIds: string[]; acceptedAt: number } | null;
  answeredCount: number;
  /** only present in reveal phase or after finish */
  reveal: { questionId: string; correctOptionIds: string[]; explanation: string | null; source: string | null; counts: Record<string, number> } | null;
  myScore: { points: number; correct: number; answered: number } | null;
  leaderboard: { userId: string; name: string; points: number; correct: number }[] | null;
  rules: { pointsCorrect: number; speedBonusMax: number; showLeaderboard: boolean; timePerQuestionSec: number; teamScoring: "average" | null };
  /** Quiz Battle only: team score = average of members' points (fair for unequal team sizes) */
  teams: { id: string; name: string; color: string; members: number; averagePoints: number }[] | null;
  myTeamId: string | null;
  hostConnected: boolean;
};

export type RoomServerMessage =
  | { type: "state"; state: RoomStateView }
  | { type: "ack"; clientMsgId: string; accepted: boolean; reason?: string }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; t: number; serverNow: number };
