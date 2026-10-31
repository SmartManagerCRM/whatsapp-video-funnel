import { sha256Hex } from "../lib/crypto";
import { normalizePhone } from "../lib/util";

export type NormalizedEvent =
  | { kind: "message"; key: string; field: string; phoneNumberId: string; data: InboundMessage }
  | { kind: "status"; key: string; field: string; phoneNumberId: string; data: StatusUpdate }
  | { kind: "echo"; key: string; field: string; phoneNumberId: string; data: EchoMessage }
  | { kind: "state_sync"; key: string; field: string; phoneNumberId: string; data: { contacts: { phone: string; name: string | null; action: string }[] } }
  | { kind: "history"; key: string; field: string; phoneNumberId: string; data: unknown }
  | { kind: "account_update"; key: string; field: string; phoneNumberId: string; data: { event: string; raw: unknown } };

export interface InboundMessage {
  id: string; from: string; name: string | null; timestamp: number;
  type: "text" | "button_reply" | "list_reply" | "media" | "other";
  text: string; replyId: string | null;
}
export interface StatusUpdate { id: string; status: string; timestamp: number; recipient: string; error: string | null }
export interface EchoMessage { id: string; to: string; timestamp: number; type: string; text: string }

/**
 * Normalises Meta webhook payloads (Cloud API + Coexistence fields) into flat events.
 * Shapes follow Meta's published webhook reference. Coexistence-specific payloads (smb_message_echoes,
 * smb_app_state_sync, history, account_update) are parsed defensively because Meta has revised them;
 * verify against live payloads during the real integration test (docs/WHATSAPP_COEXISTENCE_SETUP.md).
 */
export async function parseWebhook(body: any): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  if (!body || body.object !== "whatsapp_business_account") return out;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const field: string = change.field;
      const v = change.value ?? {};
      const phoneNumberId: string = v.metadata?.phone_number_id ?? "";
      if (field === "messages") {
        const names: Record<string, string> = {};
        for (const c of v.contacts ?? []) if (c.wa_id) names[normalizePhone(c.wa_id)] = c.profile?.name ?? "";
        for (const m of v.messages ?? []) {
          const from = normalizePhone(m.from ?? "");
          let type: InboundMessage["type"] = "other";
          let text = ""; let replyId: string | null = null;
          if (m.type === "text") { type = "text"; text = m.text?.body ?? ""; }
          else if (m.type === "interactive" && m.interactive?.type === "button_reply") {
            type = "button_reply"; replyId = m.interactive.button_reply?.id ?? null; text = m.interactive.button_reply?.title ?? "";
          } else if (m.type === "interactive" && m.interactive?.type === "list_reply") {
            type = "list_reply"; replyId = m.interactive.list_reply?.id ?? null; text = m.interactive.list_reply?.title ?? "";
          } else if (m.type === "button") { type = "button_reply"; replyId = m.button?.payload ?? null; text = m.button?.text ?? ""; }
          else if (["image", "video", "audio", "document", "sticker"].includes(m.type)) type = "media";
          out.push({
            kind: "message", key: `msg:${m.id}`, field, phoneNumberId,
            data: { id: m.id, from, name: names[from] || null, timestamp: Number(m.timestamp) || 0, type, text, replyId },
          });
        }
        for (const s of v.statuses ?? []) {
          const e = s.errors?.[0];
          out.push({
            kind: "status", key: `st:${s.id}:${s.status}`, field, phoneNumberId,
            data: {
              id: s.id, status: s.status, timestamp: Number(s.timestamp) || 0, recipient: normalizePhone(s.recipient_id ?? ""),
              error: e ? `${e.code ?? ""} ${e.title ?? e.message ?? ""}`.trim() : null,
            },
          });
        }
      } else if (field === "smb_message_echoes") {
        for (const m of v.message_echoes ?? v.messages ?? []) {
          out.push({
            kind: "echo", key: `echo:${m.id}`, field, phoneNumberId,
            data: { id: m.id, to: normalizePhone(m.to ?? ""), timestamp: Number(m.timestamp) || 0, type: m.type ?? "text", text: m.text?.body ?? "" },
          });
        }
      } else if (field === "smb_app_state_sync") {
        const contacts = (v.state_sync ?? []).filter((s: any) => s.type === "contact" || s.contact).map((s: any) => ({
          phone: normalizePhone(s.contact?.phone_number ?? ""), name: s.contact?.full_name ?? s.contact?.first_name ?? null, action: s.action ?? "add",
        })).filter((c: any) => c.phone);
        out.push({ kind: "state_sync", key: `sync:${await sha256Hex(JSON.stringify(v))}`, field, phoneNumberId, data: { contacts } });
      } else if (field === "history") {
        out.push({ kind: "history", key: `hist:${await sha256Hex(JSON.stringify(v))}`, field, phoneNumberId, data: v });
      } else if (field === "account_update") {
        out.push({
          kind: "account_update", key: `acct:${await sha256Hex(JSON.stringify(change))}`, field, phoneNumberId: phoneNumberId || String(entry.id ?? ""),
          data: { event: String(v.event ?? ""), raw: v },
        });
      }
    }
  }
  return out;
}
