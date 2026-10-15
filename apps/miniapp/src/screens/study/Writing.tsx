import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useMe } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { Badge, Banner, Field, Screen, Segmented, toast } from "../../components/ui";
import type { DocSummary } from "../Library";

type Mode = "outline" | "annotation" | "bibliography" | "polish" | "rubric";
type Result =
  | { mode: "outline"; generated: "ai" | "from_sources"; outline: { title: string; points: string[] }[]; notes?: string | null }
  | { mode: "annotation"; generated: "ai" | "extractive"; annotation: string; keywords?: string[] }
  | { mode: "bibliography"; style: string; entries: { n: number; text: string; missing: string[]; documentId: string }[] }
  | { mode: "polish"; text: string; changes: { before: string; after: string; why: string }[]; quotesKept: number; quotesChanged: string[] }
  | { mode: "rubric"; criteria: { criterion: string; status: "met" | "partly" | "not_met"; excerpt: string | null; suggestion: string }[]; overall: string };

/** Help with reports and course papers: plan, annotation, references, wording, checking against criteria. Never writes the paper for the student. */
export function Writing() {
  const t = useT();
  const me = useMe();
  const [mode, setMode] = useState<Mode>("outline");
  const docs = useQuery({ queryKey: ["documents", "ready"], queryFn: () => api.get<{ items: DocSummary[] }>("/api/documents?limit=50") });
  const ready = (docs.data?.items ?? []).filter((d) => d.version && ["ready", "partial"].includes(d.version.status));
  const [docIds, setDocIds] = useState<string[]>([]);
  const [topic, setTopic] = useState("");
  const [workType, setWorkType] = useState<"referat" | "kurs_ishi" | "maqola" | "esse">("referat");
  const [style, setStyle] = useState<"gost" | "apa">("gost");
  const [text, setText] = useState("");
  const [rubric, setRubric] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const needsAi = mode === "polish" || mode === "rubric";
  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const body =
        mode === "outline" ? { mode, topic, workType, documentIds: docIds }
          : mode === "annotation" ? { mode, documentId: docIds[0] }
            : mode === "bibliography" ? { mode, documentIds: docIds, style }
              : mode === "polish" ? { mode, text }
                : { mode, text, rubric };
      setRes(await api.post<Result>("/api/writing", body));
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const canRun =
    mode === "outline" ? topic.trim().length >= 3
      : mode === "annotation" ? docIds.length === 1
        : mode === "bibliography" ? docIds.length > 0
          : mode === "polish" ? text.trim().length >= 20
            : text.trim().length >= 20 && rubric.trim().length >= 10;
  const toggleDoc = (id: string) => setDocIds(mode === "annotation" ? [id] : docIds.includes(id) ? docIds.filter((x) => x !== id) : [...docIds, id]);
  return (
    <Screen title={t("writing.title")}>
      <div className="stack-l">
        <Banner kind="info">{t("writing.honesty")}</Banner>
        <div className="chips" role="radiogroup" aria-label={t("writing.mode")}>
          {(["outline", "annotation", "bibliography", "polish", "rubric"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={`chip${mode === m ? " chip-on" : ""}`} onClick={() => { setMode(m); setRes(null); if (m === "annotation") setDocIds(docIds.slice(0, 1)); }}>{t(`writing.mode_${m}`)}</button>
          ))}
        </div>
        {needsAi && !me.features.ai && <Banner kind="warn">{t("writing.needsAi")}</Banner>}

        {mode === "outline" && (
          <>
            <Field label={t("writing.topic")}>{(id) => <input id={id} className="input" value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} />}</Field>
            <Segmented label={t("writing.workType")} value={workType} onChange={setWorkType} options={[{ value: "referat", label: t("writing.referat") }, { value: "kurs_ishi", label: t("writing.courseWork") }, { value: "maqola", label: t("writing.article") }, { value: "esse", label: t("writing.essay") }]} />
          </>
        )}
        {(mode === "outline" || mode === "annotation" || mode === "bibliography") && (
          <section className="stack">
            <span className="label">{mode === "annotation" ? t("writing.pickOne") : t("writing.pickSources")}</span>
            {!ready.length ? <p className="caption">{t("deck.noMaterials")}</p> : (
              <div className="list">
                {ready.map((d) => (
                  <label key={d.id} className="list-item">
                    <input type={mode === "annotation" ? "radio" : "checkbox"} name="docs" style={{ width: 22, height: 22 }} checked={docIds.includes(d.id)} onChange={() => toggleDoc(d.id)} />
                    <span className="grow break">{d.title}</span>
                  </label>
                ))}
              </div>
            )}
            {mode === "bibliography" && <Segmented label={t("writing.style")} value={style} onChange={setStyle} options={[{ value: "gost", label: "GOST / O‘zDSt" }, { value: "apa", label: "APA 7" }]} />}
          </section>
        )}
        {(mode === "polish" || mode === "rubric") && (
          <Field label={t("writing.yourText")} hint={mode === "polish" ? t("writing.quotesHint") : undefined}>{(id) => <textarea id={id} className="textarea" rows={8} value={text} maxLength={12000} onChange={(e) => setText(e.target.value)} />}</Field>
        )}
        {mode === "rubric" && <Field label={t("writing.rubric")} hint={t("writing.rubricHint")}>{(id) => <textarea id={id} className="textarea" rows={5} value={rubric} maxLength={4000} onChange={(e) => setRubric(e.target.value)} />}</Field>}

        <button className="btn btn-primary btn-block" disabled={busy || !canRun || (needsAi && !me.features.ai)} onClick={run}>{busy ? t("common.loading") : t("writing.run")}</button>
        {err && <Banner kind="danger">{err}</Banner>}
        {res && <WritingResult res={res} />}
      </div>
    </Screen>
  );
}

function WritingResult({ res }: { res: Result }) {
  const t = useT();
  const copy = async (s: string) => {
    await navigator.clipboard?.writeText(s).catch(() => {});
    toast(t("common.copied"));
  };
  if (res.mode === "outline")
    return (
      <section className="card stack">
        <Badge kind="neutral">{res.generated === "ai" ? t("writing.byAi") : t("writing.fromSources")}</Badge>
        <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          {res.outline.map((s, i) => (
            <li key={i}><strong className="break">{s.title}</strong>{s.points.length > 0 && <ul className="small">{s.points.map((p, j) => <li key={j} className="break">{p}</li>)}</ul>}</li>
          ))}
        </ol>
        {res.notes && <p className="caption break">{res.notes}</p>}
      </section>
    );
  if (res.mode === "annotation")
    return (
      <section className="card stack">
        <Badge kind="neutral">{res.generated === "ai" ? t("writing.byAi") : t("tutor.extractive")}</Badge>
        <p className="break">{res.annotation}</p>
        {res.keywords && <p className="caption">{t("writing.keywords")}: {res.keywords.join(", ")}</p>}
        <button className="btn btn-secondary btn-sm" onClick={() => copy(res.annotation)}>{t("common.copy")}</button>
      </section>
    );
  if (res.mode === "bibliography")
    return (
      <section className="card stack">
        <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          {res.entries.map((e) => (
            <li key={e.documentId} className="break">
              {e.text}
              {e.missing.length > 0 && <div className="caption">⚠ {t("writing.missing")}: {e.missing.map((m) => t(`writing.missing_${m}` as never)).join(", ")} — {t("writing.fillInSource")}</div>}
            </li>
          ))}
        </ol>
        <button className="btn btn-secondary btn-sm" onClick={() => copy(res.entries.map((e) => `${e.n}. ${e.text}`).join("\n"))}>{t("common.copy")}</button>
      </section>
    );
  if (res.mode === "polish")
    return (
      <section className="card stack">
        {res.quotesChanged.length > 0 && <Banner kind="warn">{t("writing.quotesChanged", { n: res.quotesChanged.length })}</Banner>}
        <p className="break" style={{ whiteSpace: "pre-wrap" }}>{res.text}</p>
        <button className="btn btn-secondary btn-sm" onClick={() => copy(res.text)}>{t("common.copy")}</button>
        {res.changes.length > 0 && (
          <details>
            <summary className="small">{t("writing.changes", { n: res.changes.length })}</summary>
            <ul className="small stack" style={{ paddingLeft: 18 }}>{res.changes.map((c, i) => <li key={i} className="break"><s>{c.before}</s> → {c.after} <span className="caption">({c.why})</span></li>)}</ul>
          </details>
        )}
      </section>
    );
  return (
    <section className="card stack">
      {res.criteria.map((c, i) => (
        <div key={i} className="stack" style={{ gap: 4 }}>
          <div className="row between wrap"><strong className="break">{c.criterion}</strong><Badge kind={c.status === "met" ? "success" : c.status === "partly" ? "warn" : "danger"}>{t(`writing.status_${c.status}`)}</Badge></div>
          {c.excerpt && <blockquote className="small break" style={{ margin: 0 }}>«{c.excerpt}»</blockquote>}
          <p className="small break">💡 {c.suggestion}</p>
        </div>
      ))}
      <p className="break">{res.overall}</p>
      <p className="caption">{t("writing.noGrade")}</p>
    </section>
  );
}
