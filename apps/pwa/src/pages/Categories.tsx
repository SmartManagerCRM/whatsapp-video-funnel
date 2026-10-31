import { useState } from "react";
import { ListVideo, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { del, get, post, put } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, Notice, PageHeader, Textarea, Toggle, useAction, useLoad, useUi } from "../ui";
import { t } from "../i18n";

export function Categories() {
  const q = useLoad(() => get("/categories"));
  const [edit, setEdit] = useState<any | null>(null);
  const { busy, run } = useAction(); const { confirm } = useUi();
  if (q.loading && !q.data) return <Loading />;
  const save = async () => {
    const body = { name: edit.name, description: edit.description, icon: edit.icon, active: edit.active !== false };
    const ok = await run(() => (edit.id ? put(`/categories/${edit.id}`, body) : post("/categories", body)), "Saved");
    if (ok) { setEdit(null); q.reload(); }
  };
  const remove = async (c: any) => {
    if (!(await confirm({ title: `Delete "${c.name}"?`, body: t("Its video sequence is removed too. Customers keep their history."), danger: true, confirmLabel: t("Delete") }))) return;
    await run(() => del(`/categories/${c.id}`), "Deleted"); q.reload();
  };
  const cats: any[] = q.data?.categories ?? [];
  return (
    <>
      <PageHeader title={t("Business categories")} subtitle={t("Customers choose a category in WhatsApp and receive that category's video sequence.")}
        actions={<Button onClick={() => setEdit({ name: "", description: "", icon: "", active: true })}><Plus className="h-4 w-4" />{t("New category")}</Button>} />
      {q.error && <Notice tone="error">{q.error}</Notice>}
      {cats.length === 0 ? <Empty icon={<Tags className="h-10 w-10" />} title={t("No categories yet")} hint={t("Create categories such as Restaurant, Café or Retail Shop, then add videos to each.")} action={<Button onClick={() => setEdit({ name: "", active: true })}>{t("Create your first category")}</Button>} /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cats.map((c) => (
            <Card key={c.id} className={c.active ? "" : "opacity-70"}>
              <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-2xl">{c.icon || "🏷️"}</div>
                <div><h3 className="font-semibold">{c.name}</h3><p className="line-clamp-2 text-xs text-slate-500">{c.description || "No description"}</p></div></div>
                <Toggle checked={!!c.active} label={`Activate ${c.name}`} onChange={async (v) => { await run(() => put(`/categories/${c.id}`, { ...c, active: v })); q.reload(); }} /></div>
              <div className="mt-4 flex items-center justify-between">
                {c.video_count > 0 ? <Badge tone="green">{c.video_count} video{c.video_count > 1 ? "s" : ""}</Badge> : <Badge tone="amber">{t("No videos")}</Badge>}
                <div className="flex gap-1">
                  <a href={`#/sequence/${c.id}`} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-brand-700 hover:bg-brand-50"><ListVideo className="h-4 w-4" />{t("Sequence")}</a>
                  <button aria-label={`Edit ${c.name}`} onClick={() => setEdit({ ...c })} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><Pencil className="h-4 w-4" /></button>
                  <button aria-label={`Delete ${c.name}`} onClick={() => remove(c)} className="rounded-lg p-2 text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" /></button>
                </div></div>
            </Card>))}
        </div>)}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit category" : "New category"}>
        {edit && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label={t("Name")}><Input required maxLength={60} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field>
          <Field label={t("Icon (emoji)")} hint={t("Shown in the dashboard.")}><Input maxLength={4} value={edit.icon ?? ""} onChange={(e) => setEdit({ ...edit, icon: e.target.value })} placeholder="🍽️" /></Field>
          <Field label={t("Description")} hint={t("Shown under the name in the WhatsApp list (max 72 characters are displayed).")}><Textarea maxLength={200} value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEdit(null)}>{t("Cancel")}</Button><Button type="submit" loading={busy}>{t("Save")}</Button></div>
        </form>}
      </Modal>
    </>
  );
}
