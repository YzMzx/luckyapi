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
            className="stage-plate-map-line"
            pathLength="1"
            d="m16 43 10-24 14 12 8-15M26 19l10 29 4-17M16 43l20 5"
          />
          {[
            ["16", "43"],
            ["26", "19"],
            ["40", "31"],
            ["48", "16"],
            ["36", "48"],
          ].map(([cx, cy], i) => (
            <circle
              key={cx}
              className="stage-plate-map-star"
              style={{ "--star-index": i } as React.CSSProperties}
              cx={cx}
              cy={cy}
              r="2.5"
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

function LimitedEffects({ stage }: { stage: number }) {
  return (
    <>
      <span
        className={`stage-plate-outer-glow stage-plate-tier-${stage}`}
        aria-hidden="true"
      />
      <span className="stage-plate-effects" aria-hidden="true">
        <span className="stage-plate-light-field" />
        <span className="stage-plate-light-band" />
        <svg
          className="stage-plate-fx"
          viewBox="0 0 340 104"
          preserveAspectRatio="none"
        >
          {stage === 1 && (
            <g className="fx-comets">
              <path d="M-20 85 84 18h-30l104-27-18 24h33L55 72 86 66-20 104Z" />
              <path
                className="fx-comet-core"
                d="m259 18 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"
              />
            </g>
          )}
          {stage === 2 && (
            <g className="fx-trajectories">
              <ellipse
                cx="49"
                cy="52"
                rx="44"
                ry="25"
                transform="rotate(-28 49 52)"
              />
              <path
                className="fx-energy-river"
                d="M88 76C144 22 196 108 345 26"
              />
              <path
                className="fx-energy-river fx-energy-river-secondary"
                d="M79 25C161 93 221 9 350 68"
              />
            </g>
          )}
          {stage === 3 && (
            <g className="fx-constellation">
              <path
                pathLength="1"
                d="m13 79 39-56 43 44 39-51 55 56 50-44 58 49"
              />
              <path
                pathLength="1"
                d="m52 23 82 49 55-56 10 12 58 49"
                opacity=".6"
              />
              {[
                [13, 79],
                [52, 23],
                [95, 67],
                [134, 16],
                [189, 72],
                [239, 28],
                [297, 77],
              ].map(([x, y], i) => (
                <circle
                  key={x}
                  className="fx-map-node"
                  style={{ "--node-index": i } as React.CSSProperties}
                  cx={x}
                  cy={y}
                  r="2.4"
                />
              ))}
            </g>
          )}
          {stage === 4 && (
            <g className="fx-crown-field">
              <path
                className="fx-crown-rays"
                d="m49 0-8 30-22-17 8 27-27 6 30 11-18 24 29-14 8 37 9-37 28 14-17-24 29-11-27-6 8-27-22 17Z"
              />
              <path
                className="fx-royal-ribbon"
                d="M79 86C143 20 196 95 353 12"
              />
              <g className="fx-crystal-sigil">
                <path d="m49 24 13 21-5 25-8 10-8-10-5-25Z" />
                <path d="m49 24v56M36 45l13 12 13-12M41 70l8-13 8 13" />
              </g>
              <g className="fx-crown-portals">
                <ellipse cx="49" cy="52" rx="34" ry="39" />
                <ellipse
                  cx="49"
                  cy="52"
                  rx="42"
                  ry="25"
                  transform="rotate(-30 49 52)"
                />
              </g>
              <path
                className="fx-crown-lances"
                d="m123 18 4 9 9 4-9 4-4 9-4-9-9-4 9-4Zm121 43 5 11 11 5-11 5-5 11-5-11-11-5 11-5Zm51-42 3 6 6 3-6 3-3 6-3-6-6-3 6-3Z"
              />
            </g>
          )}
          {stage === 5 && (
            <g className="fx-zenith">
              <path
                className="fx-solar-waves"
                d="M-20 68C38 10 61 97 116 40s88 55 132 0 72-28 112-2M-20 86C38 28 61 115 116 58s88 55 132 0 72-28 112-2"
              />
              <g className="fx-solar-corona">
                <circle cx="49" cy="52" r="33" />
                <circle cx="49" cy="52" r="41" />
                <path d="M49 0v17m0 70v17M-3 52h17m70 0h17M12 15l12 12m50 50 12 12M12 89l12-12m50-50 12-12M26 4l7 15m32 66 7 15M2 29l15 7m64 32 15 7M2 75l15-7m64-32 15-7M26 100l7-15m32-66 7-15" />
              </g>
              <g className="fx-solar-heart">
                <circle cx="49" cy="52" r="17" />
                <path d="m49 30 5 17 17 5-17 5-5 17-5-17-17-5 17-5Z" />
              </g>
              <path
                className="fx-star-lances"
                d="m132 12 3 6 6 3-6 3-3 6-3-6-6-3 6-3Zm107 54 4 8 8 4-8 4-4 8-4-8-8-4 8-4Zm67-51 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"
              />
              <path
                className="fx-gold-filigree"
                d="M85 21h38l9 9h45l9-9h47M85 83h38l9-9h45l9 9h47M272 21h18l8 8h42M272 83h18l8-8h42"
              />
            </g>
          )}
        </svg>
        <span className="stage-plate-edge-runner">
          <i />
        </span>
        {stage >= 4 && (
          <span className="stage-plate-levitating-gems">
            <i />
            <i />
            <i />
          </span>
        )}
      </span>
      {stage >= 4 && (
        <span
          className={`stage-plate-crown stage-plate-crown-${stage}`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 64 36" fill="none">
            <path
              className="fx-regal-crown-body"
              d="m5 10 15 10 12-17 12 17 15-10-7 23H12Z"
            />
            <path className="fx-regal-crown-base" d="M12 27h40" />
            <path className="fx-regal-crown-jewel" d="m32 15 5 6-5 6-5-6Z" />
            <circle cx="5" cy="8" r="2" />
            <circle cx="59" cy="8" r="2" />
          </svg>
        </span>
      )}
      {stage === 5 && (
        <span className="stage-plate-celestial-rings" aria-hidden="true">
          <i />
          <i />
          <b />
        </span>
      )}
    </>
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
  const stage = index + 1;
  const limited = rank != null;
  const id = `stage-emblem-${useId().replaceAll(":", "")}`;
  return (
    <span
      className={`stage-plate stage-plate-${stage}${limited ? " stage-plate-limited" : ""}${size === "compact" ? " stage-plate-compact" : ""}`}
      data-level={level}
      data-effect={getStageMeta(level).motion}
    >
      <span className="stage-plate-shell">
        <span className="stage-plate-backdrop" aria-hidden="true" />
        {limited && <LimitedEffects stage={stage} />}
        <span className="stage-plate-emblem" aria-hidden="true">
          <svg
            className="stage-plate-emblem-halo"
            viewBox="0 0 72 72"
            fill="none"
          >
            <circle
              cx="36"
              cy="36"
              r="33"
              stroke="currentColor"
              strokeOpacity=".45"
              strokeDasharray="2 5"
            />
            <ellipse
              className="stage-plate-emblem-orbit"
              cx="36"
              cy="36"
              rx="31"
              ry="18"
              transform="rotate(-32 36 36)"
              stroke="currentColor"
              strokeOpacity=".8"
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
          {limited && (
            <span
              className={`stage-plate-satellites stage-plate-satellites-${stage}`}
            >
              {Array.from({ length: stage >= 4 ? 3 : stage }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          )}
        </span>
        <span className="stage-plate-copy">
          <span className="stage-plate-overline" aria-hidden="true">
            <span>{stage === 5 ? "APEX" : "STAGE"}</span>
            <b>{String(level).padStart(2, "0")}</b>
          </span>
          <span className="stage-plate-name">{name}</span>
          <span className="stage-plate-code" aria-hidden="true">
            {getStageMeta(level).code}
          </span>
        </span>
        {limited && (
          <span className="stage-plate-serial">
            <span>{stage === 5 ? "至臻" : "限定"}</span>
            <strong>{String(rank).padStart(2, "0")}</strong>
            <span className="stage-plate-total">/ 03</span>
          </span>
        )}
        <span className="stage-plate-rivet" aria-hidden="true" />
      </span>
      {limited && (
        <span className="stage-plate-edition" aria-hidden="true">
          <i />
          {stage === 5
            ? "CELESTIAL SOVEREIGN · ONE OF THREE"
            : "FIRST ARRIVAL · LIMITED EDITION"}
        </span>
      )}
    </span>
  );
}
