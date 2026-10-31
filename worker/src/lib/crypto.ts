import type { Env } from "../env";
import { b64decode, b64encode, timingSafeEqual, toHex } from "./util";

const enc = new TextEncoder();

// ---------- AES-GCM for tenant credentials ----------
async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = b64decode(env.ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be a base64 encoded 32-byte key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Output format: v1.<iv>.<ciphertext+tag> (base64). `aad` binds the secret to its tenant. */
export async function encryptSecret(env: Env, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    await aesKey(env),
    enc.encode(plaintext),
  );
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decryptSecret(env: Env, blob: string, aad: string): Promise<string> {
  const [v, iv, ct] = blob.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unsupported ciphertext format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(iv), additionalData: enc.encode(aad) },
    await aesKey(env),
    b64decode(ct),
  );
  return new TextDecoder().decode(pt);
}

// ---------- Password hashing (PBKDF2-SHA256; Workers cap iterations at 100k) ----------
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const calc = await pbkdf2(password, b64decode(salt), parseInt(iter, 10));
  return timingSafeEqual(b64encode(calc), hash);
}

/** Dummy verification to keep login timing similar when the user doesn't exist. */
export async function dummyVerify(): Promise<void> {
  await pbkdf2("x", new Uint8Array(16), PBKDF2_ITERATIONS);
}

// ---------- Hashing / HMAC ----------
export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", buf));
}

export async function hmacSha256Hex(secret: string, body: string | ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = typeof body === "string" ? enc.encode(body) : body;
  return toHex(await crypto.subtle.sign("HMAC", key, msg));
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
