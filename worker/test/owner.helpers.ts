import { env } from "cloudflare:workers";
import { raw } from "./helpers";
import { hashPassword } from "../src/lib/crypto";

export async function ownerLogin(email = `owner-${Math.random().toString(36).slice(2, 7)}@x.test`) {
  const pw = "owner-password-123";
  await env.DB.prepare("INSERT INTO platform_owners (id, email, password_hash, created_at) VALUES (?,?,?,?)").bind(crypto.randomUUID(), email, await hashPassword(pw), new Date().toISOString()).run();
  const res = await raw("/owner/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: pw }) });
  if (res.status !== 200) throw new Error(`owner login failed ${res.status}`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const { csrf } = (await res.json()) as any;
  return {
    csrf, cookie,
    fetch: (method: string, path: string, body?: unknown) =>
      raw(`/owner/api${path}`, { method, headers: { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
}
