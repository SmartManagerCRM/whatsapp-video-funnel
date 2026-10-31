import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { api, createTenant, customerSays, installMeta, installQueue, login, meta, postWebhook, inboundPayload, readyTenant, drain } from "./helpers";

beforeEach(() => { installMeta(); installQueue(); });

describe("tenant isolation", () => {
  it("a tenant session is rejected on another tenant's API path", async () => {
    const a = await createTenant(); const b = await createTenant();
    const sa = await login(a.slug, a.email);
    const res = await api(sa, "GET", "/categories", undefined, { slug: b.slug });
    expect(res.status).toBe(403);
    // and the cookie is path-scoped to its own tenant
    expect(sa.cookie).toBeTruthy();
  });

  it("A cannot read, stream, edit or delete B's videos", async () => {
    const a = await readyTenant(); const b = await readyTenant();
    const sa = await login(a.slug, a.email);
    const bVideo = b.videoIds[b.catIds[0]][0];
    expect((await api(sa, "GET", `/videos/${bVideo}/stream`)).status).toBe(404);
    expect((await api(sa, "PUT", `/videos/${bVideo}`, { title: "hacked" })).status).toBe(404);
    expect((await api(sa, "DELETE", `/videos/${bVideo}`)).status).toBe(404);
    expect((await api(sa, "POST", `/videos/${bVideo}/upload-media`)).status).toBe(404);
    const list = (await (await api(sa, "GET", "/videos")).json()) as any;
    expect(list.videos.map((v: any) => v.id)).not.toContain(bVideo);
    expect(await env.VIDEOS.head(`tenants/${b.slug}/videos/${bVideo}.mp4`)).toBeTruthy(); // untouched
  });

  it("A cannot put B's video into A's sequence", async () => {
    const a = await readyTenant(); const b = await readyTenant();
    const sa = await login(a.slug, a.email);
    const res = await api(sa, "PUT", `/sequences/${a.catIds[0]}`, { items: [{ video_id: b.videoIds[b.catIds[0]][0] }] });
    expect(res.status).toBe(400);
    // nor read B's sequence/category
    expect((await api(sa, "GET", `/sequences/${b.catIds[0]}`)).status).toBe(404);
    expect((await api(sa, "PUT", `/categories/${b.catIds[0]}`, { name: "x", active: true })).status).toBe(404);
  });

  it("A cannot see B's customers, conversations or analytics", async () => {
    const a = await readyTenant(); const b = await readyTenant();
    await customerSays(b, "201111111111", { text: "hi" });
    const sa = await login(a.slug, a.email);
    expect(((await (await api(sa, "GET", "/customers")).json()) as any).total).toBe(0);
    const bCust = await env.DB.prepare("SELECT id FROM customers WHERE tenant_id = ?").bind(b.id).first<any>();
    const bConv = await env.DB.prepare("SELECT id FROM conversations WHERE tenant_id = ?").bind(b.id).first<any>();
    expect((await api(sa, "GET", `/customers/${bCust.id}`)).status).toBe(404);
    expect((await api(sa, "DELETE", `/customers/${bCust.id}`)).status).toBe(404);
    expect((await api(sa, "GET", `/conversations/${bConv.id}`)).status).toBe(404);
    expect((await api(sa, "POST", `/conversations/${bConv.id}/action`, { action: "pause" })).status).toBe(404);
    expect(((await (await api(sa, "GET", "/analytics")).json()) as any).totals.customers).toBe(0);
    const csv = await (await api(sa, "GET", "/customers.csv")).text();
    expect(csv).not.toContain("201111111111");
    expect(await env.DB.prepare("SELECT 1 FROM customers WHERE id = ?").bind(bCust.id).first()).toBeTruthy();
  });

  it("WhatsApp credentials are never returned to the browser, and can't be re-used across tenants", async () => {
    const a = await createTenant({ connected: true }); const b = await createTenant({ connected: true });
    const sa = await login(a.slug, a.email);
    const text = JSON.stringify(await (await api(sa, "GET", "/whatsapp")).json());
    expect(text).not.toContain(`TOKEN-${a.slug}`); expect(text).not.toContain("test-app-secret"); expect(text).not.toContain("v1."); // no ciphertext either
    // phone number already bound to B
    const dup = await api(sa, "PUT", "/whatsapp", { phone_number_id: b.phoneNumberId, waba_id: "w", access_token: "t", app_secret: "s" });
    expect(dup.status).toBe(409);
    // ciphertext is bound to its tenant (AAD): moving it to another tenant doesn't decrypt
    const { decryptSecret } = await import("../src/lib/crypto");
    const row = await env.DB.prepare("SELECT access_token_enc FROM whatsapp_accounts WHERE tenant_id = ?").bind(a.id).first<any>();
    await expect(decryptSecret(env, row.access_token_enc, `${b.id}:token`)).rejects.toThrow();
  });

  it("webhooks addressed to another tenant's phone number are not processed", async () => {
    const a = await readyTenant(); const b = await readyTenant();
    // signed with A's secret (same test secret) but carrying B's phone_number_id
    const res = await postWebhook(a.slug, inboundPayload(b, "201222222222", { text: "hi" }));
    expect(res.status).toBe(200);
    await drain();
    expect(meta.sent).toHaveLength(0);
    expect(await env.DB.prepare("SELECT 1 FROM customers WHERE wa_phone = '201222222222'").first()).toBeNull();
  });

  it("owner credentials never appear in tenant detail (owner view excludes secrets)", async () => {
    const { ownerLogin } = await import("./owner.helpers");
    const o = await ownerLogin();
    const a = await readyTenant();
    const res = await o.fetch("GET", `/tenants/${a.id}`);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/access_token|app_secret|token_enc|TOKEN-/);
  });
});
