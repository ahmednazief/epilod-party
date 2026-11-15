interface AppIconProps {
  size?: number;
  className?: string;
}

/**
 * Custom beveled crystal Close cross.
 */
export function AppCloseIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M6.5 6.5L17.5 17.5" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" />
      <path d="M17.5 6.5L6.5 17.5" stroke="currentColor" strokeOpacity="0.85" strokeWidth="1.95" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom sleek window Minimize bar.
 */
export function AppMinimizeIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5.5 12H18.5" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom luminous Checkmark glyph.
 */
export function AppCheckIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M5.2 12.6L9.8 17.2L18.8 7.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom crystal directional chevron.
 */
export function AppChevronIcon({
  direction = "down",
  size = 14,
  className = "",
}: AppIconProps & { direction?: "left" | "right" | "down" | "up" }) {
  const path =
    direction === "left"
      ? "M14.8 6L8.8 12L14.8 18"
      : direction === "right"
        ? "M9.2 6L15.2 12L9.2 18"
        : direction === "up"
          ? "M6 14.8L12 8.8L18 14.8"
          : "M6 9.2L12 15.2L18 9.2";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom sleek directional arrow with lavender accent.
 */
export function AppArrowIcon({
  direction = "right",
  size = 14,
  className = "",
}: AppIconProps & { direction?: "left" | "right" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {direction === "left" ? (
        <>
          <path d="M18.5 12H6" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
          <path
            d="M11 6.8L5.6 12L11 17.2"
            stroke="#DDD6FE"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path d="M5.5 12H18" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
          <path
            d="M13 6.8L18.4 12L13 17.2"
            stroke="#DDD6FE"
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

/**
 * Custom dual-tone crystal Plus emblem.
 */
export function AppPlusIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5.5 12H18.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12 5.5V18.5" stroke="#C4B5FD" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom frosted crystal Folder icon with subtle amethyst pocket crease.
 */
export function AppFolderIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M3.5 7.5C3.5 6.12 4.62 5 6 5H9.6C10.35 5 11.06 5.34 11.54 5.92L12.7 7.3H18C19.38 7.3 20.5 8.42 20.5 9.8V16.8C20.5 18.18 19.38 19.3 18 19.3H6C4.62 19.3 3.5 18.18 3.5 16.8V7.5Z"
        fill="currentColor"
        fillOpacity="0.09"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path d="M7.5 11.5H16.5" stroke="#C4B5FD" strokeOpacity="0.85" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom 4-point amethyst crystal Sparkle icon for smart features & magic sync.
 */
export function AppSparkleIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M11.2 3.2L13 8.8L18.6 10.6L13 12.4L11.2 18L9.4 12.4L3.8 10.6L9.4 8.8L11.2 3.2Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <path
        d="M18.4 15.2L19.2 17.5L21.5 18.3L19.2 19.1L18.4 21.4L17.6 19.1L15.3 18.3L17.6 17.5L18.4 15.2Z"
        fill="#DDD6FE"
      />
    </svg>
  );
}

/**
 * Custom twin crystal arc Repeat / Loop icon.
 */
export function AppRepeatIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.5 11.2V9.8C4.5 7.7 6.2 6 8.3 6H18.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M16 3.5L19 6L16 8.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M19.5 12.8V14.2C19.5 16.3 17.8 18 15.7 18H5.5"
        stroke="#C4B5FD"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M8 15.5L5 18L8 20.5" stroke="#C4B5FD" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Custom crystal Lock emblem.
 */
export function AppLockIcon({ size = 12, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8.2 10.5V7.8C8.2 5.7 9.9 4 12 4C14.1 4 15.8 5.7 15.8 7.8V10.5"
        stroke="#DDD6FE"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <rect
        x="5.2"
        y="10.5"
        width="13.6"
        height="9.8"
        rx="3"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="15.3" r="1.4" fill="currentColor" />
    </svg>
  );
}

/**
 * Custom crystal precision Sliders icon for style tuning & server connection settings.
 */
export function AppSlidersIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M4.5 7.5H19.5" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9.2" cy="7.5" r="2.4" fill="#A78BFA" fillOpacity="0.35" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 16.5H19.5" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="14.8" cy="16.5" r="2.4" fill="#A78BFA" fillOpacity="0.35" stroke="#DDD6FE" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * Custom circular Reset / Refresh crystal arc icon.
 */
export function AppResetIcon({
  clockwise = false,
  size = 14,
  className = "",
}: AppIconProps & { clockwise?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {clockwise ? (
        <>
          <path
            d="M19.2 12A7.2 7.2 0 1 1 17.1 6.9"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path d="M18.8 4.4V8.4H14.8" stroke="#C4B5FD" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path
            d="M4.8 12A7.2 7.2 0 1 0 6.9 6.9"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path d="M5.2 4.4V8.4H9.2" stroke="#C4B5FD" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

/**
 * Custom soft-beveled crystal Stop square.
 */
export function AppStopIcon({ size = 13, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="5.5"
        y="5.5"
        width="13"
        height="13"
        rx="3.2"
        fill="currentColor"
        fillOpacity="0.32"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

/**
 * Custom beveled warning triangle or notice badge.
 */
export function AppAlertIcon({
  variant = "warn",
  size = 16,
  className = "",
}: AppIconProps & { variant?: "warn" | "info" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {variant === "warn" ? (
        <>
          <path
            d="M10.45 4.4C11.14 3.2 12.86 3.2 13.55 4.4L20.5 16.5C21.18 17.7 20.32 19.2 18.95 19.2H5.05C3.68 19.2 2.82 17.7 3.5 16.5L10.45 4.4Z"
            fill="currentColor"
            fillOpacity="0.16"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinejoin="round"
          />
          <path d="M12 9.2V13.1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="12" cy="15.8" r="1" fill="currentColor" />
        </>
      ) : (
        <>
          <circle
            cx="12"
            cy="12"
            r="8.8"
            fill="currentColor"
            fillOpacity="0.14"
            stroke="currentColor"
            strokeWidth="1.65"
          />
          <path d="M12 8.2V12.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="12" cy="15.5" r="1" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * Custom crystal Download arrow & dock tray.
 */
export function AppDownloadIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M12 4.5V14.8" stroke="#DDD6FE" strokeWidth="1.85" strokeLinecap="round" />
      <path d="M8.2 11.2L12 15L15.8 11.2" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M5 16.2V17.6C5 18.65 5.85 19.5 6.9 19.5H17.1C18.15 19.5 19 18.65 19 17.6V16.2"
        stroke="currentColor"
        strokeOpacity="0.85"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Custom beveled Keyboard icon with highlighted Spacebar key.
 */
export function AppKeyboardIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3"
        y="5.5"
        width="18"
        height="13"
        rx="3.2"
        fill="currentColor"
        fillOpacity="0.08"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <circle cx="7.2" cy="9.5" r="0.95" fill="currentColor" />
      <circle cx="10.4" cy="9.5" r="0.95" fill="currentColor" />
      <circle cx="13.6" cy="9.5" r="0.95" fill="currentColor" />
      <circle cx="16.8" cy="9.5" r="0.95" fill="currentColor" />
      <path d="M7.5 14.5H16.5" stroke="#C4B5FD" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom crystal Room Key icon for password / room options.
 */
export function AppKeyIcon({ size = 13, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle
        cx="8.5"
        cy="14.5"
        r="4.2"
        fill="#A78BFA"
        fillOpacity="0.16"
        stroke="#C4B5FD"
        strokeWidth="1.7"
      />
      <path d="M11.6 11.4L18.8 4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M16.2 6.8L19 9.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M18.2 4.8L20.5 7.1" stroke="#C4B5FD" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom beveled profile Edit stylus icon.
 */
export function AppEditIcon({ size = 13, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M15.8 4.4L19.6 8.2L8.6 19.2L4.2 19.8L4.8 15.4L15.8 4.4Z"
        fill="#A78BFA"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path d="M13.2 7L17 10.8" stroke="#DDD6FE" strokeWidth="1.65" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom interlaced crystal Shuffle ribbons.
 */
export function AppShuffleIcon({ size = 13, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4 7.5H7.8C9.3 7.5 10.7 8.2 11.5 9.5L13.5 12.8C14.3 14.1 15.7 14.8 17.2 14.8H19.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M4 16.5H7.8C9.3 16.5 10.7 15.8 11.5 14.5L13.5 11.2C14.3 9.9 15.7 9.2 17.2 9.2H19.5"
        stroke="#C4B5FD"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M17.2 6.8L19.8 9.2L17.2 11.6" stroke="#C4B5FD" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.2 12.4L19.8 14.8L17.2 17.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Custom sculpted crystal Wrench icon for Advanced settings.
 */
export function AppWrenchIcon({ size = 13, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M14.7 6.3A4.5 4.5 0 0 0 9.8 12.2L5 17A1.4 1.4 0 0 0 7 19L11.8 14.2A4.5 4.5 0 0 0 17.7 9.3L15.1 11.9L12.1 8.9L14.7 6.3Z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom rounded diagnostic Console / Logs window icon.
 */
export function AppLogsIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect
        x="3.2"
        y="4.5"
        width="17.6"
        height="15"
        rx="3.2"
        fill="currentColor"
        fillOpacity="0.08"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      <path d="M7.2 9.5L10.2 12L7.2 14.5" stroke="#DDD6FE" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.2 14.5H16.2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom beveled cryptographic Shield verification crest.
 */
export function AppShieldIcon({ size = 13, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M12 3.5L19 6.3V11.6C19 15.8 16 19.2 12 20.6C8 19.2 5 15.8 5 11.6V6.3L12 3.5Z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M8.8 12.1L11 14.3L15.4 9.7"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
