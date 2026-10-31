import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { get, post } from "../api";
import { Button, Card, Loading, Notice, PageHeader, useAction, useLoad, useUi } from "../ui";
import { t } from "../i18n";

const LINKS: Record<string, [string, string]> = {
  license: ["#/license", "Activate license"], whatsapp: ["#/whatsapp", "Connect WhatsApp"], coexistence: ["#/whatsapp", "Verify Coexistence"], webhook: ["#/whatsapp", "Webhook setup"],
  categories: ["#/categories", "Add categories"], media: ["#/videos", "Upload videos"], website: ["#/settings", "Set website URL"],
};

export function Setup() {
  const r = useLoad(() => get("/readiness"));
  const { busy, run } = useAction(); const { confirm } = useUi();
  if (r.loading && !r.data) return <Loading />;
  if (!r.data) return <Notice tone="error">{r.error}</Notice>;
  const d = r.data;
  const toggle = async (enabled: boolean) => {
    if (enabled && !(await confirm({ title: t("Activate automation?"), body: t("Your chatbot will start replying to new WhatsApp messages with your video presentation."), confirmLabel: t("Activate") }))) return;
    await run(() => post("/automation", { enabled }), enabled ? "Automation is now active" : "Automation paused");
    r.reload();
  };
  return (
    <>
      <PageHeader title={t("Setup")} subtitle={t("Complete every step before going live. Nothing is sent to customers until automation is activated.")} />
      <Card>
        <ul className="divide-y divide-slate-100">
          {d.checks.map((c: any) => (
            <li key={c.key} className="flex items-center gap-3 py-3">
              {c.ok ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" /> : <Circle className="h-5 w-5 shrink-0 text-slate-300" />}
              <div className="min-w-0 flex-1"><div className="text-sm font-medium text-slate-800">{t(c.label)}</div>{c.detail && <div className="truncate text-xs text-slate-500">{c.detail}</div>}</div>
              {!c.ok && LINKS[c.key] && <a href={LINKS[c.key][0]} className="shrink-0 text-sm font-medium text-brand-700 hover:underline">{t(LINKS[c.key][1])}</a>}
            </li>))}
        </ul>
      </Card>
      <div className="mt-4 space-y-3">
        {!d.production_ready && <Notice tone="warn">{t("Not marked production-ready yet: some checks above are incomplete. You can activate automation once the license, WhatsApp verification and at least one category are done, but finish the remaining items before launching to customers.")}</Notice>}
        {d.production_ready && <Notice tone="ok">{t("All checks passed.")}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          {d.automation_enabled ? <Button variant="secondary" loading={busy} onClick={() => toggle(false)}>{t("Pause automation")}</Button>
            : <Button loading={busy} disabled={!d.canEnable} onClick={() => toggle(true)}>{t("Activate automation")}</Button>}
          <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">{t("Meta documentation")} <ExternalLink className="h-3.5 w-3.5" /></a>
        </div>
      </div>
    </>
  );
}
