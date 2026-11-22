import type { ComponentType } from "react";
import { Medal, Layers3, type LucideIcon } from "lucide-react";
import { LevelExhibit } from "./LevelExhibit";

type HallCategory = {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
} & ({ status: "available"; Exhibit: ComponentType } | { status: "planned" });

// Each exhibit owns its data source and award rules. Use a stable id for deep links.
export const hallCategories: readonly HallCategory[] = [
  {
    id: "level",
    title: "等级铭牌",
    icon: Medal,
    description: "每个等级里程碑的前三位达成者获得限定席位。",
    status: "available",
    Exhibit: LevelExhibit,
  },
  {
    id: "upcoming",
    title: "更多铭牌类型",
    icon: Layers3,
    description: "新类型开放后，可在这里查看铭牌和获取方式。",
    status: "planned",
  },
];
