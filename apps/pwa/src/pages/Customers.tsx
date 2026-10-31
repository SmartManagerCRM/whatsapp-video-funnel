import { useState } from "react";
import { Download, Search, Trash2, Users } from "lucide-react";
import { BASE, del, get, post } from "../api";
import { Button, Card, Empty, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, fmtDate, useAction, useLoad, useUi } from "../ui";

export function Customers() {
  const [search, setSearch] = useState(""); const [status, setStatus] = useState(""); const [cat, setCat] = useState(""); const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ search, status, category: cat, page: String(page) }).toString();
  const q = useLoad(() => get("/customers?" + qs), [qs]);
  const cats = useLoad(() => get("/categories"), []);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useLoad(() => (open ? get(`/customers/${open}`) : Promise.resolve(null)), [open]);
  const { run } = useAction(); const { confirm } = useUi();
  const d = q.data;
  return (
    <>
      <PageHeader title="Customers" subtitle="Everyone who has messaged your WhatsApp number."
        actions={<><a href={`${BASE}/customers.csv?${new URLSearchParams({ search, status, category: cat })}`}><Button variant="secondary"><Download className="h-4 w-4" />Export CSV</Button></a>
          <Button variant="secondary" onClick={async () => { const days = prompt("Delete customers with no activity for how many days? (e.g. 365)"); const n = days ? parseInt(days, 10) : 0; if (!n) return;
            if (await confirm({ title: `Delete customers inactive for ${n}+ days?`, body: "This permanently removes their records and message history.", danger: true, confirmLabel: "Delete" })) { const r = await run(() => post("/customers/bulk-delete", { before: new Date(Date.now() - n * 86400000).toISOString() })); if (r) { q.reload(); } } }}><Trash2 className="h-4 w-4" />Bulk delete…</Button></>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-52 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input className="pl-9" placeholder="Search name or phone" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status"><option value="">All statuses</option>{["new", "in_progress", "waiting", "completed", "human_handling", "paused", "opted_out", "failed"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</Select>
        <Select value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }} aria-label="Category"><option value="">All categories</option>{(cats.data?.categories ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      </div>
      {q.loading && !d ? <Loading /> : q.error ? <Notice tone="error">{q.error}</Notice> : d.customers.length === 0 ? <Empty icon={<Users className="h-10 w-10" />} title="No customers found" hint="Customers appear here as soon as they message your WhatsApp number." /> : (
        <Card className="overflow-hidden !p-0">
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Category</th><th className="px-4 py-3">Progress</th><th className="px-4 py-3">Last activity</th><th className="px-4 py-3">Status</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{d.customers.map((c: any) => (
              <tr key={c.id} onClick={() => setOpen(c.id)} className="cursor-pointer hover:bg-slate-50">
                <td className="px-4 py-3"><div className="font-medium">{c.name || "—"}</div><div className="text-xs text-slate-500">+{c.wa_phone}</div></td>
                <td className="px-4 py-3">{c.category_name ?? "—"}</td>
                <td className="px-4 py-3">{c.total_videos ? <div className="w-28"><div className="text-xs text-slate-500">{c.videos_sent ?? 0}/{c.total_videos} videos</div><div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${Math.min(100, ((c.videos_sent ?? 0) / c.total_videos) * 100)}%` }} /></div></div> : "—"}</td>
                <td className="px-4 py-3 text-slate-500">{fmtDate(c.last_interaction_at)}</td>
                <td className="px-4 py-3"><StatusBadge value={c.status} /></td></tr>))}</tbody></table></div>
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-500"><span>{d.total} customers</span>
            <div className="flex gap-2"><Button variant="secondary" className="min-h-9" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" className="min-h-9" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>Next</Button></div></div>
        </Card>)}
      <Modal open={!!open} onClose={() => setOpen(null)} title="Customer profile" wide>
        {detail.loading || !detail.data ? <Loading /> : (() => { const c = detail.data.customer; return (<div className="space-y-4">
          <div className="grid gap-2 text-sm sm:grid-cols-2"><div><span className="text-slate-500">Name</span><div className="font-medium">{c.name || "—"}</div></div><div><span className="text-slate-500">Phone</span><div className="font-medium">+{c.wa_phone}</div></div>
            <div><span className="text-slate-500">Category</span><div className="font-medium">{c.category_name ?? "—"}</div></div><div><span className="text-slate-500">Status</span><div><StatusBadge value={c.status} /> <StatusBadge value={c.window} /></div></div>
            <div><span className="text-slate-500">First contact</span><div>{fmtDate(c.first_interaction_at)}</div></div><div><span className="text-slate-500">Videos sent</span><div>{c.videos_sent ?? 0} / {c.total_videos ?? 0}</div></div></div>
          <div className="flex gap-2">{c.conversation_id && <a href={`#/conversations/${c.conversation_id}`}><Button variant="secondary">Open conversation</Button></a>}
            <Button variant="danger" onClick={async () => { if (await confirm({ title: "Delete this customer?", body: "Their record and full history are permanently deleted.", danger: true, confirmLabel: "Delete" })) { await run(() => del(`/customers/${c.id}`), "Customer deleted"); setOpen(null); q.reload(); } }}><Trash2 className="h-4 w-4" />Delete</Button></div>
          <div><h3 className="mb-2 text-sm font-semibold">Timeline</h3><ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm">{detail.data.events.map((e: any, i: number) => (<li key={i} className="flex justify-between gap-3 border-b border-slate-100 pb-1.5"><span>{e.type.replace(/_/g, " ")}{e.type === "state_change" && e.data ? ` → ${JSON.parse(e.data).to}` : ""}</span><span className="shrink-0 text-xs text-slate-500">{fmtDate(e.created_at)}</span></li>))}</ul></div></div>); })()}
      </Modal>
    </>
  );
}
