import { Hono } from "hono";
import type { AppEnv } from "../auth/session";
import { bump } from "../auth/session";
import { decryptSecret, hmacSha256Hex } from "../lib/crypto";
import { newId, nowIso, timingSafeEqual } from "../lib/util";
import { parseWebhook } from "./webhook";
import { queueDeps } from "../automation/engine";

/** Per-tenant webhook endpoint: /t/:slug/webhook/whatsapp (each client's Meta app points at its own URL). */
export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.get("/", async (c) => {
  const slug = c.req.param("slug") as string;
  const q = c.req.query();
  const acct = await c.env.DB.prepare(
    "SELECT a.verify_token FROM whatsapp_accounts a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = ?",
  ).bind(slug).first<{ verify_token: string }>();
  if (q["hub.mode"] === "subscribe" && acct && timingSafeEqual(q["hub.verify_token"] ?? "", acct.verify_token)) {
    return new Response(q["hub.challenge"] ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return c.text("Forbidden", 403);
});

webhookRoutes.post("/", async (c) => {
  const slug = c.req.param("slug") as string;
  const raw = await c.req.text(); // exact bytes are required for the HMAC check
  const acct = await c.env.DB.prepare(
    `SELECT t.id AS tenant_id, a.app_secret_enc, a.phone_number_id FROM whatsapp_accounts a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = ?`,
  ).bind(slug).first<{ tenant_id: string; app_secret_enc: string | null; phone_number_id: string | null }>();
  if (!acct || !acct.app_secret_enc) return c.text("Forbidden", 403);

  const sig = c.req.header("x-hub-signature-256") ?? "";
  const secret = await decryptSecret(c.env, acct.app_secret_enc, `${acct.tenant_id}:secret`);
  const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;
  if (!timingSafeEqual(sig, expected)) return c.text("Invalid signature", 401);

  let body: any;
  try { body = JSON.parse(raw); } catch { return c.text("Bad request", 400); }
  const events = await parseWebhook(body);
  await c.env.DB.prepare("UPDATE whatsapp_accounts SET last_webhook_at = ? WHERE tenant_id = ?").bind(nowIso(), acct.tenant_id).run();
  await c.env.DB.prepare("UPDATE tenants SET last_activity_at = ? WHERE id = ?").bind(nowIso(), acct.tenant_id).run();
  await bump(c.env, acct.tenant_id, "webhooks");

  for (const ev of events) {
    // Tenant isolation: ignore events addressed to a phone number that isn't this tenant's.
    if (ev.phoneNumberId && acct.phone_number_id && ev.phoneNumberId !== acct.phone_number_id && ev.kind !== "account_update") continue;
    const id = newId("whe");
    // Idempotency: the unique (tenant_id, event_key) makes duplicate deliveries a no-op.
    const ins = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO whatsapp_webhook_events (id, tenant_id, event_key, field, kind, payload, status, received_at) VALUES (?,?,?,?,?,?,'received',?)",
    ).bind(id, acct.tenant_id, ev.key, ev.field, ev.kind, JSON.stringify(ev), nowIso()).run();
    if (ins.meta.changes) await queueDeps.send(c.env, { type: "webhook_event", eventId: id });
  }
  return c.text("ok", 200); // respond fast; real work happens in the queue consumer
});

