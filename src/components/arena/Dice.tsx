import { cn } from "@/lib/utils";

const PIPS: Record<number, [number, number][]> = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [1, 3], [3, 1], [3, 3]],
  5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
  6: [[1, 1], [2, 1], [3, 1], [1, 3], [2, 3], [3, 3]],
};

/** 单枚骰子：CSS 点阵绘制，无外部素材 */
export function DiceFace({ value, size = "md", dim }: { value: number; size?: "sm" | "md" | "lg"; dim?: boolean }) {
  const box = size === "lg" ? "h-16 w-16 rounded-xl" : size === "sm" ? "h-8 w-8 rounded-md" : "h-12 w-12 rounded-lg";
  const pip = size === "lg" ? "h-2.5 w-2.5" : size === "sm" ? "h-1 w-1" : "h-1.5 w-1.5";
  return (
    <div
      className={cn(
        "grid grid-cols-3 grid-rows-3 place-items-center border border-[#af915f]/60 bg-gradient-to-b from-[#162638] to-[#101d2b] p-1.5",
        box,
        dim && "opacity-40",
      )}
      aria-label={`骰子 ${value} 点`}
    >
      {Array.from({ length: 9 }, (_, i) => {
        const r = Math.floor(i / 3) + 1;
        const c = (i % 3) + 1;
        const on = PIPS[value]?.some(([pr, pc]) => pr === r && pc === c);
        return (
          <span
            key={i}
            className={cn("rounded-full", pip, on ? "bg-[#FFB700] shadow-[0_0_6px_#FFB70088]" : "bg-transparent")}
          />
        );
      })}
    </div>
  );
}

/** 三骰组合；rolling 时播放翻滚动画（数值无意义，结果以服务端下发为准） */
export function DiceTrio({
  dice,
  rolling,
  size = "md",
  dim,
}: {
  dice: [number, number, number] | null;
  rolling?: boolean;
  size?: "sm" | "md" | "lg";
  dim?: boolean;
}) {
  const shown = dice ?? ([1, 2, 3] as [number, number, number]);
  return (
    <div className="flex items-center gap-1.5">
      {shown.map((v, i) => (
        <div key={i} className={cn(rolling && "animate-bounce")} style={rolling ? { animationDelay: `${i * 120}ms` } : undefined}>
          <DiceFace value={v} size={size} dim={dim || !dice} />
        </div>
      ))}
    </div>
  );
}
