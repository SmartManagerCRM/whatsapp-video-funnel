// Language + currency must be visible in the header of BOTH dashboards, and in both Settings pages. Run after setup-local.sh.
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)(process.env.PW);
const base = "http://localhost:8787";
const log = []; const ok = (n, c, x = "") => log.push(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
const browser = await chromium.launch();
process.on("uncaughtException", (e) => { console.log(log.join("\n")); console.error(e.message); process.exit(1); });

/** The two header selectors are visible, inside the first screen, without opening anything. */
async function headerOk(page, label, vp) {
  const box = page.locator('[data-testid="header-controls"]');
  await box.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="header-controls"] select').length >= 2, null, { timeout: 8000 }).catch(() => {});
  const b = await box.boundingBox();
  const lang = box.locator("select").nth(0), cur = box.locator("select").nth(1);
  const [lv, cv] = [await lang.isVisible(), await cur.isVisible()];
  const [lb, cb] = [await lang.boundingBox(), await cur.boundingBox()];
  const inView = (r) => r && r.y >= 0 && r.y + r.height <= 220 && r.x >= 0 && r.x + r.width <= vp.width + 1;
  ok(`${label}: language + currency selectors visible in header`, lv && cv && inView(lb) && inView(cb), `lang@y${Math.round(lb?.y)} cur@y${Math.round(cb?.y)} box=${Math.round(b.width)}x${Math.round(b.height)}`);
  ok(`${label}: no horizontal overflow`, !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  return { lang, cur };
}

// ---------------- tenant dashboard, desktop
{
  const vp = { width: 1360, height: 860 };
  const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage();
  await page.goto(`${base}/t/demo-cafe/`); await page.waitForSelector("form");
  await page.fill("input[type=email]", "admin@demo.test"); await page.fill("input[type=password]", "demo-password-123"); await page.click("form button[type=submit]");
  const { lang, cur } = await headerOk(page, "[tenant desktop]", vp);
  await page.screenshot({ path: "/tmp/e2e/header-tenant-desktop.png" });
  // change currency from the header -> persisted on the server
  await cur.selectOption("KWD"); await page.waitForTimeout(900);
  const saved = await page.evaluate(async () => (await (await fetch("/t/demo-cafe/api/settings")).json()).currency);
  ok("[tenant desktop] header currency change is saved on the server", saved === "KWD", saved);
  // header currency and Settings page stay in sync
  await page.locator("aside nav button").nth(10).click(); await page.waitForSelector("optgroup", { state: "attached" });
  const inSettings = await page.locator("main select").filter({ has: page.locator("optgroup") }).first().inputValue();
  ok("[tenant desktop] Settings page shows the same currency", inSettings === "KWD", inSettings);
  ok("[tenant desktop] Settings page has an interface-language selector", (await page.locator("main select").evaluateAll((els) => els.some((e) => [...e.options].map((o) => o.value).join() === "en,fr,ar"))));
  await headerOk(page, "[tenant desktop, on Settings]", vp);
  // change from Settings -> header follows
  await page.locator("main select").filter({ has: page.locator("optgroup") }).first().selectOption("AED");
  await page.locator("header button, main button").filter({ hasText: /Save settings/ }).first().click(); await page.waitForTimeout(1000);
  const headerCur = await page.locator('[data-testid="header-controls"] select').nth(1).inputValue();
  ok("[tenant desktop] saving Settings updates the header currency", headerCur === "AED", headerCur);
  // language from header: Arabic, still visible
  await lang.selectOption("ar"); await page.waitForTimeout(500);
  ok("[tenant desktop] header language switches to Arabic (rtl)", (await page.evaluate(() => document.documentElement.dir)) === "rtl");
  await headerOk(page, "[tenant desktop, Arabic]", vp);
  await page.screenshot({ path: "/tmp/e2e/header-tenant-ar.png" });
  await ctx.close();
}
// ---------------- tenant dashboard, phone
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] }); const m = await ctx.newPage();
  await m.goto(`${base}/t/demo-cafe/`); await m.waitForSelector("form");
  await m.fill("input[type=email]", "admin@demo.test"); await m.fill("input[type=password]", "demo-password-123"); await m.click("form button[type=submit]");
  await headerOk(m, "[tenant phone]", devices["iPhone 13"].viewport);
  await m.screenshot({ path: "/tmp/e2e/header-tenant-phone.png" });
  await ctx.close();
}
// ---------------- owner portal
{
  const vp = { width: 1360, height: 860 };
  const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage();
  await page.goto(`${base}/owner/`); await page.waitForSelector("form");
  await page.fill("input[type=email]", "owner@smartmanager.test"); await page.fill("input[type=password]", "owner-password-123"); await page.click("form button[type=submit]");
  const { lang, cur } = await headerOk(page, "[owner desktop]", vp);
  await page.screenshot({ path: "/tmp/e2e/header-owner.png" });
  await cur.selectOption("EGP");
  ok("[owner desktop] owner currency preference persisted on device", (await page.evaluate(() => localStorage.getItem("sm_owner_currency"))) === "EGP");
  // Settings tab has both selectors
  await page.locator("nav button").last().click(); await page.waitForSelector("optgroup", { state: "attached" });
  const owSettings = await page.locator("main select").evaluateAll((els) => ({ n: els.length, hasLang: els.some((e) => [...e.options].map((o) => o.value).join() === "en,fr,ar"), hasCur: els.some((e) => e.querySelectorAll("optgroup").length === 2) }));
  ok("[owner desktop] Settings tab has interface-language and currency selectors", owSettings.hasLang && owSettings.hasCur, JSON.stringify(owSettings));
  await page.screenshot({ path: "/tmp/e2e/header-owner-settings.png" });
  // create a tenant with currency + language chosen in the form (defaults to the owner's currency)
  await page.locator("nav button").first().click(); await page.click("text=/New tenant/");
  const formCur = await page.locator("form select").filter({ has: page.locator("optgroup") }).first().inputValue();
  ok("[owner desktop] new-tenant form defaults currency to the owner's", formCur === "EGP", formCur);
  await page.fill('input[pattern]', "ui-made"); const inputs = page.locator("form input");
  await inputs.nth(1).fill("UI Made Co"); await page.locator('form input[type=email]').fill("boss@ui.test"); await page.locator('form input[type=password]').fill("a-long-password-1");
  await page.locator("form select").nth(1).selectOption("fr");
  page.once("dialog", (d) => d.accept());
  await page.locator("form button[type=submit]").click(); await page.waitForTimeout(1200);
  const prefs = await page.evaluate(async () => { const l = await (await fetch("/owner/api/tenants")).json(); const t = l.tenants.find((x) => x.slug === "ui-made"); if (!t) return null; return (await (await fetch(`/owner/api/tenants/${t.id}`)).json()).prefs; });
  ok("[owner desktop] tenant created from the UI with chosen currency + language", prefs?.currency === "EGP" && prefs?.default_language === "fr", JSON.stringify(prefs));
  await ctx.close();
}
// owner on a phone
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] }); const m = await ctx.newPage();
  await m.goto(`${base}/owner/`); await m.waitForSelector("form");
  await m.fill("input[type=email]", "owner@smartmanager.test"); await m.fill("input[type=password]", "owner-password-123"); await m.click("form button[type=submit]");
  await headerOk(m, "[owner phone]", devices["iPhone 13"].viewport);
  await m.screenshot({ path: "/tmp/e2e/header-owner-phone.png" });
  await ctx.close();
}
console.log(log.join("\n"));
await browser.close();
