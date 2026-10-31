import { useState } from "react";
import { get } from "../api";
import { BarChart, Card, Field, HBar, Input, Loading, Notice, PageHeader, Select, Stat, useLoad } from "../ui";

export function Analytics() {
  const [days, setDays] = useState(30);
  const q = useLoad(() => get("/analytics?days=" + days), [days]);
  const [rate, setRate] = useState("");
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <Notice tone="error">{q.error}</Notice>;
  const a = q.data, t = a.totals;
  return (
    <>
      <PageHeader title="Analytics" actions={<Select value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Date range"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 12 months</option></Select>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Customers" value={t.customers} /><Stat label="Completion rate" value={`${t.completion_rate}%`} hint={`${t.completed} of ${t.started} started`} />
        <Stat label="Website invitations" value={t.website_sent} /><Stat label="Failed messages" value={t.messages_failed} />
        <Stat label="Videos submitted" value={t.videos_submitted} /><Stat label="Videos delivered" value={t.videos_delivered} hint="per WhatsApp delivery receipts" /><Stat label="Videos failed" value={t.videos_failed} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Customers per category"><HBar rows={a.perCategory.map((c: any) => ({ label: c.name, value: c.customers, sub: `${c.customers} · ${c.completed} completed` }))} /></Card>
        <Card title="Drop-off points"><BarChart data={a.dropoff.map((d: any) => ({ label: d.reached === 0 ? "none" : `after ${d.reached}`, value: d.conversations }))} />
          <p className="mt-2 text-xs text-slate-500">Conversations by the number of videos they received before stopping.</p></Card>
        <Card className="lg:col-span-2" title="Customer interaction trend"><BarChart data={a.trend.map((d: any) => ({ label: d.day.slice(5), value: d.started, value2: d.completed }))} /></Card>
        <Card className="lg:col-span-2" title="Failure statistics">{a.failures.length === 0 ? <p className="py-4 text-center text-sm text-slate-400">No failed messages 🎉</p> : <ul className="divide-y divide-slate-100 text-sm">{a.failures.map((f: any, i: number) => <li key={i} className="flex justify-between gap-3 py-2"><span className="truncate">{f.error || "Unknown error"}</span><span className="font-medium">{f.n}</span></li>)}</ul>}</Card>
      </div>
      <Card className="mt-4" title="Meta messaging cost estimate (informational)">
        <p className="mb-3 text-sm text-slate-600">WhatsApp charges are billed by Meta directly to you and vary by country and message category. Enter the per-message or per-conversation rate from your own <a className="underline" href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noreferrer">Meta rate card</a>; nothing here is a quote.</p>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Your rate per presentation (your currency)"><Input type="number" min={0} step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} className="!w-56" placeholder="0.00" /></Field>
          <div className="pb-2 text-sm"><div className="text-slate-500">{t.started} presentations × rate</div>
            <div className="text-2xl font-semibold">{rate ? (t.started * parseFloat(rate)).toFixed(2) : "—"} <span className="text-xs font-normal text-slate-500">estimate only</span></div></div>
        </div>
      </Card>
      <p className="mt-4 text-xs text-slate-500">{a.note}</p>
    </>
  );
}
