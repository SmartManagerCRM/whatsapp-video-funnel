import { useState } from "react";
import { Activity, CheckCircle2, Clock, Hand, PlayCircle, Users } from "lucide-react";
import { get } from "../api";
import { BarChart, Card, HBar, Loading, Notice, PageHeader, Select, Stat, StatusBadge, fmtDate, useLoad } from "../ui";

export function Dashboard({ tz }: { tz?: string }) {
  const [days, setDays] = useState(30);
  const a = useLoad(() => get("/analytics?days=" + days), [days]);
  const s = useLoad(() => get("/dashboard-status"), []);
  if (a.loading && !a.data) return <Loading />;
  if (a.error) return <Notice tone="error">{a.error}</Notice>;
  const t = a.data.totals;
  return (
    <>
      <PageHeader title="Dashboard" subtitle="How your WhatsApp video presentations are performing."
        actions={<Select value={days} onChange={(e) => setDays(+e.target.value)} aria-label="Date range"><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 12 months</option></Select>} />
      {s.data && (!s.data.automation_enabled || !s.data.license.valid || !["connected", "coexistence_verified"].includes(s.data.whatsapp)) && (
        <div className="mb-5"><Notice tone="warn">Automation isn't fully active yet. Open <a className="font-medium underline" href="#/setup">Setup</a> to finish connecting WhatsApp, activating your license and switching automation on.</Notice></div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Customers" value={t.customers} icon={<Users className="h-4 w-4" />} />
        <Stat label="Presentations started" value={t.started} icon={<PlayCircle className="h-4 w-4" />} />
        <Stat label="Completed" value={t.completed} hint={`${t.completion_rate}% completion rate`} icon={<CheckCircle2 className="h-4 w-4" />} />
        <Stat label="Active now" value={t.active} icon={<Activity className="h-4 w-4" />} />
        <Stat label="Waiting for next video" value={t.waiting} icon={<Clock className="h-4 w-4" />} />
        <Stat label="Human-handled" value={t.human} icon={<Hand className="h-4 w-4" />} />
        <Stat label="Website links sent" value={t.website_sent} />
        <Stat label="Failed conversations" value={t.failed_conversations} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Presentations per day"><BarChart data={a.data.trend.map((d: any) => ({ label: d.day.slice(5), value: d.started, value2: d.completed }))} />
          <p className="mt-2 text-xs text-slate-500">Light = started, dark = completed.</p></Card>
        <Card title="Popular business categories"><HBar rows={a.data.perCategory.map((c: any) => ({ label: c.name, value: c.customers, sub: `${c.customers} · ${c.completed} done` }))} /></Card>
        <Card title="Connections">
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between">WhatsApp {s.data && <StatusBadge value={s.data.whatsapp} />}</li>
            <li className="flex items-center justify-between">License {s.data && <StatusBadge value={s.data.license.valid ? "active" : s.data.license.reason ?? "not_activated"} />}</li>
            <li className="flex items-center justify-between">Automation {s.data && <StatusBadge value={s.data.automation_enabled ? "active" : "paused"} />}</li>
          </ul>
        </Card>
        <Card className="lg:col-span-2" title="Recent activity">
          {a.data.recent.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">No activity yet. Send a message to your WhatsApp number to test.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{a.data.recent.map((r: any, i: number) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2"><span><b className="font-medium">{r.name || r.wa_phone}</b> · {r.type.replace(/_/g, " ")}</span><span className="shrink-0 text-xs text-slate-500">{fmtDate(r.created_at, tz)}</span></li>))}</ul>)}
        </Card>
      </div>
    </>
  );
}
