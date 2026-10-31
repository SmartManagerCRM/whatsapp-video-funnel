import { useEffect, useState } from "react";
import { BASE, del, get, post, put } from "../api";
import { Button, Card, CurrencySelect, Field, Input, Loading, Notice, PageHeader, Select, Toggle, useAction, useLoad } from "../ui";
import { t } from "../i18n";

export function SettingsPage() {
  const q = useLoad(() => get("/settings"));
  const [s, setS] = useState<any>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [logoKey, setLogoKey] = useState(0);
  const { busy, run } = useAction();
  useEffect(() => { if (q.data) setS({ ...q.data, opt_out_keywords: q.data.opt_out_keywords.join(", "), opt_in_keywords: q.data.opt_in_keywords.join(", ") }); }, [q.data]);
  if (!s) return <Loading />;
  const set = (k: string, v: any) => setS({ ...s, [k]: v });
  const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const listed = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf("timeZone") as string[] : [];
  // "UTC" is not in the browser's zone list, and the stored value must always be selectable
  const zones = [...new Set(["UTC", s.timezone, ...listed])];
  const save = () => run(() => put("/settings", { ...s, opt_out_keywords: list(s.opt_out_keywords), opt_in_keywords: list(s.opt_in_keywords), default_delay_seconds: +s.default_delay_seconds, retention_days: +s.retention_days, handover_timeout_minutes: +s.handover_timeout_minutes }), "Settings saved");
  return (
    <>
      <PageHeader title={t("Settings")} actions={<Button loading={busy} onClick={save}>{t("Save settings")}</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("Business")}>
          <div className="space-y-3">
            <Field label={t("Business name")}><Input value={s.business_name ?? ""} onChange={(e) => set("business_name", e.target.value)} /></Field>
            <Field label={t("Website URL")} hint={t("Sent to customers after the last video.")}><Input type="url" placeholder="https://" value={s.website_url ?? ""} onChange={(e) => set("website_url", e.target.value)} /></Field>
            <Field label={t("Time zone")}><Select value={s.timezone} onChange={(e) => set("timezone", e.target.value)}>{zones.map((z) => <option key={z}>{z}</option>)}</Select></Field>
            <Field label={t("Default language")} hint={t("Language of the messages your chatbot sends by default.")}><Select value={s.default_language} onChange={(e) => set("default_language", e.target.value)}><option value="en">English</option><option value="fr">Français</option><option value="ar">العربية</option>{!["en", "fr", "ar"].includes(s.default_language) && <option value={s.default_language}>{s.default_language}</option>}</Select></Field>
            <Field label={t("Currency")} hint={t("Used for cost estimates. WhatsApp charges are billed by Meta in your own account currency.")}><CurrencySelect value={s.currency ?? "USD"} onChange={(v) => set("currency", v)} /></Field>
            <Field label={t("Notification email (optional)")}><Input type="email" value={s.notification_email ?? ""} onChange={(e) => set("notification_email", e.target.value)} /></Field>
          </div>
        </Card>
        <Card title={t("Video delivery")}>
          <div className="space-y-3">
            <Field label={t("Default sequence behaviour")} hint={t("Hybrid: next video after the delay, or immediately when the customer taps Continue.")}><Select value={s.delivery_mode} onChange={(e) => set("delivery_mode", e.target.value)}><option value="hybrid">{t("Hybrid (recommended)")}</option><option value="automatic">{t("Automatic — send after the delay")}</option><option value="manual">{t("Manual — wait for Continue")}</option></Select></Field>
            <Field label={t("Default delay between videos (seconds)")}><Input type="number" min={0} value={s.default_delay_seconds} onChange={(e) => set("default_delay_seconds", e.target.value)} /></Field>
            <Field label={t("When a customer changes category")}><Select value={s.category_change_policy} onChange={(e) => set("category_change_policy", e.target.value)}><option value="restart">{t("Restart with the new sequence")}</option><option value="continue">{t("Keep their progress position")}</option></Select></Field>
          </div>
        </Card>
        <Card title={t("Human handover (WhatsApp Business app)")}>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 text-sm"><span>{t("Pause automation when I reply from the WhatsApp Business app")}</span><Toggle checked={!!s.handover_enabled} label={t("Handover")} onChange={(v) => set("handover_enabled", v ? 1 : 0)} /></div>
            <Field label={t("Resume automatically after (minutes)")} hint={t("0 = stay paused until you resume it manually.")}><Input type="number" min={0} value={s.handover_timeout_minutes} onChange={(e) => set("handover_timeout_minutes", e.target.value)} /></Field>
          </div>
        </Card>
        <Card title={t("Customer protection & data")}>
          <div className="space-y-3">
            <Field label={t("Opt-out words (comma separated)")}><Input dir="auto" value={s.opt_out_keywords} onChange={(e) => set("opt_out_keywords", e.target.value)} /></Field>
            <Field label={t("Opt-in words (to restart after opting out)")}><Input dir="auto" value={s.opt_in_keywords} onChange={(e) => set("opt_in_keywords", e.target.value)} /></Field>
            <Field label={t("Delete customers after N days of inactivity")} hint={t("0 = keep forever.")}><Input type="number" min={0} value={s.retention_days} onChange={(e) => set("retention_days", e.target.value)} /></Field>
            <Field label={t("Approved re-open template name (optional)")} hint={t("Only if you created and got a WhatsApp template approved. Used outside the 24-hour window; otherwise the sequence simply pauses.")}><Input value={s.reopen_template_name ?? ""} onChange={(e) => set("reopen_template_name", e.target.value)} /></Field>
            <Field label={t("Template language code")}><Input value={s.reopen_template_language ?? ""} onChange={(e) => set("reopen_template_language", e.target.value)} placeholder={t("en")} /></Field>
            <Notice tone="info">{t("WhatsApp charges are billed by Meta directly to your Business account. Rates vary by country and category — see")} <a className="underline" href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noreferrer">{t("Meta's official pricing")}</a>.</Notice>
          </div>
        </Card>
        <Card title={t("Logo")} className="lg:col-span-2">
          <div className="flex flex-wrap items-center gap-4">
            <img key={logoKey} src={`${BASE}/logo?v=${logoKey}`} alt="" className="h-16 w-16 rounded-xl border border-slate-200 bg-slate-50 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }} onLoad={(e) => { (e.target as HTMLImageElement).style.visibility = "visible"; }} />
            <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium hover:bg-slate-50">{t("Upload logo")}<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; const fd = new FormData(); fd.set("file", f); if (await run(() => put("/settings/logo", fd), "Logo updated")) setLogoKey(Date.now()); }} /></label>
            <Button variant="ghost" onClick={async () => { await run(() => del("/settings/logo"), "Logo removed"); setLogoKey(Date.now()); }}>{t("Remove")}</Button>
            <span className="text-xs text-slate-500">{t("PNG, JPEG or WebP, up to 512 KB.")}</span>
          </div>
        </Card>
        <Card title={t("Change password")} className="lg:col-span-2">
          <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void run(() => post("/auth/password", { current: pw.current, next: pw.next }), "Password changed").then(() => setPw({ current: "", next: "" })); }}>
            <Field label={t("Current password")}><Input type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
            <Field label={t("New password (10+ characters)")}><Input type="password" autoComplete="new-password" minLength={10} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <div className="flex items-end"><Button type="submit" variant="secondary" loading={busy}>{t("Update password")}</Button></div>
          </form>
        </Card>
      </div>
    </>
  );
}
