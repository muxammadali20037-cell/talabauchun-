import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import type { RouteHelpers } from "./app";
import * as decks from "../slides/service";

const uuid = z.string().uuid();
const page = z.object({ cursor: z.string().max(64).optional(), limit: z.coerce.number().int().optional() });

/** Presentation Studio API (all routes require a session; roles are checked in the service). */
export async function registerDeckRoutes(app: FastifyInstance, deps: Deps, h: RouteHelpers) {
  const { auth, me } = h;
  const deckId = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);
  const slideId = (req: FastifyRequest) => uuid.parse((req.params as { slideId: string }).slideId);

  app.post("/api/decks/estimate", { preHandler: auth }, async (req) => {
    const body = z.object({ slideCount: z.number().int().optional(), useAi: z.boolean().optional(), planOnly: z.boolean().optional() }).parse(req.body ?? {});
    return decks.estimateDeck(deps, me(req), body);
  });
  app.post("/api/decks", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => decks.createDeck(deps, me(req), req.body));
  app.get("/api/decks", { preHandler: auth }, async (req) => {
    const q = page.extend({ workspaceId: uuid.optional() }).parse(req.query);
    return decks.listDecks(deps, me(req), q);
  });
  app.get("/api/decks/:id", { preHandler: auth }, async (req) => decks.getDeck(deps, me(req), deckId(req)));
  app.patch("/api/decks/:id", { preHandler: auth }, async (req) => decks.updateDeck(deps, me(req), deckId(req), req.body));
  app.delete("/api/decks/:id", { preHandler: auth }, async (req) => {
    await decks.deleteDeck(deps, me(req), deckId(req));
    return { ok: true };
  });
  app.post("/api/decks/:id/generate", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => decks.generateFromOutline(deps, me(req), deckId(req), req.body));

  // slides
  app.post("/api/decks/:id/slides", { preHandler: auth }, async (req) => decks.addSlide(deps, me(req), deckId(req), req.body));
  app.put("/api/decks/:id/slides/:slideId", { preHandler: auth }, async (req) => decks.updateSlide(deps, me(req), deckId(req), slideId(req), req.body));
  app.delete("/api/decks/:id/slides/:slideId", { preHandler: auth }, async (req) => decks.deleteSlide(deps, me(req), deckId(req), slideId(req)));
  app.post("/api/decks/:id/slides/:slideId/lock", { preHandler: auth }, async (req) => decks.lockSlide(deps, me(req), deckId(req), slideId(req)));
  app.delete("/api/decks/:id/slides/:slideId/lock", { preHandler: auth }, async (req) => decks.unlockSlide(deps, me(req), deckId(req), slideId(req)));
  app.post("/api/decks/:id/slides/:slideId/regenerate", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) =>
    decks.regenerateSlide(deps, me(req), deckId(req), slideId(req), req.body ?? {}),
  );
  app.post("/api/decks/:id/slides/:slideId/undo", { preHandler: auth }, async (req) => decks.undoSlide(deps, me(req), deckId(req), slideId(req)));
  app.get("/api/decks/:id/slides/:slideId/history", { preHandler: auth }, async (req) => decks.slideHistory(deps, me(req), deckId(req), slideId(req), page.parse(req.query)));
  app.post("/api/decks/:id/reorder", { preHandler: auth }, async (req) => decks.reorderSlides(deps, me(req), deckId(req), req.body));

  // exports
  app.post("/api/decks/:id/exports", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => decks.createExport(deps, me(req), deckId(req), req.body));
  app.get("/api/decks/:id/exports", { preHandler: auth }, async (req) => decks.listExports(deps, me(req), deckId(req), page.parse(req.query)));
  app.get("/api/decks/:id/exports/:exportId/thumbnails/:n", { preHandler: auth }, async (req, reply) => {
    const p = z.object({ exportId: uuid, n: z.coerce.number().int().min(1).max(200) }).parse(req.params);
    const png = await decks.exportThumbnail(deps, me(req), deckId(req), p.exportId, p.n);
    reply.header("content-type", "image/png");
    reply.header("cache-control", "private, max-age=300");
    return reply.send(png);
  });

  // "Shu materialdan quiz"
  app.post("/api/decks/:id/quiz", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => decks.quizFromDeck(deps, me(req), deckId(req), req.body));
}
