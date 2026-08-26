import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Pager } from "@/components/Pager";
import { GAME_LABEL, fmtMoney, type DuelGame } from "@/lib/arena";
import { duelUnitsToDollars } from "@contracts/duel";

const th = "text-muted-foreground";

const ROOM_STATUS_LABEL: Record<string, string> = {
  lobby: "等待中", active: "对局中", settled: "已结算", cancelled: "已取消", refunded: "已退款",
};

/** 决斗场管理：版本化配置（赢家税率）、资金池、房间审计、流水 */
export default function AdminArena() {
  const utils = trpc.useUtils();
  const [roomPage, setRoomPage] = useState(1);
  const [roomPageSize, setRoomPageSize] = useState(20);
  const [roomGame, setRoomGame] = useState("");
  const [roomStatus, setRoomStatus] = useState("");
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerPageSize, setLedgerPageSize] = useState(50);
  const [ledgerRoomId, setLedgerRoomId] = useState("");
  const [ledgerUserId, setLedgerUserId] = useState("");
  const [ledgerType, setLedgerType] = useState("");
  const [versionPage, setVersionPage] = useState(1);
  const [versionPageSize, setVersionPageSize] = useState(20);
  const normalizedRoomId = ledgerRoomId.trim();
  const validRoomId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedRoomId);
  const parsedUserId = Number(ledgerUserId);
  const control = trpc.admin.getDuelControl.useQuery({
    rooms: {
      page: roomPage,
      pageSize: roomPageSize,
      game: (roomGame || undefined) as "dice" | "blackjack" | undefined,
      status: (roomStatus || undefined) as "lobby" | "active" | "settled" | "cancelled" | "refunded" | undefined,
    },
    ledger: {
      page: ledgerPage,
      pageSize: ledgerPageSize,
      roomId: validRoomId ? normalizedRoomId : undefined,
      userId: Number.isInteger(parsedUserId) && parsedUserId > 0 ? parsedUserId : undefined,
      type: ledgerType.trim() || undefined,
    },
    versions: { page: versionPage, pageSize: versionPageSize },
  });
  const changeRoomFilter = (fn: () => void) => { fn(); setRoomPage(1); };
  const changeLedgerFilter = (fn: () => void) => { fn(); setLedgerPage(1); };
  const fail = (e: { message: string }) => toast.error(e.message);
  const save = trpc.admin.updateDuelConfig.useMutation({
    onSuccess: (r) => { toast.success(`已发布配置 v${r.version}`); utils.admin.getDuelControl.invalidate(); },
    onError: fail,
  });
  const voidRoom = trpc.admin.voidDuelRoom.useMutation({
    onSuccess: () => { toast.success("房间已从排行榜统计中作废，原始资金流水保持不变"); utils.admin.getDuelControl.invalidate(); },
    onError: fail,
  });
  const requestVoid = (roomId: string, code: string) => {
    const reason = window.prompt(`请输入房间 ${code} 的作废原因（至少 4 个字）。\n该操作只排除排行榜统计，不会反转余额或删除原始流水。`)?.trim();
    if (!reason) return;
    if (!window.confirm(`确认将房间 ${code} 从排行榜统计中作废？\n原因：${reason}\n此操作不可重复。`)) return;
    voidRoom.mutate({ roomId, reason });
  };

  const cfg = control.data?.config;
  type Form = {
    enabled: boolean; diceEnabled: boolean; blackjackEnabled: boolean;
    feePercent: string; betOptions: string;
    minPlayers: number; maxPlayers: number;
    roomTimeoutSeconds: number; actionTimeoutSeconds: number;
    singleBetLimit: string; dailyStakeLimit: string; dailyNetLossLimit: string;
  };
  // 用户编辑存 edits；展示值 = 服务端配置 + 未保存编辑，避免 effect 里同步 setState
  const [edits, setEdits] = useState<Form | null>(null);
  const form: Form | null = useMemo(() => (cfg
    ? (edits ?? {
        enabled: cfg.enabled, diceEnabled: cfg.diceEnabled, blackjackEnabled: cfg.blackjackEnabled,
        feePercent: (cfg.feeBasisPoints / 100).toString(),
        betOptions: cfg.betOptions.join(", "),
        minPlayers: cfg.minPlayers, maxPlayers: cfg.maxPlayers,
        roomTimeoutSeconds: cfg.roomTimeoutSeconds, actionTimeoutSeconds: cfg.actionTimeoutSeconds,
        singleBetLimit: String(cfg.singleBetLimit),
        dailyStakeLimit: String(cfg.dailyStakeLimit),
        dailyNetLossLimit: String(cfg.dailyNetLossLimit),
      })
    : null), [cfg, edits]);
  const setForm = (next: Form) => setEdits(next);

  // 税率实时计算示例
  const example = useMemo(() => {
    if (!form) return null;
    const pct = Number(form.feePercent);
    const bets = form.betOptions.split(/[,，\s]+/).map(Number).filter((n) => n > 0);
    const bet = bets[0] ?? 0;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100 || !bet) return null;
    const players = 4;
    const gross = bet * players;
    const tax = gross * (pct / 100);
    return { players, bet, gross, tax, net: gross - tax, pct };
  }, [form]);

  const submit = () => {
    if (!form) return;
    const pct = Number(form.feePercent);
    const betOptions = form.betOptions.split(/[,，\s]+/).map(Number).filter((n) => n > 0);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { toast.error("赢家税率必须是 0–100 的数字"); return; }
    if (!betOptions.length) { toast.error("至少配置一个押注档位"); return; }
    const nums = [form.singleBetLimit, form.dailyStakeLimit, form.dailyNetLossLimit].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n <= 0)) { toast.error("限额必须是正数"); return; }
    save.mutate({
      enabled: form.enabled, diceEnabled: form.diceEnabled, blackjackEnabled: form.blackjackEnabled,
      feeBasisPoints: Math.round(pct * 100),
      betOptions,
      minPlayers: form.minPlayers, maxPlayers: form.maxPlayers,
      roomTimeoutSeconds: form.roomTimeoutSeconds, actionTimeoutSeconds: form.actionTimeoutSeconds,
      singleBetLimit: nums[0], dailyStakeLimit: nums[1], dailyNetLossLimit: nums[2],
    });
  };

  if (control.isLoading) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">加载中…</div>;
  if (!cfg || !form) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{control.error?.message ?? "决斗场配置尚未初始化"}</div>;

  const numInput = "font-num w-full rounded-lg border border-border bg-[hsl(var(--admin-control))] px-3 py-2 text-sm text-foreground outline-none focus:border-primary";

  return (
    <div className="space-y-6">
      {/* 配置表单 */}
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="t-section">决斗场配置 <span className="font-num text-muted-foreground">当前 v{cfg.version}</span></h3>
            <p className="mt-1 text-xs text-muted-foreground">每次保存生成新版本；进行中的房间仍按开局时的税率快照结算</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            平台费资金池
            <span className="font-num text-sm font-bold text-accent">{fmtMoney(control.data?.fund.balance ?? 0)}</span>
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {([
            ["决斗场总开关", "enabled", form.enabled],
            ["幸运骰子", "diceEnabled", form.diceEnabled],
            ["二十一点", "blackjackEnabled", form.blackjackEnabled],
          ] as const).map(([label, key, value]) => (
            <label key={key} className="flex items-center justify-between rounded-lg border border-border bg-[hsl(var(--admin-control))] px-3 py-2.5 text-sm text-foreground">
              {label}
              <Switch checked={value} onCheckedChange={(v) => setForm({ ...form, [key]: v })} />
            </label>
          ))}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">赢家税率（%，0–100，从毛奖池扣除）</p>
            <input className={numInput} value={form.feePercent} onChange={(e) => setForm({ ...form, feePercent: e.target.value })} inputMode="decimal" />
            {Number(form.feePercent) > 10 && (
              <p className="mt-1.5 rounded border border-[#EF5459]/40 bg-[#EF5459]/10 px-2 py-1 text-[10px] font-bold text-[#EF5459]">
                高税率警告：超过 10% 会显著降低玩家参与意愿，请确认这是有意为之
              </p>
            )}
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">固定押注档位（美元，逗号分隔，≤12 档）</p>
            <input className={numInput} value={form.betOptions} onChange={(e) => setForm({ ...form, betOptions: e.target.value })} placeholder="0.1, 0.5, 1, 5" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">最少人数</p>
              <input className={numInput} type="number" min={2} max={6} value={form.minPlayers} onChange={(e) => setForm({ ...form, minPlayers: Number(e.target.value) })} />
            </div>
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">最多人数</p>
              <input className={numInput} type="number" min={2} max={6} value={form.maxPlayers} onChange={(e) => setForm({ ...form, maxPlayers: Number(e.target.value) })} />
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">房间过期时间（秒）</p>
            <input className={numInput} type="number" min={60} value={form.roomTimeoutSeconds} onChange={(e) => setForm({ ...form, roomTimeoutSeconds: Number(e.target.value) })} />
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">二十一点行动超时（秒，超时托管停牌）</p>
            <input className={numInput} type="number" min={5} max={600} value={form.actionTimeoutSeconds} onChange={(e) => setForm({ ...form, actionTimeoutSeconds: Number(e.target.value) })} />
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">单局押注上限（$）</p>
            <input className={numInput} value={form.singleBetLimit} onChange={(e) => setForm({ ...form, singleBetLimit: e.target.value })} inputMode="decimal" />
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">每日押注上限（$ / 人）</p>
            <input className={numInput} value={form.dailyStakeLimit} onChange={(e) => setForm({ ...form, dailyStakeLimit: e.target.value })} inputMode="decimal" />
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">每日净亏损上限（$ / 人）</p>
            <input className={numInput} value={form.dailyNetLossLimit} onChange={(e) => setForm({ ...form, dailyNetLossLimit: e.target.value })} inputMode="decimal" />
          </div>
        </div>

        {/* 计算示例 */}
        {example && (
          <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs leading-5 text-muted-foreground">
            <span className="font-bold text-accent">计算示例：</span>
            {example.players} 人 × 押注 {fmtMoney(example.bet)} → 毛奖池 <span className="font-num text-foreground">{fmtMoney(example.gross)}</span>，
            赢家税 {example.pct}% = <span className="font-num text-[#EF5459]">{fmtMoney(example.tax)}</span>，
            税后奖池 <span className="font-num text-[#00B77D]">{fmtMoney(example.net)}</span>（由赢家平分）
          </div>
        )}

        <button onClick={submit} disabled={save.isPending} className="btn-3d mt-5 rounded-lg bg-accent px-8 py-2.5 text-sm font-black text-accent-foreground disabled:opacity-40">
          {save.isPending ? "发布中…" : "保存并发布新版本"}
        </button>
      </section>

      {/* 版本历史 */}
      <section className="rounded-xl border border-border bg-card p-6">
        <h3 className="t-section">配置版本</h3>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader><TableRow className="border-border hover:bg-transparent">
              <TableHead className={th}>版本</TableHead><TableHead className={th}>状态</TableHead>
              <TableHead className={th}>赢家税率</TableHead><TableHead className={th}>押注档位</TableHead>
              <TableHead className={th}>人数</TableHead><TableHead className={th}>时间</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {control.data?.versions.map((v) => (
                <TableRow key={v.id} className="border-border">
                  <TableCell className="font-num text-foreground">v{v.version}</TableCell>
                  <TableCell>{v.active ? <span className="text-[#00B77D]">生效中</span> : <span className="text-muted-foreground">历史</span>}</TableCell>
                  <TableCell className="font-num text-accent">{(v.feeBasisPoints / 100).toFixed(2)}%</TableCell>
                  <TableCell className="font-num text-xs text-muted-foreground">{v.betOptions.map((b) => `$${b}`).join(" / ")}</TableCell>
                  <TableCell className="font-num text-xs text-muted-foreground">{v.minPlayers}–{v.maxPlayers}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString("zh-CN")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {control.data && <Pager className="mt-4" {...control.data.pages.versions} pageSize={versionPageSize}
          onPage={setVersionPage} onPageSize={(size) => { setVersionPageSize(size); setVersionPage(1); }} unit="个版本" />}
      </section>

      {/* 房间审计 */}
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="t-section">房间审计</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select value={roomGame || "__all__"} onChange={(event) => changeRoomFilter(() => setRoomGame(event.target.value === "__all__" ? "" : event.target.value))}
              className="h-8 rounded border border-border bg-[hsl(var(--admin-control))] px-2 text-muted-foreground">
              <option value="__all__">全部玩法</option><option value="dice">幸运骰子</option><option value="blackjack">二十一点</option>
            </select>
            <select value={roomStatus || "__all__"} onChange={(event) => changeRoomFilter(() => setRoomStatus(event.target.value === "__all__" ? "" : event.target.value))}
              className="h-8 rounded border border-border bg-[hsl(var(--admin-control))] px-2 text-muted-foreground">
              <option value="__all__">全部状态</option><option value="lobby">等待中</option><option value="active">对局中</option><option value="settled">已结算</option><option value="cancelled">已取消</option><option value="refunded">已退款</option>
            </select>
            {(roomGame || roomStatus) && <button type="button" className="text-primary hover:underline"
              onClick={() => changeRoomFilter(() => { setRoomGame(""); setRoomStatus(""); })}>清除筛选</button>}
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader><TableRow className="border-border hover:bg-transparent">
              <TableHead className={th}>房间码</TableHead><TableHead className={th}>玩法</TableHead>
              <TableHead className={th}>状态</TableHead><TableHead className={th}>配置版本</TableHead>
              <TableHead className={`text-right ${th}`}>押注 / 人数</TableHead>
              <TableHead className={`text-right ${th}`}>毛奖池</TableHead>
              <TableHead className={`text-right ${th}`}>赢家税</TableHead>
              <TableHead className={th}>时间</TableHead><TableHead className={`text-right ${th}`}>统计操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {control.data?.rooms.map((r) => (
                <TableRow key={r.id} className="border-border">
                  <TableCell className="font-num font-bold tracking-widest text-accent">{r.code}</TableCell>
                  <TableCell className="text-foreground">{GAME_LABEL[r.game as DuelGame] ?? r.game}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.voidedAt ? "已作废（统计）" : ROOM_STATUS_LABEL[r.status] ?? r.status}</TableCell>
                  <TableCell className="font-num text-xs text-muted-foreground">v{r.configVersion}</TableCell>
                  <TableCell className="font-num text-right text-xs text-foreground">{fmtMoney(r.bet)} × {r.playerCount}</TableCell>
                  <TableCell className="font-num text-right text-xs text-foreground">{r.pot > 0 ? fmtMoney(r.pot) : "—"}</TableCell>
                  <TableCell className="font-num text-right text-xs text-[#EF5459]">{r.fee > 0 ? fmtMoney(r.fee) : "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</TableCell>
                  <TableCell className="text-right">
                    {r.voidedAt ? (
                      <span className="text-[10px] text-muted-foreground" title={r.voidReason ?? undefined}>已排除</span>
                    ) : r.status === "settled" ? (
                      <button type="button" disabled={voidRoom.isPending} onClick={() => requestVoid(r.id, r.code)} className="text-[10px] font-bold text-[#EF5459] hover:underline disabled:opacity-40">异常作废</button>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))}
              {!control.data?.rooms.length && (
                <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">暂无决斗房间</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {control.data && <Pager className="mt-4" {...control.data.pages.rooms} pageSize={roomPageSize}
          onPage={setRoomPage} onPageSize={(size) => { setRoomPageSize(size); setRoomPage(1); }} unit="个房间" />}
      </section>

      {/* 结算流水 */}
      <section className="rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="t-section">决斗流水</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input value={ledgerRoomId} onChange={(event) => changeLedgerFilter(() => setLedgerRoomId(event.target.value))}
              placeholder="房间 UUID" className="h-8 w-44 rounded border border-border bg-[hsl(var(--admin-control))] px-2 text-xs text-foreground placeholder:text-muted-foreground/50" />
            <input value={ledgerUserId} onChange={(event) => changeLedgerFilter(() => setLedgerUserId(event.target.value))}
              placeholder="用户 ID" inputMode="numeric" className="h-8 w-24 rounded border border-border bg-[hsl(var(--admin-control))] px-2 text-xs text-foreground placeholder:text-muted-foreground/50" />
            <input value={ledgerType} onChange={(event) => changeLedgerFilter(() => setLedgerType(event.target.value))}
              placeholder="流水类型" className="h-8 w-28 rounded border border-border bg-[hsl(var(--admin-control))] px-2 text-xs text-foreground placeholder:text-muted-foreground/50" />
            {(ledgerRoomId || ledgerUserId || ledgerType) && <button type="button" className="text-xs text-primary hover:underline"
              onClick={() => changeLedgerFilter(() => { setLedgerRoomId(""); setLedgerUserId(""); setLedgerType(""); })}>清除筛选</button>}
          </div>
        </div>
        {ledgerRoomId && !validRoomId && <p className="mt-2 text-[10px] text-[#EF5459]">房间 UUID 未完整时暂不应用该条件</p>}
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader><TableRow className="border-border hover:bg-transparent">
              <TableHead className={th}>时间</TableHead><TableHead className={th}>用户</TableHead>
              <TableHead className={th}>类型</TableHead><TableHead className={`text-right ${th}`}>金额</TableHead>
              <TableHead className={`text-right ${th}`}>变动后余额</TableHead><TableHead className={th}>备注</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {control.data?.ledger.map((entry) => (
                <TableRow key={entry.id} className="border-border">
                  <TableCell className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString("zh-CN")}</TableCell>
                  <TableCell className="font-num text-xs text-muted-foreground">#{entry.userId}</TableCell>
                  <TableCell className="text-xs text-foreground">{entry.type}</TableCell>
                  <TableCell className={`font-num text-right text-xs ${entry.amount >= 0 ? "text-[#00B77D]" : "text-[#EF5459]"}`}>
                    {entry.amount >= 0 ? "+" : ""}{fmtMoney(entry.amount)}
                  </TableCell>
                  <TableCell className="font-num text-right text-xs text-muted-foreground">{entry.userBalanceAfterUnits == null ? "—" : fmtMoney(duelUnitsToDollars(entry.userBalanceAfterUnits))}</TableCell>
                  <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground" title={entry.note ?? undefined}>{entry.note ?? "—"}</TableCell>
                </TableRow>
              ))}
              {!control.data?.ledger.length && (
                <TableRow className="border-border"><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">暂无流水</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {control.data && <Pager className="mt-4" {...control.data.pages.ledger} pageSize={ledgerPageSize}
          onPage={setLedgerPage} onPageSize={(size) => { setLedgerPageSize(size); setLedgerPage(1); }} unit="笔" />}
      </section>
    </div>
  );
}
