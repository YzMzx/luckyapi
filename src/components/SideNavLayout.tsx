import { useState } from "react";
import { NavLink } from "react-router";
import { ChevronDown, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type SideNavItem = {
  to: string;
  label: string;
  icon?: React.ReactNode;
  /** NavLink end 匹配（仅精确路径高亮） */
  end?: boolean;
};

export type SideNavSection = {
  /** 分组名；不传则不分组 */
  title?: string;
  items: SideNavItem[];
};

function NavItems({
  sections,
  onNavigate,
  compact = false,
}: {
  sections: SideNavSection[];
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("lucky-nav-sections") || "{}"); } catch { return {}; }
  });
  const toggle = (key: string) => setCollapsed((current) => {
    const next = { ...current, [key]: !current[key] };
    localStorage.setItem("lucky-nav-sections", JSON.stringify(next));
    return next;
  });
  return (
    <nav className="flex flex-col gap-4">
      {sections.map((sec, i) => {
        const key = sec.title ?? `__plain_${i}`;
        const isCollapsed = !!collapsed[key];
        return (
          <div key={key}>
            {sec.title && !compact && (
              <button
                type="button"
                onClick={() => toggle(key)}
                className="mb-1.5 flex w-full items-center justify-between px-3 text-[10px] font-bold tracking-[0.1em] text-muted-foreground/70 transition-colors hover:text-primary"
              >
                {sec.title}
                <ChevronDown
                  className={cn("h-3 w-3 transition-transform", isCollapsed && "-rotate-90")}
                />
              </button>
            )}
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5">
                {sec.items.map((l) => (
                  <NavLink
                    key={l.to}
                    to={l.to}
                    end={l.end}
                    title={compact ? l.label : undefined}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors",
                        isActive
                          ? "bg-accent/15 font-bold text-accent"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )
                    }
                  >
                    {l.icon && <span className="flex w-4 items-center justify-center">{l.icon}</span>}
                    {!compact && l.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * 通用「左侧栏 + 内容区」布局：桌面端分组侧栏（可折叠分组），移动端顶部汉堡抽屉。
 * 控制台与管理员后台共用，保证统一的设计语言。
 */
export function SideNavLayout({
  brand,
  sections,
  title,
  desc,
  header,
  maxWidth = "max-w-7xl",
  fullWidth = false,
  stickyTop = 105,
  children,
}: {
  /** 侧栏顶部品牌/标题（移动端抽屉标题同样使用） */
  brand: React.ReactNode;
  sections: SideNavSection[];
  title: string;
  desc?: string;
  /** 页面顶部导航（SiteNav 或后台顶栏） */
  header: React.ReactNode;
  maxWidth?: string;
  /** 管理后台使用全宽应用壳；普通用户控制台继续使用居中内容容器。 */
  fullWidth?: boolean;
  /** 侧栏 sticky 顶端偏移（px），默认匹配 SiteNav（Marquee + 顶栏）高度 */
  stickyTop?: number;
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem("lucky-sidebar-collapsed") === "1");
  const toggleSidebar = () => setSideCollapsed((value) => {
    localStorage.setItem("lucky-sidebar-collapsed", value ? "0" : "1");
    return !value;
  });

  return (
    <div className="min-h-screen">
      {header}
      {/* 移动端：汉堡按钮条 */}
      <div className="sticky z-30 flex items-center justify-between border-b border-border bg-card/95 px-3 backdrop-blur lg:hidden" style={{ top: stickyTop }}>
        <button
          onClick={() => setMenuOpen(true)}
          className="flex items-center gap-2 rounded-lg px-2 py-3 text-sm font-bold text-foreground"
        >
          <Menu className="h-4 w-4" />
          导航
        </button>
        <div className="min-w-0 text-right"><p className="truncate text-sm font-black text-foreground">{title}</p>{desc && <p className="hidden truncate text-[10px] text-muted-foreground min-[430px]:block">{desc}</p>}</div>
      </div>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-[min(88vw,20rem)] overflow-y-auto border-border bg-card px-4 pt-10">
          <SheetHeader>
            <SheetTitle className="text-left text-accent">{brand}</SheetTitle>
          </SheetHeader>
          <NavItems sections={sections} onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className={cn("flex", fullWidth ? "w-full max-w-none" : cn("mx-auto", maxWidth))}>
        {/* 桌面端：左侧栏 */}
        <aside
          className={cn(
            "sticky hidden shrink-0 self-start overflow-y-auto px-3 py-6 transition-[width] lg:block",
            fullWidth && "border-r border-border bg-card/35",
            sideCollapsed ? "w-20" : "w-64",
          )}
          style={{ top: stickyTop, height: `calc(100vh - ${stickyTop}px)` }}
        >
          <div className="mb-5 flex items-center justify-between gap-2 px-2 text-sm font-black tracking-wide text-accent">{!sideCollapsed && brand}<button type="button" onClick={toggleSidebar} title={sideCollapsed ? "展开侧栏" : "收起侧栏"} className="ml-auto rounded-lg border border-border p-2 text-muted-foreground hover:text-accent">{sideCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}</button></div>
          <NavItems sections={sections} compact={sideCollapsed} />
        </aside>
        <main className={cn("min-w-0 flex-1 px-4 py-6 sm:px-6 lg:py-8 xl:px-8 2xl:px-10", fullWidth && "overflow-x-hidden")}>
          <div className="rise-in">
            <div className="hidden items-center gap-3 lg:flex"><span className="h-7 w-1 rounded-full bg-primary" /><div><h1 className="text-2xl font-black tracking-tight text-foreground">{title}</h1>{desc && <p className="mt-1 text-xs text-muted-foreground">{desc}</p>}</div></div>
          </div>
          <div className="mt-0 lg:mt-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
