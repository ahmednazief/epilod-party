import { useId } from "react";

interface PlayerIconProps {
  size?: number;
  className?: string;
}

/**
 * Custom sculpted crystal Play triangle for the hero center orb.
 * Pure white, bold, optically centered rounded triangle with subtle amethyst refraction.
 */
export function PlayerPlayIcon({ size = 24, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const sheenId = `ep-play-sheen-${uid}`;
  const clipId = `ep-play-clip-${uid}`;

  // Bold optically centered rounded play triangle (x=8.5..19.2, y=5.4..18.6)
  const corePath =
    "M8.5 6.35Q8.5 5 9.65 5.71L18.65 11.29Q19.8 12 18.65 12.71L9.65 18.29Q8.5 19 8.5 17.65V6.35Z";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={sheenId} x1="8.5" y1="5" x2="19.8" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.08" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={corePath} />
        </clipPath>
      </defs>
      <path d={corePath} fill="#FFFFFF" />
      <g clipPath={`url(#${clipId})`}>
        <path d={corePath} fill={`url(#${sheenId})`} />
      </g>
    </svg>
  );
}

/**
 * Custom sculpted crystal Pause pillars for the hero center orb.
 * Crisp integer-aligned pillars matched in height and weight to Play.
 */
export function PlayerPauseIcon({ size = 24, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const sheenId = `ep-pause-sheen-${uid}`;
  const clipId = `ep-pause-clip-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={sheenId} x1="6.8" y1="5.25" x2="17.2" y2="18.75" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.08" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x="6.8" y="5.25" width="3.8" height="13.5" rx="1.25" />
          <rect x="13.4" y="5.25" width="3.8" height="13.5" rx="1.25" />
        </clipPath>
      </defs>
      <rect x="6.8" y="5.25" width="3.8" height="13.5" rx="1.25" fill="#FFFFFF" />
      <rect x="13.4" y="5.25" width="3.8" height="13.5" rx="1.25" fill="#FFFFFF" />
      <g clipPath={`url(#${clipId})`}>
        <rect x="6.8" y="5.25" width="3.8" height="13.5" rx="1.25" fill={`url(#${sheenId})`} />
        <rect x="13.4" y="5.25" width="3.8" height="13.5" rx="1.25" fill={`url(#${sheenId})`} />
      </g>
    </svg>
  );
}

/**
 * Crisp 1:1 10s backward / forward jump icon with uniform monochrome strokes,
 * clean solid directional arrowhead, and balanced geometric "10" typography.
 */
export function PlayerSeekIcon({
  direction,
  size = 24,
  className = "",
}: PlayerIconProps & { direction: "back" | "forward" }) {
  const isBack = direction === "back";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {isBack ? (
        <>
          <path
            d="M5.52 9.33A7.15 7.15 0 1 0 11.75 5.20"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
          />
          <path d="M8.55 5.20L11.85 3.05V7.35Z" fill="currentColor" />
        </>
      ) : (
        <>
          <path
            d="M18.48 9.33A7.15 7.15 0 1 1 12.25 5.20"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
          />
          <path d="M15.45 5.20L12.15 3.05V7.35Z" fill="currentColor" />
        </>
      )}
      <path
        d="M8.2 10.85L9.65 9.65V15.15"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="11.95"
        y="9.65"
        width="3.5"
        height="5.5"
        rx="1.75"
        stroke="currentColor"
        strokeWidth="1.55"
      />
    </svg>
  );
}

/**
 * Crisp monochrome episode step icon (previous / next) with subtle crystal clip depth.
 */
export function PlayerSkipEpisodeIcon({
  direction,
  size = 18,
  className = "",
}: PlayerIconProps & { direction: "prev" | "next" }) {
  const uid = useId().replace(/:/g, "");
  const sheenId = `ep-skip-facet-${uid}`;
  const clipId = `ep-skip-clip-${uid}`;
  const isPrev = direction === "prev";

  const barX = isPrev ? 5.5 : 16.3;
  const triPath = isPrev
    ? "M18.5 7.1Q18.5 6 17.55 6.6L9.9 11.4Q9.05 12 9.9 12.6L17.55 17.4Q18.5 18 18.5 16.9V7.1Z"
    : "M5.5 7.1Q5.5 6 6.45 6.6L14.1 11.4Q14.95 12 14.1 12.6L6.45 17.4Q5.5 18 5.5 16.9V7.1Z";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={sheenId} x1="5.5" y1="6" x2="18.5" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.03" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x={barX} y="6" width="2.2" height="12" rx="1.1" />
          <path d={triPath} />
        </clipPath>
      </defs>
      <rect x={barX} y="6" width="2.2" height="12" rx="1.1" fill="currentColor" />
      <path d={triPath} fill="currentColor" />
      <g clipPath={`url(#${clipId})`}>
        <rect x="5" y="5.5" width="14" height="13" fill={`url(#${sheenId})`} />
      </g>
    </svg>
  );
}

/**
 * Custom sculpted liquid-glass acoustic volume icon that morphs smoothly between mute and unmute.
 */
export function PlayerVolumeIcon({
  muted,
  size = 17,
  className = "",
}: PlayerIconProps & { muted: boolean }) {
  const uid = useId().replace(/:/g, "");
  const bodyId = `ep-vol-body-${uid}`;
  const mutedBodyId = `ep-vol-muted-${uid}`;
  const sheenId = `ep-vol-sheen-${uid}`;
  const waveId = `ep-vol-wave-${uid}`;
  const muteGradId = `ep-vol-x-${uid}`;
  const clipId = `ep-vol-clip-${uid}`;

  const conePath =
    "M3.75 10.05C3.75 9.22 4.42 8.55 5.25 8.55H7.75L11.8 5.22C12.46 4.68 13.45 5.15 13.45 5.99V18.01C13.45 18.85 12.46 19.32 11.8 18.78L7.75 15.45H5.25C4.42 15.45 3.75 14.78 3.75 13.95V10.05Z";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-muted={muted ? "true" : "false"}
      className={`ep-vol-icon ${className}`}
    >
      <defs>
        <linearGradient id={bodyId} x1="3.75" y1="5" x2="13.5" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="52%" stopColor="#E9D5FF" />
          <stop offset="100%" stopColor="#A78BFA" />
        </linearGradient>
        <linearGradient id={mutedBodyId} x1="3.75" y1="6" x2="13.5" y2="18.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#CBD5E1" stopOpacity="0.92" />
          <stop offset="100%" stopColor="#64748B" stopOpacity="0.88" />
        </linearGradient>
        <linearGradient id={sheenId} x1="4" y1="5" x2="12" y2="13" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.78" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={waveId} x1="17" y1="6" x2="21" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EDE9FE" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
        <linearGradient id={muteGradId} x1="16" y1="9" x2="21" y2="15" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FECDD3" />
          <stop offset="100%" stopColor="#FB7185" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={conePath} />
        </clipPath>
      </defs>

      <g className="ep-vol-speaker">
        <path d={conePath} fill={`url(#${mutedBodyId})`} />
        <g clipPath={`url(#${clipId})`}>
          <path
            d="M2.5 9.6C5.6 8.2 9.4 11.2 14.5 9.1V20.5H2.5V9.6Z"
            fill={`url(#${bodyId})`}
            className="ep-vol-liquid"
          />
          <polygon
            points="3,4.5 14,4.5 14,11.6 3,13.4"
            fill={`url(#${sheenId})`}
            className="ep-vol-sheen"
          />
          <path
            d={conePath}
            stroke="#FFFFFF"
            strokeOpacity="0.52"
            strokeWidth="0.95"
            strokeLinejoin="round"
          />
        </g>
      </g>

      <path
        d="M15.95 9.0C17.35 10.6 17.35 13.4 15.95 15.0"
        pathLength={1}
        stroke="#F8FAFC"
        strokeWidth="1.95"
        strokeLinecap="round"
        className="ep-vol-wave ep-vol-wave-1"
      />
      <path
        d="M18.75 6.45C21.05 9.6 21.05 14.4 18.75 17.55"
        pathLength={1}
        stroke={`url(#${waveId})`}
        strokeWidth="1.9"
        strokeLinecap="round"
        className="ep-vol-wave ep-vol-wave-2"
      />

      <g className="ep-vol-mute-x">
        <path
          d="M16.25 9.15L20.85 14.85"
          pathLength={1}
          stroke={`url(#${muteGradId})`}
          strokeWidth="2.05"
          strokeLinecap="round"
          className="ep-vol-slash ep-vol-slash-1"
        />
        <path
          d="M20.85 9.15L16.25 14.85"
          pathLength={1}
          stroke={`url(#${muteGradId})`}
          strokeWidth="2.05"
          strokeLinecap="round"
          className="ep-vol-slash ep-vol-slash-2"
        />
      </g>
    </svg>
  );
}

/**
 * Custom crystal captions screen icon with stepped subtitle bars.
 */
export function PlayerCaptionsIcon({
  active = false,
  size = 18,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-cc-plate-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="2.5" y1="4.5" x2="21.5" y2="19.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#6D28D9" stopOpacity="0.24" />
        </linearGradient>
      </defs>
      <rect
        x="2.5"
        y="4.5"
        width="19"
        height="15"
        rx="3.5"
        fill={active ? `url(#${plateId})` : "#FFFFFF"}
        fillOpacity={active ? "1" : "0.06"}
        stroke={active ? "#DDD6FE" : "#E2E8F0"}
        strokeOpacity={active ? "0.95" : "0.78"}
        strokeWidth="1.6"
      />
      {/* Stepped luminous subtitle bars inside screen frame */}
      <rect x="5.5" y="8.8" width="8.5" height="2" rx="1" fill="#FFFFFF" />
      <rect
        x="15.2"
        y="8.8"
        width="3.3"
        height="2"
        rx="1"
        fill={active ? "#DDD6FE" : "#C4B5FD"}
        fillOpacity={active ? "1" : "0.85"}
      />
      <rect
        x="5.5"
        y="13.2"
        width="4"
        height="2"
        rx="1"
        fill={active ? "#DDD6FE" : "#C4B5FD"}
        fillOpacity={active ? "1" : "0.85"}
      />
      <rect x="10.7" y="13.2" width="7.8" height="2" rx="1" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Custom sculpted acoustic waveform icon for Audio & Playback with golden-ratio symmetry.
 */
export function PlayerAudioIcon({
  active = false,
  size = 17,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const centerId = `ep-aud-center-${uid}`;
  const midId = `ep-aud-mid-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={centerId} x1="12" y1="3.5" x2="12" y2="20.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#A78BFA" : "#DDD6FE"} />
        </linearGradient>
        <linearGradient id={midId} x1="8" y1="6" x2="8" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#F8FAFC" />
          <stop offset="100%" stopColor={active ? "#C4B5FD" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      {/* Harmonious 5-bar acoustic waveform */}
      <rect x="3.5" y="9.4" width="2.2" height="5.2" rx="1.1" fill={active ? "#DDD6FE" : "#CBD5E1"} />
      <rect x="7.2" y="6.4" width="2.2" height="11.2" rx="1.1" fill={`url(#${midId})`} />
      <rect x="10.9" y="3.4" width="2.2" height="17.2" rx="1.1" fill={`url(#${centerId})`} />
      <rect x="14.6" y="6.4" width="2.2" height="11.2" rx="1.1" fill={`url(#${midId})`} />
      <rect x="18.3" y="9.4" width="2.2" height="5.2" rx="1.1" fill={active ? "#DDD6FE" : "#CBD5E1"} />
    </svg>
  );
}

/**
 * Custom stacked crystal season queue icon matching OpenMediaIcon language.
 */
export function PlayerEpisodesIcon({
  active = false,
  size = 18,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const cardId = `ep-eps-card-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={cardId} x1="5" y1="9" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={active ? "#C4B5FD" : "#475569"} stopOpacity={active ? "0.92" : "0.72"} />
          <stop offset="100%" stopColor={active ? "#6D28D9" : "#1E293B"} stopOpacity={active ? "0.92" : "0.82"} />
        </linearGradient>
      </defs>
      {/* Back stack cards */}
      <rect
        x="6"
        y="3.5"
        width="12"
        height="2.2"
        rx="1.1"
        fill={active ? "#DDD6FE" : "#CBD5E1"}
        fillOpacity={active ? "0.58" : "0.42"}
      />
      <rect
        x="4"
        y="6.6"
        width="16"
        height="2.4"
        rx="1.2"
        fill="#C4B5FD"
        fillOpacity={active ? "0.78" : "0.52"}
      />
      {/* Front active episode frame */}
      <rect
        x="2.5"
        y="9.8"
        width="19"
        height="11.2"
        rx="3.2"
        fill={`url(#${cardId})`}
        stroke={active ? "#F5F3FF" : "#E2E8F0"}
        strokeOpacity={active ? "0.9" : "0.72"}
        strokeWidth="1.4"
      />
      <path
        d="M10.4 13.1C10.4 12.65 10.9 12.38 11.28 12.62L14.95 14.92C15.3 15.14 15.3 15.66 14.95 15.88L11.28 18.18C10.9 18.42 10.4 18.15 10.4 17.7V13.1Z"
        fill={active ? "#FFFFFF" : "#EDE9FE"}
      />
    </svg>
  );
}

/**
 * Custom glossy Ready / Check badge icon.
 */
export function PlayerReadyIcon({
  ready,
  size = 16,
  className = "",
}: PlayerIconProps & { ready: boolean }) {
  const uid = useId().replace(/:/g, "");
  const okId = `ep-ready-ok-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={okId} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6EE7B7" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
      </defs>
      {ready ? (
        <>
          <circle cx="12" cy="12" r="9.5" fill={`url(#${okId})`} stroke="#ECFDF5" strokeOpacity="0.55" strokeWidth="1" />
          <path
            d="M8 12.2L10.8 15L16.2 9.2"
            stroke="#FFFFFF"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8.8" fill="#FFFFFF" fillOpacity="0.06" stroke="#CBD5E1" strokeOpacity="0.68" strokeWidth="1.6" />
          <circle cx="12" cy="12" r="2.6" fill="#C4B5FD" fillOpacity="0.78" />
        </>
      )}
    </svg>
  );
}

/**
 * Custom orbital Sync / Resync badge icon.
 */
export function PlayerResyncIcon({
  tone = "ok",
  size = 16,
  className = "",
}: PlayerIconProps & { tone?: "ok" | "warn" | "bad" | "syncing" }) {
  const primary = tone === "bad" ? "#FDA4AF" : tone === "warn" ? "#FCD34D" : "#FFFFFF";
  const accent = tone === "bad" ? "#FB7185" : tone === "warn" ? "#F59E0B" : "#A78BFA";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M5.2 10.6C5.9 7.1 9 4.5 12.6 4.7C15.1 4.9 17.3 6.3 18.4 8.4"
        stroke={primary}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M18.9 5.1V8.9H15.1" stroke={primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M18.8 13.4C18.1 16.9 15 19.5 11.4 19.3C8.9 19.1 6.7 17.7 5.6 15.6"
        stroke={accent}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M5.1 18.9V15.1H8.9" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.1" fill={primary} />
    </svg>
  );
}

/**
 * Custom iris lens icon for showing/hiding friend avatars.
 */
export function PlayerEyeIcon({
  hidden,
  size = 15,
  className = "",
}: PlayerIconProps & { hidden: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M2.6 12C4.7 8.1 8.1 6.2 12 6.2C15.9 6.2 19.3 8.1 21.4 12C19.3 15.9 15.9 17.8 12 17.8C8.1 17.8 4.7 15.9 2.6 12Z"
        fill="#8B5CF6"
        fillOpacity="0.18"
        stroke="#DDD6FE"
        strokeOpacity={hidden ? "0.5" : "0.85"}
        strokeWidth="1.7"
      />
      <circle cx="12" cy="12" r="3.1" fill={hidden ? "#A78BFA" : "#FFFFFF"} />
      {hidden && (
        <path d="M4.5 19.5L19.5 4.5" stroke="#C4B5FD" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * Custom obsidian-silver + amethyst core Preferences aperture icon.
 */
export function PlayerSettingsIcon({ size = 18, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const rimId = `ep-gear-rim-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={rimId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#CBD5E1" />
        </linearGradient>
      </defs>
      <path
        d="M18.77 10.23L21.20 10.66L21.20 13.34L18.77 13.77L18.04 15.54L19.46 17.56L17.56 19.46L15.54 18.04L13.77 18.77L13.34 21.20L10.66 21.20L10.23 18.77L8.46 18.04L6.44 19.46L4.54 17.56L5.96 15.54L5.23 13.77L2.80 13.34L2.80 10.66L5.23 10.23L5.96 8.46L4.54 6.44L6.44 4.54L8.46 5.96L10.23 5.23L10.66 2.80L13.34 2.80L13.77 5.23L15.54 5.96L17.56 4.54L19.46 6.44L18.04 8.46Z"
        fill="#8B5CF6"
        fillOpacity="0.22"
        stroke={`url(#${rimId})`}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.1" fill="#C4B5FD" stroke="#FFFFFF" strokeWidth="1.35" />
    </svg>
  );
}

/**
 * Custom corner bezel brackets for Fullscreen / Windowed toggle.
 */
export function PlayerFullscreenIcon({
  isFullscreen,
  size = 16,
  className = "",
}: PlayerIconProps & { isFullscreen: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {isFullscreen ? (
        <>
          <path d="M9 4.5V8.5C9 8.78 8.78 9 8.5 9H4.5" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M15 4.5V8.5C15 8.78 15.22 9 15.5 9H19.5" stroke="#C4B5FD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 19.5V15.5C9 15.22 8.78 15 8.5 15H4.5" stroke="#C4B5FD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M15 19.5V15.5C15 15.22 15.22 15 15.5 15H19.5" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path d="M4.5 9V5.5C4.5 4.95 4.95 4.5 5.5 4.5H9" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M19.5 9V5.5C19.5 4.95 19.05 4.5 18.5 4.5H15" stroke="#C4B5FD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 15V18.5C4.5 19.05 4.95 19.5 5.5 19.5H9" stroke="#C4B5FD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M19.5 15V18.5C19.5 19.05 19.05 19.5 18.5 19.5H15" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

/**
 * Custom crystal overlapping sheets Copy / Copied icon for Watch Party passcode.
 */
export function PartyCopyIcon({
  copied = false,
  size = 15,
  className = "",
}: PlayerIconProps & { copied?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {copied ? (
        <>
          <circle cx="12" cy="12" r="9" fill="#10B981" fillOpacity="0.18" stroke="#34D399" strokeWidth="1.6" />
          <path d="M8.3 12.3L10.9 14.9L16 9.5" stroke="#6EE7B7" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path
            d="M8.5 6.8V5.6C8.5 4.44 9.44 3.5 10.6 3.5H18.4C19.56 3.5 20.5 4.44 20.5 5.6V13.4C20.5 14.56 19.56 15.5 18.4 15.5H17.2"
            stroke="#C4B5FD"
            strokeOpacity="0.8"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <rect
            x="3.5"
            y="8.5"
            width="12"
            height="12"
            rx="2.8"
            fill="#FFFFFF"
            fillOpacity="0.08"
            stroke="#F8FAFC"
            strokeWidth="1.7"
          />
        </>
      )}
    </svg>
  );
}

/**
 * Custom Watch Party portal exit icon (inherits hover tone cleanly).
 */
export function PartyLeaveIcon({ size = 15, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M11 4.5H7.2C5.7 4.5 4.5 5.7 4.5 7.2V16.8C4.5 18.3 5.7 19.5 7.2 19.5H11"
        stroke="currentColor"
        strokeOpacity="0.72"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path d="M10.5 12H19.5" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
      <path d="M16.2 8.4L19.8 12L16.2 15.6" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Custom overlapping crystal silhouettes for Watch Party viewers section.
 */
export function PartyViewersIcon({ size = 15, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="16.4" cy="8.6" r="2.6" stroke="#C4B5FD" strokeOpacity="0.82" strokeWidth="1.55" />
      <path
        d="M15.8 13.7C18.3 13.9 20.4 15.4 20.8 18.1"
        stroke="#C4B5FD"
        strokeOpacity="0.82"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="9.6" cy="8.2" r="3.1" fill="#FFFFFF" fillOpacity="0.1" stroke="#F8FAFC" strokeWidth="1.7" />
      <path
        d="M3.6 18.7C4.1 15.6 6.5 14 9.6 14C12.7 14 15.1 15.6 15.6 18.7"
        stroke="#F8FAFC"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Custom miniature amethyst host crest icon.
 */
export function PartyHostIcon({ size = 12, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.2 17.5L5.6 7.8L10.1 11.6L12 5.6L13.9 11.6L18.4 7.8L19.8 17.5H4.2Z"
        fill="#A78BFA"
        fillOpacity="0.28"
        stroke="#DDD6FE"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom crystal clipboard paste icon for joining a Watch Party code.
 */
export function PartyPasteIcon({ size = 14, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect x="8.5" y="3.2" width="7" height="3.2" rx="1.6" fill="#C4B5FD" fillOpacity="0.35" stroke="#DDD6FE" strokeWidth="1.45" />
      <path
        d="M8.5 5H7.2C5.7 5 4.5 6.2 4.5 7.7V18.3C4.5 19.8 5.7 21 7.2 21H16.8C18.3 21 19.5 19.8 19.5 18.3V7.7C19.5 6.2 18.3 5 16.8 5H15.5"
        stroke="#F8FAFC"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
      <path d="M9 12.2H15" stroke="#C4B5FD" strokeWidth="1.65" strokeLinecap="round" />
      <path d="M9 15.8H13.2" stroke="#F8FAFC" strokeOpacity="0.85" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom signal-play host emblem for starting a Watch Party.
 */
export function PartyCreateIcon({ size = 16, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="8.8" fill="#FFFFFF" fillOpacity="0.1" stroke="#F8FAFC" strokeOpacity="0.88" strokeWidth="1.6" />
      <path d="M10.1 8.8L15.7 12L10.1 15.2V8.8Z" fill="#FFFFFF" />
      <path d="M18.4 4.2L20.1 5.9M4.2 5.9L5.9 4.2" stroke="#DDD6FE" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom dual-blade server switch icon for backup sync route fallback.
 */
export function PartyServerIcon({ size = 13, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect x="4" y="4.5" width="16" height="6" rx="2.2" fill="#FFFFFF" fillOpacity="0.08" stroke="#E2E8F0" strokeWidth="1.6" />
      <rect x="4" y="13.5" width="16" height="6" rx="2.2" fill="#A78BFA" fillOpacity="0.14" stroke="#C4B5FD" strokeWidth="1.6" />
      <circle cx="8" cy="7.5" r="1" fill="#F8FAFC" />
      <circle cx="8" cy="16.5" r="1" fill="#DDD6FE" />
    </svg>
  );
}

export function PlayerSkipIntroIcon({ size = 16, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.5 6.8L11.2 12L4.5 17.2V6.8Z"
        fill="#FFFFFF"
        fillOpacity="0.18"
        stroke="#F8FAFC"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M11.6 6.8L18.2 12L11.6 17.2V6.8Z"
        fill="#FFFFFF"
        fillOpacity="0.28"
        stroke="#F8FAFC"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M20.2 6.5V17.5"
        stroke="#F8FAFC"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * High-quality glossy 3D vector laughing emoji (😂) icon for live party reactions.
 */
export function PlayerReactionsIcon({
  active = false,
  size = 20,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const faceGradId = `ep-laugh-face-${uid}`;
  const glossGradId = `ep-laugh-gloss-${uid}`;
  const tongueGradId = `ep-laugh-tongue-${uid}`;
  const tearGradId = `ep-laugh-tear-${uid}`;
  const mouthClipId = `ep-laugh-mouth-${uid}`;

  const mouthPath =
    "M6.75 12.45Q12 13.25 17.25 12.45C17.6 12.4 17.8 12.75 17.64 13.28C16.78 16.55 14.68 18.45 12 18.45C9.32 18.45 7.22 16.55 6.36 13.28C6.2 12.75 6.4 12.4 6.75 12.45Z";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      data-active={active ? "true" : "false"}
      className={className}
    >
      <defs>
        <radialGradient id={faceGradId} cx="0.36" cy="0.28" r="0.72" fx="0.34" fy="0.24">
          <stop offset="0%" stopColor="#FFF8C5" />
          <stop offset="32%" stopColor="#FFE04B" />
          <stop offset="76%" stopColor="#F59E0B" />
          <stop offset="100%" stopColor="#D97706" />
        </radialGradient>
        <linearGradient id={glossGradId} x1="12" y1="2.4" x2="12" y2="10.2" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.62" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={tongueGradId} x1="12" y1="15.1" x2="12" y2="18.8" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FDA4AF" />
          <stop offset="100%" stopColor="#F43F5E" />
        </linearGradient>
        <linearGradient id={tearGradId} x1="0%" y1="0%" x2="85%" y2="100%">
          <stop offset="0%" stopColor="#F0F9FF" />
          <stop offset="42%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#0284C7" />
        </linearGradient>
        <clipPath id={mouthClipId}>
          <path d={mouthPath} />
        </clipPath>
      </defs>

      {/* Main sunlit sphere & crisp glass rim */}
      <circle
        cx="12"
        cy="12"
        r="9.45"
        fill={`url(#${faceGradId})`}
        stroke={active ? "#FEF08A" : "#FDE68A"}
        strokeOpacity={active ? "0.78" : "0.42"}
        strokeWidth="0.6"
      />
      <ellipse cx="12" cy="6.1" rx="6.4" ry="3.2" fill={`url(#${glossGradId})`} />

      {/* Warm cheek blush */}
      <ellipse cx="7.4" cy="12.75" rx="1.7" ry="0.95" fill="#FB7185" opacity="0.28" />
      <ellipse cx="16.6" cy="12.75" rx="1.7" ry="0.95" fill="#FB7185" opacity="0.28" />

      {/* Raised happy eyebrows & squinting laughing eyes */}
      <path d="M5.75 7.45Q7.4 6.05 9.15 6.85" stroke="#6B3410" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M18.25 7.45Q16.6 6.05 14.85 6.85" stroke="#6B3410" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M6.25 10.15Q8.05 7.85 9.85 10.15" stroke="#451E07" strokeWidth="1.65" strokeLinecap="round" />
      <path d="M14.15 10.15Q15.95 7.85 17.75 10.15" stroke="#451E07" strokeWidth="1.65" strokeLinecap="round" />

      {/* Open laughing mouth with upper teeth & rosy tongue */}
      <path d={mouthPath} fill="#591C13" />
      <g clipPath={`url(#${mouthClipId})`}>
        <path d="M6.2 12.1Q12 13.05 17.8 12.1L17.35 14.1Q12 14.65 6.65 14.1Z" fill="#FFFFFF" />
        <path d="M6.8 14.0Q12 14.55 17.2 14.0" stroke="#E2E8F0" strokeWidth="0.45" />
        <ellipse cx="12" cy="17.55" rx="3.95" ry="2.25" fill={`url(#${tongueGradId})`} />
      </g>
      <path d={mouthPath} stroke="#45190F" strokeOpacity="0.62" strokeWidth="0.6" />

      {/* Luminous crystal tears streaming cleanly from both eye corners */}
      <path
        d="M6.45 10.8C5.0 11.45 2.55 12.8 2.18 14.25C1.9 15.32 2.75 16.32 3.85 16.18C4.98 16.03 5.88 14.85 6.15 13.5C6.32 12.48 6.52 11.42 6.45 10.8Z"
        fill={`url(#${tearGradId})`}
        stroke="#E0F2FE"
        strokeOpacity="0.65"
        strokeWidth="0.4"
      />
      <ellipse
        cx="3.52"
        cy="13.95"
        rx="0.68"
        ry="1.05"
        transform="rotate(28 3.52 13.95)"
        fill="#FFFFFF"
        opacity="0.88"
      />
      <path
        d="M17.55 10.8C19.0 11.45 21.45 12.8 21.82 14.25C22.1 15.32 21.25 16.32 20.15 16.18C19.02 16.03 18.12 14.85 17.85 13.5C17.68 12.48 17.48 11.42 17.55 10.8Z"
        fill={`url(#${tearGradId})`}
        stroke="#E0F2FE"
        strokeOpacity="0.65"
        strokeWidth="0.4"
      />
      <ellipse
        cx="20.48"
        cy="13.95"
        rx="0.68"
        ry="1.05"
        transform="rotate(-28 20.48 13.95)"
        fill="#FFFFFF"
        opacity="0.88"
      />
    </svg>
  );
}

/**
 * Custom Smoked-Amethyst Auto-Next crystal glyph: open orbital advance arc
 * cradling a beveled play prism and glowing next-episode pillar.
 */
export function PlayerAutoNextIcon({
  active = false,
  size = 16,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const arcId = `ep-autonext-arc-${uid}`;
  const playId = `ep-autonext-play-${uid}`;
  const barId = `ep-autonext-bar-${uid}`;
  const glowId = `ep-autonext-glow-${uid}`;

  const orbitArcPath = "M16.5 19.79A9 9 0 1 1 18.89 6.21";
  const arrowTipPath = "M16.2 6.21H18.89V3.52";
  const playPrismPath =
    "M8.1 9.25C8.1 8.44 8.98 7.94 9.66 8.38L13.72 11.11C14.34 11.53 14.34 12.47 13.72 12.89L9.66 15.62C8.98 16.06 8.1 15.56 8.1 14.75V9.25Z";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={arcId} x1="3" y1="3" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="50%" stopColor="#DDD6FE" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
        <linearGradient id={playId} x1="8" y1="8" x2="14.5" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="65%" stopColor="#F5F3FF" />
          <stop offset="100%" stopColor="#DDD6FE" />
        </linearGradient>
        <linearGradient id={barId} x1="15.1" y1="8.3" x2="17.1" y2="15.7" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle
        cx="12.2"
        cy="12"
        r="6.2"
        fill={`url(#${glowId})`}
        style={{ opacity: active ? 1 : 0, transition: "opacity 160ms var(--ease-glass)" }}
      />

      <g style={{ opacity: active ? 0 : 1, transition: "opacity 150ms var(--ease-glass)" }}>
        <path
          d={orbitArcPath}
          stroke="#CBD5E1"
          strokeOpacity="0.68"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d={arrowTipPath}
          stroke="#E2E8F0"
          strokeOpacity="0.78"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d={playPrismPath} fill="#E2E8F0" fillOpacity="0.86" />
        <rect x="15.1" y="8.35" width="2" height="7.3" rx="1" fill="#CBD5E1" fillOpacity="0.82" />
      </g>

      <g style={{ opacity: active ? 1 : 0, transition: "opacity 160ms var(--ease-glass)" }}>
        <path
          d={orbitArcPath}
          stroke={`url(#${arcId})`}
          strokeWidth="1.85"
          strokeLinecap="round"
        />
        <path
          d={arrowTipPath}
          stroke="#FFFFFF"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d={playPrismPath} fill={`url(#${playId})`} />
        <path
          d="M9.1 11.7V9.45C9.1 9.08 9.48 8.85 9.8 9.04L11.7 10.22"
          stroke="#FFFFFF"
          strokeOpacity="0.68"
          strokeWidth="0.75"
          strokeLinecap="round"
        />
        <rect x="15.1" y="8.35" width="2" height="7.3" rx="1" fill={`url(#${barId})`} />
      </g>
    </svg>
  );
}

/**
 * Custom sky-cyan crystal Follow Party live-sync beacon icon.
 */
export function PlayerFollowIcon({
  active = false,
  size = 16,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const coreId = `ep-follow-core-${uid}`;
  const outerId = `ep-follow-outer-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={coreId} x1="5.8" y1="5.8" x2="10.2" y2="10.2" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#BAE6FD" />
        </linearGradient>
        <linearGradient id={outerId} x1="1" y1="2" x2="15" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7DD3FC" />
          <stop offset="100%" stopColor="#0284C7" />
        </linearGradient>
      </defs>
      <path
        d="M3.26 3.26A6.7 6.7 0 0 0 3.26 12.74"
        stroke={active ? `url(#${outerId})` : "#38BDF8"}
        strokeOpacity={active ? "1" : "0.55"}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M12.74 3.26A6.7 6.7 0 0 1 12.74 12.74"
        stroke={active ? `url(#${outerId})` : "#38BDF8"}
        strokeOpacity={active ? "1" : "0.55"}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M5.07 5.07A4.15 4.15 0 0 0 5.07 10.93"
        stroke={active ? "#BAE6FD" : "#CBD5E1"}
        strokeOpacity={active ? "1" : "0.75"}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M10.93 5.07A4.15 4.15 0 0 1 10.93 10.93"
        stroke={active ? "#BAE6FD" : "#CBD5E1"}
        strokeOpacity={active ? "1" : "0.75"}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {active && <circle cx="8" cy="8" r="3.1" fill="#38BDF8" fillOpacity="0.28" />}
      <circle
        cx="8"
        cy="8"
        r="2.1"
        fill={active ? `url(#${coreId})` : "#E2E8F0"}
        fillOpacity={active ? "1" : "0.86"}
      />
    </svg>
  );
}

/**
 * Custom faceted Smoked-Amethyst crystal '+' orb toggle for expanding the emoji reaction sheet.
 */
export function PlayerReactionPickerIcon({ size = 14, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const beamId = `ep-react-pick-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={beamId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="55%" stopColor="#EDE9FE" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="7.5" fill="#A78BFA" fillOpacity="0.16" />
      <path d="M5.2 12H18.8" stroke={`url(#${beamId})`} strokeWidth="2.1" strokeLinecap="round" />
      <path d="M12 5.2V18.8" stroke="#DDD6FE" strokeWidth="2.1" strokeLinecap="round" />
      <rect x="10.4" y="10.4" width="3.2" height="3.2" rx="1" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Custom faceted Smoked-Amethyst crystal Admin shield-star crest (distinct from Host crown).
 */
export function PartyAdminIcon({ size = 12, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const fillId = `ep-admin-fill-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={fillId} x1="5" y1="4" x2="19" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EDE9FE" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.32" />
        </linearGradient>
      </defs>
      <path
        d="M12 3.4L18.8 6.1V11.6C18.8 15.8 15.9 19.2 12 20.6C8.1 19.2 5.2 15.8 5.2 11.6V6.1L12 3.4Z"
        fill={`url(#${fillId})`}
        stroke="#DDD6FE"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M12 7.8L13.1 10.6L16 11.7L13.1 12.8L12 15.6L10.9 12.8L8 11.7L10.9 10.6L12 7.8Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

/**
 * Custom dual-frame crystal mismatch divider glyph replacing plain Unicode '≠'.
 */
export function PartyMismatchIcon({ size = 12, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5.5 9.2H18.5" stroke="currentColor" strokeOpacity="0.82" strokeWidth="1.85" strokeLinecap="round" />
      <path d="M5.5 14.8H18.5" stroke="#DDD6FE" strokeOpacity="0.88" strokeWidth="1.85" strokeLinecap="round" />
      <path d="M15.6 5.2L8.4 18.8" stroke="#FBBF24" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom dual-frame crystal FPS cadence sync badge icon.
 */
export function PartyFpsMatchIcon({ size = 12, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.2"
        y="5.5"
        width="10.2"
        height="13"
        rx="2.6"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M15.6 7.5H18.2C19.6 7.5 20.8 8.7 20.8 10.1V15.9C20.8 17.3 19.6 18.5 18.2 18.5H15.6"
        stroke="#DDD6FE"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
      <path
        d="M6.4 12H9.2L10.6 9.8L12 14.2L13.4 12H16.6"
        stroke="#FFFFFF"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom crystal dual-timeline scene alignment icon with central amethyst snap beam.
 */
export function PartyAlignSceneIcon({ size = 12, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M12 3.8V20.2" stroke="#DDD6FE" strokeWidth="1.85" strokeLinecap="round" />
      <rect
        x="3.5"
        y="6.4"
        width="12.5"
        height="4.4"
        rx="2.2"
        fill="currentColor"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="8"
        y="13.2"
        width="12.5"
        height="4.4"
        rx="2.2"
        fill="#A78BFA"
        fillOpacity="0.28"
        stroke="#EDE9FE"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="12" r="1.9" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Custom sculpted crystal chevron arrow indicating expandable Watch Party users drawer.
 */
export function PlayerPartyChevronIcon({
  open = false,
  size = 11,
  className = "",
}: PlayerIconProps & { open?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const gradId = `ep-party-arrow-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`transition-transform duration-200 ${open ? "rotate-180" : ""} ${className}`}
    >
      <defs>
        <linearGradient id={gradId} x1="6" y1="7" x2="18" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
      </defs>
      <path
        d="M5.75 15.25L12 9L18.25 15.25"
        stroke={`url(#${gradId})`}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom double-chevron crystal directional burst for the floating seek cue overlay.
 */
export function PlayerSeekCueIcon({
  direction,
  size = 18,
  className = "",
}: PlayerIconProps & { direction: "back" | "forward" }) {
  const uid = useId().replace(/:/g, "");
  const leadId = `ep-cue-lead-${uid}`;
  const trailId = `ep-cue-trail-${uid}`;
  const isBack = direction === "back";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={leadId} x1="4" y1="6" x2="20" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#DDD6FE" />
        </linearGradient>
        <linearGradient id={trailId} x1="4" y1="6" x2="20" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#C4B5FD" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.72" />
        </linearGradient>
      </defs>
      {isBack ? (
        <>
          <path
            d="M11.6 6.4L6.2 12L11.6 17.6"
            stroke={`url(#${leadId})`}
            strokeWidth="2.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M17.8 6.4L12.4 12L17.8 17.6"
            stroke={`url(#${trailId})`}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path
            d="M6.2 6.4L11.6 12L6.2 17.6"
            stroke={`url(#${trailId})`}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12.4 6.4L17.8 12L12.4 17.6"
            stroke={`url(#${leadId})`}
            strokeWidth="2.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
