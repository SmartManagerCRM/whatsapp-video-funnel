import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminAction, runMaintenance } from "../src/automation/engine";
import { convOf, customerSays, drain, echoPayload, inboundPayload, installMeta, installQueue, meta, postWebhook, queued, raw, readyTenant, runNextJob, runSteps, statusPayload } from "./helpers";

const PHONE = "201000000002";
beforeEach(() => { installMeta(); installQueue(); });

describe("webhook verification & security", () => {
  it("answers the GET challenge only with the right verify token", async () => {
    const t = await readyTenant();
    const ok = await raw(`/t/${t.slug}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-${t.slug}&hub.challenge=12345`);
    expect(ok.status).toBe(200); expect(await ok.text()).toBe("12345");
    const bad = await raw(`/t/${t.slug}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
    expect(bad.status).toBe(403);
    // another tenant's token doesn't work here
    const other = await readyTenant();
    expect((await raw(`/t/${t.slug}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-${other.slug}&hub.challenge=1`)).status).toBe(403);
  });

  it("rejects missing and invalid X-Hub-Signature-256 and enqueues nothing", async () => {
    const t = await readyTenant();
    const body = inboundPayload(t, PHONE, { text: "hi" });
    expect((await postWebhook(t.slug, body, { sig: null })).status).toBe(401);
    expect((await postWebhook(t.slug, body, { sig: "sha256=deadbeef" })).status).toBe(401);
    expect((await postWebhook(t.slug, body, { secret: "wrong-secret" })).status).toBe(401);
    expect(queued).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM whatsapp_webhook_events WHERE tenant_id = ?").bind(t.id).first<any>()).n).toBe(0);
  });

  it("persists the event and enqueues work instead of processing inline", async () => {
    const t = await readyTenant();
    const res = await postWebhook(t.slug, inboundPayload(t, PHONE, { text: "hi" }));
    expect(res.status).toBe(200);
    expect(meta.calls).toHaveLength(0);               // nothing sent while the request was open
    expect(queued.filter((q) => q.msg.type === "webhook_event")).toHaveLength(1);
    const ev = await env.DB.prepare("SELECT status FROM whatsapp_webhook_events WHERE tenant_id = ?").bind(t.id).first<any>();
    expect(ev.status).toBe("received");
    await drain();
    expect((await env.DB.prepare("SELECT status FROM whatsapp_webhook_events WHERE tenant_id = ?").bind(t.id).first<any>()).status).toBe("processed");
  });

  it("handles duplicate deliveries idempotently (WhatsApp message id as key)", async () => {
    const t = await readyTenant();
    const body = inboundPayload(t, PHONE, { text: "hi", id: "wamid.SAME" });
    await postWebhook(t.slug, body); await postWebhook(t.slug, body); await postWebhook(t.slug, body);
    await drain();
    expect(meta.types).toEqual(["text", "interactive:list"]); // welcome sent once
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM whatsapp_webhook_events WHERE tenant_id = ?").bind(t.id).first<any>()).n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM message_logs WHERE tenant_id = ? AND direction = 'inbound'").bind(t.id).first<any>()).n).toBe(1);
  });

  it("returns 403 for unknown tenants / unconfigured secrets", async () => {
    expect((await postWebhook("no-such-tenant", {})).status).toBe(403);
  });
});

describe("delivery statuses", () => {
  it("tracks submitted → sent → delivered → read, never downgrades, records failures", async () => {
    const t = await readyTenant();
    await customerSays(t, PHONE, { text: "hi" });
    const welcome = await env.DB.prepare("SELECT id, wa_message_id, status FROM message_logs WHERE tenant_id = ? AND kind = 'text' AND direction = 'outbound_auto'").bind(t.id).first<any>();
    expect(welcome.status).toBe("submitted");
    const status = async () => (await env.DB.prepare("SELECT status FROM message_logs WHERE id = ?").bind(welcome.id).first<any>()).status;
    const send = async (s: string, errors?: any[]) => { await postWebhook(t.slug, statusPayload(t, welcome.wa_message_id, s, PHONE, errors)); await drain(); };
    await send("sent"); expect(await status()).toBe("sent");
    await send("read"); expect(await status()).toBe("read");
    await send("delivered"); expect(await status()).toBe("read");   // late/out-of-order: no downgrade
    await send("failed", [{ code: 131026, title: "Undeliverable" }]); expect(await status()).toBe("read"); // read wins over late failure
    const second = await env.DB.prepare("SELECT id, wa_message_id FROM message_logs WHERE tenant_id = ? AND kind = 'interactive'").bind(t.id).first<any>();
    await postWebhook(t.slug, statusPayload(t, second.wa_message_id, "failed", PHONE, [{ code: 131026, title: "Undeliverable" }])); await drain();
    const f = await env.DB.prepare("SELECT status, error FROM message_logs WHERE id = ?").bind(second.id).first<any>();
    expect(f.status).toBe("failed"); expect(f.error).toContain("Undeliverable");
  });
});

describe("Coexistence: human intervention", () => {
  async function startSequence(t: any) {
    await customerSays(t, PHONE, { text: "hi" });
    await customerSays(t, PHONE, { reply: { id: `cat:${t.catIds[0]}`, kind: "list_reply" } });
    await runNextJob();
  }

  it("a reply sent from the Business app pauses automation (HUMAN_HANDLING), is logged as human, and is not treated as a customer message", async () => {
    const t = await readyTenant();
    await startSequence(t);
    const sentBefore = meta.sent.length;
    const res = await postWebhook(t.slug, echoPayload(t, PHONE, "Hi, this is Sam – happy to help!"));
    expect(res.status).toBe(200); await drain();
    const conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("HUMAN_HANDLING");
    expect(conv.resume_state).toBe("WAITING_FOR_NEXT_VIDEO");
    const human = await env.DB.prepare("SELECT direction, body FROM message_logs WHERE tenant_id = ? AND direction = 'outbound_human'").bind(t.id).first<any>();
    expect(human.body).toContain("Sam");
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM message_logs WHERE tenant_id = ? AND direction = 'inbound'").bind(t.id).first<any>()).n).toBeGreaterThan(0);
    // the pending delayed video must not be sent over the human conversation
    await runSteps();
    expect(meta.sent.length).toBe(sentBefore);
    // customer replies to the human: recorded only, no automation
    await customerSays(t, PHONE, { text: "Great, thanks" });
    expect(meta.sent.length).toBe(sentBefore);
    expect((await convOf(t.id, PHONE)).state).toBe("HUMAN_HANDLING");
  });

  it("echo of a message we sent ourselves via the API is ignored (no false handover)", async () => {
    const t = await readyTenant();
    await customerSays(t, PHONE, { text: "hi" });
    const ours = await env.DB.prepare("SELECT wa_message_id FROM message_logs WHERE tenant_id = ? AND direction = 'outbound_auto'").bind(t.id).first<any>();
    await postWebhook(t.slug, echoPayload(t, PHONE, "welcome", ours.wa_message_id)); await drain();
    expect((await convOf(t.id, PHONE)).state).toBe("WAITING_FOR_CATEGORY");
  });

  it("administrator can resume; the sequence continues from where it paused", async () => {
    const t = await readyTenant();
    await startSequence(t);
    await postWebhook(t.slug, echoPayload(t, PHONE)); await drain();
    const conv = await convOf(t.id, PHONE);
    await adminAction(env, t.id, conv.id, "resume");
    await runSteps();
    const after = await convOf(t.id, PHONE);
    expect(after.state).not.toBe("HUMAN_HANDLING");
    expect(after.videos_sent).toBe(2);
    expect(meta.sent.filter((b) => b.type === "video")).toHaveLength(2);
  });

  it("handover timeout resumes automation via the maintenance cron", async () => {
    const t = await readyTenant();
    await env.DB.prepare("UPDATE tenant_settings SET handover_timeout_minutes = 30 WHERE tenant_id = ?").bind(t.id).run();
    await startSequence(t);
    await postWebhook(t.slug, echoPayload(t, PHONE)); await drain();
    let conv = await convOf(t.id, PHONE);
    expect(conv.human_handling_until).toBeTruthy();
    expect((await runMaintenance(env)).resumed).toBe(0); // not yet
    await env.DB.prepare("UPDATE conversations SET human_handling_until = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), conv.id).run();
    expect((await runMaintenance(env)).resumed).toBe(1);
    await runSteps();
    conv = await convOf(t.id, PHONE);
    expect(conv.state).not.toBe("HUMAN_HANDLING");
  });

  it("handover can be disabled in settings (echoes are then only logged)", async () => {
    const t = await readyTenant();
    await env.DB.prepare("UPDATE tenant_settings SET handover_enabled = 0 WHERE tenant_id = ?").bind(t.id).run();
    await startSequence(t);
    await postWebhook(t.slug, echoPayload(t, PHONE)); await drain();
    expect((await convOf(t.id, PHONE)).state).not.toBe("HUMAN_HANDLING");
  });

  it("contact sync events store customer names without starting automation", async () => {
    const t = await readyTenant();
    await postWebhook(t.slug, { object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ field: "smb_app_state_sync", value: { metadata: { phone_number_id: t.phoneNumberId }, state_sync: [{ type: "contact", action: "add", contact: { full_name: "Bob Builder", phone_number: "+20 100 999 0000" } }] } }] }] });
    await drain();
    const c = await env.DB.prepare("SELECT name FROM customers WHERE tenant_id = ? AND wa_phone = '201009990000'").bind(t.id).first<any>();
    expect(c.name).toBe("Bob Builder");
    expect(meta.sent).toHaveLength(0);
  });

  it("account_update disconnect events flag the connection as disconnected", async () => {
    const t = await readyTenant();
    await postWebhook(t.slug, { object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ field: "account_update", value: { event: "PARTNER_REMOVED", metadata: { phone_number_id: t.phoneNumberId } } }] }] });
    await drain();
    expect((await env.DB.prepare("SELECT status FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first<any>()).status).toBe("disconnected");
  });
});

describe("opt-out", () => {
  it("STOP stops automation immediately, cancels pending jobs, and nothing restarts without an explicit opt-in", async () => {
    const t = await readyTenant();
    await customerSays(t, PHONE, { text: "hi" });
    await customerSays(t, PHONE, { reply: { id: `cat:${t.catIds[0]}`, kind: "list_reply" } });
    await runNextJob();
    const videosBefore = meta.sent.filter((b) => b.type === "video").length;
    await customerSays(t, PHONE, { text: " stop " });
    const conv = await convOf(t.id, PHONE);
    expect(conv.state).toBe("OPTED_OUT");
    expect((await env.DB.prepare("SELECT opted_out, status FROM customers WHERE tenant_id = ?").bind(t.id).first<any>())).toEqual({ opted_out: 1, status: "opted_out" });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM scheduled_jobs WHERE conversation_id = ? AND status = 'pending'").bind(conv.id).first<any>()).n).toBe(0);
    await runSteps(); // stale timers are ignored
    expect(meta.sent.filter((b) => b.type === "video")).toHaveLength(videosBefore);
    // a plain message does not restart anything
    const n = meta.sent.length;
    await customerSays(t, PHONE, { text: "hello again" });
    expect(meta.sent.length).toBe(n);
    expect((await convOf(t.id, PHONE)).state).toBe("OPTED_OUT");
    // explicit opt-in starts a fresh presentation
    await customerSays(t, PHONE, { text: "START" });
    expect((await convOf(t.id, PHONE)).state).toBe("WAITING_FOR_CATEGORY");
    expect((await env.DB.prepare("SELECT opted_out FROM customers WHERE tenant_id = ?").bind(t.id).first<any>()).opted_out).toBe(0);
  });

  it("recognises configured Arabic and French keywords", async () => {
    const t = await readyTenant();
    await customerSays(t, "201000000010", { text: "hi" });
    await customerSays(t, "201000000010", { text: "arrêter" });
    expect((await convOf(t.id, "201000000010")).state).toBe("OPTED_OUT");
    await customerSays(t, "201000000011", { text: "hi" });
    await customerSays(t, "201000000011", { text: "توقف" });
    expect((await convOf(t.id, "201000000011")).state).toBe("OPTED_OUT");
  });

  it("a completed customer who writes again gets a fresh presentation", async () => {
    const t = await readyTenant({ videosPerCategory: 1, mode: "automatic" });
    await customerSays(t, PHONE, { text: "hi" });
    await customerSays(t, PHONE, { reply: { id: `cat:${t.catIds[0]}`, kind: "list_reply" } });
    await runSteps(); await runSteps();
    expect((await convOf(t.id, PHONE)).state).toBe("COMPLETED");
    await customerSays(t, PHONE, { text: "hello again" });
    expect((await convOf(t.id, PHONE)).state).toBe("WAITING_FOR_CATEGORY");
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM conversations WHERE tenant_id = ?").bind(t.id).first<any>()).n).toBe(2);
  });
});
