import { useState } from "react";
import { Building2, KeyRound, LogOut, Plus, ScrollText, ServerCog, TriangleAlert } from "lucide-react";
import { get, post } from "../api";
import type { Me } from "../App";
import { Brand } from "../App";
import { Badge, Button, LangSwitch, Card, Empty, Field, Input, Loading, Modal, Notice, PageHeader, StatusBadge, cx, fmtBytes, fmtDate, useAction, useLoad, useUi } from "../ui";
import { t } from "../i18n";

const TABS = [["tenants", "Tenants", Building2], ["licenses", "Licenses", KeyRound], ["usage", "Usage", ServerCog], ["errors", "Errors", TriangleAlert], ["audit", "Audit log", ScrollText]] as const;

export function OwnerApp({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("tenants");
  return (
    <div className="min-h-full bg-slate-50">
      <header className="flex items-center justify-between gap-3 bg-ink px-4 py-3 text-white safe-top"><Brand light /><div className="flex items-center gap-3 text-xs text-slate-300"><LangSwitch dark /><span className="hidden sm:inline">Platform owner · {me.user.email}</span><button onClick={async () => { const current = prompt(t("Current password")); if (!current) return; const next = prompt(t("New password (10+ characters)")); if (!next) return; try { await post("/auth/password", { current, next }); alert(t("Password changed. Other sessions were signed out.")); } catch (e) { alert((e as Error).message); } }} className="rounded-lg px-2 py-1 text-xs hover:bg-white/10">{t("Change password")}</button><button onClick={onLogout} aria-label={t("Sign out")} className="rounded-lg p-2 hover:bg-white/10"><LogOut className="h-4 w-4" /></button></div></header>
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3" aria-label={t("Owner sections")}>{TABS.map(([id, label, Icon]) => (
        <button key={id} onClick={() => setTab(id)} aria-current={tab === id} className={cx("flex min-h-12 items-center gap-2 border-b-2 px-3 text-sm font-medium", tab === id ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500")}><Icon className="h-4 w-4" />{label}</button>))}</nav>
      <main className="mx-auto max-w-6xl p-4 sm:p-6">{tab === "tenants" ? <Tenants /> : tab === "licenses" ? <Licenses /> : tab === "usage" ? <Usage /> : tab === "errors" ? <Errors /> : <Audit />}</main>
    </div>
  );
}

function Tenants() {
  const q = useLoad(() => get("/tenants")); const [create, setCreate] = useState<any | null>(null); const [sel, setSel] = useState<string | null>(null);
  const { busy, run } = useAction();
  if (q.loading && !q.data) return <Loading />;
  const tenantRows: any[] = q.data?.tenants ?? [];
  return (<>
    <PageHeader title={t("Tenants")} subtitle={t("Each client gets a dedicated PWA URL, isolated data and their own license.")} actions={<Button onClick={() => setCreate({ slug: "", business_name: "", admin_email: "", admin_password: "" })}><Plus className="h-4 w-4" />{t("New tenant")}</Button>} />
    {tenantRows.length === 0 ? <Empty title={t("No tenants yet")} hint={t("Create the first client to get their application URL.")} /> : (
      <Card className="overflow-hidden !p-0"><div className="overflow-x-auto"><table className="w-full text-start text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">{t("Tenant")}</th><th className="px-4 py-3">{t("URL")}</th><th className="px-4 py-3">{t("License")}</th><th className="px-4 py-3">{t("WhatsApp")}</th><th className="px-4 py-3">{t("Created")}</th><th className="px-4 py-3">{t("Last activity")}</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{tenantRows.map((x) => (<tr key={x.id} onClick={() => setSel(x.id)} className="cursor-pointer hover:bg-slate-50"><td className="px-4 py-3"><div className="font-medium">{x.business_name} {x.status === "suspended" && <Badge tone="amber">{t("suspended")}</Badge>}</div><div className="font-mono text-xs text-slate-500">{x.id}</div></td>
          <td className="px-4 py-3"><a className="text-brand-700 hover:underline" href={x.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>/t/{x.slug}/</a></td>
          <td className="px-4 py-3"><StatusBadge value={x.license_status} /> <span className="text-xs text-slate-500">{x.license_type ?? ""}{x.license_expires_at ? ` · ${fmtDate(x.license_expires_at)}` : ""}</span></td><td className="px-4 py-3"><StatusBadge value={x.whatsapp_status ?? "not_connected"} /></td>
          <td className="px-4 py-3 text-slate-500">{fmtDate(x.created_at)}</td><td className="px-4 py-3 text-slate-500">{fmtDate(x.last_activity_at)}</td></tr>))}</tbody></table></div></Card>)}
    <Modal open={!!create} onClose={() => setCreate(null)} title={t("New tenant")}>{create && <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => post("/tenants", create)); if (r) { setCreate(null); q.reload(); alert(`Tenant created.\nClient URL: ${r.url}`); } }}>
      <Field label={t("Slug (URL name)")} hint={t("3–40 characters: a–z, 0–9, hyphen. Cannot be changed later.")}><Input required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" value={create.slug} onChange={(e) => setCreate({ ...create, slug: e.target.value.toLowerCase() })} /></Field>
      <Field label={t("Business name")}><Input required value={create.business_name} onChange={(e) => setCreate({ ...create, business_name: e.target.value })} /></Field>
      <Field label={t("Client admin email")}><Input type="email" required value={create.admin_email} onChange={(e) => setCreate({ ...create, admin_email: e.target.value })} /></Field>
      <Field label={t("Initial password (10+ characters)")} hint={t("Share it securely; the client can change it in Settings.")}><Input type="password" minLength={10} required autoComplete="new-password" value={create.admin_password} onChange={(e) => setCreate({ ...create, admin_password: e.target.value })} /></Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setCreate(null)}>{t("Cancel")}</Button><Button type="submit" loading={busy}>{t("Create")}</Button></div></form>}</Modal>
    <TenantDetail id={sel} onClose={() => { setSel(null); q.reload(); }} />
  </>);
}

function TenantDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useLoad(() => (id ? get(`/tenants/${id}`) : Promise.resolve(null)), [id]);
  const { busy, run } = useAction(); const { confirm } = useUi(); const [reset, setReset] = useState<{ email: string; password: string } | null>(null); const [xfer, setXfer] = useState("");
  const d = q.data;
  return (<Modal open={!!id} onClose={onClose} title={d?.tenant.business_name ?? "Tenant"} wide>{!d ? <Loading /> : (<div className="space-y-4 text-sm">
    <div className="grid gap-3 sm:grid-cols-2"><div><div className="text-xs text-slate-500">{t("URL")}</div><a className="text-brand-700 underline" href={d.url} target="_blank" rel="noreferrer">{d.url}</a></div><div><div className="text-xs text-slate-500">{t("Status")}</div><StatusBadge value={d.tenant.status} /></div>
      <div><div className="text-xs text-slate-500">{t("Customers / videos / storage")}</div>{d.counts.customers} / {d.counts.videos} / {fmtBytes(d.counts.video_bytes)}</div><div><div className="text-xs text-slate-500">{t("License")}</div><StatusBadge value={d.license_status.valid ? "active" : d.license_status.reason ?? "not_activated"} /></div></div>
    <Card title={t("WhatsApp connection health")}><dl className="grid gap-2 sm:grid-cols-2"><div>{t("Status:")} <StatusBadge value={d.whatsapp?.status ?? "not_connected"} /></div><div>Number: {d.whatsapp?.display_phone ?? "—"}</div><div>Last webhook: {fmtDate(d.whatsapp?.last_webhook_at)}</div><div>Last API OK: {fmtDate(d.whatsapp?.last_api_ok_at)}</div><div>Last check: {fmtDate(d.whatsapp?.last_check_at)}</div><div>Coexistence: {d.whatsapp?.is_on_biz_app == null ? "not verified" : d.whatsapp.is_on_biz_app ? "verified" : "no"}</div></dl>
      {d.whatsapp?.last_error && <p className="mt-2 text-xs text-rose-600">{d.whatsapp.last_error}</p>}<p className="mt-2 text-xs text-slate-500">{t("Credentials are never shown here.")}</p></Card>
    <Card title={t("Licenses")}>{d.licenses.length === 0 ? <p className="text-slate-500">{t("No license activated.")}</p> : <ul className="divide-y divide-slate-100">{d.licenses.map((l: any) => <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><code className="text-xs">{l.id}</code> <StatusBadge value={l.status} /><div className="text-xs text-slate-500">{l.license_type}{l.expires_at ? ` · ${t("Expires")} ${fmtDate(l.expires_at)}` : ""} · phone {l.registered_phone ? `+${l.registered_phone}` : "not registered"}</div></div>
      <div className="flex gap-1.5">{l.status === "active" && <Button variant="secondary" className="min-h-8 px-2.5" onClick={async () => { await run(() => post(`/licenses/${l.id}/suspend`), "Suspended"); q.reload(); }}>{t("Suspend")}</Button>}
        {l.status === "suspended" && <Button variant="secondary" className="min-h-8 px-2.5" onClick={async () => { await run(() => post(`/licenses/${l.id}/reinstate`), "Reinstated"); q.reload(); }}>{t("Reinstate")}</Button>}
        {["active", "suspended"].includes(l.status) && <Button variant="secondary" className="min-h-8 px-2.5" onClick={async () => { if (await confirm({ title: t("Allow a different WhatsApp number?"), body: t("Clears the registered number so the client can verify a new one.") })) { await run(() => post(`/licenses/${l.id}/reset-phone`), "Number registration cleared"); q.reload(); } }}>{t("Reset number")}</Button>}
        {l.status !== "revoked" && <Button variant="danger" className="min-h-8 px-2.5" onClick={async () => { if (await confirm({ title: t("Revoke this license?"), body: t("This is permanent. The client's automation stops immediately."), danger: true, confirmLabel: t("Revoke") })) { await run(() => post(`/licenses/${l.id}/revoke`), "Revoked"); q.reload(); } }}>{t("Revoke")}</Button>}</div></li>)}</ul>}
      {d.licenses.some((l: any) => l.status === "active") && <div className="mt-3 flex gap-2"><Input placeholder={t("Destination tenant ID (tnt_…) to approve a transfer")} value={xfer} onChange={(e) => setXfer(e.target.value)} /><Button variant="secondary" disabled={!xfer} onClick={async () => { const l = d.licenses.find((x: any) => x.status === "active"); if (await confirm({ title: t("Approve license transfer?"), body: t("The current license becomes unusable; issue a new license for the destination with transfer_from set."), danger: true })) { await run(() => post(`/licenses/${l.id}/transfer`, { to_tenant_id: xfer }), "Transfer approved"); q.reload(); } }}>{t("Approve transfer")}</Button></div>}</Card>
    <div className="flex flex-wrap gap-2"><Button variant={d.tenant.status === "active" ? "secondary" : "primary"} loading={busy} onClick={async () => { await run(() => post(`/tenants/${d.tenant.id}/status`, { status: d.tenant.status === "active" ? "suspended" : "active" }), "Updated"); q.reload(); }}>{d.tenant.status === "active" ? "Suspend tenant" : "Activate tenant"}</Button>
      <Button variant="secondary" onClick={() => setReset({ email: d.users[0]?.email ?? "", password: "" })}>{t("Reset admin access")}</Button></div>
    {reset && <form className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-3" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post(`/tenants/${d.tenant.id}/reset-admin`, reset), "Admin access reset")) setReset(null); }}>
      <Input type="email" required value={reset.email} onChange={(e) => setReset({ ...reset, email: e.target.value })} placeholder={t("admin email")} /><Input type="password" minLength={10} required autoComplete="new-password" value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} placeholder={t("new password")} /><Button type="submit" loading={busy}>{t("Reset")}</Button></form>}
  </div>)}</Modal>);
}

function Licenses() {
  const q = useLoad(() => get("/licenses"));
  if (q.loading && !q.data) return <Loading />;
  return (<><PageHeader title={t("Licenses")} subtitle={t("Licenses are issued with the separate SmartManager License Generator (Windows). Clients activate them in their PWA.")} />
    {(q.data?.licenses ?? []).length === 0 ? <Empty title={t("No licenses activated yet")} /> : <Card className="overflow-hidden !p-0"><div className="overflow-x-auto"><table className="w-full text-start text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">{t("License")}</th><th className="px-4 py-3">{t("Tenant")}</th><th className="px-4 py-3">{t("Type")}</th><th className="px-4 py-3">{t("Expires")}</th><th className="px-4 py-3">{t("Status")}</th><th className="px-4 py-3">{t("Number")}</th><th className="px-4 py-3">{t("Activated")}</th></tr></thead><tbody className="divide-y divide-slate-100">{q.data.licenses.map((l: any) => <tr key={l.id}><td className="px-4 py-3 font-mono text-xs">{l.id}</td><td className="px-4 py-3">{l.client_name} <span className="text-xs text-slate-500">/t/{l.slug}</span></td><td className="px-4 py-3">{l.license_type}</td><td className="px-4 py-3">{l.expires_at ? fmtDate(l.expires_at) : "—"}</td><td className="px-4 py-3"><StatusBadge value={l.status} /></td><td className="px-4 py-3">{l.registered_phone ? `+${l.registered_phone}` : "—"}</td><td className="px-4 py-3 text-slate-500">{fmtDate(l.activated_at)}</td></tr>)}</tbody></table></div></Card>}</>);
}

function Usage() {
  const q = useLoad(() => get("/usage")); const dep = useLoad(() => get("/deployment"));
  if (q.loading && !q.data) return <Loading />; const u = q.data;
  return (<><PageHeader title={t("Usage & deployment")} subtitle={t("Cloudflare Free-plan monitoring (estimates).")} />
    {u.warnings.length > 0 && <div className="mb-4 space-y-2">{u.warnings.map((w: string) => <Notice key={w} tone="warn">{w}</Notice>)}</div>}
    <div className="grid gap-4 lg:grid-cols-2"><Card title={t("Today (application counters)")}><dl className="space-y-2 text-sm">{Object.entries(u.today).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-slate-500">{k.replace(/_/g, " ")}</dt><dd className="font-medium">{String(v)}</dd></div>)}<div className="flex justify-between"><dt className="text-slate-500">{t("est. queue operations")}</dt><dd className="font-medium">{u.estimatedQueueOpsToday} / {u.limits.queueOpsPerDay}</dd></div><div className="flex justify-between"><dt className="text-slate-500">{t("R2 video storage")}</dt><dd className="font-medium">{fmtBytes(u.r2StorageBytes)} / {fmtBytes(u.limits.r2StorageBytes)}</dd></div></dl></Card>
      <Card title={t("Deployment")}>{dep.data && <dl className="space-y-2 text-sm"><div className="flex justify-between"><dt className="text-slate-500">{t("Origin")}</dt><dd>{dep.data.origin}</dd></div><div className="flex justify-between"><dt className="text-slate-500">{t("Default Graph API")}</dt><dd>{dep.data.graphVersionDefault}</dd></div>{Object.entries(dep.data.secretsConfigured).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-slate-500">{k}</dt><dd>{v ? "✓ configured" : "✗ missing"}</dd></div>)}</dl>}</Card></div>
    <p className="mt-4 text-xs text-slate-500">{u.note}</p></>);
}
function Errors() {
  const q = useLoad(() => get("/errors")); if (q.loading && !q.data) return <Loading />;
  return (<><PageHeader title={t("Application errors")} /><Card title={t("Automation errors & warnings")}>{q.data.errors.length === 0 ? <p className="text-sm text-slate-500">{t("None 🎉")}</p> : <ul className="divide-y divide-slate-100 text-sm">{q.data.errors.map((e: any, i: number) => <li key={i} className="py-2"><span className="text-xs text-slate-500">{fmtDate(e.created_at)} · {e.slug ?? "—"}</span><div><Badge tone={e.level === "error" ? "red" : "amber"}>{e.level}</Badge> {e.message}</div></li>)}</ul>}</Card>
    <Card className="mt-4" title={t("Failed webhook events")}>{q.data.failedWebhookEvents.length === 0 ? <p className="text-sm text-slate-500">{t("None")}</p> : <ul className="divide-y divide-slate-100 text-sm">{q.data.failedWebhookEvents.map((e: any, i: number) => <li key={i} className="py-2">{fmtDate(e.received_at)} · {e.slug}: {e.error}</li>)}</ul>}</Card></>);
}
function Audit() {
  const q = useLoad(() => get("/audit")); if (q.loading && !q.data) return <Loading />;
  return (<><PageHeader title={t("Audit log")} /><Card className="overflow-hidden !p-0"><div className="overflow-x-auto"><table className="w-full text-start text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">{t("When")}</th><th className="px-4 py-3">{t("Tenant")}</th><th className="px-4 py-3">{t("Actor")}</th><th className="px-4 py-3">{t("Action")}</th></tr></thead><tbody className="divide-y divide-slate-100">{q.data.audit.map((a: any, i: number) => <tr key={i}><td className="px-4 py-2 text-slate-500">{fmtDate(a.created_at)}</td><td className="px-4 py-2">{a.slug ?? "—"}</td><td className="px-4 py-2">{a.actor_kind}</td><td className="px-4 py-2">{a.action}</td></tr>)}</tbody></table></div></Card></>);
}
