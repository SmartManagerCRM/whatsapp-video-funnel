import type { Env } from "../env";
import { decryptSecret } from "../lib/crypto";
import { nowIso } from "../lib/util";

/** Network seam: tests replace `deps.fetch` with a Meta mock. */
export const deps: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) };

/**
 * Media constraints for WhatsApp video messages. These reflect Meta's documentation at the time of writing
 * (MP4/3GPP, H.264 + AAC, 16 MB). Meta can change them: re-verify against the current "Supported media types"
 * page before relying on them. They are centralised here so a change is a one-line edit.
 */
export const MEDIA_LIMITS = {
  videoMimeTypes: ["video/mp4", "video/3gpp"],
  videoMaxBytes: 16 * 1024 * 1024,
};

export type WaErrorKind = "token" | "window" | "rate" | "transient" | "media" | "permanent";

export class WaError extends Error {
  constructor(
    message: string, public kind: WaErrorKind, public status: number,
    public code?: number, public subcode?: number,
  ) { super(message); }
  get retryable() { return this.kind === "transient" || this.kind === "rate"; }
}

export interface WaCreds {
  tenantId: string;
  phoneNumberId: string;
  wabaId: string | null;
  token: string;
  graphVersion: string;
}

export async function loadCreds(env: Env, tenantId: string): Promise<WaCreds | null> {
  const a = await env.DB.prepare("SELECT * FROM whatsapp_accounts WHERE tenant_id = ?").bind(tenantId).first<{
    phone_number_id: string | null; waba_id: string | null; access_token_enc: string | null; graph_version: string; status: string;
  }>();
  if (!a || !a.phone_number_id || !a.access_token_enc) return null;
  return {
    tenantId, phoneNumberId: a.phone_number_id, wabaId: a.waba_id,
    token: await decryptSecret(env, a.access_token_enc, `${tenantId}:token`),
    graphVersion: a.graph_version || env.DEFAULT_GRAPH_VERSION,
  };
}

export function classifyError(status: number, body: any): WaError {
  const err = body?.error ?? {};
  const code: number | undefined = err.code;
  const sub: number | undefined = err.error_subcode;
  const msg: string = err.message ?? `Graph API error (HTTP ${status})`;
  if (code === 190 || status === 401) return new WaError(msg, "token", status, code, sub);
  if (code === 131047) return new WaError(msg, "window", status, code, sub);
  if (code === 4 || code === 80007 || code === 130429 || code === 131056 || status === 429) return new WaError(msg, "rate", status, code, sub);
  if (code === 131053 || code === 131052) return new WaError(msg, "media", status, code, sub);
  if (status >= 500 || code === 1 || code === 2) return new WaError(msg, "transient", status, code, sub);
  return new WaError(msg, "permanent", status, code, sub);
}

async function graph(creds: WaCreds, path: string, init: RequestInit = {}): Promise<any> {
  const url = `https://graph.facebook.com/${creds.graphVersion}/${path}`;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${creds.token}`, ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new WaError(`Network error contacting Meta: ${(e as Error).message}`, "transient", 0);
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw classifyError(res.status, body);
  return body;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function sendMessage(creds: WaCreds, payload: Record<string, unknown>): Promise<string> {
  const body = await graph(creds, `${creds.phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  const id = body?.messages?.[0]?.id;
  if (!id) throw new WaError("Meta accepted the request but returned no message id", "transient", 200);
  return id;
}

export const sendText = (c: WaCreds, to: string, text: string, previewUrl = true) =>
  sendMessage(c, { to, type: "text", text: { body: clip(text, 4096), preview_url: previewUrl } });

export const sendVideo = (c: WaCreds, to: string, mediaId: string, caption?: string) =>
  sendMessage(c, { to, type: "video", video: { id: mediaId, ...(caption ? { caption: clip(caption, 1024) } : {}) } });

export const sendButtons = (c: WaCreds, to: string, body: string, buttons: { id: string; title: string }[]) =>
  sendMessage(c, {
    to, type: "interactive",
    interactive: {
      type: "button", body: { text: clip(body, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: clip(b.title, 20) } })) },
    },
  });

export const sendList = (
  c: WaCreds, to: string, body: string, buttonLabel: string,
  rows: { id: string; title: string; description?: string }[],
) =>
  sendMessage(c, {
    to, type: "interactive",
    interactive: {
      type: "list", body: { text: clip(body, 1024) },
      action: {
        button: clip(buttonLabel, 20),
        sections: [{
          title: "Options",
          rows: rows.slice(0, 10).map((r) => ({
            id: r.id, title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}),
          })),
        }],
      },
    },
  });

export const sendTemplate = (c: WaCreds, to: string, name: string, language: string) =>
  sendMessage(c, { to, type: "template", template: { name, language: { code: language } } });

export async function uploadMedia(c: WaCreds, bytes: ArrayBuffer, mime: string, filename: string): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const body = await graph(c, `${c.phoneNumberId}/media`, { method: "POST", body: form });
  if (!body?.id) throw new WaError("Media upload returned no id", "transient", 200);
  return body.id as string;
}

export interface PhoneInfo {
  display_phone_number?: string;
  verified_name?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
}

/** Reads the phone number and its Coexistence fields (is_on_biz_app, platform_type). */
export const getPhoneInfo = (c: WaCreds): Promise<PhoneInfo> =>
  graph(c, `${c.phoneNumberId}?fields=display_phone_number,verified_name,platform_type,is_on_biz_app`);

export async function getSubscribedFields(c: WaCreds): Promise<string[]> {
  if (!c.wabaId) return [];
  const body = await graph(c, `${c.wabaId}/subscribed_apps`);
  const fields: string[] = [];
  for (const app of body?.data ?? []) for (const f of app.subscribed_fields ?? []) fields.push(typeof f === "string" ? f : f.name);
  return fields;
}

export async function subscribeApp(c: WaCreds, fields: string[]): Promise<void> {
  if (!c.wabaId) throw new WaError("WABA ID is not configured", "permanent", 400);
  await graph(c, `${c.wabaId}/subscribed_apps`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscribed_fields: fields.join(",") }),
  });
}

export const REQUIRED_WEBHOOK_FIELDS = ["messages", "smb_message_echoes", "smb_app_state_sync", "history", "account_update"];

export async function recordApiOk(env: Env, tenantId: string) {
  await env.DB.prepare("UPDATE whatsapp_accounts SET last_api_ok_at = ?, last_error = NULL WHERE tenant_id = ?").bind(nowIso(), tenantId).run();
}
export async function recordApiError(env: Env, tenantId: string, e: WaError) {
  if (e.kind === "token") {
    await env.DB.prepare("UPDATE whatsapp_accounts SET status = 'token_invalid', last_error = ?, updated_at = ? WHERE tenant_id = ?")
      .bind(e.message.slice(0, 300), nowIso(), tenantId).run();
  } else {
    await env.DB.prepare("UPDATE whatsapp_accounts SET last_error = ? WHERE tenant_id = ?").bind(e.message.slice(0, 300), tenantId).run();
  }
}
