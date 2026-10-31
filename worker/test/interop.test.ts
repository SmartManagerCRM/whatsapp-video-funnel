import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/dotnet-license.json";
import { activateLicense, getLicenseStatus, verifyToken } from "../src/licensing";
import { nowIso } from "../src/lib/util";

// The fixture was produced by the C# License Generator code (apps/license-generator tests,
// SM_FIXTURE_OUT) with a throwaway test key. This proves the .NET signer and the Worker verifier agree.
const dotnetEnv = { ...env, LICENSE_PUBLIC_KEY: fixture.publicPem } as typeof env;

describe("cross-language license compatibility (.NET signer → Worker verifier)", () => {
  it("verifies a token signed by the C# generator", async () => {
    const p = await verifyToken(dotnetEnv, fixture.token);
    expect(p).toMatchObject({ pid: "smartmanager-whatsapp-video-funnel", type: "LIFETIME", tenant_id: "tnt_interop", tenant_slug: "interop-client", max_numbers: 1 });
    expect(p.exp ?? null).toBeNull();
    expect(p.features).toEqual(["coexistence", "video-funnel"]);
  });

  it("activates for its tenant and stays valid (lifetime) with the matching key; fails with the production test key", async () => {
    await env.DB.prepare("INSERT INTO tenants (id, slug, business_name, status, created_at, updated_at) VALUES ('tnt_interop','interop-client','Interop','active',?,?)").bind(nowIso(), nowIso()).run();
    await activateLicense(dotnetEnv, { id: "tnt_interop", slug: "interop-client" }, JSON.stringify({ format: "smlic/1", token: fixture.token }), "test");
    const st = await getLicenseStatus(dotnetEnv, "tnt_interop");
    expect(st.valid).toBe(true); expect(st.license?.lifetime).toBe(true);
    // verified against a different key (the Worker test key) it must be rejected
    const other = await getLicenseStatus(env, "tnt_interop");
    expect(other.valid).toBe(false); expect(other.reason).toBe("bad_signature");
  });
});

describe("cross-language: limited license and renewal signed by the C# generator", () => {
  const f = fixture as any;
  it("Worker verifies and activates the C# LIMITED license, then accepts the C# renewal that supersedes it", async () => {
    await env.DB.prepare("INSERT INTO tenants (id, slug, business_name, status, created_at, updated_at) VALUES (?,?,?,'active',?,?)").bind(f.limited.tenantId, f.limited.tenantSlug, "Interop Ltd", nowIso(), nowIso()).run();
    const t = { id: f.limited.tenantId, slug: f.limited.tenantSlug };
    const claims = await verifyToken(dotnetEnv, f.limited.token);
    expect(claims).toMatchObject({ type: "LIMITED", tenant_id: "tnt_interop_ltd" });
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    await activateLicense(dotnetEnv, t, f.limited.token, "test");
    let st = await getLicenseStatus(dotnetEnv, t.id);
    expect(st.valid).toBe(true); expect(st.license).toMatchObject({ type: "LIMITED", lifetime: false });
    expect(st.license!.days_left).toBeGreaterThan(3000);
    // the renewal claims it renews the limited license
    expect((await verifyToken(dotnetEnv, f.renewal.token)).renews).toBe(f.limited.licenseId);
    await activateLicense(dotnetEnv, t, f.renewal.token, "test");
    st = await getLicenseStatus(dotnetEnv, t.id);
    expect(st.license?.id).toBe(f.renewal.licenseId); expect(st.license!.days_left).toBeGreaterThan(4000);
    expect((await env.DB.prepare("SELECT status FROM licenses WHERE id = ?").bind(f.limited.licenseId).first<any>()).status).toBe("transferred");
  });
});
