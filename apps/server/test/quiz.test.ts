import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps";
import { AiClient } from "../src/ai/client";
import { createDocumentFromFile } from "../src/ingest/documents";
import { answerAttempt, attemptResults, attemptState, startAttempt } from "../src/quiz/practice";
import { approveQuestions, confirmEvidence, createQuiz, getQuizForEditor, getQuizPreview, publishQuiz, updateQuestion } from "../src/quiz/service";
import { getBalance } from "../src/billing/credits";
import { createTestDeps, makeUser } from "./helpers/deps";
import { fixture, sourceFixture } from "./helpers/fixtures";
import { anthropicStub } from "./helpers/ai-stub";
import { testWorker } from "./helpers/worker";

let deps: Deps;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
});
afterAll(async () => cleanup());

async function bookFor(user: Awaited<ReturnType<typeof makeUser>>) {
  const r = await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
  await testWorker(deps).drain();
  return r.documentId;
}

describe("Quiz Studio (no AI configured: extractive mode)", () => {
  it("turns the user's Q&A list into 4-option questions with an openable source for each answer (acceptance 3)", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const before = await getBalance(deps.sql, user.id);
    const { quizId } = await createQuiz(deps, user, { method: "from_qa", documentIds: [docId], qaText: sourceFixture("savollar-javoblar.txt").toString("utf8"), idempotencyKey: "qa-quiz-0001" });
    await testWorker(deps).drain();
    const quiz = await getQuizForEditor(deps, user, quizId);
    expect(quiz.questions).toHaveLength(6);
    const inBook = quiz.questions.slice(0, 5);
    for (const q of inBook) {
      expect(q.options).toHaveLength(4);
      expect(q.options!.filter((o) => o.correct)).toHaveLength(1);
      expect(q.evidenceStatus).toBe("verified");
      expect(q.evidence?.locator?.pageIndex).toBeGreaterThanOrEqual(1);
      // the stored quote really is in the book page text
      const [page] = await deps.sql<{ text: string }[]>`select p.text from pages p join documents d on d.current_version_id = p.document_version_id where d.id = ${docId} and p.page_index = ${q.evidence!.locator!.pageIndex!}`;
      expect(page!.text.replace(/\s+/g, " ")).toContain(q.evidence!.quote.replace(/\s+/g, " ").slice(0, 40));
    }
    expect(inBook[2]!.evidence!.where).toMatch(/sahifa 3 \(kitobda: 2\)/);
    // credits: reserved then captured once
    expect(await getBalance(deps.sql, user.id)).toBeLessThan(before);
  });

  it("keeps a question whose answer is not in the book in review, with no citation (acceptance 4)", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { quizId } = await createQuiz(deps, user, { method: "from_qa", documentIds: [docId], qaText: sourceFixture("savollar-javoblar.txt").toString("utf8"), idempotencyKey: "qa-quiz-0002" });
    await testWorker(deps).drain();
    const quiz = await getQuizForEditor(deps, user, quizId);
    const outside = quiz.questions.find((q) => q.text.includes("so‘mi"))!;
    expect(outside.status).toBe("needs_review");
    expect(outside.evidenceStatus).toBe("not_found");
    expect(outside.evidence).toBeUndefined();
    expect(outside.checks!.find((c) => c.rule === "source_support")?.result).toBe("fail");
    const res = await approveQuestions(deps, user, quizId, quiz.questions.map((q) => q.id));
    expect(res.blocked.map((b) => b.questionId)).toEqual([outside.id]);
    await expect(publishQuiz(deps, user, quizId)).rejects.toMatchObject({ code: "questions_not_approved" });
    await expect(confirmEvidence(deps, user, quizId, outside.id)).rejects.toMatchObject({ code: "no_evidence_to_confirm" });
  });

  it("detects duplicate options and two correct answers in a single-answer question before publishing (acceptance 5)", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { quizId } = await createQuiz(deps, user, { method: "from_source", documentIds: [docId], settings: { count: 6 }, idempotencyKey: "src-quiz-0003" });
    await testWorker(deps).drain();
    const quiz = await getQuizForEditor(deps, user, quizId);
    expect(quiz.questions.length).toBeGreaterThanOrEqual(5);
    const q = quiz.questions[0]!;
    await expect(
      updateQuestion(deps, user, quizId, q.id, { text: q.text, type: "single", options: q.options!.map((o, i) => ({ id: o.id, text: o.text, correct: i < 2 })) }),
    ).rejects.toMatchObject({ code: "single_needs_one_correct" });
    const r = await updateQuestion(deps, user, quizId, q.id, {
      text: q.text, type: "single", explanation: "x",
      options: q.options!.map((o, i) => ({ id: o.id, text: i === 3 ? q.options![1]!.text : o.text, correct: !!o.correct })),
    });
    expect(r.checks.find((c) => c.rule === "options_distinct")?.result).toBe("fail");
    const appr = await approveQuestions(deps, user, quizId, [q.id]);
    expect(appr.blocked[0]?.reasons).toContain("options_distinct");
  });

  it("grades by option id after shuffling, never double-counts, and keeps old attempts on their version (acceptance 5 + 13)", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { quizId } = await createQuiz(deps, user, { method: "from_source", documentIds: [docId], settings: { count: 5, shuffleOptions: true, shuffleQuestions: true }, idempotencyKey: "src-quiz-0004" });
    await testWorker(deps).drain();
    let quiz = await getQuizForEditor(deps, user, quizId);
    const ids = quiz.questions.map((q) => q.id);
    const appr = await approveQuestions(deps, user, quizId, ids);
    expect(appr.blocked).toEqual([]);
    const pub1 = await publishQuiz(deps, user, quizId);

    // participant view has no keys
    const preview = await getQuizPreview(deps, user, quizId);
    expect(JSON.stringify(preview)).not.toMatch(/"correct"|whyWrong|explanation/);

    const student = user;
    const { attemptId } = await startAttempt(deps, student, quizId, "app_practice");
    const keyOf = new Map(quiz.questions.map((q) => [q.id, q.options!.find((o) => o.correct)!.id]));
    let state = await attemptState(deps, student, attemptId);
    const firstQ = state.question!;
    // answer correctly by id even though display order is shuffled
    const r1 = await answerAttempt(deps, student, attemptId, firstQ.id, [keyOf.get(firstQ.id)!]);
    expect(r1.isCorrect).toBe(true);
    const again = await answerAttempt(deps, student, attemptId, firstQ.id, [keyOf.get(firstQ.id)!]);
    expect(again.duplicate).toBe(true);
    expect(again.score).toBe(100);
    while ((state = await attemptState(deps, student, attemptId)).question) {
      const wrong = state.question!.options.find((o) => o.id !== keyOf.get(state.question!.id))!;
      await answerAttempt(deps, student, attemptId, state.question!.id, [wrong.id]);
    }
    const resultsV1 = await attemptResults(deps, student, attemptId);
    expect(resultsV1.score).toBe(100);

    // Edit a published question: creates draft v2, old attempt unchanged
    const target = quiz.questions.find((q) => q.id === firstQ.id)!;
    const newCorrect = target.options!.find((o) => !o.correct)!;
    await updateQuestion(deps, user, quizId, target.id, { text: target.text + " (tahrir)", type: "single", explanation: "tahrir", options: target.options!.map((o) => ({ id: o.id, text: o.text, correct: o.id === newCorrect.id })) });
    quiz = await getQuizForEditor(deps, user, quizId);
    expect(quiz.version!.version_no).toBe(2);
    expect(quiz.publishedVersionId).toBe(pub1.publishedVersionId);
    expect((await attemptResults(deps, student, attemptId)).score).toBe(100);
    const [oldQ] = await deps.sql<{ text: string; quiz_version_id: string }[]>`select text, quiz_version_id from questions where id = ${firstQ.id}`;
    expect(oldQ!.text).toBe(target.text);
    expect(oldQ!.quiz_version_id).toBe(pub1.publishedVersionId);
  });

  it("is idempotent: the same create request twice makes one quiz and one debit", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const before = await getBalance(deps.sql, user.id);
    const a = await createQuiz(deps, user, { method: "from_source", documentIds: [docId], settings: { count: 10 }, idempotencyKey: "same-key-0005" });
    const b = await createQuiz(deps, user, { method: "from_source", documentIds: [docId], settings: { count: 10 }, idempotencyKey: "same-key-0005" });
    expect(b.quizId).toBe(a.quizId);
    expect(b.duplicate).toBe(true);
    expect(before - (await getBalance(deps.sql, user.id))).toBe(a.credits);
  });

  it("forbids other accounts from reading editor data or using foreign documents", async () => {
    const owner = await makeUser(deps);
    const other = await makeUser(deps);
    const docId = await bookFor(owner);
    await expect(createQuiz(deps, other, { method: "from_source", documentIds: [docId], idempotencyKey: "foreign-doc-01" })).rejects.toMatchObject({ status: 404 });
    const { quizId } = await createQuiz(deps, owner, { method: "from_source", documentIds: [docId], idempotencyKey: "owner-quiz-001" });
    await expect(getQuizForEditor(deps, other, quizId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("Quiz Studio with an AI provider (SDK test double)", () => {
  it("drops fabricated citations and fails questions the blind checker disagrees with", async () => {
    const stub = anthropicStub((call) => {
      if (call.system.includes("independently check")) {
        // blind validator: agrees on q0, picks a different answer for q1
        const ids = [...call.user.matchAll(/<item id="(q\d+)">[\s\S]*?\n(A\)[\s\S]*?)<\/item>/g)].map((m) => m[1]);
        return {
          results: ids.map((id) => {
            const block = call.user.split(`<item id="${id}">`)[1]!.split("</item>")[0]!;
            const letterOf = (txt: string) => /^([A-D])\) /.exec(block.split("\n").find((l) => /^[A-D]\) /.test(l) && l.slice(3) === txt) ?? "")?.[1] ?? "?";
            return id === "q0"
              ? { id, chosen: [letterOf("Inflyatsiya")], answerable_from_source: true, other_defensible: [], ambiguous: false, language_ok: true, issues: [] }
              : { id, chosen: [letterOf("ortadi")], answerable_from_source: true, other_defensible: [], ambiguous: false, language_ok: true, issues: [] };
          }),
        };
      }
      const src = /<source id="(s\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(call.user)!;
      return {
        questions: [
          { question: "Narxlar umumiy darajasining uzoq muddat davomida barqaror o‘sishi nima deb ataladi?", type: "single",
            options: [{ text: "Inflyatsiya", correct: true, why_wrong: null }, { text: "Deflyatsiya", correct: false, why_wrong: "Bu narxlar pasayishi." }, { text: "Devalvatsiya", correct: false, why_wrong: "Valyuta kursi tushunchasi." }, { text: "Stagnatsiya", correct: false, why_wrong: "Oʻsish toʻxtashi." }],
            explanation: "Matnda inflyatsiya taʼrifi berilgan.", difficulty: "easy", cognitive_level: "recall", topic: "Inflyatsiya",
            evidence_source_id: findSource(call.user, "Inflyatsiya — bu"), evidence_quote: "Inflyatsiya — bu iqtisodiyotda narxlar umumiy darajasining uzoq muddat davomida barqaror o‘sishidir." },
          { question: "Narx oshsa talab miqdori qanday o‘zgaradi?", type: "single",
            options: [{ text: "kamayadi", correct: true, why_wrong: null }, { text: "ortadi", correct: false, why_wrong: "x" }, { text: "o‘zgarmaydi", correct: false, why_wrong: "x" }, { text: "ikki barobar", correct: false, why_wrong: "x" }],
            explanation: "Talab qonuni.", difficulty: "easy", cognitive_level: "recall", topic: "Talab",
            evidence_source_id: findSource(call.user, "Talab qonuniga"), evidence_quote: "Talab qonuniga ko‘ra, boshqa omillar o‘zgarmagan holda tovar narxi oshsa, unga bo‘lgan talab miqdori kamayadi." },
          { question: "Markaziy bank qachon tashkil etilgan?", type: "single",
            options: [{ text: "1991-yil", correct: true, why_wrong: null }, { text: "1992-yil", correct: false, why_wrong: "x" }, { text: "1994-yil", correct: false, why_wrong: "x" }, { text: "1995-yil", correct: false, why_wrong: "x" }],
            explanation: "-", difficulty: "easy", cognitive_level: "recall", topic: "Bank",
            evidence_source_id: src[1], evidence_quote: "Markaziy bank 1991-yilda tashkil etilgan." },
        ],
        not_enough_material_note: "Manba 3 ta savolga yetdi.",
      };
    });
    const ai = new AiClient({ ...deps.cfg, AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test" }, deps.sql, stub.client);
    const aiDeps = { ...deps, ai };
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { quizId } = await createQuiz(aiDeps, user, { method: "from_source", documentIds: [docId], settings: { count: 10 }, idempotencyKey: "ai-quiz-0001" });
    await testWorker(aiDeps).drain();
    const quiz = await getQuizForEditor(aiDeps, user, quizId);
    expect(quiz.version!.generation_note).toMatchObject({ requested: 10, produced: 3, mode: "ai" });
    const [inf, law, fake] = quiz.questions;
    expect(inf!.evidenceStatus).toBe("verified");
    expect(inf!.checks!.filter((c) => c.result !== "pass")).toEqual([]);
    expect(inf!.status).toBe("draft");
    expect(law!.checks!.find((c) => c.rule === "ai_blind_check")?.result).toBe("fail");
    expect(law!.status).toBe("needs_review");
    // the invented "1991" quote is not in the book: citation dropped, cannot be approved
    expect(fake!.evidence).toBeUndefined();
    expect(fake!.evidenceStatus).toBe("unverified");
    const appr = await approveQuestions(aiDeps, user, quizId, [fake!.id]);
    expect(appr.blocked).toHaveLength(1);
    // validation used a separate call that never saw the answer key
    const validatorCall = stub.calls.find((c) => c.system.includes("independently check"))!;
    expect(validatorCall.user).not.toContain("Bu narxlar pasayishi."); // distractor rationale
    expect(validatorCall.user).not.toContain("Matnda inflyatsiya taʼrifi berilgan."); // explanation
    expect(validatorCall.user).not.toMatch(/"correct"|correct:\s*true|\(to‘g‘ri\)/);
    const [usage] = await deps.sql<{ n: number }[]>`select count(*)::int as n from usage_events where kind = 'ai_tokens' and user_id = ${user.id}`;
    expect(usage!.n).toBe(2);
  });
});

function findSource(user: string, needle: string): string {
  for (const m of user.matchAll(/<source id="(s\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)) if (m[2]!.includes(needle)) return m[1]!;
  return "s1";
}
