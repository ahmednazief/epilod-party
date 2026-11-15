import { useId } from "react";

interface PlayerIconProps {
  size?: number;
  className?: string;
}

/**
 * Custom faceted Smoked-Amethyst Crystal Play prism for the hero center orb.
 */
export function PlayerPlayIcon({ size = 24, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const haloId = `ep-play-halo-${uid}`;
  const coreId = `ep-play-core-${uid}`;
  const facetId = `ep-play-facet-${uid}`;
  const rimId = `ep-play-rim-${uid}`;
  const clipId = `ep-play-clip-${uid}`;

  const haloPath =
    "M6.85 12C6.6 9.5 6.6 7.8 6.85 6.4C6.85 4.45 8.4 3.45 10 4.4C13.4 6.35 16.5 8.3 18.9 9.95C20.95 11.35 20.95 12.65 18.9 14.05C16.5 15.7 13.4 17.65 10 19.6C8.4 20.55 6.85 19.55 6.85 17.6C6.6 16.2 6.6 14.5 6.85 12Z";
  const corePath =
    "M8.05 12C7.85 9.8 7.85 8.3 8.05 7.1C8.05 5.55 9.25 4.72 10.6 5.5C13.35 7.1 16 8.85 18 10.22C19.75 11.4 19.75 12.6 18 13.78C16 15.15 13.35 16.9 10.6 18.5C9.25 19.28 8.05 18.45 8.05 16.9C7.85 15.7 7.85 14.2 8.05 12Z";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={haloId} x1="7" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EDE9FE" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.34" />
        </linearGradient>
        <linearGradient id={coreId} x1="7" y1="5" x2="19" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="52%" stopColor="#F5F3FF" />
          <stop offset="100%" stopColor="#E4D8FF" />
        </linearGradient>
        <linearGradient id={facetId} x1="8" y1="12" x2="19" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#C4B5FD" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.34" />
        </linearGradient>
        <linearGradient id={rimId} x1="7" y1="4" x2="19" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#DDD6FE" stopOpacity="0.48" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={corePath} />
        </clipPath>
      </defs>
      <path d={haloPath} fill={`url(#${haloId})`} stroke="#EDE9FE" strokeOpacity="0.38" strokeWidth="0.85" />
      <path d={corePath} fill={`url(#${coreId})`} />
      <g clipPath={`url(#${clipId})`}>
        <path
          d="M6.5 13.1C10.8 11.7 15.2 11.35 20.5 12V20.5H6.5V13.1Z"
          fill={`url(#${facetId})`}
        />
        <path
          d="M8.65 12.2C8.55 9.4 8.6 7.2 9.35 6.45C10.05 5.75 11.45 6.45 14 8.05"
          stroke="#FFFFFF"
          strokeOpacity="0.9"
          strokeWidth="1.05"
          strokeLinecap="round"
        />
      </g>
      <path d={corePath} stroke={`url(#${rimId})`} strokeWidth="0.75" />
    </svg>
  );
}

/**
 * Custom faceted Smoked-Amethyst Crystal Pause pillars for the hero center orb.
 */
export function PlayerPauseIcon({ size = 24, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const haloId = `ep-pause-halo-${uid}`;
  const coreId = `ep-pause-core-${uid}`;
  const facetId = `ep-pause-facet-${uid}`;
  const shineId = `ep-pause-shine-${uid}`;
  const rimId = `ep-pause-rim-${uid}`;
  const clipId = `ep-pause-clip-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={haloId} x1="5" y1="4" x2="19" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EDE9FE" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.34" />
        </linearGradient>
        <linearGradient id={coreId} x1="6" y1="5" x2="18" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="52%" stopColor="#F5F3FF" />
          <stop offset="100%" stopColor="#E4D8FF" />
        </linearGradient>
        <linearGradient id={facetId} x1="6" y1="12" x2="18" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#C4B5FD" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.34" />
        </linearGradient>
        <linearGradient id={shineId} x1="12" y1="6" x2="12" y2="12.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.88" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={rimId} x1="6" y1="5" x2="18" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#DDD6FE" stopOpacity="0.48" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x="6" y="5" width="4.2" height="14" rx="2.1" />
          <rect x="13.8" y="5" width="4.2" height="14" rx="2.1" />
        </clipPath>
      </defs>
      <rect x="5" y="3.9" width="6.2" height="16.2" rx="3.1" fill={`url(#${haloId})`} stroke="#EDE9FE" strokeOpacity="0.38" strokeWidth="0.85" />
      <rect x="12.8" y="3.9" width="6.2" height="16.2" rx="3.1" fill={`url(#${haloId})`} stroke="#EDE9FE" strokeOpacity="0.38" strokeWidth="0.85" />
      <rect x="6" y="5" width="4.2" height="14" rx="2.1" fill={`url(#${coreId})`} />
      <rect x="13.8" y="5" width="4.2" height="14" rx="2.1" fill={`url(#${coreId})`} />
      <g clipPath={`url(#${clipId})`}>
        <path
          d="M4.5 13.7C9.5 12.05 14.5 11.75 19.5 12.55V20.5H4.5V13.7Z"
          fill={`url(#${facetId})`}
        />
        <rect x="6.95" y="6.1" width="1.2" height="6" rx="0.6" fill={`url(#${shineId})`} />
        <rect x="14.75" y="6.1" width="1.2" height="6" rx="0.6" fill={`url(#${shineId})`} />
      </g>
      <rect x="6" y="5" width="4.2" height="14" rx="2.1" stroke={`url(#${rimId})`} strokeWidth="0.75" />
      <rect x="13.8" y="5" width="4.2" height="14" rx="2.1" stroke={`url(#${rimId})`} strokeWidth="0.75" />
    </svg>
  );
}

/**
 * Custom Smoked-Amethyst 10s backward / forward jump icon.
 */
export function PlayerSeekIcon({
  direction,
  size = 19,
  className = "",
}: PlayerIconProps & { direction: "back" | "forward" }) {
  const uid = useId().replace(/:/g, "");
  const arcId = `ep-seek-arc-${uid}`;
  const isBack = direction === "back";

  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={arcId} x1="4" y1="4" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#F8FAFC" />
          <stop offset="60%" stopColor="#DDD6FE" />
          <stop offset="100%" stopColor="#A78BFA" />
        </linearGradient>
      </defs>
      {isBack ? (
        <>
          <path
            d="M11.6 6.2C16.9 5.2 21.8 8.9 22.3 14.3C22.8 19.6 18.8 24 13.5 24C9.5 24 6.2 21.4 5.2 17.7"
            stroke={`url(#${arcId})`}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M11.7 3.8L8.4 6.7L12.1 8.8"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path
            d="M16.4 6.2C11.1 5.2 6.2 8.9 5.7 14.3C5.2 19.6 9.2 24 14.5 24C18.5 24 21.8 21.4 22.8 17.7"
            stroke={`url(#${arcId})`}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M16.3 3.8L19.6 6.7L15.9 8.8"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      <path d="M9.8 12.6L11.5 11.4V17.8" stroke="#FFFFFF" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="13.8" y="11.4" width="4.4" height="6.4" rx="2.2" stroke="#DDD6FE" strokeWidth="1.8" />
    </svg>
  );
}

/**
 * Custom crystal episode step icon (previous / next).
 */
export function PlayerSkipEpisodeIcon({
  direction,
  size = 16,
  className = "",
}: PlayerIconProps & { direction: "prev" | "next" }) {
  const uid = useId().replace(/:/g, "");
  const gId = `ep-skip-grad-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={gId} x1="4" y1="5" x2="20" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
      </defs>
      {direction === "prev" ? (
        <>
          <rect x="4.8" y="5.5" width="2.4" height="13" rx="1.2" fill={`url(#${gId})`} />
          <path
            d="M17.5 6.3C18.3 5.8 19.2 6.4 19.2 7.3V16.7C19.2 17.6 18.3 18.2 17.5 17.7L9.6 13C8.9 12.6 8.9 11.4 9.6 11L17.5 6.3Z"
            fill={`url(#${gId})`}
          />
        </>
      ) : (
        <>
          <rect x="16.8" y="5.5" width="2.4" height="13" rx="1.2" fill={`url(#${gId})`} />
          <path
            d="M6.5 6.3C5.7 5.8 4.8 6.4 4.8 7.3V16.7C4.8 17.6 5.7 18.2 6.5 17.7L14.4 13C15.1 12.6 15.1 11.4 14.4 11L6.5 6.3Z"
            fill={`url(#${gId})`}
          />
        </>
      )}
    </svg>
  );
}

/**
 * Custom sculpted acoustic volume icon with glowing violet sound arcs.
 */
export function PlayerVolumeIcon({
  muted,
  size = 17,
  className = "",
}: PlayerIconProps & { muted: boolean }) {
  const uid = useId().replace(/:/g, "");
  const bodyId = `ep-vol-body-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={bodyId} x1="3" y1="6" x2="13" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#F8FAFC" />
          <stop offset="100%" stopColor="#C4B5FD" />
        </linearGradient>
      </defs>
      <path
        d="M4 10C4 9.17 4.67 8.5 5.5 8.5H8.1L12.1 5.2C12.75 4.66 13.7 5.12 13.7 5.96V18.04C13.7 18.88 12.75 19.34 12.1 18.8L8.1 15.5H5.5C4.67 15.5 4 14.83 4 14V10Z"
        fill={muted ? "#94A3B8" : `url(#${bodyId})`}
      />
      {muted ? (
        <path
          d="M16.5 9.3L21 14.7M21 9.3L16.5 14.7"
          stroke="#FB7185"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <>
          <path
            d="M16.4 9.1C17.6 10.6 17.6 13.4 16.4 14.9"
            stroke="#FFFFFF"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <path
            d="M19.1 6.7C21.3 9.7 21.3 14.3 19.1 17.3"
            stroke="#A78BFA"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

/**
 * Custom crystal captions screen icon with stepped subtitle bars.
 */
export function PlayerCaptionsIcon({
  active = false,
  size = 17,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-cc-plate-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="3" y1="4" x2="25" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#6D28D9" stopOpacity="0.24" />
        </linearGradient>
      </defs>
      <rect
        x="2.5"
        y="5"
        width="23"
        height="18"
        rx="4.6"
        fill={active ? `url(#${plateId})` : "#FFFFFF"}
        fillOpacity={active ? "1" : "0.06"}
        stroke={active ? "#DDD6FE" : "#E2E8F0"}
        strokeOpacity={active ? "0.95" : "0.72"}
        strokeWidth="1.5"
      />
      {/* Stepped luminous subtitle bars inside screen frame */}
      <rect x="6.3" y="10.4" width="10.2" height="2.2" rx="1.1" fill="#FFFFFF" />
      <rect
        x="18.1"
        y="10.4"
        width="3.6"
        height="2.2"
        rx="1.1"
        fill={active ? "#DDD6FE" : "#C4B5FD"}
        fillOpacity={active ? "1" : "0.8"}
      />
      <rect
        x="6.3"
        y="15.1"
        width="4.8"
        height="2.2"
        rx="1.1"
        fill={active ? "#DDD6FE" : "#C4B5FD"}
        fillOpacity={active ? "1" : "0.8"}
      />
      <rect x="12.7" y="15.1" width="9" height="2.2" rx="1.1" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Custom sculpted acoustic waveform icon for Audio & Playback (pill-free).
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
      <rect x="3.6" y="9.6" width="2.2" height="4.8" rx="1.1" fill={active ? "#DDD6FE" : "#CBD5E1"} />
      <rect x="7.25" y="6.2" width="2.2" height="11.6" rx="1.1" fill={`url(#${midId})`} />
      <rect x="10.9" y="3.6" width="2.2" height="16.8" rx="1.1" fill={`url(#${centerId})`} />
      <rect x="14.55" y="7" width="2.2" height="10" rx="1.1" fill={active ? "#DDD6FE" : "#E2E8F0"} />
      <rect x="18.2" y="9.8" width="2.2" height="4.4" rx="1.1" fill={active ? "#A78BFA" : "#94A3B8"} />
    </svg>
  );
}

/**
 * Custom stacked crystal season queue icon matching OpenMediaIcon language.
 */
export function PlayerEpisodesIcon({
  active = false,
  size = 17,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const cardId = `ep-eps-card-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={cardId} x1="6" y1="10" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={active ? "#C4B5FD" : "#475569"} stopOpacity={active ? "0.92" : "0.72"} />
          <stop offset="100%" stopColor={active ? "#6D28D9" : "#1E293B"} stopOpacity={active ? "0.92" : "0.82"} />
        </linearGradient>
      </defs>
      {/* Back stack cards */}
      <rect
        x="6.5"
        y="4.5"
        width="15"
        height="3"
        rx="1.5"
        fill={active ? "#DDD6FE" : "#CBD5E1"}
        fillOpacity={active ? "0.58" : "0.38"}
      />
      <rect
        x="4.5"
        y="7.8"
        width="19"
        height="3.2"
        rx="1.6"
        fill="#C4B5FD"
        fillOpacity={active ? "0.78" : "0.48"}
      />
      {/* Front active episode frame */}
      <rect
        x="2.8"
        y="10.5"
        width="22.4"
        height="13.5"
        rx="4"
        fill={`url(#${cardId})`}
        stroke={active ? "#F5F3FF" : "#E2E8F0"}
        strokeOpacity={active ? "0.85" : "0.62"}
        strokeWidth="1.2"
      />
      <path
        d="M12.3 14.5L17.1 17.25L12.3 20V14.5Z"
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
 * Custom sleek Hide Controls tray icon.
 */
export function PlayerHideBarIcon({ size = 16, className = "" }: PlayerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M7.5 9.2L12 13.7L16.5 9.2"
        stroke="#F8FAFC"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="6" y="17" width="12" height="2.4" rx="1.2" fill="#A78BFA" />
    </svg>
  );
}

/**
 * Custom obsidian-silver + amethyst core Preferences aperture icon.
 */
export function PlayerSettingsIcon({ size = 16, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const rimId = `ep-gear-rim-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={rimId} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#F8FAFC" />
          <stop offset="100%" stopColor="#94A3B8" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.8L14 4.8L16.8 4.4L17.5 7.1L20 8.5L19.1 11.2L20.6 13.6L18.4 15.4L18.5 18.2L15.8 18.7L14.2 21L11.6 19.9L9.1 21L7.5 18.7L4.8 18.2L4.9 15.4L2.7 13.6L4.2 11.2L3.3 8.5L5.8 7.1L6.5 4.4L9.3 4.8L12 2.8Z"
        fill="#8B5CF6"
        fillOpacity="0.22"
        stroke={`url(#${rimId})`}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.4" fill="#C4B5FD" stroke="#FFFFFF" strokeWidth="1.1" />
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
