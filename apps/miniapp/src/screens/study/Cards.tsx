import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { haptic } from "../../lib/telegram";
import { Empty, ErrorState, Loading, Screen } from "../../components/ui";

type Card = { id: string; front: string; back: string; collection: string; dueAt: string; reps: number; source: { quote: string; documentTitle: string | null; where: string } | null };

/** Spaced-repetition review: show front → reveal back with its source → grade (Again / Hard / Good / Easy). */
export function Cards() {
  const t = useT();
  const qc = useQueryClient();
  const due = useQuery({ queryKey: ["cards", "due"], queryFn: () => api.get<{ items: Card[]; total: number; due: number }>("/api/flashcards?due=1&limit=50") });
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  if (due.isLoading) return <Screen title={t("cards.title")}><Loading /></Screen>;
  if (due.isError) return <Screen title={t("cards.title")}><ErrorState error={due.error} onRetry={() => due.refetch()} /></Screen>;
  const card = due.data!.items[0];
  const grade = async (g: number) => {
    if (!card) return;
    setBusy(true);
    try {
      await api.post(`/api/flashcards/${card.id}/review`, { grade: g });
      haptic(g >= 3 ? "success" : "warning");
      setFlipped(false);
      setDoneCount((n) => n + 1);
      await qc.invalidateQueries({ queryKey: ["cards"] });
      await qc.invalidateQueries({ queryKey: ["home"] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={t("cards.title")}>
      <div className="stack-l">
        <p className="caption">{t("cards.stats", { due: due.data!.due, total: due.data!.total, done: doneCount })}</p>
        {!card ? (
          <Empty icon="🎉" text={due.data!.total ? t("home.nothingToReview") : t("cards.empty")} action={<Link className="btn btn-secondary" to="/library">{t("cards.fromLibrary")}</Link>} />
        ) : (
          <>
            <button className="card" style={{ minHeight: 220, textAlign: "center", display: "grid", placeItems: "center", cursor: "pointer", width: "100%" }} onClick={() => setFlipped(!flipped)} aria-pressed={flipped}>
              <div className="stack" style={{ alignItems: "center" }}>
                <span className="caption">{card.collection}</span>
                <h2 className="break" style={{ fontSize: 22 }}>{flipped ? card.back : card.front}</h2>
                {!flipped && <span className="caption">{t("cards.tapToFlip")}</span>}
              </div>
            </button>
            {flipped && card.source && (
              <div className="evidence">
                <div className="caption">📖 {card.source.documentTitle} · {card.source.where}</div>
                <blockquote style={{ margin: "6px 0 0" }} className="break small">«{card.source.quote}»</blockquote>
              </div>
            )}
            {flipped ? (
              <div className="grid-2 wide-4">
                {([[0, "cards.again", "btn-danger"], [3, "cards.hard", "btn-secondary"], [4, "cards.good", "btn-secondary"], [5, "cards.easy", "btn-primary"]] as const).map(([g, key, cls]) => (
                  <button key={g} className={`btn ${cls}`} disabled={busy} onClick={() => grade(g)}>{t(key)}</button>
                ))}
              </div>
            ) : (
              <button className="btn btn-primary btn-block" onClick={() => setFlipped(true)}>{t("cards.showBack")}</button>
            )}
          </>
        )}
      </div>
    </Screen>
  );
}
