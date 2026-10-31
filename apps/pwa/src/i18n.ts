import { ar } from "./locales/ar";
import { fr } from "./locales/fr";

export type Lang = "en" | "fr" | "ar";
export const LANGS: { code: Lang; label: string; dir: "ltr" | "rtl" }[] = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
];
const DICT: Record<string, Record<string, string>> = { fr, ar };
const KEY = "sm_lang";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY) as Lang | null;
    if (saved && LANGS.some((l) => l.code === saved)) return saved;
  } catch { /* storage unavailable */ }
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return (LANGS.find((l) => l.code === nav)?.code ?? "en") as Lang;
}

let current: Lang = initial();
export const getLang = () => current;
const subs = new Set<() => void>();
export const subscribeLang = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

export function applyLang(l: Lang) {
  document.documentElement.lang = l;
  document.documentElement.dir = LANGS.find((x) => x.code === l)!.dir;
}
export function setLang(l: Lang) {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  applyLang(l);
  subs.forEach((f) => f());
}
applyLang(current);

/** Translate an English UI string. Unknown strings fall back to English (never blank). `{name}` placeholders are filled from vars. */
export function t(text: string, vars?: Record<string, string | number>): string {
  let out = (current === "en" ? undefined : DICT[current]?.[text]) ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

export const locale = () => (current === "ar" ? "ar" : current === "fr" ? "fr" : undefined);
