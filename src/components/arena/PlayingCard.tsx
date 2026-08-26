import type { DuelCard } from "@contracts/duel";
import { cn } from "@/lib/utils";

const SUIT: Record<string, { glyph: string; red: boolean }> = {
  S: { glyph: "♠", red: false },
  H: { glyph: "♥", red: true },
  D: { glyph: "♦", red: true },
  C: { glyph: "♣", red: false },
};

/** 扑克牌：CSS 绘制，无外部素材；card 为 null 时显示背面 */
export function PlayingCard({ card, size = "md" }: { card: DuelCard | null; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-12 w-9 rounded-md text-xs" : "h-16 w-12 rounded-lg text-sm";
  if (card === null) {
    return (
      <div
        aria-label="暗牌"
        className={cn(
          "flex items-center justify-center border border-[#af915f]/50 bg-[#162638]",
          "bg-[repeating-linear-gradient(45deg,#1d3145_0_4px,#162638_4px_8px)]",
          box,
        )}
      />
    );
  }
  const rank = card.slice(0, -1);
  const suit = SUIT[card.slice(-1)] ?? SUIT.S;
  return (
    <div
      aria-label={`${suit.glyph}${rank}`}
      className={cn(
        "flex flex-col items-center justify-center border border-[#af915f]/60 bg-gradient-to-b from-[#f7ead2] to-[#e8d5ae] font-black leading-none",
        box,
        suit.red ? "text-[#c0392b]" : "text-[#162638]",
      )}
    >
      <span>{rank}</span>
      <span className={size === "sm" ? "text-sm" : "text-lg"}>{suit.glyph}</span>
    </div>
  );
}
