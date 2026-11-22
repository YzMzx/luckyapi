import { ArrowRight, Bookmark } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { useMe } from "@/hooks/useMe";
import { hallCategories } from "./badge-hall/categories";
import "./badge-hall/hall.css";

export default function BadgeHall() {
  const { user } = useMe({ requireAuth: true, requireOnboarded: true });
  const [params] = useSearchParams();
  const available = hallCategories.filter(
    category => category.status === "available"
  );
  const selected =
    available.find(category => category.id === params.get("type")) ??
    available[0];
  const Exhibit = selected?.Exhibit;
  if (!user?.onboarded)
    return (
      <p role="status" className="p-8">
        加载中…
      </p>
    );

  return (
    <ConsoleLayout user={user} title="铭牌殿堂">
      <div data-theme="dark" className="space-y-8">
        <nav
          aria-labelledby="hall-types-title"
          className="overflow-hidden rounded-2xl border border-[#af915f]/40 bg-[#101d2b] shadow-xl"
        >
          <header className="hall-cover flex flex-wrap items-end justify-between gap-5 p-5 sm:p-8">
            <div>
              <h2
                id="hall-types-title"
                className="text-outline text-3xl font-black sm:text-4xl"
              >
                铭牌分类
              </h2>
              <p className="mt-2 max-w-prose text-sm leading-6 text-[#fce1b6]">
                选择展区，查看铭牌的获得方式与获授成员。
              </p>
            </div>
            <Link
              to="/console/my-badges"
              className="btn-3d inline-flex items-center gap-2 rounded-lg bg-[#FFB700] px-4 py-2.5 text-sm font-black text-[#162638]"
            >
              <Bookmark aria-hidden="true" size={16} />
              我的铭牌
            </Link>
          </header>
          <ul className="hall-category-grid border-t border-border p-4 sm:p-5">
            {hallCategories.map(category => {
              const Icon = category.icon;
              const content = (
                <>
                  <Icon
                    aria-hidden="true"
                    className="mt-0.5 h-5 w-5 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold">{category.title}</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {category.description}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={category.id}>
                  {category.status === "available" ? (
                    <Link
                      className="hall-category hall-category-link"
                      to={{
                        search: `?type=${encodeURIComponent(category.id)}`,
                      }}
                      aria-current={
                        selected?.id === category.id ? "page" : undefined
                      }
                    >
                      {content}
                      <ArrowRight
                        aria-hidden="true"
                        size={15}
                        className="mt-1 shrink-0"
                      />
                    </Link>
                  ) : (
                    <div className="hall-category border-dashed border-border text-muted-foreground">
                      {content}
                      <span className="shrink-0 text-xs">待开放</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        {Exhibit ? (
          <Exhibit />
        ) : (
          <p className="text-sm text-muted-foreground">展区筹备中。</p>
        )}
      </div>
    </ConsoleLayout>
  );
}
