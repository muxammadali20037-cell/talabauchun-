import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import type { RouteHelpers } from "./app";
import * as cards from "../study/flashcards";
import { listMistakes } from "../study/mistakes";
import * as plans from "../study/plans";
import { askTutor } from "../study/tutor";
import { summarizeDocument } from "../study/summary";
import * as stats from "../study/stats";
import { startMatching, submitMatching } from "../games/matching";
import * as ws from "../workspaces/service";

const uuid = z.string().uuid();
const pid = (req: FastifyRequest, k = "id") => uuid.parse((req.params as Record<string, string>)[k]);

export async function registerStudyRoutes(app: FastifyInstance, deps: Deps, h: RouteHelpers) {
  const pre = { preHandler: h.auth };
  // flashcards
  app.get("/api/flashcards", pre, async (req) => {
    const q = z.object({ due: z.enum(["1", "0"]).optional(), limit: z.coerce.number().int().optional(), collection: z.string().max(120).optional() }).parse(req.query);
    return cards.listCards(deps, h.me(req), { due: q.due === "1", limit: q.limit, collection: q.collection });
  });
  app.post("/api/flashcards", pre, async (req) => cards.createCard(deps, h.me(req), z.object({ front: z.string().min(1).max(1000), back: z.string().min(1).max(2000), collection: z.string().max(120).optional(), workspaceId: uuid.optional() }).parse(req.body)));
  app.post("/api/flashcards/from-quiz/:id", pre, async (req) => cards.cardsFromQuiz(deps, h.me(req), pid(req)));
  app.post("/api/flashcards/from-document/:id", pre, async (req) => cards.cardsFromDocument(deps, h.me(req), pid(req)));
  app.post("/api/flashcards/:id/review", pre, async (req) => cards.reviewCard(deps, h.me(req), pid(req), z.object({ grade: z.number().int().min(0).max(5) }).parse(req.body).grade));
  app.delete("/api/flashcards/:id", pre, async (req) => {
    await cards.deleteCard(deps, h.me(req), pid(req));
    return { ok: true };
  });

  // mistakes notebook
  app.get("/api/mistakes", pre, async (req) => listMistakes(deps, h.me(req), z.object({ limit: z.coerce.number().int().optional() }).parse(req.query)));

  // exam plans
  app.get("/api/plans", pre, async (req) => ({ items: await plans.listPlans(deps, h.me(req)) }));
  app.post("/api/plans", pre, async (req) => plans.createPlan(deps, h.me(req), req.body));
  app.get("/api/plans/:id", pre, async (req) => plans.getPlan(deps, h.me(req), pid(req)));
  app.post("/api/plans/:id/rebalance", pre, async (req) => plans.rebalancePlan(deps, h.me(req), pid(req)));
  app.patch("/api/tasks/:id", pre, async (req) => {
    const body = z.object({ status: z.enum(["todo", "in_progress", "done", "skipped"]) }).partial().passthrough().parse(req.body);
    const [t] = await deps.sql<{ plan_id: string | null }[]>`select plan_id from tasks where id = ${pid(req)}`;
    if (t?.plan_id && body.status && Object.keys(body).length === 1) await plans.setTaskStatus(deps, h.me(req), pid(req), body.status);
    else await ws.updateTask(deps, h.me(req), pid(req), body);
    return { ok: true };
  });

  // tutor & summaries
  app.post("/api/tutor/ask", { preHandler: h.auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => askTutor(deps, h.me(req), req.body));
  app.get("/api/documents/:id/summary", pre, async (req) => summarizeDocument(deps, h.me(req), pid(req), { useAi: (req.query as { ai?: string }).ai === "1" }));

  // statistics
  app.get("/api/documents/:id/tables", pre, async (req) => ({ tables: (await stats.documentTables(deps, h.me(req), pid(req))).map((t) => ({ ...t, rows: t.rows.slice(0, 100) })) }));
  app.post("/api/stats/facts", pre, async (req) => stats.createFactsFromTable(deps, h.me(req), req.body));
  app.get("/api/documents/:id/facts", pre, async (req) => ({ items: await stats.listFacts(deps, h.me(req), pid(req)) }));
  app.post("/api/stats/compute", pre, async (req) => stats.computeFacts(deps, h.me(req), z.object({ aId: uuid, bId: uuid, op: z.enum(["pct_change", "diff", "ratio"]) }).parse(req.body)));
  app.post("/api/stats/quiz", pre, async (req) => {
    const b = z.object({ documentId: uuid, indicator: z.string().min(1) }).parse(req.body);
    return stats.quizFromFacts(deps, h.me(req), b.documentId, b.indicator, h.me(req).language);
  });

  // games
  app.post("/api/games/matching", pre, async (req) => startMatching(deps, h.me(req), z.object({ documentId: uuid.optional(), size: z.number().int().min(3).max(8).optional() }).parse(req.body ?? {})));
  app.post("/api/games/matching/:id/submit", pre, async (req) => submitMatching(deps, h.me(req), pid(req), z.object({ pairs: z.array(z.object({ termId: uuid, definitionId: uuid })).max(12) }).parse(req.body).pairs));

  // workspaces (group projects)
  app.post("/api/workspaces", pre, async (req) => ws.createWorkspace(deps, h.me(req), z.object({ name: z.string().min(1).max(120) }).parse(req.body).name));
  app.get("/api/workspaces/:id", pre, async (req) => ws.getWorkspace(deps, h.me(req), pid(req)));
  app.post("/api/workspaces/:id/invites", pre, async (req) => ws.createWorkspaceInvite(deps, h.me(req), pid(req), z.object({ role: z.enum(["editor", "viewer"]), ttlHours: z.number().int().optional(), maxUses: z.number().int().min(1).optional() }).parse(req.body)));
  app.delete("/api/workspaces/:id/invites/:inviteId", pre, async (req) => {
    await ws.revokeWorkspaceInvite(deps, h.me(req), pid(req), pid(req, "inviteId"));
    return { ok: true };
  });
  app.post("/api/workspaces/join", { preHandler: h.auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => ws.joinWorkspace(deps, h.me(req), z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).parse(req.body).token));
  app.put("/api/workspaces/:id/members/:userId", pre, async (req) => {
    await ws.setMemberRole(deps, h.me(req), pid(req), pid(req, "userId"), z.object({ role: z.enum(["owner", "editor", "viewer"]).nullable() }).parse(req.body).role);
    return { ok: true };
  });
  app.post("/api/workspaces/:id/tasks", pre, async (req) => ws.createTask(deps, h.me(req), pid(req), req.body));
  app.post("/api/comments", pre, async (req) => ws.addComment(deps, h.me(req), z.object({ targetType: z.enum(ws.TARGETS), targetId: uuid, body: z.string().min(1).max(4000) }).parse(req.body)));
  app.get("/api/comments", pre, async (req) => {
    const q = z.object({ targetType: z.enum(ws.TARGETS), targetId: uuid }).parse(req.query);
    return { items: await ws.listComments(deps, h.me(req), q.targetType, q.targetId) };
  });
  app.delete("/api/comments/:id", pre, async (req) => {
    await ws.deleteComment(deps, h.me(req), pid(req));
    return { ok: true };
  });
  app.post("/api/share/move", pre, async (req) => {
    const b = z.object({ kind: z.enum(["document", "quiz", "deck"]), id: uuid, workspaceId: uuid }).parse(req.body);
    return ws.moveToWorkspace(deps, h.me(req), b.kind, b.id, b.workspaceId);
  });
}
