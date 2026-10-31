import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { LANGS, getLang, locale, setLang, subscribeLang, t, type Lang } from "./i18n";
import { currencyGroups } from "./currencies";
import { useSyncExternalStore } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------------------------------------------------------------- primitives
export function Spinner({ className }: { className?: string }) { return <Loader2 className={cx("animate-spin text-brand-600", className ?? "h-5 w-5")} aria-label={t("Loading")} />; }
export const Loading = () => <div className="flex justify-center py-16" role="status"><Spinner className="h-7 w-7" /></div>;

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; loading?: boolean };
export function Button({ variant = "primary", loading, className, children, disabled, ...p }: BtnProps) {
  const v = {
    primary: "bg-brand-700 text-white hover:bg-brand-800 shadow-sm",
    secondary: "bg-white text-slate-800 border border-slate-200 hover:bg-slate-50",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    ghost: "text-slate-600 hover:bg-slate-100",
  }[variant];
  return (
    <button {...p} disabled={disabled || loading}
      className={cx("inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", v, className)}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}{children}
    </button>
  );
}

export const Card = ({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) => (
  <section className={cx("rise rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,.04)]", className)}>
    {(title || action) && <header className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-slate-800">{title}</h2>{action}</header>}
    {children}
  </section>
);

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>{subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>}</div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

const TONES: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200", amber: "bg-amber-50 text-amber-700 ring-amber-200",
  red: "bg-rose-50 text-rose-700 ring-rose-200", blue: "bg-sky-50 text-sky-700 ring-sky-200", slate: "bg-slate-100 text-slate-600 ring-slate-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};
export const Badge = ({ tone = "slate", children }: { tone?: keyof typeof TONES; children: ReactNode }) =>
  <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone])}>{children}</span>;

export const STATUS_TONE: Record<string, string> = {
  new: "slate", in_progress: "blue", waiting: "amber", completed: "green", human_handling: "violet", paused: "amber", opted_out: "slate", failed: "red",
  open: "green", expiring_soon: "amber", expired: "red", active: "green", suspended: "amber", revoked: "red", transferred: "slate", not_activated: "slate",
  coexistence_verified: "green", connected: "blue", onboarding_pending: "amber", disconnected: "red", token_invalid: "red", webhook_incomplete: "amber", not_connected: "slate",
  queued: "slate", submitted: "blue", sent: "blue", delivered: "green", read: "green",
};
export const StatusBadge = ({ value }: { value: string }) => <Badge tone={(STATUS_TONE[value] ?? "slate") as any}>{t(value.replace(/_/g, " "))}</Badge>;

export const Empty = ({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) => (
  <div className="flex flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
    {icon && <div className="mb-3 text-slate-400">{icon}</div>}
    <p className="font-medium text-slate-700">{title}</p>{hint && <p className="mt-1 max-w-sm text-sm text-slate-500">{hint}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const m = { info: ["bg-sky-50 text-sky-800 border-sky-200", <Info key="i" className="h-4 w-4" />], warn: ["bg-amber-50 text-amber-800 border-amber-200", <AlertTriangle key="i" className="h-4 w-4" />],
    error: ["bg-rose-50 text-rose-800 border-rose-200", <AlertTriangle key="i" className="h-4 w-4" />], ok: ["bg-emerald-50 text-emerald-800 border-emerald-200", <CheckCircle2 key="i" className="h-4 w-4" />] }[tone];
  return <div role={tone === "error" ? "alert" : "status"} className={cx("flex gap-2 rounded-xl border px-3 py-2.5 text-sm", m[0] as string)}><span className="mt-0.5 shrink-0">{m[1]}</span><div>{children}</div></div>;
}

// ---------------------------------------------------------------- form controls
const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-slate-50";
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block font-medium text-slate-700">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}</label>;
}
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field, p.className)} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(field, "min-h-24", p.className)} />;
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(field, p.className)} />;
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition", checked ? "bg-brand-600" : "bg-slate-300")}>
      <span className={cx("inline-block h-5 w-5 rounded-full bg-white shadow transition", checked ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0.5 rtl:-translate-x-0.5")} />
    </button>
  );
}

// ---------------------------------------------------------------- modal, toast, confirm
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx("rise max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label={t("Close")} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button></div>
        {children}
      </div>
    </div>
  );
}

interface Toast { id: number; tone: "ok" | "error" | "info"; text: string }
interface UiCtx { toast: (text: string, tone?: Toast["tone"]) => void; confirm: (o: { title: string; body?: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean> }
const Ctx = createContext<UiCtx>(null as any);
export const useUi = () => useContext(Ctx);

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<null | { title: string; body?: string; danger?: boolean; confirmLabel?: string; resolve: (v: boolean) => void }>(null);
  const id = useRef(0);
  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const n = ++id.current; setToasts((t) => [...t, { id: n, tone, text }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== n)), tone === "error" ? 7000 : 3500);
  }, []);
  const confirm = useCallback((o: Parameters<UiCtx["confirm"]>[0]) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), []);
  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3 safe-top" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={cx("rise pointer-events-auto max-w-md rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg", x.tone === "ok" ? "bg-emerald-700" : x.tone === "error" ? "bg-rose-700" : "bg-slate-800")}>{t(x.text)}</div>
        ))}
      </div>
      <Modal open={!!dlg} onClose={() => { dlg?.resolve(false); setDlg(null); }} title={dlg?.title ?? ""}>
        {dlg?.body && <p className="mb-5 text-sm text-slate-600">{dlg.body}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { dlg?.resolve(false); setDlg(null); }}>{t("Cancel")}</Button>
          <Button variant={dlg?.danger ? "danger" : "primary"} onClick={() => { dlg?.resolve(true); setDlg(null); }}>{dlg?.confirmLabel ?? t("Confirm")}</Button>
        </div>
      </Modal>
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------- data hook
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void run(); }, [run]);
  return { data, error, loading, reload: run, setData };
}

export function useAction() {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

// ---------------------------------------------------------------- tiny charts (no dependency)
export function BarChart({ data, height = 140 }: { data: { label: string; value: number; value2?: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <p className="py-8 text-center text-sm text-slate-400">{t("No data for this period")}</p>;
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto pb-1" style={{ height: height + 28 }} role="img" aria-label="Bar chart">
      {data.map((d) => (
        <div key={d.label} className="flex min-w-6 flex-1 flex-col items-center justify-end gap-1" title={`${d.label}: ${d.value}${d.value2 !== undefined ? ` (completed ${d.value2})` : ""}`}>
          <div className="relative w-full rounded-t-md bg-brand-200" style={{ height: Math.max(3, (d.value / max) * height) }}>
            {d.value2 !== undefined && <div className="absolute inset-x-0 bottom-0 rounded-t-md bg-brand-600" style={{ height: `${(d.value2 / Math.max(1, d.value)) * 100}%` }} />}
          </div>
          <span className="max-w-full truncate text-[10px] text-slate-500">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export function HBar({ rows }: { rows: { label: string; value: number; sub?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-6 text-center text-sm text-slate-400">{t("No data yet")}</p>;
  return <ul className="space-y-3">{rows.map((r) => (
    <li key={r.label}><div className="mb-1 flex justify-between text-sm"><span className="font-medium text-slate-700">{r.label}</span><span className="text-slate-500">{r.sub ?? r.value}</span></div>
      <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-600" style={{ width: `${(r.value / max) * 100}%` }} /></div></li>
  ))}</ul>;
}

export const Stat = ({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon?: ReactNode }) => (
  <div className="rise rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,.04)]">
    <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500"><span>{label}</span><span className="text-brand-600">{icon}</span></div>
    <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</div>{hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
  </div>
);

export function fmtDate(iso: string | null | undefined, tz?: string) {
  if (!iso) return "—";
  try { return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: tz || undefined }).format(new Date(iso)); } catch { return iso; }
}
export const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const fmtDur = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "—");

/** Language picker. Switching re-renders the whole app (keyed on the language) and flips page direction for Arabic. */
export function useLang(): Lang { return useSyncExternalStore(subscribeLang, getLang); }
export function LangSwitch({ dark }: { dark?: boolean }) {
  const lang = useLang();
  return (
    <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as Lang)}
      className={cx("rounded-lg border px-2 py-1.5 text-xs", dark ? "border-white/20 bg-white/10 text-white" : "border-slate-300 bg-white text-slate-700")}>
      {LANGS.map((l) => <option key={l.code} value={l.code} className="text-slate-900">{l.label}</option>)}
    </select>
  );
}

/** Currency picker: all MENA currencies first, then every other ISO 4217 currency. Names follow the UI language. */
export function CurrencySelect({ value, onChange, variant = "form", disabled }: { value: string; onChange: (v: string) => void; variant?: "form" | "header" | "headerDark"; disabled?: boolean }) {
  const lang = useLang();
  const g = currencyGroups(lang);
  const known = [...g.mena, ...g.other].some((c) => c.code === value);
  const options = (
    <>
      {!known && <option value={value}>{value}</option>}
      <optgroup label={t("Middle East & North Africa")}>{g.mena.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}</optgroup>
      <optgroup label={t("Other currencies (international)")}>{g.other.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}</optgroup>
    </>
  );
  if (variant === "form") return <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={t("Currency")}>{options}</Select>;
  return (
    <label className="flex items-center gap-1.5 text-xs" title={t("Currency")}>
      <span className={cx("hidden sm:inline", variant === "headerDark" ? "text-slate-300" : "text-slate-500")}>{t("Currency")}</span>
      <select aria-label={t("Currency")} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className={cx("max-w-[8.5rem] truncate rounded-lg border px-2 py-1.5 text-xs sm:max-w-[11rem] disabled:opacity-60", variant === "headerDark" ? "border-white/20 bg-white/10 text-white" : "border-slate-300 bg-white text-slate-700")}>
        {variant === "headerDark" ? <>{!known && <option value={value}>{value}</option>}
          <optgroup label={t("Middle East & North Africa")}>{g.mena.map((c) => <option key={c.code} value={c.code} className="text-slate-900">{c.code} — {c.name}</option>)}</optgroup>
          <optgroup label={t("Other currencies (international)")}>{g.other.map((c) => <option key={c.code} value={c.code} className="text-slate-900">{c.code} — {c.name}</option>)}</optgroup></> : options}
      </select>
    </label>
  );
}

/** Language picker for headers: shows the label so it is clearly discoverable. */
export function HeaderLang({ dark }: { dark?: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-xs" title={t("Language")}>
      <span className={cx("hidden sm:inline", dark ? "text-slate-300" : "text-slate-500")}>{t("Language")}</span>
      <LangSwitch dark={dark} />
    </label>
  );
}
