import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isLang, type Lang } from "@talaba/shared";
import { api, ApiError, getToken, setToken, setUnauthorizedHandler } from "./api";
import { tg } from "./telegram";
import { useI18n } from "./i18n";

export type Me = {
  user: {
    id: string; firstName: string; lastName: string | null; username: string | null; language: Lang; languageConfirmed: boolean;
    eduRole: "student" | "teacher" | null; platformRole: "user" | "moderator" | "admin"; timezone: string; onboardingGoal: string | null;
    onboarded: boolean; personalWorkspaceId: string;
  };
  profile: Record<string, unknown> | null;
  balance: number;
  features: { ai: boolean; semanticSearch: boolean; payments: boolean; botUsername: string | null };
  integrations?: Record<string, string>;
};

type AuthState =
  | { status: "loading" }
  | { status: "outside_telegram" }
  | { status: "error"; code: string }
  | { status: "ready"; me: Me; startParam: string | null };

const AuthContext = createContext<{ state: AuthState; refresh: () => Promise<void>; devLogin?: (id: number, name: string) => Promise<void> } | null>(null);

/**
 * Sign-in = server-side validation of Telegram initData. The client never
 * trusts initDataUnsafe and never passes a user id in the URL.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const { setLang } = useI18n();

  const loadMe = useCallback(async (startParam: string | null) => {
    const me = await api.get<Me>("/api/me");
    if (isLang(me.user.language)) setLang(me.user.language);
    setState({ status: "ready", me, startParam });
  }, [setLang]);

  const signIn = useCallback(async (): Promise<string | null | false> => {
    const initData = tg()?.initData;
    if (!initData) return false;
    const r = await api.post<{ token: string; startParam: string | null }>("/api/auth/telegram", { initData });
    setToken(r.token);
    return r.startParam;
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(async () => {
      try {
        return (await signIn()) !== false;
      } catch {
        return false;
      }
    });
    (async () => {
      try {
        if (getToken()) {
          try {
            await loadMe(tg()?.initDataUnsafe?.start_param ?? null);
            return;
          } catch {
            setToken(null);
          }
        }
        const start = await signIn();
        if (start === false) {
          setState({ status: "outside_telegram" });
          return;
        }
        await loadMe(start);
      } catch (e) {
        setState({ status: "error", code: e instanceof ApiError ? e.code : "error" });
      }
    })();
  }, [loadMe, signIn]);

  const value = useMemo(
    () => ({
      state,
      refresh: async () => {
        await loadMe(state.status === "ready" ? state.startParam : null);
      },
      devLogin: import.meta.env.DEV || import.meta.env.VITE_DEV_AUTH === "true"
        ? async (id: number, name: string) => {
            const r = await api.post<{ token: string }>("/api/auth/dev", { telegramId: id, firstName: name });
            setToken(r.token);
            await loadMe(null);
          }
        : undefined,
    }),
    [state, loadMe],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const c = useContext(AuthContext);
  if (!c) throw new Error("AuthProvider missing");
  return c;
}

export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== "ready") throw new Error("not signed in");
  return state.me;
}
