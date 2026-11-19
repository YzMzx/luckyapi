# 等级徽章

开发服务器的 `/badges` 提供全部 24 款自然主题徽章和交互预览。组件使用示例：

```tsx
import { LevelBadge } from "@/components/level-badge";

<LevelBadge level={45} rank={1} size="sm" />; // Lv.45 东临沧海 No.01
```

服务端和报表可直接从 `./resolver` 导入 `resolveStageByLevel` 与 `resolveBadgeSpec`，此入口不会加载 React、DOM 或 CSS。未知主题使用自然主题，非法排位使用该阶段的常规称号。阶段起点由 `minLevel` 指定，省略时按序使用 1、11、21……。等级上界由下一阶段的起点决定，最后一阶无上限。

## 注册主题

以下示例复用自然主题的两套材质，将新主题的分界线改为 Lv.5。注册应在应用初始化时完成；相同 id 会替换已有配置。

```tsx
import {
  natureTheme,
  registerBadgeTheme,
} from "@/components/level-badge/themes";

const [first, second] = natureTheme.stages;
registerBadgeTheme({
  id: "garden",
  name: "庭园",
  description: "从萌芽走向繁花",
  stages: [
    { ...first, name: "萌芽", base: { ...first.base, title: "萌芽" } },
    {
      ...second,
      name: "繁花",
      minLevel: 5,
      base: { ...second.base, title: "繁花" },
    },
  ],
});
// <LevelBadge theme="garden" level={5} />
```

每个阶段可以声明自己的 SVG 路径、基础材质与三个限定称号。各款可独立指定明暗渐变、描边、字色、纹理与动画周期。外部容器或组件的 `style` 可覆写 `--badge-bg`、`--badge-border`、`--badge-text`、`--badge-radius`、`--badge-glow` 和 `--badge-sweep-duration`。半透明深色材质需要放在深色画布上。

会员殿堂与管理席位继续读取现有首达记录。Lv.10、20、30、40、50 为服务端授予里程碑；显示等级的六个主题区间与授予条件独立。
