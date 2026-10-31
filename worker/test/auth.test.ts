import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PASSWORD, api, createTenant, login, raw } from "./helpers";

const post = (slug: string, body: unknown) => raw(`/t/${slug}/api/auth/login`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("authentication", () => {
  it("logs in with correct credentials and sets a hardened cookie", async () => {
    const t = await createTenant();
    const res = await post(t.slug, { email: t.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict"); expect(cookie).toContain(`Path=/t/${t.slug}`);
    expect(JSON.stringify(await res.json())).not.toContain("password");
  });

  it("rejects an incorrect password and an unknown user with the same message", async () => {
    const t = await createTenant();
    const bad = await post(t.slug, { email: t.email, password: "wrong-password-1" });
    const unknown = await post(t.slug, { email: "nobody@x.test", password: "wrong-password-1" });
    expect(bad.status).toBe(401); expect(unknown.status).toBe(401);
    expect(((await bad.json()) as any).error).toBe(((await unknown.json()) as any).error);
  });

  it("rate limits repeated failures", async () => {
    const t = await createTenant();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post(t.slug, { email: t.email, password: "nope-nope-nope" })).status);
    expect(codes.slice(0, 6).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    // even the right password is blocked while locked out
    expect((await post(t.slug, { email: t.email, password: PASSWORD })).status).toBe(429);
  });

  it("requires authentication for API routes", async () => {
    const t = await createTenant();
    expect((await raw(`/t/${t.slug}/api/categories`)).status).toBe(401);
    expect((await raw(`/owner/api/tenants`)).status).toBe(401);
  });

  it("expires sessions", async () => {
    const t = await createTenant();
    const s = await login(t.slug, t.email);
    expect((await api(s, "GET", "/categories")).status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await api(s, "GET", "/categories")).status).toBe(401);
  });

  it("logout invalidates the session server-side", async () => {
    const t = await createTenant();
    const s = await login(t.slug, t.email);
    expect((await api(s, "POST", "/auth/logout")).status).toBe(200);
    expect((await api(s, "GET", "/categories")).status).toBe(401);
  });

  it("enforces CSRF tokens and same-origin on mutating requests", async () => {
    const t = await createTenant();
    const s = await login(t.slug, t.email);
    const noCsrf = await raw(`/t/${t.slug}/api/categories`, { method: "POST", headers: { Cookie: s.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "X" }) });
    expect(noCsrf.status).toBe(403);
    const evil = await api(s, "POST", "/categories", { name: "X" }, { headers: { Origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect((await api(s, "POST", "/categories", { name: "Ok" })).status).toBe(201);
  });

  it("suspended tenants cannot log in or use existing sessions", async () => {
    const t = await createTenant();
    const s = await login(t.slug, t.email);
    await env.DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(t.id).run();
    expect((await api(s, "GET", "/categories")).status).toBe(403);
    expect((await post(t.slug, { email: t.email, password: PASSWORD })).status).toBe(403);
  });

  it("hashes passwords (PBKDF2) and never stores plaintext", async () => {
    const t = await createTenant();
    const u = await env.DB.prepare("SELECT password_hash FROM tenant_users WHERE tenant_id = ?").bind(t.id).first<any>();
    expect(u.password_hash.startsWith("pbkdf2$")).toBe(true);
    expect(u.password_hash).not.toContain(PASSWORD);
  });
});

describe("platform owner", () => {
  it("bootstraps once with the secret token, then logs in; tenant sessions cannot reach owner APIs", async () => {
    const bad = await raw("/owner/api/auth/bootstrap", { method: "POST", body: JSON.stringify({ token: "nope", email: "o@x.test", password: "a-very-long-password" }) });
    expect(bad.status).toBe(403);
    const ok = await raw("/owner/api/auth/bootstrap", { method: "POST", body: JSON.stringify({ token: "test-bootstrap-token", email: "o@x.test", password: "a-very-long-password" }) });
    expect(ok.status).toBe(200);
    const again = await raw("/owner/api/auth/bootstrap", { method: "POST", body: JSON.stringify({ token: "test-bootstrap-token", email: "o2@x.test", password: "a-very-long-password" }) });
    expect(again.status).toBe(409);
    const t = await createTenant();
    const s = await login(t.slug, t.email);
    const res = await raw("/owner/api/tenants", { headers: { Cookie: s.cookie } });
    expect(res.status).toBe(401);
  });
});
