import { useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Compass,
  Layers3,
  Leaf,
  MessageCircle,
  Moon,
  PanelsTopLeft,
  SlidersHorizontal,
  Sparkles,
  Sprout,
  Sun,
  Trophy,
} from "lucide-react";
import { Link } from "react-router";
import { LevelBadge } from "./LevelBadge";
import { natureTheme, getStageMinLevel } from "./themes";
import type { BadgeRank, BadgeSize } from "./types";
import "./LevelBadgeShowcase.css";

const sizes: BadgeSize[] = ["xs", "sm", "md", "lg"];
const variants = [null, 1, 2, 3] as const;
const variantName = { 1: "第一名", 2: "第二名", 3: "第三名" } as const;
const filters = [
  { id: "all", name: "全部" },
  { id: "standard", name: "常规" },
  { id: "limited", name: "限定" },
] as const;
type Filter = (typeof filters)[number]["id"];

const comments = [
  {
    name: "青苔手记",
    avatar: "苔",
    level: 24,
    rank: null,
    time: "12 分钟前",
    text: "山腰的松林还蒙着雾，低头才发现松针上全是水珠。",
  },
  {
    name: "沿溪而行",
    avatar: "溪",
    level: 16,
    rank: 2,
    time: "36 分钟前",
    text: "今天顺着溪流走了一段，终于听见了林子里的第一声鸟鸣。",
  },
] as const;
const explorers = [
  { name: "追星的人", level: 58, rank: 1, score: "2,840" },
  { name: "潮汐来信", level: 47, rank: 2, score: "2,316" },
  { name: "山间晴时", level: 38, rank: 3, score: "1,962" },
] as const;

function SceneExamples({
  size,
  animated,
}: {
  size: BadgeSize;
  animated: boolean;
}) {
  return (
    <section
      className="atlas-section"
      id="badge-scenes"
      aria-labelledby="atlas-scene-title"
    >
      <div className="atlas-section-head">
        <div>
          <p className="atlas-kicker">
            <PanelsTopLeft aria-hidden="true" /> IN CONTEXT
          </p>
          <h2 id="atlas-scene-title">应用场景</h2>
        </div>
        <span className="atlas-muted">模拟数据</span>
      </div>
      <div className="atlas-scenes">
        <article className="atlas-scene">
          <header>
            <MessageCircle aria-hidden="true" />
            <h3>观察手记 · 评论区</h3>
          </header>
          <ul>
            {comments.map(comment => (
              <li className="atlas-comment" key={comment.name}>
                <span className="atlas-avatar" aria-hidden="true">
                  {comment.avatar}
                </span>
                <div>
                  <div className="atlas-identity">
                    <strong>{comment.name}</strong>
                    <LevelBadge
                      level={comment.level}
                      rank={comment.rank}
                      size={size}
                      animated={animated}
                    />
                  </div>
                  <p>{comment.text}</p>
                  <small>{comment.time}</small>
                </div>
              </li>
            ))}
          </ul>
        </article>
        <article className="atlas-scene">
          <header>
            <Trophy aria-hidden="true" />
            <h3>本周探索榜</h3>
          </header>
          <ol>
            {explorers.map(person => (
              <li className="atlas-rank" key={person.rank}>
                <span
                  className="atlas-place"
                  aria-label={variantName[person.rank]}
                >
                  {String(person.rank).padStart(2, "0")}
                </span>
                <div className="atlas-identity">
                  <strong>{person.name}</strong>
                  <LevelBadge
                    level={person.level}
                    rank={person.rank}
                    size={size}
                    animated={animated}
                  />
                </div>
                <span className="atlas-score">
                  {person.score}
                  <small>积分</small>
                </span>
              </li>
            ))}
          </ol>
        </article>
      </div>
    </section>
  );
}

export default function LevelBadgeShowcase() {
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [size, setSize] = useState<BadgeSize>("md");
  const [animated, setAnimated] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const stages = natureTheme.stages;
  const selectedVariants = variants.filter(
    rank =>
      filter === "all" ||
      (filter === "standard" ? rank === null : rank !== null)
  );
  return (
    <div
      className="nature-atlas"
      data-theme={mode}
      data-plate-motion={animated ? "on" : "off"}
    >
      <header className="atlas-header">
        <div className="atlas-shell atlas-nav">
          <a className="atlas-brand" href="#atlas-top">
            <span className="atlas-brand-mark">
              <Sprout aria-hidden="true" />
            </span>
            <span>
              自然档案馆<small>NATURE ARCHIVE</small>
            </span>
          </a>
          <nav aria-label="图鉴导航">
            <a href="#badge-collection">铭牌图鉴</a>
            <a href="#badge-scenes">应用场景</a>
          </nav>
          <Link className="atlas-home" to="/">
            返回首页 <ArrowUpRight aria-hidden="true" />
          </Link>
        </div>
      </header>
      <main className="atlas-shell atlas-main" id="atlas-top">
        <header className="atlas-cover">
          <p className="atlas-cover-kicker">
            <span /> NATURE FIELD GUIDE
          </p>
          <h1>自然铭牌图鉴</h1>
          <p className="atlas-intro">
            从林间萤火到浩瀚星河，沿六个自然阶段探索成长的印记。
          </p>
          <div className="atlas-cover-stats">
            <span>
              <Layers3 aria-hidden="true" />
              {stages.length} 个成长阶段
            </span>
            <i />
            <span>
              <BookOpen aria-hidden="true" />
              {variants.length * stages.length} 款等级铭牌
            </span>
          </div>
          <Compass
            aria-hidden="true"
            className="atlas-compass"
            strokeWidth={0.8}
          />
        </header>
        <div className="atlas-toolbar" role="group" aria-label="图鉴展示设置">
          <strong className="atlas-toolbar-title">
            <SlidersHorizontal aria-hidden="true" />
            展示设置
          </strong>
          <div className="atlas-control-group">
            <span>模式</span>
            <div className="atlas-segments" role="group" aria-label="显示模式">
              {(["light", "dark"] as const).map(choice => (
                <button
                  type="button"
                  key={choice}
                  aria-pressed={mode === choice}
                  onClick={() => setMode(choice)}
                >
                  {choice === "light" ? (
                    <Sun aria-hidden="true" />
                  ) : (
                    <Moon aria-hidden="true" />
                  )}
                  {choice === "light" ? "浅色" : "深色"}
                </button>
              ))}
            </div>
          </div>
          <div className="atlas-control-group">
            <span>尺寸</span>
            <div
              className="atlas-segments atlas-sizes"
              role="group"
              aria-label="铭牌尺寸"
            >
              {sizes.map(choice => (
                <button
                  type="button"
                  key={choice}
                  aria-pressed={size === choice}
                  onClick={() => setSize(choice)}
                >
                  {choice.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="atlas-motion"
            role="switch"
            aria-checked={animated}
            onClick={() => setAnimated(!animated)}
          >
            <Sparkles aria-hidden="true" />
            铭牌动效
            <span aria-hidden="true" />
          </button>
        </div>
        <section
          className="atlas-section"
          id="badge-collection"
          aria-labelledby="atlas-collection-title"
        >
          <div className="atlas-section-head">
            <div>
              <p className="atlas-kicker">
                <Leaf aria-hidden="true" /> COLLECTION
              </p>
              <h2 id="atlas-collection-title">铭牌收藏</h2>
            </div>
            <div className="atlas-filter" role="group" aria-label="筛选铭牌">
              {filters.map(item => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.name}{" "}
                  <span>
                    {stages.length *
                      (item.id === "all"
                        ? variants.length
                        : item.id === "limited"
                          ? variants.length - 1
                          : 1)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="atlas-grid">
            {stages.map((stage, index) => {
              const level = getStageMinLevel(stage, index);
              const nextStage = stages[index + 1];
              const range = nextStage
                ? level + "–" + (getStageMinLevel(nextStage, index + 1) - 1)
                : level + "+";
              return (
                <article
                  key={stage.id}
                  className="atlas-card"
                  data-stage={stage.id}
                >
                  <header className="atlas-stage-cover">
                    <div>
                      <p>{stage.id.toUpperCase()}</p>
                      <h3>{stage.name}</h3>
                    </div>
                    <span className="atlas-range">Lv. {range}</span>
                  </header>
                  <ul className="atlas-variants">
                    {selectedVariants.map((rank: BadgeRank | null) => (
                      <li key={rank ?? "regular"}>
                        <span
                          className="atlas-variant-name"
                          data-rank={rank ?? "regular"}
                        >
                          <i />
                          {rank === null ? "常规" : variantName[rank]}
                        </span>
                        <LevelBadge
                          theme={natureTheme.id}
                          level={level}
                          rank={rank}
                          size={size}
                          animated={animated}
                        />
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
        <SceneExamples size={size} animated={animated} />
        <footer className="atlas-footer">
          <span>
            <Sprout aria-hidden="true" /> 自然档案馆
          </span>
          <a href="#atlas-top">回到顶部 ↑</a>
        </footer>
      </main>
    </div>
  );
}
