import { Hono } from "hono";
import { audit, requireOwnerSession, type AppEnv } from "../auth/session";
import { assertStrongPassword } from "../auth/routes";
import { hashIterations, hashPassword } from "../lib/crypto";
import { HttpError, SLUG_RE, newId, nowIso } from "../lib/util";
import { approveTransfer, getLicenseStatus, resetRegisteredPhone, revokeLicense, setLicenseSuspended } from "../licensing";
import { randomToken } from "../lib/crypto";
import { json, oneOf, str } from "./validate";

export const ownerApi = new Hono<AppEnv>();
ownerApi.use("*", requireOwnerSession);

const RESERVED = new Set(["owner", "api", "assets", "t", "admin", "www", "static", "icons"]);

ownerApi.get("/tenants", async (c) => {
  const origin = new URL(c.req.url).origin;
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.slug, t.business_name, t.status, t.created_at, t.last_activity_at,
            (SELECT status FROM licenses l WHERE l.tenant_id = t.id AND l.status != 'transferred' ORDER BY activated_at DESC LIMIT 1) AS license_status,
            (SELECT license_type FROM licenses l WHERE l.tenant_id = t.id AND l.status != 'transferred' ORDER BY activated_at DESC LIMIT 1) AS license_type,
            (SELECT expires_at FROM licenses l WHERE l.tenant_id = t.id AND l.status != 'transferred' ORDER BY activated_at DESC LIMIT 1) AS license_expires_at,
            (SELECT status FROM whatsapp_accounts a WHERE a.tenant_id = t.id) AS whatsapp_status,
            (SELECT COUNT(*) FROM customers cu WHERE cu.tenant_id = t.id) AS customers
       FROM tenants t ORDER BY t.created_at DESC`,
  ).all<any>();
  return c.json({ tenants: results.map((t) => ({ ...t, url: `${origin}/t/${t.slug}/`, license_status: t.license_status ?? "not_activated" })) });
});

ownerApi.post("/tenants", async (c) => {
  const b = await json(c);
  const slug = String(b.slug ?? "").toLowerCase();
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw new HttpError(400, "Slug must be 3-40 characters: lowercase letters, digits and hyphens");
  if (await c.env.DB.prepare("SELECT 1 FROM tenants WHERE slug = ?").bind(slug).first()) throw new HttpError(409, "Slug already in use");
  const email = String(b.admin_email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Valid admin email required");
  const name = str(b.business_name, "Business name", { max: 120 })!;
  const id = newId("tnt"); const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO tenants (id, slug, business_name, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)").bind(id, slug, name, now, now),
    c.env.DB.prepare("INSERT INTO tenant_settings (tenant_id, business_name, timezone, updated_at) VALUES (?,?,?,?)").bind(id, name, str(b.timezone, "Time zone", { optional: true }) ?? "UTC", now),
    c.env.DB.prepare("INSERT INTO tenant_users (id, tenant_id, email, password_hash, role, created_at) VALUES (?,?,?,?, 'admin', ?)").bind(newId("usr"), id, email, await hashPassword(assertStrongPassword(b.admin_password), hashIterations(c.env)), now),
    c.env.DB.prepare("INSERT INTO whatsapp_accounts (tenant_id, verify_token, status, updated_at) VALUES (?,?, 'not_connected', ?)").bind(id, randomToken(16), now),
  ]);
  await audit(c.env, id, "owner", c.get("session").userId, "tenant_created", { slug });
  return c.json({ id, slug, url: `${new URL(c.req.url).origin}/t/${slug}/` }, 201);
});

ownerApi.get("/tenants/:id", async (c) => {
  const id = c.req.param("id");
  const t = await c.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<any>();
  if (!t) throw new HttpError(404, "Tenant not found");
  // Credentials are deliberately NOT selected: the owner never needs raw tokens.
  const wa = await c.env.DB.prepare(
    "SELECT status, display_phone, waba_id, phone_number_id, is_on_biz_app, platform_type, last_api_ok_at, last_webhook_at, last_check_at, last_error, graph_version FROM whatsapp_accounts WHERE tenant_id = ?",
  ).bind(id).first();
  const { results: licenses } = await c.env.DB.prepare("SELECT id, license_type, status, issued_at, expires_at, activated_at, registered_phone, max_whatsapp_numbers FROM licenses WHERE tenant_id = ? ORDER BY activated_at DESC").bind(id).all();
  const { results: users } = await c.env.DB.prepare("SELECT id, email, role, disabled FROM tenant_users WHERE tenant_id = ?").bind(id).all();
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM customers WHERE tenant_id = ?1) AS customers, (SELECT COUNT(*) FROM videos WHERE tenant_id = ?1) AS videos,
            (SELECT COALESCE(SUM(size_bytes),0) FROM videos WHERE tenant_id = ?1) AS video_bytes`,
  ).bind(id).first();
  return c.json({ tenant: t, whatsapp: wa, licenses, users, counts, license_status: await getLicenseStatus(c.env, id), url: `${new URL(c.req.url).origin}/t/${t.slug}/` });
});

ownerApi.put("/tenants/:id", async (c) => {
  const b = await json(c);
  const r = await c.env.DB.prepare("UPDATE tenants SET business_name = ?, updated_at = ? WHERE id = ?").bind(str(b.business_name, "Business name", { max: 120 }), nowIso(), c.req.param("id")).run();
  if (!r.meta.changes) throw new HttpError(404, "Tenant not found");
  await audit(c.env, c.req.param("id"), "owner", c.get("session").userId, "tenant_updated");
  return c.json({ ok: true });
});

ownerApi.post("/tenants/:id/status", async (c) => {
  const b = await json(c); const status = oneOf(b.status, "status", ["active", "suspended"] as const);
  const r = await c.env.DB.prepare("UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?").bind(status, nowIso(), c.req.param("id")).run();
  if (!r.meta.changes) throw new HttpError(404, "Tenant not found");
  if (status === "suspended") await c.env.DB.prepare("DELETE FROM sessions WHERE tenant_id = ?").bind(c.req.param("id")).run();
  await audit(c.env, c.req.param("id"), "owner", c.get("session").userId, `tenant_${status}`);
  return c.json({ ok: true });
});

ownerApi.post("/tenants/:id/reset-admin", async (c) => {
  const b = await json(c); const id = c.req.param("id");
  const email = String(b.email ?? "").trim().toLowerCase();
  const hash = await hashPassword(assertStrongPassword(b.password), hashIterations(c.env));
  const user = await c.env.DB.prepare("SELECT id FROM tenant_users WHERE tenant_id = ? AND email = ?").bind(id, email).first<{ id: string }>();
  if (user) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tenant_users SET password_hash = ?, disabled = 0 WHERE id = ?").bind(hash, user.id),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'tenant'").bind(user.id),
    ]);
  } else {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Valid email required");
    await c.env.DB.prepare("INSERT INTO tenant_users (id, tenant_id, email, password_hash, role, created_at) VALUES (?,?,?,?, 'admin', ?)").bind(newId("usr"), id, email, hash, nowIso()).run();
  }
  await audit(c.env, id, "owner", c.get("session").userId, "tenant_admin_reset", { email });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ licenses
ownerApi.get("/licenses", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT l.id, l.tenant_id, t.slug, l.client_name, l.license_type, l.status, l.issued_at, l.expires_at, l.activated_at, l.registered_phone FROM licenses l JOIN tenants t ON t.id = l.tenant_id ORDER BY l.activated_at DESC",
  ).all();
  return c.json({ licenses: results });
});

ownerApi.post("/licenses/:id/revoke", async (c) => { await revokeLicense(c.env, c.req.param("id"), c.get("session").email); await audit(c.env, null, "owner", c.get("session").userId, "license_revoked", { id: c.req.param("id") }); return c.json({ ok: true }); });
ownerApi.post("/licenses/:id/suspend", async (c) => { await setLicenseSuspended(c.env, c.req.param("id"), true, c.get("session").email); return c.json({ ok: true }); });
ownerApi.post("/licenses/:id/reinstate", async (c) => { await setLicenseSuspended(c.env, c.req.param("id"), false, c.get("session").email); return c.json({ ok: true }); });
ownerApi.post("/licenses/:id/reset-phone", async (c) => { await resetRegisteredPhone(c.env, c.req.param("id"), c.get("session").email); return c.json({ ok: true }); });
ownerApi.post("/licenses/:id/transfer", async (c) => {
  const b = await json(c);
  await approveTransfer(c.env, c.req.param("id"), String(b.to_tenant_id ?? ""), c.get("session").email);
  await audit(c.env, null, "owner", c.get("session").userId, "license_transfer_approved", { id: c.req.param("id"), to: b.to_tenant_id });
  return c.json({ ok: true, next: "Issue a new license for the destination tenant with transfer_from set to the old license ID." });
});

// ------------------------------------------------------------------ operations
ownerApi.get("/errors", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT l.created_at, l.level, l.message, t.slug FROM automation_logs l LEFT JOIN tenants t ON t.id = l.tenant_id WHERE l.level IN ('error','warn') ORDER BY l.created_at DESC LIMIT 100`,
  ).all();
  const { results: failedEvents } = await c.env.DB.prepare("SELECT w.received_at, w.error, t.slug FROM whatsapp_webhook_events w JOIN tenants t ON t.id = w.tenant_id WHERE w.status = 'failed' ORDER BY w.received_at DESC LIMIT 50").all();
  return c.json({ errors: results, failedWebhookEvents: failedEvents });
});

ownerApi.get("/audit", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT a.created_at, a.actor_kind, a.action, a.detail, t.slug FROM audit_logs a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.created_at DESC LIMIT 200").all();
  return c.json({ audit: results });
});

// Cloudflare Free-plan limits as last reviewed; Cloudflare changes these. Always confirm at https://developers.cloudflare.com/workers/platform/limits/
const FREE_LIMITS = { workerRequestsPerDay: 100_000, d1RowsWrittenPerDay: 100_000, d1RowsReadPerDay: 5_000_000, d1StorageBytes: 5 * 1024 ** 3, r2StorageBytes: 10 * 1024 ** 3, queueOpsPerDay: 10_000 };

ownerApi.get("/usage", async (c) => {
  const day = new Date().toISOString().slice(0, 10);
  const { results: today } = await c.env.DB.prepare("SELECT metric, SUM(count) AS n FROM usage_counters WHERE day = ? GROUP BY metric").bind(day).all<{ metric: string; n: number }>();
  const { results: perTenant } = await c.env.DB.prepare("SELECT t.slug, u.metric, SUM(u.count) AS n FROM usage_counters u JOIN tenants t ON t.id = u.tenant_id WHERE u.day >= date('now','-30 day') GROUP BY t.slug, u.metric").all();
  const storage = await c.env.DB.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM videos").first<{ n: number }>();
  const m = Object.fromEntries(today.map((r) => [r.metric, r.n]));
  const estQueueOps = ((m.wa_messages ?? 0) + (m.webhooks ?? 0)) * 3; // publish + deliver + ack per message, rough
  const warnings: string[] = [];
  const pct = (n: number, lim: number) => n / lim;
  if (pct(storage?.n ?? 0, FREE_LIMITS.r2StorageBytes) > 0.8) warnings.push("R2 video storage is above 80% of the Free plan allowance.");
  if (pct(estQueueOps, FREE_LIMITS.queueOpsPerDay) > 0.8) warnings.push("Estimated Queue operations today are above 80% of the Free plan daily allowance.");
  if (pct((m.wa_messages ?? 0) * 6, FREE_LIMITS.d1RowsWrittenPerDay) > 0.8) warnings.push("Estimated D1 writes today are above 80% of the Free plan daily allowance.");
  return c.json({
    note: "Figures are estimates from application counters. Exact usage is in the Cloudflare dashboard (Workers & Pages → Metrics, D1, R2, Queues). The platform never upgrades your Cloudflare plan automatically.",
    today: m, estimatedQueueOpsToday: estQueueOps, r2StorageBytes: storage?.n ?? 0, limits: FREE_LIMITS, warnings, perTenant,
  });
});

ownerApi.get("/deployment", async (c) => c.json({
  product: c.env.PRODUCT_ID, graphVersionDefault: c.env.DEFAULT_GRAPH_VERSION, maxUploadMb: c.env.MAX_UPLOAD_MB,
  secretsConfigured: { ENCRYPTION_KEY: !!c.env.ENCRYPTION_KEY, LICENSE_PUBLIC_KEY: !!c.env.LICENSE_PUBLIC_KEY },
  origin: new URL(c.req.url).origin, checkedAt: nowIso(),
}));
