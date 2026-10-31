import { useState } from "react";
import { Plus } from "lucide-react";
import { get, put } from "../api";
import { Button, Card, Input, Loading, Notice, PageHeader, Select, Textarea, useAction, useLoad } from "../ui";

export function Templates() {
  const [lang, setLang] = useState("en");
  const q = useLoad(() => get("/templates?language=" + encodeURIComponent(lang)), [lang]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <Notice tone="error">{q.error}</Notice>;
  const save = async (key: string, body: string | null) => { await run(() => put("/templates", { key, language: lang, body }), body === null ? "Reset to default" : "Saved"); setDraft((d) => { const n = { ...d }; delete n[key]; return n; }); q.reload(); };
  return (
    <>
      <PageHeader title="Messages" subtitle="Everything the chatbot says. Use {{business}}, {{name}}, {{category}} and {{website}} placeholders. Emojis and any language are supported."
        actions={<><Select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language">{q.data.languages.map((l: string) => <option key={l} value={l}>{l}</option>)}</Select>
          <Button variant="secondary" onClick={() => { const l = prompt("Language code (e.g. ar, fr, es)")?.trim().toLowerCase(); if (l && /^[a-z]{2,3}(-[A-Za-z]+)?$/.test(l)) setLang(l); }}><Plus className="h-4 w-4" />Language</Button></>} />
      <Notice>The default language is chosen in Settings. If a message isn't customised for a language, the English text (or the built-in default) is used.</Notice>
      <div className="mt-4 space-y-3">
        {q.data.templates.map((t: any) => {
          const cur = draft[t.key] ?? t.body ?? t.default; const changed = draft[t.key] !== undefined && draft[t.key] !== (t.body ?? t.default);
          return (
            <Card key={t.key}>
              <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t.label}</h3>{t.body !== null && <span className="text-xs text-brand-700">customised</span>}</div>
              {t.key.endsWith("button") || t.key.endsWith("_yes") || t.key.endsWith("_no") ? <Input maxLength={20} value={cur} onChange={(e) => setDraft({ ...draft, [t.key]: e.target.value })} /> : <Textarea dir="auto" value={cur} onChange={(e) => setDraft({ ...draft, [t.key]: e.target.value })} />}
              {(t.key.endsWith("button") || t.key.endsWith("_yes") || t.key.endsWith("_no")) && <p className="mt-1 text-xs text-slate-500">WhatsApp limits button labels to 20 characters.</p>}
              <div className="mt-3 flex gap-2"><Button className="min-h-9" disabled={!changed} loading={busy} onClick={() => save(t.key, cur)}>Save</Button>
                {t.body !== null && <Button variant="ghost" className="min-h-9" onClick={() => save(t.key, null)}>Reset to default</Button>}</div>
            </Card>); })}
      </div>
    </>
  );
}
