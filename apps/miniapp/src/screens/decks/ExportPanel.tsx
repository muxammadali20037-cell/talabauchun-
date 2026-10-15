import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageKey } from "@talaba/shared";
import { api, getToken } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { downloadFile, haptic } from "../../lib/telegram";
import { Badge, Banner } from "../../components/ui";
import { codeMessage, deckError, type ExportItem } from "./types";

const ACTIVE = new Set(["queued", "rendering"]);

/**
 * PPTX/PDF files of a deck. Each file is rendered from the same laid-out model
 * as the preview and verified on the server; only files that passed every
 * check get a (short-lived, signed) download link.
 */
export function ExportPanel({ deckId, deckRevision }: { deckId: string; deckRevision: number }) {
  const t = useT();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState<"pptx" | "pdf" | null>(null);
  const q = useQuery({
    queryKey: ["deck-exports", deckId],
    queryFn: () => api.get<{ items: ExportItem[] }>(`/api/decks/${deckId}/exports?limit=20`),
    refetchInterval: (query) => (query.state.data?.items.some((i) => ACTIVE.has(i.status)) ? 2000 : false),
  });
  // a new deck revision makes earlier files "old": refresh the list
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["deck-exports", deckId] });
  }, [deckRevision, deckId, qc]);

  const start = async (format: "pptx" | "pdf") => {
    setErr(null);
    setStarting(format);
    try {
      await api.post(`/api/decks/${deckId}/exports`, { format });
      await q.refetch();
    } catch (e) {
      setErr(deckError(e, t));
    } finally {
      setStarting(null);
    }
  };
  const download = async (item: ExportItem) => {
    setErr(null);
    try {
      // links are signed for a few minutes: always fetch a fresh one right before downloading
      const fresh = await api.get<{ items: ExportItem[] }>(`/api/decks/${deckId}/exports?limit=20`);
      const it = fresh.items.find((x) => x.id === item.id);
      if (!it?.download) throw new Error("no_link");
      downloadFile(it.download.url, it.download.filename);
      haptic("success");
    } catch (e) {
      setErr(deckError(e, t));
    }
  };

  return (
    <section className="card stack" aria-labelledby="deck-files">
      <h2 id="deck-files" className="deck-h2">⬇ {t("deck.files")}</h2>
      <p className="caption">{t("deck.filesHint")}</p>
      {q.isError && <Banner kind="danger">{deckError(q.error, t)}</Banner>}
      {(["pptx", "pdf"] as const).map((format) => (
        <ExportRow key={format} format={format} item={q.data?.items.find((i) => i.format === format) ?? null} loading={q.isLoading} starting={starting === format} onStart={() => start(format)} onDownload={download} deckId={deckId} />
      ))}
      {err && <Banner kind="danger">{err}</Banner>}
    </section>
  );
}

function ExportRow({ format, item, loading, starting, onStart, onDownload, deckId }: { format: "pptx" | "pdf"; item: ExportItem | null; loading: boolean; starting: boolean; onStart: () => void; onDownload: (i: ExportItem) => void; deckId: string }) {
  const t = useT();
  const label = format === "pptx" ? t("deck.exportPptx") : t("deck.exportPdf");
  const busy = starting || (!!item && ACTIVE.has(item.status));
  const okChecks = item?.checks.items.filter((c) => c.ok).length ?? 0;
  const totalChecks = item?.checks.items.length ?? 0;
  return (
    <div className="deck-export" data-format={format}>
      <div className="row wrap">
        <strong className="deck-format">{format.toUpperCase()}</strong>
        {item?.status === "ready" && (item.current ? <Badge kind="success">✓ {t("deck.exportReady")}</Badge> : <Badge kind="warn">{t("deck.exportOutdated")}</Badge>)}
        {item?.status === "failed" && <Badge kind="danger">{t("jobs.failed")}</Badge>}
        <span className="grow" />
        {busy ? (
          <span className="row caption" role="status">
            <span className="spinner" aria-hidden /> {t("deck.exporting")}
          </span>
        ) : item?.status === "ready" && item.current ? (
          <button className="btn btn-primary btn-sm" onClick={() => onDownload(item)} aria-label={`${t("deck.download")} ${format.toUpperCase()}`}>
            ⬇ {t("deck.download")}
          </button>
        ) : (
          <button className="btn btn-secondary btn-sm" disabled={loading} onClick={onStart}>
            {label}
          </button>
        )}
      </div>
      {item?.status === "ready" && !item.current && (
        <div className="row wrap">
          <button className="btn btn-ghost btn-sm" onClick={() => onDownload(item)}>⬇ {t("deck.download")}</button>
        </div>
      )}
      {item?.status === "failed" && (
        <Banner kind="danger">
          {t("deck.exportFailed")} {codeMessage(item.error, t)}
        </Banner>
      )}
      {item?.status === "ready" && totalChecks > 0 && (
        <details className="deck-checks">
          <summary>
            {item.checks.ok ? "✓" : "!"} {t("deck.checksOk", { ok: okChecks, total: totalChecks })}
            {item.checks.slideCount ? ` · ${t("deck.slidesN", { n: item.checks.slideCount })}` : ""}
          </summary>
          <ul className="deck-check-list">
            {item.checks.items.map((c) => (
              <li key={c.name}>
                <span aria-hidden>{c.ok ? "✓" : "✕"}</span> {t(`deck.check.${c.name}` as MessageKey)}
              </li>
            ))}
          </ul>
          {item.checks.thumbnails > 0 && <Thumbs deckId={deckId} exportId={item.id} count={item.checks.thumbnails} />}
        </details>
      )}
    </div>
  );
}

/** Page renders of the checked file; fetched with the session token (they are private) and shown via object URLs. */
function Thumbs({ deckId, exportId, count }: { deckId: string; exportId: string; count: number }) {
  const t = useT();
  const [urls, setUrls] = useState<(string | null)[]>([]);
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      for (let n = 1; n <= Math.min(count, 40); n++) {
        try {
          const res = await fetch(`/api/decks/${deckId}/exports/${exportId}/thumbnails/${n}`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
          if (!res.ok) throw new Error(String(res.status));
          const url = URL.createObjectURL(await res.blob());
          made.push(url);
          if (!alive) return;
          setUrls((u) => [...u, url]);
        } catch {
          if (alive) setUrls((u) => [...u, null]);
        }
      }
    })();
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [deckId, exportId, count]);
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <span className="label">{t("deck.pagesPreview")}</span>
      <div className="deck-thumbs">
        {urls.map((u, i) => (u ? <img key={i} src={u} alt={t("deck.slideN", { n: i + 1 })} loading="lazy" /> : <div key={i} className="deck-thumb-missing" aria-hidden />))}
      </div>
    </div>
  );
}
