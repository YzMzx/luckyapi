import { Crown, Orbit, Sparkles, Star, Sun } from "lucide-react";

const designs = {
  10: {
    icon: Sparkles,
    style: "border-orange-300/40 from-orange-950 to-stone-900 text-orange-200",
  },
  20: {
    icon: Orbit,
    style: "border-sky-300/40 from-blue-950 to-slate-900 text-sky-200",
  },
  30: {
    icon: Star,
    style:
      "border-emerald-300/40 from-emerald-950 to-stone-900 text-emerald-200",
  },
  40: {
    icon: Crown,
    style: "border-violet-300/40 from-violet-950 to-slate-900 text-violet-200",
  },
  50: {
    icon: Sun,
    style: "border-amber-300/60 from-stone-900 to-yellow-950 text-amber-200",
  },
};

export function StagePlate({
  level,
  name,
  rank,
}: {
  level: number;
  name: string;
  rank?: number;
}) {
  const { icon: Icon, style } =
    designs[level as keyof typeof designs] ?? designs[10];
  return (
    <span
      className={`inline-flex items-center gap-3 rounded-lg border bg-gradient-to-r px-4 py-2 ${style}`}
    >
      <Icon aria-hidden="true" size={24} strokeWidth={1.5} />
      <span className="font-bold tracking-widest">{name}</span>
      {rank != null && (
        <span className="border-l border-current/30 pl-3 font-num text-xs">
          No.{rank}
        </span>
      )}
    </span>
  );
}
