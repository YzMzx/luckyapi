import { trpc } from "@/providers/trpc";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

export default function Overview() {
  const stats = trpc.admin.stats.useQuery(undefined);
  const series = trpc.admin.statsSeries.useQuery(undefined);

  return (
    <div className="space-y-6">
      <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["注册用户", stats.data?.users], ["抽奖总次数", stats.data?.totalDraws],
          ["中奖次数", stats.data?.winDraws], ["剩余邀请码", stats.data?.unusedInvites],
          ["发放额度", `$${Number(stats.data?.totalGiven ?? 0).toFixed(2)}`],
          ["已消耗", `$${Number(stats.data?.totalConsumed ?? 0).toFixed(4)}`],
        ].map(([label, v]) => (
          <div key={label as string} className="bg-card p-6">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="font-num mt-2 text-2xl font-black text-accent">{v ?? "…"}</p>
          </div>
        ))}
      </div>

      {/* 近 14 天趋势 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-bold text-foreground">API 调用趋势（近 14 天）</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series.data ?? []}>
                <defs>
                  <linearGradient id="gCalls" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#FFB700" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#FFB700" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00B77D" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#00B77D" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1e2d3d" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: "#7f8ea0", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis yAxisId="l" tick={{ fill: "#7f8ea0", fontSize: 11 }} axisLine={false} tickLine={false} width={36} />
                <YAxis yAxisId="r" orientation="right" tick={{ fill: "#7f8ea0", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "#162638", border: "1px solid #1e2d3d", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#fce1b6" }}
                  formatter={(v: number, name: string) => (name === "消耗 $" ? [`$${v.toFixed(4)}`, name] : [v, name])}
                />
                <Area yAxisId="l" type="monotone" dataKey="calls" name="调用次数" stroke="#FFB700" strokeWidth={2} fill="url(#gCalls)" />
                <Area yAxisId="r" type="monotone" dataKey="cost" name="消耗 $" stroke="#00B77D" strokeWidth={2} fill="url(#gCost)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-bold text-foreground">新增用户（近 14 天）</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series.data ?? []}>
                <CartesianGrid stroke="#1e2d3d" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tick={{ fill: "#7f8ea0", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: "#7f8ea0", fontSize: 11 }} axisLine={false} tickLine={false} width={28} />
                <Tooltip
                  contentStyle={{ background: "#162638", border: "1px solid #1e2d3d", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#fce1b6" }}
                  cursor={{ fill: "#176EFF", opacity: 0.12 }}
                />
                <Bar dataKey="newUsers" name="新增用户" fill="#176EFF" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
