import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMe } from "../lib/auth";
import { useT } from "../lib/i18n";
import { Badge, Banner, Loading } from "../components/ui";

type Recent = { kind: "quiz" | "document" | "deck"; id: string; title: string; updatedAt: string; status: string | null };

export function Home() {
  const me = useMe();
  const t = useT();
  const recent = useQuery({ queryKey: ["home"], queryFn: () => api.get<{ recent: Recent[]; deadlines: { id: string; title: string; dueAt: string }[]; dueCards: number }>("/api/home") });
  const last = recent.data?.recent[0];
  const linkFor = (r: Recent) => (r.kind === "quiz" ? `/quiz/${r.id}/edit` : r.kind === "deck" ? `/decks/${r.id}` : `/library/${r.id}`);
  return (
    <div className="stack-l">
      <header className="stack" style={{ gap: 4 }}>
        <h1>{t("home.greeting", { name: me.user.firstName || "" })}</h1>
        <p className="muted">{t("app.slogan")}</p>
      </header>
      {!me.features.ai && <Banner kind="info">{t("quiz.aiNotConfigured")}</Banner>}

      {recent.isLoading ? (
        <Loading lines={1} />
      ) : last ? (
        <section className="stack">
          <h2 className="section-title">{t("home.continueLast")}</h2>
          <Link to={linkFor(last)} className="card card-link accent row">
            <span aria-hidden style={{ fontSize: 24 }}>
              {last.kind === "quiz" ? "📝" : last.kind === "deck" ? "📊" : "📚"}
            </span>
            <div className="grow">
              <strong className="break">{last.title}</strong>
              <div className="caption">{new Date(last.updatedAt).toLocaleString()}</div>
            </div>
            <span className="chev" aria-hidden>
              ›
            </span>
          </Link>
        </section>
      ) : null}

      <section className="stack">
        <h2 className="section-title">{t("home.quickActions")}</h2>
        <div className="grid-2 wide-4">
          <Link className="tile" to="/library/upload">
            <span className="tile-icon" aria-hidden>📥</span>
            <strong>{t("home.actionUpload")}</strong>
          </Link>
          <Link className="tile" to="/quiz/new">
            <span className="tile-icon" aria-hidden>📝</span>
            <strong>{t("home.actionQuiz")}</strong>
          </Link>
          <Link className="tile" to="/decks/new">
            <span className="tile-icon" aria-hidden>📊</span>
            <strong>{t("home.actionSlides")}</strong>
          </Link>
          <Link className="tile" to="/library?search=1">
            <span className="tile-icon" aria-hidden>🔎</span>
            <strong>{t("library.search")}</strong>
          </Link>
        </div>
      </section>

      <section className="stack">
        <h2 className="section-title">{t("home.study")}</h2>
        <div className="grid-2 wide-4">
          <Link className="tile" to="/cards">
            <span className="tile-icon" aria-hidden>🃏</span>
            <strong>{t("cards.title")}</strong>
            <span className="caption">{recent.data?.dueCards ? t("home.dueCards", { n: recent.data.dueCards }) : t("home.nothingToReview")}</span>
          </Link>
          <Link className="tile" to="/mistakes">
            <span className="tile-icon" aria-hidden>🔁</span>
            <strong>{t("mistakes.title")}</strong>
          </Link>
          <Link className="tile" to="/plans">
            <span className="tile-icon" aria-hidden>🗓</span>
            <strong>{t("plans.title")}</strong>
          </Link>
          <Link className="tile" to="/tutor">
            <span className="tile-icon" aria-hidden>💡</span>
            <strong>{t("tutor.title")}</strong>
          </Link>
        </div>
      </section>

      <section className="stack">
        <h2 className="section-title">{t("home.upcoming")}</h2>
        {recent.data?.deadlines.length ? (
          <div className="list">
            {recent.data.deadlines.map((d) => (
              <div key={d.id} className="list-item">
                <span className="grow break">{d.title}</span>
                <Badge kind="warn">{new Date(d.dueAt).toLocaleDateString()}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <p className="caption">{t("home.noDeadlines")}</p>
        )}
      </section>

      {recent.data && recent.data.recent.length > 1 && (
        <section className="stack">
          <h2 className="section-title">{t("bot.menuMyWork").replace(/^\S+\s/, "")}</h2>
          <div className="list">
            {recent.data.recent.slice(1, 6).map((r) => (
              <Link key={`${r.kind}${r.id}`} to={linkFor(r)} className="list-item">
                <span aria-hidden>{r.kind === "quiz" ? "📝" : r.kind === "deck" ? "📊" : "📚"}</span>
                <span className="grow break">{r.title}</span>
                <span className="chev" aria-hidden>›</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
