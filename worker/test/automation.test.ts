import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { convOf, customerSays, installMeta, installQueue, meta, queued, readyTenant, runNextJob, runSteps } from "./helpers";

const PHONE = "201000000001";

beforeEach(() => { installMeta(); installQueue(); });

const pickCategory = (t: any, idx: number) => customerSays(t, PHONE, { reply: { id: `cat:${t.catIds[idx]}`, kind: "list_reply" } });
const press = (t: any, step: number) => customerSays(t, PHONE, { reply: { id: `continue:${step}` } });

describe("first message", () => {
  it("sends welcome then the category list, and stores state", async () => {
    const t = await readyTenant();
    await customerSays(t, PHONE, { text: "hello" });
    expect(meta.types).toEqual(["text", "interactive:list"]);
    expect(meta.sent[0].text.body).toContain("Welcome to");
    const rows = meta.sent[1].interactive.action.sections[0].rows;
    expect(rows.map((r: any) => r.title)).toEqual(["Restaurant", "Café"]);
    const conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("WAITING_FOR_CATEGORY");
    const events = await env.DB.prepare("SELECT data FROM conversation_events WHERE conversation_id = ? AND type = 'state_change'").bind(conv.id).all<any>();
    const states = events.results.map((e) => JSON.parse(e.data).to);
    expect(states).toEqual(["WELCOME_SENT", "WAITING_FOR_CATEGORY"]);
  });

  it("does nothing (but records the message) while automation is switched off", async () => {
    const t = await readyTenant();
    await env.DB.prepare("UPDATE tenant_settings SET automation_enabled = 0 WHERE tenant_id = ?").bind(t.id).run();
    await customerSays(t, PHONE, { text: "hello" });
    expect(meta.sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM message_logs WHERE tenant_id = ? AND direction = 'inbound'").bind(t.id).first<any>()).n).toBe(1);
  });

  it("refuses to send when the license is revoked", async () => {
    const t = await readyTenant();
    await env.DB.prepare("UPDATE licenses SET status = 'revoked' WHERE tenant_id = ?").bind(t.id).run();
    await customerSays(t, PHONE, { text: "hello" });
    expect(meta.sent).toHaveLength(0);
  });

  it("falls back to a numbered text list when the interactive list is rejected", async () => {
    const t = await readyTenant();
    meta.failWhen = (c) => (c.body?.type === "interactive" ? { status: 400, body: { error: { code: 100, message: "bad list" } } } : null);
    await customerSays(t, PHONE, { text: "hello" });
    expect(meta.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(3); // welcome, rejected list, text fallback
    expect(meta.types).toEqual(["text", "text"]);
    expect(meta.sent[1].text.body).toContain("1. Restaurant");
    await customerSays(t, PHONE, { text: "2" }); // numeric text selection
    expect((await convOf(t.id, PHONE)).category_id).toBe(t.catIds[1]);
  });

  it("paginates more than 10 categories", async () => {
    const t = await readyTenant({ categories: Array.from({ length: 13 }, (_, i) => `Cat ${String(i + 1).padStart(2, "0")}`), videosPerCategory: 1 });
    await customerSays(t, PHONE, { text: "hi" });
    const rows = meta.sent[1].interactive.action.sections[0].rows;
    expect(rows).toHaveLength(9);
    expect(rows.at(-1).id).toBe("catpage:1");
    await customerSays(t, PHONE, { reply: { id: "catpage:1", kind: "list_reply" } });
    const rows2 = meta.sent.at(-1).interactive.action.sections[0].rows.map((r: any) => r.id);
    expect(rows2).toContain("catpage:0");
    expect(rows2).toHaveLength(6); // 5 remaining categories + "Previous"
  });
});

describe("sequence delivery - hybrid (default)", () => {
  it("sends videos in order, each new step guarded by delay + Continue, then website and goodbye", async () => {
    const t = await readyTenant({ videosPerCategory: 3 });
    await customerSays(t, PHONE, { text: "hello" });
    meta.calls.length = 0;
    await pickCategory(t, 0);
    // video 1 is sent via a queued step, not inline
    expect(queued.some((q) => q.msg.type === "step")).toBe(true);
    await runNextJob();
    expect(meta.types).toEqual(["video", "interactive:button"]);
    expect(meta.sent[0].video.caption).toBe("Restaurant caption 1");
    // media uploaded exactly once, before the video
    expect(meta.calls.filter((c) => c.url.endsWith("/media"))).toHaveLength(1);
    // hybrid: button AND a delayed job (video 1 has a 5s per-video delay)
    const pending = queued.find((q) => q.msg.type === "step")!;
    expect(pending.delay).toBe(5);
    expect((await convOf(t.id, PHONE)).state).toBe("WAITING_FOR_NEXT_VIDEO");

    await press(t, 1); // Continue → immediate (the hybrid timer's queue message is now stale)
    await runSteps();
    expect(meta.sent.filter((b) => b.type === "video")).toHaveLength(2);
    // second video uses the tenant default delay (30)
    expect(queued.find((q) => q.msg.type === "step")!.delay).toBe(30);

    await runNextJob(); // timer fires for video 3 without any button press
    expect(meta.sent.filter((b) => b.type === "video").map((b) => b.video.caption)).toEqual(["Restaurant caption 1", "Restaurant caption 2", "Restaurant caption 3"]);
    expect((await convOf(t.id, PHONE)).state).not.toBe("COMPLETED");

    await runNextJob(); // final step: website + goodbye
    const texts = meta.sent.filter((b) => b.type === "text").map((b) => b.text.body);
    expect(texts.at(-2)).toBe("https://example.com/discover");
    expect(texts.at(-1)).toContain("Have a wonderful day");
    const conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("COMPLETED");
    expect(conv.website_sent).toBe(1); expect(conv.goodbye_sent).toBe(1); expect(conv.completed_at).toBeTruthy();
    expect(conv.videos_sent).toBe(3);
    const states = (await env.DB.prepare("SELECT data FROM conversation_events WHERE conversation_id = ? AND type = 'state_change' ORDER BY rowid").bind(conv.id).all<any>()).results.map((e) => JSON.parse(e.data).to);
    expect(states).toContain("WEBSITE_LINK_SENT"); expect(states).toContain("GOODBYE_SENT"); expect(states.at(-1)).toBe("COMPLETED");
  });

  it("different categories get different sequences", async () => {
    const t = await readyTenant({ videosPerCategory: 2 });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 1);
    await runNextJob();
    expect(meta.sent.find((b) => b.type === "video").video.caption).toBe("Café caption 1");
  });

  it("never sends the same video twice when the timer and the Continue button race", async () => {
    const t = await readyTenant({ videosPerCategory: 3 });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    await runNextJob();
    const timer = queued.find((q) => q.msg.type === "step")!; // pending hybrid timer for step 1
    await press(t, 1);                                         // customer presses Continue first
    // both the original timer message and the button's job are delivered by the queue
    const { handleQueueMessage } = await import("../src/queues/consumer");
    const buttonJob = queued.filter((q) => q.msg.type === "step" && q.delay === 0);
    expect(buttonJob).toHaveLength(1);
    await Promise.all([handleQueueMessage(env, timer.msg), handleQueueMessage(env, buttonJob[0].msg)]);
    expect(meta.sent.filter((b) => b.type === "video")).toHaveLength(2); // video 1 + video 2 only
    expect((await convOf(t.id, PHONE)).next_step).toBe(2);
  });

  it("ignores stale Continue buttons", async () => {
    const t = await readyTenant({ videosPerCategory: 3 });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    await runNextJob();
    await press(t, 1); await runSteps();
    const before = meta.sent.length;
    await press(t, 1);                   // old button tapped again
    expect(meta.sent.length).toBe(before);
  });
});

describe("delivery modes", () => {
  it("automatic: no Continue button, delayed job scheduled with delaySeconds", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0); await runNextJob();
    expect(meta.types).toEqual(["text", "interactive:list", "video"]);
    expect(queued.find((q) => q.msg.type === "step")!.delay).toBe(5);
    // pressing a (nonexistent) button doesn't skip anything in automatic mode; the timer drives it
    await runNextJob();
    expect(meta.sent.filter((b) => b.type === "video")).toHaveLength(2);
  });

  it("manual: waits for Continue and schedules no timer", async () => {
    const t = await readyTenant({ mode: "manual" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0); await runNextJob();
    expect(meta.types.at(-1)).toBe("interactive:button");
    expect(queued.filter((q) => q.msg.type === "step")).toHaveLength(0);
    await press(t, 1); await runSteps();
    expect(meta.sent.filter((b) => b.type === "video")).toHaveLength(2);
  });

  it("delays longer than 24h are stored in D1 and not sent to the queue", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await env.DB.prepare("UPDATE sequence_items SET delay_seconds = 172800 WHERE tenant_id = ? AND position = 1").bind(t.id).run();
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0); await runNextJob();
    expect(queued.filter((q) => q.msg.type === "step")).toHaveLength(0);
    const job = await env.DB.prepare("SELECT dispatched, status, run_at FROM scheduled_jobs WHERE tenant_id = ? AND status = 'pending'").bind(t.id).first<any>();
    expect(job.dispatched).toBe(0);
    // cron dispatches it once it is due
    await env.DB.prepare("UPDATE scheduled_jobs SET run_at = ? WHERE status = 'pending'").bind(new Date(Date.now() - 1000).toISOString()).run();
    const { runMaintenance } = await import("../src/automation/engine");
    const r = await runMaintenance(env);
    expect(r.dispatched).toBe(1);
    expect(queued.filter((q) => q.msg.type === "step")).toHaveLength(1);
  });
});

describe("category change & restart", () => {
  it("asks for confirmation, then restarts with the new sequence without double-sending", async () => {
    const t = await readyTenant({ videosPerCategory: 3 });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0); await runNextJob();
    const staleTimer = queued.find((q) => q.msg.type === "step")!.msg;
    await customerSays(t, PHONE, { reply: { id: "changecat" } });
    expect(meta.types.at(-1)).toBe("interactive:list");
    await customerSays(t, PHONE, { reply: { id: `cat:${t.catIds[1]}`, kind: "list_reply" } });
    expect(meta.sent.at(-1).interactive.type).toBe("button");
    expect(meta.sent.at(-1).interactive.action.buttons[0].reply.id).toBe(`confirmcat:${t.catIds[1]}`);
    await customerSays(t, PHONE, { reply: { id: `confirmcat:${t.catIds[1]}` } });
    // the old category's timer is still in the queue but is now stale and must be ignored
    expect(queued.some((q) => q.msg === staleTimer)).toBe(true);
    await runSteps();
    const videos = meta.sent.filter((b) => b.type === "video").map((b) => b.video.caption);
    expect(videos).toEqual(["Restaurant caption 1", "Café caption 1"]);
    expect((await convOf(t.id, PHONE)).category_id).toBe(t.catIds[1]);
  });

  it("admin restart replays the sequence from the start", async () => {
    const t = await readyTenant({ videosPerCategory: 2, mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    await runNextJob(); await runNextJob();
    let conv = await convOf(t.id, PHONE);
    expect(conv.videos_sent).toBe(2);
    const { adminAction } = await import("../src/automation/engine");
    await adminAction(env, t.id, conv.id, "restart");
    await runSteps();
    conv = await convOf(t.id, PHONE);
    expect(conv.next_step).toBe(1);
    expect(conv.videos_sent).toBe(1);
  });
});

describe("failure handling", () => {
  it("retries transient Meta failures with backoff and keeps progress", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    meta.failWhen = (c) => (c.body?.type === "video" ? { status: 503, body: { error: { message: "Service unavailable" } } } : null);
    await runNextJob();
    const retry = queued.find((q) => q.msg.type === "step")!;
    expect(retry.delay).toBe(15);
    expect((await convOf(t.id, PHONE)).next_step).toBe(0); // not advanced
    meta.failWhen = null;
    await runNextJob();
    expect((await convOf(t.id, PHONE)).next_step).toBe(1);
    expect(meta.sent.filter((b) => b.type === "video")).toHaveLength(1);
  });

  it("marks the conversation FAILED after the retry budget is spent, preserving progress, and admin retry recovers", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    meta.failWhen = (c) => (c.body?.type === "video" ? { status: 500, body: { error: { message: "boom" } } } : null);
    for (let i = 0; i < 8; i++) await runNextJob();
    let conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("FAILED");
    expect(conv.next_step).toBe(0);
    meta.failWhen = null;
    const { adminAction } = await import("../src/automation/engine");
    await adminAction(env, t.id, conv.id, "retry");
    await runSteps();
    conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("VIDEO_SEQUENCE_ACTIVE");
    expect(conv.videos_sent).toBe(1);
  });

  it("failed media upload preserves the R2 original and the customer's progress", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    meta.failWhen = (c) => (c.url.endsWith("/media") ? { status: 400, body: { error: { code: 131053, message: "Media upload error" } } } : null);
    await runNextJob();
    const conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("FAILED");
    expect(conv.next_step).toBe(0);
    const vid = t.videoIds[t.catIds[0]][0];
    expect(await env.VIDEOS.head(`tenants/${t.slug}/videos/${vid}.mp4`)).toBeTruthy();
    const mu = await env.DB.prepare("SELECT status, error FROM media_uploads WHERE video_id = ?").bind(vid).first<any>();
    expect(mu.status).toBe("failed");
  });

  it("re-uploads once when Meta says the stored media id is invalid", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    let first = true;
    meta.failWhen = (c) => (c.body?.type === "video" && first ? ((first = false), { status: 400, body: { error: { code: 131053, message: "Media expired" } } }) : null);
    await runNextJob();
    expect(meta.calls.filter((c) => c.url.endsWith("/media"))).toHaveLength(2);
    expect((await convOf(t.id, PHONE)).next_step).toBe(1);
  });

  it("an invalid token pauses (not loses) the conversation and flags the account", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0);
    meta.failWhen = () => ({ status: 401, body: { error: { code: 190, message: "Invalid OAuth access token" } } });
    await runNextJob();
    const conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("PAUSED"); expect(conv.paused_reason).toBe("token_invalid");
    const acct = await env.DB.prepare("SELECT status FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first<any>();
    expect(acct.status).toBe("token_invalid");
  });
});

describe("24-hour customer service window", () => {
  it("pauses instead of sending when the window has expired, then resumes when the customer writes again", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0); await runNextJob();
    const sentBefore = meta.sent.length;
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE tenant_id = ?").bind(new Date(Date.now() - 25 * 3600_000).toISOString(), t.id).run();
    await runNextJob(); // due timer fires after the window closed
    expect(meta.sent.length).toBe(sentBefore);        // no free-form message sent
    let conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("PAUSED"); expect(conv.paused_reason).toBe("window_expired");
    expect(conv.next_step).toBe(1);
    await customerSays(t, PHONE, { text: "I'm back" });
    conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("VIDEO_SEQUENCE_ACTIVE");
    await runNextJob();
    expect((await convOf(t.id, PHONE)).next_step).toBe(2);
  });

  it("uses the configured approved template (and only that) outside the window", async () => {
    const t = await readyTenant({ mode: "automatic" });
    await env.DB.prepare("UPDATE tenant_settings SET reopen_template_name = 'reopen_hello', reopen_template_language = 'en' WHERE tenant_id = ?").bind(t.id).run();
    await customerSays(t, PHONE, { text: "hello" });
    await pickCategory(t, 0); await runNextJob();
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE tenant_id = ?").bind(new Date(Date.now() - 30 * 3600_000).toISOString(), t.id).run();
    meta.calls.length = 0;
    await runNextJob();
    expect(meta.types).toEqual(["template"]);
    expect(meta.sent[0].template.name).toBe("reopen_hello");
    const log = await env.DB.prepare("SELECT kind FROM message_logs WHERE tenant_id = ? AND kind = 'template'").bind(t.id).first();
    expect(log).toBeTruthy();
  });
});
