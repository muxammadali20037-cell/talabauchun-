import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { downloadFile, haptic } from "../../lib/telegram";
import { Badge, Banner, Field, Loading, Screen, Sheet } from "../../components/ui";

type Req = { id: string; kind: "export" | "delete"; status: string; createdAt: string; finishedAt: string | null; bytes: number | null; error: string | null; download: { url: string; filename: string } | null };

/** Export everything, or delete the account (typed confirmation; what is kept is stated up front). */
export function MyData() {
  const t = useT();
  const list = useQuery({
    queryKey: ["data-requests"],
    queryFn: () => api.get<{ items: Req[] }>("/api/me/data"),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "pending" || r.status === "processing") ? 2000 : false),
  });
  const [err, setErr] = useState<string | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [deleted, setDeleted] = useState(false);
  const requestExport = async () => {
    setErr(null);
    try {
      await api.post("/api/me/export");
      await list.refetch();
    } catch (e) {
      setErr(errorMessage(e, t));
    }
  };
  const requestDelete = async () => {
    setErr(null);
    try {
      await api.post("/api/me/delete", { confirm });
      haptic("warning");
      setDeleted(true);
      setDelOpen(false);
    } catch (e) {
      setErr(errorMessage(e, t));
    }
  };
  if (deleted) return <Screen title={t("data.title")}><Banner kind="info">{t("data.deleteQueued")}</Banner></Screen>;
  const exports = (list.data?.items ?? []).filter((r) => r.kind === "export");
  return (
    <Screen title={t("data.title")}>
      <div className="stack-l">
        <section className="card stack">
          <h3>📦 {t("data.exportTitle")}</h3>
          <p className="small">{t("data.exportHint")}</p>
          <button className="btn btn-secondary" disabled={exports.some((r) => r.status === "pending" || r.status === "processing")} onClick={requestExport}>{t("data.exportButton")}</button>
          {list.isLoading ? <Loading lines={1} /> : exports.map((r) => (
            <div key={r.id} className="list-item">
              <div className="grow">
                <div className="small">{new Date(r.createdAt).toLocaleString()}</div>
                {r.bytes != null && <div className="meta">{(r.bytes / 1024 / 1024).toFixed(1)} MB</div>}
              </div>
              {r.download ? <button className="btn btn-primary btn-sm" onClick={() => downloadFile(r.download!.url, r.download!.filename)}>{t("data.download")}</button> : <Badge kind={r.status === "failed" ? "danger" : "neutral"}>{t(`data.status_${r.status}` as never)}</Badge>}
            </div>
          ))}
        </section>
        <section className="card stack">
          <h3>🗑 {t("data.deleteTitle")}</h3>
          <p className="small">{t("data.deleteRemoves")}</p>
          <p className="small">{t("data.deleteKeeps")}</p>
          <p className="caption">{t("data.backupNote")}</p>
          <button className="btn btn-danger" onClick={() => setDelOpen(true)}>{t("data.deleteButton")}</button>
        </section>
        {err && <Banner kind="danger">{err}</Banner>}
      </div>
      <Sheet open={delOpen} onClose={() => setDelOpen(false)} title={t("data.deleteTitle")}>
        <div className="stack">
          <Banner kind="warn">{t("data.deleteWarning")}</Banner>
          <Field label={t("data.typeDelete")}>{(id) => <input id={id} className="input" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />}</Field>
          <button className="btn btn-danger btn-block" disabled={confirm !== "DELETE"} onClick={requestDelete}>{t("data.deleteFinal")}</button>
        </div>
      </Sheet>
    </Screen>
  );
}
