import { Hono } from "hono";
import { audit, bump, type AppEnv } from "../auth/session";
import { ensureMedia } from "../automation/engine";
import { sha256Hex } from "../lib/crypto";
import { HttpError, newId, nowIso } from "../lib/util";
import { loadCreds, MEDIA_LIMITS, WaError } from "../whatsapp/client";
import { int, str } from "./validate";

export const videoApi = new Hono<AppEnv>();

export interface VideoIssue { level: "error" | "warning"; message: string }

/** Validation shown to the administrator before a video can be activated. */
export function validateVideo(mime: string, size: number): VideoIssue[] {
  const issues: VideoIssue[] = [];
  if (!MEDIA_LIMITS.videoMimeTypes.includes(mime)) {
    issues.push({ level: "error", message: `Unsupported format ${mime || "(unknown)"}. WhatsApp accepts MP4 (H.264 video + AAC audio) or 3GPP.` });
  }
  if (size > MEDIA_LIMITS.videoMaxBytes) {
    issues.push({ level: "error", message: `File is ${(size / 1048576).toFixed(1)} MB. WhatsApp video messages are limited to ${MEDIA_LIMITS.videoMaxBytes / 1048576} MB. Re-encode it smaller.` });
  }
  if (size === 0) issues.push({ level: "error", message: "The file is empty." });
  if (mime === "video/mp4") issues.push({ level: "warning", message: "Use H.264 video and AAC audio for broad compatibility; other codecs may be rejected by WhatsApp." });
  return issues;
}

const r2Key = (slug: string, id: string) => `tenants/${slug}/videos/${id}.mp4`;

async function readUpload(c: any): Promise<{ file: File; form: FormData }> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) throw new HttpError(400, "Send the video as multipart/form-data");
  const declared = parseInt(c.req.header("content-length") ?? "0", 10);
  if (declared > MEDIA_LIMITS.videoMaxBytes + 1_000_000) throw new HttpError(413, `File too large. Maximum ${MEDIA_LIMITS.videoMaxBytes / 1048576} MB`);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "A video file is required");
  const issues = validateVideo(file.type, file.size).filter((i) => i.level === "error");
  if (issues.length) throw new HttpError(422, issues[0].message, "invalid_video");
  return { file, form };
}

videoApi.get("/videos", async (c) => {
  const t = c.get("tenant");
  const acct = await c.env.DB.prepare("SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = ?").bind(t.id).first<{ phone_number_id: string | null }>();
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.description, v.caption, v.mime_type, v.size_bytes, v.duration_seconds, v.version, v.active, v.created_at,
            (SELECT status FROM media_uploads m WHERE m.video_id = v.id AND m.sha256 = v.sha256 AND m.phone_number_id = ? AND m.tenant_id = v.tenant_id) AS media_status,
            (SELECT error FROM media_uploads m WHERE m.video_id = v.id AND m.sha256 = v.sha256 AND m.phone_number_id = ? AND m.tenant_id = v.tenant_id) AS media_error,
            (SELECT GROUP_CONCAT(c.name, ', ') FROM sequence_items i JOIN video_sequences s ON s.id = i.sequence_id
               JOIN business_categories c ON c.id = s.category_id WHERE i.video_id = v.id) AS categories
       FROM videos v WHERE v.tenant_id = ? ORDER BY v.created_at DESC`,
  ).bind(acct?.phone_number_id ?? "", acct?.phone_number_id ?? "", t.id).all<any>();
  return c.json({
    limits: { maxBytes: MEDIA_LIMITS.videoMaxBytes, mimeTypes: MEDIA_LIMITS.videoMimeTypes },
    videos: results.map((v) => ({ ...v, issues: validateVideo(v.mime_type, v.size_bytes) })),
  });
});

videoApi.post("/videos", async (c) => {
  const t = c.get("tenant");
  const { file, form } = await readUpload(c);
  const id = newId("vid"); const key = r2Key(t.slug, id);
  const bytes = await file.arrayBuffer();
  const hash = await sha256Hex(bytes);
  await c.env.VIDEOS.put(key, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { tenant: t.id } });
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO videos (id, tenant_id, title, description, caption, r2_key, mime_type, size_bytes, duration_seconds, sha256, version, active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,1,?,?)`,
  ).bind(id, t.id, str(form.get("title") as string, "Title", { max: 120 }), str(form.get("description") as string, "Description", { optional: true, max: 500 }),
    str(form.get("caption") as string, "Caption", { optional: true, max: 1024 }), key, file.type, file.size,
    form.get("duration") ? int(form.get("duration"), "Duration", 0, 36000) : null, hash, now, now).run();
  await bump(c.env, t.id, "video_upload_bytes", file.size);
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "video_uploaded", { id });
  return c.json({ id, issues: validateVideo(file.type, file.size) }, 201);
});

videoApi.put("/videos/:id", async (c) => {
  const t = c.get("tenant");
  const b = await c.req.json().catch(() => ({}));
  const r = await c.env.DB.prepare("UPDATE videos SET title = ?, description = ?, caption = ?, active = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(str(b.title, "Title", { max: 120 }), str(b.description, "Description", { optional: true, max: 500 }), str(b.caption, "Caption", { optional: true, max: 1024 }),
      b.active === false ? 0 : 1, nowIso(), c.req.param("id"), t.id).run();
  if (!r.meta.changes) throw new HttpError(404, "Video not found");
  return c.json({ ok: true });
});

/** Replace the file. New hash/version ⇒ previously uploaded Meta media IDs are no longer used. */
videoApi.post("/videos/:id/replace", async (c) => {
  const t = c.get("tenant");
  const row = await c.env.DB.prepare("SELECT id, r2_key FROM videos WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), t.id).first<{ id: string; r2_key: string }>();
  if (!row) throw new HttpError(404, "Video not found");
  const { file } = await readUpload(c);
  const bytes = await file.arrayBuffer();
  await c.env.VIDEOS.put(row.r2_key, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { tenant: t.id } });
  await c.env.DB.prepare("UPDATE videos SET mime_type = ?, size_bytes = ?, sha256 = ?, version = version + 1, updated_at = ? WHERE id = ?")
    .bind(file.type, file.size, await sha256Hex(bytes), nowIso(), row.id).run();
  await bump(c.env, t.id, "video_upload_bytes", file.size);
  return c.json({ ok: true, issues: validateVideo(file.type, file.size) });
});

videoApi.delete("/videos/:id", async (c) => {
  const t = c.get("tenant");
  const row = await c.env.DB.prepare("SELECT r2_key FROM videos WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), t.id).first<{ r2_key: string }>();
  if (!row) throw new HttpError(404, "Video not found");
  await c.env.DB.prepare("DELETE FROM videos WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), t.id).run();
  await c.env.VIDEOS.delete(row.r2_key);
  await audit(c.env, t.id, "tenant_user", c.get("session").userId, "video_deleted", { id: c.req.param("id") });
  return c.json({ ok: true });
});

/** Authenticated preview stream with Range support. The key always comes from D1, scoped by tenant. */
videoApi.get("/videos/:id/stream", async (c) => {
  const t = c.get("tenant");
  const row = await c.env.DB.prepare("SELECT r2_key, mime_type, size_bytes FROM videos WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), t.id).first<{ r2_key: string; mime_type: string; size_bytes: number }>();
  if (!row) throw new HttpError(404, "Video not found");
  const range = c.req.header("range")?.match(/bytes=(\d*)-(\d*)/);
  let offset = 0; let length = row.size_bytes;
  if (range) {
    offset = range[1] ? parseInt(range[1], 10) : Math.max(0, row.size_bytes - parseInt(range[2], 10));
    const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), row.size_bytes - 1) : row.size_bytes - 1;
    length = end - offset + 1;
  }
  const obj = await c.env.VIDEOS.get(row.r2_key, range ? { range: { offset, length } } : undefined);
  if (!obj) throw new HttpError(404, "File missing from storage");
  const headers: Record<string, string> = { "Content-Type": row.mime_type, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "Content-Length": String(length) };
  if (range) headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${row.size_bytes}`;
  return new Response(obj.body, { status: range ? 206 : 200, headers });
});

/** Upload (or retry the upload of) a video to WhatsApp so it is ready to send. */
videoApi.post("/videos/:id/upload-media", async (c) => {
  const t = c.get("tenant");
  const v = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ? AND tenant_id = ?").bind(c.req.param("id"), t.id).first<any>();
  if (!v) throw new HttpError(404, "Video not found");
  const issues = validateVideo(v.mime_type, v.size_bytes).filter((i) => i.level === "error");
  if (issues.length) throw new HttpError(422, issues[0].message);
  const creds = await loadCreds(c.env, t.id);
  if (!creds) throw new HttpError(409, "Connect WhatsApp first");
  try {
    const mediaId = await ensureMedia(c.env, creds, v, true);
    return c.json({ ok: true, media_id_suffix: mediaId.slice(-4) });
  } catch (e) {
    if (e instanceof WaError) throw new HttpError(502, `WhatsApp rejected the upload: ${e.message}`, "media_upload_failed");
    throw e;
  }
});
