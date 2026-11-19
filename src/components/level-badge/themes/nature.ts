import type { BadgeThemeConfig } from '../types';

export const NATURE_THEME: BadgeThemeConfig = {
  "id": "nature",
  "name": "自然意境",
  "description": "东方色谱与自然光影层次：由浅入深、由素入华、由静入动的六阶段成长与排位限定徽标体系（v2 阶梯专属动效版）。",
  "stages": [
    {
      "id": "firefly",
      "index": 1,
      "minLevel": 1,
      "maxLevel": 10,
      "label": "Lv.1–10",
      "title": "萤火",
      "imagery": "苔原微光",
      "icon": "firefly",
      "surface": "light",
      "regular": {
        "title": "萤火",
        "surface": "light",
        "effect": "none",
        "texture": "none",
        "light": {
          "bg": "linear-gradient(135deg, #F7F9F2 0%, #EBF2DC 100%)",
          "border": "#C5D89D",
          "text": "#3F5219",
          "accent": "#6E8B32",
          "glow": "none"
        },
        "dark": {
          "bg": "rgba(197, 216, 157, 0.16)",
          "border": "rgba(197, 216, 157, 0.48)",
          "text": "#DDF0B2",
          "accent": "#C5D89D",
          "glow": "none"
        }
      },
      "ranks": {
        "1": {
          "rank": 1,
          "stamp": "No.01",
          "title": "破夜初萤",
          "tier": "gold",
          "surface": "dark",
          "effect": "firefly-swarm",
          "texture": "firefly-dots",
          "light": {
            "bg": "linear-gradient(135deg, #162313 0%, #2B4223 100%)",
            "border": "#FACC15",
            "text": "#FEF9C3",
            "accent": "#FDE047",
            "glow": "0 2px 12px rgba(250, 204, 21, 0.28)",
            "sweepColor": "rgba(254, 240, 138, 0.40)",
            "pulseColor": "rgba(250, 204, 21, 0.34)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 220deg, rgba(254,240,138,0.95) 285deg, #facc15 320deg, transparent 360deg)",
            "fxColor": "rgba(254, 240, 138, 0.92)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #162313 0%, #2B4223 100%)",
            "border": "#FDE047",
            "text": "#FEFCE8",
            "accent": "#FDE047",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 14px rgba(250, 204, 21, 0.34)",
            "sweepColor": "rgba(254, 240, 138, 0.42)",
            "pulseColor": "rgba(250, 204, 21, 0.38)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 210deg, #ffffff 280deg, #fde047 325deg, transparent 360deg)",
            "fxColor": "rgba(254, 249, 195, 0.95)"
          }
        },
        "2": {
          "rank": 2,
          "stamp": "No.02",
          "title": "林间星火",
          "tier": "silver",
          "surface": "dark",
          "effect": "silver-twinkle",
          "texture": "brushed",
          "light": {
            "bg": "linear-gradient(135deg, #273B2C 0%, #426148 100%)",
            "border": "#D6E5DA",
            "text": "#F0FDF4",
            "accent": "#DCFCE7",
            "glow": "0 2px 8px rgba(43, 64, 48, 0.24)",
            "sweepColor": "rgba(236, 253, 245, 0.34)",
            "fxColor": "rgba(220, 252, 231, 0.88)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #273B2C 0%, #426148 100%)",
            "border": "#E6F2E9",
            "text": "#F0FDF4",
            "accent": "#DCFCE7",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 10px rgba(0, 0, 0, 0.38)",
            "sweepColor": "rgba(236, 253, 245, 0.36)",
            "fxColor": "rgba(220, 252, 231, 0.92)"
          }
        },
        "3": {
          "rank": 3,
          "stamp": "No.03",
          "title": "微芒引路",
          "tier": "bronze",
          "surface": "light",
          "effect": "beacon-pulse",
          "texture": "tail-glow",
          "light": {
            "bg": "linear-gradient(135deg, #DCE8C6 0%, #BFD49A 100%)",
            "border": "#C88D55",
            "text": "#2D3F12",
            "accent": "#9A6433",
            "glow": "inset 0 0 10px rgba(253, 224, 71, 0.22)",
            "fxColor": "rgba(245, 198, 72, 0.55)"
          },
          "dark": {
            "bg": "rgba(191, 212, 154, 0.18)",
            "border": "rgba(214, 156, 102, 0.68)",
            "text": "#E4F0C8",
            "accent": "#E6B07E",
            "glow": "inset 0 0 8px rgba(253, 224, 71, 0.16)",
            "fxColor": "rgba(253, 224, 71, 0.40)"
          }
        }
      }
    },
    {
      "id": "spring",
      "index": 2,
      "minLevel": 11,
      "maxLevel": 20,
      "label": "Lv.11–20",
      "title": "清泉",
      "imagery": "山涧浅碧",
      "icon": "spring",
      "surface": "light",
      "regular": {
        "title": "清泉",
        "surface": "light",
        "effect": "none",
        "texture": "top-sheen",
        "light": {
          "bg": "linear-gradient(135deg, #EDF7F6 0%, #CFECEB 100%)",
          "border": "#7EC4C1",
          "text": "#165359",
          "accent": "#2E8A8E",
          "glow": "inset 0 1px 0 rgba(255, 255, 255, 0.78)"
        },
        "dark": {
          "bg": "rgba(126, 196, 193, 0.16)",
          "border": "rgba(126, 196, 193, 0.48)",
          "text": "#B3ECE9",
          "accent": "#7EC4C1",
          "glow": "inset 0 1px 0 rgba(255, 255, 255, 0.12)"
        }
      },
      "ranks": {
        "1": {
          "rank": 1,
          "stamp": "No.01",
          "title": "雪山源泉",
          "tier": "gold",
          "surface": "dark",
          "effect": "glacier-prism",
          "texture": "crystal",
          "light": {
            "bg": "linear-gradient(135deg, #0B3E4D 0%, #1B6E82 100%)",
            "border": "#F5D061",
            "text": "#F0FDFA",
            "accent": "#FDE07A",
            "glow": "0 2px 12px rgba(28, 114, 133, 0.34)",
            "sweepColor": "rgba(224, 252, 255, 0.44)",
            "pulseColor": "rgba(103, 232, 249, 0.30)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 210deg, #e0f2fe 265deg, #f5d061 320deg, transparent 360deg)",
            "fxColor": "rgba(253, 230, 138, 0.88)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #0B3E4D 0%, #1B6E82 100%)",
            "border": "#F9DC7E",
            "text": "#F0FDFA",
            "accent": "#FDE07A",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 14px rgba(56, 189, 248, 0.36)",
            "sweepColor": "rgba(224, 252, 255, 0.46)",
            "pulseColor": "rgba(103, 232, 249, 0.36)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 200deg, #ffffff 265deg, #f9dc7e 320deg, transparent 360deg)",
            "fxColor": "rgba(253, 230, 138, 0.94)"
          }
        },
        "2": {
          "rank": 2,
          "stamp": "No.02",
          "title": "听松鸣涧",
          "tier": "silver",
          "surface": "dark",
          "effect": "water-ripple",
          "texture": "ripple",
          "light": {
            "bg": "linear-gradient(135deg, #1B5E66 0%, #3C8A90 100%)",
            "border": "#D9EFEF",
            "text": "#ECFEFF",
            "accent": "#CFFAFE",
            "glow": "0 2px 8px rgba(28, 99, 107, 0.24)",
            "sweepColor": "rgba(207, 250, 254, 0.32)",
            "fxColor": "rgba(207, 250, 254, 0.45)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #1B5E66 0%, #3C8A90 100%)",
            "border": "#EAF8F8",
            "text": "#ECFEFF",
            "accent": "#CFFAFE",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 10px rgba(0, 0, 0, 0.38)",
            "sweepColor": "rgba(207, 250, 254, 0.35)",
            "fxColor": "rgba(207, 250, 254, 0.50)"
          }
        },
        "3": {
          "rank": 3,
          "stamp": "No.03",
          "title": "玉露清溪",
          "tier": "bronze",
          "surface": "light",
          "effect": "dew-glint",
          "texture": "glass",
          "light": {
            "bg": "linear-gradient(135deg, #C6EAE8 0%, #9AD5D2 100%)",
            "border": "#C98E63",
            "text": "#0F464A",
            "accent": "#9A623B",
            "glow": "inset 0 1px 0 rgba(255, 255, 255, 0.65)",
            "fxColor": "rgba(255, 255, 255, 0.85)"
          },
          "dark": {
            "bg": "rgba(154, 213, 210, 0.18)",
            "border": "rgba(214, 155, 111, 0.68)",
            "text": "#C6F3F0",
            "accent": "#E6B48F",
            "glow": "inset 0 1px 0 rgba(255, 255, 255, 0.14)",
            "fxColor": "rgba(207, 250, 254, 0.65)"
          }
        }
      }
    },
    {
      "id": "pine",
      "index": 3,
      "minLevel": 21,
      "maxLevel": 30,
      "label": "Lv.21–30",
      "title": "劲松",
      "imagery": "苍翠黛绿",
      "icon": "pine",
      "surface": "light",
      "regular": {
        "title": "劲松",
        "surface": "light",
        "effect": "none",
        "texture": "pine-grain",
        "light": {
          "bg": "linear-gradient(135deg, #E3F2E9 0%, #B6DAC6 100%)",
          "border": "#4A8B6B",
          "text": "#183D2D",
          "accent": "#2E6F51",
          "glow": "none"
        },
        "dark": {
          "bg": "rgba(74, 139, 107, 0.18)",
          "border": "rgba(104, 179, 142, 0.50)",
          "text": "#B3E8CC",
          "accent": "#7EC8A4",
          "glow": "none"
        }
      },
      "ranks": {
        "1": {
          "rank": 1,
          "stamp": "No.01",
          "title": "凌云古松",
          "tier": "gold",
          "surface": "dark",
          "effect": "pine-goldflow",
          "texture": "rings",
          "light": {
            "bg": "linear-gradient(135deg, #0D251B 0%, #1B4A35 100%)",
            "border": "#E8B949",
            "text": "#ECFDF5",
            "accent": "#F3CA62",
            "glow": "0 2px 12px rgba(232, 185, 73, 0.28)",
            "sweepColor": "rgba(243, 202, 98, 0.38)",
            "pulseColor": "rgba(232, 185, 73, 0.28)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 225deg, #fef3c7 280deg, #e8b949 325deg, transparent 360deg)",
            "fxColor": "rgba(243, 202, 98, 0.85)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #0D251B 0%, #1B4A35 100%)",
            "border": "#F2C964",
            "text": "#ECFDF5",
            "accent": "#F3CA62",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 14px rgba(232, 185, 73, 0.34)",
            "sweepColor": "rgba(243, 202, 98, 0.40)",
            "pulseColor": "rgba(232, 185, 73, 0.34)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 215deg, #ffffff 278deg, #f2c964 325deg, transparent 360deg)",
            "fxColor": "rgba(243, 202, 98, 0.92)"
          }
        },
        "2": {
          "rank": 2,
          "stamp": "No.02",
          "title": "听涛苍柏",
          "tier": "silver",
          "surface": "dark",
          "effect": "silver-sheen",
          "texture": "brushed",
          "light": {
            "bg": "linear-gradient(135deg, #1B4434 0%, #346F54 100%)",
            "border": "#C7DDD2",
            "text": "#EBF7F1",
            "accent": "#D1FAE5",
            "glow": "0 2px 8px rgba(28, 71, 54, 0.24)",
            "sweepColor": "rgba(209, 250, 229, 0.34)",
            "fxColor": "rgba(209, 250, 229, 0.30)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #1B4434 0%, #346F54 100%)",
            "border": "#DCECE4",
            "text": "#EBF7F1",
            "accent": "#D1FAE5",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 10px rgba(0, 0, 0, 0.38)",
            "sweepColor": "rgba(209, 250, 229, 0.36)",
            "fxColor": "rgba(209, 250, 229, 0.36)"
          }
        },
        "3": {
          "rank": 3,
          "stamp": "No.03",
          "title": "青崖翠杉",
          "tier": "bronze",
          "surface": "light",
          "effect": "bronze-breath",
          "texture": "stone",
          "light": {
            "bg": "linear-gradient(135deg, #B3DEC7 0%, #80BF9F 100%)",
            "border": "#B87D52",
            "text": "#123626",
            "accent": "#8F5A34",
            "glow": "none",
            "fxColor": "rgba(214, 152, 102, 0.42)"
          },
          "dark": {
            "bg": "rgba(128, 191, 159, 0.18)",
            "border": "rgba(204, 144, 98, 0.68)",
            "text": "#C2EFD7",
            "accent": "#E0AC84",
            "glow": "none",
            "fxColor": "rgba(224, 172, 132, 0.36)"
          }
        }
      }
    },
    {
      "id": "cloud",
      "index": 4,
      "minLevel": 31,
      "maxLevel": 40,
      "label": "Lv.31–40",
      "title": "流云",
      "imagery": "天青暮霞",
      "icon": "cloud",
      "surface": "light",
      "regular": {
        "title": "流云",
        "surface": "light",
        "effect": "none",
        "texture": "top-sheen",
        "light": {
          "bg": "linear-gradient(135deg, #EEF2FA 0%, #C9D8F2 55%, #E0D8F3 100%)",
          "border": "#7A9AD6",
          "text": "#223A70",
          "accent": "#4A6CB5",
          "glow": "0 0 6px rgba(122, 154, 214, 0.28)"
        },
        "dark": {
          "bg": "rgba(122, 154, 214, 0.18)",
          "border": "rgba(154, 184, 238, 0.50)",
          "text": "#D1E2FF",
          "accent": "#9AB8EE",
          "glow": "0 0 8px rgba(122, 154, 214, 0.18)"
        }
      },
      "ranks": {
        "1": {
          "rank": 1,
          "stamp": "No.01",
          "title": "九天垂云",
          "tier": "gold",
          "surface": "dark",
          "effect": "cloud-aurora",
          "texture": "cloud-mist",
          "light": {
            "bg": "linear-gradient(135deg, #1E2457 0%, #46549E 55%, #8470BA 100%)",
            "border": "#F6C96E",
            "text": "#F8FAFC",
            "accent": "#F8D487",
            "glow": "0 2px 14px rgba(73, 88, 163, 0.36)",
            "sweepColor": "rgba(253, 224, 146, 0.40)",
            "pulseColor": "rgba(139, 120, 214, 0.36)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 200deg, #e0e7ff 255deg, #f6c96e 315deg, transparent 360deg)",
            "fxColor": "rgba(233, 213, 255, 0.34)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #1E2457 0%, #46549E 55%, #8470BA 100%)",
            "border": "#FAD588",
            "text": "#F8FAFC",
            "accent": "#F8D487",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 16px rgba(137, 117, 191, 0.42)",
            "sweepColor": "rgba(253, 224, 146, 0.42)",
            "pulseColor": "rgba(167, 139, 250, 0.40)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 195deg, #ffffff 260deg, #fad588 320deg, transparent 360deg)",
            "fxColor": "rgba(233, 213, 255, 0.38)"
          }
        },
        "2": {
          "rank": 2,
          "stamp": "No.02",
          "title": "归岫闲云",
          "tier": "silver",
          "surface": "dark",
          "effect": "mist-drift",
          "texture": "cloud-mist",
          "light": {
            "bg": "linear-gradient(135deg, #324880 0%, #6180BF 100%)",
            "border": "#E2EAF8",
            "text": "#F1F5FF",
            "accent": "#E0E7FF",
            "glow": "0 2px 10px rgba(52, 75, 133, 0.28)",
            "sweepColor": "rgba(224, 231, 255, 0.32)",
            "fxColor": "rgba(224, 231, 255, 0.30)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #324880 0%, #6180BF 100%)",
            "border": "#EFF4FC",
            "text": "#F1F5FF",
            "accent": "#E0E7FF",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 12px rgba(101, 132, 196, 0.34)",
            "sweepColor": "rgba(224, 231, 255, 0.35)",
            "fxColor": "rgba(224, 231, 255, 0.34)"
          }
        },
        "3": {
          "rank": 3,
          "stamp": "No.03",
          "title": "晴空鹤影",
          "tier": "bronze",
          "surface": "light",
          "effect": "feather-glide",
          "texture": "feather",
          "light": {
            "bg": "linear-gradient(135deg, #C4D7F7 0%, #9BB9EE 100%)",
            "border": "#D48066",
            "text": "#192F60",
            "accent": "#B45C43",
            "glow": "none",
            "fxColor": "rgba(244, 162, 134, 0.45)"
          },
          "dark": {
            "bg": "rgba(155, 185, 238, 0.18)",
            "border": "rgba(224, 144, 118, 0.68)",
            "text": "#D6E6FF",
            "accent": "#F0A892",
            "glow": "none",
            "fxColor": "rgba(240, 168, 146, 0.40)"
          }
        }
      }
    },
    {
      "id": "ocean",
      "index": 5,
      "minLevel": 41,
      "maxLevel": 50,
      "label": "Lv.41–50",
      "title": "沧海",
      "imagery": "沧溟琉璃",
      "icon": "ocean",
      "surface": "dark",
      "regular": {
        "title": "沧海",
        "surface": "dark",
        "effect": "hover-glint",
        "texture": "wave",
        "light": {
          "bg": "linear-gradient(135deg, #142F4D 0%, #275A87 100%)",
          "border": "#6BA8D9",
          "text": "#EAF5FD",
          "accent": "#93C5FD",
          "glow": "0 2px 8px rgba(20, 47, 77, 0.28)"
        },
        "dark": {
          "bg": "linear-gradient(135deg, #142F4D 0%, #275A87 100%)",
          "border": "#84BCE8",
          "text": "#EAF5FD",
          "accent": "#93C5FD",
          "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 10px rgba(39, 90, 135, 0.34)"
        }
      },
      "ranks": {
        "1": {
          "rank": 1,
          "stamp": "No.01",
          "title": "东临沧海",
          "tier": "gold",
          "surface": "dark",
          "effect": "ocean-tide",
          "texture": "wave-gold",
          "light": {
            "bg": "linear-gradient(135deg, #07172C 0%, #113863 52%, #1A6290 100%)",
            "border": "#FFB703",
            "text": "#FFFDF5",
            "accent": "#FFD166",
            "glow": "0 2px 14px rgba(255, 183, 3, 0.30)",
            "sweepColor": "rgba(255, 209, 102, 0.42)",
            "pulseColor": "rgba(255, 183, 3, 0.30)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 200deg, #7dd3fc 255deg, #ffb703 320deg, transparent 360deg)",
            "fxColor": "rgba(255, 209, 102, 0.36)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #07172C 0%, #113863 52%, #1A6290 100%)",
            "border": "#FFC933",
            "text": "#FFFDF5",
            "accent": "#FFD166",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 16px rgba(255, 183, 3, 0.38)",
            "sweepColor": "rgba(255, 209, 102, 0.45)",
            "pulseColor": "rgba(255, 201, 51, 0.36)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 195deg, #bae6fd 255deg, #ffd166 320deg, transparent 360deg)",
            "fxColor": "rgba(255, 209, 102, 0.42)"
          }
        },
        "2": {
          "rank": 2,
          "stamp": "No.02",
          "title": "扶摇巨鲲",
          "tier": "silver",
          "surface": "dark",
          "effect": "current-glide",
          "texture": "wave",
          "light": {
            "bg": "linear-gradient(135deg, #102A4A 0%, #255687 100%)",
            "border": "#D0E4F5",
            "text": "#EDF6FC",
            "accent": "#E0F2FE",
            "glow": "0 2px 10px rgba(16, 42, 74, 0.30)",
            "sweepColor": "rgba(224, 242, 254, 0.36)",
            "fxColor": "rgba(186, 230, 253, 0.32)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #102A4A 0%, #255687 100%)",
            "border": "#E3F0FA",
            "text": "#EDF6FC",
            "accent": "#E0F2FE",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 12px rgba(37, 86, 135, 0.38)",
            "sweepColor": "rgba(224, 242, 254, 0.38)",
            "fxColor": "rgba(186, 230, 253, 0.38)"
          }
        },
        "3": {
          "rank": 3,
          "stamp": "No.03",
          "title": "潮生明月",
          "tier": "bronze",
          "surface": "dark",
          "effect": "moon-tide",
          "texture": "moon-halo",
          "light": {
            "bg": "linear-gradient(135deg, #1C4269 0%, #3C729E 100%)",
            "border": "#D9A066",
            "text": "#F0F7FC",
            "accent": "#F3C794",
            "glow": "0 2px 8px rgba(28, 66, 105, 0.28)",
            "fxColor": "rgba(243, 199, 148, 0.44)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #1C4269 0%, #3C729E 100%)",
            "border": "#E6B480",
            "text": "#F0F7FC",
            "accent": "#F3C794",
            "glow": "0 0 0 1px rgba(255,255,255,0.08), 0 2px 10px rgba(217, 160, 102, 0.28)",
            "fxColor": "rgba(243, 199, 148, 0.48)"
          }
        }
      }
    },
    {
      "id": "galaxy",
      "index": 6,
      "minLevel": 51,
      "maxLevel": null,
      "label": "Lv.51+",
      "title": "星河",
      "imagery": "玄夜星云",
      "icon": "galaxy",
      "surface": "dark",
      "regular": {
        "title": "星河",
        "surface": "dark",
        "effect": "breathe",
        "texture": "stardust",
        "light": {
          "bg": "linear-gradient(135deg, #121026 0%, #292157 55%, #19386B 100%)",
          "border": "linear-gradient(135deg, #A5B4FC 0%, #FDE68A 100%)",
          "text": "#F8FAFC",
          "accent": "#E0E7FF",
          "glow": "0 2px 12px rgba(99, 102, 241, 0.30)",
          "pulseColor": "rgba(165, 180, 252, 0.32)"
        },
        "dark": {
          "bg": "linear-gradient(135deg, #121026 0%, #292157 55%, #19386B 100%)",
          "border": "linear-gradient(135deg, #C7D2FE 0%, #FEF08A 100%)",
          "text": "#F8FAFC",
          "accent": "#E0E7FF",
          "glow": "0 0 0 1px rgba(255,255,255,0.10), 0 2px 14px rgba(129, 140, 248, 0.36)",
          "pulseColor": "rgba(165, 180, 252, 0.38)"
        }
      },
      "ranks": {
        "1": {
          "rank": 1,
          "stamp": "No.01",
          "title": "银河之心",
          "tier": "prismatic",
          "surface": "dark",
          "effect": "galaxy-supernova",
          "texture": "stardust",
          "light": {
            "bg": "linear-gradient(135deg, #09061A 0%, #2B1866 52%, #5A2791 100%)",
            "border": "linear-gradient(120deg, #FDE047 0%, #C084FC 50%, #60A5FA 100%)",
            "text": "#FFFFFF",
            "accent": "#FDE047",
            "glow": "0 3px 18px rgba(168, 85, 247, 0.48)",
            "sweepColor": "rgba(255, 255, 255, 0.44)",
            "pulseColor": "rgba(192, 132, 252, 0.46)",
            "orbitColor": "conic-gradient(from var(--lb-angle), #fde047 0deg, #c084fc 120deg, #60a5fa 240deg, #fde047 360deg)",
            "fxColor": "rgba(253, 224, 71, 0.95)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #09061A 0%, #2B1866 52%, #5A2791 100%)",
            "border": "linear-gradient(120deg, #FEF08A 0%, #D8B4FE 50%, #93C5FD 100%)",
            "text": "#FFFFFF",
            "accent": "#FEF08A",
            "glow": "0 0 0 1px rgba(255,255,255,0.14), 0 3px 20px rgba(192, 132, 252, 0.56)",
            "sweepColor": "rgba(255, 255, 255, 0.48)",
            "pulseColor": "rgba(192, 132, 252, 0.54)",
            "orbitColor": "conic-gradient(from var(--lb-angle), #fef08a 0deg, #d8b4fe 120deg, #93c5fd 240deg, #fef08a 360deg)",
            "fxColor": "rgba(254, 240, 138, 0.98)"
          }
        },
        "2": {
          "rank": 2,
          "stamp": "No.02",
          "title": "北斗天枢",
          "tier": "silver",
          "surface": "dark",
          "effect": "constellation-pulse",
          "texture": "constellation",
          "light": {
            "bg": "linear-gradient(135deg, #0F1130 0%, #242E6E 100%)",
            "border": "linear-gradient(135deg, #E0E7FF 0%, #94A3B8 100%)",
            "text": "#F8FAFC",
            "accent": "#E0E7FF",
            "glow": "0 2px 12px rgba(148, 163, 184, 0.34)",
            "sweepColor": "rgba(224, 231, 255, 0.36)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 240deg, #e0e7ff 310deg, transparent 360deg)",
            "fxColor": "rgba(224, 231, 255, 0.92)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #0F1130 0%, #242E6E 100%)",
            "border": "linear-gradient(135deg, #EEF2FF 0%, #CBD5E1 100%)",
            "text": "#F8FAFC",
            "accent": "#E0E7FF",
            "glow": "0 0 0 1px rgba(255,255,255,0.10), 0 2px 14px rgba(199, 210, 254, 0.38)",
            "sweepColor": "rgba(224, 231, 255, 0.40)",
            "orbitColor": "conic-gradient(from var(--lb-angle), transparent 0deg, transparent 230deg, #ffffff 310deg, transparent 360deg)",
            "fxColor": "rgba(238, 242, 255, 0.95)"
          }
        },
        "3": {
          "rank": 3,
          "stamp": "No.03",
          "title": "织梦星轨",
          "tier": "bronze",
          "surface": "dark",
          "effect": "orbit-shimmer",
          "texture": "orbit",
          "light": {
            "bg": "linear-gradient(135deg, #1C1947 0%, #403585 100%)",
            "border": "linear-gradient(135deg, #E5A48B 0%, #F4C7B2 100%)",
            "text": "#FDF4F0",
            "accent": "#F4C7B2",
            "glow": "0 2px 10px rgba(229, 164, 139, 0.28)",
            "fxColor": "rgba(244, 199, 178, 0.72)"
          },
          "dark": {
            "bg": "linear-gradient(135deg, #1C1947 0%, #403585 100%)",
            "border": "linear-gradient(135deg, #F0B69F 0%, #F8D8C8 100%)",
            "text": "#FDF4F0",
            "accent": "#F4C7B2",
            "glow": "0 0 0 1px rgba(255,255,255,0.10), 0 2px 12px rgba(244, 199, 178, 0.34)",
            "fxColor": "rgba(248, 216, 200, 0.80)"
          }
        }
      }
    }
  ]
};
