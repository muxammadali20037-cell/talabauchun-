import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { Badge, Banner, Empty, ErrorState, Field, Loading, Screen, Segmented, Sheet, toast } from "../components/ui";

export type DocSummary = {
  id: string; title: string; author: string | null; sourceKind: string; createdAt: string; jobId: string | null;
  version: null | { id: string; status: string; pageCount: number | null; pagesOk: number; pagesFailed: number; pagesLowConf: number; errorCode: string | null; byteSize: number | null; filename: string | null };
};

export function docStatusBadge(status: string | undefined, t: ReturnType<typeof useT>) {
  switch (status) {
    case "ready":
      return <Badge kind="success">✓ {t("library.statusReady")}</Badge>;
    case "partial":
      return <Badge kind="warn">◐ {t("library.statusPartial")}</Badge>;
    case "failed":
      return <Badge kind="danger">✕ {t("library.statusFailed")}</Badge>;
    case "extracting":
      return <Badge kind="primary">⏳ {t("library.statusExtracting")}</Badge>;
    case "indexing":
      return <Badge kind="primary">⏳ {t("library.statusIndexing")}</Badge>;
    default:
      return <Badge kind="neutral">⏳ {t("library.statusQueued")}</Badge>;
  }
}

const KIND_ICON: Record<string, string> = { pdf: "📕", docx: "📘", pptx: "📙", txt: "📄", text: "📝", image: "🖼", url: "🌐", csv: "📊", xlsx: "📊" };

export function Library({ openUpload = false }: { openUpload?: boolean }) {
  const t = useT();
  const [params] = useSearchParams();
  const [sheet, setSheet] = useState(openUpload);
  const [q, setQ] = useState("");
  const list = useInfiniteQuery({
    queryKey: ["documents"],
    queryFn: ({ pageParam }) => api.get<{ items: DocSummary[]; nextCursor: string | null }>(`/api/documents?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.items.some((d) => d.version && !["ready", "partial", "failed"].includes(d.version.status))) ? 2000 : false),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Screen
      title={t("library.title")}
      back={false}
      actions={
        <button className="btn btn-primary btn-sm" onClick={() => setSheet(true)}>
          + {t("library.upload")}
        </button>
      }
    >
      <div className="stack-l">
        <SearchBox initialOpen={params.get("search") === "1"} q={q} setQ={setQ} />
        {list.isLoading ? (
          <Loading />
        ) : list.isError && !items.length ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !items.length ? (
          <Empty icon="📚" text={t("library.empty")} action={<button className="btn btn-primary" onClick={() => setSheet(true)}>{t("library.upload")}</button>} />
        ) : (
          <div className="list">
            {items.map((d) => (
              <Link key={d.id} to={`/library/${d.id}`} className="list-item">
                <span aria-hidden style={{ fontSize: 24 }}>{KIND_ICON[d.sourceKind] ?? "📄"}</span>
                <div className="grow">
                  <div className="break" style={{ fontWeight: 600 }}>{d.title}</div>
                  <div className="row wrap" style={{ marginTop: 4 }}>
                    {docStatusBadge(d.version?.status, t)}
                    {d.version?.pageCount ? <span className="meta">{d.version.pagesOk + d.version.pagesLowConf}/{d.version.pageCount}</span> : null}
                  </div>
                </div>
                <span className="chev" aria-hidden>›</span>
              </Link>
            ))}
          </div>
        )}
        {list.hasNextPage && (
          <button className="btn btn-secondary" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            {t("library.loadMore")}
          </button>
        )}
      </div>
      <UploadSheet open={sheet} onClose={() => setSheet(false)} />
    </Screen>
  );
}

function SearchBox({ initialOpen, q, setQ }: { initialOpen: boolean; q: string; setQ: (s: string) => void }) {
  const t = useT();
  const [submitted, setSubmitted] = useState("");
  const res = useQuery({
    queryKey: ["search", submitted],
    enabled: submitted.length >= 2,
    queryFn: () => api.get<{ items: { chunkId: string; documentId: string; documentTitle: string; text: string; where: string; pageStart: number; locator: { pageIndex?: number } }[]; notFound: boolean }>(`/api/search?q=${encodeURIComponent(submitted)}`),
  });
  return (
    <section className="stack">
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <input className="input grow" type="search" placeholder={t("library.search")} aria-label={t("library.search")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus={initialOpen} />
        <button className="btn btn-secondary" type="submit">🔎</button>
      </form>
      {res.isFetching && <Loading lines={1} />}
      {res.data?.notFound && <Banner kind="info">{t("library.notFoundInSources")}</Banner>}
      {!!res.data?.items.length && (
        <div className="list">
          {res.data.items.slice(0, 6).map((h) => (
            <Link key={h.chunkId} className="list-item" to={h.locator.pageIndex ? `/library/${h.documentId}/page/${h.locator.pageIndex}` : `/library/${h.documentId}/page/${h.pageStart}`}>
              <div className="grow">
                <div className="caption">{h.documentTitle} · {h.where}</div>
                <div className="small break" style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{h.text}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function UploadSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"file" | "text" | "url">("file");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const done = async (r: { documentId: string }) => {
    await qc.invalidateQueries({ queryKey: ["documents"] });
    toast(t("library.uploaded"));
    onClose();
    navigate(`/library/${r.documentId}`);
  };
  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (mode === "file") {
        const f = fileRef.current?.files?.[0];
        if (!f) throw new ApiError(400, "file_missing");
        const form = new FormData();
        if (title) form.set("title", title);
        form.set("file", f, f.name);
        await done(await api.upload<{ documentId: string }>("/api/documents/upload", form));
      } else if (mode === "text") {
        await done(await api.post<{ documentId: string }>("/api/documents/text", { title: title || text.slice(0, 60), text }));
      } else {
        await done(await api.post<{ documentId: string }>("/api/documents/url", { url }));
      }
    } catch (e) {
      setErr(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={t("library.upload")}>
      <div className="stack">
        <Segmented
          label={t("library.upload")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "file", label: t("library.fileTab") },
            { value: "text", label: t("library.addText") },
            { value: "url", label: t("library.addUrl") },
          ]}
        />
        {mode === "file" && (
          <>
            <Field label={t("library.chooseFile")} hint={t("library.supported")}>
              {(id) => <input id={id} ref={fileRef} type="file" className="input" accept=".pdf,.docx,.pptx,.txt,.md,.jpg,.jpeg,.png,.csv,.xlsx" />}
            </Field>
            <Field label={t("library.textTitle")}>
              {(id) => <input id={id} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
            </Field>
          </>
        )}
        {mode === "text" && (
          <>
            <Field label={t("library.textTitle")}>{(id) => <input id={id} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <Field label={t("library.textBody")}>{(id) => <textarea id={id} className="textarea" value={text} onChange={(e) => setText(e.target.value)} rows={8} />}</Field>
          </>
        )}
        {mode === "url" && (
          <Field label={t("library.addUrl")} hint={t("library.urlHint")}>
            {(id) => <input id={id} className="input" type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
        )}
        {err && <Banner kind="danger">{err}</Banner>}
        <button className="btn btn-primary btn-block" disabled={busy} onClick={submit}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          {t("library.upload")}
        </button>
        <p className="caption">{t("library.privacyNote")}</p>
      </div>
    </Sheet>
  );
}
