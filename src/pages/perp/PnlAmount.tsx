import { sim } from "./format";

export function PnlAmount({
  units,
  showUnit = false,
}: {
  units: number | null;
  showUnit?: boolean;
}) {
  if (units === null || !Number.isFinite(units)) {
    return <span className="text-muted-foreground">待估值</span>;
  }
  const tone =
    units > 0
      ? "text-emerald-300"
      : units < 0
        ? "text-rose-300"
        : "text-muted-foreground";
  return (
    <span className={"tabular-nums " + tone}>
      {units > 0 ? "+" : ""}
      {sim(units || 0)}
      {showUnit ? " 模拟金" : ""}
    </span>
  );
}
