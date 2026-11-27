import { useId, type ReactNode } from "react";
import {
  ACC_COLORS,
  BG_THEMES,
  BROW_STYLES,
  decodeCustomAvatar,
  EYE_COLORS,
  EYE_STYLES,
  EYEWEAR_OPTIONS,
  FACIAL_HAIR_STYLES,
  HAIR_COLORS,
  HAIR_STYLES,
  HEADWEAR_OPTIONS,
  HIJAB_COLORS,
  MOUTH_STYLES,
  OUTFIT_COLORS,
  OUTFIT_STYLES,
  SKIN_TONES,
  type CustomAvatarRecipe,
} from "./customAvatarSchema";

function BackHairLayer({
  styleId,
  color,
  accent,
}: {
  styleId: string;
  color: string;
  accent: string;
}): ReactNode {
  switch (styleId) {
    case "space-buns":
      return (
        <g>
          <circle cx="15" cy="20" r="8" fill={color} />
          <circle cx="49" cy="20" r="8" fill={color} />
          <circle cx="15" cy="20" r="2.8" fill={accent} />
          <circle cx="49" cy="20" r="2.8" fill={accent} />
        </g>
      );
    case "long-wave":
      return (
        <path
          d="M12.5 30 C12.5 14 21.5 11.5 32 11.5 C42.5 11.5 51.5 14 51.5 30 L52.5 62 L11.5 62 Z"
          fill={color}
        />
      );
    case "bob":
      return (
        <path
          d="M14 35 C13 17 21 12 32 12 C43 12 51 17 50 35 C51 43 47 49 43 50 L21 50 C17 49 13 43 14 35 Z"
          fill={color}
        />
      );
    case "ponytail":
      return (
        <g>
          <path d="M35 14 C47 10 55 18 52.5 34 C49.5 28 44 25 39 24 Z" fill={color} />
          <circle cx="38" cy="16.5" r="3.2" fill={accent} />
        </g>
      );
    case "braids":
      return (
        <g>
          <circle cx="15.5" cy="43" r="4.8" fill={color} />
          <circle cx="14.5" cy="51" r="4.3" fill={color} />
          <circle cx="14.2" cy="57.5" r="3.2" fill={accent} />
          <circle cx="48.5" cy="43" r="4.8" fill={color} />
          <circle cx="49.5" cy="51" r="4.3" fill={color} />
          <circle cx="49.8" cy="57.5" r="3.2" fill={accent} />
        </g>
      );
    case "half-up":
      return (
        <g>
          <path d="M13.5 32 C13.5 14 22 12 32 12 C42 12 50.5 14 50.5 32 L51 56 L13 56 Z" fill={color} />
          <circle cx="32" cy="13.5" r="5" fill={color} />
        </g>
      );
    case "long-curly":
      return (
        <g>
          <circle cx="16" cy="28" r="7" fill={color} />
          <circle cx="48" cy="28" r="7" fill={color} />
          <circle cx="14.5" cy="39" r="7" fill={color} />
          <circle cx="49.5" cy="39" r="7" fill={color} />
          <circle cx="15.5" cy="50" r="6.5" fill={color} />
          <circle cx="48.5" cy="50" r="6.5" fill={color} />
          <path d="M15 26 C16 14 23 12 32 12 C41 12 48 14 49 26 L49 58 L15 58 Z" fill={color} />
        </g>
      );
    case "straight-long":
      return (
        <path
          d="M14 29 C14 14 22 12 32 12 C42 12 50 14 50 29 L50.5 64 L13.5 64 Z"
          fill={color}
        />
      );
    case "curly":
      return (
        <g>
          <circle cx="22" cy="18" r="6" fill={color} />
          <circle cx="32" cy="15" r="6.8" fill={color} />
          <circle cx="42" cy="18" r="6" fill={color} />
          <circle cx="17" cy="24" r="5" fill={color} />
          <circle cx="47" cy="24" r="5" fill={color} />
        </g>
      );
    case "hijab-classic":
    case "hijab-modern":
    case "hijab-sport":
    case "hijab-pleated":
      return (
        <path
          d="M12.5 34 C12.5 14.5 21 11 32 11 C43 11 51.5 14.5 51.5 34 C51.5 44 48 51 44 54 L20 54 C16 51 12.5 44 12.5 34 Z"
          fill={accent}
        />
      );
    default:
      return null;
  }
}

function OutfitLayer({
  styleId,
  color,
  accent,
}: {
  styleId: string;
  color: string;
  accent: string;
}): ReactNode {
  const baseBody = (
    <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill={color} />
  );

  switch (styleId) {
    case "hoodie":
      return (
        <g>
          {baseBody}
          <path d="M24 46 Q32 52 40 46" fill="none" stroke={accent} strokeWidth="2.1" strokeLinecap="round" />
          <line x1="27.5" y1="49" x2="27.5" y2="57.5" stroke={accent} strokeWidth="1.7" strokeLinecap="round" />
          <line x1="36.5" y1="49" x2="36.5" y2="57.5" stroke={accent} strokeWidth="1.7" strokeLinecap="round" />
        </g>
      );
    case "varsity":
      return (
        <g>
          {baseBody}
          <path d="M25 46 L32 58 L39 46 Z" fill={accent} />
          <line x1="32" y1="56" x2="32" y2="64" stroke={accent} strokeWidth="1.8" />
        </g>
      );
    case "sweater":
      return (
        <g>
          {baseBody}
          <path d="M24 46 Q32 50.5 40 46" fill="none" stroke={accent} strokeWidth="2.5" strokeLinecap="round" opacity="0.8" />
        </g>
      );
    case "scarf":
      return (
        <g>
          {baseBody}
          <rect x="20" y="45.5" width="24" height="6.8" rx="3.4" fill={accent} />
          <rect x="35" y="49" width="6.5" height="12" rx="2.5" fill={accent} opacity="0.92" />
        </g>
      );
    case "preppy":
      return (
        <g>
          {baseBody}
          <path d="M25 46 L32 54 L39 46 Z" fill={accent} />
          <path d="M25 46 L29 51.5 L32 49.5 L35 51.5 L39 46" fill="none" stroke="#FFFFFF" strokeWidth="1.5" strokeLinejoin="round" opacity="0.7" />
        </g>
      );
    case "tech-zip":
      return (
        <g>
          {baseBody}
          <path d="M22 47 L28 64 M42 47 L36 64" stroke={accent} strokeWidth="2.1" opacity="0.7" />
          <line x1="32" y1="47" x2="32" y2="64" stroke={accent} strokeWidth="1.6" />
        </g>
      );
    case "tee":
      return (
        <g>
          {baseBody}
          <path d="M26 45.5 Q32 50 38 45.5" fill="none" stroke={accent} strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="32" cy="56" r="3" fill={accent} opacity="0.85" />
        </g>
      );
    case "cardigan":
      return (
        <g>
          {baseBody}
          <path d="M25 46 L32 64 L39 46 Z" fill={accent} />
          <circle cx="32" cy="57" r="1.1" fill={color} />
          <circle cx="32" cy="61.5" r="1.1" fill={color} />
        </g>
      );
    case "streetwear":
      return (
        <g>
          <path d="M10.5 64 C11.5 48.5 21 44.5 32 44.5 C43 44.5 52.5 48.5 53.5 64 Z" fill={color} />
          <path d="M23 46 L32 53 L41 46" fill="none" stroke={accent} strokeWidth="2.1" strokeLinecap="round" />
          <rect x="27" y="54.5" width="10" height="4" rx="2" fill={accent} opacity="0.85" />
        </g>
      );
    case "vest":
      return (
        <g>
          {baseBody}
          <path d="M26 46 L32 64 L38 46 Z" fill="#F8FAFC" opacity="0.9" />
          <path d="M23 47 L26 64 M41 47 L38 64" stroke={accent} strokeWidth="1.8" opacity="0.65" />
        </g>
      );
    case "astro":
      return (
        <g>
          <path d="M13 64 C14 50 22 46 32 46 C42 46 50 50 51 64 Z" fill="#E2E8F0" />
          <rect x="26" y="51.5" width="12" height="5.5" rx="2.7" fill={color} />
          <path d="M23 46.5 Q32 51 41 46.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
        </g>
      );
    case "turtleneck":
    default:
      return (
        <g>
          {baseBody}
          <rect x="24.5" y="43.5" width="15" height="6.5" rx="3" fill={color} />
          <line x1="25.5" y1="47" x2="38.5" y2="47" stroke={accent} strokeWidth="1.2" opacity="0.45" />
        </g>
      );
  }
}

function HijabChestDrape({
  styleId,
  color,
  accent,
}: {
  styleId: string;
  color: string;
  accent: string;
}): ReactNode {
  if (styleId === "hijab-sport") {
    return (
      <g>
        <path
          d="M17.5 39 C17.5 47 23.5 52 32 52 C40.5 52 46.5 47 46.5 39 L44.5 49 C40 53 24 53 19.5 49 Z"
          fill={color}
        />
        <path d="M21 47 Q32 52.5 43 47" fill="none" stroke={accent} strokeWidth="1.4" opacity="0.65" />
      </g>
    );
  }

  return (
    <g>
      <path
        d="M15.5 38 C15 49 22 55.5 32 55.5 C42 55.5 49 49 48.5 38 L47 47 C43.5 53.5 20.5 53.5 17 47 Z"
        fill={color}
      />
      <path
        d="M19.5 46.5 Q32 53.5 44.5 46.5"
        fill="none"
        stroke={accent}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />
    </g>
  );
}

function FacialHairLayer({
  styleId,
  hairColor,
}: {
  styleId: string;
  hairColor: string;
}): ReactNode {
  if (styleId === "none") return null;

  switch (styleId) {
    case "stubble":
      return (
        <path
          d="M22.5 39.5 C23.5 45.8 27.5 47.6 32 47.6 C36.5 47.6 40.5 45.8 41.5 39.5 C39.5 44 36 45.6 32 45.6 C28 45.6 24.5 44 22.5 39.5 Z"
          fill={hairColor}
          opacity="0.22"
        />
      );
    case "mustache":
      return (
        <path
          d="M27.2 39.2 Q29.6 37.5 32 39 Q34.4 37.5 36.8 39.2"
          fill="none"
          stroke={hairColor}
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      );
    case "goatee":
      return (
        <g>
          <path
            d="M28 39 Q30 37.8 32 38.8 Q34 37.8 36 39"
            fill="none"
            stroke={hairColor}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M28.2 44.4 Q32 47.6 35.8 44.4 Q32 45.8 28.2 44.4 Z"
            fill={hairColor}
            opacity="0.88"
          />
        </g>
      );
    case "boxed-beard":
      return (
        <path
          d="M19.8 36.2 C20.4 44.2 25.6 47.4 32 47.4 C38.4 47.4 43.6 44.2 44.2 36.2 C42.4 41.6 37.8 44.2 32 44.2 C26.2 44.2 21.6 41.6 19.8 36.2 Z"
          fill={hairColor}
          opacity="0.86"
        />
      );
    case "chin-tuft":
      return (
        <path
          d="M29.8 44.8 Q32 47.2 34.2 44.8 Q32 45.6 29.8 44.8 Z"
          fill={hairColor}
          opacity="0.85"
        />
      );
    default:
      return null;
  }
}

function MouthAndBlushLayer({
  styleId,
  mouthStroke,
}: {
  styleId: string;
  mouthStroke: string;
}): ReactNode {
  const hasBlush = styleId.endsWith("-blush");
  const baseMouth = styleId.replace("-blush", "");

  return (
    <g>
      {hasBlush && (
        <g opacity="0.45">
          <ellipse cx="21.5" cy="37.8" rx="3.1" ry="1.8" fill="#FB7185" />
          <ellipse cx="42.5" cy="37.8" rx="3.1" ry="1.8" fill="#FB7185" />
        </g>
      )}
      {baseMouth === "smile" && (
        <path
          d="M29 40.5 Q32 43.1 35 40.5"
          fill="none"
          stroke={mouthStroke}
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      )}
      {baseMouth === "grin" && (
        <g>
          <path d="M27.6 39.8 Q32 44.3 36.4 39.8 Z" fill="#FFFFFF" />
          <path
            d="M27.6 39.8 Q32 44.3 36.4 39.8"
            fill="none"
            stroke={mouthStroke}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      )}
      {baseMouth === "cat" && (
        <path
          d="M28.2 40.4 Q30.1 42.6 32 40.4 Q33.9 42.6 35.8 40.4"
          fill="none"
          stroke={mouthStroke}
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      )}
      {baseMouth === "smirk" && (
        <path
          d="M29.2 41 Q32.8 42.6 36.2 39.6"
          fill="none"
          stroke={mouthStroke}
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      )}
      {baseMouth === "o" && (
        <ellipse
          cx="32"
          cy="41.2"
          rx="1.9"
          ry="2.2"
          fill="#F43F5E"
          fillOpacity="0.35"
          stroke={mouthStroke}
          strokeWidth="1.6"
        />
      )}
      {baseMouth === "calm" && (
        <path
          d="M29.6 40.8 Q32 42 34.4 40.8"
          fill="none"
          stroke={mouthStroke}
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
      {baseMouth === "playful" && (
        <g>
          <path
            d="M28.5 40.2 Q32 43.4 35.5 40.2"
            fill="none"
            stroke={mouthStroke}
            strokeWidth="1.85"
            strokeLinecap="round"
          />
          <path d="M30.5 41.7 Q32 44.2 33.5 41.7 Z" fill="#FB7185" />
        </g>
      )}
      {baseMouth === "pout" && (
        <path
          d="M30 41.6 Q32 40.4 34 41.6"
          fill="none"
          stroke={mouthStroke}
          strokeWidth="1.85"
          strokeLinecap="round"
        />
      )}
      {baseMouth === "cheerful" && (
        <path
          d="M28 39.8 Q32 43.8 36 39.8"
          fill="none"
          stroke={mouthStroke}
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
      {baseMouth === "neutral" && (
        <line
          x1="29.5"
          y1="41"
          x2="34.5"
          y2="41"
          stroke={mouthStroke}
          strokeWidth="1.85"
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

function EyesAndBrowsLayer({
  eyeStyleId,
  eyeColor,
  browStyleId,
  browColor,
  isGirl,
}: {
  eyeStyleId: string;
  eyeColor: string;
  browStyleId: string;
  browColor: string;
  isGirl: boolean;
}): ReactNode {
  const y = 33.8;

  const renderStandardEye = (cx: number, r = 3.25) => (
    <g>
      <circle cx={cx} cy={y} r={r} fill={eyeColor} />
      <circle cx={cx + 1.05} cy={y - 1.05} r={1.15} fill="#FFFFFF" />
      <circle cx={cx - 0.95} cy={y + 1.05} r={0.58} fill="#FFFFFF" opacity="0.72" />
    </g>
  );

  const renderEyes = () => {
    switch (eyeStyleId) {
      case "wink":
        return (
          <g>
            {renderStandardEye(25.2)}
            <path
              d={`M35.5 ${y + 0.5} Q38.8 ${y - 2.6} 42 ${y + 0.5}`}
              fill="none"
              stroke={eyeColor}
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </g>
        );
      case "lashes":
        return (
          <g>
            {renderStandardEye(25.2)}
            {renderStandardEye(38.8)}
            <path d={`M21.8 ${y - 2} L20.2 ${y - 3.3}`} stroke={eyeColor} strokeWidth="1.5" strokeLinecap="round" />
            <path d={`M42.2 ${y - 2} L43.8 ${y - 3.3}`} stroke={eyeColor} strokeWidth="1.5" strokeLinecap="round" />
          </g>
        );
      case "calm":
        return (
          <g>
            {renderStandardEye(25.2, 3.0)}
            {renderStandardEye(38.8, 3.0)}
            <path d={`M21.5 ${y - 1.4} Q25.2 ${y - 2.8} 28.9 ${y - 1.4}`} fill="none" stroke={eyeColor} strokeWidth="1.7" strokeLinecap="round" />
            <path d={`M35.1 ${y - 1.4} Q38.8 ${y - 2.8} 42.5 ${y - 1.4}`} fill="none" stroke={eyeColor} strokeWidth="1.7" strokeLinecap="round" />
          </g>
        );
      case "happy-arcs":
        return (
          <g>
            <path d={`M22 ${y + 0.8} Q25.2 ${y - 2.8} 28.4 ${y + 0.8}`} fill="none" stroke={eyeColor} strokeWidth="2.2" strokeLinecap="round" />
            <path d={`M35.6 ${y + 0.8} Q38.8 ${y - 2.8} 42 ${y + 0.8}`} fill="none" stroke={eyeColor} strokeWidth="2.2" strokeLinecap="round" />
          </g>
        );
      case "starry":
        return (
          <g>
            <circle cx={25.2} cy={y} r={3.45} fill={eyeColor} />
            <circle cx={38.8} cy={y} r={3.45} fill={eyeColor} />
            <circle cx={26.3} cy={y - 1.1} r={1.25} fill="#FFFFFF" />
            <circle cx={39.9} cy={y - 1.1} r={1.25} fill="#FFFFFF" />
            <circle cx={24.4} cy={y + 1.2} r={0.8} fill="#FDE047" />
            <circle cx={38.0} cy={y + 1.2} r={0.8} fill="#FDE047" />
          </g>
        );
      case "confident":
        return (
          <g>
            <ellipse cx={25.2} cy={y + 0.3} rx={3.1} ry={2.6} fill={eyeColor} />
            <ellipse cx={38.8} cy={y + 0.3} rx={3.1} ry={2.6} fill={eyeColor} />
            <circle cx={26.2} cy={y - 0.6} r={1.0} fill="#FFFFFF" />
            <circle cx={39.8} cy={y - 0.6} r={1.0} fill="#FFFFFF" />
          </g>
        );
      case "cat":
        return (
          <g>
            <ellipse cx={25.2} cy={y} rx={3.2} ry={3.35} fill={eyeColor} />
            <ellipse cx={38.8} cy={y} rx={3.2} ry={3.35} fill={eyeColor} />
            <circle cx={26.1} cy={y - 1.1} r={1.15} fill="#FFFFFF" />
            <circle cx={39.7} cy={y - 1.1} r={1.15} fill="#FFFFFF" />
            <path d={`M21.8 ${y - 1.2} L20.5 ${y - 2.6}`} stroke={eyeColor} strokeWidth="1.4" strokeLinecap="round" />
            <path d={`M42.2 ${y - 1.2} L43.5 ${y - 2.6}`} stroke={eyeColor} strokeWidth="1.4" strokeLinecap="round" />
          </g>
        );
      case "focused":
        return (
          <g>
            {renderStandardEye(25.2, 2.95)}
            {renderStandardEye(38.8, 2.95)}
          </g>
        );
      case "cozy":
        return (
          <g>
            <path d={`M22 ${y - 0.4} Q25.2 ${y + 2.4} 28.4 ${y - 0.4}`} fill="none" stroke={eyeColor} strokeWidth="2.1" strokeLinecap="round" />
            <path d={`M35.6 ${y - 0.4} Q38.8 ${y + 2.4} 42 ${y - 0.4}`} fill="none" stroke={eyeColor} strokeWidth="2.1" strokeLinecap="round" />
          </g>
        );
      case "sparkle":
      default:
        return (
          <g>
            {renderStandardEye(25.2, isGirl ? 3.35 : 3.2)}
            {renderStandardEye(38.8, isGirl ? 3.35 : 3.2)}
            {isGirl && (
              <>
                <path d={`M22.1 ${y - 1.9} L20.9 ${y - 2.8}`} stroke={eyeColor} strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
                <path d={`M41.9 ${y - 1.9} L43.1 ${y - 2.8}`} stroke={eyeColor} strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
              </>
            )}
          </g>
        );
    }
  };

  const renderBrows = () => {
    if (browStyleId === "none") return null;
    const by = 28.4;
    switch (browStyleId) {
      case "arched":
        return (
          <g fill="none" stroke={browColor} strokeWidth="1.45" strokeLinecap="round">
            <path d={`M22.2 ${by + 0.4} Q25.2 ${by - 1.3} 28.2 ${by + 0.2}`} />
            <path d={`M35.8 ${by + 0.2} Q38.8 ${by - 1.3} 41.8 ${by + 0.4}`} />
          </g>
        );
      case "straight":
        return (
          <g fill="none" stroke={browColor} strokeWidth="1.6" strokeLinecap="round">
            <line x1="22.2" y1={by} x2="28.2" y2={by + 0.3} />
            <line x1="35.8" y1={by + 0.3} x2="41.8" y2={by} />
          </g>
        );
      case "thick":
        return (
          <g fill="none" stroke={browColor} strokeWidth="2.1" strokeLinecap="round">
            <path d={`M22 ${by + 0.3} Q25.2 ${by - 0.8} 28.3 ${by + 0.2}`} />
            <path d={`M35.7 ${by + 0.2} Q38.8 ${by - 0.8} 42 ${by + 0.3}`} />
          </g>
        );
      case "gentle":
        return (
          <g fill="none" stroke={browColor} strokeWidth="1.35" strokeLinecap="round" opacity="0.88">
            <path d={`M22.5 ${by + 0.5} Q25.2 ${by - 0.6} 28 ${by - 0.2}`} />
            <path d={`M36 ${by - 0.2} Q38.8 ${by - 0.6} 41.5 ${by + 0.5}`} />
          </g>
        );
      case "soft":
      default:
        return (
          <g fill="none" stroke={browColor} strokeWidth="1.5" strokeLinecap="round">
            <path d={`M22.3 ${by + 0.2} Q25.2 ${by - 0.9} 28.1 ${by + 0.2}`} />
            <path d={`M35.9 ${by + 0.2} Q38.8 ${by - 0.9} 41.7 ${by + 0.2}`} />
          </g>
        );
    }
  };

  return (
    <g>
      {renderEyes()}
      {renderBrows()}
    </g>
  );
}

function FrontHairOrHijabLayer({
  styleId,
  color,
  accent,
}: {
  styleId: string;
  color: string;
  accent: string;
}): ReactNode {
  switch (styleId) {
    // ── HIJAB FACE FRAMES ────────────────────────────────────────────────────
    case "hijab-classic":
      return (
        <g>
          <path
            d="M15.5 34 C15.5 16.5 23 13 32 13 C41 13 48.5 16.5 48.5 34 C47 24.5 41 20.5 32 20.5 C23 20.5 17 24.5 15.5 34 Z"
            fill={color}
          />
          {/* Smooth cheek wrap */}
          <path
            d="M15.5 32 C15.5 42 20.5 48.5 27.5 50 L23 47 C18.5 43.5 17.5 38 17.5 32 Z"
            fill={color}
          />
          <path
            d="M48.5 32 C48.5 42 43.5 48.5 36.5 50 L41 47 C45.5 43.5 46.5 38 46.5 32 Z"
            fill={color}
          />
          <path
            d="M18 28 C21 21 26.5 19.5 32 19.5 C37.5 19.5 43 21 46 28"
            fill="none"
            stroke={accent}
            strokeWidth="1.2"
            opacity="0.55"
          />
        </g>
      );
    case "hijab-modern":
      return (
        <g>
          {/* Undercap peek */}
          <path
            d="M17 31 C18 19 24.5 16 32 16 C39.5 16 46 19 47 31 C43 24 38 22 32 22 C26 22 21 24 17 31 Z"
            fill={accent}
          />
          {/* Layered asymmetric drape */}
          <path
            d="M15 34 C15.5 16 23.5 12.5 33 12.5 C42 12.5 49 16.5 49 34 C46.5 24 39 20.5 30 22.5 C22 24.2 17.5 27 15 34 Z"
            fill={color}
          />
          <path
            d="M15.5 32 C15.5 42.5 21 48.5 28 50.5 L23 47 C18.8 43.5 17.5 38 17.5 32 Z"
            fill={color}
          />
          <path
            d="M48.5 32 C48.5 42.5 43 48.5 36 50.5 L41 47 C45.2 43.5 46.5 38 46.5 32 Z"
            fill={color}
          />
          <path d="M23 19.5 Q34 17 44 23" fill="none" stroke={accent} strokeWidth="1.25" opacity="0.55" />
        </g>
      );
    case "hijab-sport":
      return (
        <g>
          <path
            d="M16 34 C16 17 23 13.5 32 13.5 C41 13.5 48 17 48 34 C46.5 24 41 20 32 20 C23 20 17.5 24 16 34 Z"
            fill={color}
          />
          <path
            d="M16 31 C16 41 20 46.5 27 49 L23.5 45.5 C19.5 42 18 37 18 31 Z"
            fill={color}
          />
          <path
            d="M48 31 C48 41 44 46.5 37 49 L40.5 45.5 C44.5 42 46 37 46 31 Z"
            fill={color}
          />
          <path
            d="M21 20.5 Q32 18.5 43 20.5"
            fill="none"
            stroke={accent}
            strokeWidth="1.35"
            strokeLinecap="round"
            opacity="0.7"
          />
        </g>
      );
    case "hijab-pleated":
      return (
        <g>
          <path
            d="M15.5 34 C15.5 16.5 23 13 32 13 C41 13 48.5 16.5 48.5 34 C47 24.5 41 20.5 32 20.5 C23 20.5 17 24.5 15.5 34 Z"
            fill={color}
          />
          <path
            d="M15.5 32 C15.5 42 20.5 48.5 27.5 50 L23 47 C18.5 43.5 17.5 38 17.5 32 Z"
            fill={color}
          />
          <path
            d="M48.5 32 C48.5 42 43.5 48.5 36.5 50 L41 47 C45.5 43.5 46.5 38 46.5 32 Z"
            fill={color}
          />
          {/* Pleat lines & pearl pin */}
          <path d="M18.5 24 Q24 18.5 32 18.5" fill="none" stroke={accent} strokeWidth="1.15" opacity="0.6" />
          <path d="M45.5 24 Q40 18.5 32 18.5" fill="none" stroke={accent} strokeWidth="1.15" opacity="0.6" />
          <circle cx="44" cy="39" r="1.45" fill="#FDE68A" />
        </g>
      );

    // ── SHORT / BOY HAIR ─────────────────────────────────────────────────────
    case "fade":
      return (
        <path
          d="M17 29 C17.5 17 24.5 14 32 14 C39.5 14 46.5 17 47 29 C42 23 36.5 21.5 32 21.5 C27.5 21.5 22 23 17 29 Z"
          fill={color}
        />
      );
    case "spiky":
      return (
        <path
          d="M17 29 C17 17 25 14 33 14 C41 14 47 18 47 29 L43 24 L37 26 L32 21 L26 26 L21 23 Z"
          fill={color}
        />
      );
    case "curly":
      return (
        <path
          d="M18 26 Q23.5 21 28 24 Q33 20 38 24 Q42.5 21 46 26 C44 17.5 20 17.5 18 26 Z"
          fill={color}
        />
      );
    case "swept":
      return (
        <path
          d="M17 30 L24 22.5 L31 26.5 L38 21.5 L47 29 C45.5 17 18.5 17 17 30 Z"
          fill={color}
        />
      );
    case "parted":
      return (
        <path
          d="M17 30 C17 17 24 14 32 14 C40 14 47 17 47 30 C43 23 37 21 34 25 C31 20 22 22 17 30 Z"
          fill={color}
        />
      );
    case "buzz":
      return (
        <path
          d="M17.5 27.5 C18 17.5 24.5 14.5 32 14.5 C39.5 14.5 46 17.5 46.5 27.5 C42 22 37 20.5 32 20.5 C27 20.5 22 22 17.5 27.5 Z"
          fill={color}
        />
      );
    case "wavy-short":
      return (
        <path
          d="M17 29.5 C17.5 17 24 14 32 14 C40 14 46.5 17 47 29.5 C43.5 25 39 24.5 35.5 26.5 C31.5 22.5 26 26.5 22.5 25 C20 26 18.5 27.5 17 29.5 Z"
          fill={color}
        />
      );
    case "undercut":
      return (
        <path
          d="M17.5 28.5 C18 16.5 24.5 13 33 13 C41.5 13 46.5 17 46.5 28.5 C41.5 21 34 20 27 23.5 C22.5 22.5 19.5 25 17.5 28.5 Z"
          fill={color}
        />
      );

    // ── LONG / GIRL HAIR ─────────────────────────────────────────────────────
    case "space-buns":
      return (
        <path
          d="M16.5 30 C17.5 17 24.5 14.5 32 14.5 C39.5 14.5 46.5 17 47.5 30 C43.5 23 39 22 33 26 C29 22 21 23 16.5 30 Z"
          fill={color}
        />
      );
    case "long-wave":
    case "half-up":
      return (
        <path
          d="M17 31 C18 18.5 25 15.5 32 15.5 C39 15.5 46 18.5 47 31 C42 24.5 36 22.5 32 26.5 C27 22.5 22 24.5 17 31 Z"
          fill={color}
        />
      );
    case "bob":
      return (
        <path
          d="M17.5 30 C18.5 18 25.5 15.5 32 15.5 C38.5 15.5 45.5 18 46.5 30 C41.5 24.5 35.5 22.5 32 24.8 C28 22 22 24 17.5 30 Z"
          fill={color}
        />
      );
    case "ponytail":
      return (
        <path
          d="M17 31 C17.5 18 24 14.5 32 14.5 C40 14.5 46.5 18 47 31 C42 22 36 21 31 24.5 C25 21.5 20 24 17 31 Z"
          fill={color}
        />
      );
    case "braids":
      return (
        <path
          d="M17 31 C18 18.5 25 15.5 32 15.5 C39 15.5 46 18.5 47 31 C42 23 36 22 32 25 C27 22 22 23.5 17 31 Z"
          fill={color}
        />
      );
    case "long-curly":
      return (
        <path
          d="M17 30 C18 18 24.5 15 32 15 C39.5 15 46 18 47 30 Q42.5 24 38 26 Q32 22 26 26 Q21.5 24 17 30 Z"
          fill={color}
        />
      );
    case "straight-long":
    default:
      return (
        <path
          d="M17 31 C17.5 17.5 24.5 15 32 15 C39.5 15 46.5 17.5 47 31 C42.5 23.5 37 22 32 22 C27 22 21.5 23.5 17 31 Z"
          fill={color}
        />
      );
  }
}

function EyewearLayer({
  eyewearId,
  frameColor,
  gradId,
}: {
  eyewearId: string;
  frameColor: string;
  gradId: string;
}): ReactNode {
  if (eyewearId === "none") return null;

  const y = 33.8;

  switch (eyewearId) {
    // ── PRESCRIPTION / OPTICAL ───────────────────────────────────────────────
    case "rx-round":
      return (
        <g>
          <circle cx="25.2" cy={y} r="5.3" fill="#FFFFFF" fillOpacity="0.08" stroke={frameColor} strokeWidth="1.7" />
          <circle cx="38.8" cy={y} r="5.3" fill="#FFFFFF" fillOpacity="0.08" stroke={frameColor} strokeWidth="1.7" />
          <line x1="30.5" y1={y} x2="33.5" y2={y} stroke={frameColor} strokeWidth="1.6" />
          <line x1="22.4" y1={y - 2.6} x2="24.4" y2={y - 0.6} stroke="#FFFFFF" strokeWidth="1.1" strokeLinecap="round" opacity="0.28" />
          <line x1="36.0" y1={y - 2.6} x2="38.0" y2={y - 0.6} stroke="#FFFFFF" strokeWidth="1.1" strokeLinecap="round" opacity="0.28" />
        </g>
      );
    case "rx-rect":
      return (
        <g>
          <rect x="19.6" y={y - 4.1} width="10.6" height="8.0" rx="2.4" fill="#FFFFFF" fillOpacity="0.08" stroke={frameColor} strokeWidth="1.75" />
          <rect x="33.8" y={y - 4.1} width="10.6" height="8.0" rx="2.4" fill="#FFFFFF" fillOpacity="0.08" stroke={frameColor} strokeWidth="1.75" />
          <line x1="30.2" y1={y - 0.4} x2="33.8" y2={y - 0.4} stroke={frameColor} strokeWidth="1.7" />
          <line x1="21.5" y1={y - 2.4} x2="23.4" y2={y - 0.5} stroke="#FFFFFF" strokeWidth="1.1" strokeLinecap="round" opacity="0.26" />
          <line x1="35.7" y1={y - 2.4} x2="37.6" y2={y - 0.5} stroke="#FFFFFF" strokeWidth="1.1" strokeLinecap="round" opacity="0.26" />
        </g>
      );
    case "rx-browline":
      return (
        <g>
          <path d={`M19.8 ${y - 1.5} C19.8 ${y + 3.6} 22.2 ${y + 4.3} 25.2 ${y + 4.3} C28.2 ${y + 4.3} 30.2 ${y + 3.2} 30.2 ${y - 1.5}`} fill="#FFFFFF" fillOpacity="0.07" stroke={frameColor} strokeWidth="1.1" />
          <path d={`M33.8 ${y - 1.5} C33.8 ${y + 3.2} 35.8 ${y + 4.3} 38.8 ${y + 4.3} C41.8 ${y + 4.3} 44.2 ${y + 3.6} 44.2 ${y - 1.5}`} fill="#FFFFFF" fillOpacity="0.07" stroke={frameColor} strokeWidth="1.1" />
          <path d={`M19.2 ${y - 2.3} Q25 ${y - 4.3} 30.4 ${y - 2.1}`} fill="none" stroke={frameColor} strokeWidth="2.3" strokeLinecap="round" />
          <path d={`M33.6 ${y - 2.1} Q39 ${y - 4.3} 44.8 ${y - 2.3}`} fill="none" stroke={frameColor} strokeWidth="2.3" strokeLinecap="round" />
          <line x1="30.2" y1={y - 1.5} x2="33.8" y2={y - 1.5} stroke={frameColor} strokeWidth="1.5" />
        </g>
      );
    case "rx-cat-eye":
      return (
        <g>
          <path
            d={`M18.6 ${y - 3.6} L29.8 ${y - 2.2} C30.4 ${y + 2.4} 28 ${y + 4.2} 24.8 ${y + 4.2} C21.2 ${y + 4.2} 19.2 ${y + 1.8} 18.6 ${y - 3.6} Z`}
            fill="#FFFFFF"
            fillOpacity="0.08"
            stroke={frameColor}
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d={`M45.4 ${y - 3.6} L34.2 ${y - 2.2} C33.6 ${y + 2.4} 36 ${y + 4.2} 39.2 ${y + 4.2} C42.8 ${y + 4.2} 44.8 ${y + 1.8} 45.4 ${y - 3.6} Z`}
            fill="#FFFFFF"
            fillOpacity="0.08"
            stroke={frameColor}
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <line x1="29.9" y1={y - 1.2} x2="34.1" y2={y - 1.2} stroke={frameColor} strokeWidth="1.6" />
        </g>
      );
    case "rx-oversized":
      return (
        <g>
          <circle cx="24.8" cy={y + 0.3} r="6.1" fill="#FFFFFF" fillOpacity="0.08" stroke={frameColor} strokeWidth="1.45" />
          <circle cx="39.2" cy={y + 0.3} r="6.1" fill="#FFFFFF" fillOpacity="0.08" stroke={frameColor} strokeWidth="1.45" />
          <line x1="30.9" y1={y - 0.5} x2="33.1" y2={y - 0.5} stroke={frameColor} strokeWidth="1.45" />
          <line x1="21.5" y1={y - 2.7} x2="23.6" y2={y - 0.6} stroke="#FFFFFF" strokeWidth="1.15" strokeLinecap="round" opacity="0.28" />
          <line x1="35.9" y1={y - 2.7} x2="38.0" y2={y - 0.6} stroke="#FFFFFF" strokeWidth="1.15" strokeLinecap="round" opacity="0.28" />
        </g>
      );

    // ── SUNGLASSES ───────────────────────────────────────────────────────────
    case "sun-wayfarer":
      return (
        <g>
          <rect x="19" y={y - 4.0} width="11.4" height="8.2" rx="2.3" fill="#0F172A" fillOpacity="0.9" stroke={frameColor} strokeWidth="1.6" />
          <rect x="33.6" y={y - 4.0} width="11.4" height="8.2" rx="2.3" fill="#0F172A" fillOpacity="0.9" stroke={frameColor} strokeWidth="1.6" />
          <line x1="30.4" y1={y - 1.5} x2="33.6" y2={y - 1.5} stroke={frameColor} strokeWidth="2.0" />
          <line x1="21.2" y1={y - 2.2} x2="24.0" y2={y + 0.8} stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" opacity="0.4" />
          <line x1="35.8" y1={y - 2.2} x2="38.6" y2={y + 0.8} stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" opacity="0.4" />
        </g>
      );
    case "sun-aviator":
      return (
        <g>
          <path
            d={`M19.2 ${y - 3.6} L30.2 ${y - 2.8} C30.4 ${y + 2.6} 28.2 ${y + 4.8} 24.4 ${y + 4.8} C20.4 ${y + 4.8} 19 ${y + 1.5} 19.2 ${y - 3.6} Z`}
            fill="#18181B"
            fillOpacity="0.86"
            stroke={frameColor}
            strokeWidth="1.35"
          />
          <path
            d={`M44.8 ${y - 3.6} L33.8 ${y - 2.8} C33.6 ${y + 2.6} 35.8 ${y + 4.8} 39.6 ${y + 4.8} C43.6 ${y + 4.8} 45 ${y + 1.5} 44.8 ${y - 3.6} Z`}
            fill="#18181B"
            fillOpacity="0.86"
            stroke={frameColor}
            strokeWidth="1.35"
          />
          <line x1="29.4" y1={y - 3.3} x2="34.6" y2={y - 3.3} stroke={frameColor} strokeWidth="1.35" />
          <line x1="30.2" y1={y - 1.4} x2="33.8" y2={y - 1.4} stroke={frameColor} strokeWidth="1.2" />
          <line x1="21.4" y1={y - 1.8} x2="23.8" y2={y + 0.8} stroke="#FFFFFF" strokeWidth="1.15" strokeLinecap="round" opacity="0.38" />
          <line x1="36.2" y1={y - 1.8} x2="38.6" y2={y + 0.8} stroke="#FFFFFF" strokeWidth="1.15" strokeLinecap="round" opacity="0.38" />
        </g>
      );
    case "sun-round":
      return (
        <g>
          <circle cx="25.2" cy={y} r="5.3" fill="#18181B" fillOpacity="0.9" stroke={frameColor} strokeWidth="1.65" />
          <circle cx="38.8" cy={y} r="5.3" fill="#18181B" fillOpacity="0.9" stroke={frameColor} strokeWidth="1.65" />
          <line x1="30.5" y1={y - 0.3} x2="33.5" y2={y - 0.3} stroke={frameColor} strokeWidth="1.65" />
          <line x1="22.3" y1={y - 2.4} x2="24.7" y2={y} stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" opacity="0.38" />
          <line x1="35.9" y1={y - 2.4} x2="38.3" y2={y} stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" opacity="0.38" />
        </g>
      );
    case "sun-rose-gradient": {
      const gid = `ep-av-sg-${gradId}`;
      return (
        <g>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.88" />
              <stop offset="100%" stopColor="#EC4899" stopOpacity="0.78" />
            </linearGradient>
          </defs>
          <rect x="19.3" y={y - 3.9} width="11.0" height="8.0" rx="3.2" fill={`url(#${gid})`} stroke={frameColor} strokeWidth="1.5" />
          <rect x="33.7" y={y - 3.9} width="11.0" height="8.0" rx="3.2" fill={`url(#${gid})`} stroke={frameColor} strokeWidth="1.5" />
          <line x1="30.3" y1={y - 1.2} x2="33.7" y2={y - 1.2} stroke={frameColor} strokeWidth="1.5" />
          <line x1="21.4" y1={y - 2.0} x2="23.9" y2={y + 0.5} stroke="#FFFFFF" strokeWidth="1.15" strokeLinecap="round" opacity="0.4" />
          <line x1="35.8" y1={y - 2.0} x2="38.3" y2={y + 0.5} stroke="#FFFFFF" strokeWidth="1.15" strokeLinecap="round" opacity="0.4" />
        </g>
      );
    }
    case "sun-cyber-visor":
      return (
        <g>
          <rect x="18.5" y={y - 3.8} width="27" height="7.6" rx="3.0" fill="#0F172A" stroke={frameColor} strokeWidth="1.4" />
          <rect x="22.8" y={y - 1.3} width="5.2" height="2.6" rx="1.1" fill="#34D399" />
          <rect x="36.0" y={y - 1.3} width="5.2" height="2.6" rx="1.1" fill="#34D399" />
        </g>
      );
    case "cinema-3d":
      return (
        <g>
          <rect x="18" y={y - 4.3} width="28" height="9.2" rx="2.4" fill="#E2E8F0" />
          <rect x="19.8" y={y - 2.7} width="10.4" height="5.9" rx="1.2" fill="#22D3EE" />
          <rect x="33.8" y={y - 2.7} width="10.4" height="5.9" rx="1.2" fill="#F43F5E" />
        </g>
      );
    default:
      return null;
  }
}

function HeadwearLayer({
  headwearId,
  color,
  accent,
  isHijab,
}: {
  headwearId: string;
  color: string;
  accent: string;
  isHijab: boolean;
}): ReactNode {
  if (headwearId === "none") return null;

  switch (headwearId) {
    case "headphones":
      return (
        <g>
          <path d="M13.5 33 C13.5 13.5 50.5 13.5 50.5 33" fill="none" stroke={color} strokeWidth="3.8" />
          <rect x="10.5" y="27" width="6.5" height="13" rx="3.2" fill={accent} />
          <rect x="47" y="27" width="6.5" height="13" rx="3.2" fill={accent} />
        </g>
      );
    case "cat-headset":
      return (
        <g>
          <path d="M14.5 28 C16.5 15.5 47.5 15.5 49.5 28" fill="none" stroke={color} strokeWidth="2.8" />
          <path d="M15 24 L19 11 L26 19 Z" fill={color} />
          <path d="M49 24 L45 11 L38 19 Z" fill={color} />
          <path d="M17 22 L19.8 14 L24 19.5 Z" fill={accent} />
          <path d="M47 22 L44.2 14 L40 19.5 Z" fill={accent} />
          <rect x="11.5" y="27.5" width="5.5" height="11" rx="2.7" fill={color} />
          <rect x="47" y="27.5" width="5.5" height="11" rx="2.7" fill={color} />
        </g>
      );
    case "beanie":
      if (isHijab) return null;
      return (
        <g>
          <path d="M16 26.5 C16.5 13.5 25 10.5 32 10.5 C39 10.5 47.5 13.5 48 26.5 Z" fill={color} />
          <rect x="15" y="22.5" width="34" height="6.5" rx="3.2" fill={accent} />
        </g>
      );
    case "cap-forward":
      if (isHijab) return null;
      return (
        <g>
          <path d="M16 25.5 C17 13.5 25 11 32 11 C39 11 47 13.5 48 25.5 Z" fill={color} />
          <path d="M15 24 L49 24 L47 27.2 L17 27.2 Z" fill={accent} />
        </g>
      );
    case "cap-back":
      if (isHijab) return null;
      return (
        <g>
          <path d="M16 25 C17 13 25 11 32 11 C39 11 47 13 48 25 Z" fill={color} />
          <path d="M42 21.5 L50.5 23 L49.8 26.5 L42 25 Z" fill={accent} />
        </g>
      );
    case "beret":
      if (isHijab) return null;
      return (
        <g>
          <ellipse cx="34" cy="16.5" rx="16" ry="6.5" transform="rotate(-10 34 16.5)" fill={color} />
          <line x1="33" y1="10" x2="34.5" y2="7.5" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
        </g>
      );
    case "clip-star":
      return (
        <polygon
          points="41.5,19 42.7,21.5 45.3,21.8 43.4,23.6 43.9,26.2 41.5,24.9 39.1,26.2 39.6,23.6 37.7,21.8 40.3,21.5"
          fill={accent}
          stroke={color}
          strokeWidth="0.6"
        />
      );
    case "clip-flower":
      return (
        <g>
          <circle cx="42.5" cy="22.8" r="3.4" fill={accent} />
          <circle cx="42.5" cy="22.8" r="1.4" fill={color} />
        </g>
      );
    case "crown-mini":
      return (
        <path
          d="M25.5 16.5 L26.8 10.5 L30.2 13.8 L32 9.5 L33.8 13.8 L37.2 10.5 L38.5 16.5 Z"
          fill={accent}
          stroke={color}
          strokeWidth="0.9"
          strokeLinejoin="round"
        />
      );
    default:
      return null;
  }
}

export function CustomAvatarSvgContent({
  avatarId,
  recipeOverride,
}: {
  avatarId?: string;
  recipeOverride?: CustomAvatarRecipe;
}) {
  const gradId = useId().replace(/:/g, "");
  const recipe = recipeOverride ?? decodeCustomAvatar(avatarId ?? "");

  const isGirl = recipe.base === 0;
  const skin = SKIN_TONES[recipe.skinTone] ?? SKIN_TONES[1];
  const hairOpt = HAIR_STYLES[recipe.hairStyle] ?? HAIR_STYLES[8];
  const isHijab = hairOpt.category === "hijab";

  const hairPalette = isHijab ? HIJAB_COLORS : HAIR_COLORS;
  const hairColorObj = hairPalette[recipe.hairOrHijabColor] ?? hairPalette[0];
  const hairColor = hairColorObj.hex;
  const hairAccent = hairColorObj.accent ?? hairColor;

  const eyeStyle = EYE_STYLES[recipe.eyeStyle] ?? EYE_STYLES[0];
  const eyeColor = (EYE_COLORS[recipe.eyeColor] ?? EYE_COLORS[0]).hex;
  const browStyle = BROW_STYLES[recipe.browStyle] ?? BROW_STYLES[0];
  const mouthStyle = MOUTH_STYLES[recipe.mouthAndBlush] ?? MOUTH_STYLES[0];
  const facialHair = FACIAL_HAIR_STYLES[recipe.facialHair] ?? FACIAL_HAIR_STYLES[0];

  const outfitStyle = OUTFIT_STYLES[recipe.outfitStyle] ?? OUTFIT_STYLES[0];
  const outfitColorObj = OUTFIT_COLORS[recipe.outfitColor] ?? OUTFIT_COLORS[0];
  const eyewear = EYEWEAR_OPTIONS[recipe.eyewear] ?? EYEWEAR_OPTIONS[0];
  const headwear = HEADWEAR_OPTIONS[recipe.headwear] ?? HEADWEAR_OPTIONS[0];
  const accColorObj = ACC_COLORS[recipe.accColor] ?? ACC_COLORS[0];
  const bg = BG_THEMES[recipe.bgTheme] ?? BG_THEMES[0];

  const browColor = isHijab ? "#2A1815" : hairColor;
  const hidesEars = Boolean(hairOpt.hidesEars);

  return (
    <>
      {/* 1. Background */}
      <rect width="64" height="64" fill={bg.base} />
      <circle cx="48" cy="16" r="17" fill={bg.glow} opacity="0.38" />

      {/* 2. Back Hair / Back Hijab Silhouette */}
      <BackHairLayer styleId={hairOpt.id} color={hairColor} accent={hairAccent} />

      {/* 3. Outfit Shoulders */}
      <OutfitLayer
        styleId={outfitStyle.id}
        color={outfitColorObj.hex}
        accent={outfitColorObj.accent ?? "#EDE9FE"}
      />

      {/* 4. Hijab Chest / Shoulder Drape */}
      {isHijab && (
        <HijabChestDrape styleId={hairOpt.id} color={hairColor} accent={hairAccent} />
      )}

      {/* 5. Ears (hidden under Hijab / ear-covering styles) */}
      {!hidesEars && (
        <g>
          <circle cx="16.5" cy="34" r="3.9" fill={skin.shadow} />
          <circle cx="47.5" cy="34" r="3.9" fill={skin.shadow} />
        </g>
      )}

      {/* 6. Face Base */}
      <circle cx="32" cy="33" r="14.6" fill={skin.base} />

      {/* 7. Optional Cute Facial Hair (Boys, non-Hijab) */}
      {!isHijab && facialHair.id !== "none" && (
        <FacialHairLayer styleId={facialHair.id} hairColor={hairColor} />
      )}

      {/* 8. Cheeks & Mouth */}
      <MouthAndBlushLayer styleId={mouthStyle.id} mouthStroke={skin.mouthStroke} />

      {/* 9. Eyes & Eyebrows */}
      <EyesAndBrowsLayer
        eyeStyleId={eyeStyle.id}
        eyeColor={eyeColor}
        browStyleId={browStyle.id}
        browColor={browColor}
        isGirl={isGirl}
      />

      {/* 10. Front Hair / Hijab Face-Frame */}
      <FrontHairOrHijabLayer styleId={hairOpt.id} color={hairColor} accent={hairAccent} />

      {/* 11. Eyewear (always above front hair & hijab edges) */}
      <EyewearLayer
        eyewearId={eyewear.id}
        frameColor={accColorObj.hex}
        gradId={gradId}
      />

      {/* 12. Headwear & Audio */}
      <HeadwearLayer
        headwearId={headwear.id}
        color={accColorObj.hex}
        accent={accColorObj.accent ?? "#FDE047"}
        isHijab={isHijab}
      />
    </>
  );
}
