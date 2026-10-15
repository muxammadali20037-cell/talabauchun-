import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useT } from "../lib/i18n";
import { useOnline } from "../lib/online";
import { ToastHost } from "./ui";

const NAV = [
  { to: "/", key: "nav.home", ico: "🏠", end: true },
  { to: "/create", key: "nav.create", ico: "✨" },
  { to: "/groups", key: "nav.groups", ico: "👥" },
  { to: "/library", key: "nav.library", ico: "📚" },
  { to: "/profile", key: "nav.profile", ico: "👤" },
] as const;

/** Mobile-first shell: bottom navigation, safe areas, offline banner. Full-screen flows hide the nav. */
export function Shell({ children }: { children: ReactNode }) {
  const t = useT();
  const online = useOnline();
  const { pathname } = useLocation();
  const fullScreen = /^\/(room|attempt|join|onboarding)/.test(pathname);
  return (
    <div className="app">
      <main className={`main${fullScreen ? " no-nav" : ""}`}>
        {!online && <div className="offline-banner" role="status">{t("common.offline")}</div>}
        {children}
      </main>
      {!fullScreen && (
        <nav className="bottom-nav" aria-label={t("nav.main")}>
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={"end" in n ? n.end : false}>
                  <span className="ico" aria-hidden>
                    {n.ico}
                  </span>
                  {t(n.key)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <ToastHost />
    </div>
  );
}
