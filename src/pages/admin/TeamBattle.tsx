import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager } from "@/components/Pager";

const STATUS: Record<string, string> = { lobby: "组队中", betting: "投注中", voting: "投票中", settled: "已结算", disputed: "争议", refunded: "已退款", cancelled: "已取消" };
const units = (value: number | null) => value == null ? "—" : `$${(value / 1_000_000).toFixed(6)}`;

export default function TeamBattleAdmin() {
  const utils = trpc.useUtils();
  const control = trpc.teamBattle.adminControl.useQuery();
  const [draft, setDraft] = useState<{ enabled?: boolean; singleBetLimit?: number; userBetLimit?: number; roomBetLimit?: number }>({});
  const config = control.data ? {
    enabled: draft.enabled ?? control.data.enabled,
    singleBetLimit: draft.singleBetLimit ?? control.data.singleBetLimit,
    userBetLimit: draft.userBetLimit ?? control.data.userBetLimit,
    roomBetLimit: draft.roomBetLimit ?? control.data.roomBetLimit,
  } : null;
  const [roomPage, setRoomPage] = useState(1); const [roomPageSize, setRoomPageSize] = useState(20);
  const [roomMode, setRoomMode] = useState<"1v1" | "3v3" | "5v5" | "">(""); const [roomStatus, setRoomStatus] = useState<"lobby" | "betting" | "voting" | "settled" | "disputed" | "cancelled" | "refunded" | "">("");
  const rooms = trpc.teamBattle.adminRoomsPage.useQuery({ page: roomPage, pageSize: roomPageSize, mode: roomMode || undefined, status: roomStatus || undefined });
  const [betPage, setBetPage] = useState(1); const [betPageSize, setBetPageSize] = useState(20); const [betRoom, setBetRoom] = useState("");
  const validBetRoom = /^[0-9a-f-]{36}$/i.test(betRoom);
  const bets = trpc.teamBattle.adminBetsPage.useQuery({ page: betPage, pageSize: betPageSize, roomId: validBetRoom ? betRoom : undefined });
  const [ledgerPage, setLedgerPage] = useState(1); const [ledgerPageSize, setLedgerPageSize] = useState(20); const [ledgerRoom, setLedgerRoom] = useState("");
  const validLedgerRoom = /^[0-9a-f-]{36}$/i.test(ledgerRoom);
  const ledger = trpc.teamBattle.adminLedgerPage.useQuery({ page: ledgerPage, pageSize: ledgerPageSize, roomId: validLedgerRoom ? ledgerRoom : undefined });
  const refresh = () => { utils.teamBattle.invalidate(); };
  const save = trpc.teamBattle.updateAdminConfig.useMutation({ onSuccess: () => { toast.success("战队配置已发布"); setDraft({}); refresh(); }, onError: (error) => toast.error(error.message) });
  const refund = trpc.teamBattle.adminRefundDisputed.useMutation({ onSuccess: () => { toast.success("争议房已全额退款"); refresh(); }, onError: (error) => toast.error(error.message) });
  const reopen = trpc.teamBattle.adminReopenVoting.useMutation({ onSuccess: () => { toast.success("已重开全员投票"); refresh(); }, onError: (error) => toast.error(error.message) });
  const reason = (action: "refund" | "reopen", roomId: string) => {
    const text = window.prompt(action === "refund" ? "请输入作废退款原因" : "请输入重开投票原因");
    if (!text?.trim()) return;
    if (action === "refund") refund.mutate({ roomId, requestId: crypto.randomUUID(), reason: text.trim() });
    else reopen.mutate({ roomId, requestId: crypto.randomUUID(), reason: text.trim() });
  };
  if (control.error) return <div className="rounded-xl border border-[#EF5459]/40 bg-card p-6 text-[#EF5459]">加载失败：{control.error.message}</div>;
  if (!config || !control.data) return <div className="rounded-xl border border-border bg-card p-6 text-muted-foreground">加载战队配置中…</div>;
  const moneyField = (key: "singleBetLimit" | "userBetLimit" | "roomBetLimit", label: string) => <label className="space-y-2"><span className="text-xs text-muted-foreground">{label}</span><Input type="number" min="0.000001" step="0.000001" value={config[key]} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} className="border-border bg-[hsl(var(--admin-control))]" /></label>;

  return <div className="w-full max-w-[90rem] space-y-6">
    <section className="rounded-xl border border-border bg-card p-6"><div className="flex items-center justify-between"><div><h2 className="t-section">战队对抗配置</h2><p className="mt-2 text-xs text-muted-foreground">固定败方池税率 10%；管理端只能作废退款或重开投票，不能指定赢家。</p></div><Switch checked={config.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} /></div><div className="mt-5 grid gap-4 md:grid-cols-3">{moneyField("singleBetLimit", "单笔投注上限 $")}{moneyField("userBetLimit", "单用户/房累计上限 $")}{moneyField("roomBetLimit", "房间总奖池上限 $")}</div><div className="mt-5 flex items-center justify-between"><p className="font-num text-xs text-muted-foreground">配置 v{control.data.version} · 平台税基金 {units(control.data.platformFundUnits)}</p><button onClick={() => save.mutate(config)} disabled={save.isPending} className="btn-3d rounded-lg bg-accent px-8 py-2.5 font-black text-accent-foreground disabled:opacity-40">保存新版本</button></div></section>

    <section className="rounded-xl border border-border bg-card p-6"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="t-section">战队房审计</h2><div className="flex gap-2"><select value={roomMode} onChange={(event) => { setRoomMode(event.target.value as typeof roomMode); setRoomPage(1); }} className="h-9 rounded border border-border bg-[hsl(var(--admin-control))] px-2 text-xs"><option value="">全部房型</option><option>1v1</option><option>3v3</option><option>5v5</option></select><select value={roomStatus} onChange={(event) => { setRoomStatus(event.target.value as typeof roomStatus); setRoomPage(1); }} className="h-9 rounded border border-border bg-[hsl(var(--admin-control))] px-2 text-xs"><option value="">全部状态</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div><div className="mt-4 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>房间</TableHead><TableHead>房型</TableHead><TableHead>状态</TableHead><TableHead>A/B 池</TableHead><TableHead>税/派彩</TableHead><TableHead>时间</TableHead><TableHead className="text-right">争议操作</TableHead></TableRow></TableHeader><TableBody>{rooms.data?.items.map((room) => <TableRow key={room.id}><TableCell><p className="font-num font-bold text-accent">{room.code}</p><p className="text-[9px] text-muted-foreground">{room.id}</p></TableCell><TableCell>{room.mode}</TableCell><TableCell>{STATUS[room.status]}</TableCell><TableCell className="font-num text-xs">{units(room.poolAUnits)} / {units(room.poolBUnits)}</TableCell><TableCell className="font-num text-xs">税 {units(room.losingPoolTaxUnits)}<br />派彩 {units(room.payoutUnits)}</TableCell><TableCell className="text-xs text-muted-foreground">{new Date(room.createdAt).toLocaleString("zh-CN")}</TableCell><TableCell className="text-right">{room.status === "disputed" ? <span className="space-x-2"><button onClick={() => reason("reopen", room.id)} className="text-xs font-bold text-[#7db4ff]">重开投票</button><button onClick={() => reason("refund", room.id)} className="text-xs font-bold text-[#EF5459]">全额退款</button></span> : "—"}</TableCell></TableRow>)}{!rooms.data?.items.length && <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">暂无房间</TableCell></TableRow>}</TableBody></Table></div>{rooms.data && <Pager className="mt-4" page={rooms.data.page} totalPages={rooms.data.totalPages} total={rooms.data.total} pageSize={roomPageSize} onPage={setRoomPage} onPageSize={(size) => { setRoomPageSize(size); setRoomPage(1); }} unit="个房间" />}</section>

    <section className="grid gap-6 xl:grid-cols-2"><div className="rounded-xl border border-border bg-card p-6"><h2 className="t-section">投注审计</h2><Input value={betRoom} onChange={(event) => { setBetRoom(event.target.value); setBetPage(1); }} placeholder="按房间 UUID 筛选" className="mt-4 border-border bg-[hsl(var(--admin-control))]" /><div className="mt-4 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>用户/队</TableHead><TableHead>金额</TableHead><TableHead>状态/派彩</TableHead></TableRow></TableHeader><TableBody>{bets.data?.items.map((bet) => <TableRow key={bet.id}><TableCell className="text-xs">{new Date(bet.createdAt).toLocaleString("zh-CN")}</TableCell><TableCell>#{bet.userId} / {bet.team}</TableCell><TableCell className="font-num">{units(bet.amountUnits)}</TableCell><TableCell className="text-xs">{bet.status} / {units(bet.payoutUnits)}</TableCell></TableRow>)}</TableBody></Table></div>{bets.data && <Pager className="mt-4" page={bets.data.page} totalPages={bets.data.totalPages} total={bets.data.total} pageSize={betPageSize} onPage={setBetPage} onPageSize={(size) => { setBetPageSize(size); setBetPage(1); }} />}</div>
      <div className="rounded-xl border border-border bg-card p-6"><h2 className="t-section">资金流水</h2><Input value={ledgerRoom} onChange={(event) => { setLedgerRoom(event.target.value); setLedgerPage(1); }} placeholder="按房间 UUID 筛选" className="mt-4 border-border bg-[hsl(var(--admin-control))]" /><div className="mt-4 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>用户</TableHead><TableHead>类型</TableHead><TableHead className="text-right">金额</TableHead></TableRow></TableHeader><TableBody>{ledger.data?.items.map((row) => <TableRow key={row.id}><TableCell className="text-xs">{new Date(row.createdAt).toLocaleString("zh-CN")}</TableCell><TableCell>#{row.userId ?? "平台"}</TableCell><TableCell className="text-xs">{row.type}</TableCell><TableCell className={`font-num text-right ${row.amountUnits >= 0 ? "text-[#00B77D]" : "text-[#EF5459]"}`}>{units(row.amountUnits)}</TableCell></TableRow>)}</TableBody></Table></div>{ledger.data && <Pager className="mt-4" page={ledger.data.page} totalPages={ledger.data.totalPages} total={ledger.data.total} pageSize={ledgerPageSize} onPage={setLedgerPage} onPageSize={(size) => { setLedgerPageSize(size); setLedgerPage(1); }} />}</div></section>
  </div>;
}
