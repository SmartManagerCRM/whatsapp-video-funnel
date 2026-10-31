import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { activateLicense, getLicenseStatus, LicenseError, revokeLicense, approveTransfer } from "../src/licensing";
import { api, createTenant, licensePayload, login, signLicense } from "./helpers";
import { ownerLogin } from "./owner.helpers";

const reason = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof LicenseError ? e.reason : `other:${(e as Error).message}`; } };

describe("lifetime licensing", () => {
  it("activates a valid lifetime license that never expires", async () => {
    const t = await createTenant();
    await activateLicense(env, t, await signLicense(licensePayload(t)), "test");
    const st = await getLicenseStatus(env, t.id);
    expect(st.valid).toBe(true);
    expect(st.license?.lifetime).toBe(true);
    expect(st.license?.expires_at).toBeNull();
    // far in the future: still valid (no expiry logic)
    const row = await env.DB.prepare("SELECT expires_at FROM licenses WHERE tenant_id = ?").bind(t.id).first<any>();
    expect(row.expires_at).toBeNull();
  });

  it("accepts the .smlic JSON file format as well as a raw token", async () => {
    const t = await createTenant();
    const token = await signLicense(licensePayload(t));
    await activateLicense(env, t, JSON.stringify({ format: "smlic/1", token }), "test");
    expect((await getLicenseStatus(env, t.id)).valid).toBe(true);
  });

  it("rejects a tampered payload (invalid signature)", async () => {
    const t = await createTenant();
    const token = await signLicense(licensePayload(t, { max_numbers: 1 }));
    const [h, p, s] = token.split(".");
    const forged = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    forged.max_numbers = 99;
    const p2 = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await reason(activateLicense(env, t, `${h}.${p2}.${s}`, "x"))).toBe("bad_signature");
  });

  it("rejects a license signed with a different (wrong) private key", async () => {
    const t = await createTenant();
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", other.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`;
    const token = await signLicense(licensePayload(t), { privatePem: pem });
    expect(await reason(activateLicense(env, t, token, "x"))).toBe("bad_signature");
  });

  it("rejects wrong tenant, wrong slug and wrong product", async () => {
    const a = await createTenant(); const b = await createTenant();
    expect(await reason(activateLicense(env, b, await signLicense(licensePayload(a)), "x"))).toBe("wrong_tenant");
    expect(await reason(activateLicense(env, a, await signLicense(licensePayload(a, { tenant_slug: "other" })), "x"))).toBe("wrong_tenant");
    expect(await reason(activateLicense(env, a, await signLicense(licensePayload(a, { pid: "some-other-product" })), "x"))).toBe("wrong_product");
  });

  it("rejects unsupported types and explicitly expired licenses, and malformed input", async () => {
    const t = await createTenant();
    expect(await reason(activateLicense(env, t, await signLicense(licensePayload(t, { type: "ANNUAL" })), "x"))).toBe("unsupported_type");
    expect(await reason(activateLicense(env, t, await signLicense(licensePayload(t, { exp: Math.floor(Date.now() / 1000) - 10 })), "x"))).toBe("expired");
    expect(await reason(activateLicense(env, t, "not-a-token", "x"))).toBe("malformed");
    expect(await reason(activateLicense(env, t, "{\"nope\":1}", "x"))).toBe("malformed");
  });

  it("rejects duplicate activation by another tenant and is idempotent for the same tenant", async () => {
    const a = await createTenant({ licensed: false });
    const token = await signLicense(licensePayload(a, { lid: "lic_dup" }));
    await activateLicense(env, a, token, "x");
    await activateLicense(env, a, token, "x"); // idempotent
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM licenses WHERE id = 'lic_dup'").first<any>()).n).toBe(1);
    // an attacker tenant tries the same token
    const b = await createTenant();
    expect(await reason(activateLicense(env, b, token, "x"))).toBe("wrong_tenant"); // tenant-bound
    // even if a second tenant had a token with a re-used license id, it's refused
    await env.DB.prepare("UPDATE licenses SET tenant_id = ? WHERE id = 'lic_dup'").bind(a.id).run();
    expect(await reason(activateLicense(env, b, await signLicense(licensePayload(b, { lid: "lic_dup" })), "x"))).toBe("already_used");
  });

  it("revoked licenses stop validating and cannot be re-activated", async () => {
    const t = await createTenant();
    const token = await signLicense(licensePayload(t, { lid: "lic_rev" }));
    await activateLicense(env, t, token, "x");
    await revokeLicense(env, "lic_rev", "owner");
    const st = await getLicenseStatus(env, t.id);
    expect(st.valid).toBe(false); expect(st.reason).toBe("revoked");
    expect(await reason(activateLicense(env, t, token, "x"))).toBe("revoked");
  });

  it("grace mechanism keeps a license usable if the verification key is misconfigured, but never overrides revocation", async () => {
    const t = await createTenant({ licensed: true });
    const broken = { ...env, LICENSE_PUBLIC_KEY: "garbage" } as typeof env;
    const st = await getLicenseStatus(broken, t.id);
    expect(st.valid).toBe(true); expect(st.grace).toBe(true);
    await env.DB.prepare("UPDATE licenses SET status = 'revoked' WHERE tenant_id = ?").bind(t.id).run();
    expect((await getLicenseStatus(broken, t.id)).valid).toBe(false);
    // and a license that was never verified gets no grace
    const t2 = await createTenant({ licensed: true });
    await env.DB.prepare("UPDATE licenses SET last_verified_at = NULL WHERE tenant_id = ?").bind(t2.id).run();
    expect((await getLicenseStatus(broken, t2.id)).valid).toBe(false);
  });

  it("transfer requires owner approval: approved → new token for the new tenant activates, old one is dead", async () => {
    const a = await createTenant(); const b = await createTenant();
    await activateLicense(env, a, await signLicense(licensePayload(a, { lid: "lic_old" })), "x");
    const newToken = await signLicense(licensePayload(b, { lid: "lic_new", transfer_from: "lic_old" }));
    expect(await reason(activateLicense(env, b, newToken, "x"))).toBe("transfer_not_approved");
    await approveTransfer(env, "lic_old", b.id, "owner");
    await activateLicense(env, b, newToken, "x");
    expect((await getLicenseStatus(env, b.id)).valid).toBe(true);
    expect((await getLicenseStatus(env, a.id)).valid).toBe(false);
    // approval is destination-specific
    const c = await createTenant();
    expect(await reason(activateLicense(env, c, await signLicense(licensePayload(c, { lid: "lic_c", transfer_from: "lic_old" })), "x"))).toBe("transfer_not_approved");
  });

  it("WhatsApp number is bound to the license; changing it needs owner approval", async () => {
    const { bindPhoneToLicense, resetRegisteredPhone } = await import("../src/licensing");
    const t = await createTenant({ licensed: true });
    await bindPhoneToLicense(env, t.id, "+1 555 010 0000");
    await bindPhoneToLicense(env, t.id, "15550100000"); // same number
    await expect(bindPhoneToLicense(env, t.id, "+44 20 7946 0000")).rejects.toThrow(/registered to a different WhatsApp number/);
    const lic = await env.DB.prepare("SELECT id FROM licenses WHERE tenant_id = ?").bind(t.id).first<any>();
    await resetRegisteredPhone(env, lic.id, "owner");
    await bindPhoneToLicense(env, t.id, "+44 20 7946 0000");
  });

  it("activation endpoint: tenant admin activates via API; bad license returns a clear error", async () => {
    const t = await createTenant();
    const s = await login(t.slug, t.email);
    const bad = await api(s, "POST", "/license/activate", { license: "x.y.z" });
    expect(bad.status).toBe(403);
    const ok = await api(s, "POST", "/license/activate", { license: await signLicense(licensePayload(t)) });
    expect(ok.status).toBe(200);
    const view = (await (await api(s, "GET", "/license")).json()) as any;
    expect(view.valid).toBe(true);
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    expect(JSON.stringify(view)).not.toContain("token");
  });

  it("owner can revoke, suspend/reinstate and approve transfers over the API", async () => {
    const o = await ownerLogin();
    const t = await createTenant({ licensed: true });
    const lic = await env.DB.prepare("SELECT id FROM licenses WHERE tenant_id = ?").bind(t.id).first<any>();
    expect((await o.fetch("POST", `/licenses/${lic.id}/suspend`)).status).toBe(200);
    expect((await getLicenseStatus(env, t.id)).reason).toBe("suspended");
    expect((await o.fetch("POST", `/licenses/${lic.id}/reinstate`)).status).toBe(200);
    expect((await getLicenseStatus(env, t.id)).valid).toBe(true);
    expect((await o.fetch("POST", `/licenses/${lic.id}/revoke`)).status).toBe(200);
    expect((await o.fetch("POST", `/licenses/${lic.id}/reinstate`)).status).toBe(409); // revoked is final
  });
});

describe("limited-time licenses", () => {
  const inDays = (d: number) => Math.floor((Date.now() + d * 86_400_000) / 1000);

  it("activates a LIMITED license with a future expiry and reports days left", async () => {
    const t = await createTenant();
    await activateLicense(env, t, await signLicense(licensePayload(t, { type: "LIMITED", exp: inDays(90) })), "x");
    const st = await getLicenseStatus(env, t.id);
    expect(st.valid).toBe(true);
    expect(st.license).toMatchObject({ type: "LIMITED", lifetime: false, expiring_soon: false });
    expect(st.license!.days_left).toBeGreaterThanOrEqual(89);
    const soon = await createTenant();
    await activateLicense(env, soon, await signLicense(licensePayload(soon, { type: "LIMITED", exp: inDays(10) })), "x");
    expect((await getLicenseStatus(env, soon.id)).license?.expiring_soon).toBe(true);
  });

  it("rejects LIMITED without an expiry and LIMITED already expired", async () => {
    const t = await createTenant();
    expect(await reason(activateLicense(env, t, await signLicense(licensePayload(t, { type: "LIMITED" })), "x"))).toBe("malformed");
    expect(await reason(activateLicense(env, t, await signLicense(licensePayload(t, { type: "LIMITED", exp: inDays(-1) })), "x"))).toBe("expired");
  });

  it("stops validating after the expiry date and switches automation off", async () => {
    const t = await createTenant();
    await activateLicense(env, t, await signLicense(licensePayload(t, { type: "LIMITED", exp: inDays(5) })), "x");
    expect((await getLicenseStatus(env, t.id)).valid).toBe(true);
    await env.DB.prepare("UPDATE licenses SET expires_at = ? WHERE tenant_id = ?").bind(new Date(Date.now() - 1000).toISOString(), t.id).run();
    const st = await getLicenseStatus(env, t.id);
    expect(st.valid).toBe(false); expect(st.reason).toBe("expired");
    // the grace mechanism never revives an expired license
    const broken = { ...env, LICENSE_PUBLIC_KEY: "garbage" } as typeof env;
    expect((await getLicenseStatus(broken, t.id)).valid).toBe(false);
  });

  it("an expired license pauses the bot and resumes after renewal when the customer writes again", async () => {
    const { readyTenant, customerSays, installMeta, installQueue, meta, convOf } = await import("./helpers");
    installMeta(); installQueue();
    const t = await readyTenant();
    const lic = await env.DB.prepare("SELECT id FROM licenses WHERE tenant_id = ?").bind(t.id).first<any>();
    await env.DB.prepare("UPDATE licenses SET license_type = 'LIMITED', expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), lic.id).run();
    await customerSays(t, "201333000001", { text: "hi" });
    expect(meta.sent).toHaveLength(0);                      // expired: nothing is sent
    // renewal: new token that renews the limited license
    await activateLicense(env, t, await signLicense(licensePayload(t, { type: "LIMITED", exp: inDays(365), renews: lic.id })), "x");
    await customerSays(t, "201333000001", { text: "hello again" });
    expect(meta.types).toEqual(["text", "interactive:list"]); // bot works again
    expect((await convOf(t.id, "201333000001")).state).toBe("WAITING_FOR_CATEGORY");
  });

  it("renewal extends a LIMITED license; the old one is superseded (not revocable by mistake)", async () => {
    const t = await createTenant();
    await activateLicense(env, t, await signLicense(licensePayload(t, { lid: "lic_ltd1", type: "LIMITED", exp: inDays(20) })), "x");
    // without `renews`, a second license is refused
    expect(await reason(activateLicense(env, t, await signLicense(licensePayload(t, { lid: "lic_ltd2", type: "LIMITED", exp: inDays(400) })), "x"))).toBe("already_used");
    await activateLicense(env, t, await signLicense(licensePayload(t, { lid: "lic_ltd3", type: "LIMITED", exp: inDays(400), renews: "lic_ltd1" })), "x");
    const st = await getLicenseStatus(env, t.id);
    expect(st.license?.id).toBe("lic_ltd3"); expect(st.license!.days_left).toBeGreaterThan(390);
    expect((await env.DB.prepare("SELECT status FROM licenses WHERE id = 'lic_ltd1'").first<any>()).status).toBe("transferred");
    const ev = await env.DB.prepare("SELECT detail FROM license_events WHERE license_id = 'lic_ltd1' AND event = 'superseded_by'").first<any>();
    expect(ev.detail).toBe("lic_ltd3");
  });

  it("a LIMITED license can be upgraded to LIFETIME, but LIFETIME cannot be 'renewed'", async () => {
    const t = await createTenant();
    await activateLicense(env, t, await signLicense(licensePayload(t, { lid: "lic_up1", type: "LIMITED", exp: inDays(30) })), "x");
    await activateLicense(env, t, await signLicense(licensePayload(t, { lid: "lic_up2", type: "LIFETIME", renews: "lic_up1" })), "x");
    const st = await getLicenseStatus(env, t.id);
    expect(st.license).toMatchObject({ id: "lic_up2", type: "LIFETIME", lifetime: true, days_left: null });
    expect(await reason(activateLicense(env, t, await signLicense(licensePayload(t, { lid: "lic_up3", type: "LIMITED", exp: inDays(30), renews: "lic_up2" })), "x"))).toBe("malformed");
  });

  it("renewal is refused for another tenant's license, unknown ids, revoked and suspended licenses", async () => {
    const a = await createTenant(); const b = await createTenant();
    await activateLicense(env, a, await signLicense(licensePayload(a, { lid: "lic_ra", type: "LIMITED", exp: inDays(30) })), "x");
    expect(await reason(activateLicense(env, b, await signLicense(licensePayload(b, { lid: "lic_rb", type: "LIMITED", exp: inDays(30), renews: "lic_ra" })), "x"))).toBe("malformed");
    expect(await reason(activateLicense(env, b, await signLicense(licensePayload(b, { lid: "lic_rc", type: "LIMITED", exp: inDays(30), renews: "lic_nope" })), "x"))).toBe("malformed");
    await env.DB.prepare("UPDATE licenses SET status = 'suspended' WHERE id = 'lic_ra'").run();
    expect(await reason(activateLicense(env, a, await signLicense(licensePayload(a, { lid: "lic_rd", type: "LIMITED", exp: inDays(60), renews: "lic_ra" })), "x"))).toBe("suspended");
    await env.DB.prepare("UPDATE licenses SET status = 'revoked' WHERE id = 'lic_ra'").run();
    expect(await reason(activateLicense(env, a, await signLicense(licensePayload(a, { lid: "lic_re", type: "LIMITED", exp: inDays(60), renews: "lic_ra" })), "x"))).toBe("revoked");
  });

  it("the tenant license endpoint shows expiry details; owner list includes them", async () => {
    const t = await createTenant();
    const s = await login(t.slug, t.email);
    await api(s, "POST", "/license/activate", { license: await signLicense(licensePayload(t, { type: "LIMITED", exp: inDays(15) })) });
    const v = (await (await api(s, "GET", "/license")).json()) as any;
    expect(v.license).toMatchObject({ type: "LIMITED", lifetime: false, expiring_soon: true });
    const ds = (await (await api(s, "GET", "/dashboard-status")).json()) as any;
    expect(ds.license).toMatchObject({ valid: true, type: "LIMITED", expiring_soon: true });
    const o = await ownerLogin();
    const list = (await (await o.fetch("GET", "/licenses")).json()) as any;
    expect(list.licenses.find((l: any) => l.tenant_id === t.id).expires_at).toBeTruthy();
  });
});
