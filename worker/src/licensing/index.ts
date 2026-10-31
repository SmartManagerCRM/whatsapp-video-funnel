import type { Env } from "../env";
import { b64decode, b64urlDecode, HttpError, newId, nowIso, safeJson } from "../lib/util";

/**
 * License token = compact JWS (RS256): base64url(header).base64url(payload).base64url(signature)
 * `.smlic` file = JSON { "format": "smlic/1", "token": "<jws>" }.
 * The Worker only holds the PUBLIC key. Signing happens in the separate Windows License Generator.
 */
export interface LicensePayload {
  lid: string;                 // license ID
  pid: string;                 // product ID
  product_name?: string;
  client_name: string;
  tenant_id: string;
  tenant_slug: string;
  iat: number;                 // issue time (epoch seconds)
  type: string;                // "LIFETIME"
  exp?: number | null;         // absent/null for LIFETIME
  features: string[];
  max_numbers: number;
  transfer_from?: string;      // license id this license replaces (requires owner approval)
}

export type LicenseFailure =
  | "malformed" | "bad_signature" | "wrong_product" | "wrong_tenant" | "expired"
  | "revoked" | "suspended" | "transferred" | "already_used" | "not_activated"
  | "unsupported_type" | "transfer_not_approved" | "key_unavailable";

export class LicenseError extends HttpError {
  constructor(public reason: LicenseFailure, message: string) {
    super(reason === "not_activated" ? 402 : 403, message, `license_${reason}`);
  }
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return b64decode(body);
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", pemToDer(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/** Accepts either a raw token or the contents of a .smlic file. */
export function extractToken(input: string): string {
  const t = input.trim();
  if (t.startsWith("{")) {
    const parsed = safeJson<{ token?: string }>(t, {});
    if (!parsed.token) throw new LicenseError("malformed", "License file does not contain a token");
    return parsed.token.trim();
  }
  return t;
}

export async function verifyToken(env: Env, token: string): Promise<LicensePayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new LicenseError("malformed", "Malformed license token");
  const [h, p, s] = parts;
  let header: { alg?: string; typ?: string };
  let payload: LicensePayload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    throw new LicenseError("malformed", "Malformed license token");
  }
  if (header.alg !== "RS256") throw new LicenseError("bad_signature", "Unsupported signature algorithm");
  let key: CryptoKey;
  try {
    key = await importPublicKey(env.LICENSE_PUBLIC_KEY);
  } catch {
    throw new LicenseError("key_unavailable", "License verification key is not configured correctly");
  }
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new LicenseError("bad_signature", "License signature is invalid");
  return payload;
}

function assertPayloadShape(payload: LicensePayload) {
  if (!payload.lid || !payload.pid || !payload.tenant_id || !payload.type) {
    throw new LicenseError("malformed", "License is missing required fields");
  }
}

/** Activate a license for a tenant. Throws LicenseError on any rejection. */
export async function activateLicense(
  env: Env, tenant: { id: string; slug: string }, input: string, actor: string,
): Promise<LicensePayload> {
  const token = extractToken(input);
  const payload = await verifyToken(env, token);
  assertPayloadShape(payload);

  if (payload.pid !== env.PRODUCT_ID) throw new LicenseError("wrong_product", "License is for a different product");
  if (payload.tenant_id !== tenant.id || payload.tenant_slug !== tenant.slug) {
    throw new LicenseError("wrong_tenant", "License was issued for a different tenant");
  }
  if (payload.type !== "LIFETIME") throw new LicenseError("unsupported_type", "Unsupported license type");
  // LIFETIME licenses never expire. If an expiry is *explicitly* present, honour it.
  if (payload.exp != null && payload.exp * 1000 < Date.now()) throw new LicenseError("expired", "License has expired");

  const existing = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?").bind(payload.lid).first<{
    tenant_id: string; status: string;
  }>();
  if (existing) {
    if (existing.status === "revoked") throw new LicenseError("revoked", "License has been revoked");
    if (existing.status === "transferred") throw new LicenseError("transferred", "License was transferred to another tenant");
    if (existing.tenant_id !== tenant.id) throw new LicenseError("already_used", "License is already registered to another tenant");
    // Same tenant re-activating the same license: idempotent.
    await env.DB.prepare("UPDATE licenses SET last_verified_at = ? WHERE id = ?").bind(nowIso(), payload.lid).run();
    return payload;
  }

  if (payload.transfer_from) {
    const approval = await env.DB.prepare(
      "SELECT id FROM license_events WHERE license_id = ? AND event = 'transfer_approved' AND detail = ?",
    ).bind(payload.transfer_from, tenant.id).first();
    if (!approval) throw new LicenseError("transfer_not_approved", "License transfer has not been approved by the platform owner");
  }

  const now = nowIso();
  // One active license per tenant: retire the previous one (only reachable via an approved transfer/re-issue flow).
  const active = await env.DB.prepare("SELECT id FROM licenses WHERE tenant_id = ? AND status = 'active'").bind(tenant.id).first<{ id: string }>();
  if (active && payload.transfer_from !== active.id) {
    throw new LicenseError("already_used", "This tenant already has an active license");
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO licenses (id, tenant_id, product_id, client_name, license_type, features, max_whatsapp_numbers,
         issued_at, expires_at, status, token, activated_at, last_verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
    ).bind(
      payload.lid, tenant.id, payload.pid, payload.client_name, payload.type, JSON.stringify(payload.features ?? []),
      payload.max_numbers ?? 1, new Date(payload.iat * 1000).toISOString(),
      payload.exp ? new Date(payload.exp * 1000).toISOString() : null, token, now, now,
    ),
    env.DB.prepare("INSERT INTO license_events (id, license_id, tenant_id, event, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("lev"), payload.lid, tenant.id, "activated", actor, now),
  ]);
  return payload;
}

export interface LicenseStatus {
  valid: boolean;
  reason?: LicenseFailure;
  message?: string;
  license?: {
    id: string; type: string; client_name: string; tenant_id: string; status: string;
    activated_at: string; registered_phone: string | null; features: string[];
    max_whatsapp_numbers: number; expires_at: string | null; lifetime: boolean;
  };
  grace?: boolean;
}

const GRACE_HOURS = 72;

/** Re-verifies the stored token (signature + tenant + product + DB revocation state) on every call. */
export async function getLicenseStatus(env: Env, tenantId: string): Promise<LicenseStatus> {
  const row = await env.DB.prepare(
    "SELECT * FROM licenses WHERE tenant_id = ? AND status != 'transferred' ORDER BY activated_at DESC LIMIT 1",
  ).bind(tenantId).first<{
    id: string; token: string; status: string; license_type: string; client_name: string; tenant_id: string;
    activated_at: string; registered_phone: string | null; features: string; max_whatsapp_numbers: number;
    expires_at: string | null; last_verified_at: string | null; product_id: string;
  }>();
  if (!row) return { valid: false, reason: "not_activated", message: "No license activated" };

  const view = {
    id: row.id, type: row.license_type, client_name: row.client_name, tenant_id: row.tenant_id, status: row.status,
    activated_at: row.activated_at, registered_phone: row.registered_phone, features: safeJson<string[]>(row.features, []),
    max_whatsapp_numbers: row.max_whatsapp_numbers, expires_at: row.expires_at, lifetime: row.license_type === "LIFETIME" && !row.expires_at,
  };
  // Explicit revocation/suspension is final: the grace mechanism never overrides it.
  if (row.status === "revoked") return { valid: false, reason: "revoked", message: "License has been revoked", license: view };
  if (row.status === "suspended") return { valid: false, reason: "suspended", message: "License is suspended", license: view };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: "expired", message: "License has expired", license: view };
  }
  try {
    const payload = await verifyToken(env, row.token);
    if (payload.tenant_id !== tenantId || payload.pid !== env.PRODUCT_ID) throw new LicenseError("wrong_tenant", "License does not match this tenant");
    await env.DB.prepare("UPDATE licenses SET last_verified_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
    return { valid: true, license: view };
  } catch (e) {
    if (e instanceof LicenseError && e.reason === "key_unavailable" && row.last_verified_at) {
      // Verification infrastructure problem (not a bad license): allow last-known-good for a bounded period.
      const age = Date.now() - new Date(row.last_verified_at).getTime();
      if (age < GRACE_HOURS * 3600_000) return { valid: true, grace: true, message: "Running on last-known-good verification", license: view };
    }
    const reason = e instanceof LicenseError ? e.reason : "malformed";
    return { valid: false, reason, message: (e as Error).message, license: view };
  }
}

export async function requireValidLicense(env: Env, tenantId: string): Promise<LicenseStatus> {
  const st = await getLicenseStatus(env, tenantId);
  if (!st.valid) throw new LicenseError(st.reason ?? "not_activated", st.message ?? "A valid license is required");
  return st;
}

// ---------- Owner administration ----------
export async function revokeLicense(env: Env, licenseId: string, actor: string) {
  const row = await env.DB.prepare("SELECT tenant_id FROM licenses WHERE id = ?").bind(licenseId).first<{ tenant_id: string }>();
  if (!row) throw new HttpError(404, "License not found");
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET status = 'revoked' WHERE id = ?").bind(licenseId),
    env.DB.prepare("INSERT INTO license_events (id, license_id, tenant_id, event, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("lev"), licenseId, row.tenant_id, "revoked", actor, nowIso()),
  ]);
}

export async function setLicenseSuspended(env: Env, licenseId: string, suspended: boolean, actor: string) {
  const row = await env.DB.prepare("SELECT tenant_id, status FROM licenses WHERE id = ?").bind(licenseId).first<{ tenant_id: string; status: string }>();
  if (!row) throw new HttpError(404, "License not found");
  if (row.status === "revoked" || row.status === "transferred") throw new HttpError(409, `Cannot change a ${row.status} license`);
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET status = ? WHERE id = ?").bind(suspended ? "suspended" : "active", licenseId),
    env.DB.prepare("INSERT INTO license_events (id, license_id, tenant_id, event, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("lev"), licenseId, row.tenant_id, suspended ? "suspended" : "reinstated", actor, nowIso()),
  ]);
}

/**
 * Approve a transfer: the old license becomes `transferred` (unusable) and the destination tenant may
 * activate a NEW token (issued by the generator with transfer_from = old id).
 */
export async function approveTransfer(env: Env, licenseId: string, toTenantId: string, actor: string) {
  const row = await env.DB.prepare("SELECT tenant_id, status FROM licenses WHERE id = ?").bind(licenseId).first<{ tenant_id: string; status: string }>();
  if (!row) throw new HttpError(404, "License not found");
  if (row.status === "revoked") throw new HttpError(409, "A revoked license cannot be transferred");
  if (row.tenant_id === toTenantId) throw new HttpError(400, "Destination tenant is the current owner");
  const dest = await env.DB.prepare("SELECT id FROM tenants WHERE id = ?").bind(toTenantId).first();
  if (!dest) throw new HttpError(404, "Destination tenant not found");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET status = 'transferred' WHERE id = ?").bind(licenseId),
    env.DB.prepare("INSERT INTO license_events (id, license_id, tenant_id, event, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("lev"), licenseId, row.tenant_id, "transferred_out", actor, now),
    env.DB.prepare("INSERT INTO license_events (id, license_id, tenant_id, event, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("lev"), licenseId, row.tenant_id, "transfer_approved", toTenantId, now),
  ]);
}

/** Registers the WhatsApp number on the license; changing it later requires owner approval. */
export async function bindPhoneToLicense(env: Env, tenantId: string, displayPhone: string) {
  const lic = await env.DB.prepare("SELECT id, registered_phone FROM licenses WHERE tenant_id = ? AND status = 'active'").bind(tenantId)
    .first<{ id: string; registered_phone: string | null }>();
  if (!lic) return;
  const digits = displayPhone.replace(/\D/g, "");
  if (!lic.registered_phone) {
    await env.DB.prepare("UPDATE licenses SET registered_phone = ? WHERE id = ?").bind(digits, lic.id).run();
    await env.DB.prepare("INSERT INTO license_events (id, license_id, tenant_id, event, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("lev"), lic.id, tenantId, "phone_registered", digits, nowIso()).run();
  } else if (lic.registered_phone !== digits) {
    throw new HttpError(403, "This license is registered to a different WhatsApp number. Changing the number requires approval from SmartManager.", "license_phone_mismatch");
  }
}

export async function resetRegisteredPhone(env: Env, licenseId: string, actor: string) {
  const row = await env.DB.prepare("SELECT tenant_id FROM licenses WHERE id = ?").bind(licenseId).first<{ tenant_id: string }>();
  if (!row) throw new HttpError(404, "License not found");
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET registered_phone = NULL WHERE id = ?").bind(licenseId),
    env.DB.prepare("INSERT INTO license_events (id, license_id, tenant_id, event, detail, created_at) VALUES (?,?,?,?,?,?)")
      .bind(newId("lev"), licenseId, row.tenant_id, "phone_reset", actor, nowIso()),
  ]);
}
