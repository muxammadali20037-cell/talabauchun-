import { useState } from "react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Banner, Field, Sheet } from "./ui";

const REASONS = ["wrong_key", "ambiguous", "bad_source", "typo", "other"] as const;

/** “Xato haqida bildirish” — sends a report tied to the exact question version. */
export function ReportButton({ questionId }: { questionId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("wrong_key");
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>⚑ {t("quiz.reportError")}</button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t("quiz.reportError")}>
        {sent ? (
          <Banner kind="success">{t("quiz.reportThanks")}</Banner>
        ) : (
          <div className="stack">
            <div className="list" role="radiogroup">
              {REASONS.map((r) => (
                <button key={r} role="radio" aria-checked={reason === r} className="list-item" onClick={() => setReason(r)}>
                  <span className="grow">{t(`report.${r}`)}</span>
                  {reason === r && <span aria-hidden>✓</span>}
                </button>
              ))}
            </div>
            <Field label={t("report.comment")}>{(id) => <textarea id={id} className="textarea" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
            <button className="btn btn-primary" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                await api.post(`/api/questions/${questionId}/report`, { reason, comment: comment || undefined });
                setSent(true);
              } finally {
                setBusy(false);
              }
            }}>{t("report.send")}</button>
          </div>
        )}
      </Sheet>
    </>
  );
}
