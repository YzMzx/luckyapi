import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const PAGE_SIZES = [10, 20, 50] as const;

/** 页码窗口：首页/末页 + 当前页前后各 1 页，中间省略 */
function pageWindow(page: number, totalPages: number): Array<number | "…"> {
  const set = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const pages = [...set].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let prev = 0;
  for (const p of pages) {
    if (prev && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

export function Pager({ page, totalPages, total, pageSize, onPage, onPageSize, unit = "条", className }: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize?: (pageSize: number) => void;
  unit?: string;
  className?: string;
}) {
  if (total === 0) return null;
  const btn = "flex h-8 min-w-8 items-center justify-center rounded border border-border px-2 text-xs font-bold text-muted-foreground transition-colors hover:border-[#FFB700] hover:text-[#FFB700] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground";
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <p className="font-num text-xs text-muted-foreground">共 {total} {unit} · 第 {page}/{totalPages} 页</p>
      <div className="flex items-center gap-1.5">
        {onPageSize && (
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="h-8 rounded border border-border bg-[#162638] px-2 text-xs text-muted-foreground"
            aria-label="每页条数"
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} 条/页</option>)}
          </select>
        )}
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="上一页">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pageWindow(page, totalPages).map((p, i) =>
          p === "…"
            ? <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground">…</span>
            : (
              <button
                key={p}
                type="button"
                onClick={() => onPage(p)}
                className={cn(btn, p === page && "border-[#FFB700] bg-[#FFB700]/10 text-[#FFB700]")}
              >
                {p}
              </button>
            ),
        )}
        <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="下一页">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
