import { useCallback, useEffect, useRef, useState } from "react";
import type { Bullet, MessageKey, SlideContent, SlideLayout } from "@talaba/shared";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { haptic } from "../../lib/telegram";
import { Badge, Banner, Field, SaveState, Segmented, Sheet, toast } from "../../components/ui";
import { deckError, type SlideView } from "./types";

type Props = {
  deckId: string;
  /** null = add a new slide after `afterSlideId` */
  slide: SlideView | null;
  afterSlideId?: string | null;
  onClose: () => void;
  onSaved: () => void;
};

const NEW_LAYOUTS: SlideLayout[] = ["bullets", "two_column", "definition", "section"];

function template(layout: SlideLayout, title: string): SlideContent {
  const base = { title, sources: [], aiWritten: false };
  switch (layout) {
    case "two_column":
      return { ...base, layout, left: { heading: "", bullets: [{ text: "", level: 0 }] }, right: { heading: "", bullets: [{ text: "", level: 0 }] } };
    case "definition":
      return { ...base, layout, term: "", definition: "" };
    case "section":
      return { ...base, layout, subtitle: "" };
    default:
      return { ...base, layout: "bullets", bullets: [{ text: "", level: 0 }] };
  }
}

/** Client-side check mirroring the server schema, so the student sees what is missing before saving. */
function valid(c: SlideContent): boolean {
  if (!c.title.trim() && c.layout !== "title") return false;
  const bulletsOk = (b: Bullet[], min = 1) => b.length >= min && b.every((x) => x.text.trim().length > 0 && x.text.length <= 600);
  switch (c.layout) {
    case "bullets":
      return bulletsOk(c.bullets);
    case "two_column":
      return bulletsOk(c.left.bullets, 0) && bulletsOk(c.right.bullets, 0);
    case "definition":
      return !!c.term.trim() && !!c.definition.trim();
    case "agenda":
    case "references":
      return c.items.length > 0 && c.items.every((i) => i.trim());
    case "table":
      return c.columns.length > 0 && c.columns.every((x) => x.trim()) && c.rows.length > 0;
    case "chart":
      return c.categories.length > 0 && c.series.every((s) => s.values.length === c.categories.length && s.values.every((v) => Number.isFinite(v)));
    default:
      return true;
  }
}

/** Removes empty optional fields the server would reject (e.g. "" subtitles are fine, empty bullets are not). */
function clean(c: SlideContent): SlideContent {
  const trimB = (b: Bullet[]) => b.filter((x) => x.text.trim()).map((x) => ({ ...x, text: x.text.trim() }));
  const k = c.kicker?.trim() ? { kicker: c.kicker.trim() } : { kicker: undefined };
  switch (c.layout) {
    case "bullets":
      return { ...c, ...k, title: c.title.trim(), bullets: trimB(c.bullets) };
    case "two_column":
      return { ...c, ...k, title: c.title.trim(), left: { ...c.left, bullets: trimB(c.left.bullets) }, right: { ...c.right, bullets: trimB(c.right.bullets) } };
    case "agenda":
    case "references":
      return { ...c, ...k, items: c.items.map((i) => i.trim()).filter(Boolean) };
    case "title":
      return { ...c, ...k, meta: c.meta.map((i) => i.trim()).filter(Boolean) };
    default:
      return { ...c, ...k, title: c.title.trim() };
  }
}

export function SlideEditor({ deckId, slide, afterSlideId, onClose, onSaved }: Props) {
  const t = useT();
  const isNew = !slide;
  const draftKey = slide ? `talaba.slide.${slide.id}.${slide.revision}` : null;
  const [content, setContent] = useState<SlideContent>(() => {
    try {
      const saved = draftKey && localStorage.getItem(draftKey);
      if (saved) return (JSON.parse(saved) as { content: SlideContent }).content;
    } catch {
      /* ignore */
    }
    return slide ? slide.content : template("bullets", t("deck.newSlide"));
  });
  const [notes, setNotes] = useState<string>(slide?.notes ?? "");
  const [baseRevision, setBaseRevision] = useState(slide?.revision ?? 1);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentRevision: number; current: { content: SlideContent; notes: string } } | null>(null);
  const [lock, setLock] = useState<"locking" | "ok" | "locked" | "error">(isNew ? "ok" : "locking");
  const conflictRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conflict) conflictRef.current?.scrollIntoView({ block: "center" });
  }, [conflict]);

  // An unsent edit survives a closed app or a dropped connection until the server confirms it.
  useEffect(() => {
    if (!draftKey) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ content, notes }));
    } catch {
      /* ignore */
    }
  }, [content, notes, draftKey]);

  const slideId = slide?.id ?? null;
  const acquire = useCallback(async () => {
    if (!slideId) return;
    try {
      await api.post(`/api/decks/${deckId}/slides/${slideId}/lock`);
      setLock("ok");
    } catch (e) {
      setLock(e instanceof ApiError && e.code === "slide_locked" ? "locked" : "error");
    }
  }, [deckId, slideId]);
  // Hold a short edit lock while the sheet is open (refreshed every minute, released on close).
  useEffect(() => {
    if (!slideId) return;
    void acquire();
    const timer = setInterval(() => void acquire(), 60_000);
    return () => {
      clearInterval(timer);
      void api.del(`/api/decks/${deckId}/slides/${slideId}/lock`).catch(() => {});
    };
  }, [acquire, deckId, slideId]);

  const forget = () => {
    try {
      if (draftKey) localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  };
  const save = async (revision = baseRevision) => {
    setErr(null);
    setState("saving");
    try {
      const body = clean(content);
      if (slide) await api.put(`/api/decks/${deckId}/slides/${slide.id}`, { content: body, notes, revision });
      else await api.post(`/api/decks/${deckId}/slides`, { content: body, notes, ...(afterSlideId !== undefined ? { afterSlideId } : {}) });
      forget();
      setState("saved");
      haptic("success");
      toast(t("common.saved"));
      onSaved();
      onClose();
    } catch (e) {
      setState("error");
      haptic("error");
      if (e instanceof ApiError && e.code === "slide_conflict") {
        const d = e.details as { currentRevision?: number; current?: { content: SlideContent; notes: string } } | undefined;
        if (d?.currentRevision && d.current) setConflict({ currentRevision: d.currentRevision, current: d.current });
        else setErr(deckError(e, t));
      } else if (e instanceof ApiError && e.code === "slide_locked") setLock("locked");
      else setErr(deckError(e, t));
    }
  };
  const loadLatest = () => {
    if (!conflict) return;
    setContent(conflict.current.content);
    setNotes(conflict.current.notes);
    setBaseRevision(conflict.currentRevision);
    setConflict(null);
    setState("idle");
  };

  const ok = valid(content);
  const locked = lock === "locked";
  return (
    <Sheet open onClose={onClose} title={isNew ? t("deck.addSlide") : t("deck.editSlide")}>
      <div className="stack">
        {lock === "locking" && <p className="caption row"><span className="spinner" aria-hidden /> {t("deck.locking")}</p>}
        {locked && (
          <Banner kind="warn">
            <span className="grow">{t("deck.lockedBy", { name: slide?.lock?.lockedByName ?? t("deck.someone") })}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => void acquire()}>{t("common.retry")}</button>
          </Banner>
        )}
        {isNew && (
          <Segmented
            label={t("deck.style")}
            value={content.layout}
            onChange={(v) => setContent(template(v, content.title))}
            options={NEW_LAYOUTS.map((l) => ({ value: l, label: t(`deck.layout.${l}` as MessageKey) }))}
          />
        )}
        <fieldset className="deck-fieldset" disabled={locked}>
          <ContentFields content={content} onChange={setContent} />
          <Field label={t("deck.notes")}>
            {(id) => <textarea id={id} className="textarea" rows={4} maxLength={8000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
        </fieldset>
        {content.sources.length > 0 && (
          <div className="stack deck-sources">
            <span className="label">{t("deck.sources")}</span>
            <ul>
              {content.sources.map((s, i) => (
                <li key={i} className="row wrap">
                  <span className="grow break small">{content.sources.length > 1 ? `[${i + 1}] ` : ""}{s.label}</span>
                  <Badge kind={s.verified ? "success" : "neutral"}>{s.verified ? `✓ ${t("deck.sourceVerified")}` : t("deck.sourceUnverified")}</Badge>
                </li>
              ))}
            </ul>
            <p className="caption">{t("deck.editKeepsSources")}</p>
          </div>
        )}
        {!ok && <p className="error-text">{t("deck.err.validation")}</p>}
        {err && <Banner kind="danger">{err}</Banner>}
        {conflict && (
          <div className="banner banner-warn deck-conflict" role="alert" ref={conflictRef}>
            <div className="stack">
              <strong>{t("deck.conflictTitle")}</strong>
              <span>{t("deck.conflictText")}</span>
              <div className="row wrap">
                <button className="btn btn-secondary btn-sm" onClick={loadLatest}>{t("deck.loadLatest")}</button>
                <button className="btn btn-danger btn-sm" onClick={() => void save(conflict.currentRevision)}>{t("deck.overwrite")}</button>
              </div>
            </div>
          </div>
        )}
        <div className="row">
          <SaveState state={state} />
          <span className="grow" />
          <button className="btn btn-secondary" onClick={() => (forget(), onClose())}>{t("common.cancel")}</button>
          <button className="btn btn-primary" disabled={!ok || locked || lock === "locking" || state === "saving" || !!conflict} onClick={() => void save()}>
            {state === "saving" && <span className="spinner" aria-hidden />}
            {t("common.save")}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** Enough rows to show a bullet without inner scrolling on a phone (≈34 characters per line). */
const rowsFor = (text: string) => Math.min(8, Math.max(2, Math.ceil(text.length / 34)));

function BulletsEditor({ label, bullets, onChange }: { label: string; bullets: Bullet[]; onChange: (b: Bullet[]) => void }) {
  const t = useT();
  const set = (i: number, patch: Partial<Bullet>) => onChange(bullets.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="stack deck-bullets" role="group" aria-label={label}>
      <span className="label">{label}</span>
      {bullets.map((b, i) => (
        <div key={i} className={`deck-bullet-row${b.level ? " is-sub" : ""}`}>
          <textarea className="textarea deck-bullet-input" rows={rowsFor(b.text)} maxLength={600} aria-label={`${label} ${i + 1}`} value={b.text} onChange={(e) => set(i, { text: e.target.value })} />
          <div className="deck-bullet-tools">
            <button type="button" className="icon-btn" aria-pressed={b.level === 1} aria-label={t("deck.subPoint")} title={t("deck.subPoint")} onClick={() => set(i, { level: b.level ? 0 : 1 })}>↳</button>
            <button type="button" className="icon-btn" aria-label={`${t("common.delete")} ${i + 1}`} onClick={() => onChange(bullets.filter((_, j) => j !== i))}>✕</button>
          </div>
        </div>
      ))}
      {bullets.length < 14 && (
        <button type="button" className="btn btn-ghost btn-sm deck-add" onClick={() => onChange([...bullets, { text: "", level: 0 }])}>+ {t("deck.addBullet")}</button>
      )}
    </div>
  );
}

function ListEditor({ label, items, onChange, max = 20, multiline = false }: { label: string; items: string[]; onChange: (v: string[]) => void; max?: number; multiline?: boolean }) {
  const t = useT();
  return (
    <div className="stack" role="group" aria-label={label}>
      <span className="label">{label}</span>
      {items.map((it, i) => (
        <div key={i} className="row">
          {multiline ? (
            <textarea className="textarea grow deck-bullet-input" rows={rowsFor(it)} aria-label={`${label} ${i + 1}`} value={it} maxLength={400} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
          ) : (
            <input className="input grow" aria-label={`${label} ${i + 1}`} value={it} maxLength={200} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
          )}
          <button type="button" className="icon-btn" aria-label={`${t("common.delete")} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {items.length < max && <button type="button" className="btn btn-ghost btn-sm deck-add" onClick={() => onChange([...items, ""])}>+ {t("deck.addItem")}</button>}
    </div>
  );
}

function ContentFields({ content: c, onChange }: { content: SlideContent; onChange: (c: SlideContent) => void }) {
  const t = useT();
  const text = (label: string, value: string, set: (v: string) => void, max = 200) => (
    <Field label={label}>{(id) => <input id={id} className="input" value={value} maxLength={max} onChange={(e) => set(e.target.value)} />}</Field>
  );
  return (
    <div className="stack">
      {text(t("deck.slideTitle"), c.title, (v) => onChange({ ...c, title: v }))}
      {c.layout !== "title" && c.layout !== "questions" && text(t("deck.kicker"), c.kicker ?? "", (v) => onChange({ ...c, kicker: v }), 80)}
      {c.layout === "title" && (
        <>
          {text(t("deck.subtitle"), c.subtitle ?? "", (v) => onChange({ ...c, subtitle: v }), 300)}
          <ListEditor label={t("deck.metaLines")} items={c.meta} max={6} onChange={(meta) => onChange({ ...c, meta })} />
        </>
      )}
      {c.layout === "section" && text(t("deck.subtitle"), c.subtitle ?? "", (v) => onChange({ ...c, subtitle: v }), 300)}
      {c.layout === "questions" && text(t("deck.prompt"), c.prompt ?? "", (v) => onChange({ ...c, prompt: v }), 200)}
      {c.layout === "agenda" && <ListEditor label={t("deck.items")} items={c.items} max={12} onChange={(items) => onChange({ ...c, items })} />}
      {c.layout === "references" && <ListEditor label={t("deck.items")} items={c.items} multiline onChange={(items) => onChange({ ...c, items })} />}
      {c.layout === "bullets" && <BulletsEditor label={t("deck.bullets")} bullets={c.bullets} onChange={(bullets) => onChange({ ...c, bullets })} />}
      {c.layout === "two_column" && (
        <div className="deck-columns">
          {(["left", "right"] as const).map((side) => (
            <div key={side} className="card flat stack">
              <strong className="small">{side === "left" ? t("deck.leftColumn") : t("deck.rightColumn")}</strong>
              {text(t("deck.columnHeading"), c[side].heading, (v) => onChange({ ...c, [side]: { ...c[side], heading: v } }), 120)}
              <BulletsEditor label={t("deck.bullets")} bullets={c[side].bullets} onChange={(bullets) => onChange({ ...c, [side]: { ...c[side], bullets: bullets.slice(0, 8) } })} />
            </div>
          ))}
        </div>
      )}
      {c.layout === "definition" && (
        <>
          {text(t("deck.term"), c.term, (v) => onChange({ ...c, term: v }), 160)}
          <Field label={t("deck.definition")}>{(id) => <textarea id={id} className="textarea" rows={4} maxLength={800} value={c.definition} onChange={(e) => onChange({ ...c, definition: e.target.value })} />}</Field>
        </>
      )}
      {c.layout === "table" && <TableFields c={c} onChange={onChange} />}
      {c.layout === "chart" && <ChartFields c={c} onChange={onChange} />}
    </div>
  );
}

function TableFields({ c, onChange }: { c: Extract<SlideContent, { layout: "table" }>; onChange: (c: SlideContent) => void }) {
  const t = useT();
  return (
    <div className="stack">
      {c.isExample && <Badge kind="warn">{t("deck.exampleData")}</Badge>}
      <span className="label">{t("deck.tableColumns")}</span>
      <div className="deck-table-edit" style={{ gridTemplateColumns: `repeat(${c.columns.length}, minmax(96px, 1fr)) auto` }}>
        {c.columns.map((col, i) => (
          <input key={`h${i}`} className="input deck-cell head" aria-label={`${t("deck.tableColumns")} ${i + 1}`} value={col} maxLength={80} onChange={(e) => onChange({ ...c, columns: c.columns.map((x, j) => (j === i ? e.target.value : x)) })} />
        ))}
        <span />
        {c.rows.map((r, ri) => (
          <div key={ri} className="deck-table-row" style={{ display: "contents" }}>
            {c.columns.map((_, ci) => (
              <input key={ci} className="input deck-cell" aria-label={`${t("deck.tableRows")} ${ri + 1}, ${c.columns[ci]}`} value={r[ci] ?? ""} maxLength={120} onChange={(e) => onChange({ ...c, rows: c.rows.map((row, j) => (j === ri ? c.columns.map((__, k) => (k === ci ? e.target.value : row[k] ?? "")) : row)) })} />
            ))}
            <button type="button" className="icon-btn" aria-label={`${t("common.delete")} ${ri + 1}`} disabled={c.rows.length <= 1} onClick={() => onChange({ ...c, rows: c.rows.filter((_, j) => j !== ri) })}>✕</button>
          </div>
        ))}
      </div>
      {c.rows.length < 14 && <button type="button" className="btn btn-ghost btn-sm deck-add" onClick={() => onChange({ ...c, rows: [...c.rows, c.columns.map(() => "")] })}>+ {t("deck.addRow")}</button>}
      <Field label={t("deck.caption")}>{(id) => <input id={id} className="input" value={c.caption ?? ""} maxLength={300} onChange={(e) => onChange({ ...c, caption: e.target.value })} />}</Field>
    </div>
  );
}

function ChartFields({ c, onChange }: { c: Extract<SlideContent, { layout: "chart" }>; onChange: (c: SlideContent) => void }) {
  const t = useT();
  return (
    <div className="stack">
      {c.isExample && <Badge kind="warn">{t("deck.exampleData")}</Badge>}
      {c.dataOrigin === "source_table" && <Banner kind="info">{t("deck.chartDataWarning")}</Banner>}
      <div className="scroll-x">
        <table className="data-table deck-chart-edit">
          <thead>
            <tr>
              <th scope="col">{t("deck.categories")}</th>
              {c.series.map((s, si) => (
                <th key={si} scope="col" className="break">{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.categories.map((cat, i) => (
              <tr key={i}>
                <td>
                  <input className="input deck-cell" aria-label={`${t("deck.categories")} ${i + 1}`} value={cat} maxLength={60} onChange={(e) => onChange({ ...c, categories: c.categories.map((x, j) => (j === i ? e.target.value : x)) })} />
                </td>
                {c.series.map((s, si) => (
                  <td key={si}>
                    <input
                      className="input deck-cell"
                      type="number"
                      step="any"
                      aria-label={`${s.name}, ${cat}`}
                      value={Number.isFinite(s.values[i]) ? String(s.values[i]) : ""}
                      onChange={(e) => onChange({ ...c, series: c.series.map((x, k) => (k === si ? { ...x, values: x.values.map((v, j) => (j === i ? (e.target.value === "" ? NaN : Number(e.target.value)) : v)) } : x)) })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid-2">
        <Field label={t("deck.unit")}>{(id) => <input id={id} className="input" value={c.unit ?? ""} maxLength={40} onChange={(e) => onChange({ ...c, unit: e.target.value || undefined })} />}</Field>
        <Field label={t("deck.caption")}>{(id) => <input id={id} className="input" value={c.caption ?? ""} maxLength={300} onChange={(e) => onChange({ ...c, caption: e.target.value || undefined })} />}</Field>
      </div>
    </div>
  );
}
