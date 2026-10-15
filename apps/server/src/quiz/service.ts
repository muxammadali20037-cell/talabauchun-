import { effectiveLimits } from "../billing/plans";
import { CreateQuizRequest, QuestionEdit, QuizSettings, type Locator } from "@talaba/shared";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import type { Tx } from "../db/index";
import { requireObjectRole, requireWorkspaceRole } from "../access/policy";
import { estimateCredits, getBalance, loadPricing } from "../billing/credits";
import { enqueueJob } from "../jobs/queue";
import { AppError, badRequest, notFound } from "../lib/errors";
import { describeLocator } from "../search/retrieve";
import { findEvidenceForAnswer } from "./evidence";
import { insertCandidate, writeChecks } from "./store";
import { contentStems, coverage } from "./text";
import { deterministicChecks, nativePollCompatible, statusFromChecks, type Candidate, type Check } from "./validate";

export async function estimateQuiz(deps: Deps, user: UserRow, req: Pick<CreateQuizRequest, "method"> & { settings?: Partial<QuizSettings>; useAi?: boolean; questionsCount?: number }) {
  const pricing = await loadPricing(deps.sql);
  const settings = QuizSettings.parse(req.settings ?? {});
  const ai = (req.useAi ?? true) && !!deps.ai;
  const count = req.questionsCount ?? settings.count;
  const limits = await effectiveLimits(deps.sql, user.id);
  return { credits: estimateCredits(pricing, { kind: "quiz", questions: count, ai }), balance: await getBalance(deps.sql, user.id), ai, aiAvailable: !!deps.ai, maxQuestions: limits.maxQuestionsPerQuiz };
}

export async function createQuiz(deps: Deps, user: UserRow, raw: unknown, opts: { notifyChatId?: string | number | null; workspaceId?: string } = {}) {
  const req = CreateQuizRequest.parse(raw);
  const workspaceId = opts.workspaceId ?? user.personal_workspace_id;
  await requireWorkspaceRole(deps.sql, user, workspaceId, "editor");
  const docIds = "documentIds" in req ? req.documentIds : [];
  for (const id of docIds) await requireObjectRole(deps.sql, user, "document", id, "viewer");
  const settings = QuizSettings.parse({ language: user.language, ...(req.settings ?? {}) });
  const { maxQuestionsPerQuiz } = await effectiveLimits(deps.sql, user.id);
  if (settings.count > maxQuestionsPerQuiz) throw badRequest("quiz_too_many_questions", { max: maxQuestionsPerQuiz });
  const useAi = req.method !== "from_mistakes" && (req as { useAi?: boolean }).useAi !== false && !!deps.ai;
  const questionsCount =
    req.method === "from_qa" ? Math.max(1, req.qaText.split(/\n\s*\n/).length) : req.method === "from_questions" ? Math.max(1, req.questionsText.split("\n").filter((l) => l.trim()).length) : settings.count;
  const pricing = await loadPricing(deps.sql);
  const credits = estimateCredits(pricing, { kind: "quiz", questions: questionsCount, ai: useAi });
  const title = req.title?.trim() || (await defaultTitle(deps, docIds)) || "Quiz";

  return deps.sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; target_id: string }[]>`select id, target_id from generation_jobs where idempotency_key = ${`quiz:${user.id}:${req.idempotencyKey}`}`;
    if (existing) return { quizId: existing.target_id, jobId: existing.id, credits, duplicate: true };
    const [quiz] = await tx<{ id: string }[]>`
      insert into quizzes (workspace_id, owner_id, title, language, subject, topic, settings, source_document_ids)
      values (${workspaceId}, ${user.id}, ${title.slice(0, 200)}, ${settings.language}, ${settings.subject ?? null}, ${settings.topic ?? null},
              ${tx.json(settings as never)}, ${docIds}) returning id`;
    const [ver] = await tx<{ id: string }[]>`
      insert into quiz_versions (quiz_id, version_no, status, created_by) values (${quiz!.id}, 1, 'draft', ${user.id}) returning id`;
    await tx`update quizzes set draft_version_id = ${ver!.id} where id = ${quiz!.id}`;
    const { job } = await enqueueJob(tx, {
      kind: "generate_quiz",
      userId: user.id,
      workspaceId,
      targetId: quiz!.id,
      idempotencyKey: `quiz:${user.id}:${req.idempotencyKey}`,
      stages: ["generating", "validating"],
      input: { quizId: quiz!.id, versionId: ver!.id, request: req, useAi },
      credits,
      notifyChatId: opts.notifyChatId ?? null,
    });
    return { quizId: quiz!.id, jobId: job.id, credits, duplicate: false };
  });
}

async function defaultTitle(deps: Deps, docIds: string[]) {
  if (!docIds.length) return null;
  const [d] = await deps.sql<{ title: string }[]>`select title from documents where id = ${docIds[0]!}`;
  return d ? `${d.title} — quiz` : null;
}

type QRow = {
  id: string; stable_id: string; revision: number; position: number; type: string; text: string; language: string; topic: string | null;
  difficulty: string; cognitive_level: string; explanation: string | null; status: string; generator: string; evidence_status: string;
  payload: Record<string, unknown>; source_ref_id: string | null; quote: string | null; locator: Locator | null; document_title: string | null;
  document_id: string | null; verification: string | null;
};

async function loadQuestions(sql: Deps["sql"], versionId: string, withKeys: boolean) {
  const qs = await sql<QRow[]>`
    select q.id, q.stable_id, q.revision, q.position, q.type, q.text, q.language, q.topic, q.difficulty, q.cognitive_level, q.explanation,
           q.status, q.generator, q.evidence_status, q.payload, q.source_ref_id, sr.quote, sr.locator, sr.document_title, sr.document_id, sr.verification
    from questions q left join source_references sr on sr.id = q.source_ref_id
    where q.quiz_version_id = ${versionId} and q.status <> 'archived' order by q.position`;
  if (!qs.length) return [];
  const ids = qs.map((q) => q.id);
  const opts = await sql<{ id: string; question_id: string; stable_id: string; position: number; text: string; why_wrong: string | null }[]>`
    select id, question_id, stable_id, position, text, why_wrong from options where question_id in ${sql(ids)} order by question_id, position`;
  const keys = withKeys ? await sql<{ question_id: string; correct_option_ids: string[] }[]>`select question_id, correct_option_ids from private_answer_keys where question_id in ${sql(ids)}` : [];
  const checks = withKeys ? await sql<{ question_id: string; rule: string; result: string; checker: string; detail: Record<string, unknown> }[]>`select question_id, rule, result, checker, detail from question_checks where question_id in ${sql(ids)} order by created_at` : [];
  const keyMap = new Map(keys.map((k) => [k.question_id, new Set(k.correct_option_ids)]));
  return qs.map((q) => ({
    id: q.id,
    stableId: q.stable_id,
    revision: q.revision,
    position: q.position,
    type: q.type,
    text: q.text,
    language: q.language,
    topic: q.topic,
    difficulty: q.difficulty,
    cognitiveLevel: q.cognitive_level,
    status: q.status,
    generator: q.generator,
    evidenceStatus: q.evidence_status,
    nativePollOk: !!q.payload.nativePollOk,
    notes: withKeys ? q.payload : undefined,
    explanation: withKeys ? q.explanation : undefined,
    evidence: withKeys && q.quote ? { quote: q.quote, documentTitle: q.document_title, documentId: q.document_id, locator: q.locator, where: describeLocator(q.locator ?? {}), verification: q.verification } : undefined,
    options: opts
      .filter((o) => o.question_id === q.id)
      .map((o) => ({ id: o.id, stableId: o.stable_id, text: o.text, ...(withKeys ? { correct: keyMap.get(q.id)?.has(o.id) ?? false, whyWrong: o.why_wrong } : {}) })),
    checks: withKeys ? checks.filter((c) => c.question_id === q.id).map((c) => ({ rule: c.rule, result: c.result, checker: c.checker, detail: c.detail })) : undefined,
  }));
}

type QuizRow = { id: string; workspace_id: string; owner_id: string; title: string; language: string; settings: QuizSettings; draft_version_id: string | null; published_version_id: string | null; source_document_ids: string[]; visibility: string; updated_at: Date };

async function getQuizRow(sql: Deps["sql"] | Tx, quizId: string): Promise<QuizRow> {
  const [q] = await sql<QuizRow[]>`select id, workspace_id, owner_id, title, language, settings, draft_version_id, published_version_id, source_document_ids, visibility, updated_at from quizzes where id = ${quizId} and deleted_at is null`;
  if (!q) throw notFound("quiz");
  return q;
}

/** Editor view (owner/editor only): includes answer keys, evidence and check results. */
export async function getQuizForEditor(deps: Deps, user: UserRow, quizId: string) {
  const { role } = await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  const quiz = await getQuizRow(deps.sql, quizId);
  const versionId = quiz.draft_version_id ?? quiz.published_version_id;
  const [version] = versionId ? await deps.sql<{ id: string; version_no: number; status: string; generation_note: Record<string, unknown>; published_at: Date | null }[]>`select id, version_no, status, generation_note, published_at from quiz_versions where id = ${versionId}` : [];
  const [job] = await deps.sql<{ id: string; status: string; error_code: string | null }[]>`select id, status, error_code from generation_jobs where target_id = ${quizId} and kind = 'generate_quiz' order by created_at desc limit 1`;
  const versions = await deps.sql<{ id: string; version_no: number; status: string; published_at: Date | null; created_at: Date }[]>`select id, version_no, status, published_at, created_at from quiz_versions where quiz_id = ${quizId} order by version_no desc`;
  return {
    id: quiz.id, title: quiz.title, language: quiz.language, settings: quiz.settings, role, visibility: quiz.visibility,
    publishedVersionId: quiz.published_version_id, draftVersionId: quiz.draft_version_id, sourceDocumentIds: quiz.source_document_ids,
    version: version ?? null, versions, job: job ?? null,
    questions: versionId ? await loadQuestions(deps.sql, versionId, true) : [],
  };
}

/** Participant/preview view: published version only, never answer keys or hidden explanations. */
export async function getQuizPreview(deps: Deps, user: UserRow, quizId: string) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "viewer");
  const quiz = await getQuizRow(deps.sql, quizId);
  if (!quiz.published_version_id) throw new AppError("quiz_not_published", 409);
  return { id: quiz.id, title: quiz.title, versionId: quiz.published_version_id, questions: await loadQuestions(deps.sql, quiz.published_version_id, false) };
}

export async function listQuizzes(deps: Deps, user: UserRow, opts: { limit?: number; cursor?: string | null } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = await deps.sql<{ id: string; title: string; updated_at: Date; published_version_id: string | null; draft_version_id: string | null; questions: number; job_status: string | null }[]>`
    select q.id, q.title, q.updated_at, q.published_version_id, q.draft_version_id,
      (select count(*)::int from questions x where x.quiz_version_id = coalesce(q.draft_version_id, q.published_version_id) and x.status <> 'archived') as questions,
      (select j.status from generation_jobs j where j.target_id = q.id order by j.created_at desc limit 1) as job_status
    from quizzes q
    where q.deleted_at is null and q.workspace_id in (select workspace_id from memberships where user_id = ${user.id})
      and (${opts.cursor ?? null}::timestamptz is null or q.updated_at < ${opts.cursor ?? null}::timestamptz)
    order by q.updated_at desc limit ${limit + 1}`;
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.updated_at.toISOString() : null };
}

/**
 * Returns the editable draft version. If the quiz only has a published version,
 * a new draft is created by copying it (same stable ids), so earlier attempts
 * keep pointing at the version they were taken on.
 */
async function ensureDraft(tx: Tx, quiz: QuizRow, userId: string): Promise<string> {
  if (quiz.draft_version_id) return quiz.draft_version_id;
  if (!quiz.published_version_id) throw new AppError("quiz_has_no_version", 409);
  const [{ next }] = (await tx<{ next: number }[]>`select coalesce(max(version_no), 0) + 1 as next from quiz_versions where quiz_id = ${quiz.id}`) as unknown as [{ next: number }];
  const [ver] = await tx<{ id: string }[]>`
    insert into quiz_versions (quiz_id, version_no, status, based_on_version_id, created_by)
    values (${quiz.id}, ${next}, 'draft', ${quiz.published_version_id}, ${userId}) returning id`;
  const src = await tx<{ id: string }[]>`select id from questions where quiz_version_id = ${quiz.published_version_id} order by position`;
  for (const s of src) {
    const [nq] = await tx<{ id: string }[]>`
      insert into questions (quiz_version_id, stable_id, revision, position, type, text, language, topic, difficulty, cognitive_level, explanation,
        status, generator, evidence_status, source_ref_id, payload)
      select ${ver!.id}, stable_id, revision, position, type, text, language, topic, difficulty, cognitive_level, explanation,
        case when status = 'published' then 'approved' else status end, generator, evidence_status, source_ref_id, payload
      from questions where id = ${s.id} returning id`;
    const optMap = await tx<{ old_id: string; new_id: string }[]>`
      with src as (select id, stable_id, position, text, why_wrong from options where question_id = ${s.id}),
      ins as (insert into options (question_id, stable_id, position, text, why_wrong) select ${nq!.id}, stable_id, position, text, why_wrong from src returning id, stable_id)
      select src.id as old_id, ins.id as new_id from src join ins on ins.stable_id = src.stable_id`;
    const [key] = await tx<{ correct_option_ids: string[]; accepted_answers: string[] }[]>`select correct_option_ids, accepted_answers from private_answer_keys where question_id = ${s.id}`;
    const m = new Map(optMap.map((r) => [r.old_id, r.new_id]));
    await tx`insert into private_answer_keys (question_id, correct_option_ids, accepted_answers) values (${nq!.id}, ${(key?.correct_option_ids ?? []).map((id) => m.get(id)!).filter(Boolean)}, ${key?.accepted_answers ?? []})`;
    await tx`insert into question_checks (question_id, rule, result, checker, detail) select ${nq!.id}, rule, result, checker, detail from question_checks where question_id = ${s.id}`;
  }
  await tx`update quizzes set draft_version_id = ${ver!.id}, updated_at = now() where id = ${quiz.id}`;
  return ver!.id;
}

async function questionContext(tx: Tx, questionId: string) {
  const [q] = await tx<{ id: string; quiz_id: string; quiz_version_id: string; stable_id: string; status: string; version_status: string }[]>`
    select q.id, v.quiz_id, q.quiz_version_id, q.stable_id, q.status, v.status as version_status
    from questions q join quiz_versions v on v.id = q.quiz_version_id where q.id = ${questionId}`;
  if (!q) throw notFound("question");
  return q;
}

/** Maps a question id (possibly from the published version) to its counterpart in the draft. */
async function draftQuestionId(tx: Tx, quiz: QuizRow, user: UserRow, questionId: string) {
  const q = await questionContext(tx, questionId);
  if (q.quiz_id !== quiz.id) throw notFound("question");
  const draftId = await ensureDraft(tx, quiz, user.id);
  if (q.quiz_version_id === draftId) return { draftVersionId: draftId, questionId };
  const [d] = await tx<{ id: string }[]>`select id from questions where quiz_version_id = ${draftId} and stable_id = ${q.stable_id}`;
  if (!d) throw notFound("question");
  return { draftVersionId: draftId, questionId: d.id };
}

async function candidateFromDb(tx: Tx, questionId: string): Promise<Candidate> {
  const [q] = await tx<QRow[]>`
    select q.*, sr.quote, sr.locator, sr.document_title, sr.document_id, sr.verification
    from questions q left join source_references sr on sr.id = q.source_ref_id where q.id = ${questionId}`;
  const opts = await tx<{ id: string; text: string; why_wrong: string | null }[]>`select id, text, why_wrong from options where question_id = ${questionId} order by position`;
  const [key] = await tx<{ correct_option_ids: string[] }[]>`select correct_option_ids from private_answer_keys where question_id = ${questionId}`;
  return {
    text: q!.text, type: q!.type as Candidate["type"], explanation: q!.explanation, difficulty: q!.difficulty as Candidate["difficulty"], cognitiveLevel: q!.cognitive_level as Candidate["cognitiveLevel"],
    topic: q!.topic, language: q!.language, generator: q!.generator as Candidate["generator"], evidenceStatus: q!.evidence_status as Candidate["evidenceStatus"],
    options: opts.map((o) => ({ text: o.text, whyWrong: o.why_wrong, correct: key?.correct_option_ids.includes(o.id) ?? false })),
    evidence: q!.quote ? { chunkId: null, documentId: q!.document_id, documentVersionId: null, documentTitle: q!.document_title ?? "", locator: q!.locator ?? {}, quote: q!.quote, method: (q!.verification ?? "exact_quote") as "exact_quote" } : null,
  };
}

async function recheck(tx: Tx, versionId: string, questionId: string, sourcesOnly: boolean, aiAvailable: boolean): Promise<Check[]> {
  const ids = (await tx<{ id: string }[]>`select id from questions where quiz_version_id = ${versionId} and status <> 'archived'`).map((r) => r.id);
  const all = await Promise.all(ids.map((id) => candidateFromDb(tx, id)));
  const me = all[ids.indexOf(questionId)]!;
  const checks = deterministicChecks(me, all, { sourcesOnly, aiAvailable: false });
  void aiAvailable;
  // Keep earlier user confirmations (e.g. "evidence checked by me").
  const userChecks = await tx<{ rule: string; result: Check["result"]; detail: Record<string, unknown> }[]>`select rule, result, detail from question_checks where question_id = ${questionId} and checker = 'user'`;
  await writeChecks(tx, questionId, checks);
  const effective = checks.map((c) => (c.rule === "source_support" && userChecks.some((u) => u.rule === "evidence_confirmed") ? { ...c, result: "pass" as const } : c));
  const status = statusFromChecks(effective);
  await tx`update questions set status = ${status}, payload = payload || ${tx.json({ nativePollOk: nativePollCompatible(me) } as never)}, updated_at = now() where id = ${questionId}`;
  return checks;
}

export async function updateQuestion(deps: Deps, user: UserRow, quizId: string, questionId: string, raw: unknown) {
  const edit = QuestionEdit.parse(raw);
  await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  const correct = edit.options.filter((o) => o.correct).length;
  if (edit.type === "single" && correct !== 1) throw badRequest("single_needs_one_correct");
  if (edit.type === "multiple" && correct < 2) throw badRequest("multiple_needs_two_correct");
  return deps.sql.begin(async (tx) => {
    const quiz = await getQuizRow(tx, quizId);
    const { draftVersionId, questionId: qid } = await draftQuestionId(tx, quiz, user, questionId);
    const [before] = await tx<{ text: string; quote: string | null; evidence_status: string }[]>`
      select q.text, sr.quote, q.evidence_status from questions q left join source_references sr on sr.id = q.source_ref_id where q.id = ${qid}`;
    await tx`update questions set text = ${edit.text}, type = ${edit.type}, topic = ${edit.topic ?? null}, difficulty = ${edit.difficulty},
      cognitive_level = ${edit.cognitiveLevel}, explanation = ${edit.explanation ?? null}, revision = revision + 1, updated_at = now() where id = ${qid}`;
    // Replace options (keep stable ids of options that still exist by id)
    const existing = await tx<{ id: string; stable_id: string }[]>`select id, stable_id from options where question_id = ${qid}`;
    const keepStable = new Map(existing.map((o) => [o.id, o.stable_id]));
    await tx`delete from options where question_id = ${qid}`;
    const correctIds: string[] = [];
    for (let i = 0; i < edit.options.length; i++) {
      const o = edit.options[i]!;
      const stable = o.id ? keepStable.get(o.id) : undefined;
      const [row] = stable
        ? await tx<{ id: string }[]>`insert into options (question_id, stable_id, position, text, why_wrong) values (${qid}, ${stable}, ${i}, ${o.text}, ${o.whyWrong ?? null}) returning id`
        : await tx<{ id: string }[]>`insert into options (question_id, position, text, why_wrong) values (${qid}, ${i}, ${o.text}, ${o.whyWrong ?? null}) returning id`;
      if (o.correct) correctIds.push(row!.id);
    }
    await tx`update private_answer_keys set correct_option_ids = ${correctIds}, updated_at = now() where question_id = ${qid}`;
    // If the new correct answer is not in the stored evidence anymore, the evidence no longer proves it.
    if (before?.quote) {
      const cov = Math.min(...edit.options.filter((o) => o.correct).map((o) => coverage(contentStems(o.text), contentStems(before.quote!))));
      if (cov < 0.6 && before.evidence_status === "verified") {
        await tx`update questions set evidence_status = 'unverified' where id = ${qid}`;
        await tx`delete from question_checks where question_id = ${qid} and checker = 'user' and rule = 'evidence_confirmed'`;
      }
    }
    const settings = quiz.settings ?? QuizSettings.parse({});
    const checks = await recheck(tx, draftVersionId, qid, settings.sourceMode === "sources_only", !!deps.ai);
    await tx`update quizzes set updated_at = now() where id = ${quizId}`;
    return { questionId: qid, draftVersionId, checks };
  });
}

export async function addQuestion(deps: Deps, user: UserRow, quizId: string, raw: unknown) {
  const edit = QuestionEdit.parse(raw);
  await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  const quiz = await getQuizRow(deps.sql, quizId);
  const answer = edit.options.find((o) => o.correct)?.text ?? "";
  const ev = answer ? await findEvidenceForAnswer(deps, { userId: user.id, documentIds: quiz.source_document_ids, question: edit.text, answer }) : null;
  return deps.sql.begin(async (tx) => {
    const q = await getQuizRow(tx, quizId);
    const draftId = await ensureDraft(tx, q, user.id);
    const [{ pos }] = (await tx<{ pos: number }[]>`select coalesce(max(position), -1) + 1 as pos from questions where quiz_version_id = ${draftId}`) as unknown as [{ pos: number }];
    const c: Candidate = {
      text: edit.text, type: edit.type === "multiple" ? "multiple" : "single", options: edit.options.map((o) => ({ text: o.text, correct: o.correct, whyWrong: o.whyWrong })),
      explanation: edit.explanation ?? null, difficulty: edit.difficulty, cognitiveLevel: edit.cognitiveLevel, topic: edit.topic ?? null, language: q.language,
      evidence: ev?.evidence ?? null, evidenceStatus: ev?.evidence ? "verified" : q.source_document_ids.length ? "not_found" : "unverified", generator: "user",
      notes: ev?.closestPassage ? { closestPassage: ev.closestPassage } : undefined,
    };
    const qid = await insertCandidate(tx, { versionId: draftId, workspaceId: q.workspace_id, position: pos, c, checks: [], status: "draft" });
    const checks = await recheck(tx, draftId, qid, (q.settings?.sourceMode ?? "sources_only") === "sources_only", !!deps.ai);
    return { questionId: qid, checks };
  });
}

export async function removeQuestion(deps: Deps, user: UserRow, quizId: string, questionId: string) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  await deps.sql.begin(async (tx) => {
    const quiz = await getQuizRow(tx, quizId);
    const { questionId: qid } = await draftQuestionId(tx, quiz, user, questionId);
    await tx`update questions set status = 'archived', updated_at = now() where id = ${qid}`;
  });
}

/** The user states they checked the evidence passage themselves (kept as a separate, visible check). */
export async function confirmEvidence(deps: Deps, user: UserRow, quizId: string, questionId: string) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  return deps.sql.begin(async (tx) => {
    const quiz = await getQuizRow(tx, quizId);
    const { draftVersionId, questionId: qid } = await draftQuestionId(tx, quiz, user, questionId);
    const [q] = await tx<{ source_ref_id: string | null }[]>`select source_ref_id from questions where id = ${qid}`;
    if (!q?.source_ref_id) throw new AppError("no_evidence_to_confirm", 409);
    await tx`update questions set evidence_status = 'verified' where id = ${qid}`;
    await tx`update source_references set verified = true, verification = 'user_confirmed' where id = ${q.source_ref_id}`;
    await tx`delete from question_checks where question_id = ${qid} and checker = 'user' and rule = 'evidence_confirmed'`;
    await tx`insert into question_checks (question_id, rule, result, checker, detail) values (${qid}, 'evidence_confirmed', 'pass', 'user', ${tx.json({ by: user.id } as never)})`;
    return recheck(tx, draftVersionId, qid, (quiz.settings?.sourceMode ?? "sources_only") === "sources_only", !!deps.ai);
  });
}

/**
 * Approves questions after human review. Questions with failing checks or
 * without verified evidence (in "only my sources" mode) cannot be approved.
 * Warnings are acknowledged by the explicit approve action.
 */
export async function approveQuestions(deps: Deps, user: UserRow, quizId: string, questionIds: string[]) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  return deps.sql.begin(async (tx) => {
    const quiz = await getQuizRow(tx, quizId);
    const sourcesOnly = (quiz.settings?.sourceMode ?? "sources_only") === "sources_only";
    const approved: string[] = [];
    const blocked: { questionId: string; reasons: string[] }[] = [];
    for (const id of questionIds) {
      const { questionId: qid } = await draftQuestionId(tx, quiz, user, id);
      const [q] = await tx<{ evidence_status: string; status: string }[]>`select evidence_status, status from questions where id = ${qid}`;
      const fails = await tx<{ rule: string }[]>`select rule from question_checks where question_id = ${qid} and result = 'fail'`;
      const userConfirmed = (await tx`select 1 from question_checks where question_id = ${qid} and rule = 'evidence_confirmed' and checker = 'user'`).length > 0;
      const reasons = fails.map((f) => f.rule).filter((r) => !(r === "source_support" && userConfirmed));
      if (sourcesOnly && q!.evidence_status !== "verified") reasons.push("evidence_not_verified");
      if (!sourcesOnly && !["verified", "general_knowledge"].includes(q!.evidence_status)) reasons.push("evidence_not_verified");
      if (reasons.length) blocked.push({ questionId: id, reasons: [...new Set(reasons)] });
      else {
        await tx`update questions set status = 'approved', updated_at = now() where id = ${qid}`;
        approved.push(qid);
      }
    }
    return { approved, blocked };
  });
}

export async function publishQuiz(deps: Deps, user: UserRow, quizId: string) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  return deps.sql.begin(async (tx) => {
    const quiz = await getQuizRow(tx, quizId);
    if (!quiz.draft_version_id) throw new AppError("nothing_to_publish", 409);
    const qs = await tx<{ id: string; status: string; evidence_status: string }[]>`
      select id, status, evidence_status from questions where quiz_version_id = ${quiz.draft_version_id} and status <> 'archived'`;
    if (!qs.length) throw new AppError("quiz_empty", 409);
    const notApproved = qs.filter((q) => q.status !== "approved").map((q) => q.id);
    if (notApproved.length) throw new AppError("questions_not_approved", 409, "approve or remove questions first", { questionIds: notApproved });
    const sourcesOnly = (quiz.settings?.sourceMode ?? "sources_only") === "sources_only";
    const unverified = qs.filter((q) => (sourcesOnly ? q.evidence_status !== "verified" : !["verified", "general_knowledge"].includes(q.evidence_status))).map((q) => q.id);
    if (unverified.length) throw new AppError("questions_without_evidence", 409, "evidence missing", { questionIds: unverified });
    await tx`update questions set status = 'published' where quiz_version_id = ${quiz.draft_version_id} and status = 'approved'`;
    await tx`update quiz_versions set status = 'archived' where quiz_id = ${quizId} and status = 'published'`;
    await tx`update quiz_versions set status = 'published', published_at = now() where id = ${quiz.draft_version_id}`;
    await tx`update quizzes set published_version_id = ${quiz.draft_version_id}, draft_version_id = null, updated_at = now() where id = ${quizId}`;
    return { publishedVersionId: quiz.draft_version_id, questions: qs.length };
  });
}

export async function reportQuestion(deps: Deps, user: UserRow, questionId: string, reason: string, comment?: string) {
  const allowed = ["wrong_key", "ambiguous", "bad_source", "typo", "other"];
  if (!allowed.includes(reason)) throw badRequest("invalid_reason");
  // Reporter must have seen the question: member of its workspace, or took it in an attempt/room.
  const [ok] = await deps.sql<{ ok: boolean }[]>`
    select exists (
      select 1 from questions q join quiz_versions v on v.id = q.quiz_version_id join quizzes z on z.id = v.quiz_id
      join memberships m on m.workspace_id = z.workspace_id and m.user_id = ${user.id} where q.id = ${questionId}
    ) or exists (
      select 1 from attempts a where a.user_id = ${user.id} and ${questionId} = any(a.question_ids)
    ) or exists (
      select 1 from rooms r join room_members rm on rm.room_id = r.id and rm.user_id = ${user.id} where ${questionId} = any(r.question_ids)
    ) as ok`;
  if (!ok?.ok) throw notFound("question");
  await deps.sql`
    insert into question_reports (question_id, reporter_id, reason, comment) values (${questionId}, ${user.id}, ${reason}, ${comment?.slice(0, 1000) ?? null})
    on conflict (question_id, reporter_id) do update set reason = excluded.reason, comment = excluded.comment, status = 'open', created_at = now()`;
}

export async function renameQuiz(deps: Deps, user: UserRow, quizId: string, title: string) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "editor");
  if (!title.trim()) throw badRequest("title_required");
  await deps.sql`update quizzes set title = ${title.trim().slice(0, 200)}, updated_at = now() where id = ${quizId}`;
}
