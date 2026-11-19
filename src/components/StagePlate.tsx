import { useId } from "react";
import "./StagePlate.css";

import { getStageIndex, getStageMeta } from "./stageMeta";

function EmblemArt({ level }: { level: number }) {
  const shared = {
    fill: "none",
    strokeWidth: 1.5,
    strokeLinejoin: "round" as const,
  };
  switch (level) {
    case 20:
      return (
        <g {...shared}>
          <circle cx="32" cy="32" r="7" />
          <ellipse
            cx="32"
            cy="32"
            rx="23"
            ry="10"
            transform="rotate(-35 32 32)"
          />
          <path
            d="m32 24 2.5 5.5L40 32l-5.5 2.5L32 40l-2.5-5.5L24 32l5.5-2.5Z"
            fill="currentColor"
            stroke="none"
          />
          <circle cx="49" cy="19" r="2.5" fill="currentColor" stroke="none" />
        </g>
      );
    case 30:
      return (
        <g {...shared}>
          <path
            d="m16 43 10-24 14 12 8-15M26 19l10 29 4-17M16 43l20 5"
            opacity=".75"
          />
          {[
            ["16", "43"],
            ["26", "19"],
            ["40", "31"],
            ["48", "16"],
            ["36", "48"],
          ].map(([cx, cy]) => (
            <circle
              key={cx}
              cx={cx}
              cy={cy}
              r="3"
              fill="var(--plate-surface)"
            />
          ))}
          <path
            d="m26 13 2 4 4 2-4 2-2 4-2-4-4-2 4-2Z"
            fill="currentColor"
            stroke="none"
          />
        </g>
      );
    case 40:
      return (
        <g {...shared}>
          <path d="m15 23 10 8 7-16 7 16 10-8-5 25H20Z" />
          <path d="M21 42h22M25 52h14" opacity=".8" />
          <path
            d="m32 7 2.5 5L32 15l-2.5-3Z"
            fill="currentColor"
            stroke="none"
          />
          <circle cx="15" cy="20" r="2" fill="currentColor" stroke="none" />
          <circle cx="49" cy="20" r="2" fill="currentColor" stroke="none" />
        </g>
      );
    case 50:
      return (
        <g {...shared}>
          <circle cx="32" cy="32" r="12" />
          <circle cx="32" cy="32" r="18" strokeDasharray="2 5" opacity=".75" />
          <path d="M32 5v7m0 40v7M5 32h7m40 0h7M13 13l5 5m28 28 5 5M13 51l5-5m28-28 5-5" />
          <path
            d="m32 23 2.8 6.2L41 32l-6.2 2.8L32 41l-2.8-6.2L23 32l6.2-2.8Z"
            fill="currentColor"
            stroke="none"
          />
        </g>
      );
    default:
      return (
        <g {...shared}>
          <path d="m32 11 5.5 15.5L53 32l-15.5 5.5L32 53l-5.5-15.5L11 32l15.5-5.5Z" />
          <path
            d="m32 23 2.5 6.5L41 32l-6.5 2.5L32 41l-2.5-6.5L23 32l6.5-2.5Z"
            fill="currentColor"
            stroke="none"
          />
          <path d="M15 15h7m-3.5-3.5v7M45 49h7m-3.5-3.5v7" opacity=".8" />
        </g>
      );
  }
}

function StageEmblem({ level }: { level: number }) {
  const id = `stage-emblem-${useId().replaceAll(":", "")}`;
  return (
    <span className="stage-plate-emblem" aria-hidden="true">
      <svg className="stage-plate-emblem-halo" viewBox="0 0 72 72" fill="none">
        <circle
          cx="36"
          cy="36"
          r="33"
          stroke="currentColor"
          strokeOpacity=".35"
          strokeDasharray="2 5"
        />
        <circle
          className="stage-plate-emblem-orbit"
          cx="36"
          cy="36"
          r="28"
          stroke="currentColor"
          strokeOpacity=".7"
          strokeDasharray="34 142"
        />
      </svg>
      <svg className="stage-emblem" viewBox="0 0 64 64" fill="none">
        <defs>
          <linearGradient
            id={id}
            x1="12"
            y1="8"
            x2="52"
            y2="58"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--plate-highlight)" />
            <stop offset=".48" stopColor="var(--plate-accent)" />
            <stop offset="1" stopColor="var(--plate-deep)" />
          </linearGradient>
        </defs>
        <path
          className="stage-emblem-frame"
          d="M32 3 55 16v32L32 61 9 48V16Z"
          stroke={`url(#${id})`}
        />
        <path
          className="stage-emblem-inner-frame"
          d="M32 8 50 18v28L32 56 14 46V18Z"
        />
        <g
          className="stage-emblem-art"
          color={`url(#${id})`}
          stroke={`url(#${id})`}
        >
          <EmblemArt level={level} />
        </g>
      </svg>
    </span>
  );
}

export function StagePlate({
  level,
  name,
  rank,
  size = "regular",
}: {
  level: number;
  name: string;
  rank?: number;
  size?: "regular" | "compact";
}) {
  const index = Math.max(0, getStageIndex(level));
  const limited = rank != null;
  return (
    <span
      className={`stage-plate stage-plate-${index + 1}${limited ? " stage-plate-limited" : ""}${size === "compact" ? " stage-plate-compact" : ""}`}
      data-level={level}
    >
      <span className="stage-plate-shell">
        <span className="stage-plate-backdrop" aria-hidden="true" />
        {limited && (
          <span className="stage-plate-effects" aria-hidden="true">
            <span className="stage-plate-aurora" />
            <span className="stage-plate-shine" />
            <span className="stage-plate-particles">
              {Array.from({ length: 6 }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          </span>
        )}
        <StageEmblem level={level} />
        <span className="stage-plate-copy">
          <span className="stage-plate-overline" aria-hidden="true">
            <span>STAGE</span>
            <b>{String(level).padStart(2, "0")}</b>
          </span>
          <span className="stage-plate-name">{name}</span>
          <span className="stage-plate-code" aria-hidden="true">
            {getStageMeta(level).code}
          </span>
        </span>
        {limited && (
          <span className="stage-plate-serial">
            <span>限定</span>
            <strong>{String(rank).padStart(2, "0")}</strong>
            <span className="stage-plate-total">/ 03</span>
          </span>
        )}
        <span className="stage-plate-rivet" aria-hidden="true" />
      </span>
      {limited && (
        <span className="stage-plate-edition" aria-hidden="true">
          <i />
          FIRST ARRIVAL · LIMITED EDITION
        </span>
      )}
    </span>
  );
}
