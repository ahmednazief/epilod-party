import { Shuffle } from "lucide-react";
import { useState, type ReactNode } from "react";

export type AvatarCategory = "girls" | "boys" | "characters";

export type AvatarId =
  | "nova"
  | "luna"
  | "sakura"
  | "maya"
  | "leo"
  | "kai"
  | "omar"
  | "zayd"
  | "snoo-violet"
  | "snoo-cinema"
  | "mochi-cat"
  | "astro-pip";

export interface AvatarPreset {
  id: AvatarId;
  label: string;
  category: AvatarCategory;
}

export const AVATAR_PRESETS: readonly AvatarPreset[] = [
  { id: "nova", label: "Nova", category: "girls" },
  { id: "luna", label: "Luna", category: "girls" },
  { id: "sakura", label: "Sakura", category: "girls" },
  { id: "maya", label: "Maya", category: "girls" },
  { id: "leo", label: "Leo", category: "boys" },
  { id: "kai", label: "Kai", category: "boys" },
  { id: "omar", label: "Omar", category: "boys" },
  { id: "zayd", label: "Zayd", category: "boys" },
  { id: "snoo-violet", label: "PopBot", category: "characters" },
  { id: "snoo-cinema", label: "Cinema", category: "characters" },
  { id: "mochi-cat", label: "Mochi", category: "characters" },
  { id: "astro-pip", label: "Astro", category: "characters" },
] as const;

export const DEFAULT_AVATAR_ID: AvatarId = "snoo-violet";

const VALID_AVATAR_IDS = new Set<string>(AVATAR_PRESETS.map((p) => p.id));

export function isValidAvatarId(raw: string): raw is AvatarId {
  return VALID_AVATAR_IDS.has(raw);
}

export function resolvePeerAvatarId(
  peerUsername: string,
  localUsername?: string,
  localAvatarId: AvatarId = DEFAULT_AVATAR_ID,
): AvatarId {
  const cleanPeer = peerUsername.trim().toLowerCase();
  const cleanLocal = (localUsername ?? "").trim().toLowerCase();
  if (cleanPeer && cleanLocal && cleanPeer === cleanLocal) {
    return localAvatarId;
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
          <path d="M44 21 L56 23 L55 27 L44 25 Z" fill="#D97706" />
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
          <path d="M14 64 C15 50 22 46 32 46 C42 46 49 50 50 64 Z" fill="#E2E8F0" />
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
  }
}

interface ProfileAvatarProps {
  avatarId: AvatarId;
  size?: number;
  className?: string;
}

export function ProfileAvatar({ avatarId, size = 32, className = "" }: ProfileAvatarProps) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 64 64" className="w-full h-full block" aria-hidden="true">
        <AvatarIllustration id={avatarId} />
      </svg>
    </span>
  );
}

interface AvatarPickerProps {
  value: AvatarId;
  onChange: (avatarId: AvatarId) => void;
  compact?: boolean;
}

const CATEGORY_TABS: ReadonlyArray<{ value: "all" | AvatarCategory; label: string }> = [
  { value: "all", label: "All" },
  { value: "girls", label: "Girls" },
  { value: "boys", label: "Boys" },
  { value: "characters", label: "Mascots" },
];

export function AvatarPicker({ value, onChange, compact = false }: AvatarPickerProps) {
  const [filter, setFilter] = useState<"all" | AvatarCategory>("all");

  const visiblePresets =
    filter === "all"
      ? AVATAR_PRESETS
      : AVATAR_PRESETS.filter((preset) => preset.category === filter);

  const handleRandomAvatar = () => {
    const others = AVATAR_PRESETS.filter((p) => p.id !== value);
    const chosen = others[Math.floor(Math.random() * others.length)] ?? AVATAR_PRESETS[0];
    onChange(chosen.id);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="ep-glass-input p-0.5 rounded-full inline-flex items-center gap-0.5">
          {CATEGORY_TABS.map((cat) => {
            const active = filter === cat.value;
            return (
              <button
                key={cat.value}
                type="button"
                onClick={() => setFilter(cat.value)}
                className={`ep-press whitespace-nowrap px-2.5 py-1 rounded-full text-[11px] font-medium cursor-pointer transition-colors ${
                  active ? "ep-droplet-indicator text-white" : "text-muted hover:text-primary"
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={handleRandomAvatar}
          title="Pick a random look"
          className="ep-press whitespace-nowrap shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.07] hover:bg-white/[0.13] text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
        >
          <Shuffle className="h-3 w-3" />
          <span>Surprise me</span>
        </button>
      </div>

      <div className={`grid grid-cols-4 ${compact ? "gap-1.5" : "gap-2"}`}>
        {visiblePresets.map((preset) => {
          const selected = preset.id === value;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange(preset.id)}
              aria-pressed={selected}
              className={`ep-press rounded-2xl py-2 px-1 flex flex-col items-center gap-1 cursor-pointer transition-colors ${
                selected
                  ? "bg-accent/25 ring-2 ring-accent-soft text-white"
                  : "bg-white/[0.04] hover:bg-white/[0.09] text-secondary hover:text-white"
              }`}
            >
              <ProfileAvatar avatarId={preset.id} size={compact ? 34 : 38} />
              <span className="text-[10px] font-medium leading-none truncate max-w-full">
                {preset.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
