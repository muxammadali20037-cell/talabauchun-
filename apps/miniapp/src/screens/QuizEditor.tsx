import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageKey } from "@talaba/shared";
import { api, ApiError } from "../lib/api";
import { useMe } from "../lib/auth";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { useJob } from "../lib/jobs";
import { haptic, openTelegramLink } from "../lib/telegram";
import { MoveToWorkspace } from "./workspaces/Workspaces";
import { Badge, Banner, ErrorState, Field, JobProgress, Loading, SaveState, Screen, Segmented, Sheet, Toggle, toast } from "../components/ui";

type Check = { rule: string; result: "pass" | "warn" | "fail"; checker: string; detail: Record<string, unknown> };
type Option = { id: string; stableId: string; text: string; correct: boolean; whyWrong: string | null };
type Question = {
  id: string; stableId: string; position: number; type: string; text: string; status: string; generator: string; evidenceStatus: string;
  difficulty: string; cognitiveLevel: string; explanation: string | null; nativePollOk: boolean; notes: Record<string, unknown>;
  evidence?: { quote: string; documentTitle: string | null; documentId: string | null; locator: { pageIndex?: number; slide?: number; section?: number } | null; where: string; verification: string };
  options: Option[]; checks: Check[];
};
type Editor = {
  id: string; title: string; role: string; settings: { sourceMode?: string; timePerQuestionSec?: number }; publishedVersionId: string | null; draftVersionId: string | null;
  version: { id: string; version_no: number; status: string; generation_note: { requested?: number; produced?: number; note?: string | null; mode?: string } } | null;
  job: { id: string; status: string; error_code: string | null } | null;
  questions: Question[];
};

const STATUS_BADGE: Record<string, ["neutral" | "primary" | "success" | "warn" | "danger", MessageKey]> = {
  draft: ["primary", "quiz.checked"],
  needs_review: ["warn", "quiz.needsReview"],
  approved: ["success", "quiz.approved"],
  published: ["success", "quiz.published"],
};

export function QuizEditor() {
  const { id } = useParams();
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["quiz-editor", id], queryFn: () => api.get<Editor>(`/api/quizzes/${id}/editor`) });
  const running = q.data?.job && !["completed", "failed", "cancelled"].includes(q.data.job.status);
  const job = useJob(running ? q.data!.job!.id : null);
  useEffect(() => {
    if (job.data?.status === "completed") void qc.invalidateQueries({ queryKey: ["quiz-editor", id] });
  }, [job.data?.status, qc, id]);
  const [editing, setEditing] = useState<Question | "new" | null>(null);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "danger" | "success" | "warn"; text: string } | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["quiz-editor", id] });

  if (q.isLoading) return <Screen title={t("quiz.title")}><Loading /></Screen>;
  if (q.isError || !q.data) return <Screen title={t("quiz.title")}><ErrorState error={q.error} onRetry={() => q.refetch()} /></Screen>;
  const quiz = q.data;
  const qs = quiz.questions;
  const needs = qs.filter((x) => x.status === "needs_review").length;
  const checked = qs.filter((x) => x.status === "draft").length;
  const approved = qs.filter((x) => x.status === "approved" || x.status === "published").length;
  const note = quiz.version?.generation_note;
  const isPublishedView = !quiz.draftVersionId && !!quiz.publishedVersionId;

  const act = async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (okText) toast(okText);
      haptic("success");
      await reload();
    } catch (e) {
      haptic("error");
      if (e instanceof ApiError && (e.code === "questions_not_approved" || e.code === "questions_without_evidence")) {
        setMsg({ kind: "warn", text: `${t("quiz.cannotPublishUnverified")} (${(e.details?.questionIds as string[] | undefined)?.length ?? "?"})` });
      } else setMsg({ kind: "danger", text: errorMessage(e, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={quiz.title} actions={quiz.publishedVersionId ? <button className="btn btn-primary btn-sm" onClick={() => setShare(true)}>▶ {t("quiz.play")}</button> : undefined}>
      <div className="stack-l">
        {running && job.data && <JobProgress status={job.data.status} done={job.data.stagesDone} total={job.data.stagesTotal} />}
        {quiz.job?.status === "failed" && <Banner kind="danger">{t("common.error")} {t("credits.refundedOnFail")}</Banner>}

        <div className="card stack">
          <div className="row wrap">
            {quiz.publishedVersionId ? <Badge kind="success">{t("quiz.published")}</Badge> : <Badge kind="neutral">{t("quiz.draft")}</Badge>}
            {quiz.version && <Badge kind="neutral">v{quiz.version.version_no}</Badge>}
            {note?.mode && <Badge kind="primary">{note.mode === "ai" ? t("quiz.generatorAi") : t("quiz.generatorExtractive")}</Badge>}
          </div>
          <div className="row wrap small">
            <span>{t("quiz.questionsN", { n: qs.length })}</span>·<span>{t("quiz.approved")}: {approved}</span>·<span>{t("quiz.checked")}: {checked}</span>·<span>{t("quiz.needsReview")}: {needs}</span>
          </div>
          {note && note.requested && note.produced != null && note.produced < note.requested && (
            <Banner kind="info">{t("quiz.fewerThanAsked", { asked: note.requested, got: note.produced })}{note.note ? ` ${note.note}` : ""}</Banner>
          )}
          {quiz.draftVersionId && quiz.publishedVersionId && <Banner kind="info">{t("quiz.newVersionNote")}</Banner>}
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          <div className="row wrap">
            {checked > 0 && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(() => api.post(`/api/quizzes/${id}/approve`, { questionIds: qs.filter((x) => x.status === "draft").map((x) => x.id) }), t("common.saved"))}>
                ✓ {t("quiz.approveAll")}
              </button>
            )}
            {quiz.draftVersionId && (
              <button className="btn btn-primary btn-sm" disabled={busy || !qs.length} onClick={() => act(() => api.post(`/api/quizzes/${id}/publish`), t("quiz.published"))}>
                {t("quiz.publish")}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing("new")}>+ {t("quiz.addQuestion")}</button>
          </div>
          {qs.length > 0 && (
            <div className="row wrap">
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(async () => {
                const r = await api.post<{ created: number }>(`/api/flashcards/from-quiz/${id}`);
                toast(t("cards.created", { n: r.created }));
              })}>🃏 {t("cards.fromQuiz")}</button>
              {quiz.role === "owner" && <MoveToWorkspace kind="quiz" id={id!} onDone={reload} />}
            </div>
          )}
          <p className="caption">{t("quiz.reviewPolicy")}</p>
        </div>

        {qs.map((question, i) => (
          <QuestionCard
            key={question.id}
            q={question}
            n={i + 1}
            busy={busy}
            readOnly={isPublishedView && false}
            onEdit={() => setEditing(question)}
            onApprove={() =>
              act(async () => {
                const r = await api.post<{ blocked: { reasons: string[] }[] }>(`/api/quizzes/${id}/approve`, { questionIds: [question.id] });
                if (r.blocked.length) throw new ApiError(409, "questions_without_evidence", { questionIds: [question.id] });
              }, t("quiz.approved"))
            }
            onConfirmEvidence={() => act(() => api.post(`/api/quizzes/${id}/questions/${question.id}/confirm-evidence`), t("common.saved"))}
            onRemove={() => act(() => api.del(`/api/quizzes/${id}/questions/${question.id}`), t("common.done"))}
          />
        ))}
        {!qs.length && !running && <Banner kind="info">{t("quiz.noQuestionsYet")}</Banner>}
      </div>
      {editing && <QuestionSheet quizId={id!} question={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {share && <PlaySheet quizId={id!} questions={qs} onClose={() => setShare(false)} />}
    </Screen>
  );
}

function CheckChips({ checks }: { checks: Check[] }) {
  const t = useT();
  const bad = checks.filter((c) => c.result !== "pass");
  if (!bad.length) return <span className="caption">✓ {t("quiz.allChecksPassed")}</span>;
  return (
    <ul className="checks" aria-label={t("quiz.checks")} style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {bad.map((c, i) => (
        <li key={i}>
          <Badge kind={c.result === "fail" ? "danger" : "warn"}>
            {c.result === "fail" ? "✕" : "!"} {t(`quizRule.${c.rule}` as MessageKey)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function QuestionCard({ q, n, busy, onEdit, onApprove, onConfirmEvidence, onRemove }: { q: Question; n: number; busy: boolean; readOnly: boolean; onEdit: () => void; onApprove: () => void; onConfirmEvidence: () => void; onRemove: () => void }) {
  const t = useT();
  const [kind, key] = STATUS_BADGE[q.status] ?? ["neutral", "quiz.draft"];
  const notes = q.notes ?? {};
  const closest = notes.closestPassage as { quote: string; documentTitle: string } | undefined;
  const candidates = notes.candidatePassages as { quote: string; documentTitle: string }[] | undefined;
  const fail = q.checks.some((c) => c.result === "fail" && !(c.rule === "source_support" && q.checks.some((u) => u.rule === "evidence_confirmed")));
  const sourceLink = q.evidence?.documentId && q.evidence.locator ? `/library/${q.evidence.documentId}/page/${q.evidence.locator.pageIndex ?? q.evidence.locator.slide ?? q.evidence.locator.section ?? 1}` : null;
  return (
    <article className="card q-card" aria-labelledby={`q-${q.id}`}>
      <div className="q-head">
        <span className="q-num" aria-hidden>{n}</span>
        <div className="grow stack" style={{ gap: 6 }}>
          <div className="row wrap">
            <Badge kind={kind}>{t(key)}</Badge>
            <Badge kind="neutral">{q.generator === "ai" ? t("quiz.generatorAi") : q.generator === "extractive" ? t("quiz.generatorExtractive") : t("quiz.generatorUser")}</Badge>
            {q.type === "multiple" && <Badge kind="primary">{t("quiz.multipleCorrect")}</Badge>}
            {!q.nativePollOk && <Badge kind="neutral">{t("quiz.miniAppOnly")}</Badge>}
          </div>
          <h3 id={`q-${q.id}`} className="break" style={{ fontWeight: 600 }}>{q.text}</h3>
        </div>
      </div>
      <div>
        {q.options.map((o, i) => (
          <div key={o.id} className={`opt-line${o.correct ? " is-correct" : ""}`}>
            <span className="tick" aria-hidden>{o.correct ? "✓" : String.fromCharCode(65 + i)}</span>
            <span className="grow break">
              {o.text}
              {o.correct && <span className="sr-only"> ({t("quiz.correct")})</span>}
            </span>
          </div>
        ))}
        {!q.options.length && <Banner kind="warn">{t("quiz.needsAnswer")}</Banner>}
      </div>
      {q.evidence ? (
        <div className={`evidence${q.evidenceStatus === "verified" ? "" : " missing"}`}>
          <div className="caption">
            {q.evidenceStatus === "verified" ? "✓ " + t("quiz.evidenceVerified") : "! " + t("quiz.evidenceUnverified")} · {q.evidence.documentTitle} · {q.evidence.where}
            {q.evidence.verification === "user_confirmed" && ` · ${t("quiz.userConfirmed")}`}
          </div>
          <blockquote style={{ margin: "6px 0 0" }} className="break">«{q.evidence.quote}»</blockquote>
          {sourceLink && <Link to={sourceLink} className="small">{t("quiz.openSource")} →</Link>}
        </div>
      ) : (
        <div className="evidence missing">
          <strong className="small">✕ {t("quiz.evidenceMissing")}</strong>
          {closest && <p className="small break" style={{ marginTop: 6 }}>{t("quiz.closestPassage")}: «{closest.quote}» — {closest.documentTitle}</p>}
          {candidates?.slice(0, 2).map((c, i) => <p key={i} className="small break" style={{ marginTop: 6 }}>«{c.quote.slice(0, 220)}…» — {c.documentTitle}</p>)}
        </div>
      )}
      {typeof notes.conflict === "string" && <Banner kind="warn">{t("quiz.conflict")} {notes.conflict}</Banner>}
      {q.explanation && <p className="small muted break"><strong>{t("quiz.explanation")}:</strong> {q.explanation}</p>}
      <CheckChips checks={q.checks} />
      <div className="row wrap">
        <button className="btn btn-secondary btn-sm" onClick={onEdit}>✎ {t("common.edit")}</button>
        {(q.status === "needs_review" || q.status === "draft") && !fail && q.evidenceStatus === "verified" && (
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onApprove}>✓ {t("quiz.approve")}</button>
        )}
        {q.evidence && q.evidenceStatus !== "verified" && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onConfirmEvidence}>{t("quiz.confirmEvidence")}</button>
        )}
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onRemove} aria-label={`${t("common.delete")} ${n}`}>🗑</button>
      </div>
    </article>
  );
}

type Draft = { text: string; type: "single" | "multiple"; explanation: string; options: { id?: string; text: string; correct: boolean; whyWrong: string }[] };

function QuestionSheet({ quizId, question, onClose, onSaved }: { quizId: string; question: Question | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const storageKey = `talaba.qdraft.${quizId}.${question?.stableId ?? "new"}`;
  const initial: Draft = (() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved) as Draft;
    } catch {
      /* ignore */
    }
    return question
      ? { text: question.text, type: question.type === "multiple" ? "multiple" : "single", explanation: question.explanation ?? "", options: question.options.map((o) => ({ id: o.id, text: o.text, correct: o.correct, whyWrong: o.whyWrong ?? "" })) }
      : { text: "", type: "single", explanation: "", options: [0, 1, 2, 3].map((i) => ({ text: "", correct: i === 0, whyWrong: "" })) };
  })();
  const [d, setD] = useState<Draft>(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  // Local draft survives a closed app or a dropped connection until the server confirms the save.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(d));
    } catch {
      /* ignore */
    }
  }, [d, storageKey]);
  const correctCount = d.options.filter((o) => o.correct).length;
  const valid = d.text.trim().length >= 3 && d.options.length >= 2 && d.options.every((o) => o.text.trim()) && (d.type === "single" ? correctCount === 1 : correctCount >= 2);
  const save = async () => {
    setState("saving");
    setErr(null);
    try {
      const body = { text: d.text.trim(), type: d.type, explanation: d.explanation.trim() || null, options: d.options.map((o) => ({ id: o.id, text: o.text.trim(), correct: o.correct, whyWrong: o.whyWrong.trim() || null })) };
      if (question) await api.put(`/api/quizzes/${quizId}/questions/${question.id}`, body);
      else await api.post(`/api/quizzes/${quizId}/questions`, body);
      localStorage.removeItem(storageKey);
      setState("saved");
      onSaved();
      onClose();
    } catch (e) {
      setState("error");
      setErr(errorMessage(e, t));
    }
  };
  const setOpt = (i: number, patch: Partial<Draft["options"][number]>) => setD({ ...d, options: d.options.map((o, j) => (j === i ? { ...o, ...patch } : patch.correct && d.type === "single" ? { ...o, correct: false } : o)) });
  return (
    <Sheet open onClose={onClose} title={question ? t("common.edit") : t("quiz.addQuestion")}>
      <div className="stack">
        <Field label={t("quiz.questionText")}>{(id) => <textarea id={id} className="textarea" rows={3} value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} />}</Field>
        <Toggle label={t("quiz.multipleCorrect")} checked={d.type === "multiple"} onChange={(v) => setD({ ...d, type: v ? "multiple" : "single", options: v ? d.options : d.options.map((o, i) => ({ ...o, correct: i === d.options.findIndex((x) => x.correct) })) })} />
        {d.options.map((o, i) => (
          <div key={i} className="card flat stack" style={{ padding: 12 }}>
            <div className="row">
              <input
                type={d.type === "single" ? "radio" : "checkbox"}
                name="correct"
                aria-label={`${t("quiz.markCorrect")} ${String.fromCharCode(65 + i)}`}
                checked={o.correct}
                onChange={(e) => setOpt(i, { correct: e.target.checked })}
                style={{ width: 22, height: 22 }}
              />
              <input className="input grow" aria-label={`${t("quiz.optionText")} ${String.fromCharCode(65 + i)}`} value={o.text} maxLength={500} onChange={(e) => setOpt(i, { text: e.target.value })} />
              {d.options.length > 2 && (
                <button className="icon-btn" aria-label={t("common.delete")} onClick={() => setD({ ...d, options: d.options.filter((_, j) => j !== i) })}>✕</button>
              )}
            </div>
            {!o.correct && <input className="input" aria-label={t("quiz.whyWrong")} placeholder={t("quiz.whyWrong")} value={o.whyWrong} onChange={(e) => setOpt(i, { whyWrong: e.target.value })} />}
          </div>
        ))}
        {d.options.length < 6 && <button className="btn btn-ghost btn-sm" onClick={() => setD({ ...d, options: [...d.options, { text: "", correct: false, whyWrong: "" }] })}>+ {t("quiz.addOption")}</button>}
        <Field label={t("quiz.explanation")}>{(id) => <textarea id={id} className="textarea" rows={3} value={d.explanation} onChange={(e) => setD({ ...d, explanation: e.target.value })} />}</Field>
        {!valid && <p className="error-text">{d.type === "single" ? t("quiz.needOneCorrect") : t("quiz.needTwoCorrect")}</p>}
        {err && <Banner kind="danger">{err}</Banner>}
        <p className="caption">{t("quiz.recheckNote")}</p>
        <div className="row">
          <SaveState state={state} />
          <span className="grow" />
          <button className="btn btn-secondary" onClick={() => (localStorage.removeItem(storageKey), onClose())}>{t("common.cancel")}</button>
          <button className="btn btn-primary" disabled={!valid || state === "saving"} onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    </Sheet>
  );
}

function PlaySheet({ quizId, questions, onClose }: { quizId: string; questions: Question[]; onClose: () => void }) {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const [time, setTime] = useState(30);
  const [speed, setSpeed] = useState(false);
  const [board, setBoard] = useState(true);
  const [anon, setAnon] = useState(false);
  const [teams, setTeams] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [group, setGroup] = useState<{ link: string | null; questions: number; skipped: number } | null>(null);
  const nativeOk = questions.filter((q) => q.nativePollOk && q.type !== "multiple").length;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={t("quiz.play")}>
      <div className="stack-l">
        <section className="stack">
          <h3>🎯 {t("quiz.practiceSelf")}</h3>
          <p className="caption">{t("quiz.practiceHint")}</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => {
            const r = await api.post<{ attemptId: string }>(`/api/quizzes/${quizId}/attempts`);
            navigate(`/attempt/${r.attemptId}`);
          })}>{t("practice.start")}</button>
        </section>
        <section className="stack">
          <h3>⚡ {t("quiz.openRoom")}</h3>
          <p className="caption">{t("quiz.liveRoomHint")}</p>
          <Field label={t("quiz.timePerQuestion")}>{(id) => <input id={id} className="input" type="number" min={5} max={300} value={time} onChange={(e) => setTime(Number(e.target.value))} />}</Field>
          <Toggle label={t("room.speedBonusToggle")} checked={speed} onChange={setSpeed} hint={speed ? t("room.speedBonusRule", { max: 50 }) : t("room.noSpeedBonus")} />
          <Toggle label={t("room.leaderboard")} checked={board} onChange={setBoard} hint={board ? t("room.leaderboardVisible") : t("room.leaderboardHidden")} />
          <Segmented label={t("room.battle")} value={String(teams)} onChange={(v) => setTeams(Number(v))} options={[
            { value: "0", label: t("room.individual") },
            { value: "2", label: t("room.teamsN", { n: 2 }) },
            { value: "3", label: t("room.teamsN", { n: 3 }) },
            { value: "4", label: t("room.teamsN", { n: 4 }) },
          ]} />
          {teams > 0 && <p className="caption">{t("room.battleHint")}</p>}
          <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => {
            const r = await api.post<{ roomId: string; inviteLink: string | null; inviteToken: string; inviteExpiresAt: string }>("/api/rooms", { quizId, settings: { timePerQuestionSec: time, speedBonus: speed, showLeaderboard: board, ...(teams ? { mode: "teams", teamCount: teams } : {}) } });
            // the invite token is shown once (only its hash is stored server-side)
            sessionStorage.setItem(`room.invite.${r.roomId}`, JSON.stringify(r));
            navigate(`/room/${r.roomId}`);
          })}>{t("room.create")}</button>
        </section>
        <section className="stack">
          <h3>💬 {t("quiz.shareToGroup")}</h3>
          <p className="caption">{t("group.howTo")} {t("quiz.nativeCount", { n: nativeOk, total: questions.length })}</p>
          <Toggle label={anon ? t("group.anonymous") : t("group.notAnonymous")} checked={anon} onChange={setAnon} />
          {!me.features.botUsername && <Banner kind="warn">{t("quiz.botNotConfigured")}</Banner>}
          <button className="btn btn-secondary" disabled={busy || !nativeOk} onClick={() => run(async () => {
            const r = await api.post<{ link: string | null; questions: number; skipped: number }>(`/api/quizzes/${quizId}/group-runs`, { anonymous: anon, openPeriod: time });
            setGroup(r);
            if (r.link) openTelegramLink(r.link);
          })}>{t("group.chooseGroup")}</button>
          {group && <Banner kind="info">{t("quiz.groupLinkCreated", { n: group.questions, skipped: group.skipped })}</Banner>}
        </section>
        {err && <Banner kind="danger">{err}</Banner>}
      </div>
    </Sheet>
  );
}
