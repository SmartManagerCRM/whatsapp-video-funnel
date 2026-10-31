import { useState } from "react";
import { CheckCircle2, Copy, ExternalLink, XCircle } from "lucide-react";
import { get, post, put } from "../api";
import { Button, Card, Field, Input, Loading, Notice, PageHeader, StatusBadge, fmtDate, useAction, useLoad, useUi } from "../ui";
import { t } from "../i18n";

const copy = (t: string, toast: (s: string) => void) => navigator.clipboard?.writeText(t).then(() => toast("Copied"));

export function WhatsApp() {
  const q = useLoad(() => get("/whatsapp"));
  const [f, setF] = useState({ app_id: "", waba_id: "", phone_number_id: "", access_token: "", app_secret: "", graph_version: "v23.0" });
  const [checks, setChecks] = useState<any[] | null>(null);
  const { busy, run } = useAction(); const { toast, confirm } = useUi();
  if (q.loading && !q.data) return <Loading />;
  const a = q.data; if (!a) return null;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { ...f, app_id: f.app_id || a.app_id || undefined, waba_id: f.waba_id || a.waba_id, phone_number_id: f.phone_number_id || a.phone_number_id, graph_version: f.graph_version || a.graph_version };
    if (await run(() => put("/whatsapp", body), "Credentials saved (encrypted). Now verify the connection.")) { setF({ ...f, access_token: "", app_secret: "" }); q.reload(); }
  };
  const verify = async () => { const r = await run(() => post("/whatsapp/verify")); if (r) { setChecks(r.checks); q.reload(); } };
  return (
    <>
      <PageHeader title={t("WhatsApp integration")} subtitle={t("Connect your own WhatsApp Business number through Meta's official Cloud API with Coexistence, so you keep using the WhatsApp Business app on the same number.")} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("Connection status")}>
          <dl className="space-y-3 text-sm">
            <Row k="Status"><StatusBadge value={a.status} /></Row>
            <Row k="Coexistence">{a.is_on_biz_app === null ? <span className="text-slate-400">{t("not verified")}</span> : a.is_on_biz_app ? <StatusBadge value="coexistence_verified" /> : <span className="text-amber-700">{t("Number is not on the WhatsApp Business app")}</span>}</Row>
            <Row k="Business account ID">{a.waba_id ?? "—"}</Row><Row k="Phone number ID">{a.phone_number_id ?? "—"}</Row><Row k="Display number">{a.display_phone ?? "—"}</Row>
            <Row k="Access token">{a.token_hint ?? "not set"}</Row><Row k="Graph API version">{a.graph_version ?? "—"}</Row>
            <Row k="Webhook">{a.webhook_status === "receiving" ? "receiving events" : "no events received yet"}</Row>
            <Row k="Last webhook">{fmtDate(a.last_webhook_at)}</Row><Row k="Last successful API call">{fmtDate(a.last_api_ok_at)}</Row><Row k="Last connection check">{fmtDate(a.last_check_at)}</Row>
          </dl>
          {a.last_error && <div className="mt-3"><Notice tone="error">{a.last_error}</Notice></div>}
          <div className="mt-4 flex flex-wrap gap-2"><Button loading={busy} disabled={!a.configured} onClick={verify}>{t("Verify connection")}</Button>
            <Button variant="secondary" loading={busy} disabled={!a.configured} onClick={() => run(() => post("/whatsapp/subscribe"), "Webhook fields subscribed")}>{t("Subscribe webhook fields")}</Button>
            <Button variant="ghost" disabled={!a.configured} onClick={async () => { if (await confirm({ title: t("Disconnect WhatsApp?"), body: t("Automation stops and the stored credentials are erased."), danger: true, confirmLabel: t("Disconnect") })) { await run(() => post("/whatsapp/disconnect"), "Disconnected"); q.reload(); } }}>{t("Disconnect")}</Button></div>
          {checks && <ul className="mt-4 space-y-2 text-sm">{checks.map((c, i) => <li key={i} className="flex gap-2">{c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />}<span><b className="font-medium">{c.name}</b>{c.detail && <span className="block break-words text-xs text-slate-500">{c.detail}</span>}</span></li>)}</ul>}
        </Card>
        <Card title={t("Webhook (paste into your Meta app)")}>
          <div className="space-y-3 text-sm">
            <Field label={t("Callback URL")}><div className="flex gap-2"><Input readOnly value={a.webhook_url} /><Button variant="secondary" aria-label={t("Copy")} onClick={() => copy(a.webhook_url, toast)}><Copy className="h-4 w-4" /></Button></div></Field>
            <Field label={t("Verify token")}><div className="flex gap-2"><Input readOnly value={a.verify_token ?? ""} /><Button variant="secondary" aria-label={t("Copy")} onClick={() => copy(a.verify_token, toast)}><Copy className="h-4 w-4" /></Button></div></Field>
            <p className="text-slate-600">{t("Subscribe to these fields:")} <b>{a.required_fields?.join(", ")}</b></p>
            <ol className="list-decimal space-y-1 ps-5 text-slate-600"><li>{t("In Meta App Dashboard → WhatsApp → Configuration, set the callback URL and verify token above.")}</li><li>{t("Subscribe to the fields listed.")}</li><li>{t("Complete Coexistence onboarding for your number (see the setup guide).")}</li><li>{t("Save the credentials on the right and press")} <b>{t("Verify connection")}</b>.</li></ol>
            <a className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline" href="https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users" target="_blank" rel="noreferrer">{t("Meta Coexistence guide")} <ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
        </Card>
        <Card className="lg:col-span-2" title={t("Credentials")}>
          <p className="mb-4 text-sm text-slate-500">{t("Tokens are encrypted before storage and never shown again. Leave the token and secret empty to keep the saved ones.")}</p>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off">
            <Field label={t("Meta App ID")}><Input value={f.app_id} onChange={set("app_id")} placeholder={a.app_id ?? ""} /></Field>
            <Field label={t("WhatsApp Business Account ID (WABA)")}><Input required={!a.waba_id} value={f.waba_id} onChange={set("waba_id")} placeholder={a.waba_id ?? ""} /></Field>
            <Field label={t("Phone Number ID")}><Input required={!a.phone_number_id} inputMode="numeric" value={f.phone_number_id} onChange={set("phone_number_id")} placeholder={a.phone_number_id ?? ""} /></Field>
            <Field label={t("Graph API version")} hint={t("Update when Meta retires your current version.")}><Input value={f.graph_version} onChange={set("graph_version")} /></Field>
            <Field label={t("Access token")}><Input type="password" autoComplete="new-password" required={!a.configured} value={f.access_token} onChange={set("access_token")} placeholder={a.configured ? "•••• stored" : ""} /></Field>
            <Field label={t("App secret")}><Input type="password" autoComplete="new-password" required={!a.configured} value={f.app_secret} onChange={set("app_secret")} placeholder={a.configured ? "•••• stored" : ""} /></Field>
            <div className="sm:col-span-2"><Button type="submit" loading={busy}>{t("Save credentials")}</Button></div>
          </form>
        </Card>
      </div>
    </>
  );
}
const Row = ({ k, children }: { k: string; children: React.ReactNode }) => <div className="flex items-center justify-between gap-3"><dt className="text-slate-500">{k}</dt><dd className="text-end font-medium">{children}</dd></div>;
