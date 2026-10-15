import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Banner, ErrorState, JobProgress, Loading, Screen, toast } from "../components/ui";
import { docStatusBadge, type DocSummary } from "./Library";
import { useJob } from "../lib/jobs";
import { tg } from "../lib/telegram";

type Detail = DocSummary & {
  pages: { page_index: number; page_label: string | null; kind: string; heading: string | null; method: string; ocr_confidence: number | null; status: string; chars: number }[];
  sections: { id: string; title: string; level: number; start_page: number; end_page: number }[];
  versions: { id: string; version_no: number; status: string; created_at: string }[];
};

export function DocumentDetail() {
  const { id } = useParams();
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const doc = useQuery({
    queryKey: ["document", id],
    queryFn: () => api.get<Detail>(`/api/documents/${id}`),
    refetchInterval: (q) => (q.state.data?.version && !["ready", "partial", "failed"].includes(q.state.data.version.status) ? 2000 : false),
  });
  const job = useJob(doc.data?.version && !["ready", "partial", "failed"].includes(doc.data.version.status) ? doc.data.jobId : null);
  if (doc.isLoading) return <Screen title={t("library.title")}><Loading /></Screen>;
  if (doc.isError || !doc.data) return <Screen title={t("library.title")}><ErrorState error={doc.error} onRetry={() => doc.refetch()} /></Screen>;
  const d = doc.data;
  const v = d.version;
  const paged = d.pages.some((p) => p.kind === "pdf_page" || p.kind === "slide");
  const unit = (p: Detail["pages"][number]) => (p.kind === "pdf_page" ? t("common.page") : p.kind === "slide" ? t("common.slide") : t("library.section"));
  const failed = d.pages.filter((p) => p.status === "failed");
  const low = d.pages.filter((p) => p.status === "low_confidence");
  const del = async () => {
    const ok = await new Promise<boolean>((res) => (tg()?.showConfirm ? tg()!.showConfirm!(t("library.deleteConfirm"), res) : res(window.confirm(t("library.deleteConfirm")))));
    if (!ok) return;
    await api.del(`/api/documents/${id}`);
    await qc.invalidateQueries({ queryKey: ["documents"] });
    toast(t("common.done"));
    navigate("/library", { replace: true });
  };
  return (
    <Screen title={d.title}>
      <div className="stack-l">
        <div className="card stack">
          <div className="row wrap">
            {docStatusBadge(v?.status, t)}
            {d.author && <span className="caption">{d.author}</span>}
          </div>
          {v?.pageCount != null && (
            <div className="row wrap small">
              <span>{t("library.pagesTotal", { n: v.pageCount })}</span>·<span>{t("library.pagesOk", { n: v.pagesOk })}</span>
              {v.pagesLowConf > 0 && <>·<span>{t("library.pagesLowConfidence", { n: v.pagesLowConf })}</span></>}
              {v.pagesFailed > 0 && <>·<span>{t("library.pagesFailed", { n: v.pagesFailed })}</span></>}
            </div>
          )}
          {job.data && !["completed", "failed", "cancelled"].includes(job.data.status) && (
            <JobProgress status={job.data.status} done={job.data.stagesDone} total={job.data.stagesTotal} />
          )}
          {v?.status === "failed" && (
            <Banner kind="danger">
              {v.errorCode === "password_protected" ? t("library.passwordProtected") : v.errorCode === "corrupted" ? t("library.corrupted") : v.errorCode === "too_large" ? t("library.tooLarge", { size: "?", max: 50 }) : t("library.statusFailed")}
            </Banner>
          )}
          {v?.status === "partial" && <Banner kind="warn">{t("library.partialHint")}</Banner>}
          {d.pages.some((p) => p.method === "ocr") && <p className="caption">{t("library.ocrUsed")}</p>}
          {(v?.status === "ready" || v?.status === "partial") && (
            <div className="row wrap">
              <Link className="btn btn-primary" to={`/quiz/new?doc=${d.id}`}>📝 {t("quiz.create")}</Link>
              <Link className="btn btn-secondary" to={`/decks/new?doc=${d.id}`}>📊 {t("deck.create")}</Link>
            </div>
          )}
        </div>

        {d.sections.length > 0 && (
          <section className="stack">
            <h2 className="section-title">{t("library.chapters")}</h2>
            <div className="list">
              {d.sections.map((s) => (
                <Link key={s.id} to={`/library/${d.id}/page/${s.start_page}`} className="list-item" style={{ paddingLeft: 16 + (s.level - 1) * 16 }}>
                  <span className="grow break">{s.title}</span>
                  {paged && <span className="meta">{s.start_page === s.end_page ? s.start_page : `${s.start_page}–${s.end_page}`}</span>}
                </Link>
              ))}
            </div>
          </section>
        )}

        {d.pages.length > 0 && (
          <section className="stack">
            <h2 className="section-title">{paged ? t("library.pagesMap") : t("library.sectionsMap")}</h2>
            <div className="page-grid" role="list">
              {d.pages.map((p) => (
                <Link
                  key={p.page_index}
                  role="listitem"
                  to={`/library/${d.id}/page/${p.page_index}`}
                  className={`page-cell ${p.status}`}
                  aria-label={`${unit(p)} ${p.page_index}${p.page_label ? ` (${p.page_label})` : ""}: ${p.status}`}
                  title={p.page_label ? t("library.pageLabel", { label: p.page_label }) : undefined}
                >
                  {p.page_index}
                  {p.status === "failed" ? " ✕" : p.status === "low_confidence" ? " ?" : ""}
                </Link>
              ))}
            </div>
            <p className="caption">{t("library.legend")}</p>
            {failed.length > 0 && <p className="small">{t("library.pagesFailed", { n: failed.map((p) => p.page_index).join(", ") })}</p>}
            {low.length > 0 && <p className="small">{t("library.pagesLowConfidence", { n: low.map((p) => p.page_index).join(", ") })}</p>}
          </section>
        )}

        <section className="stack">
          <h2 className="section-title">{t("library.versions")}</h2>
          <div className="list">
            {d.versions.map((ver) => (
              <div key={ver.id} className="list-item">
                <span className="grow">v{ver.version_no}</span>
                {docStatusBadge(ver.status, t)}
                <span className="meta">{new Date(ver.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </section>
        <button className="btn btn-danger" onClick={del}>{t("common.delete")}</button>
      </div>
    </Screen>
  );
}

export function PageView() {
  const { id, n } = useParams();
  const t = useT();
  const page = useQuery({ queryKey: ["page", id, n], queryFn: () => api.get<{ text: string; page_label: string | null; kind: string; heading: string | null; status: string; method: string; ocr_confidence: number | null }>(`/api/documents/${id}/pages/${n}`) });
  const num = Number(n);
  const title = page.data?.kind === "pdf_page" ? `${t("library.physicalPage", { n: num })}` : page.data?.kind === "slide" ? `${t("common.slide")} ${num}` : `${t("library.section")} ${num}`;
  return (
    <Screen title={title}>
      {page.isLoading ? (
        <Loading />
      ) : page.isError ? (
        <ErrorState error={page.error} onRetry={() => page.refetch()} />
      ) : (
        <div className="stack">
          <div className="row wrap">
            {page.data!.page_label && <span className="badge badge-neutral">{t("library.pageLabel", { label: page.data!.page_label })}</span>}
            {page.data!.heading && <span className="caption break">{page.data!.heading}</span>}
            {page.data!.method === "ocr" && <span className="badge badge-primary">OCR {page.data!.ocr_confidence != null ? `${Math.round(page.data!.ocr_confidence)}%` : ""}</span>}
          </div>
          {page.data!.status === "low_confidence" && <Banner kind="warn">{t("library.ocrUncertain")}</Banner>}
          {page.data!.status === "failed" && <Banner kind="danger">{t("library.pageUnreadable")}</Banner>}
          {page.data!.status === "empty" ? <p className="muted">{t("library.pageEmpty")}</p> : <div className="page-text break">{page.data!.text}</div>}
          <div className="row between">
            <Link className="btn btn-secondary" to={`/library/${id}/page/${Math.max(1, num - 1)}`} aria-disabled={num <= 1}>← {num - 1 >= 1 ? num - 1 : ""}</Link>
            <Link className="btn btn-secondary" to={`/library/${id}/page/${num + 1}`}>{num + 1} →</Link>
          </div>
        </div>
      )}
    </Screen>
  );
}
