import { useState } from "react";
import { get } from "../api";
import { BarChart, Card, Field, HBar, Input, Loading, Notice, PageHeader, Select, Stat, useLoad } from "../ui";
import { formatMoney } from "../currencies";
import { t } from "../i18n";

export function Analytics() {
  const [days, setDays] = useState(30);
  const q = useLoad(() => get("/analytics?days=" + days), [days]);
  const [rate, setRate] = useState("");
  const cfg = useLoad(() => get("/settings"), []);
  const currency: string = cfg.data?.currency ?? "USD";
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <Notice tone="error">{q.error}</Notice>;
  const a = q.data, tot = a.totals;
  return (
    <>
      <PageHeader title={t("Analytics")} actions={<Select value={days} onChange={(e) => setDays(+e.target.value)} aria-label={t("Date range")}><option value={7}>{t("Last 7 days")}</option><option value={30}>{t("Last 30 days")}</option><option value={90}>{t("Last 90 days")}</option><option value={365}>{t("Last 12 months")}</option></Select>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("Customers")} value={tot.customers} /><Stat label={t("Completion rate")} value={`${tot.completion_rate}%`} hint={`${tot.completed} of ${tot.started} started`} />
        <Stat label={t("Website invitations")} value={tot.website_sent} /><Stat label={t("Failed messages")} value={tot.messages_failed} />
        <Stat label={t("Videos submitted")} value={tot.videos_submitted} /><Stat label={t("Videos delivered")} value={tot.videos_delivered} hint={t("per WhatsApp delivery receipts")} /><Stat label={t("Videos failed")} value={tot.videos_failed} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t("Customers per category")}><HBar rows={a.perCategory.map((c: any) => ({ label: c.name, value: c.customers, sub: `${c.customers} · ${c.completed} completed` }))} /></Card>
        <Card title={t("Drop-off points")}><BarChart data={a.dropoff.map((d: any) => ({ label: d.reached === 0 ? "none" : `after ${d.reached}`, value: d.conversations }))} />
          <p className="mt-2 text-xs text-slate-500">{t("Conversations by the number of videos they received before stopping.")}</p></Card>
        <Card className="lg:col-span-2" title={t("Customer interaction trend")}><BarChart data={a.trend.map((d: any) => ({ label: d.day.slice(5), value: d.started, value2: d.completed }))} /></Card>
        <Card className="lg:col-span-2" title={t("Failure statistics")}>{a.failures.length === 0 ? <p className="py-4 text-center text-sm text-slate-400">{t("No failed messages 🎉")}</p> : <ul className="divide-y divide-slate-100 text-sm">{a.failures.map((f: any, i: number) => <li key={i} className="flex justify-between gap-3 py-2"><span className="truncate">{f.error || "Unknown error"}</span><span className="font-medium">{f.n}</span></li>)}</ul>}</Card>
      </div>
      <Card className="mt-4" title={t("Meta messaging cost estimate (informational)")}>
        <p className="mb-3 text-sm text-slate-600">{t("WhatsApp charges are billed by Meta directly to you and vary by country and message category. Enter the per-message or per-conversation rate from your own")} <a className="underline" href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noreferrer">{t("Meta rate card")}</a>; nothing here is a quote.</p>
        <div className="flex flex-wrap items-end gap-4">
          <Field label={`${t("Your rate per presentation")} (${currency})`}><Input type="number" min={0} step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} className="!w-56" placeholder="0.00" /></Field>
          <div className="pb-2 text-sm"><div className="text-slate-500">{tot.started} presentations × rate</div>
            <div className="text-2xl font-semibold">{rate ? formatMoney(tot.started * parseFloat(rate), currency) : "—"} <span className="text-xs font-normal text-slate-500">{t("estimate only")}</span></div></div>
        </div>
      </Card>
      <p className="mt-4 text-xs text-slate-500">{t(a.note)}</p>
    </>
  );
}
