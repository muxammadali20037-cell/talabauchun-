import { useMe } from "../lib/auth";
import { useT } from "../lib/i18n";
import { openTelegramLink } from "../lib/telegram";
import { Screen } from "../components/ui";

/** Help, terms and privacy summaries. The privacy page states plainly what goes to the AI provider. */
export function InfoPage({ kind }: { kind: "terms" | "privacy" | "help" }) {
  const t = useT();
  const me = useMe();
  const bot = me.features.botUsername;
  if (kind === "help")
    return (
      <Screen title={t("profile.support")}>
        <div className="stack">
          <div className="card stack">
            <p className="small" style={{ whiteSpace: "pre-line" }}>{t("info.helpBody")}</p>
          </div>
          {bot && <button className="btn btn-primary" onClick={() => openTelegramLink(`https://t.me/${bot}?start=support`)}>{t("info.writeSupport")}</button>}
        </div>
      </Screen>
    );
  return (
    <Screen title={kind === "terms" ? t("profile.terms") : t("profile.privacy")}>
      <div className="card stack">
        <p className="small" style={{ whiteSpace: "pre-line" }}>{kind === "terms" ? t("info.termsBody") : t("info.privacyBody")}</p>
        <p className="caption">{t("info.draftNote")}</p>
      </div>
    </Screen>
  );
}
