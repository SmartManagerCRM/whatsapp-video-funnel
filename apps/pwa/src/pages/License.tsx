import { useState } from "react";
import { ShieldCheck, Upload } from "lucide-react";
import { get, post } from "../api";
import { Button, Card, Loading, Notice, PageHeader, StatusBadge, Textarea, fmtDate, useAction, useLoad } from "../ui";
import { t } from "../i18n";

export function LicensePage() {
  const q = useLoad(() => get("/license"));
  const [text, setText] = useState("");
  const { busy, run } = useAction();
  if (q.loading && !q.data) return <Loading />;
  const l = q.data?.license; const v = q.data;
  return (
    <>
      <PageHeader title={t("License")} subtitle={t("Your one-time lifetime license for SmartManager WhatsApp Video Funnel. It never expires and has no monthly fee.")} />
      {v && !v.valid && <div className="mb-4"><Notice tone="warn">{t(v.message ?? "No valid license.")} {t("Automation stays off until a valid license is activated.")}</Notice></div>}
      {v?.valid && l?.expiring_soon && <div className="mb-4"><Notice tone="warn">{t("Your license expires in {n} days. Contact SmartManager to renew it or upgrade to a lifetime license.", { n: Math.max(0, l.days_left ?? 0) })}</Notice></div>}
      {v?.grace && <div className="mb-4"><Notice tone="warn">{t("Running on last-known-good verification. Contact SmartManager if this persists.")}</Notice></div>}
      {l && (
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-brand-600" />{t("License details")}</span>}>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Item k={t("Product")}>{v.product}</Item><Item k={t("License ID")}><code className="text-xs">{l.id}</code></Item>
            <Item k={t("License type")}>{l.type === "LIMITED" ? t("Limited-time") : t("Lifetime")}</Item>
            <Item k={t("Expiry date")}>{l.lifetime ? t("Never expires") : <>{fmtDate(l.expires_at)} <span className="text-xs font-normal text-slate-500">({t("{n} days left", { n: Math.max(0, l.days_left ?? 0) })})</span></>}</Item>
            <Item k={t("Tenant ID")}><code className="text-xs">{l.tenant_id}</code></Item><Item k={t("Activated")}>{fmtDate(l.activated_at)}</Item>
            <Item k={t("Registered WhatsApp number")}>{l.registered_phone ? `+${l.registered_phone}` : t("Registered when you verify WhatsApp")}</Item><Item k={t("WhatsApp numbers allowed")}>{l.max_whatsapp_numbers}</Item>
            <Item k={t("Status")}><StatusBadge value={v.valid ? "active" : v.reason ?? l.status} /></Item><Item k={t("Features")}>{l.features.join(", ") || "—"}</Item>
          </dl>
        </Card>)}
      <Card className="mt-4" title={l ? t("Renew or activate a different license") : t("Activate your license")}>
        <p className="mb-3 text-sm text-slate-500">{t("Paste the license key, or load the")} <b>{t(".smlic")}</b> {t("file you received. Changing the WhatsApp number or transferring the license needs approval from SmartManager.")}</p>
        <Textarea rows={5} placeholder={t("Paste license key…")} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" />
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium hover:bg-slate-50"><Upload className="h-4 w-4" />{t("Load .smlic file")}<input type="file" accept=".smlic,application/json,text/plain" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = ""; }} /></label>
          <Button loading={busy} disabled={!text.trim()} onClick={async () => { if (await run(() => post("/license/activate", { license: text }), "License activated")) { setText(""); q.reload(); } }}>{t("Activate")}</Button>
        </div>
      </Card>
    </>
  );
}
const Item = ({ k, children }: { k: string; children: React.ReactNode }) => <div><dt className="text-xs uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 font-medium">{children}</dd></div>;
