import { describe, expect, it } from "vitest";
import { ALL_CURRENCIES, MENA_CURRENCIES } from "../../apps/pwa/src/currency-data";

describe("currency dropdown data", () => {
  it("contains every Middle East & North Africa currency (Arab League + Iran, Israel, Türkiye)", () => {
    const expected = ["AED","BHD","DJF","DZD","EGP","ILS","IQD","IRR","JOD","KMF","KWD","LBP","LYD","MAD","MRU","OMR","QAR","SAR","SDG","SOS","SYP","TND","TRY","YER"];
    expect([...MENA_CURRENCIES].sort()).toEqual(expected);
    for (const c of MENA_CURRENCIES) expect(ALL_CURRENCIES, c).toContain(c);
  });

  it("has no duplicates and only valid-looking ISO 4217 codes", () => {
    expect(new Set(ALL_CURRENCIES).size).toBe(ALL_CURRENCIES.length);
    for (const c of ALL_CURRENCIES) expect(c).toMatch(/^[A-Z]{3}$/);
  });

  it("includes every currency known to the runtime's ICU data (nothing missing)", () => {
    const icu = (Intl as any).supportedValuesOf?.("currency") as string[] | undefined;
    expect(icu, "Intl.supportedValuesOf should exist").toBeDefined();
    expect(icu!.filter((c) => !(ALL_CURRENCIES as readonly string[]).includes(c))).toEqual([]);
  });

  it("every code is accepted by Intl formatting", () => {
    for (const c of ALL_CURRENCIES) expect(() => new Intl.NumberFormat("en", { style: "currency", currency: c }).format(1), c).not.toThrow();
  });
});
