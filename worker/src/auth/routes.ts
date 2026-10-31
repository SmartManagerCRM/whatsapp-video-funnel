import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { clearRateLimit, clientIp, createSession, destroySession, rateLimit, requireOwnerSession, requireTenantSession, sessionCookie, SESSION_COOKIE, audit, type AppEnv } from "./session";
import { dummyVerify, hashIterations, hashPassword, verifyPassword } from "../lib/crypto";
import { HttpError, nowIso, timingSafeEqual } from "../lib/util";
import type { TenantRow } from "../env";

export const MIN_PASSWORD = 10;
export function assertStrongPassword(p: unknown): string {
  if (typeof p !== "string" || p.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  if (p.length > 200) throw new HttpError(400, "Password is too long");
  return p;
}

async function readJson(c: { req: { json: () => Promise<any> } }): Promise<any> {
  try { return await c.req.json(); } catch { throw new HttpError(400, "Invalid JSON body"); }
}

// ---------------------------------------------------------------- tenant auth
export const tenantAuth = new Hono<AppEnv>();

tenantAuth.post("/login", async (c) => {
  const slug = c.req.param("slug") as string;
  const body = await readJson(c);
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const ipBucket = `login-ip:${slug}:${clientIp(c)}`;
  const userBucket = `login-user:${slug}:${email}`;
  if (!(await rateLimit(c.env, ipBucket, 20, 900)) || !(await rateLimit(c.env, userBucket, 6, 900))) {
    throw new HttpError(429, "Too many login attempts. Try again in a few minutes.", "rate_limited");
  }
  const tenant = await c.env.DB.prepare("SELECT id, slug, business_name, status FROM tenants WHERE slug = ?").bind(slug).first<TenantRow>();
  const user = tenant ? await c.env.DB.prepare("SELECT id, password_hash, role, disabled FROM tenant_users WHERE tenant_id = ? AND email = ?").bind(tenant.id, email).first<{
    id: string; password_hash: string; role: string; disabled: number;
  }>() : null;
  if (!user || !tenant) { await dummyVerify(); throw new HttpError(401, "Incorrect email or password", "bad_credentials"); }
  if (!(await verifyPassword(password, user.password_hash)) || user.disabled) throw new HttpError(401, "Incorrect email or password", "bad_credentials");
  if (tenant.status === "suspended") throw new HttpError(403, "This account is suspended. Please contact SmartManager.", "tenant_suspended");
  await clearRateLimit(c.env, userBucket);
  const { token, csrf } = await createSession(c.env, "tenant", user.id, tenant.id);
  await audit(c.env, tenant.id, "tenant_user", user.id, "login");
  c.header("Set-Cookie", sessionCookie(c.env, token, `/t/${slug}`));
  return c.json({ ok: true, csrf, user: { email, role: user.role }, tenant: { slug, name: tenant.business_name } });
});

tenantAuth.post("/logout", async (c) => {
  await destroySession(c.env, getCookie(c, SESSION_COOKIE));
  c.header("Set-Cookie", sessionCookie(c.env, "", `/t/${c.req.param("slug")}`, 0));
  return c.json({ ok: true });
});

tenantAuth.get("/me", requireTenantSession, (c) => {
  const s = c.get("session"); const t = c.get("tenant");
  return c.json({ csrf: s.csrf, user: { email: s.email, role: s.role }, tenant: { id: t.id, slug: t.slug, name: t.business_name } });
});

tenantAuth.post("/password", requireTenantSession, async (c) => {
  const s = c.get("session");
  const { current, next } = await readJson(c);
  const row = await c.env.DB.prepare("SELECT password_hash FROM tenant_users WHERE id = ?").bind(s.userId).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(String(current ?? ""), row.password_hash))) throw new HttpError(403, "Current password is incorrect");
  await c.env.DB.prepare("UPDATE tenant_users SET password_hash = ? WHERE id = ?").bind(await hashPassword(assertStrongPassword(next), hashIterations(c.env)), s.userId).run();
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'tenant' AND csrf_token != ?").bind(s.userId, s.csrf).run();
  await audit(c.env, s.tenantId, "tenant_user", s.userId, "password_changed");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- owner auth
export const ownerAuth = new Hono<AppEnv>();

/** One-time creation of the first platform owner, authorised by the OWNER_BOOTSTRAP_TOKEN secret. */
ownerAuth.post("/bootstrap", async (c) => {
  const secret = c.env.OWNER_BOOTSTRAP_TOKEN;
  if (!secret) throw new HttpError(404, "Not found");
  if (!(await rateLimit(c.env, `bootstrap:${clientIp(c)}`, 5, 900))) throw new HttpError(429, "Too many attempts");
  const body = await readJson(c);
  if (!timingSafeEqual(String(body.token ?? ""), secret)) throw new HttpError(403, "Invalid bootstrap token");
  const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM platform_owners").first<{ n: number }>();
  if (existing && existing.n > 0) throw new HttpError(409, "A platform owner already exists");
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Valid email required");
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO platform_owners (id, email, password_hash, created_at) VALUES (?,?,?,?)")
    .bind(id, email, await hashPassword(assertStrongPassword(body.password), hashIterations(c.env)), nowIso()).run();
  await audit(c.env, null, "owner", id, "owner_bootstrapped");
  return c.json({ ok: true });
});

ownerAuth.post("/login", async (c) => {
  const body = await readJson(c);
  const email = String(body.email ?? "").trim().toLowerCase();
  const ipBucket = `owner-login-ip:${clientIp(c)}`; const userBucket = `owner-login-user:${email}`;
  if (!(await rateLimit(c.env, ipBucket, 20, 900)) || !(await rateLimit(c.env, userBucket, 6, 900))) throw new HttpError(429, "Too many login attempts", "rate_limited");
  const owner = await c.env.DB.prepare("SELECT id, password_hash FROM platform_owners WHERE email = ?").bind(email).first<{ id: string; password_hash: string }>();
  if (!owner) { await dummyVerify(); throw new HttpError(401, "Incorrect email or password", "bad_credentials"); }
  if (!(await verifyPassword(String(body.password ?? ""), owner.password_hash))) throw new HttpError(401, "Incorrect email or password", "bad_credentials");
  await clearRateLimit(c.env, userBucket);
  const { token, csrf } = await createSession(c.env, "owner", owner.id, null);
  await audit(c.env, null, "owner", owner.id, "login");
  c.header("Set-Cookie", sessionCookie(c.env, token, "/owner"));
  return c.json({ ok: true, csrf, user: { email } });
});

ownerAuth.post("/logout", async (c) => {
  await destroySession(c.env, getCookie(c, SESSION_COOKIE));
  c.header("Set-Cookie", sessionCookie(c.env, "", "/owner", 0));
  return c.json({ ok: true });
});

ownerAuth.get("/me", requireOwnerSession, (c) => c.json({ csrf: c.get("session").csrf, user: { email: c.get("session").email } }));
