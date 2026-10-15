import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Badge, Empty, ErrorState, Loading, Screen } from "../components/ui";

type Item = { id: string; title: string; updated_at: string; published_version_id: string | null; draft_version_id: string | null; questions: number; job_status: string | null };

export function QuizList() {
  const t = useT();
  const list = useQuery({ queryKey: ["quizzes"], queryFn: () => api.get<{ items: Item[] }>("/api/quizzes?limit=50") });
  return (
    <Screen title={t("create.myQuizzes")} actions={<Link className="btn btn-primary btn-sm" to="/quiz/new">+ {t("quiz.create")}</Link>}>
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data!.items.length ? (
        <Empty icon="📝" text={t("bot.noQuizzes")} action={<Link className="btn btn-primary" to="/quiz/new">{t("quiz.create")}</Link>} />
      ) : (
        <div className="list">
          {list.data!.items.map((q) => (
            <Link key={q.id} to={`/quiz/${q.id}/edit`} className="list-item">
              <span aria-hidden>📝</span>
              <div className="grow">
                <div className="break" style={{ fontWeight: 600 }}>{q.title}</div>
                <div className="row wrap" style={{ marginTop: 4 }}>
                  {q.published_version_id ? <Badge kind="success">{t("quiz.published")}</Badge> : <Badge kind="neutral">{t("quiz.draft")}</Badge>}
                  {q.draft_version_id && q.published_version_id && <Badge kind="warn">{t("quiz.unpublishedChanges")}</Badge>}
                  <span className="meta">{t("quiz.questionsN", { n: q.questions })}</span>
                </div>
              </div>
              <span className="chev" aria-hidden>›</span>
            </Link>
          ))}
        </div>
      )}
    </Screen>
  );
}
