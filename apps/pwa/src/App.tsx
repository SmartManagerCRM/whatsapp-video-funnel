import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BarChart3, Download, FileVideo2, Film, KeyRound, LayoutDashboard, ListVideo, LogOut, Menu, MessageSquareText, MessagesSquare, Plug, Rocket, Settings as Cog, Tags, Users, WifiOff, X } from "lucide-react";
import { ApiError, BASE, IS_OWNER, SLUG, get, post, put, setCsrf } from "./api";
import { Button, CurrencySelect, Field, HeaderLang, Input, LangSwitch, Loading, UiProvider, cx, useAction, useLang, useUi } from "./ui";
import { Dashboard } from "./pages/Dashboard";
import { Categories } from "./pages/Categories";
import { Videos } from "./pages/Videos";
import { SequenceBuilder } from "./pages/Sequence";
import { Templates } from "./pages/Templates";
import { Customers } from "./pages/Customers";
import { Conversations } from "./pages/Conversations";
import { Analytics } from "./pages/Analytics";
import { WhatsApp } from "./pages/WhatsApp";
import { SettingsPage } from "./pages/Settings";
import { LicensePage } from "./pages/License";
import { Setup } from "./pages/Setup";
import { OwnerApp } from "./pages/Owner";
import { t } from "./i18n";

export interface Me { csrf: string; user: { email: string; role: string }; tenant?: { id: string; slug: string; name: string } }

export const Brand = ({ light }: { light?: boolean }) => (
  <div className="flex items-center gap-2.5">
    <svg viewBox="0 0 48 48" className="h-8 w-8" aria-hidden><rect width="48" height="48" rx="12" fill="#0f766e" /><path d="M14 17.5c0-2 1.6-3.5 3.6-3.5h12.8c2 0 3.6 1.5 3.6 3.5v9.5c0 2-1.6 3.5-3.6 3.5H25l-5.2 4.2c-.5.4-1.3 0-1.3-.7v-3.5h-.9c-2 0-3.6-1.5-3.6-3.5v-9.5Z" fill="#fff" /><path d="m21.5 18.8 6.2 3.7-6.2 3.7v-7.4Z" fill="#0f766e" /></svg>
    <div className="leading-tight"><div className={cx("text-sm font-semibold tracking-tight", light ? "text-white" : "text-slate-900")}>{t("SmartManager")}</div><div className={cx("text-[11px]", light ? "text-teal-200/80" : "text-slate-500")}>{t("Video Funnel")}</div></div>
  </div>
);

export function LoginScreen({ onDone, owner }: { onDone: (m: Me) => void; owner?: boolean }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const { busy, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => post<Me>("/auth/login", { email, password }));
    if (r) { setCsrf(r.csrf); const me = await get<Me>("/auth/me"); onDone(me); }
  };
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-ink via-ink-2 to-brand-800 p-4">
      <form onSubmit={submit} className="rise w-full max-w-sm space-y-4 rounded-2xl bg-white p-7 shadow-2xl">
        <div className="flex items-center justify-between"><Brand /><LangSwitch /></div>
        <div><h1 className="text-xl font-semibold">{owner ? "Platform owner sign in" : "Sign in"}</h1><p className="text-sm text-slate-500">{owner ? "Restricted area." : "Manage your WhatsApp video presentations."}</p></div>
        <Field label={t("Email")}><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t("Password")}><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" className="w-full" loading={busy}>{t("Sign in")}</Button>
      </form>
    </div>
  );
}

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "setup", label: "Setup", icon: Rocket },
  { id: "categories", label: "Categories", icon: Tags },
  { id: "videos", label: "Video Library", icon: Film },
  { id: "sequence", label: "Sequences", icon: ListVideo },
  { id: "templates", label: "Messages", icon: MessageSquareText },
  { id: "customers", label: "Customers", icon: Users },
  { id: "conversations", label: "Conversations", icon: MessagesSquare },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "whatsapp", label: "WhatsApp", icon: Plug },
  { id: "settings", label: "Settings", icon: Cog },
  { id: "license", label: "License", icon: KeyRound },
] as const;
const TABS = ["dashboard", "customers", "conversations", "videos"];
const SHORT: Record<string, string> = { dashboard: "Dashboard", customers: "Customers", conversations: "Conversations", videos: "Videos" };

function useHash() {
  const [h, setH] = useState(location.hash.slice(2) || "dashboard");
  useEffect(() => { const f = () => setH(location.hash.slice(2) || "dashboard"); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  return h;
}
function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => { const a = () => setOn(true), b = () => setOn(false); window.addEventListener("online", a); window.addEventListener("offline", b); return () => { window.removeEventListener("online", a); window.removeEventListener("offline", b); }; }, []);
  return on;
}
function useInstall() {
  const [evt, setEvt] = useState<any>(null);
  useEffect(() => { const f = (e: Event) => { e.preventDefault(); setEvt(e); }; window.addEventListener("beforeinstallprompt", f); return () => window.removeEventListener("beforeinstallprompt", f); }, []);
  return evt ? async () => { evt.prompt(); await evt.userChoice; setEvt(null); } : null;
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const hash = useHash(); const online = useOnline(); const install = useInstall();
  const [drawer, setDrawer] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);
  const { toast } = useUi();
  useEffect(() => {
    const load = () => get("/settings").then((x) => setCurrency(x.currency ?? "USD")).catch(() => undefined);
    void load(); window.addEventListener("sm-settings-changed", load); return () => window.removeEventListener("sm-settings-changed", load);
  }, []);
  const changeCurrency = async (c: string) => {
    const prev = currency; setCurrency(c);
    try { await put("/settings/currency", { currency: c }); toast(t("Currency updated")); }
    catch (e) { setCurrency(prev); toast((e as Error).message, "error"); }
  };
  const [page, arg] = hash.split("/");
  const go = (id: string) => { location.hash = `/${id}`; setDrawer(false); };
  const content: Record<string, ReactNode> = {
    dashboard: <Dashboard tz={undefined} />, setup: <Setup />, categories: <Categories />, videos: <Videos />, sequence: <SequenceBuilder categoryId={arg} />,
    templates: <Templates />, customers: <Customers />, conversations: <Conversations openId={arg} />, analytics: <Analytics />, whatsapp: <WhatsApp />, settings: <SettingsPage />, license: <LicensePage />,
  };
  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2" aria-label={t("Main")}>
      {NAV.map(({ id, label, icon: Icon }) => (
        <button key={id} onClick={() => go(id)} aria-current={page === id ? "page" : undefined}
          className={cx("flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition", page === id ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white")}>
          <Icon className="h-4.5 w-4.5 shrink-0" />{t(label)}
        </button>
      ))}
    </nav>
  );
  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 flex-col bg-ink lg:flex"><div className="p-5"><Brand light /></div>{nav}</aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden"><div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawer(false)} />
          <aside className="rise absolute inset-y-0 start-0 flex w-72 flex-col bg-ink safe-top"><div className="flex items-center justify-between p-5"><Brand light /><button aria-label={t("Close menu")} onClick={() => setDrawer(false)} className="text-slate-300"><X /></button></div>{nav}</aside></div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[4.5rem] flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-slate-200 bg-white px-4 sm:px-6"
          style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 1rem)", paddingBottom: "1rem" }}>
          <div className="flex items-center gap-3">
            <div className="lg:hidden"><Brand /></div>
            <button aria-label={t("Open menu")} onClick={() => setDrawer(true)} className="rounded-lg p-2 hover:bg-slate-100 lg:hidden"><Menu /></button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-4" data-testid="header-controls">
            <HeaderLang />
            {currency && <CurrencySelect variant="header" value={currency} onChange={changeCurrency} disabled={me.user.role === "viewer"} />}
            <div className="flex items-center gap-2.5 border-slate-200 ps-3 sm:border-s sm:ps-4" data-testid="header-account">
              <span title={`${me.tenant?.name ?? ""} · ${me.user.email}`} className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-700 text-sm font-semibold text-white">
                {(me.tenant?.name ?? me.user.email).slice(0, 1).toUpperCase()}
                <img src={`${BASE}/logo`} alt="" className="absolute inset-0 h-full w-full bg-white object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </span>
              <div className="hidden min-w-0 text-start leading-tight md:block">
                <div className="max-w-[12rem] truncate text-sm font-medium text-slate-800">{me.tenant?.name}</div>
                <div className="max-w-[12rem] truncate text-xs text-slate-500">{me.user.email}</div>
              </div>
              {install && <button onClick={install} aria-label={t("Install app")} title={t("Install app")} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"><Download className="h-5 w-5" /></button>}
              <button onClick={onLogout} aria-label={t("Sign out")} title={t("Sign out")} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100"><LogOut className="h-5 w-5" /></button>
            </div>
          </div>
        </header>
        {!online && <div role="status" className="flex items-center justify-center gap-2 bg-amber-500 px-3 py-1.5 text-sm font-medium text-white"><WifiOff className="h-4 w-4" />{t("You're offline. The app is installed, but live data and WhatsApp automation need an internet connection.")}</div>}
        <main className="min-h-0 flex-1 overflow-y-auto"><div key={currency ?? "c"} className="mx-auto max-w-6xl p-4 pb-28 sm:p-6 lg:pb-8">{content[page] ?? content.dashboard}</div></main>
        <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white/95 backdrop-blur safe-bottom lg:hidden" aria-label={t("Quick")}>
          {NAV.filter((n) => TABS.includes(n.id)).map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => go(id)} aria-current={page === id ? "page" : undefined} className={cx("flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium", page === id ? "text-brand-700" : "text-slate-500")}><Icon className="h-5 w-5" />{t(SHORT[id] ?? label)}</button>
          ))}
          <button onClick={() => setDrawer(true)} className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-slate-500"><FileVideo2 className="h-5 w-5" />{t("More")}</button>
        </nav>
      </div>
    </div>
  );
}

function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-slate-50 p-6 text-center">
      <div role="status" className="flex items-center gap-2 rounded-full bg-amber-500 px-4 py-1.5 text-sm font-medium text-white"><WifiOff className="h-4 w-4" />{t("You're offline")}</div>
      <Brand />
      <p className="max-w-sm text-sm text-slate-600">{t("The app is installed, but your data and the WhatsApp automation need an internet connection. Your automation keeps running on the server while you're offline. We'll reconnect automatically.")}</p>
      <Button variant="secondary" onClick={onRetry}>{t("Try again")}</Button>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const load = useCallback(async () => {
    try { const m = await get<Me>("/auth/me"); setCsrf(m.csrf); setMe(m); setOffline(false); }
    catch (e) { if (e instanceof ApiError && e.status === 0) setOffline(true); else { setOffline(false); setMe(null); } }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!offline) return; const f = () => void load(); window.addEventListener("online", f); const t = setInterval(f, 8000); return () => { window.removeEventListener("online", f); clearInterval(t); }; }, [offline, load]);
  const logout = async () => { await post("/auth/logout").catch(() => undefined); setMe(null); };
  const lang = useLang();
  if (!SLUG && !IS_OWNER) return <div className="flex h-full items-center justify-center p-6 text-center text-slate-600">{t("Open your dedicated application link to continue.")}</div>;
  return (
    <UiProvider key={lang}>
      {offline && !me ? <OfflineScreen onRetry={() => void load()} /> : me === undefined ? <Loading /> : me === null ? <LoginScreen owner={IS_OWNER} onDone={setMe} /> : IS_OWNER ? <OwnerApp me={me} onLogout={logout} /> : <Shell me={me} onLogout={logout} />}
    </UiProvider>
  );
}
