import type { ThemeId } from "@talaba/shared";
import { useI18n } from "../../lib/i18n";
import { Banner } from "../../components/ui";
import { THEME_KEYS, THEME_SWATCH, type Estimate } from "./types";

/** Small pieces shared by the create form and the deck page. */

/** Credit price before anything is reserved; failed work returns the reservation. */
export function CostBanner({ estimate }: { estimate: Estimate }) {
  const { t } = useI18n();
  return (
    <Banner kind={estimate.balance < estimate.credits ? "warn" : "info"}>
      <span className="stack deck-cost">
        <strong>{estimate.credits > 0 ? t("deck.cost", { credits: estimate.credits, balance: estimate.balance }) : t("deck.costFree", { balance: estimate.balance })}</strong>
        <span>{t("credits.refundedOnFail")}</span>
      </span>
    </Banner>
  );
}

/** The three designs as selectable cards with their real colours. */
export function ThemePicker({ value, onChange, disabled }: { value: ThemeId; onChange: (v: ThemeId) => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="deck-themes" role="radiogroup" aria-label={t("deck.style")}>
      {(Object.keys(THEME_KEYS) as ThemeId[]).map((id) => {
        const [dark, accent, soft] = THEME_SWATCH[id];
        return (
          <button key={id} type="button" role="radio" aria-checked={value === id} disabled={disabled} className="deck-theme" onClick={() => onChange(id)}>
            <span className="deck-theme-art" aria-hidden style={{ background: soft }}>
              <span style={{ background: dark }} />
              <span style={{ background: accent }} />
            </span>
            <span className="deck-theme-name">{t(THEME_KEYS[id])}</span>
          </button>
        );
      })}
    </div>
  );
}
