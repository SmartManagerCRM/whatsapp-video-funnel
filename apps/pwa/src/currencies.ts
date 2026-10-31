import { getLang } from "./i18n";
import { ALL_CURRENCIES, MENA_CURRENCIES } from "./currency-data";

export { ALL_CURRENCIES, MENA_CURRENCIES };

export interface CurrencyOption { code: string; name: string }

function nameOf(code: string, lang: string): string {
  try { return new Intl.DisplayNames([lang], { type: "currency" }).of(code) ?? code; } catch { return code; }
}

/** Two groups for the dropdown: MENA first, then every other currency, each sorted by its localised name. */
export function currencyGroups(lang = getLang()): { mena: CurrencyOption[]; other: CurrencyOption[] } {
  const mena = new Set<string>(MENA_CURRENCIES);
  const sort = (xs: string[]) => xs.map((code) => ({ code, name: nameOf(code, lang) })).sort((a, b) => a.name.localeCompare(b.name, lang));
  return { mena: sort([...MENA_CURRENCIES]), other: sort(ALL_CURRENCIES.filter((c) => !mena.has(c))) };
}

export function formatMoney(amount: number, currency: string, lang = getLang()): string {
  try { return new Intl.NumberFormat(lang, { style: "currency", currency }).format(amount); } catch { return `${amount.toFixed(2)} ${currency}`; }
}
