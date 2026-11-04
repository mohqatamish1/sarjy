"use client";

import { createContext, useContext, useEffect, useState } from "react";
import translations from "./translations.json";

type Locale = "en" | "ar";
const LocaleContext = createContext({
  locale: "en" as Locale,
  setLocale: (_: Locale) => {},
  t: (text: string): string => text,
});

// UI language is independent of speech recognition, which always auto-detects.
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  useEffect(() => {
    const saved = localStorage.getItem("sarjy-locale");
    if (saved === "ar" || saved === "en") setLocale(saved);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  }, [locale]);
  function changeLocale(next: Locale) {
    localStorage.setItem("sarjy-locale", next);
    setLocale(next);
  }
  const t = (text: string) =>
    locale === "ar"
      ? ((translations as Record<string, string>)[text] ?? text)
      : text;
  return (
    <LocaleContext.Provider value={{ locale, setLocale: changeLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}
export function useLocale() {
  return useContext(LocaleContext);
}
