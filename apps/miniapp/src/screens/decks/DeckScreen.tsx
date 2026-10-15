import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeckOutlineItem, MessageKey, ThemeId } from "@talaba/shared";
import { api, newIdempotencyKey } from "../../lib/api";
import { useMe } from "../../lib/auth";
import { useI18n } from "../../lib/i18n";
import { useJob } from "../../lib/jobs";
import { haptic, tg } from "../../lib/telegram";
import { Badge, Banner, ErrorState, Field, JobProgress, Loading, Screen, Sheet, toast } from "../../components/ui";
import { CostBanner, ThemePicker } from "./DeckParts";
import { ExportPanel } from "./ExportPanel";
import { SlideEditor } from "./SlideEditor";
import { SlidePreview } from "./SlidePreview";
import { SlideViewer } from "./SlideViewer";
import { codeMessage, deckError, formatDate, STATUS_KIND, warningText, type DeckDetail, type Estimate, type SlideView } from "./types";

const RUNNING = new Set(["queued", "extracting", "indexing", "generating", "validating", "rendering"]);

function confirmAsk(message: string): Promise<boolean> {
  const w = tg();
  if (w?.showConfirm && w.isVersionAtLeast("6.2")) return new Promise((r) => w.showConfirm!(message, r));
  return Promise.resolve(window.confirm(message));
}

export function DeckScreen() {
  const { id } = useParams();
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ["deck", id],
    queryFn: () => api.get<DeckDetail>(`/api/decks/${id}`),
    // poll only while the server is working on this deck
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      const busy = d.deck.status === "planning" || d.deck.status === "generating" || (d.job && RUNNING.has(d.job.status)) || d.regenerations.some((r) => RUNNING.has(r.status));
      return busy ? 2000 : false;
    },
  });
  if (q.isLoading) return <Screen title={t("deck.title")}><Loading lines={4} /></Screen>;
  if (q.isError || !q.data) return <Screen title={t("deck.title")}><ErrorState error={q.error} onRetry={() => q.refetch()} /></Screen>;
  const d = q.data;
  const status = d.deck.status;
  return (
    <Screen title={d.deck.title}>
      {status === "planning" || status === "generating" ? (
        <Working data={d} />
      ) : status === "failed" ? (
        <Failed data={d} />
      ) : status === "plan_ready" ? (
        <OutlineEditor data={d} />
      ) : (
        <Ready data={d} />
      )}
    </Screen>
  );
}

function Working({ data }: { data: DeckDetail }) {
  const { t } = useI18n();
  const job = data.job;
  const cancel = async () => {
    if (!job) return;
    try {
      await api.post(`/api/jobs/${job.id}/cancel`);
    } catch (e) {
      toast(deckError(e, t));
    }
  };
  return (
    <div className="stack-l">
      <div className="card stack">
        <div className="row wrap">
          <Badge kind="primary">{t(data.deck.status === "planning" ? "deck.planning" : "deck.generating")}</Badge>
          <Badge kind="neutral">{t("deck.slidesN", { n: data.deck.settings.slideCount })}</Badge>
        </div>
        <p className="small muted break">{data.deck.settings.topic}</p>
      </div>
      {job ? <JobProgress status={job.status} done={job.stagesDone} total={job.stagesTotal} onCancel={data.deck.role !== "viewer" && (job.status === "queued" || job.status === "generating") ? cancel : undefined} /> : <Loading lines={1} />}
      <div className="deck-skeleton-grid" aria-hidden>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton deck-skeleton-slide" />
        ))}
      </div>
    </div>
  );
}

function Failed({ data }: { data: DeckDetail }) {
  const { t } = useI18n();
  const code = data.deck.generation.errorCode ?? data.job?.errorCode ?? null;
  const doc = data.deck.sourceDocumentIds[0];
  return (
    <div className="stack-l">
      <Banner kind="danger">
        <span>
          <strong>{t("deck.failed")}</strong> {code === "cancelled" ? t("jobs.cancelled") : codeMessage(code, t)} {t("credits.refundedOnFail")}
        </span>
      </Banner>
      {data.deck.role !== "viewer" && (
        <Link className="btn btn-primary btn-block" to={doc ? `/decks/new?doc=${doc}` : "/decks/new"}>
          {t("deck.createAgain")}
        </Link>
      )}
    </div>
  );
}

/** The outline shown before generation: edit titles/ideas, reorder, remove or add slides, then build. */
function OutlineEditor({ data }: { data: DeckDetail }) {
  const { t } = useI18n();
  const me = useMe();
  const qc = useQueryClient();
  const [items, setItems] = useState<DeckOutlineItem[]>(() => data.deck.outline ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const idem = useMemo(() => newIdempotencyKey("deckgen"), []);
  const viewer = data.deck.role === "viewer";
  const estimate = useQuery({
    queryKey: ["deck-estimate", items.length, data.deck.generation.mode === "ai"],
    queryFn: () => api.post<Estimate>("/api/decks/estimate", { slideCount: Math.max(4, Math.min(40, items.length)), useAi: data.deck.generation.mode === "ai" }),
    enabled: !viewer,
  });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setItems(next);
  };
  const build = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api.post(`/api/decks/${data.deck.id}/generate`, { outline: items.map((it) => ({ ...it, title: it.title.trim() || t("deck.newSlide") })), idempotencyKey: idem });
      haptic("success");
      await qc.invalidateQueries({ queryKey: ["deck", data.deck.id] });
    } catch (e) {
      setErr(deckError(e, t));
      setBusy(false);
    }
  };
  return (
    <div className="stack-l">
      <Banner kind="info">{t("deck.planReadyHint")}</Banner>
      <ol className="deck-outline">
        {items.map((it, i) => (
          <li key={`${it.key ?? "new"}-${i}`} className="card stack">
            <div className="row">
              <span className="q-num" aria-hidden>{i + 1}</span>
              <Badge kind="neutral">{t(`deck.layout.${it.layout}` as MessageKey)}</Badge>
              <span className="grow" />
              {!viewer && (
                <>
                  <button className="icon-btn" aria-label={`${t("deck.moveUp")} ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="icon-btn" aria-label={`${t("deck.moveDown")} ${i + 1}`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="icon-btn" aria-label={`${t("deck.removeItem")} ${i + 1}`} disabled={items.length <= 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
                </>
              )}
            </div>
            <input className="input" aria-label={`${t("deck.slideTitle")} ${i + 1}`} value={it.title} maxLength={200} readOnly={viewer} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
            {(it.idea || !it.key) && (
              <textarea className="textarea deck-idea" rows={2} aria-label={`${t("deck.idea")} ${i + 1}`} placeholder={t("deck.idea")} value={it.idea} maxLength={400} readOnly={viewer} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, idea: e.target.value } : x)))} />
            )}
          </li>
        ))}
      </ol>
      {!viewer && (
        <>
          <button className="btn btn-ghost" disabled={items.length >= 40} onClick={() => setItems([...items, { layout: "bullets", title: "", idea: "" }])}>+ {t("deck.addPlanItem")}</button>
          {estimate.data && <CostBanner estimate={estimate.data} />}
          {!me.features.ai && <p className="caption">{t("deck.aiOff")}</p>}
          {err && <Banner kind="danger">{err}</Banner>}
          <button className="btn btn-primary btn-block" disabled={busy || !items.length} onClick={build}>
            {busy && <span className="spinner" aria-hidden />}
            {t("deck.buildDeck")}
          </button>
        </>
      )}
    </div>
  );
}

type SheetState = { kind: "edit"; slide: SlideView } | { kind: "add"; after: string | null } | { kind: "regen"; slide: SlideView } | { kind: "history"; slide: SlideView } | { kind: "rename" } | null;

function Ready({ data }: { data: DeckDetail }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const deck = data.deck;
  const editor = deck.role !== "viewer";
  const [sheet, setSheet] = useState<SheetState>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [quizBusy, setQuizBusy] = useState(false);
  const reload = () => qc.invalidateQueries({ queryKey: ["deck", deck.id] });
  const regenerating = new Map(data.regenerations.filter((r) => RUNNING.has(r.status) && r.slideId).map((r) => [r.slideId!, r]));
  const warnings = data.warnings.map((w) => warningText(w, t)).filter((x): x is string => !!x);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      haptic("success");
    } catch (e) {
      haptic("error");
      toast(deckError(e, t));
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const move = (i: number, dir: -1 | 1) => {
    const ids = data.slides.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    return act(() => api.post(`/api/decks/${deck.id}/reorder`, { slideIds: ids, revision: deck.revision }));
  };
  const setTheme = (theme: ThemeId) => act(() => api.patch(`/api/decks/${deck.id}`, { theme }), t("deck.themeChanged"));
  const remove = async (s: SlideView, n: number) => {
    if (!(await confirmAsk(`${t("deck.slideN", { n })}: ${t("deck.deleteConfirm")}`))) return;
    await act(() => api.del(`/api/decks/${deck.id}/slides/${s.id}`), t("deck.slideDeleted"));
  };
  const quiz = async () => {
    setQuizBusy(true);
    try {
      const r = await api.post<{ quizId: string }>(`/api/decks/${deck.id}/quiz`, { idempotencyKey: newIdempotencyKey("deckquiz") });
      navigate(`/quiz/${r.quizId}/edit`);
    } catch (e) {
      toast(deckError(e, t));
      setQuizBusy(false);
    }
  };

  return (
    <div className="stack-l">
      <div className="card stack">
        <div className="row wrap">
          <Badge kind={STATUS_KIND[deck.status]}>{t(`deck.status.${deck.status}` as MessageKey)}</Badge>
          <Badge kind="neutral">{t("deck.slidesN", { n: data.slides.length })}</Badge>
          {deck.generation.mode && <Badge kind="primary">{deck.generation.mode === "ai" ? t("deck.modeAi") : t("deck.modeExtractive")}</Badge>}
          <span className="grow" />
          {editor && <button className="btn btn-ghost btn-sm" onClick={() => setSheet({ kind: "rename" })}>✎ {t("deck.rename")}</button>}
        </div>
        {!editor && <Banner kind="info">{t("deck.viewerOnly")}</Banner>}
        {warnings.length > 0 && (
          <Banner kind="warn">
            <ul className="deck-warnings">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        )}
        {editor && (
          <div className="stack">
            <span className="label">{t("deck.style")}</span>
            <ThemePicker value={deck.theme} onChange={(v) => v !== deck.theme && void setTheme(v)} disabled={busy} />
          </div>
        )}
      </div>

      <ExportPanel deckId={deck.id} deckRevision={deck.revision} />

      {deck.sourceDocumentIds.length > 0 && (
        <button className="btn btn-secondary btn-block" disabled={quizBusy} onClick={quiz}>
          {quizBusy && <span className="spinner" aria-hidden />}📝 {t("deck.quizFromDeck")}
        </button>
      )}

      <section className="deck-slides" aria-label={t("deck.preview")}>
        {data.slides.map((s, i) => (
          <SlideCard
            key={s.id}
            data={data}
            slide={s}
            n={i + 1}
            editor={editor}
            busy={busy}
            regenerating={regenerating.has(s.id)}
            onView={setViewer}
            onEdit={() => setSheet({ kind: "edit", slide: s })}
            onRegen={() => setSheet({ kind: "regen", slide: s })}
            onHistory={() => setSheet({ kind: "history", slide: s })}
            onUndo={() => act(() => api.post(`/api/decks/${deck.id}/slides/${s.id}/undo`), t("deck.undone"))}
            onUp={i > 0 ? () => move(i, -1) : undefined}
            onDown={i < data.slides.length - 1 ? () => move(i, 1) : undefined}
            onDelete={() => remove(s, i + 1)}
            onAddAfter={() => setSheet({ kind: "add", after: s.id })}
          />
        ))}
      </section>
      {editor && (
        <button className="btn btn-secondary btn-block" onClick={() => setSheet({ kind: "add", after: data.slides[data.slides.length - 1]?.id ?? null })}>
          + {t("deck.addSlide")}
        </button>
      )}

      {sheet?.kind === "edit" && <SlideEditor deckId={deck.id} slide={sheet.slide} onClose={() => setSheet(null)} onSaved={reload} />}
      {sheet?.kind === "add" && <SlideEditor deckId={deck.id} slide={null} afterSlideId={sheet.after} onClose={() => setSheet(null)} onSaved={reload} />}
      {sheet?.kind === "regen" && <RegenerateSheet deckId={deck.id} slide={sheet.slide} aiMode={deck.generation.mode === "ai"} onClose={() => setSheet(null)} onDone={reload} />}
      {sheet?.kind === "history" && <HistorySheet deckId={deck.id} slide={sheet.slide} onClose={() => setSheet(null)} />}
      {sheet?.kind === "rename" && <RenameSheet deckId={deck.id} title={deck.title} onClose={() => setSheet(null)} onDone={reload} />}
      {viewer !== null && <SlideViewer slides={data.preview.slides} start={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

const EVIDENCE_KIND = { verified: "success", partial: "warn", unverified: "neutral" } as const;

function SlideCard(p: {
  data: DeckDetail; slide: SlideView; n: number; editor: boolean; busy: boolean; regenerating: boolean;
  onView: (renderIndex: number) => void; onEdit: () => void; onRegen: () => void; onHistory: () => void; onUndo: () => void; onUp?: () => void; onDown?: () => void; onDelete: () => void; onAddAfter: () => void;
}) {
  const { t } = useI18n();
  const s = p.slide;
  const pages = s.renderIndexes.map((ri) => p.data.preview.slides[ri]).filter((x) => !!x);
  const lockedByOther = s.lock && !s.lock.byMe;
  const disabled = p.busy || p.regenerating;
  return (
    <article className="card deck-card" aria-labelledby={`slide-${s.id}`}>
      <div className="row wrap deck-card-head">
        <span className="q-num" aria-hidden>{p.n}</span>
        <h3 id={`slide-${s.id}`} className="grow break deck-card-title">
          <span className="sr-only">{t("deck.slideN", { n: p.n })}: </span>
          {s.content.title || t(`deck.layout.${s.content.layout}` as MessageKey)}
        </h3>
        {s.evidence !== "not_applicable" && <Badge kind={EVIDENCE_KIND[s.evidence]}>{s.evidence === "verified" ? "✓ " : ""}{t(`deck.evidence.${s.evidence}` as MessageKey)}</Badge>}
        {s.aiWritten && <Badge kind="primary">{t("deck.modeAi")}</Badge>}
        {lockedByOther && <Badge kind="warn">🔒 {s.lock!.lockedByName ?? t("deck.someone")}</Badge>}
      </div>
      <div className="deck-pages">
        {pages.map((pg, i) => (
          <div key={pg.renderIndex} className={i ? "deck-cont" : undefined}>
            {i > 0 && <span className="caption">↳ {t("deck.continued")}</span>}
            <button type="button" className="deck-preview-btn" onClick={() => p.onView(pg.renderIndex)} aria-label={`${t("deck.view")}: ${t("deck.slideN", { n: p.n })}${i ? ` (${t("deck.continued")})` : ""}`}>
              <SlidePreview slide={pg} />
            </button>
          </div>
        ))}
      </div>
      {p.regenerating && (
        <p className="row caption" role="status">
          <span className="spinner" aria-hidden /> {t("deck.regenerating")}
        </p>
      )}
      <details className="deck-notes">
        <summary>{t("deck.notes")}</summary>
        <p className="small break deck-notes-text">{s.notes.trim() || t("deck.notesEmpty")}</p>
      </details>
      {p.editor && (
        <div className="deck-actions" role="group" aria-label={t("deck.slideN", { n: p.n })}>
          <div className="deck-actions-main">
            <button className="btn btn-secondary btn-sm" disabled={disabled || !!lockedByOther} onClick={p.onEdit}>✎ {t("common.edit")}</button>
            <button className="btn btn-secondary btn-sm" disabled={disabled || !!lockedByOther} onClick={p.onRegen} aria-label={t("deck.regenerateSlide")}>↻ {t("deck.regenShort")}</button>
          </div>
          <div className="deck-actions-icons">
            <button className="icon-btn" disabled={disabled} onClick={p.onUndo} aria-label={`${t("deck.undo")} (${p.n})`} title={t("deck.undo")}>↶</button>
            <button className="icon-btn" onClick={p.onHistory} aria-label={`${t("deck.history")} (${p.n})`} title={t("deck.history")}>🕘</button>
            <button className="icon-btn" disabled={disabled || !p.onUp} onClick={p.onUp} aria-label={`${t("deck.moveUp")} (${p.n})`} title={t("deck.moveUp")}>↑</button>
            <button className="icon-btn" disabled={disabled || !p.onDown} onClick={p.onDown} aria-label={`${t("deck.moveDown")} (${p.n})`} title={t("deck.moveDown")}>↓</button>
            <button className="icon-btn" disabled={disabled} onClick={p.onAddAfter} aria-label={`${t("deck.addSlide")} (${p.n + 1})`} title={t("deck.addSlide")}>＋</button>
            <button className="icon-btn" disabled={disabled || !!lockedByOther} onClick={p.onDelete} aria-label={`${t("deck.deleteSlide")} (${p.n})`} title={t("deck.deleteSlide")}>🗑</button>
          </div>
        </div>
      )}
    </article>
  );
}

/** Regenerates exactly one slide; the price is the single-slide price, never the deck price. */
function RegenerateSheet({ deckId, slide, aiMode, onClose, onDone }: { deckId: string; slide: SlideView; aiMode: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const ai = me.features.ai && aiMode;
  const aiCapable = ai && ["bullets", "two_column", "definition"].includes(slide.content.layout);
  const [instruction, setInstruction] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useMemo(() => newIdempotencyKey("regen"), []);
  const estimate = useQuery({ queryKey: ["deck-estimate", "regen", aiCapable], queryFn: () => api.post<Estimate>("/api/decks/estimate", { slideCount: 12, useAi: aiCapable }) });
  const job = useJob(jobId);
  useEffect(() => {
    if (job.data?.status === "completed") {
      toast(t("deck.regenerated"));
      haptic("success");
      onDone();
      onClose();
    }
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.post<{ jobId: string }>(`/api/decks/${deckId}/slides/${slide.id}/regenerate`, { revision: slide.revision, idempotencyKey: idem, useAi: aiCapable, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) });
      setJobId(r.jobId);
    } catch (e) {
      setErr(deckError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const price = estimate.data ? (estimate.data.regenerateCredits > 0 ? t("deck.priceN", { credits: estimate.data.regenerateCredits }) : t("deck.priceFree")) : null;
  return (
    <Sheet open onClose={onClose} title={t("deck.regenerateSlide")}>
      <div className="stack">
        <p className="small">{t("deck.regenerateHint")}</p>
        {!aiCapable && <Banner kind="info">{t("deck.regenNoAi")}</Banner>}
        {aiCapable && (
          <Field label={t("deck.instruction")} hint={t("deck.instructionHint")}>
            {(id) => <textarea id={id} className="textarea" rows={3} maxLength={500} value={instruction} disabled={!!jobId} onChange={(e) => setInstruction(e.target.value)} />}
          </Field>
        )}
        {price && (
          <p className="row">
            <Badge kind="neutral">{price}</Badge>
          </p>
        )}
        {jobId && job.data && <JobProgress status={job.data.status} done={job.data.stagesDone} total={job.data.stagesTotal} />}
        {job.data?.status === "failed" && <Banner kind="danger">{codeMessage(job.data.errorCode, t)} {t("credits.refundedOnFail")}</Banner>}
        {err && <Banner kind="danger">{err}</Banner>}
        <div className="row">
          <span className="grow" />
          <button className="btn btn-secondary" onClick={onClose}>{t("common.close")}</button>
          {(!jobId || job.data?.status === "failed") && (
            <button className="btn btn-primary" disabled={busy} onClick={() => (setJobId(null), void start())}>
              {busy && <span className="spinner" aria-hidden />}↻ {t("deck.regenerateSlide")}
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

type HistoryItem = { revision: number; changeKind: string; restoredFrom: number | null; createdAt: string; author: string | null; content: { title: string } };

function HistorySheet({ deckId, slide, onClose }: { deckId: string; slide: SlideView; onClose: () => void }) {
  const { t, lang } = useI18n();
  const q = useInfiniteQuery({
    queryKey: ["slide-history", slide.id, slide.revision],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<{ items: HistoryItem[]; nextCursor: string | null }>(`/api/decks/${deckId}/slides/${slide.id}/history?limit=20${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (p) => p.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Sheet open onClose={onClose} title={t("deck.history")}>
      {q.isLoading ? (
        <Loading lines={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="stack">
          <ol className="list deck-history">
            {items.map((h) => (
              <li key={h.revision} className="list-item">
                <Badge kind={h.changeKind === "regenerate" ? "primary" : h.changeKind === "delete" ? "danger" : "neutral"}>{t(`deck.change.${h.changeKind}` as MessageKey)}</Badge>
                <span className="grow">
                  <span className="break small">{h.content.title}</span>
                  <span className="meta">
                    {formatDate(h.createdAt, lang)}
                    {h.author ? ` · ${h.author}` : ""} · r{h.revision}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {q.hasNextPage && <button className="btn btn-secondary btn-sm" onClick={() => q.fetchNextPage()}>{t("deck.loadMore")}</button>}
        </div>
      )}
    </Sheet>
  );
}

function RenameSheet({ deckId, title, onClose, onDone }: { deckId: string; title: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(title);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/decks/${deckId}`, { title: value.trim() });
      onDone();
      onClose();
    } catch (e) {
      setErr(deckError(e, t));
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={t("deck.rename")}>
      <div className="stack">
        <Field label={t("deck.titleLabel")}>{(id) => <input id={id} className="input" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} />}</Field>
        {err && <Banner kind="danger">{err}</Banner>}
        <div className="row">
          <span className="grow" />
          <button className="btn btn-secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" disabled={busy || !value.trim()} onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    </Sheet>
  );
}
