import type { BadgeStageConfig } from "./types";

// Each mark uses the same stroke weight so a set stays legible at inline sizes.
const marks = {
  firefly:
    "M9 15c1-3 3-5 6-6 2 2 2 5 0 7s-5 2-6-1ZM9 13C4 11 4 7 6 6c3-1 5 2 6 5m1-1c0-4 3-7 5-6 2 2 0 5-3 7M5 17v4m-2-2h4m12-3v3m-1.5-1.5h3",
  spring:
    "M4 18c3-2 5 2 8 0s5 2 8 0M3 21c3-2 6 2 9 0s6 2 9 0M9 12c0-3 4-7 5-10 1 4 4 7 4 10a4.5 4.5 0 0 1-9 0Zm3 0c0 1 .5 2 2 2",
  pine: "m12 2-5 6h3l-6 6h4l-5 5h18l-5-5h4l-6-6h3l-5-6Zm0 10v10",
  cloud:
    "M3 18h13a3.4 3.4 0 0 0 0-6.8h-.8a5.8 5.8 0 0 0-11.3 1M2 15h8m-3 6h11m2-13h2m-4-3 1-2",
  ocean:
    "M2 16c3 0 4-2 6-5 2-4 5-6 10-5-3 1-5 4-4 6 1 3 4 4 8 3M2 20c3 0 5-1 7-3 3 2 5 3 8 2l5-2M3 12l2-2",
  galaxy:
    "m12 5 1.6 4.4L18 11l-4.4 1.6L12 17l-1.6-4.4L6 11l4.4-1.6L12 5ZM7 9C3 12 1 16 3 18c2 3 8 1 13-2 4-3 7-7 5-9-1-2-4-2-7-1m4 12v4m-2-2h4M5 3v3M3.5 4.5h3",
};

export function BadgeGlyph({ icon }: { icon: BadgeStageConfig["icon"] }) {
  const custom = typeof icon === "object";
  return (
    <svg
      viewBox={custom ? (icon.viewBox ?? "0 0 24 24") : "0 0 24 24"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={custom ? icon.path : marks[icon]} />
    </svg>
  );
}
