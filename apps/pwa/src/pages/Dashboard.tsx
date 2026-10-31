import { useState } from "react";
import { Activity, CheckCircle2, Clock, Hand, PlayCircle, Users } from "lucide-react";
import { get } from "../api";
import { BarChart, Card, HBar, Loading, Notice, PageHeader, Select, Stat, StatusBadge, fmtDate, useLoad } from "../ui";
import { t } from "../i18n";

export function Dashboard({ tz }: { tz?: string }) {
  const [days, setDays] = useState(30);
  const a = useLoad(() => get("/analytics?days=" + days), [days]);
  const s = useLoad(() => get("/dashboard-status"), []);
  if (a.loading && !a.data) return <Loading />;
  if (a.error) return <Notice tone="error">{a.error}</Notice>;
  const tot = a.data.totals;
  return (
    <>
      <PageHeader title={t("Dashboard")} subtitle={t("How your WhatsApp video presentations are performing.")}
        actions={<Select value={days} onChange={(e) => setDays(+e.target.value)} aria-label={t("Date range")}><option value={7}>{t("Last 7 days")}</option><option value={30}>{t("Last 30 days")}</option><option value={90}>{t("Last 90 days")}</option><option value={365}>{t("Last 12 months")}</option></Select>} />
      {s.data && (!s.data.automation_enabled || !s.data.license.valid || !["connected", "coexistence_verified"].includes(s.data.whatsapp)) && (
        <div className="mb-5"><Notice tone="warn">{t("Automation isn't fully active yet. Open")} <a className="font-medium underline" href="#/setup">{t("Setup")}</a> {t("to finish connecting WhatsApp, activating your license and switching automation on.")}</Notice></div>
      )}
      {s.data?.license?.valid && s.data.license.expiring_soon && (
        <div className="mb-5"><Notice tone="warn">{t("Your license expires in {n} days. Contact SmartManager to renew it or upgrade to a lifetime license.", { n: Math.max(0, s.data.license.days_left ?? 0) })} <a className="font-medium underline" href="#/license">{t("License")}</a></Notice></div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("Customers")} value={tot.customers} icon={<Users className="h-4 w-4" />} />
        <Stat label={t("Presentations started")} value={tot.started} icon={<PlayCircle className="h-4 w-4" />} />
        <Stat label={t("Completed")} value={tot.completed} hint={`${tot.completion_rate}% completion rate`} icon={<CheckCircle2 className="h-4 w-4" />} />
        <Stat label={t("Active now")} value={tot.active} icon={<Activity className="h-4 w-4" />} />
        <Stat label={t("Waiting for next video")} value={tot.waiting} icon={<Clock className="h-4 w-4" />} />
        <Stat label={t("Human-handled")} value={tot.human} icon={<Hand className="h-4 w-4" />} />
        <Stat label={t("Website links sent")} value={tot.website_sent} />
        <Stat label={t("Failed conversations")} value={tot.failed_conversations} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title={t("Presentations per day")}><BarChart data={a.data.trend.map((d: any) => ({ label: d.day.slice(5), value: d.started, value2: d.completed }))} />
          <p className="mt-2 text-xs text-slate-500">Light = started, dark = completed.</p></Card>
        <Card title={t("Popular business categories")}><HBar rows={a.data.perCategory.map((c: any) => ({ label: c.name, value: c.customers, sub: `${c.customers} · ${c.completed} done` }))} /></Card>
        <Card title={t("Connections")}>
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between">WhatsApp {s.data && <StatusBadge value={s.data.whatsapp} />}</li>
            <li className="flex items-center justify-between">License {s.data && <StatusBadge value={s.data.license.valid ? "active" : s.data.license.reason ?? "not_activated"} />}</li>
            <li className="flex items-center justify-between">Automation {s.data && <StatusBadge value={s.data.automation_enabled ? "active" : "paused"} />}</li>
          </ul>
        </Card>
        <Card className="lg:col-span-2" title={t("Recent activity")}>
          {a.data.recent.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">{t("No activity yet. Send a message to your WhatsApp number to test.")}</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{a.data.recent.map((r: any, i: number) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2"><span><b className="font-medium">{r.name || r.wa_phone}</b> · {r.type.replace(/_/g, " ")}</span><span className="shrink-0 text-xs text-slate-500">{fmtDate(r.created_at, tz)}</span></li>))}</ul>)}
        </Card>
      </div>
    </>
  );
}
