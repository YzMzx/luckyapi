import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Copy, Lock, LogOut, ShieldCheck, Swords } from "lucide-react";
import { toast } from "sonner";
import { SiteNav } from "@/components/SiteNav";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import { requestBalanceRefresh } from "@/lib/balance-sync";

const STATUS: Record<string, string> = { lobby: "组队中", betting: "投注开放", voting: "投注已关 · 投票中", settled: "已结算", disputed: "争议待管理员处理", refunded: "已退款", cancelled: "已取消" };
const money = (value: number) => `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00")}`;

export default function TeamBattleRoom() {
  const { roomId = "" } = useParams();
  const [search] = useSearchParams();
  const roomCode = search.get("code")?.toUpperCase();
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const utils = trpc.useUtils();
  const room = trpc.teamBattle.room.useQuery({ roomId, code: roomCode || undefined }, { enabled: !!user && !!roomId, refetchInterval: 1_500, retry: false });
  const balanceSyncMarker = useRef("");
  const [betTeam, setBetTeam] = useState<"A" | "B">("A");
  const [amount, setAmount] = useState("1");
  const ids = useRef<Record<string, string>>({});
  const rid = (key: string) => (ids.current[key] ??= crypto.randomUUID());
  const done = (key: string) => { delete ids.current[key]; };
  const refresh = () => { utils.teamBattle.room.invalidate(); utils.teamBattle.listRoomsPage.invalidate(); requestBalanceRefresh(); };
  const failure = (error: { message: string }) => toast.error(error.message);
  const takeSeat = trpc.teamBattle.takeSeat.useMutation({ onSuccess: (_next, input) => { done(`seat:${input.team}:${input.seat}`); refresh(); toast.success(`已坐入 ${input.team}${input.seat}`); }, onError: failure });
  const leaveSeat = trpc.teamBattle.leaveSeat.useMutation({ onSuccess: () => { done("leaveSeat"); refresh(); toast.success("已下到观众席"); }, onError: failure });
  const lock = trpc.teamBattle.lockRoster.useMutation({ onSuccess: () => { done("lock"); refresh(); toast.success("阵容已锁定，投注开放"); }, onError: failure });
  const bet = trpc.teamBattle.placeBet.useMutation({ onSuccess: () => { done("bet"); refresh(); toast.success("投注已进入托管"); }, onError: failure });
  const vote = trpc.teamBattle.vote.useMutation({ onSuccess: () => { done("vote"); refresh(); }, onError: failure });

  useEffect(() => {
    const data = room.data;
    if (!data || (data.status !== "settled" && data.status !== "refunded")) return;
    const marker = `${data.id}:${data.status}:${data.finishedAt?.getTime() ?? ""}`;
    if (balanceSyncMarker.current === marker) return;
    balanceSyncMarker.current = marker;
    requestBalanceRefresh();
  }, [room.data, utils]);

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  if (room.error) return <div className="min-h-screen"><SiteNav user={user} /><main className="mx-auto max-w-xl px-4 py-20 text-center"><p className="text-[#EF5459]">房间加载失败：{room.error.message}</p><Link to="/arena/team" className="mt-5 inline-block font-bold text-[#FFB700]">返回战队大厅</Link></main></div>;
  if (!room.data) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">读取战队房…</div>;
  const data = room.data;
  const me = data.viewer.player;
  const isOwner = data.ownerId === user.id;
  const teamA = data.players.filter((player) => player.team === "A");
  const teamB = data.players.filter((player) => player.team === "B");
  const canVote = !!me && (data.status === "betting" || data.status === "voting") && data.odds.ready && !data.viewer.voted;
  const sideButton = (team: "A" | "B", selected: boolean, onClick: () => void, disabled = false) => <button type="button" disabled={disabled} onClick={onClick} className={cn("rounded-lg border py-2 text-sm font-black disabled:opacity-30", selected ? team === "A" ? "border-[#176EFF] bg-[#176EFF]/15 text-[#7db4ff]" : "border-[#EF5459] bg-[#EF5459]/15 text-[#ff8f93]" : "border-border text-muted-foreground")}>{team} 队</button>;

  return <div className="min-h-screen"><SiteNav user={user} /><main className="mx-auto max-w-6xl px-4 py-10">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><Link to="/arena/team" className="text-xs font-bold text-[#FFB700] hover:underline">← 战队大厅</Link><h1 className="mt-2 flex items-center gap-2 text-3xl font-black text-[#fce1b6]"><Swords className="text-[#FFB700]" />{data.mode} 战队房</h1><p className="mt-2 text-xs text-muted-foreground">房间码 <button onClick={() => { navigator.clipboard.writeText(data.code); toast.success("房间码已复制"); }} className="font-num font-bold tracking-[0.25em] text-[#FFB700]">{data.code} <Copy className="inline h-3 w-3" /></button> · {data.visibility === "private" ? "私密" : "公开"}</p></div><span className="rounded-full border border-[#FFB700]/40 bg-[#FFB700]/10 px-4 py-1.5 text-xs font-bold text-[#FFB700]">{STATUS[data.status]}</span></div>

    <section className="mt-6 grid gap-4 lg:grid-cols-[1fr_300px_1fr]">
      {(["A", "B"] as const).map((team, index) => {
        const players = team === "A" ? teamA : teamB;
        return <div key={team} className={cn("rounded-2xl border bg-[#101d2b] p-5", team === "A" ? "border-[#176EFF]/40" : "border-[#EF5459]/40", index === 1 && "lg:col-start-3")}>
          <h2 className={cn("text-center text-xl font-black", team === "A" ? "text-[#7db4ff]" : "text-[#ff8f93]")}>{team} 队</h2>
          <div className="mt-4 space-y-2">
            {Array.from({ length: data.seatsPerTeam }, (_, seatIndex) => {
              const seat = seatIndex + 1;
              const player = players.find((row) => row.seat === seat);
              if (!player) return <button key={seat} type="button"
                onClick={() => takeSeat.mutate({ roomId: data.id, roomCode: roomCode || undefined, requestId: rid(`seat:${team}:${seat}`), team, seat })}
                disabled={data.status !== "lobby" || data.rosterLocked || !!me || takeSeat.isPending}
                className="flex h-14 w-full items-center justify-between rounded-xl border border-dashed border-border bg-[#162638]/30 px-4 text-left transition-colors hover:border-[#FFB700]/60 hover:bg-[#FFB700]/5 disabled:cursor-not-allowed disabled:opacity-50">
                <span><span className="text-sm font-bold text-muted-foreground">空席 {team}{seat}</span><span className="mt-0.5 block text-[10px] text-[#FFB700]">{me ? "请先下到观众席" : data.status === "lobby" ? "点击占座" : "阵容已锁定"}</span></span>
                <span className="font-num text-xs text-muted-foreground">{seat}/{data.seatsPerTeam}</span>
              </button>;
              return <div key={seat} className={cn("flex h-14 items-center justify-between rounded-xl border bg-[#162638]/60 px-4", player.userId === user.id ? "border-[#FFB700]/60" : "border-border")}><div><p className="text-sm font-bold text-[#fce1b6]">{player.groupName ?? player.username}</p><p className="text-[10px] text-muted-foreground">席位 {team}{player.seat}{player.userId === data.ownerId ? " · 房主" : ""}{player.userId === user.id ? " · 我" : ""}</p></div>{player.taxShareUnits ? <span className="font-num text-xs text-[#00B77D]">税分成 {money(player.taxShare)}</span> : null}</div>;
            })}
          </div>
        </div>;
      })}
      <div className="rounded-2xl border border-[#FFB700]/30 bg-[#101d2b] p-5 lg:col-start-2 lg:row-start-1"><p className="text-center text-xs font-bold tracking-[0.3em] text-[#af915f]">LIVE POOL</p><div className="mt-4 grid grid-cols-2 gap-2 text-center"><div className="rounded-lg bg-[#176EFF]/10 p-3"><p className="text-[10px] text-[#7db4ff]">A 池</p><p className="font-num mt-1 font-black">{money(data.poolA)}</p><p className="font-num text-[10px] text-muted-foreground">{data.odds.A ? `${data.odds.A.decimal.toFixed(3)}×` : "待形成"}</p></div><div className="rounded-lg bg-[#EF5459]/10 p-3"><p className="text-[10px] text-[#ff8f93]">B 池</p><p className="font-num mt-1 font-black">{money(data.poolB)}</p><p className="font-num text-[10px] text-muted-foreground">{data.odds.B ? `${data.odds.B.decimal.toFixed(3)}×` : "待形成"}</p></div></div><p className="mt-3 text-center text-[10px] leading-4 text-muted-foreground">倍率为预计本金+利润返还倍数；随奖池实时变化，投注记录保留当时快照。</p></div>
    </section>

    <section className="mt-5 grid gap-4 lg:grid-cols-3">
      <div className="rounded-xl border border-border bg-[#101d2b] p-5"><h2 className="text-sm font-bold text-[#fce1b6]">阵容操作</h2><p className="mt-2 text-xs text-muted-foreground">当前：{isOwner ? "房主 · " : ""}{me ? `${me.team}${me.seat} 选手` : "观众席"}。仅组队阶段可点击空席上场或下到观众席；房主身份不会转移。</p>{isOwner && data.status === "lobby" && <button onClick={() => lock.mutate({ roomId: data.id, requestId: rid("lock") })} disabled={lock.isPending} className="btn-3d mt-4 w-full rounded-lg bg-[#FFB700] py-2.5 font-black text-[#162638] disabled:opacity-40"><Lock className="mr-1 inline h-4 w-4" />锁定满席阵容并开放投注</button>}{me && data.status === "lobby" && <button onClick={() => leaveSeat.mutate({ roomId: data.id, roomCode: roomCode || undefined, requestId: rid("leaveSeat") })} disabled={leaveSeat.isPending} className="mt-3 w-full rounded-lg border border-[#EF5459]/40 py-2 text-xs font-bold text-[#EF5459] disabled:opacity-40"><LogOut className="mr-1 inline h-3.5 w-3.5" />下到观众席</button>}</div>
      <div className="rounded-xl border border-border bg-[#101d2b] p-5"><h2 className="text-sm font-bold text-[#fce1b6]">奖池投注</h2><div className="mt-3 grid grid-cols-2 gap-2">{sideButton("A", betTeam === "A", () => setBetTeam("A"), !!me && me.team !== "A")}{sideButton("B", betTeam === "B", () => setBetTeam("B"), !!me && me.team !== "B")}</div><input type="number" min="0.000001" step="0.000001" value={amount} onChange={(event) => setAmount(event.target.value)} className="font-num mt-3 w-full rounded-lg border border-border bg-[#162638] px-3 py-2 text-sm" /><button disabled={data.status !== "betting" || bet.isPending || Number(amount) <= 0 || (!!me && me.team !== betTeam)} onClick={() => bet.mutate({ roomId: data.id, roomCode: roomCode || undefined, requestId: rid("bet"), team: betTeam, amount: Number(amount) })} className="btn-3d mt-3 w-full rounded-lg bg-[#FFB700] py-2.5 font-black text-[#162638] disabled:opacity-40">{bet.isPending ? "托管中…" : data.status === "betting" ? "确认投注" : "投注已关闭"}</button><p className="mt-2 text-[10px] text-muted-foreground">我的 A/B 累计：{money(data.viewer.totalBetA)} / {money(data.viewer.totalBetB)}</p></div>
      <div className="rounded-xl border border-border bg-[#101d2b] p-5"><h2 className="text-sm font-bold text-[#fce1b6]">选手终局投票</h2><p className="mt-2 text-xs text-muted-foreground">进度 {data.voteProgress.submitted}/{data.voteProgress.totalPlayers} · 任一方达到 {data.voteProgress.threshold} 票即结算。首票提交时原子关闭投注。</p><div className="mt-3 grid grid-cols-2 gap-2">{sideButton("A", false, () => vote.mutate({ roomId: data.id, requestId: rid("vote"), winnerTeam: "A" }), !canVote || vote.isPending)}{sideButton("B", false, () => vote.mutate({ roomId: data.id, requestId: rid("vote"), winnerTeam: "B" }), !canVote || vote.isPending)}</div>{data.viewer.voted && data.status !== "settled" && <p className="mt-2 text-center text-[10px] text-[#00B77D]">本轮已提交，身份与选择在终局前隐藏</p>}{data.status === "disputed" && <p className="mt-2 text-center text-[10px] text-[#EF5459]">全员投完但无过半，等待管理员退款或重开投票</p>}</div>
    </section>

    {(data.status === "settled" || data.status === "refunded") && <section className="mt-5 rounded-2xl border border-[#FFB700]/40 bg-gradient-to-r from-[#162638] to-[#101d2b] p-6"><h2 className="text-xl font-black text-[#FFB700]">{data.status === "settled" ? `${data.winnerTeam} 队胜出` : "房间已全额退款"}</h2><p className="mt-2 text-xs text-muted-foreground">败方池税 {money(data.losingPoolTaxUnits / 1_000_000)} · 选手分成 {money(data.playerTaxUnits / 1_000_000)} · 平台 {money(data.platformTaxUnits / 1_000_000)}</p><div className="mt-4 space-y-2">{data.viewer.bets.map((item) => <div key={item.id} className="flex justify-between rounded-lg bg-black/10 px-3 py-2 text-xs"><span>押 {item.team} · {money(item.amount)}</span><span className={item.payout > 0 ? "text-[#00B77D]" : "text-[#EF5459]"}>返还 {money(item.payout)}</span></div>)}</div></section>}
    <section className="mt-5 rounded-xl border border-border bg-[#101d2b] p-5"><h2 className="flex items-center gap-2 text-sm font-bold text-[#fce1b6]"><ShieldCheck className="h-4 w-4 text-[#00B77D]" />公开规则</h2><p className="mt-2 text-xs leading-5 text-muted-foreground">{data.rules.winnerPayout}。{data.rules.taxSplit}。{data.rules.integerRemainder}。</p></section>
  </main></div>;
}
