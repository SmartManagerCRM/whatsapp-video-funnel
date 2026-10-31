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
