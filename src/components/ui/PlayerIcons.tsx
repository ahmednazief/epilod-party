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
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      className={className}
    >
      {isBack ? (
        <>
          <path
            d="M3.80 11.14A8.25 8.25 0 1 0 5.87 6.48"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
          />
          <path
            d="M5.74 4.03L5.87 6.48L8.32 6.35"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path
            d="M20.20 11.14A8.25 8.25 0 1 1 18.13 6.48"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
          />
          <path
            d="M18.26 4.03L18.13 6.48L15.68 6.35"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      <path
        d="M8.5 10.6L9.65 9.5V14.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="11.9"
        y="9.5"
        width="3.45"
        height="5.0"
        rx="1.725"
        stroke="currentColor"
        strokeWidth="1.35"
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

  const barX = isPrev ? 5.1 : 16.8;
  const triPath = isPrev
    ? "M17.9 7.2Q17.9 6.15 17.0 6.72L9.5 11.42Q8.65 12 9.5 12.58L17.0 17.28Q17.9 17.85 17.9 16.8V7.2Z"
    : "M6.1 7.2Q6.1 6.15 7.0 6.72L14.5 11.42Q15.35 12 14.5 12.58L7.0 17.28Q6.1 17.85 6.1 16.8V7.2Z";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={sheenId} x1="5" y1="6" x2="19" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.02" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x={barX} y="6.2" width="2.1" height="11.6" rx="1.05" />
          <path d={triPath} />
        </clipPath>
      </defs>
      <rect x={barX} y="6.2" width="2.1" height="11.6" rx="1.05" fill="currentColor" />
      <path d={triPath} fill="currentColor" />
      <g clipPath={`url(#${clipId})`}>
        <rect x="4.5" y="5.5" width="15" height="13" fill={`url(#${sheenId})`} />
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
 * Custom crystal chain-link icon for copying Watch Party deep-link URLs.
 */
export function PartyLinkIcon({
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
            d="M10 13.5a4.5 4.5 0 0 0 6.36.5l2.14-2.14a4.5 4.5 0 0 0-6.36-6.36L10.9 6.74"
            stroke="#C4B5FD"
            strokeOpacity="0.9"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M14 10.5a4.5 4.5 0 0 0-6.36-.5L5.5 12.14a4.5 4.5 0 0 0 6.36 6.36l1.24-1.24"
            stroke="#F8FAFC"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
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
 * Custom faceted golden-pearl & amethyst crystal Host crown icon.
 */
export function PartyHostIcon({ size = 14, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const crownGradId = `ep-host-crown-${uid}`;
  const bandGradId = `ep-host-band-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={crownGradId} x1="4" y1="6" x2="20" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FEF3C7" stopOpacity="0.92" />
          <stop offset="52%" stopColor="#FCD34D" stopOpacity="0.88" />
          <stop offset="100%" stopColor="#C4B5FD" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id={bandGradId} x1="5" y1="17" x2="19" y2="19.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FDE68A" />
          <stop offset="100%" stopColor="#A78BFA" />
        </linearGradient>
      </defs>
      <path
        d="M4.3 16.3L3.6 8.6L8.7 12.1L12 6.2L15.3 12.1L20.4 8.6L19.7 16.3H4.3Z"
        fill={`url(#${crownGradId})`}
        fillOpacity="0.28"
        stroke={`url(#${crownGradId})`}
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M8.7 12.1L12 16.3L15.3 12.1"
        stroke="#FEF3C7"
        strokeOpacity="0.55"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <rect x="4.5" y="17.3" width="15" height="2.4" rx="1.2" fill={`url(#${bandGradId})`} fillOpacity="0.85" />
      <circle cx="12" cy="5.2" r="1.25" fill="#FEF3C7" />
      <circle cx="3.6" cy="7.9" r="1.05" fill="#FDE68A" />
      <circle cx="20.4" cy="7.9" r="1.05" fill="#DDD6FE" />
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
 * Sleek Smoked-Amethyst crystal reaction icon matching the monochrome/lavender Play Bar aesthetic.
 */
export function PlayerReactionsIcon({
  active = false,
  size = 20,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const gradId = `ep-react-grad-${uid}`;

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
        <linearGradient id={gradId} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={active ? "#DDD6FE" : "#FFFFFF"} stopOpacity={active ? "0.95" : "0.14"} />
          <stop offset="100%" stopColor={active ? "#A78BFA" : "#C4B5FD"} stopOpacity={active ? "0.85" : "0.06"} />
        </linearGradient>
      </defs>
      <circle
        cx="12"
        cy="12"
        r="8.75"
        fill={`url(#${gradId})`}
        stroke={active ? "#C4B5FD" : "currentColor"}
        strokeOpacity={active ? "0.95" : "0.88"}
        strokeWidth="1.55"
      />
      <circle
        cx="9"
        cy="10"
        r="1.1"
        fill={active ? "#4C1D95" : "currentColor"}
      />
      <circle
        cx="15"
        cy="10"
        r="1.1"
        fill={active ? "#4C1D95" : "currentColor"}
      />
      <path
        d="M8.6 13.7C9.45 15.2 10.65 15.9 12 15.9C13.35 15.9 14.55 15.2 15.4 13.7"
        stroke={active ? "#4C1D95" : "currentColor"}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M18.6 4.2L19.1 5.6L20.5 6.1L19.1 6.6L18.6 8L18.1 6.6L16.7 6.1L18.1 5.6L18.6 4.2Z"
        fill={active ? "#DDD6FE" : "#C4B5FD"}
        fillOpacity={active ? "1" : "0.75"}
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
export function PartyAdminIcon({
  size = 12,
  revoke = false,
  className = "",
}: PlayerIconProps & { revoke?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const fillId = `ep-admin-fill-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={fillId} x1="5" y1="4" x2="19" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={revoke ? "#FECDD3" : "#EDE9FE"} stopOpacity="0.34" />
          <stop offset="100%" stopColor={revoke ? "#E11D48" : "#7C3AED"} stopOpacity="0.32" />
        </linearGradient>
      </defs>
      <path
        d="M12 3.4L18.8 6.1V11.6C18.8 15.8 15.9 19.2 12 20.6C8.1 19.2 5.2 15.8 5.2 11.6V6.1L12 3.4Z"
        fill={`url(#${fillId})`}
        stroke={revoke ? "#FDA4AF" : "#DDD6FE"}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeOpacity={revoke ? "0.75" : "1"}
      />
      <path
        d="M12 7.8L13.1 10.6L16 11.7L13.1 12.8L12 15.6L10.9 12.8L8 11.7L10.9 10.6L12 7.8Z"
        fill="#FFFFFF"
        fillOpacity={revoke ? "0.65" : "1"}
      />
      {revoke && (
        <path
          d="M5.2 18.8L18.8 5.2"
          stroke="#FB7185"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
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

/**
 * Custom sculpted liquid-glass chat bubble icon for the party play bar.
 */
export function PlayerChatIcon({
  size = 19,
  active = false,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const gradId = `ep-chat-grad-${uid}`;
  const bubblePath =
    "M5.1 5.4H18.9C20.06 5.4 21 6.34 21 7.5V14.7C21 15.86 20.06 16.8 18.9 16.8H10.65L6.55 19.85C6.02 20.24 5.28 19.86 5.28 19.2V16.8H5.1C3.94 16.8 3 15.86 3 14.7V7.5C3 6.34 3.94 5.4 5.1 5.4Z";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {active ? (
        <>
          <defs>
            <linearGradient id={gradId} x1="3" y1="5" x2="21" y2="20" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#DDD6FE" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#A78BFA" stopOpacity="0.85" />
            </linearGradient>
          </defs>
          <path
            d={bubblePath}
            fill={`url(#${gradId})`}
            stroke="#C4B5FD"
            strokeOpacity="0.95"
            strokeWidth="1.55"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="11.1" r="1.05" fill="#4C1D95" />
          <circle cx="12" cy="11.1" r="1.05" fill="#4C1D95" />
          <circle cx="16" cy="11.1" r="1.05" fill="#4C1D95" />
        </>
      ) : (
        <>
          <path
            d={bubblePath}
            fill="currentColor"
            fillOpacity="0.06"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="8" cy="11.1" r="0.95" fill="currentColor" />
          <circle cx="12" cy="11.1" r="0.95" fill="currentColor" />
          <circle cx="16" cy="11.1" r="0.95" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * Crisp faceted paper-plane send glyph for the liquid-glass composer orb.
 */
export function PlayerSendIcon({ size = 18, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Minimal curved reply glyph for message bubble hover actions.
 */
export function PlayerReplyIcon({ size = 14, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M9 7L4 12L9 17M4 12H15C17.76 12 20 14.24 20 17V18"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Compact clock icon for tagging current playback timestamp in chat.
 */
export function PlayerClockIcon({ size = 14, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 7.75V12L14.9 13.85"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Compact pencil edit icon for editing own chat messages.
 */
export function PlayerEditIcon({ size = 13, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.5 19.5L8.2 18.6L18.4 8.4C19.2 7.6 19.2 6.3 18.4 5.5C17.6 4.7 16.3 4.7 15.5 5.5L5.3 15.7L4.5 19.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Clean emoji smile icon for the chat composer.
 */
export function PlayerSmileIcon({ size = 16, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.65" />
      <circle cx="9.25" cy="10.25" r="1.05" fill="currentColor" />
      <circle cx="14.75" cy="10.25" r="1.05" fill="currentColor" />
      <path
        d="M8.75 14.1C9.55 15.4 10.7 16.05 12 16.05C13.3 16.05 14.45 15.4 15.25 14.1"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Minimal horizontal ellipsis icon for compact header menus.
 */
export function PlayerMoreIcon({ size = 16, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="6.5" cy="12" r="1.45" fill="currentColor" />
      <circle cx="12" cy="12" r="1.45" fill="currentColor" />
      <circle cx="17.5" cy="12" r="1.45" fill="currentColor" />
    </svg>
  );
}

/**
 * Rightward dock-collapse glyph (distinguishable from the window Close X directly above).
 */
export function PlayerCollapseRightIcon({ size = 15, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5.5 12H14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path
        d="M10.5 8.2L14.3 12L10.5 15.8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18 5.5V18.5" stroke="currentColor" strokeOpacity="0.85" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Leftward dock-collapse glyph for the Left Party Lounge.
 */
export function PlayerCollapseLeftIcon({ size = 15, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M18.5 12H10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path
        d="M13.5 8.2L9.7 12L13.5 15.8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6 5.5V18.5" stroke="currentColor" strokeOpacity="0.85" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom Liquid-Glass Left Party & Voice Lounge icon with sculpted theater frame,
 * luminous docked lounge column, and active Royal Purple crystal refraction.
 */
export function PartyDockLeftIcon({
  size = 15,
  active = false,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const gradId = `ep-dock-left-fill-${uid}`;
  const sheenId = `ep-dock-left-sheen-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={gradId} x1="4" y1="5" x2="12" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.96" />
          <stop offset="55%" stopColor="#E9D5FF" stopOpacity="0.90" />
          <stop offset="100%" stopColor="#A78BFA" stopOpacity="0.94" />
        </linearGradient>
        <linearGradient id={sheenId} x1="3" y1="4" x2="18" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect
        x="2.8"
        y="4.2"
        width="18.4"
        height="15.6"
        rx="4.2"
        fill="currentColor"
        fillOpacity={active ? "0.10" : "0.05"}
        stroke="currentColor"
        strokeOpacity={active ? "0.92" : "0.86"}
        strokeWidth="1.6"
      />

      {active ? (
        <>
          <rect x="4.8" y="6.1" width="6.2" height="11.8" rx="2.1" fill={`url(#${gradId})`} />
          <rect x="4.8" y="6.1" width="6.2" height="11.8" rx="2.1" fill={`url(#${sheenId})`} />
          <circle cx="7.9" cy="9.4" r="1.15" fill="#18122B" />
          <path d="M6.4 13.1H9.4" stroke="#18122B" strokeWidth="1.35" strokeLinecap="round" />
          <path d="M6.7 15.3H9.1" stroke="#18122B" strokeOpacity="0.7" strokeWidth="1.2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <rect
            x="4.8"
            y="6.1"
            width="6.2"
            height="11.8"
            rx="2.1"
            fill="currentColor"
            fillOpacity="0.22"
            stroke="currentColor"
            strokeOpacity="0.7"
            strokeWidth="1.1"
          />
          <circle cx="7.9" cy="9.4" r="0.95" fill="currentColor" />
          <path d="M6.6 13.1H9.2" stroke="currentColor" strokeOpacity="0.85" strokeWidth="1.2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/**
 * Custom Liquid-Glass Unpin-to-Play-Bar glyph with floating capsule pill and crystal sheen.
 */
export function PartyUnpinIcon({ size = 14, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const pillId = `ep-unpin-pill-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={pillId} x1="6" y1="13" x2="18" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#C4B5FD" stopOpacity="0.88" />
        </linearGradient>
      </defs>
      <rect
        x="2.8"
        y="4.2"
        width="18.4"
        height="15.6"
        rx="4.2"
        fill="currentColor"
        fillOpacity="0.06"
        stroke="currentColor"
        strokeOpacity="0.86"
        strokeWidth="1.6"
      />
      <rect x="5.8" y="13.4" width="12.4" height="4.1" rx="2.05" fill={`url(#${pillId})`} />
      <path
        d="M12 7.4V10.9M12 10.9L9.9 8.9M12 10.9L14.1 8.9"
        stroke="currentColor"
        strokeOpacity="0.82"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom iOS 27 Liquid-Glass sculpted rating star with soft squircle-rounded points,
 * translucent warm-gold glass body, inner refraction glow, and top-left specular crescent.
 */
export function PlayerRatingStarIcon({
  size = 16,
  active = true,
  tone = "gold",
  className = "",
}: PlayerIconProps & { active?: boolean; tone?: "gold" | "personal" }) {
  const uid = useId().replace(/:/g, "");
  const bodyId = `ep-star-body-${uid}`;
  const innerGlowId = `ep-star-glow-${uid}`;
  const sheenId = `ep-star-sheen-${uid}`;
  const clipId = `ep-star-clip-${uid}`;
  const isPersonal = tone === "personal";

  // Plump, soft iOS-style rounded 5-point star
  const starPath =
    "M12 2.25Q12.72 2.25 13.28 3.38L15.05 6.95Q15.42 7.7 16.24 7.82L20.18 8.39Q21.4 8.57 21.05 9.6Q20.9 10.04 20.22 10.7L17.36 13.48Q16.77 14.06 16.91 14.88L17.58 18.81Q17.8 20.02 16.75 20.12Q16.32 20.16 15.48 19.72L11.95 17.86Q11.22 17.48 10.49 17.86L6.96 19.72Q5.88 20.29 5.42 19.38Q5.22 18.99 5.38 18.04L6.05 14.11Q6.19 13.29 5.6 12.71L2.74 9.93Q1.86 9.08 2.52 8.28Q2.8 7.94 3.74 7.8L7.68 7.23Q8.5 7.11 8.87 6.36L10.64 2.79Q11.2 1.66 12 2.25Z";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={bodyId} x1="4" y1="2" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={isPersonal ? "#F3E8FF" : "#FFF7AE"} stopOpacity="0.98" />
          <stop offset="42%" stopColor={isPersonal ? "#C084FC" : "#FBBF24"} stopOpacity="0.94" />
          <stop offset="100%" stopColor={isPersonal ? "#7C3AED" : "#EA580C"} stopOpacity="0.9" />
        </linearGradient>
        <radialGradient id={innerGlowId} cx="50%" cy="55%" r="50%">
          <stop offset="0%" stopColor={isPersonal ? "#E9D5FF" : "#FEF08A"} stopOpacity="0.88" />
          <stop offset="100%" stopColor={isPersonal ? "#8B5CF6" : "#F59E0B"} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={sheenId} x1="5" y1="2" x2="14" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.88" />
          <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={starPath} />
        </clipPath>
      </defs>
      {active ? (
        <>
          <path d={starPath} fill={`url(#${bodyId})`} />
          <g clipPath={`url(#${clipId})`}>
            <circle cx="12" cy="12.5" r="7.5" fill={`url(#${innerGlowId})`} />
            <ellipse cx="9" cy="6.6" rx="7.2" ry="3.8" transform="rotate(-18 9 6.6)" fill={`url(#${sheenId})`} />
          </g>
          <path
            d={starPath}
            stroke="#FFFFFF"
            strokeOpacity="0.62"
            strokeWidth="0.85"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <path
          d={starPath}
          fill="rgba(255,255,255,0.14)"
          stroke="rgba(255,255,255,0.75)"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/**
 * Custom Smoked-Amethyst Liquid-Glass watched episode badge with a translucent
 * crystal squircle lens, inner violet refraction glow, top-left specular crescent,
 * refractive glass rim, and luminous sculpted check glyph.
 */
export function PlayerWatchedCheckIcon({
  watched = true,
  size = 18,
  className = "",
}: PlayerIconProps & { watched?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const bodyId = `ep-watched-body-${uid}`;
  const rimId = `ep-watched-rim-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={bodyId} x1="5" y1="4" x2="19" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.34" />
        </linearGradient>
        <linearGradient id={rimId} x1="5" y1="4" x2="19" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EDE9FE" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#A78BFA" stopOpacity="0.24" />
        </linearGradient>
      </defs>
      {watched ? (
        <>
          <circle
            cx="12"
            cy="12"
            r="8.5"
            fill={`url(#${bodyId})`}
            stroke={`url(#${rimId})`}
            strokeWidth="1.1"
          />
          <path
            d="M8.6 12.15L10.85 14.4L15.5 9.6"
            stroke="#F5F3FF"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="12"
            cy="12"
            r="8.5"
            fill="rgba(255,255,255,0.035)"
            stroke="currentColor"
            strokeOpacity="0.26"
            strokeWidth="1.1"
          />
          <path
            d="M8.6 12.15L10.85 14.4L15.5 9.6"
            stroke="currentColor"
            strokeOpacity="0.58"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

/** Custom crystal photo frame icon for ephemeral chat images. */
export function PlayerImageIcon({
  size = 16,
  active = false,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect
        x="3.2"
        y="4.5"
        width="17.6"
        height="15"
        rx="3.4"
        fill={active ? "rgba(167,139,250,0.20)" : "rgba(255,255,255,0.06)"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeOpacity={active ? 0.95 : 0.78}
      />
      <circle cx="8.6" cy="9.4" r="1.55" fill="currentColor" fillOpacity={active ? 0.95 : 0.78} />
      <path
        d="M5.5 16.5L10.2 12.1L13.3 14.9L15.6 12.8L18.5 16.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity={active ? 0.95 : 0.82}
      />
    </svg>
  );
}

/** Custom crystal camera snap icon for capturing the active video frame into chat. */
export function PlayerCameraSnapIcon({
  size = 16,
  className = "",
}: PlayerIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M8.5 5.2H15.5L17.1 7.2H19.4C20.5 7.2 21.4 8.1 21.4 9.2V17.4C21.4 18.5 20.5 19.4 19.4 19.4H4.6C3.5 19.4 2.6 18.5 2.6 17.4V9.2C2.6 8.1 3.5 7.2 4.6 7.2H6.9L8.5 5.2Z"
        fill="rgba(255,255,255,0.06)"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.1" r="3.4" stroke="currentColor" strokeWidth="1.45" />
      <circle cx="12" cy="13.1" r="1.2" fill="currentColor" fillOpacity="0.7" />
    </svg>
  );
}

/**
 * Pure GPU-animated circular countdown ring (`stroke-dashoffset` CSS animation)
 * showing remaining ephemeral photo lifetime without React timer re-renders.
 */
export function EphemeralTimerRing({
  size = 18,
  receivedAtMs,
  expiresAtMs,
  paused = false,
  className = "",
}: {
  size?: number;
  receivedAtMs: number;
  expiresAtMs: number;
  paused?: boolean;
  className?: string;
}) {
  const totalMs = Math.max(1000, expiresAtMs - receivedAtMs);
  const elapsedMs = Math.max(0, Math.min(totalMs, Date.now() - receivedAtMs));
  const durationSecs = totalMs / 1000;
  const delaySecs = -(elapsedMs / 1000);
  const r = 7;
  const c = 2 * Math.PI * r;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle
        cx="10"
        cy="10"
        r={r}
        stroke="rgba(255,255,255,0.22)"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={r}
        stroke="#E9D5FF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        transform="rotate(-90 10 10)"
        className="ep-ephemeral-ring-circle"
        style={{
          animationDuration: `${durationSecs}s`,
          animationDelay: `${delaySecs}s`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    </svg>
  );
}
