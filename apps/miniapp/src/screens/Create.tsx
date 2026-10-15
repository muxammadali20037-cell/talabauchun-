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
        <div className="card flat row" aria-disabled="true">
          <span aria-hidden style={{ width: 44, height: 44, display: "grid", placeItems: "center", fontSize: 22 }}>🗒</span>
          <div className="grow">
            <strong>{t("create.summary")}</strong>
            <p className="caption">{t("create.comingStage2")}</p>
          </div>
        </div>
        <div className="card flat row" aria-disabled="true">
          <span aria-hidden style={{ width: 44, height: 44, display: "grid", placeItems: "center", fontSize: 22 }}>🃏</span>
          <div className="grow">
            <strong>{t("create.flashcards")}</strong>
            <p className="caption">{t("create.comingStage2")}</p>
          </div>
        </div>
      </div>
    </Screen>
  );
}
