import { Hono } from "hono";
import { audit, type AppEnv } from "../auth/session";
import { DEFAULT_TEMPLATES } from "../automation/templates";
import { HttpError, newId, nowIso, safeJson } from "../lib/util";
import { int, json, oneOf, str, url, validTimezone } from "./validate";
import type { TenantSettings } from "../env";

export const configApi = new Hono<AppEnv>();

// ------------------------------------------------------------------ settings
configApi.get("/settings", async (c) => {
  const t = c.get("tenant");
  const s = await c.env.DB.prepare("SELECT * FROM tenant_settings WHERE tenant_id = ?").bind(t.id).first<TenantSettings>();
  return c.json({
    ...s, opt_out_keywords: safeJson<string[]>(s?.opt_out_keywords, []), opt_in_keywords: safeJson<string[]>(s?.opt_in_keywords, []),
    business_name: s?.business_name ?? t.business_name,
  });
});

configApi.put("/settings", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  const tz = str(b.timezone, "Time zone", { max: 64 })!;
  if (!validTimezone(tz)) throw new HttpError(400, "Unknown time zone");
  const kw = (v: unknown, f: string) => {
    if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== "string" || x.length > 40)) throw new HttpError(400, `${f} must be a list of short words`);
    return JSON.stringify(v.map((x: string) => x.trim()).filter(Boolean));
  };
  await c.env.DB.prepare(
    `UPDATE tenant_settings SET business_name = ?, timezone = ?, default_language = ?, delivery_mode = ?, default_delay_seconds = ?,
       website_url = ?, retention_days = ?, handover_enabled = ?, handover_timeout_minutes = ?, category_change_policy = ?,
       opt_out_keywords = ?, opt_in_keywords = ?, reopen_template_name = ?, reopen_template_language = ?, notification_email = ?, updated_at = ?
     WHERE tenant_id = ?`,
  ).bind(
    str(b.business_name, "Business name", { max: 120 }), tz, str(b.default_language, "Language", { max: 10 }) ?? "en",
    oneOf(b.delivery_mode, "Delivery mode", ["automatic", "manual", "hybrid"] as const),
    int(b.default_delay_seconds, "Default delay", 0, 86_400 * 7), url(b.website_url, "Website URL"),
    int(b.retention_days, "Retention days", 0, 3650), b.handover_enabled ? 1 : 0, int(b.handover_timeout_minutes, "Handover timeout", 0, 10_080),
    oneOf(b.category_change_policy, "Category change policy", ["restart", "continue"] as const),
    kw(b.opt_out_keywords, "Opt-out keywords"), kw(b.opt_in_keywords, "Opt-in keywords"),
    str(b.reopen_template_name, "Template name", { optional: true, max: 100 }), str(b.reopen_template_language, "Template language", { optional: true, max: 10 }),
    str(b.notification_email, "Notification email", { optional: true, max: 200 }), nowIso(), t.id,
  ).run();
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "settings_updated");
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ categories
configApi.get("/categories", async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM sequence_items i JOIN video_sequences s ON s.id = i.sequence_id WHERE s.category_id = c.id) AS video_count,
            (SELECT active FROM video_sequences s WHERE s.category_id = c.id) AS sequence_active
       FROM business_categories c WHERE c.tenant_id = ? ORDER BY c.sort_order, c.name`,
  ).bind(t.id).all();
  return c.json({ categories: results });
});

configApi.post("/categories", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  const id = newId("cat"); const now = nowIso();
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM business_categories WHERE tenant_id = ?").bind(t.id).first<{ m: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO business_categories (id, tenant_id, name, description, icon, active, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, t.id, str(b.name, "Name", { max: 60 }), str(b.description, "Description", { optional: true, max: 200 }), str(b.icon, "Icon", { optional: true, max: 8 }), b.active === false ? 0 : 1, (max?.m ?? 0) + 1, now),
    c.env.DB.prepare("INSERT INTO video_sequences (id, tenant_id, category_id, active, version, updated_at) VALUES (?,?,?,?,1,?)").bind(newId("seq"), t.id, id, 1, now),
  ]);
  return c.json({ id }, 201);
});

configApi.put("/categories/reorder", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  if (!Array.isArray(b.ids)) throw new HttpError(400, "ids must be a list");
  await c.env.DB.batch(b.ids.map((id: string, i: number) =>
    c.env.DB.prepare("UPDATE business_categories SET sort_order = ? WHERE id = ? AND tenant_id = ?").bind(i + 1, id, t.id)));
  return c.json({ ok: true });
});

configApi.put("/categories/:id", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  const r = await c.env.DB.prepare("UPDATE business_categories SET name = ?, description = ?, icon = ?, active = ? WHERE id = ? AND tenant_id = ?")
    .bind(str(b.name, "Name", { max: 60 }), str(b.description, "Description", { optional: true, max: 200 }), str(b.icon, "Icon", { optional: true, max: 8 }), b.active ? 1 : 0, c.req.param("id"), t.id).run();
  if (!r.meta.changes) throw new HttpError(404, "Category not found");
  return c.json({ ok: true });
});

configApi.delete("/categories/:id", async (c) => {
  const t = c.get("tenant");
  const r = await c.env.DB.prepare("DELETE FROM business_categories WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), t.id).run();
  if (!r.meta.changes) throw new HttpError(404, "Category not found");
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "category_deleted", { id: c.req.param("id") });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ sequences
async function ownedCategory(c: any, categoryId: string) {
  const cat = await c.env.DB.prepare("SELECT id, name FROM business_categories WHERE id = ? AND tenant_id = ?").bind(categoryId, c.get("tenant").id).first();
  if (!cat) throw new HttpError(404, "Category not found");
  return cat;
}

configApi.get("/sequences/:categoryId", async (c) => {
  const t = c.get("tenant"); await ownedCategory(c, c.req.param("categoryId"));
  const seq = await c.env.DB.prepare("SELECT id, active, version FROM video_sequences WHERE category_id = ? AND tenant_id = ?").bind(c.req.param("categoryId"), t.id).first<{ id: string }>();
  if (!seq) throw new HttpError(404, "Sequence not found");
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.video_id, i.position, i.delay_seconds, i.caption, v.title, v.active AS video_active, v.duration_seconds, v.size_bytes
       FROM sequence_items i JOIN videos v ON v.id = i.video_id WHERE i.sequence_id = ? AND i.tenant_id = ? ORDER BY i.position`,
  ).bind(seq.id, t.id).all();
  return c.json({ sequence: seq, items: results });
});

/** Replace the full ordered list in one request (drag-and-drop editor saves the whole order). */
configApi.put("/sequences/:categoryId", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  await ownedCategory(c, c.req.param("categoryId"));
  const seq = await c.env.DB.prepare("SELECT id FROM video_sequences WHERE category_id = ? AND tenant_id = ?").bind(c.req.param("categoryId"), t.id).first<{ id: string }>();
  if (!seq) throw new HttpError(404, "Sequence not found");
  if (!Array.isArray(b.items) || b.items.length > 50) throw new HttpError(400, "items must be a list of at most 50 videos");
  const ids = [...new Set(b.items.map((i: any) => String(i.video_id)))] as string[];
  if (ids.length) {
    const { results } = await c.env.DB.prepare(`SELECT id FROM videos WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(t.id, ...ids).all<{ id: string }>();
    if (results.length !== ids.length) throw new HttpError(400, "One or more videos do not belong to this account"); // cross-tenant guard
  }
  const stmts = [
    c.env.DB.prepare("DELETE FROM sequence_items WHERE sequence_id = ? AND tenant_id = ?").bind(seq.id, t.id),
    ...b.items.map((it: any, i: number) =>
      c.env.DB.prepare("INSERT INTO sequence_items (id, tenant_id, sequence_id, video_id, position, delay_seconds, caption) VALUES (?,?,?,?,?,?,?)")
        .bind(newId("itm"), t.id, seq.id, String(it.video_id), i + 1,
          it.delay_seconds === null || it.delay_seconds === undefined ? null : int(it.delay_seconds, "Delay", 0, 86_400 * 7),
          str(it.caption, "Caption", { optional: true, max: 1024 }))),
    c.env.DB.prepare("UPDATE video_sequences SET active = ?, version = version + 1, updated_at = ? WHERE id = ?").bind(b.active === false ? 0 : 1, nowIso(), seq.id),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

configApi.post("/sequences/:categoryId/duplicate", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  await ownedCategory(c, c.req.param("categoryId")); await ownedCategory(c, String(b.to_category_id));
  const from = await c.env.DB.prepare("SELECT id FROM video_sequences WHERE category_id = ? AND tenant_id = ?").bind(c.req.param("categoryId"), t.id).first<{ id: string }>();
  const to = await c.env.DB.prepare("SELECT id FROM video_sequences WHERE category_id = ? AND tenant_id = ?").bind(String(b.to_category_id), t.id).first<{ id: string }>();
  if (!from || !to) throw new HttpError(404, "Sequence not found");
  const { results } = await c.env.DB.prepare("SELECT video_id, position, delay_seconds, caption FROM sequence_items WHERE sequence_id = ? AND tenant_id = ? ORDER BY position").bind(from.id, t.id).all<any>();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sequence_items WHERE sequence_id = ? AND tenant_id = ?").bind(to.id, t.id),
    ...results.map((r) => c.env.DB.prepare("INSERT INTO sequence_items (id, tenant_id, sequence_id, video_id, position, delay_seconds, caption) VALUES (?,?,?,?,?,?,?)")
      .bind(newId("itm"), t.id, to.id, r.video_id, r.position, r.delay_seconds, r.caption)),
    c.env.DB.prepare("UPDATE video_sequences SET version = version + 1, updated_at = ? WHERE id = ?").bind(nowIso(), to.id),
  ]);
  return c.json({ ok: true, copied: results.length });
});

// ------------------------------------------------------------------ message templates
configApi.get("/templates", async (c) => {
  const t = c.get("tenant"); const lang = c.req.query("language") ?? "en";
  const { results } = await c.env.DB.prepare("SELECT key, language, body FROM message_templates WHERE tenant_id = ?").bind(t.id).all<{ key: string; language: string; body: string }>();
  const custom = new Map(results.filter((r) => r.language === lang).map((r) => [r.key, r.body]));
  return c.json({
    language: lang,
    languages: [...new Set(["en", lang, ...results.map((r) => r.language)])],
    templates: Object.entries(DEFAULT_TEMPLATES).map(([key, d]) => ({ key, label: d.label, default: d.body, body: custom.get(key) ?? null })),
  });
});

configApi.put("/templates", async (c) => {
  const t = c.get("tenant"); const b = await json(c);
  const key = str(b.key, "Template key", { max: 60 })!;
  if (!(key in DEFAULT_TEMPLATES)) throw new HttpError(400, "Unknown template key");
  const lang = str(b.language, "Language", { max: 10 }) ?? "en";
  if (b.body === null || b.body === undefined) {
    await c.env.DB.prepare("DELETE FROM message_templates WHERE tenant_id = ? AND key = ? AND language = ?").bind(t.id, key, lang).run();
  } else {
    if (typeof b.body !== "string" || b.body.length > 4000) throw new HttpError(400, "Message is too long");
    await c.env.DB.prepare(
      `INSERT INTO message_templates (id, tenant_id, key, language, body, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (tenant_id, key, language) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    ).bind(newId("tpl"), t.id, key, lang, b.body, nowIso()).run();
  }
  return c.json({ ok: true });
});
