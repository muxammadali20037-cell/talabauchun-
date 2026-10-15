import { Link } from "react-router-dom";
import { useT } from "../lib/i18n";
import { Screen } from "../components/ui";

export function Create() {
  const t = useT();
  return (
    <Screen title={t("nav.create")} back={false}>
      <div className="stack">
        <Link to="/decks/new" className="card card-link row">
          <span className="tile-icon" aria-hidden style={{ width: 44, height: 44, display: "grid", placeItems: "center", fontSize: 22 }}>📊</span>
          <div className="grow">
            <strong>{t("deck.create")}</strong>
            <p className="caption">{t("create.deckHint")}</p>
          </div>
          <span className="chev" aria-hidden>›</span>
        </Link>
        <Link to="/quiz/new" className="card card-link row">
          <span aria-hidden style={{ width: 44, height: 44, display: "grid", placeItems: "center", fontSize: 22 }}>📝</span>
          <div className="grow">
            <strong>{t("quiz.create")}</strong>
            <p className="caption">{t("create.quizHint")}</p>
          </div>
          <span className="chev" aria-hidden>›</span>
        </Link>
        <Link to="/quizzes" className="card card-link row">
          <span aria-hidden style={{ width: 44, height: 44, display: "grid", placeItems: "center", fontSize: 22 }}>🗂</span>
          <div className="grow">
            <strong>{t("create.myQuizzes")}</strong>
          </div>
          <span className="chev" aria-hidden>›</span>
        </Link>
        {(
          [
            ["/cards", "🃏", "create.flashcards", "create.flashcardsHint"],
            ["/tutor", "💡", "tutor.title", "create.tutorHint"],
            ["/plans/new", "🗓", "plans.new", "create.planHint"],
            ["/games/matching", "🧩", "games.matching", "create.matchingHint"],
            ["/library", "🗒", "create.summary", "create.summaryHint"],
          ] as const
        ).map(([to, ico, title, hint]) => (
          <Link key={to} to={to} className="card card-link row">
            <span aria-hidden style={{ width: 44, height: 44, display: "grid", placeItems: "center", fontSize: 22 }}>{ico}</span>
            <div className="grow">
              <strong>{t(title)}</strong>
              <p className="caption">{t(hint)}</p>
            </div>
            <span className="chev" aria-hidden>›</span>
          </Link>
        ))}
      </div>
    </Screen>
  );
}
