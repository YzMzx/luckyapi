import { ShieldCheck } from "lucide-react";
import type { DuelRoomData } from "@/lib/arena/types";
import { fmtMoney } from "@/lib/arena/hooks";

/** 可验证公平面板：开局前公开承诺哈希，终态后揭示种子供校验 */
export function FairnessPanel({ room }: { room: DuelRoomData }) {
  const fairness = room.fairness;
  if (!fairness?.commitment) return null;
  return (
    <div className="rounded-xl border border-border bg-[#101d2b] p-4 text-xs">
      <p className="flex items-center gap-1.5 font-bold text-[#af915f]">
        <ShieldCheck className="h-3.5 w-3.5" />
        可验证公平
      </p>
      <div className="mt-2 space-y-1.5 text-muted-foreground">
        <p className="break-all">
          承诺哈希：<span className="font-num text-[#fce1b6]">{fairness.commitment}</span>
        </p>
        {fairness.reveal ? (
          <p className="break-all">
            已揭示种子：<span className="font-num text-[#00B77D]">{fairness.reveal}</span>
          </p>
        ) : (
          <p>结算后揭示原始种子，可自行校验哈希是否一致（{fairness.algorithm}）。</p>
        )}
        {fairness.blackjackRule && (
          <p className="leading-4">
            牌型规则 <span className="font-num text-[#af915f]">{fairness.blackjackRule.version}</span>：
            {fairness.blackjackRule.description}
          </p>
        )}
      </div>
    </div>
  );
}

/** 房间状态横幅 */
export function RoomStatusBanner({ room }: { room: DuelRoomData }) {
  const state = room.state as { kind?: string; rounds?: unknown[]; contenderSeats?: number[] } | null;
  const rounds = state?.rounds?.length ?? 0;
  const tie = room.game === "dice" && room.status === "active" && rounds > 0 && (state?.contenderSeats?.length ?? 0) > 1;

  let item: { text: string; cls: string } | null = null;
  if (room.status === "active" && room.game === "dice") {
    item = tie
      ? { text: `第 ${rounds} 轮并列最高 · 等待加赛开奖`, cls: "border-[#EF54EA]/40 bg-[#EF54EA]/10 text-[#EF54EA]" }
      : rounds > 0
        ? { text: `第 ${rounds} 轮已开奖`, cls: "border-[#FFB700]/40 bg-[#FFB700]/10 text-[#FFB700]" }
        : { text: "已开局 · 等待开奖", cls: "border-[#176EFF]/40 bg-[#176EFF]/10 text-[#7db4ff]" };
  } else if (room.status === "active") {
    item = { text: "对局进行中", cls: "border-[#176EFF]/40 bg-[#176EFF]/10 text-[#7db4ff]" };
  } else if (room.status === "settled") {
    item = { text: rounds > 1 ? `已结算（含 ${rounds - 1} 次加赛）` : "已结算", cls: "border-[#00B77D]/40 bg-[#00B77D]/10 text-[#00B77D]" };
  } else if (room.status === "cancelled") {
    item = { text: "房间已过期/解散，冻结额度已退回", cls: "border-border bg-white/5 text-muted-foreground" };
  } else if (room.status === "refunded") {
    item = { text: "全员爆牌 · 已原额退款", cls: "border-border bg-white/5 text-muted-foreground" };
  }
  if (!item) return null;
  return <p className={`rounded-lg border px-3 py-1.5 text-center text-xs font-bold ${item.cls}`}>{item.text}</p>;
}

/**
 * 奖池税负拆解：毛奖池 / 赢家税率 / 预计税额 / 税后奖池。
 * 终态后传 fee/pot 实际值；否则按当前人数估算。
 */
export function PotBreakdown({
  bet,
  playerCount,
  feePercent,
  pot,
  fee,
  compact,
}: {
  bet: number;
  playerCount: number;
  feePercent: number;
  pot?: number;
  fee?: number;
  compact?: boolean;
}) {
  const gross = pot ?? bet * playerCount;
  const tax = fee ?? gross * (feePercent / 100);
  const net = Math.max(0, gross - tax);
  const cells: [string, string, string?][] = [
    ["毛奖池", fmtMoney(gross)],
    ["赢家税率", `${feePercent}%`],
    [pot != null ? "赢家税" : "预计税额", fmtMoney(tax), "text-[#EF5459]"],
    ["税后奖池", fmtMoney(net), "text-[#00B77D]"],
  ];
  return (
    <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border ${compact ? "" : "sm:grid-cols-4"}`}>
      {cells.map(([label, v, cls]) => (
        <div key={label} className="bg-[#101d2b] p-3 text-center">
          <p className="text-[10px] text-muted-foreground">{label}</p>
          <p className={`font-num mt-1 text-sm font-bold ${cls ?? "text-[#fce1b6]"}`}>{v}</p>
        </div>
      ))}
    </div>
  );
}
