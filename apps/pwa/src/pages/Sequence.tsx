import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Save, X } from "lucide-react";
import { BASE, get, post, put } from "../api";
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, Notice, PageHeader, Select, Toggle, fmtDur, useAction, useLoad } from "../ui";

interface Item { video_id: string; title: string; delay_seconds: number | null; caption: string | null; duration_seconds?: number | null }

export function SequenceBuilder({ categoryId }: { categoryId?: string }) {
  const cats = useLoad(() => get("/categories"));
  const vids = useLoad(() => get("/videos"));
  const [sel, setSel] = useState(categoryId ?? "");
  const [items, setItems] = useState<Item[]>([]); const [active, setActive] = useState(true); const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false); const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState<number | null>(null); const [preview, setPreview] = useState(false); const [dup, setDup] = useState(false); const [dupTo, setDupTo] = useState("");
  const { busy, run } = useAction();

  useEffect(() => { if (!sel && cats.data?.categories?.length) setSel(categoryId ?? cats.data.categories[0].id); }, [cats.data, sel, categoryId]);
  useEffect(() => {
    if (!sel) return; setLoading(true);
    get(`/sequences/${sel}`).then((d) => { setItems(d.items.map((i: any) => ({ video_id: i.video_id, title: i.title, delay_seconds: i.delay_seconds, caption: i.caption, duration_seconds: i.duration_seconds }))); setActive(!!d.sequence.active); setVersion(d.sequence.version); setDirty(false); })
      .catch(() => undefined).finally(() => setLoading(false));
  }, [sel]);

  if ((cats.loading && !cats.data) || (vids.loading && !vids.data)) return <Loading />;
  const categories: any[] = cats.data?.categories ?? []; const library: any[] = vids.data?.videos ?? [];
  if (categories.length === 0) return <><PageHeader title="Sequences" /><Empty title="Create a category first" hint="Each category has its own video sequence." action={<a href="#/categories"><Button>Go to categories</Button></a>} /></>;

  const mutate = (fn: (a: Item[]) => Item[]) => { setItems((a) => fn([...a])); setDirty(true); };
  const move = (i: number, d: number) => mutate((a) => { const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const save = async () => { const ok = await run(() => put(`/sequences/${sel}`, { active, items: items.map((i) => ({ video_id: i.video_id, delay_seconds: i.delay_seconds, caption: i.caption || null })) }), "Sequence saved"); if (ok) { setDirty(false); setVersion((v) => v + 1); cats.reload(); } };
  const total = items.reduce((s, i) => s + (i.duration_seconds ?? 0), 0);

  return (
    <>
      <PageHeader title="Sequence builder" subtitle="Drag videos to reorder. Set a delay after each video, or leave it blank to use your default."
        actions={<>
          <Select value={sel} onChange={(e) => { if (!dirty || confirm("Discard unsaved changes?")) setSel(e.target.value); }} aria-label="Category">{categories.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}</Select>
          <Button variant="secondary" onClick={() => setPreview(true)} disabled={!items.length}>Preview</Button>
          <Button variant="secondary" onClick={() => setDup(true)}><Copy className="h-4 w-4" />Duplicate to…</Button>
          <Button onClick={save} loading={busy} disabled={!dirty}><Save className="h-4 w-4" />Save</Button></>} />
      {loading ? <Loading /> : (
        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3" title={<span className="flex items-center gap-2">Order <Badge tone="slate">v{version}</Badge>{items.length > 0 && <span className="text-xs font-normal text-slate-500">{items.length} videos{total ? ` · ${fmtDur(total)}` : ""}</span>}</span>}
            action={<label className="flex items-center gap-2 text-sm text-slate-600">Active <Toggle checked={active} label="Sequence active" onChange={(v) => { setActive(v); setDirty(true); }} /></label>}>
            {items.length === 0 ? <Empty title="No videos in this sequence" hint="Add videos from your library on the right." /> : (
              <ol className="space-y-2">
                {items.map((it, i) => (
                  <li key={it.video_id + i} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (drag === null || drag === i) return; mutate((a) => { const [m] = a.splice(drag, 1); a.splice(i, 0, m); return a; }); setDrag(null); }}
                    className={"rounded-xl border bg-white p-3 shadow-sm " + (drag === i ? "border-brand-500 opacity-60" : "border-slate-200")}>
                    <div className="flex items-center gap-2">
                      <GripVertical className="h-5 w-5 shrink-0 cursor-grab text-slate-400" aria-hidden />
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{it.title}</span>
                      <button aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                      <button aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                      <button aria-label="Remove" onClick={() => mutate((a) => { a.splice(i, 1); return a; })} className="rounded p-1.5 text-rose-600 hover:bg-rose-50"><X className="h-4 w-4" /></button>
                    </div>
                    <div className="mt-2 grid gap-2 pl-9 sm:grid-cols-3">
                      <Field label="Delay after (sec)"><Input type="number" min={0} placeholder="default" value={it.delay_seconds ?? ""} onChange={(e) => mutate((a) => { a[i] = { ...a[i], delay_seconds: e.target.value === "" ? null : Math.max(0, +e.target.value) }; return a; })} /></Field>
                      <div className="sm:col-span-2"><Field label="Caption (overrides the video's caption)"><Input maxLength={1024} value={it.caption ?? ""} onChange={(e) => mutate((a) => { a[i] = { ...a[i], caption: e.target.value || null }; return a; })} /></Field></div>
                    </div>
                  </li>))}
              </ol>)}
            {items.length > 0 && <p className="mt-3 text-xs text-slate-500">After the last video, customers automatically receive your website invitation, link and goodbye message.</p>}
          </Card>
          <Card className="lg:col-span-2" title="Video library">
            {library.length === 0 ? <p className="text-sm text-slate-500">Upload videos in the <a className="underline" href="#/videos">Video Library</a> first.</p> : (
              <ul className="space-y-2">{library.map((v) => (
                <li key={v.id} className="flex items-center gap-2 rounded-xl border border-slate-200 p-2.5">
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{v.title}</div><div className="text-xs text-slate-500">{fmtDur(v.duration_seconds)}{items.some((i) => i.video_id === v.id) ? " · in sequence" : ""}</div></div>
                  <Button variant="secondary" className="min-h-9 px-3" disabled={v.issues?.some((x: any) => x.level === "error")} onClick={() => mutate((a) => [...a, { video_id: v.id, title: v.title, delay_seconds: null, caption: null, duration_seconds: v.duration_seconds }])}><Plus className="h-4 w-4" />Add</Button>
                </li>))}</ul>)}
          </Card>
        </div>)}
      <Modal open={preview} onClose={() => setPreview(false)} title="Sequence preview" wide>
        <p className="mb-3 text-sm text-slate-500">Videos play in the order customers receive them.</p>
        <ol className="space-y-4">{items.map((it, i) => (<li key={it.video_id + i}><div className="mb-1 text-sm font-medium">{i + 1}. {it.title}</div>
          <video controls preload="metadata" className="max-h-64 w-full rounded-xl bg-black" src={`${BASE}/videos/${it.video_id}/stream`} />{(it.caption) && <p className="mt-1 text-xs text-slate-500">Caption: {it.caption}</p>}</li>))}</ol>
      </Modal>
      <Modal open={dup} onClose={() => setDup(false)} title="Duplicate this sequence">
        <p className="mb-3 text-sm text-slate-500">Replaces the target category's sequence with a copy of this saved one.</p>
        <Select value={dupTo} onChange={(e) => setDupTo(e.target.value)}><option value="">Choose a category…</option>{categories.filter((c) => c.id !== sel).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setDup(false)}>Cancel</Button><Button disabled={!dupTo} loading={busy} onClick={async () => { if (await run(() => post(`/sequences/${sel}/duplicate`, { to_category_id: dupTo }), "Sequence duplicated")) { setDup(false); cats.reload(); } }}>Duplicate</Button></div>
      </Modal>
      {dirty && <div className="fixed bottom-20 left-1/2 z-30 -translate-x-1/2 lg:bottom-6"><Notice tone="warn">Unsaved changes</Notice></div>}
    </>
  );
}
