// Browser checks for French/Arabic UI, RTL layout, and the currency dropdown. Run after tests/e2e/setup-local.sh.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium, devices } = createRequire(import.meta.url)(process.env.PW);
const base = "http://localhost:8787";
const MENA = ["AED","BHD","DJF","DZD","EGP","ILS","IQD","IRR","JOD","KMF","KWD","LBP","LYD","MAD","MRU","OMR","QAR","SAR","SDG","SOS","SYP","TND","TRY","YER"];
const log = []; const ok = (n, c, x = "") => log.push(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
const browser = await chromium.launch();
process.on("uncaughtException", (e) => { console.log(log.join("\n")); console.error(e.message); process.exit(1); });

async function session(lang) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.addInitScript((l) => localStorage.setItem("sm_lang", l), lang);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/t/demo-cafe/`);
  await page.waitForSelector("form");
  await page.fill("input[type=email]", "admin@demo.test"); await page.fill("input[type=password]", "demo-password-123");
  await page.click("form button[type=submit]");
  await page.waitForSelector("nav[aria-label] button");
  return { ctx, page, errors };
}

for (const lang of ["fr", "ar"]) {
  const { ctx, page, errors } = await session(lang);
  const dir = await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir]);
  ok(`[${lang}] html lang/dir`, dir[0] === lang && dir[1] === (lang === "ar" ? "rtl" : "ltr"), dir.join("/"));
  const nav = await page.locator("aside nav button").allTextContents();
  ok(`[${lang}] sidebar translated`, nav.length === 12 && !nav.includes("Dashboard") && !nav.includes("Video Library"), nav.slice(0, 4).join(" | "));
  await page.screenshot({ path: `/tmp/e2e/i18n-${lang}-dashboard.png` });
  for (let i = 0; i < 12; i++) {
    await page.locator("aside nav button").nth(i).click(); await page.waitForTimeout(250);
    const h1 = await page.locator("h1").first().textContent();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ok(`[${lang}] page ${i} renders`, !!h1 && !overflow, `h1="${h1}" overflow=${overflow}`);
    if (i === 3 || i === 10) await page.screenshot({ path: `/tmp/e2e/i18n-${lang}-p${i}.png` });
  }
  // Settings: currency dropdown
  await page.locator("aside nav button").nth(10).click(); await page.waitForSelector("optgroup", { state: "attached" });
  const sel = page.locator('select').filter({ has: page.locator("optgroup") }).first();
  const groups = await sel.locator("optgroup").evaluateAll((g) => g.map((x) => ({ label: x.label, codes: [...x.querySelectorAll("option")].map((o) => o.value) })));
  ok(`[${lang}] two currency groups, MENA first`, groups.length === 2, groups.map((g) => `${g.label}(${g.codes.length})`).join(" / "));
  ok(`[${lang}] ALL ${MENA.length} MENA currencies present in the first group`, MENA.every((c) => groups[0].codes.includes(c)), MENA.filter((c) => !groups[0].codes.includes(c)).join(","));
  const all = new Set(groups.flatMap((g) => g.codes));
  ok(`[${lang}] international list is complete (USD EUR GBP JPY CNY INR XOF…)`, ["USD","EUR","GBP","JPY","CNY","INR","XOF","XAF","CHF","AUD","CAD","BRL","ZAR","RUB","KRW"].every((c) => all.has(c)) && all.size >= 162, `${all.size} codes`);
  const label = await sel.locator('option[value="SAR"]').textContent();
  ok(`[${lang}] currency names localised`, /SAR/.test(label) && (lang === "ar" ? /[؀-ۿ]/.test(label) : /riyal/i.test(label)), label);
  await sel.selectOption("SAR");
  await page.click("header button, main button >> text=/Save|Enregistrer|حفظ/").catch(() => {});
  await page.waitForTimeout(800);
  const saved = await page.evaluate(async () => (await (await fetch(location.pathname + "api/settings")).json()).currency);
  ok(`[${lang}] currency saved to server`, saved === "SAR", saved);
  ok(`[${lang}] no uncaught errors`, errors.length === 0, errors.slice(0, 2).join("|"));
  await ctx.close();
}

// runtime language switch (English → Arabic → French) without reloading
{
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage(); await page.goto(`${base}/t/demo-cafe/`); await page.waitForSelector("form");
  ok("[en] login in English by default", await page.isVisible("text=Sign in"));
  await page.selectOption("select[aria-label=Language]", "ar");
  await page.waitForSelector("text=تسجيل الدخول");
  ok("[switch] Arabic applied live, RTL", (await page.evaluate(() => document.documentElement.dir)) === "rtl");
  await page.screenshot({ path: "/tmp/e2e/i18n-ar-login.png" });
  await page.selectOption("select[aria-label=Language]", "fr"); await page.waitForSelector("text=Se connecter");
  ok("[switch] French applied live, LTR", (await page.evaluate(() => document.documentElement.dir)) === "ltr");
  ok("[switch] preference persisted", (await page.evaluate(() => localStorage.getItem("sm_lang"))) === "fr");
  await ctx.close();
}
// mobile RTL
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  await ctx.addInitScript(() => localStorage.setItem("sm_lang", "ar"));
  const m = await ctx.newPage(); await m.goto(`${base}/t/demo-cafe/`); await m.waitForSelector("form");
  await m.fill("input[type=email]", "admin@demo.test"); await m.fill("input[type=password]", "demo-password-123"); await m.click("form button[type=submit]");
  await m.waitForSelector("nav.fixed");
  ok("[ar mobile] no horizontal overflow", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await m.screenshot({ path: "/tmp/e2e/i18n-ar-mobile.png" });
  await ctx.close();
}
console.log(log.join("\n"));
await browser.close();
