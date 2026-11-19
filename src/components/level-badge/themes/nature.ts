import type {
  BadgeMotion,
  BadgeTexture,
  BadgeThemeConfig,
  BadgeVariantConfig,
} from "../types";

// Keep the prescribed color stops visible together in the theme's color table.
function gradient(stops: string, alpha = ""): string {
  const colors = stops.split(" ").map(color => color + alpha);
  if (colors.length === 1) colors.push(colors[0]);
  return `linear-gradient(115deg, ${colors.join(", ")})`;
}

function variant(
  title: string,
  background: string,
  border: string,
  textColor: string,
  texture: BadgeTexture = "none",
  finish: Pick<BadgeVariantConfig, "scrim" | "motion" | "darkTextColor"> = {}
): BadgeVariantConfig {
  return {
    title,
    background: gradient(background),
    border: gradient(border),
    textColor,
    texture,
    ...(finish.darkTextColor
      ? {
          darkBackground: gradient(background, "2E"),
          darkBorder: gradient(border, "80"),
        }
      : {}),
    ...finish,
  };
}

// Translucent, same-hue surfaces used for the lighter variants on dark canvases.
const moss = {
  darkTextColor: "#E4F0BC",
};
const jade = {
  darkTextColor: "#C7F4EF",
};
const forest = {
  darkTextColor: "#D2F2DD",
};
const sky = {
  darkTextColor: "#DFE7FF",
};

const winnerMotion: BadgeMotion = { kind: "slow-sweep", duration: "4s" };

export const natureTheme: BadgeThemeConfig = {
  id: "nature",
  name: "自然",
  description: "循着萤光出发，经过清泉、松林与云海，抵达星河。",
  stages: [
    {
      id: "firefly",
      name: "萤火",
      icon: "firefly",
      effect: "none",
      description: "暮色落在草叶上，第一点萤光亮起来。",
      base: variant(
        "萤火",
        "#F7F9F2 #EBF2DC",
        "#C5D89D",
        "#3F5219",
        "none",
        moss
      ),
      ranks: {
        1: variant(
          "破夜初萤",
          "#1B2918 #314A29",
          "#FACC15",
          "#FEF9C3",
          "firefly-dots",
          { motion: winnerMotion }
        ),
        2: variant("林间星火", "#2B4030 #46664C", "#D6E5DA", "#F0FDF4", "mist"),
        3: variant(
          "微芒引路",
          "#DCE8C6 #BFD49A",
          "#C88D55",
          "#2D3F12",
          "warm-tail",
          moss
        ),
      },
    },
    {
      id: "spring",
      name: "清泉",
      icon: "spring",
      effect: "highlight",
      description: "一脉泉水沿石隙流下，在松根旁汇成浅溪。",
      base: variant(
        "清泉",
        "#EDF7F6 #CFECEB",
        "#7EC4C1",
        "#165359",
        "none",
        jade
      ),
      ranks: {
        1: variant(
          "雪山源泉",
          "#0D4454 #1C7285",
          "#F5D061",
          "#F0FDFA",
          "ice-crystals",
          { motion: winnerMotion, scrim: "rgba(0, 0, 0, 0.08)" }
        ),
        2: variant(
          "听松鸣涧",
          "#1C636B #408E94",
          "#D9EFEF",
          "#ECFEFF",
          "ripples",
          { scrim: "rgba(0, 0, 0, 0.17)" }
        ),
        3: variant(
          "玉露清溪",
          "#C6EAE8 #9AD5D2",
          "#C98E63",
          "#0F464A",
          "dewdrops",
          jade
        ),
      },
    },
    {
      id: "pine",
      name: "劲松",
      icon: "pine",
      effect: "matte",
      description: "松根扎入崖缝，针叶在山风里发出潮声。",
      base: variant(
        "劲松",
        "#E3F2E9 #B6DAC6",
        "#4A8B6B",
        "#183D2D",
        "none",
        forest
      ),
      ranks: {
        1: variant(
          "凌云古松",
          "#0F291E #1C4D37",
          "#E8B949",
          "#ECFDF5",
          "gold-threads",
          { motion: winnerMotion }
        ),
        2: variant(
          "听涛苍柏",
          "#1C4736 #377358",
          "#C7DDD2",
          "#EBF7F1",
          "brushed",
          { scrim: "rgba(0, 0, 0, 0.08)" }
        ),
        3: variant(
          "青崖翠杉",
          "#B3DEC7 #80BF9F",
          "#B87D52",
          "#123626",
          "rock-strata",
          forest
        ),
      },
    },
    {
      id: "cloud",
      name: "流云",
      icon: "cloud",
      effect: "glow",
      description: "越过松梢，风把一抹山岚送向开阔的晴空。",
      base: variant(
        "流云",
        "#EEF2FA #C9D8F2 #E0D8F3",
        "#7A9AD6",
        "#223A70",
        "none",
        sky
      ),
      ranks: {
        1: variant(
          "九天垂云",
          "#21275C #4958A3 #8975BF",
          "#F6C96E",
          "#F8FAFC",
          "gold-cloud",
          { motion: winnerMotion, scrim: "rgba(0, 0, 0, 0.18)" }
        ),
        2: variant(
          "归岫闲云",
          "#344B85 #6584C4",
          "#E2EAF8",
          "#F1F5FF",
          "soft-fog",
          { scrim: "rgba(0, 0, 0, 0.19)" }
        ),
        3: variant(
          "晴空鹤影",
          "#C4D7F7 #9BB9EE",
          "#D48066",
          "#192F60",
          "feathers",
          sky
        ),
      },
    },
    {
      id: "ocean",
      name: "沧海",
      icon: "ocean",
      effect: "glaze",
      description: "江河在此入海，一线潮头托起初升的月。",
      base: variant("沧海", "#142F4D #275A87", "#6BA8D9", "#EAF5FD"),
      ranks: {
        1: variant(
          "东临沧海",
          "#081930 #133C69 #1B6594",
          "#FFB703",
          "#FFFDF5",
          "gold-flecks",
          { motion: winnerMotion }
        ),
        2: variant(
          "扶摇巨鲲",
          "#102A4A #255687",
          "#D0E4F5",
          "#EDF6FC",
          "streamlines"
        ),
        3: variant(
          "潮生明月",
          "#1C4269 #3C729E",
          "#D9A066",
          "#F0F7FC",
          "moonlight",
          { scrim: "rgba(0, 0, 0, 0.10)" }
        ),
      },
    },
    {
      id: "galaxy",
      name: "星河",
      icon: "galaxy",
      effect: "none",
      description: "海面静下来，星河的倒影一直铺到天边。",
      base: variant(
        "星河",
        "#121026 #292157 #19386B",
        "#A5B4FC #FDE68A",
        "#F8FAFC",
        "stardust",
        { motion: { kind: "breathe", duration: "6s" } }
      ),
      ranks: {
        1: variant(
          "银河之心",
          "#09061A #2B1866 #5A2791",
          "#FDE047 #C084FC #60A5FA",
          "#FFFFFF",
          "stardust",
          { motion: winnerMotion }
        ),
        2: variant(
          "北斗天枢",
          "#0F1130 #242E6E",
          "#E0E7FF #94A3B8",
          "#F8FAFC",
          "constellation",
          { motion: { kind: "silver-sweep", duration: "9s" } }
        ),
        3: variant(
          "织梦星轨",
          "#1C1947 #403585",
          "#E5A48B #F4C7B2",
          "#FDF4F0",
          "orbits"
        ),
      },
    },
  ],
};
