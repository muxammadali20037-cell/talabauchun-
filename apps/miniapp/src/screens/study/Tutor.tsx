import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { Badge, Banner, Field, Screen, Segmented } from "../../components/ui";

type Claim = { text: string; documentTitle: string | null; where: string | null; quote?: string | null; verified: boolean };
type Passage = { documentTitle: string; where: string; quote: string };
type Reply =
  | { status: "not_found"; passages: Passage[] }
  | { status: "extractive"; claims: Claim[]; passages: Passage[] }
  | { status: "answered"; answer: string; claims: Claim[]; generalNote: string | null; needsClarification: string | null; passages: Passage[] };
type Turn = { q: string; r: Reply | null; err?: string };

type Mode = "sources_only" | "general";
type Style = "normal" | "simpler" | "example" | "hint" | "check_me";

/** Study helper: answers only from the user's sources by default, each claim with its verbatim quote and location. */
export function Tutor() {
  const t = useT();
  const [params] = useSearchParams();
  const doc = params.get("doc");
  const [mode, setMode] = useState<Mode>("sources_only");
  const [style, setStyle] = useState<Style>("normal");
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    const question = q.trim();
    if (question.length < 2) return;
    setBusy(true);
    setTurns((x) => [...x, { q: question, r: null }]);
    setQ("");
    try {
      const r = await api.post<Reply>("/api/tutor/ask", { question, mode, style, documentIds: doc ? [doc] : undefined, studentAnswer: style === "check_me" && answer ? answer : undefined });
      setTurns((x) => x.map((tt, i) => (i === x.length - 1 ? { ...tt, r } : tt)));
    } catch (e) {
      setTurns((x) => x.map((tt, i) => (i === x.length - 1 ? { ...tt, err: errorMessage(e, t) } : tt)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t("tutor.title")}>
      <div className="stack-l">
        <Segmented<Mode> label={t("tutor.mode")} value={mode} onChange={setMode} options={[{ value: "sources_only", label: t("tutor.sourcesOnly") }, { value: "general", label: t("tutor.general") }]} />
        <p className="caption">{mode === "sources_only" ? t("tutor.sourcesOnlyHint") : t("tutor.generalHint")} {t("tutor.webOff")}</p>
        <div className="chips" role="radiogroup" aria-label={t("tutor.style")}>
          {(["normal", "simpler", "example", "hint", "check_me"] as const).map((s) => (
            <button key={s} role="radio" aria-checked={style === s} className={`chip${style === s ? " chip-on" : ""}`} onClick={() => setStyle(s)}>{t(`tutor.style_${s}`)}</button>
          ))}
        </div>
        <div className="stack" aria-live="polite">
          {turns.map((tt, i) => (
            <div key={i} className="stack">
              <div className="bubble bubble-me break">{tt.q}</div>
              {tt.err ? <Banner kind="danger">{tt.err}</Banner> : !tt.r ? <div className="bubble"><span className="skeleton" style={{ display: "block", height: 14, width: 160 }} /></div> : <TutorReply r={tt.r} />}
            </div>
          ))}
        </div>
        <div className="stack">
          <Field label={t("tutor.question")}>{(id) => <textarea id={id} className="textarea" rows={3} value={q} maxLength={4000} onChange={(e) => setQ(e.target.value)} placeholder={t("tutor.placeholder")} />}</Field>
          {style === "check_me" && <Field label={t("tutor.yourAnswer")}>{(id) => <textarea id={id} className="textarea" rows={3} value={answer} maxLength={4000} onChange={(e) => setAnswer(e.target.value)} />}</Field>}
          <button className="btn btn-primary btn-block" disabled={busy || q.trim().length < 2} onClick={ask}>{t("tutor.ask")}</button>
        </div>
      </div>
    </Screen>
  );
}

function TutorReply({ r }: { r: Reply }) {
  const t = useT();
  if (r.status === "not_found") return <div className="bubble"><p>{t("tutor.notFound")}</p></div>;
  return (
    <div className="bubble stack">
      {r.status === "extractive" && <Badge kind="neutral">{t("tutor.extractive")}</Badge>}
      {r.status === "answered" && r.needsClarification && <Banner kind="info">{r.needsClarification}</Banner>}
      {r.status === "answered" && <p className="break">{r.answer}</p>}
      {r.claims.length > 0 && (
        <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
          {r.claims.map((c, i) => (
            <li key={i} className="small break">
              {c.text}
              {c.where && <span className="caption"> — 📖 {c.documentTitle}, {c.where}</span>}
              {!c.verified && <> <Badge kind="warn">{t("tutor.unverified")}</Badge></>}
            </li>
          ))}
        </ul>
      )}
      {r.status === "answered" && r.generalNote && (
        <div className="evidence"><div className="caption">{t("tutor.generalNote")}</div><p className="small break">{r.generalNote}</p></div>
      )}
    </div>
  );
}
