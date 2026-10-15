import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { errorMessage } from "../../lib/errors";
import { haptic } from "../../lib/telegram";
import { Banner, Screen } from "../../components/ui";

type Game = { sessionId: string; terms: { id: string; text: string }[]; definitions: { id: string; text: string }[] };
type Result = { score: number; max: number; results: { termId: string; definitionId: string; correct: boolean }[]; answer: Record<string, string> };

/** Term ↔ definition matching. Pairs come from the user's own source; the server holds the key and scores once. */
export function Matching() {
  const t = useT();
  const [params] = useSearchParams();
  const doc = params.get("doc");
  const [game, setGame] = useState<Game | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<Game>("/api/games/matching", { documentId: doc ?? undefined, size: 6 }),
    onSuccess: (g) => { setGame(g); setPairs({}); setPicked(null); setResult(null); },
  });
  const submit = useMutation({
    mutationFn: () => api.post<Result>(`/api/games/matching/${game!.sessionId}/submit`, { pairs: Object.entries(pairs).map(([termId, definitionId]) => ({ termId, definitionId })) }),
    onSuccess: (r) => { setResult(r); haptic(r.score === r.max ? "success" : "warning"); },
  });
  const defUsed = new Set(Object.values(pairs));
  const termOf = (defId: string) => Object.entries(pairs).find(([, d]) => d === defId)?.[0];
  const label = (termId: string) => String.fromCharCode(65 + game!.terms.findIndex((x) => x.id === termId));
  const status = (termId: string) => result?.results.find((r) => r.termId === termId)?.correct;
  return (
    <Screen title={t("games.matching")}>
      <div className="stack-l">
        <p className="caption">{t("games.matchingHint")}</p>
        {!game && <button className="btn btn-primary btn-block" disabled={start.isPending} onClick={() => start.mutate()}>{t("games.start")}</button>}
        {start.isError && <Banner kind="danger">{(start.error as { code?: string }).code === "not_enough_pairs" ? t("games.notEnough") : errorMessage(start.error, t)}</Banner>}
        {game && (
          <>
            <section className="stack">
              <h2 className="section-title">{t("games.terms")}</h2>
              <div className="list">
                {game.terms.map((x, i) => (
                  <button key={x.id} className="list-item" aria-pressed={picked === x.id} disabled={!!result} onClick={() => setPicked(picked === x.id ? null : x.id)} style={picked === x.id ? { outline: "2px solid var(--c-primary)" } : undefined}>
                    <strong aria-hidden>{String.fromCharCode(65 + i)}</strong>
                    <span className="grow break">{x.text}</span>
                    {result ? <span aria-label={status(x.id) ? t("quiz.correct") : t("practice.wrong")}>{status(x.id) ? "✅" : "❌"}</span> : pairs[x.id] ? <span aria-hidden>🔗</span> : null}
                  </button>
                ))}
              </div>
            </section>
            <section className="stack">
              <h2 className="section-title">{t("games.definitions")}</h2>
              <div className="list">
                {game.definitions.map((d) => {
                  const owner = termOf(d.id);
                  const correctTerm = result ? Object.entries(result.answer).find(([, v]) => v === d.id)?.[0] : undefined;
                  return (
                    <button key={d.id} className="list-item" disabled={!!result || (!picked && !owner)} onClick={() => {
                      if (owner && !picked) { const next = { ...pairs }; delete next[owner]; setPairs(next); return; }
                      if (!picked) return;
                      const next = { ...pairs };
                      if (owner) delete next[owner];
                      next[picked] = d.id;
                      setPairs(next);
                      setPicked(null);
                      haptic("light");
                    }}>
                      <span className="badge" style={{ minWidth: 28, justifyContent: "center" }}>{owner ? label(owner) : "·"}</span>
                      <span className="grow break small">{d.text}</span>
                      {result && correctTerm && correctTerm !== owner && <span className="caption">→ {label(correctTerm)}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
            {result ? (
              <div className="card stack" style={{ textAlign: "center" }}>
                <h2>{t("games.score", { score: result.score, max: result.max })}</h2>
                <button className="btn btn-primary" onClick={() => start.mutate()}>{t("games.again")}</button>
              </div>
            ) : (
              <button className="btn btn-primary btn-block" disabled={submit.isPending || defUsed.size < game.terms.length} onClick={() => submit.mutate()}>{t("games.check")}</button>
            )}
          </>
        )}
      </div>
    </Screen>
  );
}
