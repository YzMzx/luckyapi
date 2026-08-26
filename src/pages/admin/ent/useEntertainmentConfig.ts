import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";

export type Draft = {
  businessTimezoneOffsetMinutes: number;
  businessDayStartHour: number;
  drawEnabled: boolean;
  drawWinRatePercent: number;
  drawMinReward: number;
  drawMaxReward: number;
  drawTotalLimit: number;
  drawBudgetRemaining: number;
  slotEnabled: boolean;
  slotDailyLimit: number;
  signinEnabled: boolean;
  signinMinReward: number;
  signinMaxReward: number;
  signinMode: "range" | "fixed" | "tiers";
  signinFixedReward: number;
  signinTiers: Array<{ reward: number; probabilityPpm: number }>;
  signinBudgetRemaining: number;
};

/** 娱乐配置公共状态：整体读取、局部修改、整份保存 */
export function useEntertainmentConfig() {
  const utils = trpc.useUtils();
  const control = trpc.admin.getEntertainmentControl.useQuery();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tierTextDraft, setTierTextDraft] = useState<string | null>(null);
  const form = draft ?? control.data?.config ?? null;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (!form) return;
    setDraft({ ...form, [key]: value });
  };
  const save = trpc.admin.updateEntertainmentConfig.useMutation({
    onSuccess: () => {
      toast.success("娱乐配置已保存");
      setDraft(null);
      setTierTextDraft(null);
      utils.admin.getEntertainmentControl.invalidate();
      utils.entertainment.invalidate();
      utils.member.checkinStatus.invalidate();
      utils.member.reportQuota.invalidate();
      utils.draw.status.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  return { control, form, set, save, tierTextDraft, setTierTextDraft };
}
