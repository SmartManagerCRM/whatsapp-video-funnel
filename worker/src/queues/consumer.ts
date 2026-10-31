import type { Env, QueueMessage } from "../env";
import { executeStep, handleEcho, handleInbound, handleStateSync, handleStatus, autoLog, failConversation } from "../automation/engine";
import type { NormalizedEvent } from "../whatsapp/webhook";
import { nowIso } from "../lib/util";

/** Processes one queue message. Returns a retry delay (seconds) when it should be retried. */
export async function handleQueueMessage(env: Env, msg: QueueMessage): Promise<{ retryAfter?: number }> {
  if (msg.type === "step") {
    const r = await executeStep(env, msg.jobId);
    return r.outcome === "retry" ? { retryAfter: r.retryAfter } : {};
  }
  if (msg.type === "webhook_event") {
    const row = await env.DB.prepare("SELECT * FROM whatsapp_webhook_events WHERE id = ?").bind(msg.eventId).first<{
      id: string; tenant_id: string; payload: string; status: string;
    }>();
    if (!row || row.status === "processed") return {};
    const ev = JSON.parse(row.payload) as NormalizedEvent;
    try {
      switch (ev.kind) {
        case "message": await handleInbound(env, row.tenant_id, ev.data); break;
        case "status": await handleStatus(env, row.tenant_id, ev.data); break;
        case "echo": await handleEcho(env, row.tenant_id, ev.data); break;
        case "state_sync": await handleStateSync(env, row.tenant_id, ev.data.contacts); break;
        case "account_update": await handleAccountUpdate(env, row.tenant_id, ev.data.event); break;
        case "history": break; // stored only; historical messages are never auto-replied
      }
      await env.DB.prepare("UPDATE whatsapp_webhook_events SET status = 'processed', processed_at = ?, error = NULL WHERE id = ?").bind(nowIso(), row.id).run();
    } catch (e) {
      await env.DB.prepare("UPDATE whatsapp_webhook_events SET status = 'failed', error = ? WHERE id = ?").bind(String((e as Error).message).slice(0, 300), row.id).run();
      throw e; // let the queue retry (events are idempotent by key)
    }
  }
  return {};
}

async function handleAccountUpdate(env: Env, tenantId: string, event: string) {
  const e = event.toUpperCase();
  if (e.includes("DISCONNECT") || e.includes("REMOVED") || e.includes("DELETED")) {
    await env.DB.prepare("UPDATE whatsapp_accounts SET status = 'disconnected', last_error = ?, updated_at = ? WHERE tenant_id = ?")
      .bind(`Meta account_update: ${event}`, nowIso(), tenantId).run();
    await autoLog(env, tenantId, null, `WhatsApp account update: ${event}`, "warn");
  }
}

export async function queueHandler(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  const isDlq = batch.queue.endsWith("-dlq");
  for (const m of batch.messages) {
    if (isDlq) { await handleDeadLetter(env, m.body); m.ack(); continue; }
    try {
      const r = await handleQueueMessage(env, m.body);
      if (r.retryAfter) m.retry({ delaySeconds: r.retryAfter }); else m.ack();
    } catch (e) {
      m.retry({ delaySeconds: Math.min(900, 10 * 2 ** m.attempts) });
      console.error("queue message failed", m.body.type, (e as Error).message);
    }
  }
}

/** Messages that exhausted every retry: keep progress, surface the failure, allow admin retry. */
async function handleDeadLetter(env: Env, msg: QueueMessage) {
  if (msg.type === "step") {
    const job = await env.DB.prepare("SELECT conversation_id, tenant_id FROM scheduled_jobs WHERE id = ?").bind(msg.jobId).first<{ conversation_id: string; tenant_id: string }>();
    if (!job) return;
    const conv = await env.DB.prepare("SELECT * FROM conversations WHERE id = ?").bind(job.conversation_id).first<any>();
    if (conv && !["COMPLETED", "OPTED_OUT", "HUMAN_HANDLING"].includes(conv.state)) await failConversation(env, conv, msg.jobId, "Dead-lettered after repeated failures");
    await autoLog(env, job.tenant_id, job.conversation_id, "Step job dead-lettered", "error");
  } else {
    await env.DB.prepare("UPDATE whatsapp_webhook_events SET status = 'failed', error = COALESCE(error,'') || ' [dead-lettered]' WHERE id = ?").bind(msg.eventId).run();
  }
}
