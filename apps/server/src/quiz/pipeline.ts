import { shuffle } from "../lib/crypto";
import { CreateQuizRequest, QuizSettings, translate, type Lang } from "@talaba/shared";
import type { Deps } from "../deps";
import { AiError } from "../ai/client";
import { estimateCredits, loadPricing } from "../billing/credits";
import { JobError, type JobContext, type JobResult } from "../jobs/queue";
import { chunksForScope, retrieve } from "../search/retrieve";
import { enqueueMessage } from "../telegram/outbox";
import { miniAppUrl } from "../telegram/links";
import { escapeHtml } from "../ingest/pipeline";
import { aiAnswerAndDistract, aiBlindValidate, aiGenerateFromChunks } from "./ai-gen";
import { extractiveDistractors } from "./distractors";
import { findEvidenceForAnswer } from "./evidence";
import { extractiveQuestions, pickByDifficulty } from "./extractive-gen";
import { detectLanguage } from "./lang";
import { parseQaText, parseQuestionList } from "./parse-input";
import { insertCandidate } from "./store";
import { findDefinitions } from "./terms";
import { deterministicChecks, statusFromChecks, type Candidate, type Check } from "./validate";

type Input = { quizId: string; versionId: string; request: CreateQuizRequest; useAi: boolean };

function toAiError(e: unknown): never {
  if (e instanceof AiError) throw new JobError(`ai_${e.code}`, e.retryable);
  throw e;
}

/**
 * generate_quiz job: generating (AI or extractive) → validating (deterministic
 * rules + independent AI blind check when available) → stored as a draft
 * version. Nothing is published automatically.
 */
export function quizGenerateHandler(deps: Deps) {
  return async (ctx: JobContext): Promise<JobResult> => {
    const input = ctx.job.input as unknown as Input;
    const req = CreateQuizRequest.parse(input.request);
    const settings = QuizSettings.parse(req.settings ?? {});
    const userId = ctx.job.user_id;
    const meta = { userId, workspaceId: ctx.job.workspace_id, jobId: ctx.job.id };
    const useAi = input.useAi && !!deps.ai;
    let note: string | null = null;

    // ── generating ── (checkpointed so a restart does not pay for generation twice)
    let candidates = (ctx.checkpoint.candidates as Candidate[] | undefined) ?? null;
    if (!candidates) {
      await ctx.stage("generating");
      candidates = [];
      if (req.method === "from_source") {
        const chunks = await chunksForScope(deps, { userId, documentIds: req.documentIds, pageRanges: req.pageRanges, sectionIds: req.sectionIds, maxChunks: useAi ? 60 : 400 });
        if (!chunks.length) throw new JobError("no_source_text");
        const lang = settings.language || detectLanguage(chunks.map((c) => c.text).join(" "));
        if (useAi) {
          const r = await aiGenerateFromChunks(deps.ai!, chunks, { count: settings.count, language: lang, allowMultiple: settings.allowMultipleCorrect, allowTrueFalse: settings.includeTrueFalse, difficultyMix: settings.difficultyMix, topic: settings.topic, meta }).catch(toAiError);
          candidates = r.candidates;
          note = r.note;
        } else {
          candidates = pickByDifficulty(extractiveQuestions(chunks, { max: settings.count, trueFalse: settings.includeTrueFalse }), settings.count, settings.difficultyMix);
        }
      } else if (req.method === "from_questions" || req.method === "from_qa") {
        const parsed =
          req.method === "from_qa"
            ? parseQaText(req.qaText).items
            : parseQuestionList(req.questionsText).map((q, i) => ({ question: q, answer: null, options: null, explanation: null, line: i + 1 }));
        if (!parsed.length) throw new JobError("nothing_parsed");
        const lang = settings.language || detectLanguage(parsed.map((p) => p.question).join(" "));
        const docIds = req.documentIds ?? [];
        const lookups = await Promise.all(
          parsed.map(async (p) => {
            const answer = p.options?.find((o) => o.correct)?.text ?? p.answer;
            const ev = answer ? await findEvidenceForAnswer(deps, { userId, documentIds: docIds, question: p.question, answer }) : null;
            const chunks = ev?.candidates ?? (docIds.length ? await retrieve(deps, { query: p.question, userId, documentIds: docIds, limit: 6 }) : []);
            return { p, answer, ev, chunks };
          }),
        );
        if (useAi && lookups.some((l) => !l.p.options)) {
          const need = lookups.filter((l) => !l.p.options);
          const aiCands = await aiAnswerAndDistract(deps.ai!, need.map((l) => ({ question: l.p.question, userAnswer: l.answer, chunks: l.chunks.slice(0, 5) })), { language: lang, meta }).catch(toAiError);
          const byQuestion = new Map(need.map((l, i) => [l, aiCands[i]!]));
          candidates = lookups.map((l) => (l.p.options ? userOptionsCandidate(l, lang) : mergeEvidence(byQuestion.get(l)!, l.ev?.evidence ?? null)));
        } else {
          // extractive: distractors from the material's own terms and the other answers in the list
          const docChunks = docIds.length ? await chunksForScope(deps, { userId, documentIds: docIds, maxChunks: 400 }) : [];
          const terms = findDefinitions(docChunks.map((c) => c.text)).map((d) => d.term);
          const otherAnswers = lookups.map((l) => l.answer).filter((a): a is string => !!a);
          candidates = lookups.map((l) => {
            if (l.p.options) return userOptionsCandidate(l, lang);
            if (!l.answer) {
              return {
                text: l.p.question, type: "single", options: [], explanation: null, difficulty: "medium", cognitiveLevel: "recall", topic: null, language: lang,
                evidence: null, evidenceStatus: "unverified", generator: "extractive",
                notes: { needsAnswer: true, candidatePassages: l.chunks.slice(0, 3).map((c) => ({ quote: c.text.slice(0, 400), documentTitle: c.documentTitle, locator: c.locator })) },
              } satisfies Candidate;
            }
            const pool = [...otherAnswers.filter((a) => a !== l.answer), ...terms];
            const distract = extractiveDistractors(l.answer, pool, 3, lang);
            return {
              text: l.p.question,
              type: "single",
              options: [{ text: l.answer, correct: true }, ...distract.map((d) => ({ text: d, correct: false }))],
              explanation: l.p.explanation ?? (l.ev?.evidence ? l.ev.evidence.quote : null),
              difficulty: "medium", cognitiveLevel: "recall", topic: null, language: lang,
              evidence: l.ev?.evidence ?? null,
              evidenceStatus: l.ev?.evidence ? "verified" : docIds.length ? "not_found" : "unverified",
              generator: "user",
              notes: l.ev?.closestPassage ? { closestPassage: l.ev.closestPassage } : undefined,
            } satisfies Candidate;
          });
        }
      } else if (req.method === "from_mistakes") {
        candidates = await mistakesCandidates(deps, userId, settings.count);
        if (!candidates.length) throw new JobError("no_mistakes");
      }
      // Generated options are stored in random order (the correct one is not always first, even with
      // per-player shuffling switched off). Options the user typed keep the user's order.
      candidates = candidates.map((c) => (c.notes?.userOptions || c.type === "true_false" ? c : { ...c, options: shuffle(c.options) }));
      await ctx.saveCheckpoint({ candidates, note });
    } else {
      note = (ctx.checkpoint.note as string | null) ?? null;
    }

    await ctx.throwIfCancelled();

    // ── validating ──
    await ctx.stage("validating");
    const sourcesOnly = settings.sourceMode === "sources_only";
    const checks = new Map<number, Check[]>();
    candidates.forEach((c, i) => checks.set(i, deterministicChecks(c, candidates!, { sourcesOnly, aiAvailable: useAi })));
    if (useAi) {
      const toCheck = candidates.map((c, i) => ({ key: `q${i}`, c, passage: c.evidence?.quote ?? "" })).filter((x) => x.passage && x.c.options.length >= 2);
      if (toCheck.length) {
        const aiChecks = await aiBlindValidate(deps.ai!, toCheck, meta).catch(toAiError);
        for (const [key, list] of aiChecks) {
          const i = Number(key.slice(1));
          checks.set(i, [...(checks.get(i) ?? []), ...list]);
        }
      }
    }

    await deps.sql.begin(async (tx) => {
      // idempotent on retry: replace whatever an earlier attempt wrote
      await tx`delete from questions where quiz_version_id = ${input.versionId}`;
      let pos = 0;
      for (let i = 0; i < candidates!.length; i++) {
        const c = candidates![i]!;
        const list = checks.get(i) ?? [];
        await insertCandidate(tx, { versionId: input.versionId, workspaceId: ctx.job.workspace_id, position: pos++, c, checks: list, status: statusFromChecks(list) });
      }
      const requested = req.method === "from_source" || req.method === "from_mistakes" ? settings.count : candidates!.length;
      await tx`update quiz_versions set generation_note = ${tx.json({ requested, produced: candidates!.length, note, mode: useAi ? "ai" : "extractive" } as never)} where id = ${input.versionId}`;
      await tx`update quizzes set updated_at = now() where id = ${input.quizId}`;
    });

    const produced = candidates.length;
    const needsReview = [...checks.values()].filter((l) => statusFromChecks(l) === "needs_review").length;
    await notifyQuizReady(deps, ctx, input.quizId, produced);
    const pricing = await loadPricing(deps.sql);
    return {
      result: { quizId: input.quizId, versionId: input.versionId, produced, requested: settings.count, needsReview, note, mode: useAi ? "ai" : "extractive" },
      creditsUsed: estimateCredits(pricing, { kind: "quiz", questions: produced, ai: useAi }),
    };
  };
}

function userOptionsCandidate(l: { p: { question: string; options: { text: string; correct: boolean }[] | null; explanation: string | null }; ev: { evidence: Candidate["evidence"] } | null }, lang: string): Candidate {
  const correctCount = l.p.options!.filter((o) => o.correct).length;
  return {
    text: l.p.question, type: correctCount > 1 ? "multiple" : "single", options: l.p.options!, explanation: l.p.explanation,
    difficulty: "medium", cognitiveLevel: "recall", topic: null, language: lang,
    evidence: l.ev?.evidence ?? null, evidenceStatus: l.ev?.evidence ? "verified" : "not_found", generator: "user",
    notes: { userOptions: true },
  };
}

function mergeEvidence(c: Candidate, deterministic: Candidate["evidence"]): Candidate {
  // Prefer the deterministic exact-sentence match when the model did not return a verifiable quote.
  if (!c.evidence && deterministic) return { ...c, evidence: deterministic, evidenceStatus: "verified" };
  return c;
}

async function mistakesCandidates(deps: Deps, userId: string, count: number): Promise<Candidate[]> {
  const rows = await deps.sql<{ question_id: string }[]>`
    select distinct on (q.stable_id) q.id as question_id
    from attempt_answers aa join attempts a on a.id = aa.attempt_id join questions q on q.id = aa.question_id
    where a.user_id = ${userId} and aa.is_correct = false
    order by q.stable_id, aa.answered_at desc limit ${count}`;
  const out: Candidate[] = [];
  for (const r of rows) {
    const [q] = await deps.sql<{ text: string; type: Candidate["type"]; explanation: string | null; difficulty: Candidate["difficulty"]; cognitive_level: Candidate["cognitiveLevel"]; topic: string | null; language: string; evidence_status: Candidate["evidenceStatus"]; quote: string | null; locator: Candidate["evidence"] extends infer E ? E extends { locator: infer L } ? L : never : never; document_title: string | null; document_id: string | null; document_version_id: string | null; chunk_id: string | null; verification: string | null }[]>`
      select q.text, q.type, q.explanation, q.difficulty, q.cognitive_level, q.topic, q.language, q.evidence_status,
        sr.quote, sr.locator, sr.document_title, sr.document_id, sr.document_version_id, sr.chunk_id, sr.verification
      from questions q left join source_references sr on sr.id = q.source_ref_id where q.id = ${r.question_id}`;
    if (!q) continue;
    const opts = await deps.sql<{ id: string; text: string; why_wrong: string | null }[]>`select id, text, why_wrong from options where question_id = ${r.question_id} order by position`;
    const [key] = await deps.sql<{ correct_option_ids: string[] }[]>`select correct_option_ids from private_answer_keys where question_id = ${r.question_id}`;
    out.push({
      text: q.text, type: q.type, explanation: q.explanation, difficulty: q.difficulty, cognitiveLevel: q.cognitive_level, topic: q.topic, language: q.language,
      options: opts.map((o) => ({ text: o.text, whyWrong: o.why_wrong, correct: key?.correct_option_ids.includes(o.id) ?? false })),
      evidence: q.quote ? { chunkId: q.chunk_id, documentId: q.document_id, documentVersionId: q.document_version_id, documentTitle: q.document_title ?? "", locator: q.locator, quote: q.quote, method: (q.verification as "exact_quote") ?? "exact_quote" } : null,
      evidenceStatus: q.evidence_status,
      generator: "user",
      notes: { fromMistake: r.question_id },
    });
  }
  return out;
}

async function notifyQuizReady(deps: Deps, ctx: JobContext, quizId: string, produced: number) {
  if (!ctx.job.notify_chat_id) return;
  const [row] = await deps.sql<{ title: string; language: Lang }[]>`select q.title, u.language from quizzes q join users u on u.id = q.owner_id where q.id = ${quizId}`;
  if (!row) return;
  const url = miniAppUrl(deps.cfg, `/quiz/${quizId}/edit`);
  const keyboard = [
    ...(url ? [[{ text: translate(row.language, "common.edit"), web_app: { url } }]] : []),
    [{ text: translate(row.language, "quiz.playInBot"), callback_data: `qp:${quizId}` }],
  ];
  await enqueueMessage(deps.sql, {
    chatId: ctx.job.notify_chat_id,
    userId: ctx.job.user_id,
    method: "sendMessage",
    payload: { text: translate(row.language, "bot.quizReady", { title: escapeHtml(row.title), n: produced }), parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } },
    dedupeKey: `quiz-ready:${ctx.job.id}`,
  });
}
