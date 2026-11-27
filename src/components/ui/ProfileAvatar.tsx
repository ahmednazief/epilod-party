import {
  AppChevronIcon,
  AppCloseIcon,
  AppCustomCharsIcon,
  AppEditIcon,
  AppPlusIcon,
  AppShuffleIcon,
  AppStudioIcon,
} from "./AppIcons";
import { useEffect, useState, type ReactNode } from "react";
import { useAnimatedPresence } from "../../lib/useAnimatedPresence";
import { AnimatedCollapse } from "./AnimatedCollapse";
import { SegmentedTabs } from "./SegmentedTabs";
import { AvatarCustomizerStudio } from "./avatar/AvatarCustomizerStudio";
import { CustomAvatarSvgContent } from "./avatar/CustomAvatarRenderer";
import {
  BG_THEMES,
  decodeCustomAvatar,
  encodeCustomAvatar,
  isValidCustomAvatarId,
  loadSavedCustomAvatars,
  MAX_SAVED_CUSTOM_AVATARS,
  OUTFIT_COLORS,
  presetToStartingRecipe,
  randomizeCustomRecipe,
  removeSavedCustomAvatar,
  saveCustomAvatarsList,
  upsertSavedCustomAvatar,
  type CustomAvatarId,
} from "./avatar/customAvatarSchema";

export type { CustomAvatarId };

export type AvatarCategory = "girls" | "boys" | "characters";

export type PresetAvatarId =
  | "nova"
  | "nova-star"
  | "luna"
  | "luna-mint"
  | "sakura"
  | "sakura-gold"
  | "maya"
  | "aria-beret"
  | "leo"
  | "leo-amber"
  | "kai"
  | "kai-crimson"
  | "omar"
  | "omar-cobalt"
  | "zayd"
  | "milo-gamer"
  | "snoo-violet"
  | "snoo-cinema"
  | "snoo-gold"
  | "snoo-mint"
  | "mochi-cat"
  | "kuro-cat"
  | "astro-pip"
  | "astro-rose";

export type AvatarId = PresetAvatarId | CustomAvatarId;

export interface AvatarPreset {
  id: PresetAvatarId;
  label: string;
  category: AvatarCategory;
}

export const AVATAR_PRESETS: readonly AvatarPreset[] = [
  { id: "nova", label: "Nova", category: "girls" },
  { id: "nova-star", label: "Nova Star", category: "girls" },
  { id: "luna", label: "Luna", category: "girls" },
  { id: "luna-mint", label: "Luna Mint", category: "girls" },
  { id: "sakura", label: "Sakura", category: "girls" },
  { id: "sakura-gold", label: "Sakura Gold", category: "girls" },
  { id: "maya", label: "Maya", category: "girls" },
  { id: "aria-beret", label: "Aria", category: "girls" },
  { id: "leo", label: "Leo", category: "boys" },
  { id: "leo-amber", label: "Leo Amber", category: "boys" },
  { id: "kai", label: "Kai", category: "boys" },
  { id: "kai-crimson", label: "Kai Crimson", category: "boys" },
  { id: "omar", label: "Omar", category: "boys" },
  { id: "omar-cobalt", label: "Omar Cobalt", category: "boys" },
  { id: "zayd", label: "Zayd", category: "boys" },
  { id: "milo-gamer", label: "Milo", category: "boys" },
  { id: "snoo-violet", label: "PopBot", category: "characters" },
  { id: "snoo-cinema", label: "Cinema", category: "characters" },
  { id: "snoo-gold", label: "StarBot", category: "characters" },
  { id: "snoo-mint", label: "MintBot", category: "characters" },
  { id: "mochi-cat", label: "Mochi", category: "characters" },
  { id: "kuro-cat", label: "Kuro", category: "characters" },
  { id: "astro-pip", label: "Astro", category: "characters" },
  { id: "astro-rose", label: "Astro Rose", category: "characters" },
] as const;

export const DEFAULT_AVATAR_ID: AvatarId = "snoo-violet";

const VALID_PRESET_AVATAR_IDS = new Set<string>(AVATAR_PRESETS.map((p) => p.id));

const PRESET_ACCENT_HEX: Record<PresetAvatarId, string> = {
  nova: "#8B5CF6",
  "nova-star": "#EC4899",
  luna: "#6366F1",
  "luna-mint": "#2DD4BF",
  sakura: "#F472B6",
  "sakura-gold": "#F59E0B",
  maya: "#A855F7",
  "aria-beret": "#FB7185",
  leo: "#3B82F6",
  "leo-amber": "#F59E0B",
  kai: "#14B8A6",
  "kai-crimson": "#E11D48",
  omar: "#10B981",
  "omar-cobalt": "#3B82F6",
  zayd: "#8B5CF6",
  "milo-gamer": "#22C55E",
  "snoo-violet": "#A78BFA",
  "snoo-cinema": "#E11D48",
  "snoo-gold": "#FBBF24",
  "snoo-mint": "#2DD4BF",
  "mochi-cat": "#F472B6",
  "kuro-cat": "#A78BFA",
  "astro-pip": "#38BDF8",
  "astro-rose": "#FB7185",
};

function hexToRgbTriplet(hex: string): string {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return "167, 139, 250";
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return "167, 139, 250";
  return `${r}, ${g}, ${b}`;
}

/** Extracts the signature RGB color ("r, g, b") for any preset or custom avatar. */
export function resolveAvatarAccentRgb(id: AvatarId): string {
  if (isValidCustomAvatarId(id)) {
    const recipe = decodeCustomAvatar(id);
    const outfit = OUTFIT_COLORS[recipe.outfitColor % OUTFIT_COLORS.length];
    const theme = BG_THEMES[recipe.bgTheme % BG_THEMES.length];
    const pickedHex =
      outfit && outfit.id !== "obsidian" && outfit.id !== "slate" && outfit.id !== "cream"
        ? outfit.hex
        : theme?.glow ?? "#A78BFA";
    return hexToRgbTriplet(pickedHex);
  }
  return hexToRgbTriplet(PRESET_ACCENT_HEX[id] ?? "#A78BFA");
}

export function isValidAvatarId(raw: string): raw is AvatarId {
  return VALID_PRESET_AVATAR_IDS.has(raw) || isValidCustomAvatarId(raw);
}

export function resolvePeerAvatarId(
  peerUsername: string,
  localUsername?: string,
  localAvatarId: AvatarId | string = DEFAULT_AVATAR_ID,
  peerAvatars?: Record<string, AvatarId>,
): AvatarId {
  const safeAvatarId = isValidAvatarId(localAvatarId) ? localAvatarId : DEFAULT_AVATAR_ID;
  const cleanPeer = peerUsername.trim().toLowerCase();
  const cleanLocal = (localUsername ?? "").trim().toLowerCase();
  if (cleanPeer && cleanLocal && cleanPeer === cleanLocal) {
    return safeAvatarId;
  }

  const synced = cleanPeer ? peerAvatars?.[cleanPeer] : undefined;
  if (synced && isValidAvatarId(synced)) {
    return synced;
  }

  // Natural defaults for common demo/friend names before deterministic hashing
  if (cleanPeer === "maya") return "maya";
  if (cleanPeer === "noor") return "luna";
  if (cleanPeer === "tariq") return "kai";
  if (cleanPeer === "omar") return "omar";
  if (cleanPeer === "sakura") return "sakura";
  if (cleanPeer === "leo") return "leo";

  let hash = 0;
  for (let i = 0; i < cleanPeer.length; i++) {
    hash = (hash * 31 + cleanPeer.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PRESETS[hash % AVATAR_PRESETS.length].id;
}

interface CuteEyesProps {
  y?: number;
  eyeColor?: string;
  winkRight?: boolean;
}

function CuteEyes({ y = 33.5, eyeColor = "#1D1632", winkRight = false }: CuteEyesProps) {
  return (
    <g>
      <circle cx="25.2" cy={y} r="3.3" fill={eyeColor} />
      <circle cx="26.3" cy={y - 1.1} r="1.2" fill="#FFFFFF" />
      <circle cx="24.2" cy={y + 1.1} r="0.6" fill="#FFFFFF" opacity="0.7" />
      {winkRight ? (
        <path
          d={`M35.5 ${y + 0.5} Q38.8 ${y - 2.6} 42 ${y + 0.5}`}
          fill="none"
          stroke={eyeColor}
          strokeWidth="2.3"
          strokeLinecap="round"
        />
      ) : (
        <>
          <circle cx="38.8" cy={y} r="3.3" fill={eyeColor} />
          <circle cx="39.9" cy={y - 1.1} r="1.2" fill="#FFFFFF" />
          <circle cx="37.8" cy={y + 1.1} r="0.6" fill="#FFFFFF" opacity="0.7" />
        </>
      )}
    </g>
  );
}

function Cheeks({ y = 37.8, color = "#FB7185" }: { y?: number; color?: string }) {
  return (
    <g opacity="0.48">
      <ellipse cx="21.5" cy={y} rx="3.1" ry="1.8" fill={color} />
      <ellipse cx="42.5" cy={y} rx="3.1" ry="1.8" fill={color} />
    </g>
  );
}

function AvatarIllustration({ id }: { id: AvatarId }): ReactNode {
  if (isValidCustomAvatarId(id)) {
    return <CustomAvatarSvgContent avatarId={id} />;
  }

  switch (id) {
    // ── GIRLS ────────────────────────────────────────────────────────────────
    case "nova":
      return (
        <>
          <rect width="64" height="64" fill="#3B1D6E" />
          <circle cx="50" cy="14" r="16" fill="#6D28D9" opacity="0.45" />
          {/* Space buns */}
          <circle cx="15" cy="20" r="8" fill="#1F1235" />
          <circle cx="49" cy="20" r="8" fill="#1F1235" />
          <circle cx="15" cy="20" r="3" fill="#C4B5FD" />
          <circle cx="49" cy="20" r="3" fill="#C4B5FD" />
          {/* Hoodie shoulders */}
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#8B5CF6" />
          <path d="M24 46 Q32 52 40 46" fill="none" stroke="#EDE9FE" strokeWidth="2.2" strokeLinecap="round" />
          {/* Ears & face */}
          <circle cx="16.5" cy="34" r="4" fill="#FCD3B8" />
          <circle cx="47.5" cy="34" r="4" fill="#FCD3B8" />
          <circle cx="32" cy="32" r="15.5" fill="#FDE2CE" />
          {/* Bangs */}
          <path
            d="M16 30 C17 17 24 14 32 14 C40 14 47 17 48 30 C44 23 39 22 33 26 C29 22 21 23 16 30 Z"
            fill="#1F1235"
          />
          <CuteEyes />
          <Cheeks />
          <path d="M29 40 Q32 42.8 35 40" fill="none" stroke="#9F584A" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "luna":
      return (
        <>
          <rect width="64" height="64" fill="#1E1B4B" />
          <circle cx="16" cy="14" r="18" fill="#4338CA" opacity="0.45" />
          {/* Long flowing lavender-dark back hair */}
          <path d="M13 30 C13 14 22 12 32 12 C42 12 51 14 51 30 L52 62 L12 62 Z" fill="#2A1C4E" />
          {/* Cat-ear headset band & glowing ears */}
          <path d="M15 24 L19 11 L26 19 Z" fill="#A78BFA" />
          <path d="M49 24 L45 11 L38 19 Z" fill="#A78BFA" />
          <path d="M17 22 L19.8 14 L24 19.5 Z" fill="#F472B6" />
          <path d="M47 22 L44.2 14 L40 19.5 Z" fill="#F472B6" />
          {/* Sweater */}
          <path d="M14 64 C15 50 23 46 32 46 C41 46 49 50 50 64 Z" fill="#6366F1" />
          {/* Face */}
          <circle cx="32" cy="33" r="14.5" fill="#FFE6D5" />
          <path
            d="M17 31 C18 19 25 16 32 16 C39 16 46 19 47 31 C42 25 36 23 32 27 C27 23 22 25 17 31 Z"
            fill="#3B236E"
          />
          <CuteEyes y={34.5} eyeColor="#1E1B4B" />
          <Cheeks y={38.5} />
          <path d="M29.2 41 Q32 43.2 34.8 41" fill="none" stroke="#9F584A" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "sakura":
      return (
        <>
          <rect width="64" height="64" fill="#50183D" />
          <circle cx="48" cy="18" r="16" fill="#BE185D" opacity="0.38" />
          {/* Bob hair */}
          <path d="M14 35 C13 17 21 12 32 12 C43 12 51 17 50 35 C51 43 47 49 43 50 L21 50 C17 49 13 43 14 35 Z" fill="#3B1A2B" />
          <path d="M14 64 C15 50 23 46 32 46 C41 46 49 50 50 64 Z" fill="#F472B6" />
          <path d="M26 46 L32 54 L38 46 Z" fill="#FDF2F8" />
          {/* Face */}
          <circle cx="32" cy="33" r="14.5" fill="#FFE4D6" />
          <path d="M18 30 C19 18 26 16 32 16 C38 16 45 18 46 30 C41 25 35 23 32 25 C28 22 22 24 18 30 Z" fill="#4A2136" />
          {/* Flower clip */}
          <circle cx="43" cy="23" r="3.4" fill="#FBCFE8" />
          <circle cx="43" cy="23" r="1.4" fill="#F59E0B" />
          {/* Cute round glasses */}
          <circle cx="25.2" cy="34" r="5.3" fill="none" stroke="#F9A8D4" strokeWidth="1.6" />
          <circle cx="38.8" cy="34" r="5.3" fill="none" stroke="#F9A8D4" strokeWidth="1.6" />
          <line x1="30.5" y1="34" x2="33.5" y2="34" stroke="#F9A8D4" strokeWidth="1.6" />
          <CuteEyes y={34} />
          <Cheeks y={38.8} color="#FB7185" />
          <path d="M29.5 41.2 Q32 43.3 34.5 41.2" fill="none" stroke="#9D4E59" strokeWidth="1.8" strokeLinecap="round" />
        </>
      );

    case "maya":
      return (
        <>
          <rect width="64" height="64" fill="#2E1065" />
          <circle cx="18" cy="48" r="18" fill="#7C3AED" opacity="0.35" />
          {/* High ponytail back */}
          <path d="M35 14 C46 11 54 18 52 32 C49 27 44 25 40 24 Z" fill="#1E142E" />
          <circle cx="38" cy="16" r="3.4" fill="#F43F5E" />
          {/* Top */}
          <path d="M13 64 C14 49 22 45 32 45 C42 45 50 49 51 64 Z" fill="#A855F7" />
          <line x1="27" y1="47" x2="27" y2="57" stroke="#F5F3FF" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="37" y1="47" x2="37" y2="57" stroke="#F5F3FF" strokeWidth="1.8" strokeLinecap="round" />
          {/* Face */}
          <circle cx="16.5" cy="34" r="3.8" fill="#EBB48F" />
          <circle cx="47.5" cy="34" r="3.8" fill="#EBB48F" />
          <circle cx="32" cy="32.5" r="15" fill="#F3C19D" />
          <path d="M17 31 C17 18 24 14 32 14 C40 14 47 18 47 31 C42 22 36 21 31 24 C25 21 20 24 17 31 Z" fill="#1E142E" />
          <CuteEyes y={33.5} winkRight />
          <Cheeks color="#F43F5E" />
          <path d="M27.5 39.5 Q32 44.2 36.5 39.5 Z" fill="#FFFFFF" />
          <path d="M27.5 39.5 Q32 44.2 36.5 39.5" fill="none" stroke="#85453A" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );

    // ── BOYS ─────────────────────────────────────────────────────────────────
    case "leo":
      return (
        <>
          <rect width="64" height="64" fill="#172554" />
          <circle cx="48" cy="16" r="16" fill="#2563EB" opacity="0.38" />
          {/* Hoodie */}
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#3B82F6" />
          <path d="M23 46 L32 54 L41 46" fill="none" stroke="#DBEAFE" strokeWidth="2" strokeLinecap="round" />
          {/* Headphone headband */}
          <path d="M14 33 C14 14 50 14 50 33" fill="none" stroke="#7C3AED" strokeWidth="4" />
          <rect x="11" y="27" width="6.5" height="13" rx="3.2" fill="#8B5CF6" />
          <rect x="46.5" y="27" width="6.5" height="13" rx="3.2" fill="#8B5CF6" />
          {/* Face */}
          <circle cx="32" cy="33" r="15" fill="#FCDAC2" />
          {/* Tousled spiky hair */}
          <path
            d="M17 29 C17 17 25 14 33 14 C41 14 47 18 47 29 L43 24 L37 26 L32 21 L26 26 L21 23 Z"
            fill="#1F2937"
          />
          <CuteEyes y={34} />
          <Cheeks y={38} color="#F97316" />
          <path d="M28.5 40.5 Q32 43.5 35.8 40.2" fill="none" stroke="#8D5144" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    case "kai":
      return (
        <>
          <rect width="64" height="64" fill="#0F3A42" />
          <circle cx="16" cy="18" r="18" fill="#0D9488" opacity="0.35" />
          {/* Jacket */}
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#14B8A6" />
          <path d="M22 47 L28 64 M42 47 L36 64" stroke="#0F766E" strokeWidth="2.5" />
          {/* Face */}
          <circle cx="16.5" cy="34.5" r="3.8" fill="#E8B998" />
          <circle cx="47.5" cy="34.5" r="3.8" fill="#E8B998" />
          <circle cx="32" cy="33.5" r="14.5" fill="#F3CBB0" />
          {/* Knit Beanie */}
          <path d="M16.5 27 C17 14 25 11 32 11 C39 11 47 14 47.5 27 Z" fill="#7C3AED" />
          <rect x="15.5" y="23" width="33" height="6.5" rx="3.2" fill="#8B5CF6" />
          {/* Glasses */}
          <rect x="20" y="29.8" width="10" height="7.5" rx="2.5" fill="none" stroke="#1E293B" strokeWidth="1.8" />
          <rect x="34" y="29.8" width="10" height="7.5" rx="2.5" fill="none" stroke="#1E293B" strokeWidth="1.8" />
          <line x1="30" y1="33.5" x2="34" y2="33.5" stroke="#1E293B" strokeWidth="1.8" />
          <CuteEyes y={33.6} />
          <path d="M29 41 Q32 43.2 35 41" fill="none" stroke="#854E3E" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "omar":
      return (
        <>
          <rect width="64" height="64" fill="#132F28" />
          <circle cx="48" cy="48" r="16" fill="#059669" opacity="0.3" />
          {/* Varsity jacket */}
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#10B981" />
          <path d="M25 46 L32 58 L39 46 Z" fill="#ECFDF5" />
          {/* Curly crown */}
          <circle cx="22" cy="18" r="6" fill="#18121E" />
          <circle cx="32" cy="15" r="6.8" fill="#18121E" />
          <circle cx="42" cy="18" r="6" fill="#18121E" />
          <circle cx="17" cy="24" r="5" fill="#18121E" />
          <circle cx="47" cy="24" r="5" fill="#18121E" />
          {/* Face */}
          <circle cx="16.5" cy="34.5" r="3.8" fill="#C98D68" />
          <circle cx="47.5" cy="34.5" r="3.8" fill="#C98D68" />
          <circle cx="32" cy="33.5" r="14.5" fill="#D99E78" />
          {/* Curly fringe */}
          <path d="M19 25 Q24 21 28 24 Q33 20 38 24 Q42 21 45 25 C43 18 21 18 19 25 Z" fill="#18121E" />
          <CuteEyes y={34} eyeColor="#120F1A" />
          <Cheeks y={38} color="#E11D48" />
          <path d="M28 40 Q32 44 36 40 Z" fill="#FFFFFF" />
        </>
      );

    case "zayd":
      return (
        <>
          <rect width="64" height="64" fill="#321A4A" />
          <circle cx="46" cy="18" r="16" fill="#9333EA" opacity="0.38" />
          {/* Jacket */}
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#6D28D9" />
          <circle cx="32" cy="54" r="3.5" fill="#FBBF24" />
          {/* Face */}
          <circle cx="16.5" cy="34.5" r="3.8" fill="#F1C39E" />
          <circle cx="47.5" cy="34.5" r="3.8" fill="#F1C39E" />
          <circle cx="32" cy="33.5" r="14.5" fill="#F7CFAF" />
          {/* Swept hair under cap */}
          <path d="M18 30 L24 23 L31 27 L38 22 L46 29 C45 19 19 19 18 30 Z" fill="#272038" />
          {/* Backwards baseball cap */}
          <path d="M16 25 C17 13 25 11 32 11 C39 11 47 13 48 25 Z" fill="#F59E0B" />
          <path d="M42 21.5 L50 23 L49.5 26.5 L42 25 Z" fill="#D97706" />
          <CuteEyes y={34.5} />
          <path d="M29 41 Q33 43.2 36.5 39.8" fill="none" stroke="#854E3E" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    // ── MASCOTS (Reddit Snoo & Cinema Characters) ────────────────────────────
    case "snoo-violet":
      return (
        <>
          <rect width="64" height="64" fill="#4C1D95" />
          <circle cx="32" cy="16" r="20" fill="#7C3AED" opacity="0.55" />
          {/* Antenna */}
          <path d="M32 21 L35 12 L43 13.5" fill="none" stroke="#F5F3FF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="44.5" cy="14" r="3.6" fill="#C4B5FD" />
          {/* Snoo shoulders */}
          <path d="M15 64 C16 50 23 47 32 47 C41 47 48 50 49 64 Z" fill="#EDE9FE" />
          {/* Ears */}
          <circle cx="15" cy="33" r="4.5" fill="#FFFFFF" />
          <circle cx="49" cy="33" r="4.5" fill="#FFFFFF" />
          <circle cx="15" cy="33" r="2.2" fill="#DDD6FE" />
          <circle cx="49" cy="33" r="2.2" fill="#DDD6FE" />
          {/* Wide Snoo oval head */}
          <ellipse cx="32" cy="35" rx="16.5" ry="13.5" fill="#FFFFFF" />
          {/* Luminous amethyst Snoo eyes */}
          <circle cx="25.2" cy="34.5" r="3.4" fill="#7C3AED" />
          <circle cx="38.8" cy="34.5" r="3.4" fill="#7C3AED" />
          <circle cx="26.2" cy="33.4" r="1.1" fill="#FFFFFF" />
          <circle cx="39.8" cy="33.4" r="1.1" fill="#FFFFFF" />
          <Cheeks y={38.8} color="#A78BFA" />
          <path d="M27.5 41.2 Q32 44.5 36.5 41.2" fill="none" stroke="#2E1065" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    case "snoo-cinema":
      return (
        <>
          <rect width="64" height="64" fill="#1E1B4B" />
          <circle cx="48" cy="14" r="16" fill="#8B5CF6" opacity="0.45" />
          {/* Antenna */}
          <path d="M32 21 L34 11 L42 12.5" fill="none" stroke="#EDE9FE" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="43.5" cy="13" r="3.4" fill="#F472B6" />
          {/* Popcorn-striped collar */}
          <path d="M15 64 C16 50 23 47 32 47 C41 47 48 50 49 64 Z" fill="#7C3AED" />
          {/* Ears & head */}
          <circle cx="15" cy="33.5" r="4.3" fill="#F8FAFC" />
          <circle cx="49" cy="33.5" r="4.3" fill="#F8FAFC" />
          <ellipse cx="32" cy="35" rx="16.5" ry="13.5" fill="#FFFFFF" />
          {/* 3D Cinema glasses */}
          <rect x="18" y="29.5" width="28" height="9.5" rx="2.5" fill="#E2E8F0" />
          <rect x="20" y="31.2" width="10" height="6" rx="1.2" fill="#22D3EE" />
          <rect x="34" y="31.2" width="10" height="6" rx="1.2" fill="#F43F5E" />
          {/* Cheerful smile */}
          <path d="M27.8 42 Q32 45 36.2 42" fill="none" stroke="#1E1B4B" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    case "mochi-cat":
      return (
        <>
          <rect width="64" height="64" fill="#4A1D4E" />
          <circle cx="18" cy="16" r="16" fill="#EC4899" opacity="0.32" />
          {/* Hoodie */}
          <path d="M15 64 C16 50 23 46 32 46 C41 46 48 50 49 64 Z" fill="#F472B6" />
          {/* Cat ears */}
          <path d="M15 30 L17 13 L28 23 Z" fill="#FFFDF9" />
          <path d="M49 30 L47 13 L36 23 Z" fill="#FFFDF9" />
          <path d="M18 26 L19 16.5 L25.5 22.5 Z" fill="#F9A8D4" />
          <path d="M46 26 L45 16.5 L38.5 22.5 Z" fill="#F9A8D4" />
          {/* Cat head */}
          <ellipse cx="32" cy="35.5" rx="16.5" ry="14" fill="#FFFDF9" />
          <CuteEyes y={34.5} eyeColor="#3B0764" />
          <Cheeks y={38.5} color="#F472B6" />
          {/* Whiskers & ":3" mouth */}
          <line x1="17" y1="36" x2="12" y2="35" stroke="#CBD5E1" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="17" y1="39" x2="12" y2="40" stroke="#CBD5E1" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="47" y1="36" x2="52" y2="35" stroke="#CBD5E1" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="47" y1="39" x2="52" y2="40" stroke="#CBD5E1" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M28 40.5 Q30 43 32 40.5 Q34 43 36 40.5" fill="none" stroke="#831843" strokeWidth="1.7" strokeLinecap="round" />
        </>
      );

    case "astro-pip":
      return (
        <>
          <rect width="64" height="64" fill="#0F172A" />
          <circle cx="48" cy="14" r="14" fill="#6366F1" opacity="0.45" />
          <circle cx="14" cy="20" r="1.5" fill="#FDE047" />
          <circle cx="52" cy="46" r="1.5" fill="#C4B5FD" />
          {/* Suit */}
          <path d="M14 64 C15 50 22 46 32 46 C42 46 50 50 50 64 Z" fill="#E2E8F0" />
          <rect x="26" y="51" width="12" height="6" rx="3" fill="#7C3AED" />
          {/* Helmet outer & visor */}
          <circle cx="32" cy="33" r="16.5" fill="#F8FAFC" />
          <ellipse cx="32" cy="33.5" rx="12.5" ry="10.5" fill="#1E1B4B" />
          {/* Glowing visor eyes */}
          <circle cx="26.8" cy="33" r="2.6" fill="#38BDF8" />
          <circle cx="37.2" cy="33" r="2.6" fill="#38BDF8" />
          <circle cx="27.6" cy="32.1" r="0.9" fill="#FFFFFF" />
          <circle cx="38" cy="32.1" r="0.9" fill="#FFFFFF" />
          <path d="M29 38.2 Q32 40.2 35 38.2" fill="none" stroke="#C4B5FD" strokeWidth="1.7" strokeLinecap="round" />
        </>
      );

    case "nova-star":
      return (
        <>
          <rect width="64" height="64" fill="#1E1B4B" />
          <circle cx="16" cy="16" r="16" fill="#0EA5E9" opacity="0.32" />
          {/* Lavender space buns + star ties */}
          <circle cx="15" cy="20" r="8" fill="#4C1D95" />
          <circle cx="49" cy="20" r="8" fill="#4C1D95" />
          <circle cx="15" cy="20" r="3" fill="#38BDF8" />
          <circle cx="49" cy="20" r="3" fill="#38BDF8" />
          {/* Hoodie */}
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#0284C7" />
          <path d="M24 46 Q32 52 40 46" fill="none" stroke="#E0F2FE" strokeWidth="2.2" strokeLinecap="round" />
          {/* Face */}
          <circle cx="16.5" cy="34" r="4" fill="#FCD3B8" />
          <circle cx="47.5" cy="34" r="4" fill="#FCD3B8" />
          <circle cx="32" cy="32" r="15.5" fill="#FFE7D6" />
          <path
            d="M16 30 C17 17 24 14 32 14 C40 14 47 17 48 30 C44 23 39 22 33 26 C29 22 21 23 16 30 Z"
            fill="#5B21B6"
          />
          <polygon points="41,19 42.2,21.5 44.8,21.8 42.9,23.6 43.4,26.2 41,24.9 38.6,26.2 39.1,23.6 37.2,21.8 39.8,21.5" fill="#FDE047" />
          <CuteEyes eyeColor="#1E1B4B" winkRight />
          <Cheeks color="#FB7185" />
          <path d="M28.5 39.8 Q32 43.2 35.5 39.8" fill="none" stroke="#9F584A" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "luna-mint":
      return (
        <>
          <rect width="64" height="64" fill="#0F2933" />
          <circle cx="48" cy="18" r="18" fill="#14B8A6" opacity="0.32" />
          {/* Flowing silver hair */}
          <path d="M13 30 C13 14 22 12 32 12 C42 12 51 14 51 30 L52 62 L12 62 Z" fill="#94A3B8" />
          {/* Teal cat-ear headset */}
          <path d="M15 24 L19 11 L26 19 Z" fill="#2DD4BF" />
          <path d="M49 24 L45 11 L38 19 Z" fill="#2DD4BF" />
          <path d="M17 22 L19.8 14 L24 19.5 Z" fill="#FDE047" />
          <path d="M47 22 L44.2 14 L40 19.5 Z" fill="#FDE047" />
          <path d="M14 64 C15 50 23 46 32 46 C41 46 49 50 50 64 Z" fill="#0D9488" />
          <circle cx="32" cy="33" r="14.5" fill="#FFE6D5" />
          <path
            d="M17 31 C18 19 25 16 32 16 C39 16 46 19 47 31 C42 25 36 23 32 27 C27 23 22 25 17 31 Z"
            fill="#CBD5E1"
          />
          <CuteEyes y={34.5} eyeColor="#0F766E" />
          <Cheeks y={38.5} color="#FDA4AF" />
          <path d="M29.2 41 Q32 43.2 34.8 41" fill="none" stroke="#9F584A" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "sakura-gold":
      return (
        <>
          <rect width="64" height="64" fill="#451A2B" />
          <circle cx="16" cy="16" r="18" fill="#F59E0B" opacity="0.28" />
          {/* Warm chestnut bob */}
          <path d="M14 35 C13 17 21 12 32 12 C43 12 51 17 50 35 C51 43 47 49 43 50 L21 50 C17 49 13 43 14 35 Z" fill="#78350F" />
          <path d="M14 64 C15 50 23 46 32 46 C41 46 49 50 50 64 Z" fill="#FB7185" />
          <path d="M26 46 L32 54 L38 46 Z" fill="#FFFBEB" />
          <circle cx="32" cy="33" r="14.5" fill="#FFE4D6" />
          <path d="M18 30 C19 18 26 16 32 16 C38 16 45 18 46 30 C41 25 35 23 32 25 C28 22 22 24 18 30 Z" fill="#92400E" />
          {/* Gold clip */}
          <circle cx="21" cy="23" r="3" fill="#FDE047" />
          <circle cx="21" cy="23" r="1.3" fill="#F97316" />
          <CuteEyes y={34} eyeColor="#451A03" winkRight />
          <Cheeks y={38.8} color="#FB7185" />
          <path d="M29 41 Q32 43.8 35 41" fill="none" stroke="#9D4E59" strokeWidth="1.8" strokeLinecap="round" />
        </>
      );

    case "aria-beret":
      return (
        <>
          <rect width="64" height="64" fill="#3B1228" />
          <circle cx="48" cy="48" r="18" fill="#BE185D" opacity="0.28" />
          {/* Caramel braids */}
          <circle cx="15" cy="44" r="5" fill="#92400E" />
          <circle cx="14" cy="52" r="4.5" fill="#92400E" />
          <circle cx="49" cy="44" r="5" fill="#92400E" />
          <circle cx="50" cy="52" r="4.5" fill="#92400E" />
          {/* Cream sweater & scarf */}
          <path d="M13 64 C14 49 22 45 32 45 C42 45 50 49 51 64 Z" fill="#F5F3FF" />
          <rect x="20" y="46" width="24" height="6.5" rx="3.2" fill="#E11D48" />
          <circle cx="32" cy="33" r="14.5" fill="#F7CFAF" />
          <path d="M17 31 C18 19 25 16 32 16 C39 16 46 19 47 31 C42 23 36 22 32 25 C27 22 22 24 17 31 Z" fill="#B45309" />
          {/* Tilted velvet beret */}
          <ellipse cx="34" cy="17" rx="16" ry="6.5" transform="rotate(-10 34 17)" fill="#9F1239" />
          <line x1="33" y1="10.5" x2="34.5" y2="8" stroke="#9F1239" strokeWidth="2.2" strokeLinecap="round" />
          <CuteEyes y={34} eyeColor="#3B1D0E" />
          <Cheeks y={38.5} color="#F43F5E" />
          <path d="M29.2 41 Q32 43.2 34.8 41" fill="none" stroke="#85453A" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "leo-amber":
      return (
        <>
          <rect width="64" height="64" fill="#2B190E" />
          <circle cx="18" cy="16" r="16" fill="#EA580C" opacity="0.34" />
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#334155" />
          <path d="M23 46 L32 54 L41 46" fill="none" stroke="#FDBA74" strokeWidth="2" strokeLinecap="round" />
          {/* Amber headphones */}
          <path d="M14 33 C14 14 50 14 50 33" fill="none" stroke="#F59E0B" strokeWidth="4" />
          <rect x="11" y="27" width="6.5" height="13" rx="3.2" fill="#FB923C" />
          <rect x="46.5" y="27" width="6.5" height="13" rx="3.2" fill="#FB923C" />
          <circle cx="32" cy="33" r="15" fill="#FCDAC2" />
          {/* Golden spiky hair */}
          <path
            d="M17 29 C17 17 25 14 33 14 C41 14 47 18 47 29 L43 24 L37 26 L32 21 L26 26 L21 23 Z"
            fill="#D97706"
          />
          <CuteEyes y={34} eyeColor="#1E293B" winkRight />
          <Cheeks y={38} color="#F97316" />
          <path d="M28.5 40.5 Q32 43.5 35.8 40.2" fill="none" stroke="#8D5144" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    case "kai-crimson":
      return (
        <>
          <rect width="64" height="64" fill="#31101C" />
          <circle cx="48" cy="18" r="16" fill="#E11D48" opacity="0.32" />
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#BE123C" />
          <path d="M22 47 L28 64 M42 47 L36 64" stroke="#881337" strokeWidth="2.5" />
          <circle cx="16.5" cy="34.5" r="3.8" fill="#E8B998" />
          <circle cx="47.5" cy="34.5" r="3.8" fill="#E8B998" />
          <circle cx="32" cy="33.5" r="14.5" fill="#F3CBB0" />
          {/* Charcoal knit beanie */}
          <path d="M16.5 27 C17 14 25 11 32 11 C39 11 47 14 47.5 27 Z" fill="#1E293B" />
          <rect x="15.5" y="23" width="33" height="6.5" rx="3.2" fill="#334155" />
          {/* Round tinted shades */}
          <circle cx="25.2" cy="33.5" r="5" fill="#18181B" stroke="#E2E8F0" strokeWidth="1.6" />
          <circle cx="38.8" cy="33.5" r="5" fill="#18181B" stroke="#E2E8F0" strokeWidth="1.6" />
          <line x1="30.2" y1="33.5" x2="33.8" y2="33.5" stroke="#E2E8F0" strokeWidth="1.6" />
          <path d="M29 41 Q32 43.2 35 41" fill="none" stroke="#854E3E" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "omar-cobalt":
      return (
        <>
          <rect width="64" height="64" fill="#0F172A" />
          <circle cx="16" cy="48" r="16" fill="#2563EB" opacity="0.34" />
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#2563EB" />
          <path d="M25 46 L32 58 L39 46 Z" fill="#EFF6FF" />
          {/* Clean cropped fade */}
          <path d="M17 31 C17 16 24 13 32 13 C40 13 47 16 47 31 Z" fill="#18121E" />
          <circle cx="16.5" cy="34.5" r="3.8" fill="#C98D68" />
          <circle cx="47.5" cy="34.5" r="3.8" fill="#C98D68" />
          <circle cx="32" cy="33.5" r="14.5" fill="#D99E78" />
          <path d="M17.5 28 C18 18 25 15 32 15 C39 15 46 18 46.5 28 C41 23 36 22 32 22 C28 22 23 23 17.5 28 Z" fill="#18121E" />
          <CuteEyes y={34} eyeColor="#120F1A" />
          <Cheeks y={38} color="#E11D48" />
          <path d="M28.5 40.5 Q32 43.2 36 39.8" fill="none" stroke="#6B3A2E" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    case "milo-gamer":
      return (
        <>
          <rect width="64" height="64" fill="#112A2C" />
          <circle cx="48" cy="18" r="16" fill="#10B981" opacity="0.34" />
          <path d="M12 64 C13 49 22 45 32 45 C42 45 51 49 52 64 Z" fill="#10B981" />
          <circle cx="32" cy="55" r="3.2" fill="#A7F3D0" />
          <circle cx="16.5" cy="34.5" r="3.8" fill="#F1C39E" />
          <circle cx="47.5" cy="34.5" r="3.8" fill="#F1C39E" />
          <circle cx="32" cy="33.5" r="14.5" fill="#FDE2CE" />
          {/* Violet cap */}
          <path d="M16 26 C17 14 25 11 32 11 C39 11 47 14 48 26 Z" fill="#7C3AED" />
          <path d="M15 24.5 L49 24.5 L47 27.5 L17 27.5 Z" fill="#5B21B6" />
          {/* Retro pixel visor */}
          <rect x="19.5" y="30" width="25" height="7" rx="2.5" fill="#0F172A" />
          <rect x="23" y="32.2" width="5" height="2.6" rx="1" fill="#34D399" />
          <rect x="36" y="32.2" width="5" height="2.6" rx="1" fill="#34D399" />
          <path d="M28.5 40.5 Q32 43.2 35.5 40.5" fill="none" stroke="#854E3E" strokeWidth="1.9" strokeLinecap="round" />
        </>
      );

    case "snoo-gold":
      return (
        <>
          <rect width="64" height="64" fill="#18122B" />
          <circle cx="32" cy="18" r="18" fill="#F59E0B" opacity="0.32" />
          {/* Antenna with gold star tip */}
          <path d="M32 21 L35 11 L43 12.5" fill="none" stroke="#FDE68A" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="44.5" cy="13" r="3.6" fill="#FBBF24" />
          <path d="M15 64 C16 50 23 47 32 47 C41 47 48 50 49 64 Z" fill="#F59E0B" />
          <circle cx="15" cy="33" r="4.5" fill="#272042" />
          <circle cx="49" cy="33" r="4.5" fill="#272042" />
          <circle cx="15" cy="33" r="2.2" fill="#FBBF24" />
          <circle cx="49" cy="33" r="2.2" fill="#FBBF24" />
          <ellipse cx="32" cy="35" rx="16.5" ry="13.5" fill="#1E1B38" stroke="#FBBF24" strokeWidth="1.6" />
          <circle cx="25.2" cy="34.5" r="3.3" fill="#FBBF24" />
          <circle cx="38.8" cy="34.5" r="3.3" fill="#FBBF24" />
          <circle cx="26.2" cy="33.4" r="1.1" fill="#FFFFFF" />
          <circle cx="39.8" cy="33.4" r="1.1" fill="#FFFFFF" />
          <path d="M27.5 41.2 Q32 44.5 36.5 41.2" fill="none" stroke="#FDE68A" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    case "snoo-mint":
      return (
        <>
          <rect width="64" height="64" fill="#0B2E33" />
          <circle cx="18" cy="18" r="18" fill="#2DD4BF" opacity="0.35" />
          <path d="M32 21 L34 11 L42 12.5" fill="none" stroke="#CCFBF1" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="43.5" cy="13" r="3.6" fill="#5EEAD4" />
          <path d="M15 64 C16 50 23 47 32 47 C41 47 48 50 49 64 Z" fill="#14B8A6" />
          <circle cx="15" cy="33" r="4.5" fill="#ECFDF5" />
          <circle cx="49" cy="33" r="4.5" fill="#ECFDF5" />
          <circle cx="15" cy="33" r="2.2" fill="#5EEAD4" />
          <circle cx="49" cy="33" r="2.2" fill="#5EEAD4" />
          <ellipse cx="32" cy="35" rx="16.5" ry="13.5" fill="#F0FDFA" />
          <CuteEyes y={34.5} eyeColor="#0F766E" winkRight />
          <Cheeks y={38.8} color="#2DD4BF" />
          <path d="M27.5 41.2 Q32 44.5 36.5 41.2" fill="none" stroke="#0F766E" strokeWidth="2" strokeLinecap="round" />
        </>
      );

    case "kuro-cat":
      return (
        <>
          <rect width="64" height="64" fill="#1A102C" />
          <circle cx="48" cy="16" r="16" fill="#8B5CF6" opacity="0.32" />
          <path d="M15 64 C16 50 23 46 32 46 C41 46 48 50 49 64 Z" fill="#7C3AED" />
          <circle cx="32" cy="52.5" r="3.3" fill="#FDE047" />
          {/* Black cat ears */}
          <path d="M15 30 L17 13 L28 23 Z" fill="#1F1B2E" />
          <path d="M49 30 L47 13 L36 23 Z" fill="#1F1B2E" />
          <path d="M18 26 L19 16.5 L25.5 22.5 Z" fill="#A78BFA" />
          <path d="M46 26 L45 16.5 L38.5 22.5 Z" fill="#A78BFA" />
          <ellipse cx="32" cy="35.5" rx="16.5" ry="14" fill="#1F1B2E" />
          {/* Golden cat eyes */}
          <circle cx="25.2" cy="34.5" r="3.4" fill="#FACC15" />
          <circle cx="38.8" cy="34.5" r="3.4" fill="#FACC15" />
          <circle cx="26.2" cy="33.4" r="1.1" fill="#FFFFFF" />
          <circle cx="39.8" cy="33.4" r="1.1" fill="#FFFFFF" />
          <line x1="17" y1="36" x2="12" y2="35" stroke="#64748B" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="17" y1="39" x2="12" y2="40" stroke="#64748B" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="47" y1="36" x2="52" y2="35" stroke="#64748B" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="47" y1="39" x2="52" y2="40" stroke="#64748B" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M28 40.5 Q30 43 32 40.5 Q34 43 36 40.5" fill="none" stroke="#F472B6" strokeWidth="1.7" strokeLinecap="round" />
        </>
      );

    case "astro-rose":
      return (
        <>
          <rect width="64" height="64" fill="#2A0F24" />
          <circle cx="16" cy="14" r="14" fill="#EC4899" opacity="0.38" />
          <circle cx="50" cy="20" r="1.5" fill="#FDE047" />
          <circle cx="14" cy="48" r="1.5" fill="#F9A8D4" />
          <path d="M14 64 C15 50 22 46 32 46 C42 46 49 50 50 64 Z" fill="#FDF2F8" />
          <rect x="26" y="51" width="12" height="6" rx="3" fill="#EC4899" />
          <circle cx="32" cy="33" r="16.5" fill="#FCE7F3" />
          <ellipse cx="32" cy="33.5" rx="12.5" ry="10.5" fill="#3B0764" />
          <circle cx="26.8" cy="33" r="2.6" fill="#F472B6" />
          <circle cx="27.6" cy="32.1" r="0.9" fill="#FFFFFF" />
          <path d="M34.2 33.4 Q37.2 30.6 40.2 33.4" fill="none" stroke="#F472B6" strokeWidth="2.1" strokeLinecap="round" />
          <path d="M29 38.2 Q32 40.2 35 38.2" fill="none" stroke="#FDE68A" strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
  }
}

interface ProfileAvatarProps {
  avatarId: AvatarId;
  size?: number;
  className?: string;
  title?: string;
}

export function AvatarSvg({
  avatarId,
  className = "w-full h-full block",
}: {
  avatarId: AvatarId;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
    >
      <AvatarIllustration id={avatarId} />
    </svg>
  );
}

export function ProfileAvatar({
  avatarId,
  size = 32,
  className = "",
  title,
}: ProfileAvatarProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <AvatarSvg avatarId={avatarId} />
    </span>
  );
}

interface AvatarPickerProps {
  value: AvatarId;
  onChange: (avatarId: AvatarId) => void;
  compact?: boolean;
  onStudioModeChange?: (active: boolean) => void;
}

const CATEGORY_TABS: ReadonlyArray<{ value: "all" | AvatarCategory; label: string }> = [
  { value: "all", label: "All" },
  { value: "girls", label: "Girls" },
  { value: "boys", label: "Boys" },
  { value: "characters", label: "Mascots" },
];

const COLLAPSED_GRID_LIMIT = 16;

export function AvatarPicker({
  value,
  onChange,
  compact = false,
  onStudioModeChange,
}: AvatarPickerProps) {
  const [filter, setFilter] = useState<"all" | AvatarCategory>("all");
  const [expanded, setExpanded] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioInitialId, setStudioInitialId] = useState<CustomAvatarId>(() =>
    isValidCustomAvatarId(value) ? value : encodeCustomAvatar(presetToStartingRecipe(value)),
  );
  const [editingSlotId, setEditingSlotId] = useState<CustomAvatarId | null>(null);
  const [savedCustoms, setSavedCustoms] = useState<CustomAvatarId[]>(() =>
    loadSavedCustomAvatars(),
  );
  const extraPresence = useAnimatedPresence(expanded, 340);

  useEffect(() => {
    if (isValidCustomAvatarId(value) && !savedCustoms.includes(value)) {
      const next = upsertSavedCustomAvatar(savedCustoms, value);
      setSavedCustoms(next);
      saveCustomAvatarsList(next);
    }
  }, [value, savedCustoms]);

  const setStudioActive = (active: boolean) => {
    setStudioOpen(active);
    onStudioModeChange?.(active);
  };

  const openStudioFor = (initial: CustomAvatarId, replaceSlot: CustomAvatarId | null) => {
    setStudioInitialId(initial);
    setEditingSlotId(replaceSlot);
    onChange(initial);
    const nextSaved = upsertSavedCustomAvatar(savedCustoms, initial, replaceSlot);
    setSavedCustoms(nextSaved);
    saveCustomAvatarsList(nextSaved);
    setEditingSlotId(initial);
    setStudioActive(true);
  };

  const handleCustomizeClick = () => {
    if (isValidCustomAvatarId(value)) {
      openStudioFor(value, value);
    } else {
      const starter = encodeCustomAvatar(presetToStartingRecipe(value));
      openStudioFor(starter, null);
    }
  };

  const handleNewCustomClick = () => {
    const fresh = encodeCustomAvatar(randomizeCustomRecipe("girl"));
    openStudioFor(fresh, null);
  };

  const handleStudioChange = (nextId: CustomAvatarId) => {
    onChange(nextId);
    const nextSaved = upsertSavedCustomAvatar(savedCustoms, nextId, editingSlotId);
    setSavedCustoms(nextSaved);
    saveCustomAvatarsList(nextSaved);
    setEditingSlotId(nextId);
  };

  const handleDeleteSavedCustom = (targetId: CustomAvatarId) => {
    const nextSaved = removeSavedCustomAvatar(savedCustoms, targetId);
    setSavedCustoms(nextSaved);
    saveCustomAvatarsList(nextSaved);
    if (value === targetId) {
      onChange(nextSaved[0] ?? DEFAULT_AVATAR_ID);
    }
  };

  if (studioOpen) {
    return (
      <AvatarCustomizerStudio
        initialId={studioInitialId}
        onChange={handleStudioChange}
        onBack={() => setStudioActive(false)}
        compact={compact}
      />
    );
  }

  const visiblePresets =
    filter === "all"
      ? AVATAR_PRESETS
      : AVATAR_PRESETS.filter((preset) => preset.category === filter);

  const needsCollapse = visiblePresets.length > COLLAPSED_GRID_LIMIT;
  const previewLimit = COLLAPSED_GRID_LIMIT - 1;
  const hiddenCount = Math.max(0, visiblePresets.length - previewLimit);
  const avatarSize = compact ? 48 : 54;
  const gridGapClass = compact ? "gap-1.5" : "gap-2";

  const selectedPreset = visiblePresets.find((p) => p.id === value) ?? null;
  const basePreview = visiblePresets.slice(0, previewLimit);
  const inBasePreview = basePreview.some((p) => p.id === value);

  // Keep the 15 visible preview tiles crisp; if collapsed while holding a late character, pin it in slot 15.
  const topPresets = (() => {
    if (!needsCollapse) return visiblePresets;
    if (expanded || extraPresence.mounted || inBasePreview || !selectedPreset) {
      return basePreview;
    }
    return [...visiblePresets.slice(0, previewLimit - 1), selectedPreset];
  })();

  const slot16Preset = needsCollapse ? visiblePresets[previewLimit] ?? null : null;
  const extraPresets = needsCollapse ? visiblePresets.slice(COLLAPSED_GRID_LIMIT) : [];

  const handleRandomAvatar = () => {
    const others = AVATAR_PRESETS.filter((p) => p.id !== value);
    const chosen = others[Math.floor(Math.random() * others.length)] ?? AVATAR_PRESETS[0];
    onChange(chosen.id);
  };

  const renderPresetTile = (
    preset: AvatarPreset,
    opts?: { extraClass?: string; hidden?: boolean; revealed?: boolean },
  ) => {
    const selected = preset.id === value;
    const isHidden = Boolean(opts?.hidden);
    return (
      <button
        key={preset.id}
        type="button"
        onClick={() => onChange(preset.id)}
        aria-label={preset.label}
        aria-pressed={selected}
        aria-hidden={isHidden || undefined}
        tabIndex={isHidden ? -1 : undefined}
        data-revealed={
          opts?.revealed === undefined ? undefined : opts.revealed ? "true" : "false"
        }
        title={preset.label}
        className={`ep-press rounded-2xl py-2 px-1 flex items-center justify-center cursor-pointer ${
          selected
            ? "bg-accent/25 ring-2 ring-accent-soft text-white shadow-[0_6px_18px_rgba(124,58,237,0.3)]"
            : "bg-white/[0.045] hover:bg-white/[0.09] text-secondary hover:text-white"
        } ${opts?.extraClass ?? ""}`}
      >
        <ProfileAvatar avatarId={preset.id} size={avatarSize} />
      </button>
    );
  };

  const isCustomActive = isValidCustomAvatarId(value);

  return (
    <div className="anim-tab-in space-y-3">
      <div className="flex items-center justify-between gap-1.5 min-w-0">
        <SegmentedTabs
          ariaLabel="Avatar style category"
          size="xs"
          className="min-w-0"
          value={filter}
          items={CATEGORY_TABS}
          onChange={(next) => {
            setFilter(next);
            setExpanded(false);
          }}
        />

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleRandomAvatar}
            title="Pick a random look"
            aria-label="Pick a random look"
            className="ep-glass-pill ep-press h-8 w-8 rounded-full inline-flex items-center justify-center text-secondary hover:text-white cursor-pointer"
          >
            <AppShuffleIcon size={13} />
          </button>

          <button
            type="button"
            onClick={handleCustomizeClick}
            title={isCustomActive ? "Edit custom character in Studio" : "Create custom character"}
            className="ep-glass-pill-active ep-press h-8 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-semibold text-white whitespace-nowrap cursor-pointer"
          >
            {isCustomActive ? (
              <AppEditIcon size={12} className="text-white/90 shrink-0" />
            ) : (
              <AppStudioIcon size={13} className="text-white/90 shrink-0" />
            )}
            <span>Custom</span>
          </button>
        </div>
      </div>

      {savedCustoms.length > 0 && (
        <div className="ep-glass-well rounded-2xl p-2.5 space-y-2">
          <div className="flex items-center justify-between px-0.5">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
              <AppCustomCharsIcon size={13} className="text-accent-soft" />
              <span>My Characters</span>
            </span>
            <span className="text-[10px] text-muted num">
              {savedCustoms.length}/{MAX_SAVED_CUSTOM_AVATARS}
            </span>
          </div>
          <div className={`grid grid-cols-4 ${gridGapClass}`}>
            {savedCustoms.map((customId, idx) => {
              const selected = value === customId;
              return (
                <div key={customId} className="relative group">
                  <button
                    type="button"
                    onClick={() => onChange(customId)}
                    aria-label={`Custom Character ${idx + 1}`}
                    aria-pressed={selected}
                    className={`ep-press w-full rounded-2xl py-2 px-1 flex items-center justify-center cursor-pointer ${
                      selected
                        ? "bg-accent/25 ring-2 ring-accent-soft text-white shadow-[0_6px_18px_rgba(124,58,237,0.3)]"
                        : "bg-white/[0.045] hover:bg-white/[0.09] text-secondary hover:text-white"
                    }`}
                  >
                    <ProfileAvatar avatarId={customId} size={avatarSize} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSavedCustom(customId);
                    }}
                    aria-label="Remove saved character"
                    title="Remove saved character"
                    className="ep-bar-icon-btn ep-press opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[#1a1828] border border-white/15 text-secondary hover:text-white flex items-center justify-center cursor-pointer"
                  >
                    <AppCloseIcon size={10} />
                  </button>
                </div>
              );
            })}

            {savedCustoms.length < MAX_SAVED_CUSTOM_AVATARS && (
              <button
                type="button"
                onClick={handleNewCustomClick}
                aria-label="Create new custom character"
                title="Create new character"
                className="ep-press rounded-2xl py-2 px-1 flex items-center justify-center bg-white/[0.045] hover:bg-white/[0.09] text-secondary hover:text-white cursor-pointer"
              >
                <span
                  style={{ width: avatarSize, height: avatarSize }}
                  className="rounded-full bg-white/[0.05] border border-white/10 flex items-center justify-center"
                >
                  <AppPlusIcon size={18} />
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      <div>
        <div className={`grid grid-cols-4 ${gridGapClass}`}>
          {topPresets.map((preset) => renderPresetTile(preset))}

          {needsCollapse && slot16Preset && (
            <div className="relative">
              {renderPresetTile(slot16Preset, {
                extraClass: "ep-avatar-reveal-tile w-full",
                hidden: !expanded,
                revealed: expanded,
              })}
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  setExpanded(true);
                }}
                aria-expanded={expanded}
                aria-hidden={expanded || undefined}
                inert={expanded || undefined}
                tabIndex={expanded ? -1 : undefined}
                aria-label={`Show ${hiddenCount} more characters`}
                title={`Show ${hiddenCount} more characters`}
                data-revealed={expanded ? "true" : "false"}
                className="ep-avatar-more-slot ep-press absolute inset-0 rounded-2xl py-2 px-1 flex items-center justify-center cursor-pointer"
              >
                <span
                  style={{ width: avatarSize, height: avatarSize }}
                  className="ep-avatar-more-orb relative overflow-hidden rounded-full flex flex-col items-center justify-center text-white/95"
                >
                  <span className="relative z-10 text-[12.5px] font-bold leading-none num">+{hiddenCount}</span>
                  <span className="relative z-10 text-[9.5px] font-medium leading-tight text-secondary">more</span>
                </span>
              </button>
            </div>
          )}
        </div>

        {needsCollapse && (
          <AnimatedCollapse
            open={expanded}
            durationMs={340}
            className="ep-collapse-liquid -mx-1"
            innerClassName={`px-1 pb-1 ${compact ? "pt-1.5" : "pt-2"} space-y-2.5`}
          >
            <div className={`grid grid-cols-4 ${gridGapClass}`}>
              {extraPresets.map((preset) => renderPresetTile(preset))}
            </div>

            <div className="flex justify-center pt-0.5">
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-expanded={expanded}
                className="ep-glass-pill ep-press h-7.5 px-3.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
              >
                <span>Show fewer</span>
                <AppChevronIcon direction="down" size={11} className="rotate-180" />
              </button>
            </div>
          </AnimatedCollapse>
        )}
      </div>
    </div>
  );
}
