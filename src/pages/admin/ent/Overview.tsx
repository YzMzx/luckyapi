import { Field, ConfigLoading, ConfigError } from "./shared";
import { useEntertainmentConfig } from "./useEntertainmentConfig";

/** 娱乐总览：核心指标与统一业务日设置 */
export default function EntOverview() {
  const { control, form, set, save } = useEntertainmentConfig();

  if (control.error) return <ConfigError message={control.error.message} onRetry={() => control.refetch()} />;
  if (!form || !control.data) return <ConfigLoading />;

  return (
    <div className="w-full max-w-[90rem] space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["一次抽奖参与", control.data.stats.drawCount],
          ["今日老虎机局数", control.data.stats.slotToday],
          ["今日签到人数", control.data.stats.signinToday],
        ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">{label}</p><p className="font-num mt-2 text-3xl font-black text-accent">{value}</p>
        </div>)}
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="t-section">统一业务日</h2>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">当前业务日 {control.data.businessDay.key}，结束于 {new Date(control.data.businessDay.endsAt).toLocaleString("zh-CN")}。老虎机次数在「老虎机」配置。</p>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Field label="时区偏移（分钟）" value={form.businessTimezoneOffsetMinutes} min={-720} max={840} onChange={(v) => set("businessTimezoneOffsetMinutes", v)} />
          <Field label="业务日开始小时" value={form.businessDayStartHour} min={0} max={23} onChange={(v) => set("businessDayStartHour", v)} />
        </div>
      </div>

      <div className="flex justify-end">
        <button disabled={save.isPending} onClick={() => save.mutate(form)} className="btn-3d rounded-lg bg-accent px-8 py-3 font-black text-accent-foreground disabled:opacity-50">
          {save.isPending ? "保存中…" : "保存配置"}
        </button>
      </div>
    </div>
  );
}
