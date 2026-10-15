import { Route, Routes } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { Loading, Screen } from "../../components/ui";

// Replaced by the full Presentation Studio screens once the deck API lands.
export function DeckRoutes() {
  const t = useT();
  return (
    <Routes>
      <Route path="*" element={<Screen title={t("deck.title")}><Loading /></Screen>} />
    </Routes>
  );
}
