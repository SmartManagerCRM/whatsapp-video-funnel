import { createRequire } from "node:module";
// PW = path to a Playwright install, e.g. PW=$(node -p "require.resolve('playwright')")
const { chromium, devices } = createRequire(import.meta.url)(process.env.PW);
import { readFileSync } from "node:fs";
const base = "http://localhost:8787";
const browser = await chromium.launch();
const log = [];
const ok = (name, cond, extra = "") => { log.push(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`); };

// ---------- desktop
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, serviceWorkers: "allow" });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/t/demo-cafe/`);
await page.waitForSelector("text=Sign in");
await page.screenshot({ path: "/tmp/e2e/01-login.png" });
// wrong password
await page.fill('input[type=email]', "admin@demo.test"); await page.fill('input[type=password]', "wrong-password");
await page.click('button:has-text("Sign in")');
await page.waitForSelector("text=Incorrect email or password"); ok("wrong password shows error", true);
await page.fill('input[type=password]', "demo-password-123"); await page.click('button:has-text("Sign in")');
await page.waitForSelector("h1:has-text('Dashboard')"); ok("login → dashboard", true);
await page.screenshot({ path: "/tmp/e2e/02-dashboard-desktop.png" });

// license through the UI
await page.click('nav[aria-label=Main] >> text=License');
await page.waitForSelector("text=Activate your license");
const lic = JSON.parse(readFileSync(process.env.LIC, "utf8"));
await page.fill("textarea", JSON.stringify(lic));
await page.click('button:has-text("Activate")');
await page.waitForSelector("text=License details"); ok("license activated via UI", true);
ok("license shows lifetime", await page.isVisible("text=Yes — no expiry date"));
await page.screenshot({ path: "/tmp/e2e/03-license.png" });

// category via UI
await page.click('nav[aria-label=Main] >> text=Categories');
await page.click('button:has-text("Create your first category")');
await page.fill('input[maxlength="60"]', "Restaurant"); await page.click('button:has-text("Save")');
await page.waitForSelector("h3:has-text('Restaurant')"); ok("category created via UI", true);
await page.screenshot({ path: "/tmp/e2e/04-categories.png" });

// video upload via UI (fake mp4 bytes are accepted: server validates type/size)
await page.click('nav[aria-label=Main] >> text=Video Library');
await page.waitForSelector("text=Your library is empty");
await page.setInputFiles('input[type=file] >> nth=0', { name: "intro.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(2048, 1) });
await page.waitForSelector("text=Upload video >> nth=1");
await page.click('form button:has-text("Upload")');
await page.waitForSelector("h3:has-text('intro')"); ok("video uploaded via UI", true);
await page.screenshot({ path: "/tmp/e2e/05-videos.png" });
// oversize rejected client-side
await page.setInputFiles('input[type=file] >> nth=0', { name: "big.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(17 * 1024 * 1024, 1) });
await page.waitForSelector("text=WhatsApp allows up to"); ok("oversize video rejected with message", true);

// sequence builder
await page.click('nav[aria-label=Main] >> text=Sequences');
await page.waitForSelector("text=Sequence builder");
await page.click('button:has-text("Add")'); await page.click('button:has-text("Save")');
await page.waitForSelector("text=Sequence saved"); ok("sequence saved", true);
await page.screenshot({ path: "/tmp/e2e/06-sequence.png" });

for (const [nav, h] of [["Messages", "Messages"], ["Customers", "Customers"], ["Conversations", "Conversations"], ["Analytics", "Analytics"], ["WhatsApp", "WhatsApp integration"], ["Settings", "Settings"], ["Setup", "Setup"]]) {
  await page.click(`nav[aria-label=Main] >> text=${nav}`); await page.waitForSelector(`h1:has-text("${h}")`); ok(`page ${nav} renders`, true);
  await page.screenshot({ path: `/tmp/e2e/p-${nav}.png` });
}

// ---------- PWA checks
const mhref = await page.getAttribute('link[rel=manifest]', "href");
const manifest = await (await page.request.get(new URL(mhref, page.url()).toString())).json();
ok("manifest unique id/scope", manifest.id === "/t/demo-cafe/" && manifest.scope === "/t/demo-cafe/", JSON.stringify([manifest.id, manifest.scope]));
await page.waitForFunction(() => navigator.serviceWorker.getRegistration("/t/demo-cafe/").then((r) => !!r?.active), null, { timeout: 15000 }).catch(() => {});
const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration("/t/demo-cafe/"); return r ? { scope: r.scope, active: !!r.active } : null; });
ok("service worker registered with tenant scope", reg?.active && reg.scope.endsWith("/t/demo-cafe/"), JSON.stringify(reg));
await page.reload(); await page.waitForSelector("h1"); // now controlled by SW
const cacheKeys = await page.evaluate(async () => { const out = []; for (const n of await caches.keys()) { const c = await caches.open(n); for (const r of await c.keys()) out.push(new URL(r.url).pathname); } return out; });
ok("SW caches only static shell (no /api/)", cacheKeys.length > 0 && !cacheKeys.some((u) => u.includes("/api/")), `${cacheKeys.length} entries`);
// offline: go offline then navigate again
await ctx.setOffline(true);
await page.goto(`${base}/t/demo-cafe/`, { waitUntil: "domcontentloaded" }).catch((e) => log.push("nav offline error " + e.message));
await page.waitForSelector("#root *", { timeout: 8000 }).then(() => ok("offline shell loads", true), () => ok("offline shell loads", false));
await page.waitForSelector("text=You're offline", { timeout: 8000 }).then(() => ok("offline indicator shown", true), async () => { ok("offline indicator shown", false, (await page.textContent("body"))?.slice(0, 200)); });
await page.screenshot({ path: "/tmp/e2e/07-offline.png" });
await ctx.setOffline(false);

// ---------- mobile
const mctx = await browser.newContext({ ...devices["iPhone 13"] });
const m = await mctx.newPage();
await m.goto(`${base}/t/demo-cafe/`); await m.waitForSelector("text=Sign in");
await m.fill('input[type=email]', "admin@demo.test"); await m.fill('input[type=password]', "demo-password-123"); await m.click('button:has-text("Sign in")');
await m.waitForSelector("h1:has-text('Dashboard')");
await m.screenshot({ path: "/tmp/e2e/08-dashboard-mobile.png" });
ok("mobile bottom nav visible", await m.isVisible('nav[aria-label=Quick]'));
ok("desktop sidebar hidden on mobile", !(await m.isVisible('nav[aria-label=Main]')));
const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok("no horizontal overflow on mobile dashboard", !overflow);
await m.click('nav[aria-label=Quick] >> text=More'); await m.waitForSelector('aside.absolute nav >> text=License'); ok("mobile drawer lists all pages", (await m.locator('aside.absolute nav button').count()) === 12); await m.screenshot({ path: "/tmp/e2e/09-mobile-menu.png" });

// ---------- tenant isolation in the browser: tenant cookie is path-scoped
const cookies = await ctx.cookies(base + "/t/demo-cafe/");
ok("session cookie HttpOnly + path-scoped", cookies.some((c) => c.name === "sm_session" && c.httpOnly && c.path === "/t/demo-cafe" && c.sameSite === "Strict"), JSON.stringify(cookies.map((c) => [c.path, c.httpOnly, c.sameSite])));
const other = await page.request.get(`${base}/t/other/api/categories`); ok("other tenant API not accessible", [401, 403, 404].includes(other.status()), String(other.status()));
ok("no uncaught page errors", errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.slice(0, 3).join(" | "));
console.log(log.join("\n"));
await browser.close();
