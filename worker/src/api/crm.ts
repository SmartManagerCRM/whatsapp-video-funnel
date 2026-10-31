import { Hono } from "hono";
import { audit, type AppEnv } from "../auth/session";
import { adminAction, windowStatus, type AdminAction } from "../automation/engine";
import { HttpError } from "../lib/util";
import { json, oneOf } from "./validate";

export const crmApi = new Hono<AppEnv>();

const PAGE = 25;

// ------------------------------------------------------------------ customers
function customerFilter(c: any, tenantId: string) {
  const where = ["cu.tenant_id = ?"]; const binds: unknown[] = [tenantId];
  const q = c.req.query("search")?.trim();
  if (q) { where.push("(cu.wa_phone LIKE ? OR cu.name LIKE ?)"); binds.push(`%${q.replace(/[%_]/g, "")}%`, `%${q.replace(/[%_]/g, "")}%`); }
  const status = c.req.query("status"); if (status) { where.push("cu.status = ?"); binds.push(status); }
  const cat = c.req.query("category"); if (cat) { where.push("cu.category_id = ?"); binds.push(cat); }
  return { where: where.join(" AND "), binds };
}

const LIST_SQL = `SELECT cu.id, cu.wa_phone, cu.name, cu.status, cu.category_id, cat.name AS category_name, cu.first_interaction_at, cu.last_interaction_at,
    cv.id AS conversation_id, cv.state, cv.next_step, cv.videos_sent, cv.last_inbound_at,
    (SELECT COUNT(*) FROM sequence_items i WHERE i.sequence_id = cv.sequence_id) AS total_videos
  FROM customers cu LEFT JOIN business_categories cat ON cat.id = cu.category_id
  LEFT JOIN conversations cv ON cv.id = (SELECT id FROM conversations x WHERE x.customer_id = cu.id ORDER BY x.started_at DESC, x.rowid DESC LIMIT 1)`;

crmApi.get("/customers", async (c) => {
  const t = c.get("tenant"); const f = customerFilter(c, t.id);
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const { results } = await c.env.DB.prepare(`${LIST_SQL} WHERE ${f.where} ORDER BY cu.last_interaction_at DESC LIMIT ? OFFSET ?`).bind(...f.binds, PAGE, (page - 1) * PAGE).all<any>();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM customers cu WHERE ${f.where}`).bind(...f.binds).first<{ n: number }>();
  return c.json({ page, pageSize: PAGE, total: total?.n ?? 0, customers: results.map((r) => ({ ...r, window: windowStatus(r.last_inbound_at) })) });
});

/** CSV values beginning with = + - @ are prefixed to neutralise spreadsheet formula injection. */
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

crmApi.get("/customers.csv", async (c) => {
  const t = c.get("tenant"); const f = customerFilter(c, t.id);
  const { results } = await c.env.DB.prepare(`${LIST_SQL} WHERE ${f.where} ORDER BY cu.first_interaction_at LIMIT 10000`).bind(...f.binds).all<any>();
  const head = ["phone", "name", "category", "status", "videos_sent", "total_videos", "first_interaction", "last_interaction"];
  const lines = [head.join(",")].concat(results.map((r) => [r.wa_phone, r.name, r.category_name, r.status, r.videos_sent ?? 0, r.total_videos ?? 0, r.first_interaction_at, r.last_interaction_at].map(csvCell).join(",")));
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "customers_exported", { rows: results.length });
  return new Response("﻿" + lines.join("\r\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="customers.csv"', "Cache-Control": "no-store" } });
});

crmApi.get("/customers/:id", async (c) => {
  const t = c.get("tenant");
  const cu = await c.env.DB.prepare(`${LIST_SQL} WHERE cu.tenant_id = ? AND cu.id = ?`).bind(t.id, c.req.param("id")).first<any>();
  if (!cu) throw new HttpError(404, "Customer not found");
  const { results: events } = await c.env.DB.prepare(
    `SELECT e.type, e.data, e.created_at FROM conversation_events e JOIN conversations v ON v.id = e.conversation_id
      WHERE e.tenant_id = ? AND v.customer_id = ? ORDER BY e.created_at DESC LIMIT 200`,
  ).bind(t.id, cu.id).all();
  const { results: conversations } = await c.env.DB.prepare("SELECT id, state, started_at, completed_at, videos_sent FROM conversations WHERE tenant_id = ? AND customer_id = ? ORDER BY started_at DESC").bind(t.id, cu.id).all();
  return c.json({ customer: { ...cu, window: windowStatus(cu.last_inbound_at) }, events, conversations });
});

crmApi.delete("/customers/:id", async (c) => {
  const t = c.get("tenant");
  const r = await c.env.DB.prepare("DELETE FROM customers WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), t.id).run();
  if (!r.meta.changes) throw new HttpError(404, "Customer not found");
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "customer_deleted", { id: c.req.param("id") });
  return c.json({ ok: true });
});

crmApi.post("/customers/bulk-delete", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  let deleted = 0;
  if (Array.isArray(b.ids) && b.ids.length) {
    const ids = b.ids.slice(0, 500).map(String);
    const where = `tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})`;
    deleted = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${where}`).bind(t.id, ...ids).first<{ n: number }>())?.n ?? 0;
    await c.env.DB.prepare(`DELETE FROM customers WHERE ${where}`).bind(t.id, ...ids).run();
  } else if (typeof b.before === "string" && !Number.isNaN(Date.parse(b.before))) {
    const before = new Date(b.before).toISOString();
    // (D1's meta.changes also counts rows removed by FK cascades, so count the customers explicitly)
    deleted = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND last_interaction_at < ?").bind(t.id, before).first<{ n: number }>())?.n ?? 0;
    await c.env.DB.prepare("DELETE FROM customers WHERE tenant_id = ? AND last_interaction_at < ?").bind(t.id, before).run();
  } else throw new HttpError(400, "Provide ids or a 'before' date");
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "customers_bulk_deleted", { deleted });
  return c.json({ ok: true, deleted });
});

// ------------------------------------------------------------------ conversations
crmApi.get("/conversations", async (c) => {
  const t = c.get("tenant");
  const state = c.req.query("state");
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.state, v.next_step, v.videos_sent, v.paused_reason, v.last_inbound_at, v.updated_at, cu.wa_phone, cu.name, cat.name AS category_name
       FROM conversations v JOIN customers cu ON cu.id = v.customer_id LEFT JOIN business_categories cat ON cat.id = v.category_id
      WHERE v.tenant_id = ? ${state ? "AND v.state = ?" : ""} ORDER BY v.updated_at DESC LIMIT 100`,
  ).bind(...(state ? [t.id, state] : [t.id])).all<any>();
  return c.json({ conversations: results.map((r) => ({ ...r, window: windowStatus(r.last_inbound_at) })) });
});

crmApi.get("/conversations/:id", async (c) => {
  const t = c.get("tenant");
  const v = await c.env.DB.prepare(
    `SELECT v.*, cu.wa_phone, cu.name, cu.opted_out, cat.name AS category_name FROM conversations v JOIN customers cu ON cu.id = v.customer_id
       LEFT JOIN business_categories cat ON cat.id = v.category_id WHERE v.id = ? AND v.tenant_id = ?`,
  ).bind(c.req.param("id"), t.id).first<any>();
  if (!v) throw new HttpError(404, "Conversation not found");
  const { results: messages } = await c.env.DB.prepare("SELECT id, direction, kind, body, status, error, video_id, created_at FROM message_logs WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at, rowid").bind(v.id, t.id).all();
  const { results: events } = await c.env.DB.prepare("SELECT type, data, created_at FROM conversation_events WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at, rowid").bind(v.id, t.id).all();
  const { lock_until, ...safe } = v;
  void lock_until;
  return c.json({ conversation: { ...safe, window: windowStatus(v.last_inbound_at) }, messages, events });
});

crmApi.post("/conversations/:id/action", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  const action = oneOf(b.action, "action", ["pause", "resume", "restart", "human", "complete", "retry", "change_category"] as const) as AdminAction;
  try { await adminAction(c.env, t.id, c.req.param("id"), action, typeof b.category_id === "string" ? b.category_id : undefined); }
  catch (e: any) { if (e.status) throw new HttpError(e.status, e.message); throw e; }
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, `conversation_${action}`, { id: c.req.param("id") });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ analytics
crmApi.get("/analytics", async (c) => {
  const t = c.get("tenant");
  const days = Math.min(365, Math.max(1, parseInt(c.req.query("days") ?? "30", 10) || 30));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const q = async <T>(sql: string, ...b: unknown[]) => (await c.env.DB.prepare(sql).bind(t.id, ...b).all<T>()).results;
  const [totals] = await q<any>(
    `SELECT (SELECT COUNT(*) FROM customers WHERE tenant_id = ?1) AS customers,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?1 AND started_at >= ?2) AS started,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?1 AND started_at >= ?2 AND state = 'COMPLETED') AS completed,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?1 AND state IN ('VIDEO_SEQUENCE_ACTIVE','CATEGORY_SELECTED','WAITING_FOR_CATEGORY','WELCOME_SENT')) AS active,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?1 AND state = 'WAITING_FOR_NEXT_VIDEO') AS waiting,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?1 AND state = 'HUMAN_HANDLING') AS human,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?1 AND started_at >= ?2 AND website_sent = 1) AS website_sent,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = ?1 AND state = 'FAILED') AS failed_conversations,
            (SELECT COUNT(*) FROM message_logs WHERE tenant_id = ?1 AND created_at >= ?2 AND kind = 'video' AND direction = 'outbound_auto') AS videos_submitted,
            (SELECT COUNT(*) FROM message_logs WHERE tenant_id = ?1 AND created_at >= ?2 AND kind = 'video' AND status IN ('delivered','read')) AS videos_delivered,
            (SELECT COUNT(*) FROM message_logs WHERE tenant_id = ?1 AND created_at >= ?2 AND kind = 'video' AND status = 'failed') AS videos_failed,
            (SELECT COUNT(*) FROM message_logs WHERE tenant_id = ?1 AND created_at >= ?2 AND status = 'failed') AS messages_failed`, since);
  const perCategory = await q<any>(
    `SELECT COALESCE(cat.name, 'Not selected') AS name, COUNT(*) AS customers,
            SUM(CASE WHEN v.state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
       FROM conversations v LEFT JOIN business_categories cat ON cat.id = v.category_id WHERE v.tenant_id = ? AND v.started_at >= ? GROUP BY cat.id ORDER BY customers DESC LIMIT 20`, since);
  // Drop-off: how many conversations reached each video position (based on videos submitted, not "watched")
  const dropoff = await q<any>(
    `SELECT videos_sent AS reached, COUNT(*) AS conversations FROM conversations WHERE tenant_id = ? AND started_at >= ? AND category_id IS NOT NULL GROUP BY videos_sent ORDER BY videos_sent`, since);
  const trend = await q<any>(
    `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS started, SUM(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
       FROM conversations WHERE tenant_id = ? AND started_at >= ? GROUP BY day ORDER BY day`, since);
  const failures = await q<any>(`SELECT error, COUNT(*) AS n FROM message_logs WHERE tenant_id = ? AND created_at >= ? AND status = 'failed' GROUP BY error ORDER BY n DESC LIMIT 10`, since);
  const recent = await q<any>(
    `SELECT e.type, e.created_at, cu.name, cu.wa_phone FROM conversation_events e JOIN conversations v ON v.id = e.conversation_id JOIN customers cu ON cu.id = v.customer_id
      WHERE e.tenant_id = ? AND e.type NOT IN ('inbound_during_human_handling') ORDER BY e.created_at DESC LIMIT 12`);
  return c.json({
    days, totals: { ...totals, completion_rate: totals.started ? Math.round((totals.completed / totals.started) * 1000) / 10 : 0 },
    perCategory, dropoff, trend, failures, recent,
    note: "Delivery counts reflect WhatsApp delivery receipts. WhatsApp does not report whether a video was watched.",
  });
});
