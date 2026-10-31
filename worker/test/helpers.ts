import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { queueDeps } from "../src/automation/engine";
import { handleQueueMessage } from "../src/queues/consumer";
import { encryptSecret, hashPassword, hmacSha256Hex } from "../src/lib/crypto";
import { newId, nowIso, b64urlEncode, b64decode } from "../src/lib/util";
import { activateLicense } from "../src/licensing";
import { deps } from "../src/whatsapp/client";
import type { QueueMessage } from "../src/env";

export const APP_SECRET = "test-app-secret";
export const PASSWORD = "correct-horse-battery";

// ------------------------------------------------------------------ Meta mock
export interface MetaCall { method: string; url: string; body: any; failed?: boolean }
export const meta = {
  calls: [] as MetaCall[],
  failNext: [] as { status: number; body: any }[],
  failWhen: null as null | ((c: MetaCall) => { status: number; body: any } | null),
  phoneInfo: { display_phone_number: "+1 555 010 0000", platform_type: "CLOUD_API", is_on_biz_app: true } as any,
  subscribed: ["messages", "smb_message_echoes", "smb_app_state_sync", "history", "account_update"],
  counter: 0,
  reset() { this.calls = []; this.failNext = []; this.failWhen = null; this.counter = 0; this.phoneInfo = { display_phone_number: "+1 555 010 0000", platform_type: "CLOUD_API", is_on_biz_app: true }; },
  get sent() { return this.calls.filter((c) => c.url.endsWith("/messages") && !c.failed).map((c) => c.body); },
  get types() { return this.sent.map((b) => (b.type === "interactive" ? `interactive:${b.interactive.type}` : b.type)); },
};

export function installMeta() {
  meta.reset();
  deps.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    let body: any = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep */ } }
    else if (body instanceof FormData) body = { form: true, type: body.get("type") };
    const call: MetaCall = { method: init.method ?? "GET", url, body };
    meta.calls.push(call);
    const forced = meta.failNext.shift() ?? meta.failWhen?.(call);
    if (forced) { call.failed = true; return new Response(JSON.stringify(forced.body), { status: forced.status }); }
    if (url.endsWith("/messages")) return Response.json({ messages: [{ id: `wamid.OUT${++meta.counter}` }] });
    if (url.endsWith("/media")) return Response.json({ id: `media-${++meta.counter}` });
    if (url.includes("subscribed_apps")) return Response.json({ data: [{ subscribed_fields: meta.subscribed }] });
    if (url.includes("fields=")) return Response.json(meta.phoneInfo);
    return Response.json({});
  }) as typeof fetch;
}

// ------------------------------------------------------------------ queue capture
export const queued: { msg: QueueMessage; delay?: number }[] = [];
export function installQueue() {
  queued.length = 0;
  queueDeps.send = async (_e, msg, delay) => { queued.push({ msg, delay }); return undefined as any; };
}
/** Processes queued webhook events (not delayed step jobs) until none are left. */
export async function drain(limit = 200): Promise<number> {
  let n = 0;
  for (;;) {
    const i = queued.findIndex((q) => q.msg.type === "webhook_event");
    if (i < 0 || n >= limit) return n;
    const [{ msg }] = queued.splice(i, 1);
    await handleQueueMessage(env, msg);
    n++;
  }
}
/** Runs every step job that is queued right now exactly once (a snapshot, so newly scheduled timers wait). */
export async function runSteps(): Promise<number> {
  const snapshot = queued.filter((q) => q.msg.type === "step");
  for (const q of snapshot) queued.splice(queued.indexOf(q), 1);
  for (const q of snapshot) {
    const r = await handleQueueMessage(env, q.msg);
    if (r.retryAfter) queued.push({ msg: q.msg, delay: r.retryAfter });
  }
  return snapshot.length;
}

// ------------------------------------------------------------------ licenses
async function importPriv(pem: string) {
  const der = b64decode(pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, ""));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
export async function signLicense(payload: Record<string, unknown>, opts: { privatePem?: string } = {}) {
  const enc = new TextEncoder();
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "RS256", typ: "SMLIC" })));
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await importPriv(opts.privatePem ?? env.TEST_LICENSE_PRIVATE_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64urlEncode(sig)}`;
}
export const licensePayload = (t: { id: string; slug: string }, over: Record<string, unknown> = {}) => ({
  lid: newId("lic"), pid: env.PRODUCT_ID, product_name: "SmartManager WhatsApp Video Funnel", client_name: "Test Client",
  tenant_id: t.id, tenant_slug: t.slug, iat: Math.floor(Date.now() / 1000), type: "LIFETIME", features: ["video-funnel"], max_numbers: 1, ...over,
});

// ------------------------------------------------------------------ tenants
export interface TestTenant { id: string; slug: string; email: string; phoneNumberId: string; waPhone: string }
let seq = 0;

export async function createTenant(opts: { slug?: string; licensed?: boolean; connected?: boolean; automation?: boolean } = {}): Promise<TestTenant> {
  const n = ++seq;
  const slug = opts.slug ?? `client-${n}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `tnt_${slug}`; const now = nowIso(); const email = `admin@${slug}.test`; const phoneNumberId = `100${n}000${Math.floor(Math.random() * 1e6)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tenants (id, slug, business_name, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)").bind(id, slug, `Biz ${slug}`, now, now),
    env.DB.prepare("INSERT INTO tenant_settings (tenant_id, business_name, website_url, default_delay_seconds, updated_at) VALUES (?,?,?,?,?)").bind(id, `Biz ${slug}`, "https://example.com/discover", 30, now),
    env.DB.prepare("INSERT INTO tenant_users (id, tenant_id, email, password_hash, role, created_at) VALUES (?,?,?,?, 'admin', ?)").bind(newId("usr"), id, email, await hashPassword(PASSWORD), now),
  ]);
  const connected = opts.connected ?? false;
  await env.DB.prepare(
    `INSERT INTO whatsapp_accounts (tenant_id, app_id, waba_id, phone_number_id, display_phone, access_token_enc, app_secret_enc, verify_token, graph_version, status, is_on_biz_app, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, "app1", `waba-${slug}`, phoneNumberId, "15550100000", await encryptSecret(env, `TOKEN-${slug}`, `${id}:token`), await encryptSecret(env, APP_SECRET, `${id}:secret`),
    `verify-${slug}`, "v23.0", connected ? "coexistence_verified" : "not_connected", connected ? 1 : null, now).run();
  const t = { id, slug, email, phoneNumberId, waPhone: "15550100000" };
  if (opts.licensed) await activateLicense(env, t, await signLicense(licensePayload(t)), "test");
  if (opts.automation) await env.DB.prepare("UPDATE tenant_settings SET automation_enabled = 1 WHERE tenant_id = ?").bind(id).run();
  return t;
}

/** Fully ready tenant (license + verified WhatsApp + automation on) with N categories and a video sequence each. */
export async function readyTenant(opts: { categories?: string[]; videosPerCategory?: number; mode?: "automatic" | "manual" | "hybrid" } = {}) {
  const t = await createTenant({ licensed: true, connected: true, automation: true });
  const cats = opts.categories ?? ["Restaurant", "Café"];
  const per = opts.videosPerCategory ?? 3;
  const now = nowIso();
  if (opts.mode) await env.DB.prepare("UPDATE tenant_settings SET delivery_mode = ? WHERE tenant_id = ?").bind(opts.mode, t.id).run();
  const catIds: string[] = []; const videoIds: Record<string, string[]> = {};
  for (const [ci, name] of cats.entries()) {
    const cid = newId("cat"); const sid = newId("seq"); catIds.push(cid); videoIds[cid] = [];
    await env.DB.batch([
      env.DB.prepare("INSERT INTO business_categories (id, tenant_id, name, description, active, sort_order, created_at) VALUES (?,?,?,?,1,?,?)").bind(cid, t.id, name, `${name} businesses`, ci, now),
      env.DB.prepare("INSERT INTO video_sequences (id, tenant_id, category_id, active, version, updated_at) VALUES (?,?,?,1,1,?)").bind(sid, t.id, cid, now),
    ]);
    for (let i = 0; i < per; i++) {
      const vid = newId("vid"); const key = `tenants/${t.slug}/videos/${vid}.mp4`;
      await env.VIDEOS.put(key, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, i, ci]), { httpMetadata: { contentType: "video/mp4" } });
      videoIds[cid].push(vid);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO videos (id, tenant_id, title, caption, r2_key, mime_type, size_bytes, sha256, version, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,?,?)")
          .bind(vid, t.id, `${name} video ${i + 1}`, `${name} caption ${i + 1}`, key, "video/mp4", 10, `hash-${vid}`, now, now),
        env.DB.prepare("INSERT INTO sequence_items (id, tenant_id, sequence_id, video_id, position, delay_seconds) VALUES (?,?,?,?,?,?)").bind(newId("itm"), t.id, sid, vid, i + 1, i === 0 ? 5 : null),
      ]);
    }
  }
  return { ...t, catIds, videoIds };
}

// ------------------------------------------------------------------ HTTP helpers
const call = (path: string, init: RequestInit = {}) => (exports as any).default.fetch(new Request(`https://app.test${path}`, init));

export interface Session { cookie: string; csrf: string; slug: string }

export async function login(slug: string, email: string, password = PASSWORD): Promise<Session> {
  const res = await call(`/t/${slug}/api/auth/login`, { method: "POST", body: JSON.stringify({ email, password }), headers: { "Content-Type": "application/json" } });
  expect(res.status, await res.clone().text()).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const { csrf } = (await res.json()) as { csrf: string };
  return { cookie, csrf, slug };
}

export async function api(s: Session, method: string, path: string, body?: unknown, over: { slug?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { Cookie: s.cookie, "X-CSRF-Token": s.csrf, ...(over.headers ?? {}) };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  return call(`/t/${over.slug ?? s.slug}/api${path}`, { method, headers, body: payload });
}
export const raw = call;

// ------------------------------------------------------------------ webhooks
export async function postWebhook(slug: string, body: unknown, opts: { secret?: string; sig?: string | null } = {}) {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.sig !== null) headers["X-Hub-Signature-256"] = opts.sig ?? `sha256=${await hmacSha256Hex(opts.secret ?? APP_SECRET, text)}`;
  return call(`/t/${slug}/webhook/whatsapp`, { method: "POST", body: text, headers });
}

let msgSeq = 0;
export const inboundPayload = (t: { phoneNumberId: string }, from: string, msg: { text?: string; reply?: { id: string; title?: string; kind?: "button_reply" | "list_reply" }; id?: string; ts?: number }) => {
  const id = msg.id ?? `wamid.IN${++msgSeq}-${Math.random().toString(36).slice(2, 7)}`;
  const m: any = { from, id, timestamp: String(msg.ts ?? Math.floor(Date.now() / 1000)) };
  if (msg.reply) { m.type = "interactive"; m.interactive = { type: msg.reply.kind ?? "button_reply", [msg.reply.kind ?? "button_reply"]: { id: msg.reply.id, title: msg.reply.title ?? "x" } }; }
  else { m.type = "text"; m.text = { body: msg.text ?? "hi" }; }
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: t.phoneNumberId, display_phone_number: "15550100000" }, contacts: [{ profile: { name: "Alice" }, wa_id: from }], messages: [m] } }] }],
  };
};
export const statusPayload = (t: { phoneNumberId: string }, id: string, status: string, recipient: string, errors?: any[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: t.phoneNumberId }, statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient, ...(errors ? { errors } : {}) }] } }] }],
});
export const echoPayload = (t: { phoneNumberId: string }, to: string, text = "Hello from the business app", id = `wamid.ECHO${++msgSeq}`) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: { phone_number_id: t.phoneNumberId }, message_echoes: [{ from: "15550100000", to, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
});

/** Sends an inbound webhook then processes the queue. */
export async function customerSays(t: { slug: string; phoneNumberId: string }, from: string, msg: Parameters<typeof inboundPayload>[2]) {
  const res = await postWebhook(t.slug, inboundPayload(t, from, msg));
  expect(res.status).toBe(200);
  await drain();
}

export const convOf = (tenantId: string, phone: string) => env.DB.prepare(
  "SELECT v.* FROM conversations v JOIN customers c ON c.id = v.customer_id WHERE v.tenant_id = ? AND c.wa_phone = ? ORDER BY v.started_at DESC, v.rowid DESC LIMIT 1",
).bind(tenantId, phone).first<any>();

/** Fire (only) the next queued step job right now, as the queue would after its delay. */
export async function runNextJob() {
  const i = queued.findIndex((q) => q.msg.type === "step");
  if (i < 0) return false;
  const [{ msg }] = queued.splice(i, 1);
  const r = await handleQueueMessage(env, msg);
  if (r.retryAfter) queued.push({ msg, delay: r.retryAfter });
  return true;
}
