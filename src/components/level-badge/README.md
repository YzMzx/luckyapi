# 自然意境等级徽章 v2

本模块使用 nature-level-badge-kit-v2 的 React 组件、SVG 图标、主题配置及样式。运行开发服务器后打开 `/badges` 查看六个阶段的全部 24 款徽章。

```tsx
import { LevelBadge } from "@/components/level-badge";

<LevelBadge level={45} rank={1} size="sm" />
```

`animated={false}` 可暂停动效。样式覆盖使用 v2 的 `--lb-*` 变量，如 `--lb-radius`。主题通过 `registerBadgeTheme` 注册，每阶配置包含起止等级、常规款和三款限定。服务端可以从 `./resolver` 直接导入解析函数。
