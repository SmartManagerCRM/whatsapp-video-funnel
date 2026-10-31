import { Hono } from "hono";
import type { Env } from "./env";
import type { AppEnv } from "./auth/session";
import { requireTenantSession } from "./auth/session";
import { ownerAuth, tenantAuth } from "./auth/routes";
import { configApi } from "./api/config";
import { crmApi } from "./api/crm";
import { integrationApi } from "./api/integration";
import { ownerApi } from "./api/owner";
import { videoApi } from "./api/videos";
import { runMaintenance } from "./automation/engine";
import { queueHandler } from "./queues/consumer";
import { webhookRoutes } from "./whatsapp/routes";
import { HttpError } from "./lib/util";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
  console.error("Unhandled error:", err.message); // never log secrets or request bodies
  return c.json({ error: "Internal error" }, 500);
});

// Security headers on everything
app.use("*", async (c, next) => {
  await next();
  c.res = new Response(c.res.body, c.res); // responses proxied from Static Assets have immutable headers
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
  c.res.headers.set("X-Frame-Options", "DENY");
  if (!c.res.headers.has("Content-Security-Policy") && (c.res.headers.get("content-type") ?? "").includes("text/html")) {
    c.res.headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  }
});

app.get("/healthz", (c) => c.json({ ok: true, product: c.env.PRODUCT_ID }));

// ---------------------------------------------------------------- tenant routes
app.get("/t/:slug", (c) => c.redirect(`/t/${c.req.param("slug")}/`, 301));

/** Each tenant gets its own manifest: unique id + scope + start_url ⇒ independently installable PWA. */
app.get("/t/:slug/manifest.webmanifest", async (c) => {
  const slug = c.req.param("slug");
  const t = await c.env.DB.prepare("SELECT slug, business_name FROM tenants WHERE slug = ?").bind(slug).first<{ slug: string; business_name: string }>();
  if (!t) return c.json({ error: "Unknown tenant" }, 404);
  const base = `/t/${t.slug}/`;
  return new Response(JSON.stringify({
    id: base, name: `${t.business_name} · Video Funnel`, short_name: t.business_name.slice(0, 12), description: "SmartManager WhatsApp Video Funnel administration",
    start_url: base, scope: base, display: "standalone", orientation: "any", background_color: "#0b1220", theme_color: "#0f766e", lang: "en",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } });
});

app.get("/owner/manifest.webmanifest", () => new Response(JSON.stringify({
  id: "/owner/", name: "SmartManager Platform Owner", short_name: "SM Owner", start_url: "/owner/", scope: "/owner/", display: "standalone",
  background_color: "#0b1220", theme_color: "#0f766e", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
}), { headers: { "Content-Type": "application/manifest+json" } }));

const tenantApi = new Hono<AppEnv>();
tenantApi.route("/auth", tenantAuth);
// Only the auth sub-router (login/logout/me/password, which guard themselves) skips the session middleware.
// Exact prefix match on the mounted path - never a substring match on a security boundary.
tenantApi.use("*", async (c, next) => (c.req.path.startsWith(`/t/${c.req.param("slug")}/api/auth/`) ? next() : requireTenantSession(c, next)));
tenantApi.route("/", configApi);
tenantApi.route("/", videoApi);
tenantApi.route("/", crmApi);
tenantApi.route("/", integrationApi);
app.route("/t/:slug/api", tenantApi);
app.route("/t/:slug/webhook/whatsapp", webhookRoutes);

// ---------------------------------------------------------------- owner routes
const ownerRoot = new Hono<AppEnv>();
ownerRoot.route("/auth", ownerAuth);
ownerRoot.route("/", ownerApi);
app.route("/owner/api", ownerRoot);

// Unknown API paths must be a JSON 404, never the SPA shell.
app.all("/t/:slug/api/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/t/:slug/webhook/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/owner/api/*", (c) => c.json({ error: "Not found" }, 404));

// ---------------------------------------------------------------- SPA + static assets
async function spa(c: { env: Env; req: { url: string; raw: Request } }) {
  const url = new URL(c.req.url);
  url.pathname = "/"; // Static Assets canonicalises /index.html -> / (a redirect), so ask for the root document directly
  const res = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-cache");
  return out;
}
app.get("/t/:slug/*", async (c) => {
  const exists = await c.env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ?").bind(c.req.param("slug")).first();
  if (!exists) return c.text("Unknown account", 404);
  return spa(c);
});
app.get("/owner", (c) => c.redirect("/owner/", 301));
app.get("/owner/*", (c) => spa(c));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  queue: queueHandler,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runMaintenance(env).then((r) => console.log("maintenance", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env, import("./env").QueueMessage>;

