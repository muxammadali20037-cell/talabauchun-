import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../src/deps";
import { buildApp } from "../src/http/app";
import { signInitData } from "../src/auth/init-data";
import { AiClient } from "../src/ai/client";
import { createDocumentFromFile } from "../src/ingest/documents";
import { getUserById } from "../src/auth/users";
import { formatReference, quotedSegments } from "../src/study/writing";
import { createTestDeps, TEST_BOT_TOKEN } from "./helpers/deps";
import { fixture } from "./helpers/fixtures";
import { anthropicStub } from "./helpers/ai-stub";
import { testWorker } from "./helpers/worker";

let deps: Deps;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
let token: string;
let docId: string;

beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
  app = await buildApp(deps, { logger: false });
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAHw", user: JSON.stringify({ id: 610001, first_name: "Yozuvchi", language_code: "uz" }) }, TEST_BOT_TOKEN);
  const r = (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } })).json();
  token = r.token;
  const user = (await getUserById(deps.sql, r.user.id))!;
  docId = (await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" })).documentId;
  await testWorker(deps).drain();
});
afterAll(async () => {
  await app.close();
  await cleanup();
});
const H = () => ({ authorization: `Bearer ${token}` });
const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/writing", headers: H(), payload });

describe("writing helper (master prompt §11)", () => {
  it("bibliography uses only the stored details, reports what is missing, and the user can fill them in", async () => {
    let r = (await post({ mode: "bibliography", documentIds: [docId], style: "gost" })).json();
    expect(r.entries[0].missing).toEqual(["publication"]); // author comes from the PDF metadata
    expect(r.entries[0].text).not.toMatch(/\b(19|20)\d{2}\b/); // no invented year
    const upd = await app.inject({ method: "PATCH", url: `/api/documents/${docId}`, headers: H(), payload: { author: "Karimov A.", publishedInfo: "Toshkent: Iqtisodiyot, 2021. — 240 b." } });
    expect(upd.statusCode).toBe(200);
    r = (await post({ mode: "bibliography", documentIds: [docId], style: "gost" })).json();
    expect(r.entries[0].text).toMatch(/^Karimov A\. [^.]+\. — Toshkent: Iqtisodiyot, 2021\. — 240 b\.$/);
    expect(r.entries[0].missing).toEqual([]);
    r = (await post({ mode: "bibliography", documentIds: [docId], style: "apa" })).json();
    expect(r.entries[0].text).toMatch(/^Karimov A\. \(2021\)\. /);
    // pure formatter: no year → n.d., never a made-up one
    expect(formatReference({ id: "x", title: "T", author: null, published_info: null, source_url: "https://stat.uz/x", source_kind: "web", created_at: new Date() }, "apa", new Date()).text).toBe("(n.d.). T. https://stat.uz/x");
    expect(formatReference({ id: "x", title: "Bozor nima?", author: "Aliyev B", published_info: null, source_url: "https://stat.uz/x", source_kind: "web", created_at: new Date() }, "gost", new Date(Date.UTC(2026, 9, 5))).text).toBe("Aliyev B. Bozor nima? — URL: https://stat.uz/x (murojaat sanasi: 05.10.2026).");
  });

  it("without AI: outline from the source's chapters (labelled), extractive annotation; polish and rubric say AI is required", async () => {
    const o = (await post({ mode: "outline", topic: "Inflyatsiya va uning oqibatlari", documentIds: [docId] })).json();
    expect(o.generated).toBe("from_sources");
    expect(o.outline.map((s: { title: string }) => s.title)).toEqual(expect.arrayContaining(["Kirish", "2-bob. Inflyatsiya", "Xulosa"]));
    const a = (await post({ mode: "annotation", documentId: docId })).json();
    expect(a.generated).toBe("extractive");
    expect(a.annotation.length).toBeGreaterThan(40);
    const p = await post({ mode: "polish", text: "Bu mening matnim, unda «Talab — bu xohish» degan iqtibos bor va u o‘zgarmasligi kerak." });
    expect(p.statusCode).toBe(409);
    expect(p.json().error.code).toBe("ai_required");
    // another user cannot use this document
    const other = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAHx", user: JSON.stringify({ id: 610002, first_name: "B" }) }, TEST_BOT_TOKEN);
    const t2 = (await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData: other } })).json().token;
    expect((await app.inject({ method: "POST", url: "/api/writing", headers: { authorization: `Bearer ${t2}` }, payload: { mode: "bibliography", documentIds: [docId] } })).statusCode).toBe(404);
  });

  it("with AI: polish reports any changed citation; rubric drops excerpts the student did not write", async () => {
    const stub = anthropicStub((call) => {
      if (call.system.includes("Improve the clarity")) return { text: "Mening matnim yaxshilandi, «Talab — bu istak» deb yozilgan.", changes: [{ before: "Bu mening matnim", after: "Mening matnim", why: "qisqartirildi" }] };
      return { criteria: [{ criterion: "Manbalar", status: "partly", excerpt: "bu jumla matnda yo‘q", suggestion: "Manba qo‘shing" }, { criterion: "Kirish", status: "met", excerpt: "Mavzu dolzarb", suggestion: "—" }], overall: "Yaxshi" };
    });
    const aiDeps: Deps = { ...deps, ai: new AiClient(deps.cfg, deps.sql, stub.client) };
    const app2 = await buildApp(aiDeps, { logger: false });
    try {
      const p = (await app2.inject({ method: "POST", url: "/api/writing", headers: H(), payload: { mode: "polish", text: "Bu mening matnim, unda «Talab — bu xohish» degan iqtibos bor." } })).json();
      expect(p.quotesChanged).toEqual(["Talab — bu xohish"]);
      expect(p.quotesKept).toBe(0);
      const r = (await app2.inject({ method: "POST", url: "/api/writing", headers: H(), payload: { mode: "rubric", text: "Mavzu dolzarb, chunki narxlar oshmoqda. Xulosa qilamiz.", rubric: "1. Kirish 2. Manbalar" } })).json();
      expect(r.criteria[0].excerpt).toBeNull();
      expect(r.criteria[1].excerpt).toBe("Mavzu dolzarb");
      // the source text of the student is sent as data, with the untrusted-data rules
      expect(stub.calls.every((c) => c.system.includes("data"))).toBe(true);
      // AI help is capped per rolling 24 h by the plan (here: 2 calls already made)
      await deps.sql`update plans set limits = limits || '{"aiAssistPerDay": 2}'::jsonb where code = 'free'`;
      const capped = await app2.inject({ method: "POST", url: "/api/writing", headers: H(), payload: { mode: "polish", text: "Yana bir matn, uni ham tekshirib bering iltimos." } });
      expect(capped.statusCode).toBe(429);
      expect(capped.json().error).toMatchObject({ code: "daily_ai_limit" });
      // the no-AI bibliography is not limited
      expect((await app2.inject({ method: "POST", url: "/api/writing", headers: H(), payload: { mode: "bibliography", documentIds: [docId] } })).statusCode).toBe(200);
      await deps.sql`update plans set limits = limits - 'aiAssistPerDay' where code = 'free'`;
    } finally {
      await app2.close();
    }
    expect(quotedSegments("a «bir ikki» b “uch to‘rt” c")).toEqual(["bir ikki", "uch to‘rt"]);
  });
});
