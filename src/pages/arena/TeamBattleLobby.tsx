import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Swords, Users, LockKeyhole, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { SiteNav } from "@/components/SiteNav";
import { Pager } from "@/components/Pager";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";

const MODES = ["1v1", "3v3", "5v5"] as const;
const STATUS: Record<string, string> = { lobby: "组队中", betting: "投注中", voting: "投票中", settled: "已结算", disputed: "争议待审", refunded: "已退款", cancelled: "已取消" };

export default function TeamBattleLobby() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const config = trpc.teamBattle.config.useQuery(undefined, { enabled: !!user });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const rooms = trpc.teamBattle.listRoomsPage.useQuery({ page, pageSize }, { enabled: !!user, refetchInterval: 5_000 });
  const [mode, setMode] = useState<(typeof MODES)[number] | null>(null);
  const [visibility, setVisibility] = useState<"public" | "private" | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const ids = useRef<Record<string, string>>({});
  const rid = (key: string) => (ids.current[key] ??= crypto.randomUUID());
  const done = (key: string) => { delete ids.current[key]; };
  const create = trpc.teamBattle.create.useMutation({
    onSuccess: (room) => { done("create"); utils.teamBattle.listRoomsPage.invalidate(); navigate(`/arena/team/${room.id}`); },
    onError: (error) => toast.error(error.message),
  });
  const join = trpc.teamBattle.join.useMutation({
    onSuccess: (room) => { done("join"); utils.teamBattle.listRoomsPage.invalidate(); navigate(`/arena/team/${room.id}?code=${room.code}`); },
    onError: (error) => toast.error(error.message),
  });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  const c = config.data;
  return <div className="min-h-screen"><SiteNav user={user} /><main className="mx-auto max-w-5xl px-4 py-12">
    <div className="text-center"><p className="text-xs font-bold tracking-[0.5em] text-[#af915f]">TEAM BATTLE</p><h1 className="mt-2 text-4xl font-black"><span className="text-outline">战队对抗</span></h1><p className="mt-3 text-xs leading-5 text-muted-foreground">固定 A/B 队席 · 实时奖池赔率 · 选手多数投票结算 · 全程额度守恒</p><Link to="/arena" className="mt-3 inline-block text-xs font-bold text-[#FFB700] hover:underline">← 返回幸运决斗场</Link></div>

    <section className="mt-8 grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-border bg-[#101d2b] p-6">
        <h2 className="flex items-center gap-2 font-bold text-[#fce1b6]"><Swords className="h-4 w-4 text-[#FFB700]" /> 创建战队房</h2>
        <p className="mt-4 text-xs text-muted-foreground">① 选择对抗规模 <span className="ml-1 text-[10px] text-[#FFB700]">{mode ?? "尚未选择"}</span></p><div className="mt-2 grid grid-cols-3 gap-2">{MODES.map((value) => <button key={value} onClick={() => setMode(value)} className={cn("rounded-lg border py-2 font-num text-sm font-bold", mode === value ? "border-[#FFB700] bg-[#FFB700]/10 text-[#FFB700]" : "border-border text-muted-foreground")}>{value}</button>)}</div>
        <p className="mt-4 rounded-lg border border-[#af915f]/30 bg-[#af915f]/5 p-3 text-xs leading-5 text-muted-foreground">创建者只保留房主身份，默认从观众席进入；进入房间后再点击具体空席位上场。</p>
        <p className="mt-4 text-xs text-muted-foreground">② 选择房间类型 <span className="ml-1 text-[10px] text-[#7db4ff]">{visibility === "public" ? "公开房" : visibility === "private" ? "私密房" : "尚未选择"}</span></p>
        <div className="mt-2 grid grid-cols-2 gap-2">{(["public", "private"] as const).map((value) => <button key={value} onClick={() => setVisibility(value)} className={cn("rounded-lg border py-2 text-xs font-bold", visibility === value ? "border-[#176EFF] bg-[#176EFF]/10 text-[#7db4ff]" : "border-border text-muted-foreground")}>{value === "public" ? "公开房" : "私密房"}</button>)}</div>
        <button disabled={!c?.enabled || !mode || !visibility || create.isPending} onClick={() => c && mode && visibility && create.mutate({ requestId: rid("create"), mode, visibility, expectedConfigVersion: c.version })} className="btn-3d mt-5 w-full rounded-lg bg-[#FFB700] py-3 font-black text-[#162638] disabled:opacity-40">{create.isPending ? "创建中…" : !c?.enabled ? "当前未开放" : !mode || !visibility ? "请先完成两项选择" : "创建并进入观众席"}</button>
      </div>
      <div className="rounded-2xl border border-border bg-[#101d2b] p-6">
        <h2 className="flex items-center gap-2 font-bold text-[#fce1b6]"><LockKeyhole className="h-4 w-4 text-[#FFB700]" /> 房间码入队</h2>
        <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6))} placeholder="6 位房间码" className="font-num mt-5 w-full rounded-lg border border-border bg-[#162638] px-4 py-3 text-center text-lg tracking-[0.4em] text-[#FFB700] outline-none focus:border-[#af915f]" />
        <p className="mt-3 text-xs leading-5 text-muted-foreground">按房间码进入时默认仅观看，不自动占用 A/B 队席位。</p>
        <button disabled={joinCode.length !== 6 || join.isPending} onClick={() => join.mutate({ requestId: rid("join"), code: joinCode })} className="btn-3d mt-5 w-full rounded-lg bg-[#FFB700] py-3 font-black text-[#162638] disabled:opacity-40">{join.isPending ? "进入中…" : "按房间码进入观看"}</button>
        <div className="mt-5 rounded-lg border border-[#af915f]/30 bg-[#af915f]/5 p-3 text-[11px] leading-5 text-muted-foreground"><p className="font-bold text-[#fce1b6]">公开结算口径</p><p>胜方本金全返，并按胜方投注占比分败方池税后 90%；败方池 10% 税的一半平分给全部选手，另一半进入平台。</p></div>
      </div>
    </section>

    <section className="mt-6 rounded-2xl border border-border bg-[#101d2b] p-6"><div className="flex items-center justify-between"><h2 className="t-section">公开战队房</h2><button onClick={() => rooms.refetch()} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-[#FFB700]"><RefreshCw className={cn("h-3.5 w-3.5", rooms.isFetching && "animate-spin")} />刷新</button></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{rooms.data?.items.map((room) => <Link key={room.id} to={`/arena/team/${room.id}`} className="rounded-xl border border-border bg-[#162638]/50 p-4 transition-colors hover:border-[#FFB700]/50"><div className="flex items-center justify-between"><span className="font-num font-bold text-[#FFB700]">{room.code ?? "私密房"}</span><span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">{STATUS[room.status]}</span></div><p className="mt-2 flex items-center gap-2 text-sm font-bold text-[#fce1b6]"><Users className="h-4 w-4" />{room.mode} · A ${room.poolA.toFixed(2)} / B ${room.poolB.toFixed(2)}</p><p className="mt-1 text-[10px] text-muted-foreground">{room.odds.ready ? `实时倍率 A ${room.odds.A?.decimal.toFixed(3)}× · B ${room.odds.B?.decimal.toFixed(3)}×` : "等待两侧奖池形成赔率"}</p></Link>)}</div>
      {!rooms.isLoading && !rooms.data?.items.length && <p className="py-10 text-center text-xs text-muted-foreground">暂无可见房间</p>}
      {rooms.data && <Pager className="mt-4" page={rooms.data.page} totalPages={rooms.data.totalPages} total={rooms.data.total} pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} unit="个房间" />}
    </section>
  </main></div>;
}
