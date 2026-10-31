import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, TenantRow } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { HttpError, nowIso } from "../lib/util";

export const SESSION_COOKIE = "sm_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface SessionInfo {
  kind: "tenant" | "owner";
  userId: string;
  tenantId: string | null;
  role: string;
  csrf: string;
  email: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { tenant: TenantRow; session: SessionInfo };
};

export async function createSession(env: Env, kind: "tenant" | "owner", userId: string, tenantId: string | null) {
  const token = randomToken(32);
  const csrf = randomToken(16);
  const now = new Date();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, kind, user_id, tenant_id, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(await sha256Hex(token), kind, userId, tenantId, csrf, now.toISOString(), new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString()).run();
  return { token, csrf };
}

export function sessionCookie(env: Env, token: string, path: string, maxAge = SESSION_TTL_SECONDS) {
  const secure = env.COOKIE_SECURE !== "false" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export async function destroySession(env: Env, token: string | undefined) {
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
}

/** Fixed-window rate limiter backed by D1. Returns true if the call is allowed. */
export async function rateLimit(env: Env, bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
  const nowS = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT count, window_start FROM rate_limits WHERE bucket = ?").bind(bucket).first<{ count: number; window_start: number }>();
  if (!row || nowS - row.window_start >= windowSeconds) {
    await env.DB.prepare("INSERT INTO rate_limits (bucket, count, window_start) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start")
      .bind(bucket, nowS).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?").bind(bucket).run();
  return true;
}
export const clearRateLimit = (env: Env, bucket: string) => env.DB.prepare("DELETE FROM rate_limits WHERE bucket = ?").bind(bucket).run();

export const clientIp = (c: Context) => c.req.header("cf-connecting-ip") ?? "unknown";

async function loadSession(c: Context<AppEnv>, kind: "tenant" | "owner"): Promise<{ s: SessionInfo; token: string } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ? AND kind = ?").bind(await sha256Hex(token), kind).first<{
    user_id: string; tenant_id: string | null; csrf_token: string; expires_at: string;
  }>();
  if (!row || row.expires_at < nowIso()) return null;
  if (kind === "tenant") {
    const u = await c.env.DB.prepare("SELECT email, role, disabled FROM tenant_users WHERE id = ? AND tenant_id = ?").bind(row.user_id, row.tenant_id).first<{ email: string; role: string; disabled: number }>();
    if (!u || u.disabled) return null;
    return { token, s: { kind, userId: row.user_id, tenantId: row.tenant_id, role: u.role, csrf: row.csrf_token, email: u.email } };
  }
  const o = await c.env.DB.prepare("SELECT email FROM platform_owners WHERE id = ?").bind(row.user_id).first<{ email: string }>();
  if (!o) return null;
  return { token, s: { kind, userId: row.user_id, tenantId: null, role: "owner", csrf: row.csrf_token, email: o.email } };
}

function enforceCsrfAndOrigin(c: Context<AppEnv>, s: SessionInfo) {
  const method = c.req.method;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== new URL(c.req.url).host) throw new HttpError(403, "Cross-origin request rejected", "csrf_origin");
  if (c.req.header("x-csrf-token") !== s.csrf) throw new HttpError(403, "Missing or invalid CSRF token", "csrf");
}

/** Resolves :slug → tenant and requires a valid session that belongs to that exact tenant. */
export const requireTenantSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const slug = c.req.param("slug") as string;
  const tenant = await c.env.DB.prepare("SELECT id, slug, business_name, status FROM tenants WHERE slug = ?").bind(slug).first<TenantRow>();
  if (!tenant) throw new HttpError(404, "Unknown tenant");
  const loaded = await loadSession(c, "tenant");
  if (!loaded) throw new HttpError(401, "Authentication required", "unauthenticated");
  // Never trust the slug in the URL alone: the session must have been issued for this tenant.
  if (loaded.s.tenantId !== tenant.id) throw new HttpError(403, "Forbidden", "tenant_mismatch");
  if (tenant.status === "suspended") throw new HttpError(403, "This account is suspended. Please contact SmartManager.", "tenant_suspended");
  enforceCsrfAndOrigin(c, loaded.s);
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (loaded.s.role === "viewer") throw new HttpError(403, "Read-only account", "forbidden");
    if (!(await rateLimit(c.env, `api:${loaded.token.slice(0, 12)}`, 240, 60))) throw new HttpError(429, "Too many requests", "rate_limited");
  }
  c.set("tenant", tenant);
  c.set("session", loaded.s);
  await next();
};

export const requireOwnerSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const loaded = await loadSession(c, "owner");
  if (!loaded) throw new HttpError(401, "Authentication required", "unauthenticated");
  enforceCsrfAndOrigin(c, loaded.s);
  c.set("session", loaded.s);
  await next();
};

export async function audit(env: Env, tenantId: string | null, actorKind: string, actorId: string | null, action: string, detail?: unknown) {
  await env.DB.prepare("INSERT INTO audit_logs (id, tenant_id, actor_kind, actor_id, action, detail, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), tenantId, actorKind, actorId, action, detail === undefined ? null : JSON.stringify(detail).slice(0, 1000), nowIso()).run();
}

export async function bump(env: Env, tenantId: string, metric: string, by = 1) {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO usage_counters (day, tenant_id, metric, count) VALUES (?,?,?,?) ON CONFLICT(day, tenant_id, metric) DO UPDATE SET count = count + excluded.count",
  ).bind(day, tenantId, metric, by).run();
}
