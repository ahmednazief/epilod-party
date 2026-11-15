import { useId } from "react";

interface PlayerIconProps {
  size?: number;
  className?: string;
}

/**
 * Custom Liquid-Glass Play glyph for the hero center orb.
 */
export function PlayerPlayIcon({ size = 19, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const fillId = `ep-play-fill-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={fillId} x1="6" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="65%" stopColor="#F5F3FF" />
          <stop offset="100%" stopColor="#DDD6FE" />
        </linearGradient>
      </defs>
      <path
        d="M8.1 5.05C7.24 4.55 6.18 5.17 6.18 6.16V17.84C6.18 18.83 7.24 19.45 8.1 18.95L18.22 13.11C19.08 12.61 19.08 11.39 18.22 10.89L8.1 5.05Z"
        fill={`url(#${fillId})`}
      />
    </svg>
  );
}

/**
 * Custom Liquid-Glass Pause pillars for the hero center orb.
 */
export function PlayerPauseIcon({ size = 19, className = "" }: PlayerIconProps) {
  const uid = useId().replace(/:/g, "");
  const fillId = `ep-pause-fill-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={fillId} x1="6" y1="4" x2="18" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="65%" stopColor="#F5F3FF" />
          <stop offset="100%" stopColor="#DDD6FE" />
        </linearGradient>
      </defs>
      <rect x="6.5" y="5" width="4.2" height="14" rx="2.1" fill={`url(#${fillId})`} />
      <rect x="13.3" y="5" width="4.2" height="14" rx="2.1" fill={`url(#${fillId})`} />
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
 * Custom crystal captions plaque icon matching LobbyIcons squircle style.
 */
export function PlayerCaptionsIcon({
  active = false,
  size = 18,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-cc-plate-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="3" y1="4" x2="25" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={active ? "#C4B5FD" : "#A78BFA"} stopOpacity={active ? "0.95" : "0.34"} />
          <stop offset="100%" stopColor={active ? "#7C3AED" : "#5B21B6"} stopOpacity={active ? "0.95" : "0.24"} />
        </linearGradient>
      </defs>
      <rect
        x="2"
        y="4.5"
        width="24"
        height="19"
        rx="6"
        fill={`url(#${plateId})`}
        stroke="#EDE9FE"
        strokeOpacity={active ? "0.8" : "0.48"}
        strokeWidth="1.25"
      />
      {/* Stepped luminous subtitle bars inside screen frame */}
      <rect x="6" y="10.2" width="11" height="2.4" rx="1.2" fill="#FFFFFF" />
      <rect x="18.6" y="10.2" width="3.4" height="2.4" rx="1.2" fill="#DDD6FE" />
      <rect x="6" y="15.2" width="5.2" height="2.4" rx="1.2" fill="#DDD6FE" />
      <rect x="12.8" y="15.2" width="9.2" height="2.4" rx="1.2" fill="#FFFFFF" />
    </svg>
  );
}

/**
 * Custom Royal-Purple acoustic waveform pill icon for Audio & Playback.
 */
export function PlayerAudioIcon({
  active = false,
  size = 18,
  className = "",
}: PlayerIconProps & { active?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-aud-plate-${uid}`;
  const waveId = `ep-aud-wave-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={active ? "#C4B5FD" : "#A78BFA"} stopOpacity={active ? "0.92" : "0.3"} />
          <stop offset="100%" stopColor={active ? "#6D28D9" : "#4C1D95"} stopOpacity={active ? "0.92" : "0.22"} />
        </linearGradient>
        <linearGradient id={waveId} x1="7" y1="6" x2="21" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#DDD6FE" />
        </linearGradient>
      </defs>
      <rect
        x="2"
        y="3"
        width="24"
        height="22"
        rx="7.5"
        fill={`url(#${plateId})`}
        stroke="#EDE9FE"
        strokeOpacity={active ? "0.78" : "0.44"}
        strokeWidth="1.2"
      />
      <rect x="6.8" y="11.2" width="2.5" height="5.6" rx="1.25" fill="#DDD6FE" />
      <rect x="10.9" y="7.5" width="2.5" height="13" rx="1.25" fill={`url(#${waveId})`} />
      <rect x="15" y="9.4" width="2.5" height="9.2" rx="1.25" fill="#FFFFFF" />
      <rect x="19.1" y="12" width="2.5" height="4" rx="1.25" fill="#C4B5FD" />
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
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={cardId} x1="6" y1="8" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={active ? "#DDD6FE" : "#C4B5FD"} />
          <stop offset="100%" stopColor={active ? "#7C3AED" : "#6D28D9"} />
        </linearGradient>
      </defs>
      {/* Back stack cards */}
      <rect x="6.5" y="4.5" width="15" height="3.2" rx="1.6" fill="#DDD6FE" fillOpacity="0.45" />
      <rect x="4.5" y="7.8" width="19" height="3.4" rx="1.7" fill="#C4B5FD" fillOpacity="0.68" />
      {/* Front active episode frame */}
      <rect
        x="2.8"
        y="10.5"
        width="22.4"
        height="13.5"
        rx="4"
        fill={`url(#${cardId})`}
        stroke="#F5F3FF"
        strokeOpacity="0.6"
        strokeWidth="1.1"
      />
      <path
        d="M12.3 14.5L17.1 17.25L12.3 20V14.5Z"
        fill="#FFFFFF"
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
          <circle cx="12" cy="12" r="8.8" fill="#8B5CF6" fillOpacity="0.16" stroke="#C4B5FD" strokeOpacity="0.7" strokeWidth="1.6" />
          <circle cx="12" cy="12" r="2.8" fill="#DDD6FE" fillOpacity="0.7" />
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
