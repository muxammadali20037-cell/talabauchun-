import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { haptic } from "../lib/telegram";
import { ActionBar, Banner, ErrorState, Loading, Screen } from "../components/ui";
import { ReportButton } from "../components/ReportButton";

type State = {
  attemptId: string; quizId: string; title: string; status: string; index: number; total: number; score: number; maxScore: number;
  question: { id: string; text: string; type: string; multiple: boolean; options: { id: string; text: string }[] } | null;
  alreadyAnswered: { question_id: string; selected_option_ids: string[]; is_correct: boolean } | null;
};
type Feedback = { isCorrect: boolean; correctOptionIds: string[]; correctTexts: string[]; whyWrong: string[]; explanation: string | null; source: { quote: string; documentTitle: string | null; where: string } | null; finished: boolean };

/** Self-practice: answer → immediate explanation with the book source → next; results with mistake replay. */
export function Practice() {
  const { id } = useParams();
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["attempt", id], queryFn: () => api.get<State>(`/api/attempts/${id}`) });
  const [picked, setPicked] = useState<string[]>([]);
  const [fb, setFb] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const results = useQuery({
    queryKey: ["attempt-results", id],
    enabled: st.data?.status === "finished" || !!fb?.finished,
    queryFn: () => api.post<{ score: number; maxScore: number; correct: number; total: number; mistakes: { questionId: string; text: string }[] }>(`/api/attempts/${id}/finish`),
  });

  if (st.isLoading) return <Screen title="…"><Loading /></Screen>;
  if (st.isError || !st.data) return <Screen title={t("quiz.title")}><ErrorState error={st.error} onRetry={() => st.refetch()} /></Screen>;
  const s = st.data;
  const q = s.question;

  if ((s.status === "finished" || (!q && !fb)) && results.data) {
    const r = results.data;
    return (
      <Screen title={t("practice.finished")}>
        <div className="stack-l">
          <div className="card stack" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 44 }} aria-hidden>{r.correct === r.total ? "🏆" : "🏁"}</div>
            <h2>{t("practice.result", { score: r.correct, max: r.total })}</h2>
            <div className="progress"><span style={{ width: `${(r.correct / Math.max(1, r.total)) * 100}%` }} /></div>
          </div>
          {r.mistakes.length ? (
            <section className="stack">
              <h2 className="section-title">{t("practice.mistakesTitle")}</h2>
              <div className="list">{r.mistakes.map((m) => <div key={m.questionId} className="list-item small break">{m.text}</div>)}</div>
              <button className="btn btn-primary" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const n = await api.post<{ attemptId: string }>(`/api/attempts/${id}/mistakes`);
                  navigate(`/attempt/${n.attemptId}`, { replace: true });
                } finally {
                  setBusy(false);
                }
              }}>🔁 {t("practice.reviewMistakes")}</button>
            </section>
          ) : <Banner kind="success">{t("practice.noMistakes")}</Banner>}
          <Link className="btn btn-secondary" to={`/quiz/${s.quizId}/edit`}>{t("common.back")}</Link>
        </div>
      </Screen>
    );
  }
  if (!q && !fb) return <Screen title={s.title}><Loading /></Screen>;

  const submit = async () => {
    if (!q || !picked.length) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<Feedback>(`/api/attempts/${id}/answer`, { questionId: q.id, optionIds: picked });
      setFb(r);
      haptic(r.isCorrect ? "success" : "error");
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const next = async () => {
    setFb(null);
    setPicked([]);
    await qc.invalidateQueries({ queryKey: ["attempt", id] });
  };
  return (
    <Screen title={s.title}>
      <div className="stack-l">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row between caption"><span>{t("practice.question", { i: s.index + 1, n: s.total })}</span><span>{s.score / 100} ✓</span></div>
          <div className="progress"><span style={{ width: `${(s.index / s.total) * 100}%` }} /></div>
        </div>
        {q && (
          <>
            <h2 className="break" style={{ fontSize: 19, lineHeight: 1.4 }}>{q.text}</h2>
            {q.multiple && <p className="caption">{t("quiz.multipleCorrect")}</p>}
            <div className="stack" role={q.multiple ? "group" : "radiogroup"}>
              {q.options.map((o, i) => {
                const chosen = picked.includes(o.id);
                const cls = fb ? (fb.correctOptionIds.includes(o.id) ? " correct" : chosen ? " wrong" : "") : "";
                return (
                  <button key={o.id} className={`choice${cls}`} aria-pressed={chosen} disabled={!!fb || busy} onClick={() => setPicked(q.multiple ? (chosen ? picked.filter((x) => x !== o.id) : [...picked, o.id]) : [o.id])}>
                    <span className="letter" aria-hidden>{String.fromCharCode(65 + i)}</span>
                    <span className="grow break">{o.text}</span>
                    {fb && fb.correctOptionIds.includes(o.id) && <span className="mark" aria-label={t("quiz.correct")}>✓</span>}
                    {fb && chosen && !fb.correctOptionIds.includes(o.id) && <span className="mark" aria-label={t("quiz.wrong")}>✕</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {fb && (
          <div className="card stack" role="status">
            <strong>{fb.isCorrect ? "✅ " + t("bot.practiceCorrect").replace("✅ ", "") : "❌ " + t("quiz.wrong")}</strong>
            {!fb.isCorrect && <p className="small">{t("quiz.correct")}: <strong>{fb.correctTexts.join(", ")}</strong></p>}
            {fb.whyWrong.map((w, i) => <p key={i} className="small muted">{t("quiz.whyWrong")}: {w}</p>)}
            {fb.explanation && <p className="small break"><strong>{t("quiz.explanation")}:</strong> {fb.explanation}</p>}
            {fb.source && (
              <div className="evidence">
                <div className="caption">📖 {fb.source.documentTitle} · {fb.source.where}</div>
                <blockquote style={{ margin: "6px 0 0" }} className="break">«{fb.source.quote}»</blockquote>
              </div>
            )}
            {q && <div><ReportButton questionId={q.id} /></div>}
          </div>
        )}
        {err && <Banner kind="danger">{err}</Banner>}
      </div>
      <ActionBar>
        {!fb ? (
          <button className="btn btn-primary btn-block" disabled={!picked.length || busy} onClick={submit}>{t("practice.check")}</button>
        ) : (
          <button className="btn btn-primary btn-block" onClick={next}>{fb.finished ? t("practice.seeResults") : t("common.next")}</button>
        )}
      </ActionBar>
    </Screen>
  );
}
