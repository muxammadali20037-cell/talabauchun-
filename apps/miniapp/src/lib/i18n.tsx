import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { suggestLang, translate, type Lang, type MessageKey } from "@talaba/shared";
import { tg } from "./telegram";

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (k: MessageKey, v?: Record<string, string | number>) => string };
const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => suggestLang(tg()?.initDataUnsafe?.user?.language_code ?? navigator.language));
  const value = useMemo<Ctx>(() => {
    document.documentElement.lang = lang === "uz-Cyrl" ? "uz-Cyrl" : lang;
    return { lang, setLang, t: (k, v) => translate(lang, k, v) };
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const c = useContext(I18nContext);
  if (!c) throw new Error("I18nProvider missing");
  return c;
}

export function useT() {
  return useI18n().t;
}
