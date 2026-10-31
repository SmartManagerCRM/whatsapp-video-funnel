import type { Env, QueueMessage, TenantSettings } from "../env";
import { bump } from "../auth/session";
import { getLicenseStatus } from "../licensing";
import { newId, normKeyword, nowIso, safeJson } from "../lib/util";
import * as wa from "../whatsapp/client";
import { WaError, loadCreds, recordApiError, recordApiOk, type WaCreds } from "../whatsapp/client";
import type { EchoMessage, InboundMessage, StatusUpdate } from "../whatsapp/webhook";
import { getTemplate, render } from "./templates";

// ---------------------------------------------------------------------------------------------
// Types & seams
// ---------------------------------------------------------------------------------------------
export type State =
  | "NEW" | "WELCOME_SENT" | "WAITING_FOR_CATEGORY" | "CATEGORY_SELECTED" | "VIDEO_SEQUENCE_ACTIVE"
  | "WAITING_FOR_NEXT_VIDEO" | "WEBSITE_LINK_SENT" | "GOODBYE_SENT" | "COMPLETED" | "HUMAN_HANDLING"
  | "PAUSED" | "OPTED_OUT" | "FAILED";

export interface Conversation {
  id: string; tenant_id: string; customer_id: string; state: State; category_id: string | null;
  pending_category_id: string | null; sequence_id: string | null; sequence_version: number | null;
  next_step: number; videos_sent: number; run_version: number; lock_until: string | null;
  resume_state: State | null; paused_reason: string | null; human_handling_until: string | null;
  last_inbound_at: string | null; website_sent: number; goodbye_sent: number;
  started_at: string; completed_at: string | null;
}
interface Customer { id: string; wa_phone: string; name: string | null; opted_out: number }

/** Queue seam: tests capture messages instead of relying on a live consumer. */
export const queueDeps = {
  send: (env: Env, msg: QueueMessage, delaySeconds?: number) =>
    env.QUEUE.send(msg, delaySeconds ? { delaySeconds } : undefined),
};

export const MAX_QUEUE_DELAY_SECONDS = 86_400; // Cloudflare Queues hard limit (24h)
export const MAX_STEP_ATTEMPTS = 5;
const LOCK_SECONDS = 120;
const WINDOW_MS = 24 * 3600_000;
const SOON_MS = 2 * 3600_000;

export type WindowStatus = "open" | "expiring_soon" | "expired";
export function windowStatus(lastInboundAt: string | null, now = Date.now()): WindowStatus {
  if (!lastInboundAt) return "expired";
  const left = new Date(lastInboundAt).getTime() + WINDOW_MS - now;
  if (left <= 0) return "expired";
  return left <= SOON_MS ? "expiring_soon" : "open";
}

const CUSTOMER_STATUS: Record<State, string> = {
  NEW: "new", WELCOME_SENT: "new", WAITING_FOR_CATEGORY: "waiting", CATEGORY_SELECTED: "in_progress",
  VIDEO_SEQUENCE_ACTIVE: "in_progress", WAITING_FOR_NEXT_VIDEO: "waiting", WEBSITE_LINK_SENT: "in_progress",
  GOODBYE_SENT: "in_progress", COMPLETED: "completed", HUMAN_HANDLING: "human_handling", PAUSED: "paused",
  OPTED_OUT: "opted_out", FAILED: "failed",
};

interface Ctx {
  env: Env; tenantId: string; settings: TenantSettings; lang: string; businessName: string;
}

async function loadCtx(env: Env, tenantId: string): Promise<Ctx> {
  const settings = await env.DB.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").bind(tenantId).first<TenantSettings>();
  const tenant = await env.DB.prepare("SELECT business_name FROM tenants WHERE id = ?").bind(tenantId).first<{ business_name: string }>();
  if (!settings || !tenant) throw new Error(`Tenant ${tenantId} is not configured`);
  return { env, tenantId, settings, lang: settings.default_language || "en", businessName: settings.business_name || tenant.business_name };
}

const tpl = (ctx: Ctx, key: string, vars: Record<string, string | number | null | undefined> = {}) =>
  getTemplate(ctx.env, ctx.tenantId, key, ctx.lang).then((b) => render(b, { business: ctx.businessName, website: ctx.settings.website_url, ...vars }));

// ---------------------------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------------------------
async function getConv(env: Env, id: string): Promise<Conversation | null> {
  return env.DB.prepare("SELECT * FROM conversations WHERE id = ?").bind(id).first<Conversation>();
}

async function event(env: Env, tenantId: string, convId: string, type: string, data?: unknown) {
  await env.DB.prepare("INSERT INTO conversation_events (id, tenant_id, conversation_id, type, data, created_at) VALUES (?,?,?,?,?,?)")
    .bind(newId("evt"), tenantId, convId, type, data === undefined ? null : JSON.stringify(data), nowIso()).run();
}

export async function autoLog(env: Env, tenantId: string, convId: string | null, message: string, level = "info") {
  await env.DB.prepare("INSERT INTO automation_logs (id, tenant_id, conversation_id, level, message, created_at) VALUES (?,?,?,?,?,?)")
    .bind(newId("log"), tenantId, convId, level, message.slice(0, 500), nowIso()).run();
}

/** Every transition is stored (conversation_events) and mirrored to the customer's status. */
async function transition(env: Env, conv: Conversation, to: State, why: string, extra: Partial<Record<string, unknown>> = {}) {
  const from = conv.state;
  const sets = ["state = ?", "updated_at = ?"]; const vals: unknown[] = [to, nowIso()];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
  await env.DB.batch([
    env.DB.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, conv.id),
    env.DB.prepare("UPDATE customers SET status = ?, last_interaction_at = ? WHERE id = ?").bind(CUSTOMER_STATUS[to], nowIso(), conv.customer_id),
    env.DB.prepare("INSERT INTO conversation_events (id, tenant_id, conversation_id, type, data, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("evt"), conv.tenant_id, conv.id, "state_change", JSON.stringify({ from, to, why }), nowIso()),
  ]);
  conv.state = to;
  Object.assign(conv, extra);
}

async function cancelJobs(env: Env, convId: string) {
  await env.DB.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE conversation_id = ? AND status = 'pending'").bind(convId).run();
}

/** Invalidate everything in flight for this conversation (jobs, locks, stale buttons). */
async function invalidateRun(env: Env, conv: Conversation) {
  await cancelJobs(env, conv.id);
  await env.DB.prepare("UPDATE conversations SET run_version = run_version + 1, lock_until = NULL WHERE id = ?").bind(conv.id).run();
  conv.run_version += 1; conv.lock_until = null;
}

// ---------------------------------------------------------------------------------------------
// Sending (24-hour window aware)
// ---------------------------------------------------------------------------------------------
class WindowClosedError extends Error {}

type Delivery = { kind: string; body: string; videoId?: string; send: (c: WaCreds) => Promise<string> };

async function deliver(ctx: Ctx, conv: Conversation, customer: Customer, d: Delivery): Promise<string> {
  if (windowStatus(conv.last_inbound_at) === "expired") throw new WindowClosedError("24-hour customer service window is closed");
  const creds = await loadCreds(ctx.env, ctx.tenantId);
  if (!creds) throw new WaError("WhatsApp is not connected", "permanent", 400);
  const logId = newId("msg"); const t = nowIso();
  await ctx.env.DB.prepare(
    `INSERT INTO message_logs (id, tenant_id, conversation_id, customer_id, direction, kind, body, video_id, status, created_at, updated_at)
     VALUES (?,?,?,?,'outbound_auto',?,?,?,'queued',?,?)`,
  ).bind(logId, ctx.tenantId, conv.id, customer.id, d.kind, d.body.slice(0, 2000), d.videoId ?? null, t, t).run();
  try {
    const waId = await d.send(creds);
    // "Submitted" only once Meta has accepted the API request.
    await ctx.env.DB.prepare("UPDATE message_logs SET wa_message_id = ?, status = 'submitted', updated_at = ? WHERE id = ?").bind(waId, nowIso(), logId).run();
    await recordApiOk(ctx.env, ctx.tenantId);
    await bump(ctx.env, ctx.tenantId, "wa_messages");
    return waId;
  } catch (e) {
    if (e instanceof WaError) {
      await ctx.env.DB.prepare("UPDATE message_logs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(e.message.slice(0, 300), nowIso(), logId).run();
      await recordApiError(ctx.env, ctx.tenantId, e);
    }
    throw e;
  }
}

const sendText = (ctx: Ctx, conv: Conversation, cu: Customer, text: string, preview = false) =>
  text ? deliver(ctx, conv, cu, { kind: "text", body: text, send: (c) => wa.sendText(c, cu.wa_phone, text, preview) }) : Promise.resolve("");

async function sendTemplateText(ctx: Ctx, conv: Conversation, cu: Customer, key: string, vars: Record<string, string> = {}) {
  const body = await tpl(ctx, key, { name: cu.name ?? "", ...vars });
  if (body) await sendText(ctx, conv, cu, body);
}

// ---------------------------------------------------------------------------------------------
// Gate: automation must be explicitly enabled, licensed and verified
// ---------------------------------------------------------------------------------------------
export async function automationGate(ctx: Ctx): Promise<{ ok: boolean; reason?: string }> {
  const t = await ctx.env.DB.prepare("SELECT status FROM tenants WHERE id = ?").bind(ctx.tenantId).first<{ status: string }>();
  if (!t || t.status !== "active") return { ok: false, reason: "tenant_suspended" };
  if (!ctx.settings.automation_enabled) return { ok: false, reason: "automation_disabled" };
  const acct = await ctx.env.DB.prepare("SELECT status FROM whatsapp_accounts WHERE tenant_id = ?").bind(ctx.tenantId).first<{ status: string }>();
  if (!acct || !["connected", "coexistence_verified"].includes(acct.status)) return { ok: false, reason: "whatsapp_not_verified" };
  const lic = await getLicenseStatus(ctx.env, ctx.tenantId);
  if (!lic.valid) return { ok: false, reason: `license_${lic.reason}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Category selection
// ---------------------------------------------------------------------------------------------
interface CategoryRow { id: string; name: string; description: string | null }

async function playableCategories(env: Env, tenantId: string): Promise<CategoryRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.description FROM business_categories c
       JOIN video_sequences s ON s.category_id = c.id AND s.active = 1
      WHERE c.tenant_id = ? AND c.active = 1
        AND EXISTS (SELECT 1 FROM sequence_items i JOIN videos v ON v.id = i.video_id WHERE i.sequence_id = s.id AND v.active = 1)
      ORDER BY c.sort_order, c.name`,
  ).bind(tenantId).all<CategoryRow>();
  return results;
}

const PAGE_SIZE = 8;

async function sendCategoryPrompt(ctx: Ctx, conv: Conversation, cu: Customer, page = 0, textOnly = false) {
  const cats = await playableCategories(ctx.env, ctx.tenantId);
  if (cats.length === 0) {
    await sendTemplateText(ctx, conv, cu, "error_generic");
    throw new WaError("No playable categories are configured", "permanent", 400);
  }
  const question = await tpl(ctx, "category_question");
  if (!textOnly) {
    let rows: { id: string; title: string; description?: string }[];
    if (cats.length <= 10) {
      rows = cats.map((c) => ({ id: `cat:${c.id}`, title: c.name, description: c.description ?? undefined }));
    } else {
      const slice = cats.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      rows = slice.map((c) => ({ id: `cat:${c.id}`, title: c.name, description: c.description ?? undefined }));
      if (page > 0) rows.push({ id: `catpage:${page - 1}`, title: "◀ Previous" });
      if ((page + 1) * PAGE_SIZE < cats.length) rows.push({ id: `catpage:${page + 1}`, title: "More ▶" });
    }
    const label = await tpl(ctx, "category_list_button");
    try {
      await deliver(ctx, conv, cu, { kind: "interactive", body: question, send: (c) => wa.sendList(c, cu.wa_phone, question, label, rows) });
      return;
    } catch (e) {
      // Text fallback if the interactive message is rejected (not for window/token/transient errors).
      if (!(e instanceof WaError) || e.kind !== "permanent") throw e;
      await autoLog(ctx.env, ctx.tenantId, conv.id, `Interactive list failed (${e.message}); using text fallback`, "warn");
    }
  }
  const intro = await tpl(ctx, "category_text_list");
  await sendText(ctx, conv, cu, `${question}\n\n${intro}\n${cats.map((c, i) => `${i + 1}. ${c.name}`).join("\n")}`);
}

function matchCategory(text: string, cats: CategoryRow[]): CategoryRow | null {
  const t = normKeyword(text);
  if (!t) return null;
  if (/^\d{1,3}$/.test(t)) return cats[parseInt(t, 10) - 1] ?? null;
  return cats.find((c) => normKeyword(c.name) === t) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------------
async function scheduleStep(env: Env, conv: Conversation, step: number, delaySeconds: number) {
  await cancelJobs(env, conv.id);
  const jobId = newId("job");
  const runAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const dispatch = delaySeconds <= MAX_QUEUE_DELAY_SECONDS;
  await env.DB.prepare(
    `INSERT INTO scheduled_jobs (id, tenant_id, conversation_id, kind, step, run_version, sequence_version, run_at, status, dispatched, created_at)
     VALUES (?,?,?,'step',?,?,?,?,'pending',?,?)`,
  ).bind(jobId, conv.tenant_id, conv.id, step, conv.run_version, conv.sequence_version, runAt, dispatch ? 1 : 0, nowIso()).run();
  // Delays beyond the 24h Queue limit stay in D1 and are dispatched by the cron trigger when due.
  if (dispatch) await queueDeps.send(env, { type: "step", jobId }, Math.max(0, Math.round(delaySeconds)));
  return jobId;
}

interface SeqItem { video_id: string; delay_seconds: number | null; item_caption: string | null; caption: string | null; title: string; r2_key: string; mime_type: string; sha256: string; version: number; size_bytes: number; id: string }

async function loadSequence(env: Env, conv: Conversation): Promise<{ items: SeqItem[]; version: number } | null> {
  if (!conv.sequence_id) return null;
  const seq = await env.DB.prepare("SELECT version, active FROM video_sequences WHERE id = ? AND tenant_id = ?").bind(conv.sequence_id, conv.tenant_id).first<{ version: number; active: number }>();
  if (!seq || !seq.active) return null;
  const { results } = await env.DB.prepare(
    `SELECT i.video_id, i.delay_seconds, i.caption AS item_caption, v.caption, v.title, v.r2_key, v.mime_type, v.sha256, v.version, v.size_bytes, v.id
       FROM sequence_items i JOIN videos v ON v.id = i.video_id
      WHERE i.sequence_id = ? AND i.tenant_id = ? AND v.active = 1 ORDER BY i.position`,
  ).bind(conv.sequence_id, conv.tenant_id).all<SeqItem>();
  return { items: results, version: seq.version };
}

// ---------------------------------------------------------------------------------------------
// Media: upload original from R2 to Meta once per (video, phone number, file hash)
// ---------------------------------------------------------------------------------------------
export async function ensureMedia(env: Env, creds: WaCreds, video: SeqItem, force = false): Promise<string> {
  if (!force) {
    const row = await env.DB.prepare(
      "SELECT media_id FROM media_uploads WHERE video_id = ? AND phone_number_id = ? AND sha256 = ? AND status = 'uploaded' AND tenant_id = ?",
    ).bind(video.id, creds.phoneNumberId, video.sha256, creds.tenantId).first<{ media_id: string }>();
    if (row?.media_id) return row.media_id;
  }
  const obj = await env.VIDEOS.get(video.r2_key);
  if (!obj) throw new WaError(`Video file is missing from storage (${video.title})`, "permanent", 404);
  try {
    const mediaId = await wa.uploadMedia(creds, await obj.arrayBuffer(), video.mime_type, `${video.id}.mp4`);
    await env.DB.prepare(
      `INSERT INTO media_uploads (id, tenant_id, video_id, phone_number_id, sha256, version, media_id, status, uploaded_at, created_at)
       VALUES (?,?,?,?,?,?,?,'uploaded',?,?)
       ON CONFLICT (video_id, phone_number_id, sha256) DO UPDATE SET media_id = excluded.media_id, status = 'uploaded', error = NULL, uploaded_at = excluded.uploaded_at`,
    ).bind(newId("mu"), creds.tenantId, video.id, creds.phoneNumberId, video.sha256, video.version, mediaId, nowIso(), nowIso()).run();
    return mediaId;
  } catch (e) {
    if (e instanceof WaError) {
      // The original stays in R2; the failure is recorded so the admin can retry.
      await env.DB.prepare(
        `INSERT INTO media_uploads (id, tenant_id, video_id, phone_number_id, sha256, version, status, error, created_at)
         VALUES (?,?,?,?,?,?,'failed',?,?)
         ON CONFLICT (video_id, phone_number_id, sha256) DO UPDATE SET status = 'failed', error = excluded.error`,
      ).bind(newId("mu"), creds.tenantId, video.id, creds.phoneNumberId, video.sha256, video.version, e.message.slice(0, 300), nowIso()).run();
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Presentation flow
// ---------------------------------------------------------------------------------------------
async function sendWelcomeAndCategories(ctx: Ctx, conv: Conversation, cu: Customer) {
  await sendTemplateText(ctx, conv, cu, "welcome");
  if (conv.state === "NEW") await transition(ctx.env, conv, "WELCOME_SENT", "welcome sent");
  await sendCategoryPrompt(ctx, conv, cu);
  await transition(ctx.env, conv, "WAITING_FOR_CATEGORY", "category question sent");
}

async function applyCategory(ctx: Ctx, conv: Conversation, cu: Customer, categoryId: string, isChange: boolean) {
  const seq = await ctx.env.DB.prepare(
    "SELECT s.id, s.version FROM video_sequences s JOIN business_categories c ON c.id = s.category_id WHERE s.category_id = ? AND s.tenant_id = ? AND s.active = 1 AND c.active = 1",
  ).bind(categoryId, ctx.tenantId).first<{ id: string; version: number }>();
  if (!seq) { await sendTemplateText(ctx, conv, cu, "category_fallback"); return; }

  const keepProgress = isChange && ctx.settings.category_change_policy === "continue";
  await invalidateRun(ctx.env, conv); // never allow two sequences to run at once
  const n = (await loadSequence(ctx.env, { ...conv, sequence_id: seq.id }))?.items.length ?? 0;
  const step = keepProgress ? Math.min(conv.next_step, n) : 0;
  await ctx.env.DB.prepare("UPDATE customers SET category_id = ? WHERE id = ?").bind(categoryId, cu.id).run();
  await transition(ctx.env, conv, "CATEGORY_SELECTED", isChange ? "category changed" : "category selected", {
    category_id: categoryId, pending_category_id: null, sequence_id: seq.id, sequence_version: seq.version,
    next_step: step, videos_sent: keepProgress ? conv.videos_sent : 0, website_sent: 0, goodbye_sent: 0, completed_at: null, paused_reason: null,
  });
  await event(ctx.env, ctx.tenantId, conv.id, isChange ? "category_changed" : "category_selected", { category_id: categoryId });
  await transition(ctx.env, conv, "VIDEO_SEQUENCE_ACTIVE", "sequence started");
  await scheduleStep(ctx.env, conv, step, 0);
}

type StepOutcome = "done" | "ignored" | "retry";

/** Executes one step of the sequence exactly once. Safe against duplicate / stale / concurrent invocations. */
export async function executeStep(env: Env, jobId: string): Promise<{ outcome: StepOutcome; retryAfter?: number }> {
  const job = await env.DB.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").bind(jobId).first<{
    id: string; tenant_id: string; conversation_id: string; step: number; run_version: number; status: string; attempts: number;
  }>();
  if (!job || job.status !== "pending") return { outcome: "ignored" };
  const conv = await getConv(env, job.conversation_id);
  if (!conv || conv.run_version !== job.run_version || !["VIDEO_SEQUENCE_ACTIVE", "WAITING_FOR_NEXT_VIDEO"].includes(conv.state) || conv.next_step !== job.step) {
    await env.DB.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'").bind(jobId).run();
    return { outcome: "ignored" };
  }

  // Lease: only one executor may send this step.
  const lock = await env.DB.prepare(
    "UPDATE conversations SET lock_until = ? WHERE id = ? AND run_version = ? AND next_step = ? AND (lock_until IS NULL OR lock_until < ?)",
  ).bind(new Date(Date.now() + LOCK_SECONDS * 1000).toISOString(), conv.id, job.run_version, job.step, nowIso()).run();
  if (!lock.meta.changes) return { outcome: "ignored" };

  const ctx = await loadCtx(env, conv.tenant_id);
  const cu = (await env.DB.prepare("SELECT id, wa_phone, name, opted_out FROM customers WHERE id = ?").bind(conv.customer_id).first<Customer>())!;
  const release = () => env.DB.prepare("UPDATE conversations SET lock_until = NULL WHERE id = ? AND run_version = ?").bind(conv.id, job.run_version).run();

  try {
    if (cu.opted_out) { await release(); await cancelJobs(env, conv.id); return { outcome: "ignored" }; }
    const gate = await automationGate(ctx);
    if (!gate.ok) {
      await release();
      await transition(env, conv, "PAUSED", gate.reason!, { paused_reason: gate.reason, resume_state: conv.state });
      await env.DB.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?").bind(jobId).run();
      return { outcome: "ignored" };
    }
    if (windowStatus(conv.last_inbound_at) === "expired") {
      await release();
      await pauseForWindow(ctx, conv, cu);
      await env.DB.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?").bind(jobId).run();
      return { outcome: "ignored" };
    }

    const seq = await loadSequence(env, conv);
    if (!seq || seq.items.length === 0) throw new WaError("The assigned sequence is empty or inactive", "permanent", 400);
    if (seq.version !== conv.sequence_version) {
      await env.DB.prepare("UPDATE conversations SET sequence_version = ? WHERE id = ?").bind(seq.version, conv.id).run();
      conv.sequence_version = seq.version;
      await event(env, conv.tenant_id, conv.id, "sequence_resynced", { version: seq.version });
    }
    const n = seq.items.length;
    if (conv.state !== "VIDEO_SEQUENCE_ACTIVE") await transition(env, conv, "VIDEO_SEQUENCE_ACTIVE", "step started");

    if (job.step < n) {
      const item = seq.items[job.step];
      const creds = await loadCreds(env, conv.tenant_id);
      if (!creds) throw new WaError("WhatsApp is not connected", "permanent", 400);
      let mediaId = await ensureMedia(env, creds, item);
      const intro = await tpl(ctx, "video_intro", { index: job.step + 1, total: n, title: item.title });
      if (intro) await sendText(ctx, conv, cu, intro);
      const caption = item.item_caption ?? item.caption ?? undefined;
      try {
        await deliver(ctx, conv, cu, { kind: "video", body: caption ?? item.title, videoId: item.video_id, send: (c) => wa.sendVideo(c, cu.wa_phone, mediaId, caption) });
      } catch (e) {
        // Stale/invalid media id → re-upload once from the original in R2, then retry the send.
        if (e instanceof WaError && e.kind === "media") {
          mediaId = await ensureMedia(env, creds, item, true);
          await deliver(ctx, conv, cu, { kind: "video", body: caption ?? item.title, videoId: item.video_id, send: (c) => wa.sendVideo(c, cu.wa_phone, mediaId, caption) });
        } else throw e;
      }
      const upd = await env.DB.prepare(
        "UPDATE conversations SET next_step = ?, videos_sent = videos_sent + 1, lock_until = NULL, updated_at = ? WHERE id = ? AND run_version = ?",
      ).bind(job.step + 1, nowIso(), conv.id, job.run_version).run();
      await env.DB.prepare("UPDATE scheduled_jobs SET status = 'done' WHERE id = ?").bind(jobId).run();
      await event(env, conv.tenant_id, conv.id, "video_sent", { step: job.step, video_id: item.video_id });
      if (!upd.meta.changes) return { outcome: "done" }; // run was invalidated while sending; do not schedule more
      conv.next_step = job.step + 1; conv.videos_sent += 1;

      const delay = item.delay_seconds ?? ctx.settings.default_delay_seconds;
      const mode = ctx.settings.delivery_mode;
      if (job.step + 1 >= n) {
        await scheduleStep(env, conv, n, delay); // final: website + goodbye
      } else if (mode === "automatic") {
        await scheduleStep(env, conv, job.step + 1, delay);
      } else {
        await sendContinuePrompt(ctx, conv, cu, job.step + 1);
        await transition(env, conv, "WAITING_FOR_NEXT_VIDEO", "waiting for customer / delay");
        if (mode === "hybrid") await scheduleStep(env, conv, job.step + 1, delay);
      }
      return { outcome: "done" };
    }

    // job.step === n: website invitation, website link, goodbye
    await finishJourney(ctx, conv, cu);
    await env.DB.prepare("UPDATE scheduled_jobs SET status = 'done' WHERE id = ?").bind(jobId).run();
    await release();
    return { outcome: "done" };
  } catch (e) {
    await release();
    return handleStepError(ctx, conv, cu, job, e);
  }
}

async function sendContinuePrompt(ctx: Ctx, conv: Conversation, cu: Customer, nextStep: number) {
  const body = await tpl(ctx, "continue_prompt");
  const [cont, change] = await Promise.all([tpl(ctx, "continue_button"), tpl(ctx, "change_category_button")]);
  await deliver(ctx, conv, cu, {
    kind: "interactive", body,
    send: (c) => wa.sendButtons(c, cu.wa_phone, body, [{ id: `continue:${nextStep}`, title: cont }, { id: "changecat", title: change }]),
  });
}

async function finishJourney(ctx: Ctx, conv: Conversation, cu: Customer) {
  const url = ctx.settings.website_url;
  if (!conv.website_sent) {
    await sendTemplateText(ctx, conv, cu, "website_invite");
    if (url) await sendText(ctx, conv, cu, url, true);
    await ctx.env.DB.prepare("UPDATE conversations SET website_sent = 1 WHERE id = ?").bind(conv.id).run();
    conv.website_sent = 1;
    await transition(ctx.env, conv, "WEBSITE_LINK_SENT", "website invitation sent");
  }
  if (!conv.goodbye_sent) {
    await sendTemplateText(ctx, conv, cu, "goodbye");
    await ctx.env.DB.prepare("UPDATE conversations SET goodbye_sent = 1 WHERE id = ?").bind(conv.id).run();
    conv.goodbye_sent = 1;
    await transition(ctx.env, conv, "GOODBYE_SENT", "goodbye sent");
  }
  // Completed only after the final message was accepted by the WhatsApp API.
  await transition(ctx.env, conv, "COMPLETED", "journey completed", { completed_at: nowIso(), next_step: conv.next_step + 1 });
}

async function pauseForWindow(ctx: Ctx, conv: Conversation, cu: Customer) {
  const prev = conv.state;
  await transition(ctx.env, conv, "PAUSED", "24h window expired", { paused_reason: "window_expired", resume_state: prev });
  await cancelJobs(ctx.env, conv.id);
  const tn = ctx.settings.reopen_template_name;
  if (tn) {
    // Only an approved template the client configured may be used outside the window. Tracked as its own kind.
    try {
      const creds = await loadCreds(ctx.env, ctx.tenantId);
      if (creds) {
        const id = await wa.sendTemplate(creds, cu.wa_phone, tn, ctx.settings.reopen_template_language || "en");
        await ctx.env.DB.prepare(
          `INSERT INTO message_logs (id, tenant_id, conversation_id, customer_id, direction, wa_message_id, kind, body, status, created_at, updated_at)
           VALUES (?,?,?,?,'outbound_auto',?,'template',?,'submitted',?,?)`,
        ).bind(newId("msg"), ctx.tenantId, conv.id, cu.id, id, `template:${tn}`, nowIso(), nowIso()).run();
      }
    } catch (e) { await autoLog(ctx.env, ctx.tenantId, conv.id, `Re-open template failed: ${(e as Error).message}`, "warn"); }
  }
}

async function handleStepError(ctx: Ctx, conv: Conversation, cu: Customer, job: { id: string; attempts: number; step: number }, e: unknown): Promise<{ outcome: StepOutcome; retryAfter?: number }> {
  const env = ctx.env;
  if (e instanceof WindowClosedError) {
    await pauseForWindow(ctx, conv, cu);
    await env.DB.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?").bind(job.id).run();
    return { outcome: "ignored" };
  }
  if (e instanceof WaError && e.kind === "window") {
    await pauseForWindow(ctx, conv, cu);
    await env.DB.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?").bind(job.id).run();
    return { outcome: "ignored" };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof WaError) await recordApiError(env, ctx.tenantId, e); // e.g. token errors raised during media upload
  const attempts = job.attempts + 1;
  await env.DB.prepare("UPDATE scheduled_jobs SET attempts = ?, last_error = ? WHERE id = ?").bind(attempts, msg.slice(0, 300), job.id).run();
  await autoLog(env, ctx.tenantId, conv.id, `Step ${job.step} failed (attempt ${attempts}): ${msg}`, "error");
  const retryable = e instanceof WaError ? e.retryable : true;
  if (e instanceof WaError && e.kind === "token") {
    // Credentials are bad: retrying cannot help. Pause with progress preserved; admin fixes token and resumes.
    await transition(env, conv, "PAUSED", "token invalid", { paused_reason: "token_invalid", resume_state: conv.state });
    await env.DB.prepare("UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?").bind(job.id).run();
    return { outcome: "ignored" };
  }
  if (retryable && attempts < MAX_STEP_ATTEMPTS) {
    return { outcome: "retry", retryAfter: Math.min(900, 15 * 2 ** (attempts - 1)) }; // 15s, 30s, 60s, 120s ...
  }
  await failConversation(env, conv, job.id, msg);
  return { outcome: "ignored" };
}

export async function failConversation(env: Env, conv: Conversation, jobId: string | null, reason: string) {
  if (jobId) await env.DB.prepare("UPDATE scheduled_jobs SET status = 'failed', last_error = ? WHERE id = ?").bind(reason.slice(0, 300), jobId).run();
  // Progress (next_step, videos_sent) is retained so an administrator can retry from the same point.
  await transition(env, conv, "FAILED", reason.slice(0, 200), { resume_state: conv.state === "FAILED" ? conv.resume_state : conv.state });
}

// ---------------------------------------------------------------------------------------------
// Inbound messages
// ---------------------------------------------------------------------------------------------
async function upsertCustomer(env: Env, tenantId: string, phone: string, name: string | null): Promise<Customer> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO customers (id, tenant_id, wa_phone, name, status, first_interaction_at, last_interaction_at)
     VALUES (?,?,?,?, 'new', ?, ?)
     ON CONFLICT (tenant_id, wa_phone) DO UPDATE SET last_interaction_at = excluded.last_interaction_at,
       name = COALESCE(NULLIF(excluded.name, ''), customers.name)`,
  ).bind(newId("cus"), tenantId, phone, name, now, now).run();
  return (await env.DB.prepare("SELECT id, wa_phone, name, opted_out FROM customers WHERE tenant_id = ? AND wa_phone = ?").bind(tenantId, phone).first<Customer>())!;
}

async function latestConversation(env: Env, customerId: string): Promise<Conversation | null> {
  return env.DB.prepare("SELECT * FROM conversations WHERE customer_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").bind(customerId).first<Conversation>();
}

async function createConversation(env: Env, tenantId: string, customerId: string, state: State, lastInbound: string | null): Promise<Conversation> {
  const id = newId("cnv"); const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO conversations (id, tenant_id, customer_id, state, last_inbound_at, started_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(id, tenantId, customerId, state, lastInbound, now, now).run();
  await event(env, tenantId, id, "conversation_started");
  return (await getConv(env, id))!;
}

const CHANGE_WORDS = ["CHANGE", "MENU", "CATEGORY", "CHANGE CATEGORY"];
const NEXT_WORDS = ["NEXT", "CONTINUE"];

export async function handleInbound(env: Env, tenantId: string, m: InboundMessage): Promise<void> {
  const ctx = await loadCtx(env, tenantId);
  const cu = await upsertCustomer(env, tenantId, m.from, m.name);
  const at = m.timestamp ? new Date(m.timestamp * 1000).toISOString() : nowIso();

  let conv = await latestConversation(env, cu.id);
  if (!conv) conv = await createConversation(env, tenantId, cu.id, "NEW", at);
  // The customer-service window is measured from the most recent customer-initiated message.
  if (!conv.last_inbound_at || at > conv.last_inbound_at) {
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ?, updated_at = ? WHERE id = ?").bind(at, nowIso(), conv.id).run();
    conv.last_inbound_at = at;
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_logs (id, tenant_id, conversation_id, customer_id, direction, wa_message_id, kind, body, status, created_at, updated_at)
     VALUES (?,?,?,?,'inbound',?,?,?, 'delivered', ?, ?)`,
  ).bind(newId("msg"), tenantId, conv.id, cu.id, m.id, m.type === "text" ? "text" : m.type, m.text || (m.replyId ?? ""), at, at).run();

  const text = normKeyword(m.text);
  const optOut = safeJson<string[]>(ctx.settings.opt_out_keywords, []).map(normKeyword);
  const optIn = safeJson<string[]>(ctx.settings.opt_in_keywords, []).map(normKeyword);

  // --- Opt-out / opt-in handling comes first and always works.
  if (m.type === "text" && optOut.includes(text)) {
    await env.DB.prepare("UPDATE customers SET opted_out = 1 WHERE id = ?").bind(cu.id).run();
    cu.opted_out = 1;
    await invalidateRun(env, conv);
    if (conv.state !== "OPTED_OUT") await transition(env, conv, "OPTED_OUT", "customer opted out", { resume_state: null });
    await event(env, tenantId, conv.id, "opted_out");
    try { await sendTemplateText(ctx, conv, cu, "optout_confirm"); } catch (e) { await autoLog(env, tenantId, conv.id, `opt-out confirmation not sent: ${(e as Error).message}`, "warn"); }
    return;
  }
  if (cu.opted_out) {
    if (m.type === "text" && optIn.includes(text)) {
      await env.DB.prepare("UPDATE customers SET opted_out = 0 WHERE id = ?").bind(cu.id).run();
      cu.opted_out = 0;
      conv = await createConversation(env, tenantId, cu.id, "NEW", at);
      await event(env, tenantId, conv.id, "opted_in");
      const gate = await automationGate(ctx);
      if (gate.ok) await safely(ctx, conv, async () => { await sendTemplateText(ctx, conv!, cu, "optin_confirm"); await sendWelcomeAndCategories(ctx, conv!, cu); });
    } else {
      await autoLog(env, tenantId, conv.id, "Message from opted-out customer ignored (explicit opt-in required)");
    }
    return;
  }

  const gate = await automationGate(ctx);
  if (!gate.ok) { await autoLog(env, tenantId, conv.id, `Inbound recorded, automation inactive: ${gate.reason}`); return; }

  switch (conv.state) {
    case "HUMAN_HANDLING":
      await event(env, tenantId, conv.id, "inbound_during_human_handling");
      return;
    case "PAUSED":
      if (conv.paused_reason === "window_expired" || conv.paused_reason === "automation_disabled" || conv.paused_reason === "whatsapp_not_verified") {
        await autoResumeAfterPause(ctx, conv, cu);
      }
      return;
    case "NEW": case "WELCOME_SENT":
      await safely(ctx, conv, () => sendWelcomeAndCategories(ctx, conv!, cu));
      return;
    case "WAITING_FOR_CATEGORY":
      await safely(ctx, conv, () => handleCategoryReply(ctx, conv!, cu, m));
      return;
    case "COMPLETED": case "FAILED":
      // A new customer message after a finished (or failed) journey begins a fresh presentation.
      conv = await createConversation(env, tenantId, cu.id, "NEW", at);
      await safely(ctx, conv, () => sendWelcomeAndCategories(ctx, conv!, cu));
      return;
    case "OPTED_OUT":
      return;
    default:
      // Sequence in progress (or finishing)
      await safely(ctx, conv, () => handleActiveReply(ctx, conv!, cu, m, text));
  }
}

/** Wraps a send flow so window / token problems pause cleanly instead of losing the conversation. */
async function safely(ctx: Ctx, conv: Conversation, fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) {
    if (e instanceof WindowClosedError || (e instanceof WaError && e.kind === "window")) {
      const cu = (await ctx.env.DB.prepare("SELECT id, wa_phone, name, opted_out FROM customers WHERE id = ?").bind(conv.customer_id).first<Customer>())!;
      await pauseForWindow(ctx, conv, cu); return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    await autoLog(ctx.env, ctx.tenantId, conv.id, `Flow error: ${msg}`, "error");
    if (e instanceof WaError && e.kind === "token") await transition(ctx.env, conv, "PAUSED", "token invalid", { paused_reason: "token_invalid", resume_state: conv.state });
    else if (e instanceof WaError && !e.retryable) await failConversation(ctx.env, conv, null, msg);
    else throw e; // transient: let the queue retry the webhook event
  }
}

async function handleCategoryReply(ctx: Ctx, conv: Conversation, cu: Customer, m: InboundMessage) {
  const id = m.replyId ?? "";
  if (id.startsWith("catpage:")) { await sendCategoryPrompt(ctx, conv, cu, parseInt(id.slice(8), 10) || 0); return; }
  const cats = await playableCategories(ctx.env, ctx.tenantId);
  let chosen: CategoryRow | null = null;
  if (id.startsWith("cat:")) chosen = cats.find((c) => c.id === id.slice(4)) ?? null;
  else if (m.type === "text") chosen = matchCategory(m.text, cats);
  if (!chosen) {
    await sendTemplateText(ctx, conv, cu, "category_fallback");
    await sendCategoryPrompt(ctx, conv, cu, 0);
    return;
  }
  await applyCategory(ctx, conv, cu, chosen.id, false);
}

async function handleActiveReply(ctx: Ctx, conv: Conversation, cu: Customer, m: InboundMessage, text: string) {
  const id = m.replyId ?? "";
  if (id.startsWith("continue:") || (m.type === "text" && NEXT_WORDS.includes(text))) {
    const step = id.startsWith("continue:") ? parseInt(id.slice(9), 10) : conv.next_step;
    // Only the button for the *current* step is valid: stale buttons are ignored (no duplicate videos).
    if (step === conv.next_step && ["VIDEO_SEQUENCE_ACTIVE", "WAITING_FOR_NEXT_VIDEO"].includes(conv.state)) {
      await scheduleStep(ctx.env, conv, step, 0); // cancels the pending delayed job; the step lease ensures once-only
      await event(ctx.env, ctx.tenantId, conv.id, "continue_pressed", { step });
    }
    return;
  }
  if (id === "changecat" || (m.type === "text" && CHANGE_WORDS.includes(text))) { await sendCategoryPrompt(ctx, conv, cu); return; }
  if (id.startsWith("catpage:")) { await sendCategoryPrompt(ctx, conv, cu, parseInt(id.slice(8), 10) || 0); return; }
  if (id.startsWith("cat:") || (m.type === "text" && matchCategory(m.text, await playableCategories(ctx.env, ctx.tenantId)))) {
    const cats = await playableCategories(ctx.env, ctx.tenantId);
    const chosen = id.startsWith("cat:") ? cats.find((c) => c.id === id.slice(4)) : matchCategory(m.text, cats);
    if (!chosen) return;
    if (chosen.id === conv.category_id) { await sendTemplateText(ctx, conv, cu, "category_change_kept"); return; }
    await ctx.env.DB.prepare("UPDATE conversations SET pending_category_id = ? WHERE id = ?").bind(chosen.id, conv.id).run();
    const body = await tpl(ctx, "category_change_confirm", { category: chosen.name });
    const [yes, no] = await Promise.all([tpl(ctx, "category_change_yes"), tpl(ctx, "category_change_no")]);
    await deliver(ctx, conv, cu, {
      kind: "interactive", body,
      send: (c) => wa.sendButtons(c, cu.wa_phone, body, [{ id: `confirmcat:${chosen.id}`, title: yes }, { id: "keepcat", title: no }]),
    });
    return;
  }
  if (id.startsWith("confirmcat:")) {
    if (conv.pending_category_id === id.slice(11)) await applyCategory(ctx, conv, cu, id.slice(11), true);
    return;
  }
  if (id === "keepcat") {
    await ctx.env.DB.prepare("UPDATE conversations SET pending_category_id = NULL WHERE id = ?").bind(conv.id).run();
    await sendTemplateText(ctx, conv, cu, "category_change_kept");
  }
  // Anything else during an active sequence is recorded but does not interrupt it.
}

async function autoResumeAfterPause(ctx: Ctx, conv: Conversation, cu: Customer) {
  const to = conv.resume_state ?? "WAITING_FOR_CATEGORY";
  await safely(ctx, conv, async () => {
    if (["NEW", "WELCOME_SENT", "WAITING_FOR_CATEGORY", "CATEGORY_SELECTED"].includes(to) || !conv.sequence_id) {
      await sendTemplateText(ctx, conv, cu, "resume_notice");
      await sendCategoryPrompt(ctx, conv, cu);
      await transition(ctx.env, conv, "WAITING_FOR_CATEGORY", "resumed after window reopened", { paused_reason: null, resume_state: null });
    } else {
      await sendTemplateText(ctx, conv, cu, "resume_notice");
      await invalidateRun(ctx.env, conv);
      await transition(ctx.env, conv, "VIDEO_SEQUENCE_ACTIVE", "resumed after window reopened", { paused_reason: null, resume_state: null });
      await scheduleStep(ctx.env, conv, conv.next_step, 0);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Coexistence echoes / human handover, statuses, state sync
// ---------------------------------------------------------------------------------------------
export async function handleEcho(env: Env, tenantId: string, e: EchoMessage): Promise<void> {
  // Never treat an echo as a customer message. Skip if we sent it ourselves via the API.
  const mine = await env.DB.prepare("SELECT id FROM message_logs WHERE tenant_id = ? AND wa_message_id = ?").bind(tenantId, e.id).first();
  if (mine) return;
  const ctx = await loadCtx(env, tenantId);
  const cu = await upsertCustomer(env, tenantId, e.to, null);
  let conv = await latestConversation(env, cu.id);
  if (!conv) conv = await createConversation(env, tenantId, cu.id, "NEW", null);
  const at = e.timestamp ? new Date(e.timestamp * 1000).toISOString() : nowIso();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_logs (id, tenant_id, conversation_id, customer_id, direction, wa_message_id, kind, body, status, created_at, updated_at)
     VALUES (?,?,?,?,'outbound_human',?,?,?,'sent',?,?)`,
  ).bind(newId("msg"), tenantId, conv.id, cu.id, e.id, e.type, e.text, at, at).run();
  if (!ctx.settings.handover_enabled) return;
  await enterHumanHandling(ctx, conv, "human reply from WhatsApp Business app");
}

export async function enterHumanHandling(ctx: Ctx, conv: Conversation, why: string) {
  if (["HUMAN_HANDLING", "OPTED_OUT"].includes(conv.state)) return;
  if (conv.state === "COMPLETED") { await event(ctx.env, ctx.tenantId, conv.id, "human_message_after_completion"); return; }
  const mins = ctx.settings.handover_timeout_minutes;
  const resumeState = conv.state === "FAILED" || conv.state === "PAUSED" ? conv.resume_state : conv.state;
  await invalidateRun(ctx.env, conv);
  await transition(ctx.env, conv, "HUMAN_HANDLING", why, {
    resume_state: resumeState, human_handling_until: mins > 0 ? new Date(Date.now() + mins * 60_000).toISOString() : null,
  });
}

export async function resumeAutomation(env: Env, convId: string, why: string): Promise<void> {
  const conv = await getConv(env, convId);
  if (!conv) return;
  if (!["HUMAN_HANDLING", "PAUSED", "FAILED"].includes(conv.state)) return;
  const ctx = await loadCtx(env, conv.tenant_id);
  const cu = (await env.DB.prepare("SELECT id, wa_phone, name, opted_out FROM customers WHERE id = ?").bind(conv.customer_id).first<Customer>())!;
  if (cu.opted_out) return;
  const target = conv.resume_state ?? "WAITING_FOR_CATEGORY";
  await invalidateRun(env, conv);
  if (conv.sequence_id && ["VIDEO_SEQUENCE_ACTIVE", "WAITING_FOR_NEXT_VIDEO", "WEBSITE_LINK_SENT", "GOODBYE_SENT", "CATEGORY_SELECTED"].includes(target)) {
    await transition(env, conv, "VIDEO_SEQUENCE_ACTIVE", why, { paused_reason: null, human_handling_until: null, resume_state: null });
    await scheduleStep(env, conv, conv.next_step, 0);
  } else {
    await transition(env, conv, "WAITING_FOR_CATEGORY", why, { paused_reason: null, human_handling_until: null, resume_state: null });
    if (windowStatus(conv.last_inbound_at) !== "expired") await safely(ctx, conv, () => sendCategoryPrompt(ctx, conv, cu));
  }
}

const STATUS_RANK: Record<string, number> = { queued: 0, submitted: 1, sent: 2, delivered: 3, read: 4 };

export async function handleStatus(env: Env, tenantId: string, s: StatusUpdate): Promise<void> {
  const row = await env.DB.prepare("SELECT id, status FROM message_logs WHERE tenant_id = ? AND wa_message_id = ?").bind(tenantId, s.id).first<{ id: string; status: string }>();
  if (!row) return;
  if (s.status === "failed") {
    if ((STATUS_RANK[row.status] ?? 0) >= 3) return;
    await env.DB.prepare("UPDATE message_logs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(s.error, nowIso(), row.id).run();
    return;
  }
  const rank = STATUS_RANK[s.status];
  if (rank === undefined || rank <= (STATUS_RANK[row.status] ?? 0)) return; // never downgrade (out-of-order delivery)
  await env.DB.prepare("UPDATE message_logs SET status = ?, error = NULL, updated_at = ? WHERE id = ?").bind(s.status, nowIso(), row.id).run();
}

export async function handleStateSync(env: Env, tenantId: string, contacts: { phone: string; name: string | null; action: string }[]) {
  for (const c of contacts) {
    if (c.action === "remove" || !c.name) continue;
    await env.DB.prepare(
      `INSERT INTO customers (id, tenant_id, wa_phone, name, status, first_interaction_at, last_interaction_at) VALUES (?,?,?,?,'new',?,?)
       ON CONFLICT (tenant_id, wa_phone) DO UPDATE SET name = COALESCE(NULLIF(customers.name,''), excluded.name)`,
    ).bind(newId("cus"), tenantId, c.phone, c.name, nowIso(), nowIso()).run();
  }
}

// ---------------------------------------------------------------------------------------------
// Administrator actions
// ---------------------------------------------------------------------------------------------
export type AdminAction = "pause" | "resume" | "restart" | "human" | "complete" | "retry" | "change_category";

export async function adminAction(env: Env, tenantId: string, convId: string, action: AdminAction, arg?: string): Promise<void> {
  const conv = await getConv(env, convId);
  if (!conv || conv.tenant_id !== tenantId) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  const ctx = await loadCtx(env, tenantId);
  const cu = (await env.DB.prepare("SELECT id, wa_phone, name, opted_out FROM customers WHERE id = ?").bind(conv.customer_id).first<Customer>())!;
  switch (action) {
    case "pause":
      await invalidateRun(env, conv);
      await transition(env, conv, "PAUSED", "paused by administrator", { paused_reason: "admin", resume_state: ["PAUSED", "HUMAN_HANDLING", "FAILED"].includes(conv.state) ? conv.resume_state : conv.state });
      break;
    case "human":
      await enterHumanHandling(ctx, conv, "marked as human-handled by administrator");
      break;
    case "resume": case "retry":
      await resumeAutomation(env, convId, `${action} by administrator`);
      break;
    case "complete":
      await invalidateRun(env, conv);
      await transition(env, conv, "COMPLETED", "completed by administrator", { completed_at: nowIso(), resume_state: null });
      break;
    case "restart": case "change_category": {
      if (cu.opted_out) throw Object.assign(new Error("Customer has opted out; they must opt in again"), { status: 409 });
      await invalidateRun(env, conv);
      if (action === "restart" && conv.category_id) {
        await transition(env, conv, "VIDEO_SEQUENCE_ACTIVE", "restarted by administrator", { next_step: 0, videos_sent: 0, website_sent: 0, goodbye_sent: 0, completed_at: null, paused_reason: null, resume_state: null, human_handling_until: null });
        await scheduleStep(env, conv, 0, 0);
      } else if (action === "change_category" && arg) {
        await applyCategory(ctx, conv, cu, arg, true);
      } else {
        await transition(env, conv, "WAITING_FOR_CATEGORY", "restarted by administrator", { next_step: 0, videos_sent: 0, website_sent: 0, goodbye_sent: 0, completed_at: null, paused_reason: null, resume_state: null });
        if (windowStatus(conv.last_inbound_at) !== "expired") await safely(ctx, conv, () => sendCategoryPrompt(ctx, conv, cu));
      }
      break;
    }
  }
  await event(env, tenantId, convId, `admin_${action}`);
}

// ---------------------------------------------------------------------------------------------
// Maintenance (cron)
// ---------------------------------------------------------------------------------------------
export async function runMaintenance(env: Env): Promise<{ resumed: number; dispatched: number; purged: number }> {
  const now = nowIso();
  // 1) Human-handover timeouts
  const { results: expired } = await env.DB.prepare(
    "SELECT id FROM conversations WHERE state = 'HUMAN_HANDLING' AND human_handling_until IS NOT NULL AND human_handling_until < ? LIMIT 50",
  ).bind(now).all<{ id: string }>();
  for (const c of expired) await resumeAutomation(env, c.id, "handover timeout expired");

  // 2) Jobs whose delay exceeded the Queue limit (dispatched=0), or whose queue message appears lost (>10 min overdue)
  const overdue = new Date(Date.now() - 10 * 60_000).toISOString();
  const { results: due } = await env.DB.prepare(
    "SELECT id FROM scheduled_jobs WHERE status = 'pending' AND ((dispatched = 0 AND run_at <= ?) OR (dispatched = 1 AND run_at < ?)) LIMIT 100",
  ).bind(now, overdue).all<{ id: string }>();
  for (const j of due) {
    await env.DB.prepare("UPDATE scheduled_jobs SET dispatched = 1 WHERE id = ?").bind(j.id).run();
    await queueDeps.send(env, { type: "step", jobId: j.id });
  }

  // 3) Housekeeping + data retention
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Math.floor(Date.now() / 1000) - 86400).run();
  let purged = 0;
  const { results: tenants } = await env.DB.prepare("SELECT tenant_id, retention_days FROM tenant_settings WHERE retention_days > 0").all<{ tenant_id: string; retention_days: number }>();
  for (const t of tenants) {
    const cutoff = new Date(Date.now() - t.retention_days * 86400_000).toISOString();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND last_interaction_at < ?").bind(t.tenant_id, cutoff).first<{ n: number }>();
    await env.DB.prepare("DELETE FROM customers WHERE tenant_id = ? AND last_interaction_at < ?").bind(t.tenant_id, cutoff).run();
    purged += n?.n ?? 0;
  }
  return { resumed: expired.length, dispatched: due.length, purged };
}
