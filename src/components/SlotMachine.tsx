import { useEffect, useRef, useState } from "react";
import { SLOT_SYMBOLS, type SlotSymbol, type SlotSymbols } from "@contracts/slot-machine";

const CELL = 112;
const symbolMap = new Map(SLOT_SYMBOLS.map((symbol) => [symbol.id, symbol]));
const rand = (): SlotSymbol => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)].id;

function Reel({ finalSymbol, duration }: { finalSymbol: SlotSymbol; duration: number }) {
  const [seq] = useState<SlotSymbol[]>(() => [rand(), ...Array.from({ length: 16 }, rand), finalSymbol, rand()]);
  const [offset, setOffset] = useState(0);
  const [instant, setInstant] = useState(true);

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setInstant(false);
        setOffset(-(seq.length - 2) * CELL);
      }),
    );
    return () => cancelAnimationFrame(raf);
  }, [seq.length]);

  return (
    <div className="rounded-xl bg-gradient-to-b from-[#af915f]/70 via-[#af915f]/20 to-[#af915f]/70 p-px">
      <div className="reel-mask relative h-[112px] w-[88px] overflow-hidden rounded-[11px] bg-[#101d2b] sm:w-[104px]">
        <div
          className="reel-track absolute left-0 top-0 w-full"
          style={{
            transform: `translateY(${offset}px)`,
            transitionDuration: instant ? "0ms" : `${duration}ms`,
          }}
        >
          {seq.map((symbolId, i) => {
            const symbol = symbolMap.get(symbolId)!;
            return <div key={i} className="flex items-center justify-center" style={{ height: CELL }}>
              <span
                className="font-num text-6xl font-bold"
                style={{ color: symbol.color, textShadow: `0 0 24px ${symbol.color}55` }}
              >
                {symbol.glyph}
              </span>
            </div>;
          })}
        </div>
        {/* 中线指示 */}
        <div className="pointer-events-none absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-[#af915f]/30" />
      </div>
    </div>
  );
}

export type SlotResult =
  | { kind: "idle" }
  | { kind: "spinning" }
  | { kind: "won"; amount: number; symbols?: SlotSymbols }
  | { kind: "blocked"; message: string; symbols?: SlotSymbols }
  | { kind: "already"; amount: number; symbols?: SlotSymbols }
  | {
    kind: "slot";
    symbols: SlotSymbols;
    bet: number;
    payoutMultiplier: number;
    grossPayout: number;
    netChange: number;
    win: boolean;
    message: string;
  };

export function SlotMachine({
  result,
  onSettled,
}: {
  result: SlotResult;
  onSettled?: () => void;
}) {
  const fallback: SlotSymbols = result.kind === "won" || result.kind === "already"
    ? ["seven", "seven", "seven"]
    : ["cherry", "lemon", "bell"];
  const finalSyms = "symbols" in result && result.symbols ? result.symbols : fallback;
  const doneRef = useRef(false);
  const onSettledRef = useRef(onSettled);

  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  useEffect(() => {
    if (result.kind === "spinning") {
      doneRef.current = false;
      return;
    }
    if (result.kind === "won" || result.kind === "blocked" || result.kind === "already" || result.kind === "slot") {
      // 等最长滚筒停稳后回调
      const t = setTimeout(() => {
        if (!doneRef.current) {
          doneRef.current = true;
          onSettledRef.current?.();
        }
      }, 2100);
      return () => clearTimeout(t);
    }
  }, [result]);

  const durations = [1000, 1500, 2000];
  return (
    <div className="flex items-center justify-center gap-3">
      {durations.map((d, i) => (
        <Reel key={`${i}-${result.kind}-${finalSyms.join("-")}`} finalSymbol={finalSyms[i]} duration={d} />
      ))}
    </div>
  );
}
