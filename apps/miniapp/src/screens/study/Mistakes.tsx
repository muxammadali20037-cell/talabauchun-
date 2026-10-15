import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { Empty, ErrorState, Loading, Screen } from "../../components/ui";

type Item = { questionId: string; text: string; yourAnswer: string[]; correct: string[]; times: number; quizTitle: string; source: { quote: string; documentTitle: string | null; where: string } | null };

export function Mistakes() {
  const t = useT();
  const list = useQuery({ queryKey: ["mistakes"], queryFn: () => api.get<{ items: Item[] }>("/api/mistakes") });
  return (
    <Screen title={t("mistakes.title")}>
      {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data!.items.length ? (
        <Empty icon="✨" text={t("mistakes.empty")} />
      ) : (
        <div className="stack-l">
          <p className="caption">{t("mistakes.hint")}</p>
          <Link className="btn btn-primary" to="/quiz/new?method=from_mistakes">🔁 {t("quiz.fromMistakes")}</Link>
          {list.data!.items.map((m) => (
            <article key={m.questionId} className="card stack">
              <div className="row between"><span className="caption">{m.quizTitle}</span>{m.times > 1 && <span className="badge badge-warn">×{m.times}</span>}</div>
              <h3 className="break" style={{ fontWeight: 600 }}>{m.text}</h3>
              <p className="small">❌ {t("practice.yourAnswer")}: {m.yourAnswer.join(", ")}</p>
              <p className="small">✅ {t("quiz.correct")}: <strong>{m.correct.join(", ")}</strong></p>
              {m.source && (
                <div className="evidence">
                  <div className="caption">📖 {m.source.documentTitle} · {m.source.where}</div>
                  <blockquote style={{ margin: "6px 0 0" }} className="break small">«{m.source.quote}»</blockquote>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </Screen>
  );
}
