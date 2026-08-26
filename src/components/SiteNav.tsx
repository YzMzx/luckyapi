import { Link, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Marquee } from "./Marquee";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const LINKS = [
  { to: "/entertainment", label: "娱乐" },
  { to: "/arena", label: "决斗场" },
  { to: "/leaderboard", label: "榜单" },
  { to: "/report", label: "举报" },
  { to: "/models", label: "模型广场" },
  { to: "/console", label: "控制台" },
];

export function SiteNav({ user }: { user?: { groupName: string | null; balance: number; avatarUrl: string; linuxdoId?: string } | null }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: async () => {
      await utils.invalidate();
      navigate("/");
    },
  });

  return (
    <header className="sticky top-0 z-40">
      <Marquee />
      <div className="border-b border-border bg-[#162638]/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-4">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <span className="font-num whitespace-nowrap text-lg font-bold tracking-tight text-[#FFB700]">LUCKY·DRAW</span>
            <span className="hidden text-xs text-muted-foreground sm:inline"><span className="tracking-[0.2em]">API</span> 分发站</span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-4">
            {/* 桌面端：平铺导航链接 */}
            {user?.groupName &&
              LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className="hidden whitespace-nowrap rounded px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-[#FFB700] md:block"
                >
                  {l.label}
                </Link>
              ))}
            {user ? (
              <>
                <span className="font-num ml-1 whitespace-nowrap rounded border border-[#af915f]/50 bg-[#101d2b] px-2.5 py-1 text-sm font-bold text-[#FFB700]">
                  ${Number(user.balance).toFixed(2)}
                </span>
                {/* 桌面端头像现在可点击，打开账号快捷菜单 */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="打开账号菜单" className="hidden rounded-full outline-none ring-[#FFB700]/40 hover:ring-2 focus:ring-2 md:block">
                      <Avatar className="h-8 w-8 border border-[#af915f]/60">
                        <AvatarImage src={user.avatarUrl} />
                        <AvatarFallback className="bg-[#1d3145] text-xs text-[#fce1b6]">{(user.groupName ?? "U").slice(0, 1)}</AvatarFallback>
                      </Avatar>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56 border-border bg-[#101d2b] text-[#fce1b6]">
                    <div className="px-2 py-2"><p className="truncate text-sm font-bold">{user.groupName ?? "Lucky 玩家"}</p>{user.linuxdoId && <p className="mt-1 font-mono text-xs text-muted-foreground">Linux.do ID：{user.linuxdoId}</p>}</div>
                    <DropdownMenuSeparator className="bg-border" />
                    <DropdownMenuItem asChild><Link to="/console" className="cursor-pointer">进入控制台</Link></DropdownMenuItem>
                    <DropdownMenuItem asChild><Link to="/console/finance" className="cursor-pointer">资金与借贷</Link></DropdownMenuItem>
                    <DropdownMenuItem asChild><Link to="/leaderboard" className="cursor-pointer">榜单中心</Link></DropdownMenuItem>
                    <DropdownMenuItem asChild><Link to="/report" className="cursor-pointer">举报中心</Link></DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-border" />
                    <DropdownMenuItem onClick={() => logout.mutate()} className="cursor-pointer text-[#EF5459] focus:text-[#EF5459]">退出登录</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* 移动端：汉堡菜单 */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label="菜单"
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-[#af915f]/50 text-[#fce1b6] transition-colors hover:border-[#FFB700] md:hidden"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="4" y1="7" x2="20" y2="7" />
                        <line x1="4" y1="12" x2="20" y2="12" />
                        <line x1="4" y1="17" x2="20" y2="17" />
                      </svg>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40 border-border bg-[#101d2b] text-[#fce1b6]">
                    {user.groupName &&
                      LINKS.map((l) => (
                        <DropdownMenuItem key={l.to} asChild>
                          <Link to={l.to} className="cursor-pointer">{l.label}</Link>
                        </DropdownMenuItem>
                      ))}
                    {user.groupName && <DropdownMenuSeparator className="bg-border" />}
                    <DropdownMenuItem
                      onClick={() => logout.mutate()}
                      className="cursor-pointer text-[#EF5459] focus:text-[#EF5459]"
                    >
                      退出登录
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <a href={`/api/oauth/login?origin=${encodeURIComponent(window.location.origin)}`} className="whitespace-nowrap text-sm font-bold text-[#FFB700] hover:underline">
                登录 →
              </a>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}
