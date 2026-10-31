import { useEffect, useState } from "react";
import { Hand, MessagesSquare, Pause, Play, RotateCcw, CheckCheck, RefreshCw } from "lucide-react";
import { get, post } from "../api";
import { Button, Card, Empty, Loading, Notice, PageHeader, Select, StatusBadge, cx, fmtDate, useAction, useLoad, useUi } from "../ui";

export function Conversations({ openId }: { openId?: string }) {
  const [state, setState] = useState("");
  const list = useLoad(() => get("/conversations" + (state ? `?state=${state}` : "")), [state]);
  const [sel, setSel] = useState<string | null>(openId ?? null);
  const cats = useLoad(() => get("/categories"), []);
  const d = useLoad(() => (sel ? get(`/conversations/${sel}`) : Promise.resolve(null)), [sel]);
  const { busy, run } = useAction(); const { confirm } = useUi();
  useEffect(() => { if (openId) setSel(openId); }, [openId]);
  const act = async (action: string, extra: object = {}, ask?: string) => {
    if (ask && !(await confirm({ title: ask, confirmLabel: "Yes, continue" }))) return;
    await run(() => post(`/conversations/${sel}/action`, { action, ...extra }), "Done"); d.reload(); list.reload();
  };
  const c = d.data?.conversation;
  return (
    <>
      <PageHeader title="Conversations" subtitle="Follow each customer's journey and take control when needed. Replies you send from the WhatsApp Business app appear here and pause the automation."
        actions={<><Select value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by state"><option value="">All conversations</option>{["WAITING_FOR_CATEGORY", "VIDEO_SEQUENCE_ACTIVE", "WAITING_FOR_NEXT_VIDEO", "HUMAN_HANDLING", "PAUSED", "COMPLETED", "FAILED", "OPTED_OUT"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}</Select>
          <Button variant="secondary" onClick={() => { list.reload(); d.reload(); }}><RefreshCw className="h-4 w-4" /></Button></>} />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className={cx("lg:col-span-2", sel && "hidden lg:block")}>
          {list.loading && !list.data ? <Loading /> : list.data?.conversations.length === 0 ? <Empty icon={<MessagesSquare className="h-10 w-10" />} title="No conversations yet" /> : (
            <ul className="space-y-2">{list.data?.conversations.map((v: any) => (
              <li key={v.id}><button onClick={() => setSel(v.id)} className={cx("w-full rounded-xl border bg-white p-3 text-left shadow-sm hover:border-brand-500", sel === v.id ? "border-brand-600 ring-1 ring-brand-600" : "border-slate-200")}>
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{v.name || `+${v.wa_phone}`}</span><StatusBadge value={v.state.toLowerCase()} /></div>
                <div className="mt-1 flex items-center justify-between text-xs text-slate-500"><span>{v.category_name ?? "No category"} · {v.videos_sent} video{v.videos_sent === 1 ? "" : "s"}</span><span>window: {v.window.replace("_", " ")}</span></div></button></li>))}</ul>)}
        </div>
        <div className={cx("lg:col-span-3", !sel && "hidden lg:block")}>
          {!sel ? <Empty title="Select a conversation" /> : d.loading && !d.data ? <Loading /> : !c ? <Notice tone="error">{d.error}</Notice> : (
            <Card>
              <button className="mb-3 text-sm text-brand-700 lg:hidden" onClick={() => setSel(null)}>← Back</button>
              <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{c.name || `+${c.wa_phone}`}</h2><p className="text-xs text-slate-500">+{c.wa_phone} · {c.category_name ?? "no category"}</p></div>
                <div className="flex gap-1.5"><StatusBadge value={c.state.toLowerCase()} /><StatusBadge value={c.window} /></div></div>
              {c.window === "expired" && <div className="mt-3"><Notice tone="warn">The 24-hour WhatsApp window is closed. Automated free-form messages are paused until the customer writes again{c.paused_reason ? "" : " (or an approved template is configured)"}.</Notice></div>}
              {c.paused_reason && <p className="mt-2 text-xs text-slate-500">Paused reason: {c.paused_reason.replace(/_/g, " ")}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {!["PAUSED", "HUMAN_HANDLING", "FAILED", "COMPLETED", "OPTED_OUT"].includes(c.state) && <Button variant="secondary" className="min-h-9" loading={busy} onClick={() => act("pause")}><Pause className="h-4 w-4" />Pause</Button>}
                {["PAUSED", "HUMAN_HANDLING"].includes(c.state) && <Button className="min-h-9" loading={busy} onClick={() => act("resume")}><Play className="h-4 w-4" />Resume automation</Button>}
                {c.state === "FAILED" && <Button className="min-h-9" loading={busy} onClick={() => act("retry")}><RefreshCw className="h-4 w-4" />Retry</Button>}
                {!["HUMAN_HANDLING", "OPTED_OUT", "COMPLETED"].includes(c.state) && <Button variant="secondary" className="min-h-9" onClick={() => act("human")}><Hand className="h-4 w-4" />Mark human-handled</Button>}
                {!c.opted_out && <Button variant="secondary" className="min-h-9" onClick={() => act("restart", {}, "Restart this presentation from the first video?")}><RotateCcw className="h-4 w-4" />Restart</Button>}
                {c.state !== "COMPLETED" && <Button variant="ghost" className="min-h-9" onClick={() => act("complete", {}, "Mark this conversation as completed?")}><CheckCheck className="h-4 w-4" />Complete</Button>}
                {!c.opted_out && <Select className="!w-auto" value="" onChange={(e) => e.target.value && act("change_category", { category_id: e.target.value }, "Change this customer's category? The new sequence will start.")} aria-label="Change category"><option value="">Change category…</option>{(cats.data?.categories ?? []).filter((x: any) => x.active && x.id !== c.category_id).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
              </div>
              <div className="mt-4 max-h-[26rem] space-y-2 overflow-y-auto rounded-xl bg-[#efeae2] p-3">
                {d.data.messages.map((m: any) => {
                  const mine = m.direction !== "inbound";
                  return (<div key={m.id} className={cx("flex", mine ? "justify-end" : "justify-start")}><div className={cx("max-w-[80%] rounded-xl px-3 py-2 text-sm shadow-sm", m.direction === "inbound" ? "bg-white" : m.direction === "outbound_human" ? "bg-violet-100" : "bg-[#d9fdd3]")}>
                    {m.kind === "video" && <div className="mb-1 text-xs font-medium text-slate-600">🎬 Video</div>}{m.kind === "template" && <div className="mb-1 text-xs font-medium text-slate-600">📋 Template</div>}
                    <div className="whitespace-pre-wrap break-words" dir="auto">{m.body || "—"}</div>
                    <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-slate-500">{m.direction === "outbound_human" && <span>sent from Business app</span>}{mine && <span>{m.status}</span>}<span>{fmtDate(m.created_at)}</span></div>
                    {m.error && <div className="mt-1 text-[11px] text-rose-600">{m.error}</div>}</div></div>); })}
              </div>
              <details className="mt-3"><summary className="cursor-pointer text-sm font-medium text-slate-700">Sequence events ({d.data.events.length})</summary>
                <ul className="mt-2 space-y-1 text-xs text-slate-600">{d.data.events.map((e: any, i: number) => <li key={i} className="flex justify-between gap-2"><span>{e.type.replace(/_/g, " ")}{e.type === "state_change" && e.data ? `: ${JSON.parse(e.data).from} → ${JSON.parse(e.data).to}` : ""}</span><span className="shrink-0 text-slate-400">{fmtDate(e.created_at)}</span></li>)}</ul></details>
            </Card>)}
        </div>
      </div>
    </>
  );
}
