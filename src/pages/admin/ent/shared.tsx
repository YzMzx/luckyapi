import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Field = ({ label, value, onChange, min, max, step = 1, hint }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; hint?: string;
}) => <div className="space-y-2"><Label>{label}</Label><Input type="number" value={value} min={min} max={max} step={step}
  onChange={(event) => onChange(Number(event.target.value))} className="border-border bg-[hsl(var(--admin-control))]" />
  {hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;

export function ConfigLoading() {
  return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">加载娱乐配置中…</div>;
}

export function ConfigError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-[#EF5459]/50 bg-card p-6 text-center">
      <p className="text-sm font-bold text-[#EF5459]">娱乐配置加载失败：{message}</p>
      <button onClick={onRetry} className="mt-3 text-xs font-bold text-accent hover:underline">重试</button>
    </div>
  );
}
