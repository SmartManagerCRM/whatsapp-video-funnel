import { Hono } from "hono";
import { audit, type AppEnv } from "../auth/session";
import { encryptSecret, randomToken } from "../lib/crypto";
import { HttpError, nowIso } from "../lib/util";
import { LicenseError, activateLicense, bindPhoneToLicense, getLicenseStatus } from "../licensing";
import * as wa from "../whatsapp/client";
import { json, str } from "./validate";

export const integrationApi = new Hono<AppEnv>();

const mask = (s: string | null | undefined) => (s ? `••••${s.slice(-4)}` : null);

async function accountView(c: any) {
  const t = c.get("tenant");
  const a = await c.env.DB.prepare("SELECT * FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first();
  const origin = new URL(c.req.url).origin;
  if (!a) return { status: "not_connected", webhook_url: `${origin}/t/${t.slug}/webhook/whatsapp`, configured: false };
  let fields: string[] | null = null;
  return {
    configured: !!a.access_token_enc, status: a.status, app_id: a.app_id, waba_id: a.waba_id, phone_number_id: a.phone_number_id,
    display_phone: a.display_phone, graph_version: a.graph_version, is_on_biz_app: a.is_on_biz_app === null ? null : !!a.is_on_biz_app,
    platform_type: a.platform_type, token_hint: a.access_token_enc ? "stored (encrypted)" : null, app_secret_hint: a.app_secret_enc ? "stored (encrypted)" : null,
    verify_token: a.verify_token, webhook_url: `${origin}/t/${t.slug}/webhook/whatsapp`, required_fields: wa.REQUIRED_WEBHOOK_FIELDS, subscribed_fields: fields,
    last_api_ok_at: a.last_api_ok_at, last_webhook_at: a.last_webhook_at, last_check_at: a.last_check_at, last_error: a.last_error,
    webhook_status: a.last_webhook_at ? "receiving" : "none_received",
  };
}

integrationApi.get("/whatsapp", async (c) => c.json(await accountView(c)));

/** Save credentials (encrypted). Does NOT enable automation; the connection must be verified first. */
integrationApi.put("/whatsapp", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  const existing = await c.env.DB.prepare("SELECT * FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first<any>();
  const phoneId = str(b.phone_number_id, "Phone Number ID", { max: 40 })!;
  if (!/^\d+$/.test(phoneId)) throw new HttpError(400, "Phone Number ID must be numeric");
  const dup = await c.env.DB.prepare("SELECT tenant_id FROM whatsapp_accounts WHERE phone_number_id = ? AND tenant_id != ?").bind(phoneId, t.id).first();
  if (dup) throw new HttpError(409, "This WhatsApp number is already connected to another account");
  const token = str(b.access_token, "Access token", { optional: !!existing?.access_token_enc, max: 1000 });
  const secret = str(b.app_secret, "App secret", { optional: !!existing?.app_secret_enc, max: 200 });
  const graph = str(b.graph_version, "Graph API version", { optional: true, max: 10 }) ?? c.env.DEFAULT_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(graph)) throw new HttpError(400, "Graph API version looks like v23.0");
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO whatsapp_accounts (tenant_id, app_id, waba_id, phone_number_id, access_token_enc, app_secret_enc, verify_token, graph_version, status, updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'onboarding_pending', ?)
     ON CONFLICT (tenant_id) DO UPDATE SET app_id = excluded.app_id, waba_id = excluded.waba_id, phone_number_id = excluded.phone_number_id,
       access_token_enc = excluded.access_token_enc, app_secret_enc = excluded.app_secret_enc, graph_version = excluded.graph_version,
       status = 'onboarding_pending', is_on_biz_app = NULL, platform_type = NULL, last_error = NULL, updated_at = excluded.updated_at`,
  ).bind(
    t.id, str(b.app_id, "App ID", { optional: true, max: 40 }), str(b.waba_id, "WABA ID", { max: 40 }), phoneId,
    token ? await encryptSecret(c.env, token, `${t.id}:token`) : existing.access_token_enc,
    secret ? await encryptSecret(c.env, secret, `${t.id}:secret`) : existing.app_secret_enc,
    existing?.verify_token ?? randomToken(16), graph, now,
  ).run();
  // Credentials changed: stop automated sending until verified again.
  await c.env.DB.prepare("UPDATE tenant_settings SET automation_enabled = 0 WHERE tenant_id = ?").bind(t.id).run();
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "whatsapp_credentials_saved");
  return c.json({ ok: true });
});

/** Verification: token validity, phone number, Coexistence flags, webhook subscription. Never fakes success. */
integrationApi.post("/whatsapp/verify", async (c) => {
  const t = c.get("tenant");
  const creds = await wa.loadCreds(c.env, t.id);
  if (!creds) throw new HttpError(409, "Save your WhatsApp credentials first");
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  let status = "connected"; let isBiz: boolean | null = null; let platform: string | null = null; let display: string | null = null;
  try {
    const info = await wa.getPhoneInfo(creds);
    display = info.display_phone_number ?? null; isBiz = info.is_on_biz_app ?? null; platform = info.platform_type ?? null;
    checks.push({ name: "Access token & phone number", ok: true, detail: display ?? undefined });
    const coexist = isBiz === true;
    checks.push({ name: "Coexistence (is_on_biz_app)", ok: coexist, detail: `is_on_biz_app=${isBiz}, platform_type=${platform}` });
    status = coexist ? "coexistence_verified" : "connected";
    if (display) await bindPhoneToLicense(c.env, t.id, display);
    checks.push({ name: "License number match", ok: true });
  } catch (e) {
    if (e instanceof wa.WaError) {
      status = e.kind === "token" ? "token_invalid" : "disconnected";
      checks.push({ name: "Access token & phone number", ok: false, detail: e.message });
      await wa.recordApiError(c.env, t.id, e);
    } else if (e instanceof HttpError) {
      checks.push({ name: "License number match", ok: false, detail: e.message }); status = "disconnected";
    } else throw e;
  }
  let webhookOk = false;
  if (status === "connected" || status === "coexistence_verified") {
    try {
      const fields = await wa.getSubscribedFields(creds);
      const missing = wa.REQUIRED_WEBHOOK_FIELDS.filter((f) => !fields.includes(f));
      webhookOk = missing.length === 0;
      checks.push({ name: "Webhook subscriptions", ok: webhookOk, detail: webhookOk ? fields.join(", ") : `Missing: ${missing.join(", ")}` });
      if (!webhookOk) status = status === "coexistence_verified" ? "webhook_incomplete" : status;
    } catch (e) { checks.push({ name: "Webhook subscriptions", ok: false, detail: (e as Error).message }); }
  }
  await c.env.DB.prepare(
    `UPDATE whatsapp_accounts SET status = ?, is_on_biz_app = ?, platform_type = ?, display_phone = COALESCE(?, display_phone), last_check_at = ?,
       last_api_ok_at = CASE WHEN ? IN ('connected','coexistence_verified','webhook_incomplete') THEN ? ELSE last_api_ok_at END, updated_at = ? WHERE tenant_id = ?`,
  ).bind(status, isBiz === null ? null : isBiz ? 1 : 0, platform, display, nowIso(), status, nowIso(), nowIso(), t.id).run();
  if (status === "disconnected" || status === "token_invalid") await c.env.DB.prepare("UPDATE tenant_settings SET automation_enabled = 0 WHERE tenant_id = ?").bind(t.id).run();
  return c.json({ status, checks });
});

integrationApi.post("/whatsapp/subscribe", async (c) => {
  const t = c.get("tenant");
  const creds = await wa.loadCreds(c.env, t.id);
  if (!creds) throw new HttpError(409, "Save your WhatsApp credentials first");
  try { await wa.subscribeApp(creds, wa.REQUIRED_WEBHOOK_FIELDS); } catch (e) {
    if (e instanceof wa.WaError) throw new HttpError(502, `Meta rejected the subscription: ${e.message}`);
    throw e;
  }
  return c.json({ ok: true });
});

integrationApi.post("/whatsapp/disconnect", async (c) => {
  const t = c.get("tenant");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE whatsapp_accounts SET access_token_enc = NULL, app_secret_enc = NULL, status = 'disconnected', updated_at = ? WHERE tenant_id = ?").bind(nowIso(), t.id),
    c.env.DB.prepare("UPDATE tenant_settings SET automation_enabled = 0 WHERE tenant_id = ?").bind(t.id),
  ]);
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "whatsapp_disconnected");
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ license
integrationApi.get("/license", async (c) => {
  const t = c.get("tenant");
  const st = await getLicenseStatus(c.env, t.id);
  return c.json({ ...st, tenant: { id: t.id, slug: t.slug }, product: "SmartManager WhatsApp Video Funnel" });
});

integrationApi.post("/license/activate", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  if (typeof b.license !== "string" || b.license.length > 8000) throw new HttpError(400, "Provide the license key or the contents of the .smlic file");
  try {
    const p = await activateLicense(c.env, t, b.license, c.get("session").email);
    await audit(c.env, t.id, "tenant_user", c.get("session").userId, "license_activated", { lid: p.lid });
  } catch (e) {
    if (e instanceof LicenseError) await audit(c.env, t.id, "tenant_user", c.get("session").userId, "license_rejected", { reason: e.reason });
    throw e;
  }
  return c.json({ ok: true, status: await getLicenseStatus(c.env, t.id) });
});

// ------------------------------------------------------------------ readiness & automation switch
export async function readiness(c: any) {
  const t = c.get("tenant");
  const env = c.env;
  const [lic, acct, settings, cats, vids] = await Promise.all([
    getLicenseStatus(env, t.id),
    env.DB.prepare("SELECT status, last_webhook_at, is_on_biz_app FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first(),
    env.DB.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").bind(t.id).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM business_categories c JOIN video_sequences s ON s.category_id = c.id AND s.active = 1
        WHERE c.tenant_id = ? AND c.active = 1 AND EXISTS (SELECT 1 FROM sequence_items i JOIN videos v ON v.id = i.video_id WHERE i.sequence_id = s.id AND v.active = 1)`,
    ).bind(t.id).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN EXISTS (SELECT 1 FROM media_uploads m WHERE m.video_id = v.id AND m.sha256 = v.sha256 AND m.status = 'uploaded') THEN 1 ELSE 0 END) AS uploaded
         FROM videos v WHERE v.tenant_id = ? AND v.active = 1`,
    ).bind(t.id).first(),
  ]);
  const ok = (s?: string) => ["connected", "coexistence_verified"].includes(s ?? "");
  const checks = [
    { key: "license", label: "License activated", ok: lic.valid, detail: lic.valid ? undefined : lic.message },
    { key: "whatsapp", label: "WhatsApp credentials verified", ok: ok(acct?.status), detail: acct?.status ?? "not_connected" },
    { key: "coexistence", label: "Coexistence verified (WhatsApp Business app + API on the same number)", ok: acct?.status === "coexistence_verified", detail: acct?.is_on_biz_app === 0 ? "Number is not on the WhatsApp Business app" : undefined },
    { key: "webhook", label: "Webhook receiving events from Meta", ok: !!acct?.last_webhook_at },
    { key: "categories", label: "At least one active category with videos", ok: (cats?.n ?? 0) > 0 },
    { key: "media", label: "All active videos uploaded to WhatsApp", ok: (vids?.total ?? 0) > 0 && vids?.uploaded === vids?.total, detail: `${vids?.uploaded ?? 0}/${vids?.total ?? 0} (videos are also uploaded on first send)` },
    { key: "website", label: "Website URL configured", ok: !!settings?.website_url },
  ];
  // Hard requirements for switching automation on (the rest are advisory).
  const canEnable = checks.filter((x) => ["license", "whatsapp", "categories"].includes(x.key)).every((x) => x.ok);
  return { checks, canEnable, automation_enabled: !!settings?.automation_enabled, production_ready: checks.every((x) => x.ok) };
}

integrationApi.get("/readiness", async (c) => c.json(await readiness(c)));

integrationApi.post("/automation", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  const enable = !!b.enabled;
  if (enable) {
    const r = await readiness(c);
    if (!r.canEnable) throw new HttpError(409, "Complete the setup checklist (license, verified WhatsApp connection, and at least one category with videos) before activating automation.", "not_ready");
  }
  await c.env.DB.prepare("UPDATE tenant_settings SET automation_enabled = ?, updated_at = ? WHERE tenant_id = ?").bind(enable ? 1 : 0, nowIso(), t.id).run();
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, enable ? "automation_enabled" : "automation_disabled");
  return c.json({ ok: true, automation_enabled: enable });
});

integrationApi.get("/dashboard-status", async (c) => {
  const t = c.get("tenant");
  const lic = await getLicenseStatus(c.env, t.id);
  const acct = await c.env.DB.prepare("SELECT status, last_webhook_at FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first<any>();
  const s = await c.env.DB.prepare("SELECT automation_enabled FROM tenant_settings WHERE tenant_id = ?").bind(t.id).first<any>();
  return c.json({ license: { valid: lic.valid, reason: lic.reason, type: lic.license?.type ?? null, expires_at: lic.license?.expires_at ?? null, days_left: lic.license?.days_left ?? null, expiring_soon: lic.license?.expiring_soon ?? false }, whatsapp: acct?.status ?? "not_connected", automation_enabled: !!s?.automation_enabled });
});

