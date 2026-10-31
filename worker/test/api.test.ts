import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, customerSays, installMeta, installQueue, login, meta, raw, readyTenant } from "./helpers";
import { ownerLogin } from "./owner.helpers";

beforeEach(() => { installMeta(); installQueue(); });

const mp4 = (size = 64, type = "video/mp4") => new File([new Uint8Array(size).fill(7)], "v.mp4", { type });
const form = (file: File, extra: Record<string, string> = {}) => { const f = new FormData(); f.set("file", file); f.set("title", "Intro"); for (const [k, v] of Object.entries(extra)) f.set(k, v); return f; };

describe("videos", () => {
  it("uploads to a tenant-prefixed R2 key, records hash/size, streams back with Range support", async () => {
    const t = await createTenant({ licensed: true }); const s = await login(t.slug, t.email);
    const res = await api(s, "POST", "/videos", form(mp4(100), { caption: "Hello" }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as any;
    const row = await env.DB.prepare("SELECT r2_key, sha256, size_bytes FROM videos WHERE id = ?").bind(id).first<any>();
    expect(row.r2_key).toBe(`tenants/${t.slug}/videos/${id}.mp4`);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/); expect(row.size_bytes).toBe(100);
    const full = await api(s, "GET", `/videos/${id}/stream`);
    expect(full.status).toBe(200); expect((await full.arrayBuffer()).byteLength).toBe(100);
    const part = await api(s, "GET", `/videos/${id}/stream`, undefined, { headers: { Range: "bytes=10-19" } });
    expect(part.status).toBe(206); expect(part.headers.get("content-range")).toBe("bytes 10-19/100"); expect((await part.arrayBuffer()).byteLength).toBe(10);
  });

  it("rejects unsupported formats and oversized files with useful messages", async () => {
    const t = await createTenant(); const s = await login(t.slug, t.email);
    const avi = await api(s, "POST", "/videos", form(mp4(10, "video/x-msvideo")));
    expect(avi.status).toBe(422); expect(((await avi.json()) as any).error).toMatch(/MP4/);
    const big = await api(s, "POST", "/videos", form(mp4(17 * 1024 * 1024)));
    expect(big.status).toBeGreaterThanOrEqual(413); expect(((await big.json()) as any).error).toMatch(/16 MB/);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM videos WHERE tenant_id = ?").bind(t.id).first<any>()).n).toBe(0);
  });

  it("replacing a file bumps the version and hash so Meta media is re-uploaded", async () => {
    const t = await createTenant({ licensed: true, connected: true }); const s = await login(t.slug, t.email);
    const { id } = (await (await api(s, "POST", "/videos", form(mp4(50)))).json()) as any;
    const before = await env.DB.prepare("SELECT sha256, version FROM videos WHERE id = ?").bind(id).first<any>();
    const rep = new File([new Uint8Array(60).fill(9)], "v2.mp4", { type: "video/mp4" });
    expect((await api(s, "POST", `/videos/${id}/replace`, form(rep))).status).toBe(200);
    const after = await env.DB.prepare("SELECT sha256, version, size_bytes FROM videos WHERE id = ?").bind(id).first<any>();
    expect(after.sha256).not.toBe(before.sha256); expect(after.version).toBe(before.version + 1); expect(after.size_bytes).toBe(60);
    // upload-media stores the Meta media id against (video, phone number, hash)
    expect((await api(s, "POST", `/videos/${id}/upload-media`)).status).toBe(200);
    const mu = await env.DB.prepare("SELECT media_id, sha256, phone_number_id, tenant_id FROM media_uploads WHERE video_id = ?").bind(id).first<any>();
    expect(mu.sha256).toBe(after.sha256); expect(mu.tenant_id).toBe(t.id); expect(mu.media_id).toMatch(/^media-/);
  });

  it("deleting a video removes the R2 object and its sequence items", async () => {
    const t = await readyTenant({ videosPerCategory: 2 }); const s = await login(t.slug, t.email);
    const v = t.videoIds[t.catIds[0]][0];
    expect((await api(s, "DELETE", `/videos/${v}`)).status).toBe(200);
    expect(await env.VIDEOS.head(`tenants/${t.slug}/videos/${v}.mp4`)).toBeNull();
    expect(((await (await api(s, "GET", `/sequences/${t.catIds[0]}`)).json()) as any).items).toHaveLength(1);
  });
});

describe("categories, sequences, templates", () => {
  it("creates a category with its own sequence, reorders items, bumps the sequence version, and duplicates sequences", async () => {
    const t = await readyTenant({ videosPerCategory: 3 }); const s = await login(t.slug, t.email);
    const [v1, v2, v3] = t.videoIds[t.catIds[0]];
    const put = await api(s, "PUT", `/sequences/${t.catIds[0]}`, { items: [{ video_id: v3, delay_seconds: 10 }, { video_id: v1, caption: "custom" }, { video_id: v2 }] });
    expect(put.status).toBe(200);
    const seq = (await (await api(s, "GET", `/sequences/${t.catIds[0]}`)).json()) as any;
    expect(seq.items.map((i: any) => i.video_id)).toEqual([v3, v1, v2]);
    expect(seq.items[0].delay_seconds).toBe(10); expect(seq.items[1].caption).toBe("custom"); expect(seq.sequence.version).toBe(2);
    const c = (await (await api(s, "POST", "/categories", { name: "Gym", description: "Fitness" })).json()) as any;
    expect((await api(s, "POST", `/sequences/${t.catIds[0]}/duplicate`, { to_category_id: c.id })).status).toBe(200);
    expect(((await (await api(s, "GET", `/sequences/${c.id}`)).json()) as any).items).toHaveLength(3);
    expect((await api(s, "PUT", `/sequences/${c.id}`, { items: [{ video_id: "nope" }] })).status).toBe(400);
  });

  it("templates: defaults, per-language overrides, reset; custom welcome is used by the engine", async () => {
    const t = await readyTenant(); const s = await login(t.slug, t.email);
    const list = (await (await api(s, "GET", "/templates")).json()) as any;
    expect(list.templates.find((x: any) => x.key === "goodbye").body).toBeNull();
    expect((await api(s, "PUT", "/templates", { key: "welcome", language: "en", body: "مرحبا {{business}} 🌟 Hello!" })).status).toBe(200);
    await customerSays(t, "201555000001", { text: "hi" });
    expect(meta.sent[0].text.body).toBe(`مرحبا Biz ${t.slug} 🌟 Hello!`);
    expect((await api(s, "PUT", "/templates", { key: "welcome", language: "en", body: null })).status).toBe(200);
    expect((await api(s, "PUT", "/templates", { key: "bogus", language: "en", body: "x" })).status).toBe(400);
  });

  it("settings validation", async () => {
    const t = await readyTenant(); const s = await login(t.slug, t.email);
    const cur = (await (await api(s, "GET", "/settings")).json()) as any;
    expect((await api(s, "PUT", "/settings", { ...cur, timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await api(s, "PUT", "/settings", { ...cur, website_url: "javascript:alert(1)" })).status).toBe(400);
    expect((await api(s, "PUT", "/settings", { ...cur, delivery_mode: "chaos" })).status).toBe(400);
    expect((await api(s, "PUT", "/settings", { ...cur, timezone: "Africa/Cairo", default_delay_seconds: 90 })).status).toBe(200);
  });
});

describe("WhatsApp connection & automation activation", () => {
  it("stores credentials encrypted, shows only hints, and switches automation off until verified", async () => {
    const t = await createTenant({ licensed: true }); const s = await login(t.slug, t.email);
    await env.DB.prepare("UPDATE tenant_settings SET automation_enabled = 1 WHERE tenant_id = ?").bind(t.id).run();
    const res = await api(s, "PUT", "/whatsapp", { app_id: "123", waba_id: "999", phone_number_id: "555123", access_token: "EAAB-secret-token", app_secret: "shhh", graph_version: "v24.0" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT access_token_enc, app_secret_enc, status, graph_version FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first<any>();
    expect(row.access_token_enc).not.toContain("EAAB"); expect(row.access_token_enc.startsWith("v1.")).toBe(true);
    expect(row.status).toBe("onboarding_pending"); expect(row.graph_version).toBe("v24.0");
    expect((await env.DB.prepare("SELECT automation_enabled a FROM tenant_settings WHERE tenant_id = ?").bind(t.id).first<any>()).a).toBe(0);
    const view = JSON.stringify(await (await api(s, "GET", "/whatsapp")).json());
    expect(view).not.toContain("EAAB"); expect(view).not.toContain("shhh");
    expect(view).toContain("/webhook/whatsapp");
  });

  it("verify distinguishes coexistence from plain cloud API, and never fakes success on bad tokens", async () => {
    const t = await createTenant({ licensed: true }); const s = await login(t.slug, t.email);
    await api(s, "PUT", "/whatsapp", { waba_id: "999", phone_number_id: "555124", access_token: "tok", app_secret: "sec" });
    meta.phoneInfo = { display_phone_number: "+1 555 010 0000", platform_type: "CLOUD_API", is_on_biz_app: false };
    let r = (await (await api(s, "POST", "/whatsapp/verify")).json()) as any;
    expect(r.status).toBe("connected");
    expect(r.checks.find((c: any) => c.name.startsWith("Coexistence")).ok).toBe(false);
    meta.phoneInfo = { ...meta.phoneInfo, is_on_biz_app: true };
    r = (await (await api(s, "POST", "/whatsapp/verify")).json()) as any;
    expect(r.status).toBe("coexistence_verified");
    // missing webhook subscription → incomplete
    meta.subscribed = ["messages"];
    r = (await (await api(s, "POST", "/whatsapp/verify")).json()) as any;
    expect(r.status).toBe("webhook_incomplete");
    // rejected token
    meta.failNext = [{ status: 401, body: { error: { code: 190, message: "Invalid OAuth access token." } } }];
    r = (await (await api(s, "POST", "/whatsapp/verify")).json()) as any;
    expect(r.status).toBe("token_invalid");
    expect((await env.DB.prepare("SELECT status FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first<any>()).status).toBe("token_invalid");
  });

  it("verify refuses a number that doesn't match the license registration", async () => {
    const t = await createTenant({ licensed: true }); const s = await login(t.slug, t.email);
    await env.DB.prepare("UPDATE licenses SET registered_phone = '447700900000' WHERE tenant_id = ?").bind(t.id).run();
    await api(s, "PUT", "/whatsapp", { waba_id: "999", phone_number_id: "555125", access_token: "tok", app_secret: "sec" });
    const r = (await (await api(s, "POST", "/whatsapp/verify")).json()) as any;
    expect(r.status).toBe("disconnected");
    expect(JSON.stringify(r.checks)).toContain("registered to a different WhatsApp number");
  });

  it("automation cannot be activated until license + verified connection + a playable category exist", async () => {
    const t = await createTenant(); const s = await login(t.slug, t.email);
    const blocked = await api(s, "POST", "/automation", { enabled: true });
    expect(blocked.status).toBe(409);
    const ready = await readyTenant(); const sr = await login(ready.slug, ready.email);
    await env.DB.prepare("UPDATE tenant_settings SET automation_enabled = 0 WHERE tenant_id = ?").bind(ready.id).run();
    expect((await api(sr, "POST", "/automation", { enabled: true })).status).toBe(200);
    const r = (await (await api(sr, "GET", "/readiness")).json()) as any;
    expect(r.automation_enabled).toBe(true);
    expect(r.production_ready).toBe(false); // webhook never received, media not yet uploaded → not "production ready"
    expect(r.checks.find((c: any) => c.key === "webhook").ok).toBe(false);
  });
});

describe("customers", () => {
  it("search, filter, CSV export (formula-injection safe), delete, bulk delete", async () => {
    const t = await readyTenant(); const s = await login(t.slug, t.email);
    await customerSays(t, "201700000001", { text: "hi" });
    await env.DB.prepare("UPDATE customers SET name = '=HYPERLINK(\"http://evil\")' WHERE wa_phone = '201700000001'").run();
    await customerSays(t, "201700000002", { text: "hi" });
    expect(((await (await api(s, "GET", "/customers?search=00002")).json()) as any).total).toBe(1);
    expect(((await (await api(s, "GET", "/customers?status=waiting")).json()) as any).total).toBe(2);
    const csv = await (await api(s, "GET", "/customers.csv")).text();
    expect(csv).toContain("\"'=HYPERLINK");
    const list = (await (await api(s, "GET", "/customers")).json()) as any;
    expect(list.customers[0].window).toBe("open");
    const one = list.customers[0].id;
    const profile = (await (await api(s, "GET", `/customers/${one}`)).json()) as any;
    expect(profile.events.length).toBeGreaterThan(0);
    expect((await api(s, "DELETE", `/customers/${one}`)).status).toBe(200);
    const bulk = (await (await api(s, "POST", "/customers/bulk-delete", { before: new Date(Date.now() + 86400000).toISOString() })).json()) as any;
    expect(bulk.deleted).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM message_logs WHERE tenant_id = ?").bind(t.id).first<any>()).n).toBe(0); // cascades
  });

  it("conversation timeline and admin actions work over the API; window status shows expiring/expired", async () => {
    const t = await readyTenant(); const s = await login(t.slug, t.email);
    await customerSays(t, "201700000003", { text: "hi" });
    const conv = await env.DB.prepare("SELECT id FROM conversations WHERE tenant_id = ?").bind(t.id).first<any>();
    const d = (await (await api(s, "GET", `/conversations/${conv.id}`)).json()) as any;
    expect(d.messages.map((m: any) => m.direction)).toEqual(["inbound", "outbound_auto", "outbound_auto"]);
    expect(d.conversation.window).toBe("open"); expect(d.conversation.lock_until).toBeUndefined();
    expect((await api(s, "POST", `/conversations/${conv.id}/action`, { action: "pause" })).status).toBe(200);
    expect(((await (await api(s, "GET", `/conversations/${conv.id}`)).json()) as any).conversation.state).toBe("PAUSED");
    expect((await api(s, "POST", `/conversations/${conv.id}/action`, { action: "explode" })).status).toBe(400);
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE id = ?").bind(new Date(Date.now() - 23 * 3600_000).toISOString(), conv.id).run();
    expect(((await (await api(s, "GET", `/conversations/${conv.id}`)).json()) as any).conversation.window).toBe("expiring_soon");
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE id = ?").bind(new Date(Date.now() - 25 * 3600_000).toISOString(), conv.id).run();
    expect(((await (await api(s, "GET", `/conversations/${conv.id}`)).json()) as any).conversation.window).toBe("expired");
  });

  it("analytics reports totals and does not claim video views", async () => {
    const t = await readyTenant(); const s = await login(t.slug, t.email);
    await customerSays(t, "201700000004", { text: "hi" });
    const a = (await (await api(s, "GET", "/analytics")).json()) as any;
    expect(a.totals.customers).toBe(1); expect(a.totals.started).toBe(1);
    expect(a.note).toMatch(/does not report whether a video was watched/);
    expect(a).not.toHaveProperty("views");
  });
});

describe("platform owner & PWA", () => {
  it("owner creates tenants (unique slug), sees overview without secrets, suspends and resets admin", async () => {
    const o = await ownerLogin();
    const res = await o.fetch("POST", "/tenants", { slug: "new-client", business_name: "New Client", admin_email: "boss@new.test", admin_password: "a-long-password-1" });
    expect(res.status).toBe(201);
    const made = (await res.json()) as any;
    expect(made.url).toMatch(/\/t\/new-client\/$/);
    expect((await o.fetch("POST", "/tenants", { slug: "new-client", business_name: "x", admin_email: "a@b.co", admin_password: "a-long-password-1" })).status).toBe(409);
    expect((await o.fetch("POST", "/tenants", { slug: "Bad Slug!", business_name: "x", admin_email: "a@b.co", admin_password: "a-long-password-1" })).status).toBe(400);
    expect((await o.fetch("POST", "/tenants", { slug: "owner", business_name: "x", admin_email: "a@b.co", admin_password: "a-long-password-1" })).status).toBe(400);
    expect((await o.fetch("POST", "/tenants", { slug: "weakpw", business_name: "x", admin_email: "a@b.co", admin_password: "short" })).status).toBe(400);
    const list = (await (await o.fetch("GET", "/tenants")).json()) as any;
    const row = list.tenants.find((t: any) => t.slug === "new-client");
    expect(row).toMatchObject({ status: "active", license_status: "not_activated", whatsapp_status: "not_connected" });
    // the new client can log in; then gets suspended
    const s = await login("new-client", "boss@new.test", "a-long-password-1");
    expect((await api(s, "GET", "/categories")).status).toBe(200);
    expect((await o.fetch("POST", `/tenants/${made.id}/status`, { status: "suspended" })).status).toBe(200);
    expect((await api(s, "GET", "/categories")).status).toBe(401); // sessions purged
    await o.fetch("POST", `/tenants/${made.id}/status`, { status: "active" });
    expect((await o.fetch("POST", `/tenants/${made.id}/reset-admin`, { email: "boss@new.test", password: "another-long-pass-2" })).status).toBe(200);
    await login("new-client", "boss@new.test", "another-long-pass-2");
    // audit trail exists
    expect(JSON.stringify(await (await o.fetch("GET", "/audit")).json())).toContain("tenant_created");
  });

  it("owner usage endpoint warns near free-plan limits and never claims exact Cloudflare numbers", async () => {
    const o = await ownerLogin();
    const u = (await (await o.fetch("GET", "/usage")).json()) as any;
    expect(u.note).toMatch(/estimates/); expect(u.limits.queueOpsPerDay).toBeGreaterThan(0); expect(Array.isArray(u.warnings)).toBe(true);
    const d = (await (await o.fetch("GET", "/deployment")).json()) as any;
    expect(d.secretsConfigured).toEqual({ ENCRYPTION_KEY: true, LICENSE_PUBLIC_KEY: true });
  });

  it("each tenant gets its own manifest with a unique id and scope", async () => {
    const a = await createTenant(); const b = await createTenant();
    const ma = (await (await raw(`/t/${a.slug}/manifest.webmanifest`)).json()) as any;
    const mb = (await (await raw(`/t/${b.slug}/manifest.webmanifest`)).json()) as any;
    expect(ma.id).toBe(`/t/${a.slug}/`); expect(ma.scope).toBe(`/t/${a.slug}/`); expect(ma.start_url).toBe(`/t/${a.slug}/`);
    expect(mb.id).not.toBe(ma.id); expect(mb.scope).not.toBe(ma.scope);
    expect(ma.display).toBe("standalone"); expect(ma.icons.some((i: any) => i.purpose === "maskable")).toBe(true);
    expect((await raw("/t/does-not-exist/manifest.webmanifest")).status).toBe(404);
  });

  it("serves the SPA for tenant paths, redirects bare slug, and sets security headers", async () => {
    const a = await createTenant();
    expect((await raw(`/t/${a.slug}`, { redirect: "manual" })).status).toBe(301);
    const page = await raw(`/t/${a.slug}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY"); expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await raw(`/t/nope/`)).status).toBe(404);
  });
});
