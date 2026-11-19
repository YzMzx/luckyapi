import type { BadgeTexture as Texture } from "./types";

// Hand-engraved silhouettes share one tiny viewport and no paint-server IDs.
// The edge placement leaves a quiet field under the title.
const engravings: Record<Exclude<Texture, "none">, string> = {
  "firefly-dots":
    "m13 9 1.2-3 1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2zM28 24h1m8-16h1m117 8h2m7 11h1m-16 4h1m20-22h1",
  mist: "M-5 26q18-15 40-5t35-1m62-8q17-10 35-6t26 0M-5 28q28-10 47-4",
  "warm-tail": "M-8 26q19-11 40-12M-4 30l23-9m127-2 32-12m-20 14 17-5",
  "ice-crystals":
    "m8 21 7-12 7 12-7 7zM15 9v19m132-18 6-8 5 8-5 8zM153 2v16m10 8 5-7 5 7-5 6z",
  ripples:
    "M-21 18q33-19 63 0t-63 0zm4 1q24-12 47 0t-47 0zm144-8q27-12 54 0t-54 0zm8 0q18-7 37 0t-37 0z",
  dewdrops:
    "M10 24q-5-3 0-9 5 6 0 9zm20-13q-3-2 0-6 3 4 0 6zm125 13q-5-3 0-9 5 6 0 9zm10-14q-3-2 0-6 3 4 0 6z",
  "gold-threads":
    "M-8 33 25 0m-19 34L37 2m-21 31L48 1m80 30 29-29m-18 30 28-29m-17 29 30-31",
  brushed:
    "M-3 26 47 6M3 28 35 15m-15 14 27-11m86 2 45-18m-40 24 42-17m-34 19 35-13",
  "rock-strata":
    "M-5 28 10 18l12 2L44 7M-1 32l14-10 11 2L45 12m85 9 13-6 11 2L180 3m-47 24 15-7 9 2 24-13",
  "gold-cloud":
    "M-5 23h30c10 0 9-11 2-11-4 0-6 5-2 6h10m103-4h16c0-7 11-9 13-2 5-1 10 1 10 5h8",
  "soft-fog":
    "M-7 23q20-11 35-6t27 1M-4 28q22-9 37-5m101-12q14-8 31-4t24 1m-45 7q19-6 36-2",
  feathers:
    "M-3 31C7 13 24 2 35 1c-2 13-19 23-38 30Zm5-3L30 5m-17 12 10-1m118 12q4-16 31-22-8 17-31 22zm2-2 24-17",
  "gold-flecks":
    "m5 21 9-5-2 4zm15-12 8-4-3 4zm7 17 3-2m117-7 8-4-3 5zm16-9 4-2-1 3zm-2 17 5-2m8-10 3-2",
  streamlines:
    "M-8 28C13 30 20 7 47 7M-8 32C19 31 23 12 45 12m82 8c24 4 29-14 54-12m-47 18c19-1 30-17 48-12",
  moonlight:
    "M14 5c-7 7-3 15 6 16a10 10 0 0 1-6-16ZM2 27h22m123-15 19-2m-24 8 27-3m-11 6 13-2",
  stardust:
    "m13 9 1-3 1 3 3 1-3 1-1 3-1-3-3-1zM6 23h1m24-2h1m10-13h1m83 18h1m21-16h1m11 10 1-3 1 3 3 1-3 1-1 3-1-3-3-1zm10-15h1",
  constellation:
    "m-3 24 15-8L25 5l14 8M12 16l11 9L39 13m91 10 12-14 14 8 19-11M142 9l11-5m-142 12h2m13-11h2m116 4h2m11 8h2",
  orbits:
    "M-15 29C-8 12 22 2 55-3M-14 30C10 24 34 13 42-3m82 38c44-6 60-20 58-36m-44 35c29-11 46-27 46-31",
};

export function BadgeTexture({
  texture,
}: {
  texture: Exclude<Texture, "none">;
}) {
  return (
    <svg
      className="level-badge__texture"
      data-texture={texture}
      viewBox="0 0 176 32"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={engravings[texture]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
