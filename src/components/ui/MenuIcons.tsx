interface MenuIconProps {
  size?: number;
  className?: string;
}

/**
 * Custom crystal Playback section glyph (rounded play crest).
 */
export function MenuControlsIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle
        cx="12"
        cy="12"
        r="8.8"
        fill="#A78BFA"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M10 8.7L16.2 12L10 15.3V8.7Z"
        fill="#F8FAFC"
      />
    </svg>
  );
}

/**
 * Custom semicircular crystal Speedometer gauge + needle for Playback Speed.
 */
export function MenuSpeedIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.3 16.4A8.5 8.5 0 1 1 19.7 16.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M7.2 15.5A5.4 5.4 0 0 1 16.5 11.4"
        stroke="#C4B5FD"
        strokeOpacity="0.55"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M12 15.2L15.9 10.1"
        stroke="#DDD6FE"
        strokeWidth="1.85"
        strokeLinecap="round"
      />
      <circle cx="12" cy="15.2" r="1.7" fill="#F8FAFC" />
    </svg>
  );
}

/**
 * Custom 16:9 widescreen crystal crop bezel for Picture Frame / Aspect Ratio.
 */
export function MenuAspectFrameIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.2"
        y="5.5"
        width="17.6"
        height="13"
        rx="3"
        fill="#8B5CF6"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M7 11V8.8H9.4"
        stroke="#DDD6FE"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17 13V15.2H14.6"
        stroke="#C4B5FD"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom cinema screen & play bar glyph showing either centered floating capsule or docked full-width bar.
 */
export function MenuPlayBarLayoutIcon({
  size = 14,
  fullWidth = false,
  className = "",
}: MenuIconProps & { fullWidth?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.2"
        y="4.8"
        width="17.6"
        height="14.4"
        rx="3.2"
        fill="currentColor"
        fillOpacity="0.07"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      {fullWidth ? (
        <path
          d="M3.6 15.2H20.4V16.8C20.4 17.9 19.5 18.8 18.4 18.8H5.6C4.5 18.8 3.6 17.9 3.6 16.8V15.2Z"
          fill="#A78BFA"
          fillOpacity="0.52"
          stroke="#DDD6FE"
          strokeWidth="1.15"
        />
      ) : (
        <rect
          x="5.6"
          y="13.8"
          width="12.8"
          height="3"
          rx="1.5"
          fill="#A78BFA"
          fillOpacity="0.45"
          stroke="#DDD6FE"
          strokeWidth="1.15"
        />
      )}
    </svg>
  );
}

/**
 * Custom crisp theater display screen for Window & Picture submenu.
 */
export function MenuScreenIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.2"
        y="4.8"
        width="17.6"
        height="12.4"
        rx="2.8"
        fill="#A78BFA"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <path d="M8.5 20H15.5" stroke="#DDD6FE" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M12 17.2V20" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom crystal cinema frame & media aperture for Media section headers.
 */
export function MenuMediaDiscIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="3.4"
        fill="#8B5CF6"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M7.5 4.8V19.2M16.5 4.8V19.2" stroke="#C4B5FD" strokeOpacity="0.65" strokeWidth="1.35" />
      <path d="M10.4 9.3L14.8 12L10.4 14.7V9.3Z" fill="#F8FAFC" />
    </svg>
  );
}

/**
 * Custom layered acoustic + caption streams badge for Audio & Subtitles section.
 */
export function MenuTrackListIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5 7.5H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 12H19" stroke="#DDD6FE" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5 16.5H13.2" stroke="#A78BFA" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="17.8" cy="16.5" r="2.2" fill="#C4B5FD" />
    </svg>
  );
}

/**
 * Custom slashed crystal screen icon for Subtitle Off option.
 */
export function MenuSubtitlesOffIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.2"
        y="5.2"
        width="17.6"
        height="13.6"
        rx="3.2"
        fill="currentColor"
        fillOpacity="0.06"
        stroke="currentColor"
        strokeOpacity="0.65"
        strokeWidth="1.55"
      />
      <path d="M6.8 13.8H11.5M13.8 13.8H17.2" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M4.8 19.2L19.2 4.8" stroke="#FB7185" strokeWidth="1.85" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom document with amethyst plus badge for adding external files/subtitles.
 */
export function MenuAddFileIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M6 4.2H13.2L17.5 8.5V18.2C17.5 19.2 16.7 20 15.7 20H6C5 20 4.2 19.2 4.2 18.2V6C4.2 5 5 4.2 6 4.2Z"
        fill="currentColor"
        fillOpacity="0.08"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M13 4.4V8.8H17.4" stroke="#C4B5FD" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M16.5 14.5H20.5M18.5 12.5V16.5" stroke="#DDD6FE" strokeWidth="1.85" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom precision clock / sync wave icon for Timing & Sync section headers.
 */
export function MenuTimingSyncIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle
        cx="12"
        cy="12.5"
        r="7.8"
        fill="#A78BFA"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <path d="M12 8.4V12.7L15 14.4" stroke="#DDD6FE" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 3.4H14.5" stroke="#C4B5FD" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom luminous droplet prism icon for Appearance section headers.
 */
export function MenuPaletteIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M12 3.8C8.1 8.4 6.2 11.4 6.2 14.3A5.8 5.8 0 0 0 17.8 14.3C17.8 11.4 15.9 8.4 12 3.8Z"
        fill="#A78BFA"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <circle cx="10.4" cy="14.2" r="1.4" fill="#F8FAFC" />
    </svg>
  );
}

/**
 * Custom typographic crystal Aa glyph for Subtitle Font Family.
 */
export function MenuFontIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.2 18.2L8.4 6.2L12.6 18.2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5.6 14.4H11.2" stroke="#DDD6FE" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16.8" cy="15.2" r="2.8" fill="#A78BFA" fillOpacity="0.18" stroke="#C4B5FD" strokeWidth="1.6" />
      <path d="M19.6 12.6V18.2" stroke="#C4B5FD" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom sculpted heavy B glyph for Bold Subtitle Font toggle.
 */
export function MenuBoldIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M7 5.5H13.2C15.2 5.5 16.6 6.7 16.6 8.5C16.6 10.1 15.5 11.3 13.8 11.6H7V5.5Z"
        fill="#A78BFA"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
      <path
        d="M7 11.6H14.2C16.4 11.6 17.8 13 17.8 15C17.8 17.1 16.4 18.5 14.2 18.5H7V11.6Z"
        fill="#A78BFA"
        fillOpacity="0.22"
        stroke="#DDD6FE"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom magic override prism brush icon for overriding styled fansubs.
 */
export function MenuOverrideFansubIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.5 19.5L14.8 9.2"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M15.6 4.2L16.6 7.1L19.5 8.1L16.6 9.1L15.6 12L14.6 9.1L11.7 8.1L14.6 7.1L15.6 4.2Z"
        fill="#C4B5FD"
        stroke="#DDD6FE"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <circle cx="8.2" cy="7.2" r="1.1" fill="#A78BFA" />
    </svg>
  );
}

/**
 * Custom crystal meridian globe icon for Text Encoding selection.
 */
export function MenuEncodingIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle
        cx="12"
        cy="12"
        r="8.4"
        fill="#8B5CF6"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <ellipse cx="12" cy="12" rx="3.8" ry="8.4" stroke="#C4B5FD" strokeWidth="1.45" />
      <path d="M4 12H20" stroke="#DDD6FE" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom Auto-Orbit + Next Episode crystal glyph for Auto-Next.
 */
export function MenuAutoNextIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M16.5 19.79A9 9 0 1 1 18.89 6.21"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M16.2 6.21H18.89V3.52"
        stroke="#DDD6FE"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.1 9.25C8.1 8.44 8.98 7.94 9.66 8.38L13.72 11.11C14.34 11.53 14.34 12.47 13.72 12.89L9.66 15.62C8.98 16.06 8.1 15.56 8.1 14.75V9.25Z"
        fill="#A78BFA"
        fillOpacity="0.22"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <rect x="15.1" y="8.35" width="2" height="7.3" rx="1" fill="#C4B5FD" />
    </svg>
  );
}

/**
 * Custom stacked card drawer glyph for Select / List Menu option headers.
 */
export function MenuInterfaceIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="3.2"
        fill="#A78BFA"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M3.8 9.2H20.2" stroke="#C4B5FD" strokeWidth="1.45" />
      <circle cx="7" cy="6.9" r="0.9" fill="#DDD6FE" />
      <circle cx="9.8" cy="6.9" r="0.9" fill="#A78BFA" />
    </svg>
  );
}

/**
 * Custom crystal magnifying lens icon for Online Subtitle Search.
 */
export function MenuSearchIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle
        cx="10.75"
        cy="10.75"
        r="6.25"
        fill="#A78BFA"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M15.4 15.4L19.8 19.8"
        stroke="#DDD6FE"
        strokeWidth="2.0"
        strokeLinecap="round"
      />
      <path
        d="M8.4 8.7C9.1 7.9 10.2 7.5 11.4 7.7"
        stroke="#DDD6FE"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Custom crystal download tray glyph for downloading fetched subtitles.
 */
export function MenuDownloadIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M12 4.5V14.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M8.2 11.2L12 15L15.8 11.2"
        stroke="#DDD6FE"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.8 16.5V18.2C4.8 19.1 5.5 19.8 6.4 19.8H17.6C18.5 19.8 19.2 19.1 19.2 18.2V16.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Custom screen bezel with docked chat trigger pill for Chat Button placement.
 */
export function MenuChatTriggerIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.2"
        y="4.8"
        width="17.6"
        height="14.4"
        rx="3"
        fill="currentColor"
        fillOpacity="0.10"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <rect
        x="7.2"
        y="14.6"
        width="9.6"
        height="2.1"
        rx="1.05"
        fill="currentColor"
      />
      <circle cx="17.2" cy="9.5" r="1.45" fill="currentColor" />
    </svg>
  );
}

/**
 * Custom viewport corner with floating message toast for Corner Peeks.
 */
export function MenuCornerPeekIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4 15.5V7.5C4 5.84 5.34 4.5 7 4.5H11"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
      <path
        d="M20 13.5V16.5C20 18.16 18.66 19.5 17 19.5H8.5"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
      <rect
        x="10.2"
        y="5.2"
        width="10.3"
        height="6.4"
        rx="2.2"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M12.8 8.4H17.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom photo frame with mountain silhouette and sun for Chat Photos.
 */
export function MenuChatPhotosIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="3.2"
        fill="currentColor"
        fillOpacity="0.10"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <circle cx="9" cy="9.4" r="1.55" fill="currentColor" />
      <path
        d="M5.2 17.6L10.1 12.8L13.5 15.9L16 13.5L19 17.6"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom ephemeral timer dial for Keep Photos retention.
 */
export function MenuPhotoRetentionIcon({ size = 14, className = "" }: MenuIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle
        cx="12"
        cy="12.5"
        r="7.8"
        fill="currentColor"
        fillOpacity="0.10"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <path d="M9.8 2.8H14.2" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
      <path
        d="M12 8.6V12.6L14.8 14.3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
