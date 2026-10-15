import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, newIdempotencyKey } from "../lib/api";
import { useMe } from "../lib/auth";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { useJob } from "../lib/jobs";
import { Banner, Field, JobProgress, Loading, Screen, Segmented, Toggle } from "../components/ui";
import type { DocSummary } from "./Library";

type Method = "from_source" | "from_qa" | "from_questions" | "from_mistakes";
type Detail = { sections: { id: string; title: string; level: number; start_page: number; end_page: number }[]; pages: { page_index: number; kind: string }[] };

export function QuizNew() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [method, setMethod] = useState<Method>(params.get("method") === "from_mistakes" ? "from_mistakes" : "from_source");
  const [docIds, setDocIds] = useState<string[]>(params.get("doc") ? [params.get("doc")!] : []);
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [count, setCount] = useState(10);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [shuffleQuestions, setShuffleQuestions] = useState(false);
  const [trueFalse, setTrueFalse] = useState(false);
  const [time, setTime] = useState(30);
  const [mix, setMix] = useState<"easy" | "balanced" | "hard">("balanced");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [quizId, setQuizId] = useState<string | null>(null);
  const idem = useMemo(() => newIdempotencyKey("quiz"), []);

  const docs = useQuery({ queryKey: ["documents", "ready"], queryFn: () => api.get<{ items: DocSummary[] }>("/api/documents?limit=50") });
  const ready = (docs.data?.items ?? []).filter((d) => d.version && ["ready", "partial"].includes(d.version.status));
  const firstDoc = docIds[0];
  const detail = useQuery({ queryKey: ["document", firstDoc], enabled: !!firstDoc && method === "from_source", queryFn: () => api.get<Detail>(`/api/documents/${firstDoc}`) });
  const qCount = method === "from_qa" ? text.split(/\n\s*\n/).filter((b) => b.trim()).length : method === "from_questions" ? text.split("\n").filter((l) => l.trim()).length : count;
  const estimate = useQuery({
    queryKey: ["estimate", method, qCount, useAi],
    queryFn: () => api.post<{ credits: number; balance: number; ai: boolean; aiAvailable: boolean; maxQuestions: number }>("/api/quizzes/estimate", { method, useAi, questionsCount: Math.max(1, qCount) }),
  });
  const job = useJob(jobId);
  useEffect(() => {
    if (job.data?.status === "completed" && quizId) navigate(`/quiz/${quizId}/edit`, { replace: true });
  }, [job.data?.status, quizId, navigate]);

  const mixes = { easy: { easy: 0.6, medium: 0.3, hard: 0.1 }, balanced: { easy: 0.3, medium: 0.5, hard: 0.2 }, hard: { easy: 0.1, medium: 0.4, hard: 0.5 } };
  const canSubmit =
    !busy &&
    (method === "from_mistakes" || (method === "from_source" ? docIds.length > 0 : method === "from_questions" ? docIds.length > 0 && text.trim().length > 5 : text.trim().length > 5));

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const settings = { count, shuffleOptions, shuffleQuestions, includeTrueFalse: trueFalse, timePerQuestionSec: time, difficultyMix: mixes[mix], language: me.user.language };
      const body =
        method === "from_source"
          ? { method, documentIds: docIds, sectionIds: sectionIds.length ? sectionIds : undefined, settings, useAi, title: title || undefined, idempotencyKey: idem }
          : method === "from_qa"
            ? { method, documentIds: docIds, qaText: text, settings, useAi, title: title || undefined, idempotencyKey: idem }
            : method === "from_questions"
              ? { method, documentIds: docIds, questionsText: text, settings, useAi, title: title || undefined, idempotencyKey: idem }
              : { method, settings, title: title || undefined, idempotencyKey: idem };
      const r = await api.post<{ quizId: string; jobId: string }>("/api/quizzes", body);
      setQuizId(r.quizId);
      setJobId(r.jobId);
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (jobId)
    return (
      <Screen title={t("quiz.generating")}>
        <div className="stack">
          {job.data ? <JobProgress status={job.data.status} done={job.data.stagesDone} total={job.data.stagesTotal} onCancel={job.data.status === "queued" || job.data.status === "generating" ? () => api.post(`/api/jobs/${jobId}/cancel`) : undefined} /> : <Loading lines={1} />}
          {job.data?.status === "failed" && (
            <Banner kind="danger">
              {job.data.errorCode === "no_source_text" ? t("quiz.noSources") : job.data.errorCode === "nothing_parsed" ? t("quiz.nothingParsed") : t("common.error")} {t("credits.refundedOnFail")}
            </Banner>
          )}
          {job.data?.status === "cancelled" && <Banner kind="info">{t("jobs.cancelled")}</Banner>}
        </div>
      </Screen>
    );

  return (
    <Screen title={t("quiz.create")}>
      <div className="stack-l">
        {!me.features.ai && <Banner kind="info">{t("quiz.aiNotConfigured")}</Banner>}
        <section className="stack">
          <span className="label">{t("quiz.methodLabel")}</span>
          <div className="list" role="radiogroup" aria-label={t("quiz.methodLabel")}>
            {(
              [
                ["from_source", "📚", "quiz.fromBook"],
                ["from_qa", "✍️", "quiz.fromAnswers"],
                ["from_questions", "❓", "quiz.fromQuestions"],
                ["from_mistakes", "🔁", "quiz.fromMistakes"],
              ] as const
            ).map(([m, ico, key]) => (
              <button key={m} role="radio" aria-checked={method === m} className="list-item" onClick={() => setMethod(m)}>
                <span aria-hidden>{ico}</span>
                <span className="grow">{t(key)}</span>
                {method === m && <span aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        </section>

        {method !== "from_mistakes" && (
          <section className="stack">
            <span className="label">{t("quiz.chooseSources")}</span>
            {docs.isLoading ? (
              <Loading lines={2} />
            ) : !ready.length ? (
              <Banner kind="warn">{t("quiz.noSources")}</Banner>
            ) : (
              <div className="list">
                {ready.map((d) => (
                  <label key={d.id} className="list-item">
                    <input type="checkbox" checked={docIds.includes(d.id)} onChange={(e) => setDocIds(e.target.checked ? [...docIds, d.id] : docIds.filter((x) => x !== d.id))} style={{ width: 20, height: 20 }} />
                    <span className="grow break">{d.title}</span>
                  </label>
                ))}
              </div>
            )}
          </section>
        )}

        {method === "from_source" && docIds.length === 1 && !!detail.data?.sections.length && (
          <section className="stack">
            <span className="label">{t("quiz.choosePages")}</span>
            <div className="list">
              {detail.data.sections.filter((s) => s.level === 1).map((s) => (
                <label key={s.id} className="list-item">
                  <input type="checkbox" checked={sectionIds.includes(s.id)} onChange={(e) => setSectionIds(e.target.checked ? [...sectionIds, s.id] : sectionIds.filter((x) => x !== s.id))} style={{ width: 20, height: 20 }} />
                  <span className="grow break">{s.title}</span>
                </label>
              ))}
            </div>
            <p className="caption">{t("quiz.allChaptersHint")}</p>
          </section>
        )}

        {(method === "from_qa" || method === "from_questions") && (
          <Field label={method === "from_qa" ? t("quiz.pasteQa") : t("quiz.pasteQuestions")} hint={method === "from_qa" ? t("quiz.qaFormatHint") : undefined}>
            {(id) => <textarea id={id} className="textarea" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={method === "from_qa" ? "1. …?\nJavob: …\n\n2. …?\nA) …\n*B) …\nC) …\nD) …" : "…?\n…?"} />}
          </Field>
        )}

        {(method === "from_source" || method === "from_mistakes") && (
          <section className="stack">
            <span className="label">{t("quiz.count")}</span>
            <Segmented label={t("quiz.count")} value={String(count)} onChange={(v) => setCount(Number(v))} options={["5", "10", "20", "30"].map((v) => ({ value: v, label: v }))} />
          </section>
        )}

        <details className="more">
          <summary>{t("common.moreSettings")}</summary>
          <div className="stack">
            <Field label={t("quiz.titleLabel")}>{(id) => <input id={id} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <span className="label">{t("quiz.difficulty")}</span>
            <Segmented label={t("quiz.difficulty")} value={mix} onChange={setMix} options={[{ value: "easy", label: t("quiz.easy") }, { value: "balanced", label: t("quiz.medium") }, { value: "hard", label: t("quiz.hard") }]} />
            <Field label={t("quiz.timePerQuestion")}>{(id) => <input id={id} className="input" type="number" min={5} max={600} value={time} onChange={(e) => setTime(Number(e.target.value))} />}</Field>
            <Toggle label={t("quiz.shuffleOptions")} checked={shuffleOptions} onChange={setShuffleOptions} />
            <Toggle label={t("quiz.shuffleQuestions")} checked={shuffleQuestions} onChange={setShuffleQuestions} />
            {method === "from_source" && <Toggle label={t("quiz.includeTrueFalse")} hint={t("quiz.includeTrueFalseHint")} checked={trueFalse} onChange={setTrueFalse} />}
            {me.features.ai && <Toggle label={t("quiz.useAi")} checked={useAi} onChange={setUseAi} hint={t("quiz.useAiHint")} />}
          </div>
        </details>

        {estimate.data && (
          <Banner kind={estimate.data.balance < estimate.data.credits ? "warn" : "info"}>
            {t("quiz.costPreview", { credits: estimate.data.credits, balance: estimate.data.balance })} {t("credits.refundedOnFail")}
          </Banner>
        )}
        {err && <Banner kind="danger">{err}</Banner>}
        <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          {t("quiz.create")}
        </button>
      </div>
    </Screen>
  );
}
