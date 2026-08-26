import { LayoutDashboard, KeyRound, ArrowDownUp, Waves, Dices, Trophy, Boxes, Swords, Landmark } from "lucide-react";
import { SideNavLayout, type SideNavSection } from "./SideNavLayout";
import { SiteNav } from "./SiteNav";

const CONSOLE_SECTIONS: SideNavSection[] = [
  {
    title: "控制台",
    items: [
      { to: "/console", label: "概览", icon: <LayoutDashboard className="h-3.5 w-3.5" />, end: true },
      { to: "/console/keys", label: "API 密钥", icon: <KeyRound className="h-3.5 w-3.5" /> },
    ],
  },
  {
    title: "用量与账单",
    items: [
      { to: "/console/usage", label: "消耗记录", icon: <Waves className="h-3.5 w-3.5" /> },
      { to: "/console/billing", label: "额度流水", icon: <ArrowDownUp className="h-3.5 w-3.5" /> },
      { to: "/console/finance", label: "资金与借贷", icon: <Landmark className="h-3.5 w-3.5" /> },
    ],
  },
  {
    title: "快捷入口",
    items: [
      { to: "/arena", label: "幸运决斗场", icon: <Swords className="h-3.5 w-3.5" /> },
      { to: "/models", label: "模型广场", icon: <Boxes className="h-3.5 w-3.5" /> },
      { to: "/draw", label: "幸运抽奖", icon: <Dices className="h-3.5 w-3.5" /> },
      { to: "/leaderboard", label: "榜单中心", icon: <Trophy className="h-3.5 w-3.5" /> },
    ],
  },
];

/** 控制台布局：桌面端左侧分组栏，移动端顶部汉堡抽屉（基于 SideNavLayout） */
export function ConsoleLayout({
  user,
  title,
  desc,
  children,
}: {
  user: { groupName: string | null; balance: number; avatarUrl: string };
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <SideNavLayout
      brand="控制台"
      sections={CONSOLE_SECTIONS}
      title={title}
      desc={desc}
      header={<SiteNav user={user} />}
    >
      {children}
    </SideNavLayout>
  );
}
