import { useRef, useState } from "react";
import { AlertTriangle, CloudUpload, Film, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import { BASE, del, get, post, put } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, Notice, PageHeader, StatusBadge, Textarea, fmtBytes, fmtDur, useAction, useLoad, useUi } from "../ui";
import { t } from "../i18n";

function readDuration(file: File): Promise<number | null> {
  return new Promise((res) => {
    const v = document.createElement("video"); v.preload = "metadata";
    v.onloadedmetadata = () => { res(Number.isFinite(v.duration) ? Math.round(v.duration) : null); URL.revokeObjectURL(v.src); };
    v.onerror = () => res(null); v.src = URL.createObjectURL(file);
  });
}

export function Videos() {
  const q = useLoad(() => get("/videos"));
  const { busy, run } = useAction(); const { confirm, toast } = useUi();
  const [upload, setUpload] = useState<{ file: File; title: string; caption: string; description: string; duration: number | null } | null>(null);
  const [edit, setEdit] = useState<any | null>(null); const [preview, setPreview] = useState<any | null>(null);
  const fileRef = useRef<HTMLInputElement>(null); const replaceRef = useRef<HTMLInputElement>(null); const replaceId = useRef("");
  if (q.loading && !q.data) return <Loading />;
  const limits = q.data?.limits; const videos: any[] = q.data?.videos ?? [];

  const pick = async (f?: File | null) => {
    if (!f) return;
    if (limits && f.size > limits.maxBytes) { toast(`That file is ${fmtBytes(f.size)}. WhatsApp allows up to ${fmtBytes(limits.maxBytes)} per video. Please compress it first.`, "error"); return; }
    if (limits && !limits.mimeTypes.includes(f.type)) { toast("Unsupported format. Use MP4 (H.264 video + AAC audio).", "error"); return; }
    setUpload({ file: f, title: f.name.replace(/\.[^.]+$/, ""), caption: "", description: "", duration: await readDuration(f) });
  };
  const doUpload = async () => {
    if (!upload) return;
    const fd = new FormData(); fd.set("file", upload.file); fd.set("title", upload.title); fd.set("caption", upload.caption); fd.set("description", upload.description);
    if (upload.duration) fd.set("duration", String(upload.duration));
    const ok = await run(() => post("/videos", fd), "Video uploaded");
    if (ok) { setUpload(null); q.reload(); }
  };
  const remove = async (v: any) => {
    if (!(await confirm({ title: `Delete "${v.title}"?`, body: t("It will also be removed from every sequence that uses it."), danger: true, confirmLabel: t("Delete") }))) return;
    await run(() => del(`/videos/${v.id}`), "Deleted"); q.reload();
  };
  const toWa = async (v: any) => { await run(() => post(`/videos/${v.id}/upload-media`), "Uploaded to WhatsApp"); q.reload(); };

  return (
    <>
      <PageHeader title={t("Video library")} subtitle={`MP4 (H.264 + AAC) up to ${limits ? fmtBytes(limits.maxBytes) : "16 MB"}. Videos are stored privately and sent to customers as native WhatsApp video attachments.`}
        actions={<Button onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />{t("Upload video")}</Button>} />
      <input ref={fileRef} type="file" accept="video/mp4,video/3gpp" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={replaceRef} type="file" accept="video/mp4,video/3gpp" className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; const fd = new FormData(); fd.set("file", f);
        await run(() => post(`/videos/${replaceId.current}/replace`, fd), "Video replaced"); q.reload(); }} />
      {q.error && <Notice tone="error">{q.error}</Notice>}
      {videos.length === 0 ? <Empty icon={<Film className="h-10 w-10" />} title={t("Your library is empty")} hint={t("Upload the videos you want to send, then arrange them into sequences for each category.")} action={<Button onClick={() => fileRef.current?.click()}>{t("Upload your first video")}</Button>} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {videos.map((v) => (
            <Card key={v.id}>
              <div className="flex gap-3">
                <button onClick={() => setPreview(v)} aria-label={`Preview ${v.title}`} className="group relative h-24 w-36 shrink-0 overflow-hidden rounded-xl bg-slate-900">
                  <video src={`${BASE}/videos/${v.id}/stream#t=0.5`} preload="metadata" muted className="h-full w-full object-cover opacity-80 group-hover:opacity-100" />
                  <span className="absolute inset-0 flex items-center justify-center text-white/90">▶</span></button>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold">{v.title}</h3>
                  <p className="text-xs text-slate-500">{fmtBytes(v.size_bytes)} · {fmtDur(v.duration_seconds)} · v{v.version}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">{v.categories ? `Used in: ${v.categories}` : "Not used in any sequence"}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {v.media_status === "uploaded" ? <Badge tone="green">{t("Ready on WhatsApp")}</Badge> : v.media_status === "failed" ? <Badge tone="red">{t("WhatsApp upload failed")}</Badge> : <Badge tone="slate">{t("Uploads on first send")}</Badge>}
                    {v.issues.filter((i: any) => i.level === "error").map((i: any) => <Badge key={i.message} tone="red">{t("Invalid")}</Badge>)}
                  </div>
                </div></div>
              {v.media_error && <p className="mt-2 flex gap-1 text-xs text-rose-600"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{v.media_error}</p>}
              {v.issues.filter((i: any) => i.level === "error").map((i: any) => <p key={i.message} className="mt-2 text-xs text-rose-600">{i.message}</p>)}
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                <Button variant="secondary" className="min-h-9 px-3" loading={busy} onClick={() => toWa(v)}><CloudUpload className="h-4 w-4" />{v.media_status === "failed" ? "Retry upload" : "Upload to WhatsApp"}</Button>
                <Button variant="ghost" className="min-h-9 px-3" onClick={() => setEdit({ ...v })}><Pencil className="h-4 w-4" />{t("Edit")}</Button>
                <Button variant="ghost" className="min-h-9 px-3" onClick={() => { replaceId.current = v.id; replaceRef.current?.click(); }}><RefreshCw className="h-4 w-4" />{t("Replace")}</Button>
                <Button variant="ghost" className="min-h-9 px-3 text-rose-600" onClick={() => remove(v)}><Trash2 className="h-4 w-4" />{t("Delete")}</Button>
              </div>
            </Card>))}
        </div>)}

      <Modal open={!!upload} onClose={() => setUpload(null)} title={t("Upload video")}>
        {upload && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void doUpload(); }}>
          <p className="text-sm text-slate-500">{upload.file.name} · {fmtBytes(upload.file.size)}{upload.duration ? ` · ${fmtDur(upload.duration)}` : ""}</p>
          <Field label={t("Title")}><Input required maxLength={120} value={upload.title} onChange={(e) => setUpload({ ...upload, title: e.target.value })} /></Field>
          <Field label={t("WhatsApp caption (optional)")} hint={t("Shown under the video in the chat.")}><Textarea maxLength={1024} value={upload.caption} onChange={(e) => setUpload({ ...upload, caption: e.target.value })} /></Field>
          <Field label={t("Internal description (optional)")}><Input maxLength={500} value={upload.description} onChange={(e) => setUpload({ ...upload, description: e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setUpload(null)}>{t("Cancel")}</Button><Button type="submit" loading={busy}>{t("Upload")}</Button></div>
        </form>}
      </Modal>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={t("Edit video")}>
        {edit && <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const ok = await run(() => put(`/videos/${edit.id}`, edit), "Saved"); if (ok) { setEdit(null); q.reload(); } }}>
          <Field label={t("Title")}><Input required maxLength={120} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
          <Field label={t("WhatsApp caption")}><Textarea maxLength={1024} value={edit.caption ?? ""} onChange={(e) => setEdit({ ...edit, caption: e.target.value })} /></Field>
          <Field label={t("Internal description")}><Input maxLength={500} value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEdit(null)}>{t("Cancel")}</Button><Button type="submit" loading={busy}>{t("Save")}</Button></div>
        </form>}
      </Modal>
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.title ?? ""} wide>
        {preview && <video src={`${BASE}/videos/${preview.id}/stream`} controls autoPlay className="max-h-[70vh] w-full rounded-xl bg-black" />}
        {preview?.caption && <p className="mt-3 text-sm text-slate-600">Caption: {preview.caption}</p>}
        {preview && <div className="mt-2"><StatusBadge value={preview.media_status ?? "queued"} /></div>}
      </Modal>
    </>
  );
}
