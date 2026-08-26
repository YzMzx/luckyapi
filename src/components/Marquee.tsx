import { trpc } from "@/providers/trpc";

export function Marquee() {
  const { data: cfg } = trpc.auth.publicConfig.useQuery();
  const range = `$${cfg?.drawMin ?? 5} - $${cfg?.drawMax ?? 10}`;
  const ITEMS = [
    { text: "LUCKY DRAW", color: "#FFB700" },
    { text: "抽奖赢额度", color: "#fce1b6" },
    { text: range, color: "#00B77D" },
    { text: "API 分发", color: "#176EFF" },
    { text: "每日签到", color: "#EF5459" },
    { text: "JACKPOT", color: "#EF54EA" },
    { text: "邀请码准入", color: "#FF6B35" },
    { text: "LINUX DO CONNECT", color: "#af915f" },
  ];
  const row = [...ITEMS, ...ITEMS];
  return (
    <div className="overflow-hidden border-b border-border bg-[#101d2b] py-2 select-none">
      <div className="animate-marquee flex w-max items-center gap-8 whitespace-nowrap">
        {row.map((item, i) => (
          <span key={i} className="flex items-center gap-8 text-xs font-bold tracking-[0.1em]">
            <span style={{ color: item.color }}>{item.text}</span>
            <span className="text-[#af915f]">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}
