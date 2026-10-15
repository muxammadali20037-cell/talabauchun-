import { useState } from "react";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/errors";
import { ApiError } from "../lib/api";

/**
 * Opened outside Telegram (or initData rejected): explain how to return to
 * Telegram. A user id in the URL is never accepted as a login.
 */
export function OutsideTelegram({ code }: { code: string | null }) {
  const t = useT();
  const { devLogin } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <div className="app">
      <main className="main no-nav">
        <div className="stack-l" style={{ paddingTop: 48 }}>
          <div className="state">
            <div className="state-icon" aria-hidden>
              🎓
            </div>
            <h1>{t("app.name")}</h1>
            <p className="muted">{t("app.promise")}</p>
          </div>
          <div className="card stack">
            <h2>{t("common.openInTelegram")}</h2>
            <p className="muted">{code ? errorMessage(new ApiError(401, code), t) : t("common.openInTelegramHint")}</p>
          </div>
          {devLogin && (
            <div className="card stack">
              <p className="caption">Development sign-in (disabled in production builds)</p>
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await devLogin(Number(localStorage.getItem("dev.tgid") ?? 10001), "Dev").finally(() => setBusy(false));
                }}
              >
                Dev login
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
