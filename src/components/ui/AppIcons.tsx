import { useEffect, useId, useState } from "react";

interface AppIconProps {
  size?: number;
  className?: string;
  active?: boolean;
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
 * Custom faceted dual-tone crystal Sparkle emblem.
 */
export function AppSparkleIcon({ size = 14, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const coreId = `ep-spark-core-${uid}`;
  const facetId = `ep-spark-facet-${uid}`;
  const clipId = `ep-spark-clip-${uid}`;
  const mainStar =
    "M10.8 2.8L12.65 8.15L18 10L12.65 11.85L10.8 17.2L8.95 11.85L3.6 10L8.95 8.15L10.8 2.8Z";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={coreId} x1="4" y1="3" x2="18" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="55%" stopColor={active ? "#EDE9FE" : "#E2E8F0"} />
          <stop offset="100%" stopColor={active ? "#C4B5FD" : "#94A3B8"} />
        </linearGradient>
        <linearGradient id={facetId} x1="10" y1="10" x2="18" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#C4B5FD" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#7C3AED" stopOpacity="0.4" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={mainStar} />
        </clipPath>
      </defs>
      <path d={mainStar} fill={`url(#${coreId})`} />
      <g clipPath={`url(#${clipId})`}>
        <path d="M10.8 2.4H19V18H10.8V2.4Z" fill={`url(#${facetId})`} />
      </g>
      <path d={mainStar} stroke="#FFFFFF" strokeOpacity={active ? "0.75" : "0.45"} strokeWidth="0.7" strokeLinejoin="round" />
      <path
        d="M18.4 14.8L19.25 17.25L21.7 18.1L19.25 18.95L18.4 21.4L17.55 18.95L15.1 18.1L17.55 17.25L18.4 14.8Z"
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
 * Custom sculpted frosted channel & crystal pill Sliders icon for server connection settings.
 */
export function AppSlidersIcon({ size = 14, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-sliders-plate-${uid}`;
  const knobId = `ep-sliders-knob-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.22" : "0.11"} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={active ? "0.08" : "0.03"} />
        </linearGradient>
        <linearGradient id={knobId} x1="6" y1="5" x2="18" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#E2E8F0" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      <rect
        x="2.8"
        y="3.8"
        width="18.4"
        height="16.4"
        rx="5"
        fill={`url(#${plateId})`}
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.38" : "0.18"}
        strokeWidth="1"
      />
      <rect x="6" y="7.6" width="12" height="2.4" rx="1.2" fill="#FFFFFF" fillOpacity="0.22" />
      <rect x="6" y="14" width="12" height="2.4" rx="1.2" fill="#FFFFFF" fillOpacity="0.22" />
      <rect x="7" y="6.4" width="5.2" height="4.8" rx="2.4" fill={`url(#${knobId})`} />
      <rect x="11.8" y="12.8" width="5.2" height="4.8" rx="2.4" fill={`url(#${knobId})`} />
      <circle cx="9.6" cy="8.8" r="0.9" fill="#FFFFFF" />
      <circle cx="14.4" cy="15.2" r="0.9" fill="#FFFFFF" />
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
 * Custom sculpted liquid-crystal Download drop shard & dock pill icon.
 */
export function AppDownloadIcon({ size = 14, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-dl-plate-${uid}`;
  const shardId = `ep-dl-shard-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.24" : "0.11"} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={active ? "0.08" : "0.03"} />
        </linearGradient>
        <linearGradient id={shardId} x1="8" y1="5" x2="16" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#E2E8F0" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      <rect
        x="3.2"
        y="3.2"
        width="17.6"
        height="17.6"
        rx="5.4"
        fill={`url(#${plateId})`}
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.38" : "0.18"}
        strokeWidth="1"
      />
      <path
        d="M12 6.2C12.55 6.2 13 6.65 13 7.2V11.35L14.35 10C14.74 9.61 15.37 9.61 15.76 10C16.15 10.39 16.15 11.02 15.76 11.41L12.71 14.46C12.32 14.85 11.68 14.85 11.29 14.46L8.24 11.41C7.85 11.02 7.85 10.39 8.24 10C8.63 9.61 9.26 9.61 9.65 10L11 11.35V7.2C11 6.65 11.45 6.2 12 6.2Z"
        fill={`url(#${shardId})`}
      />
      <rect
        x="6.6"
        y="16.1"
        width="10.8"
        height="2.1"
        rx="1.05"
        fill={`url(#${shardId})`}
        fillOpacity={active ? "0.95" : "0.78"}
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
 * Custom sculpted crystal calibration Hex Dial icon for Advanced settings.
 */
export function AppWrenchIcon({ size = 13, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const dialId = `ep-adv-dial-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={dialId} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.95" : "0.75"} />
          <stop offset="100%" stopColor="#94A3B8" stopOpacity={active ? "0.85" : "0.6"} />
        </linearGradient>
      </defs>
      <path
        d="M10.45 3.65C11.4 3.1 12.6 3.1 13.55 3.65L18.1 6.28C19.05 6.83 19.65 7.85 19.65 8.95V15.05C19.65 16.15 19.05 17.17 18.1 17.72L13.55 20.35C12.6 20.9 11.4 20.9 10.45 20.35L5.9 17.72C4.95 17.17 4.35 16.15 4.35 15.05V8.95C4.35 7.85 4.95 6.83 5.9 6.28L10.45 3.65Z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke={`url(#${dialId})`}
        strokeWidth="1.45"
      />
      <circle cx="12" cy="12" r="3.1" fill={`url(#${dialId})`} />
      <circle cx="12" cy="12" r="1.25" fill="#0F172A" fillOpacity="0.85" />
    </svg>
  );
}

/**
 * Custom rounded frosted Telemetry Console slab icon for Diagnostics.
 */
export function AppLogsIcon({ size = 14, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-logs-plate-${uid}`;
  const glyphId = `ep-logs-glyph-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.22" : "0.11"} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={active ? "0.08" : "0.03"} />
        </linearGradient>
        <linearGradient id={glyphId} x1="6" y1="8" x2="18" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#E2E8F0" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      <rect
        x="2.8"
        y="3.8"
        width="18.4"
        height="16.4"
        rx="5"
        fill={`url(#${plateId})`}
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.38" : "0.18"}
        strokeWidth="1"
      />
      <path
        d="M7.1 9.2L10.2 11.9L7.1 14.6"
        stroke={`url(#${glyphId})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="12" y="13.5" width="4.8" height="2" rx="1" fill={`url(#${glyphId})`} />
      <rect x="13" y="9.1" width="3.8" height="1.7" rx="0.85" fill="#FFFFFF" fillOpacity="0.45" />
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

/**
 * Custom beveled obsidian-crystal Maximize / Restore Window icon.
 */
export function AppMaximizeIcon({
  restored = false,
  size = 13,
  className = "",
}: AppIconProps & { restored?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {restored ? (
        <>
          <path
            d="M8.5 7.4V6.2C8.5 4.98 9.48 4 10.7 4H17.8C19.02 4 20 4.98 20 6.2V13.3C20 14.52 19.02 15.5 17.8 15.5H16.6"
            stroke="#C4B5FD"
            strokeOpacity="0.82"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <rect
            x="4"
            y="8.4"
            width="11.6"
            height="11.6"
            rx="3.1"
            fill="currentColor"
            fillOpacity="0.11"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path d="M6.8 11.8H12.8" stroke="#DDD6FE" strokeWidth="1.45" strokeLinecap="round" />
        </>
      ) : (
        <>
          <rect
            x="4.4"
            y="4.4"
            width="15.2"
            height="15.2"
            rx="3.6"
            fill="currentColor"
            fillOpacity="0.09"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path d="M7.6 8.3H16.4" stroke="#DDD6FE" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/**
 * Custom Smoked-Amethyst crystal orbital progress ring for the title bar updater pill.
 */
export function AppUpdateProgressIcon({
  progress,
  verifying = false,
  size = 16,
  className = "",
}: AppIconProps & { progress: number; verifying?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const arcId = `ep-upd-arc-${uid}`;
  const clamped = Math.max(0, Math.min(1, progress));
  const circumference = 37.7;

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={arcId} x1="2" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EDE9FE" />
          <stop offset="55%" stopColor="#C4B5FD" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="rgba(255,255,255,0.14)"
        strokeWidth="1.8"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke={`url(#${arcId})`}
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - (verifying ? 1 : clamped))}
        transform="rotate(-90 8 8)"
        className="transition-[stroke-dashoffset] duration-150 ease-out"
      />
      <path
        d="M8 5.4L9.75 8L8 10.6L6.25 8L8 5.4Z"
        fill="#DDD6FE"
        className={verifying ? "animate-pulse" : ""}
      />
    </svg>
  );
}

/**
 * Custom faceted Smoked-Amethyst optical crystal Search lens icon.
 */
export function AppSearchIcon({ size = 14, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const lensId = `ep-search-lens-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={lensId} x1="4" y1="4" x2="17" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#EDE9FE" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0.10" />
        </linearGradient>
      </defs>
      <circle
        cx="10.6"
        cy="10.6"
        r="6.6"
        fill={`url(#${lensId})`}
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M7.6 8.3A3.8 3.8 0 0 1 11.4 6.8"
        stroke="#FFFFFF"
        strokeOpacity="0.78"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M15.6 15.6L20.2 20.2"
        stroke="#C4B5FD"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Custom stacked frosted crystal Season Folder icon distinguishing multi-episode queues.
 */
export function AppSeasonFolderIcon({ size = 14, className = "" }: AppIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M5.5 5.2H18.5C19.6 5.2 20.5 6.1 20.5 7.2V8.2"
        stroke="#A78BFA"
        strokeOpacity="0.72"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <path
        d="M3.5 8.6C3.5 7.38 4.48 6.4 5.7 6.4H9.2C9.9 6.4 10.56 6.72 11 7.26L12.05 8.5H18.3C19.52 8.5 20.5 9.48 20.5 10.7V17.2C20.5 18.42 19.52 19.4 18.3 19.4H5.7C4.48 19.4 3.5 18.42 3.5 17.2V8.6Z"
        fill="currentColor"
        fillOpacity="0.11"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path d="M7.5 12.6H16.5" stroke="#DDD6FE" strokeOpacity="0.88" strokeWidth="1.45" strokeLinecap="round" />
      <path d="M7.5 15.4H13.2" stroke="#C4B5FD" strokeOpacity="0.75" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom sculpted crystal Portrait emblem for Profile preferences.
 */
export function AppProfileCategoryIcon({ size = 15, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-prof-plate-${uid}`;
  const bustId = `ep-prof-bust-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.24" : "0.11"} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={active ? "0.08" : "0.03"} />
        </linearGradient>
        <linearGradient id={bustId} x1="8" y1="6" x2="16" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#E2E8F0" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="5.6"
        fill={`url(#${plateId})`}
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.4" : "0.18"}
        strokeWidth="1"
      />
      <circle cx="12" cy="9.4" r="2.65" fill={`url(#${bustId})`} />
      <path
        d="M7.3 17.5C7.65 15.05 9.6 13.75 12 13.75C14.4 13.75 16.35 15.05 16.7 17.5C16.78 18.02 16.37 18.45 15.84 18.45H8.16C7.63 18.45 7.22 18.02 7.3 17.5Z"
        fill={`url(#${bustId})`}
        fillOpacity={active ? "0.96" : "0.82"}
      />
    </svg>
  );
}

/**
 * Custom sculpted Liquid Capsule viewport icon for Appearance & Motion preferences.
 */
export function AppAppearanceCategoryIcon({ size = 15, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-app-plate-${uid}`;
  const pillId = `ep-app-pill-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.24" : "0.11"} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={active ? "0.08" : "0.03"} />
        </linearGradient>
        <linearGradient id={pillId} x1="6" y1="14" x2="18" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#E2E8F0" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      <rect
        x="2.8"
        y="3.8"
        width="18.4"
        height="16.4"
        rx="5.2"
        fill={`url(#${plateId})`}
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.4" : "0.18"}
        strokeWidth="1"
      />
      <path
        d="M6.4 8.1H12.4"
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.52" : "0.28"}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <rect
        x="5.6"
        y="13.5"
        width="12.8"
        height="3.4"
        rx="1.7"
        fill={`url(#${pillId})`}
        fillOpacity={active ? "0.96" : "0.82"}
      />
      <circle cx="8" cy="15.2" r="0.85" fill="#0F172A" fillOpacity="0.65" />
    </svg>
  );
}

/**
 * Custom sculpted Cinema Prism & Caption bars icon for Playback & Subtitles preferences.
 */
export function AppPlaybackCategoryIcon({ size = 15, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const plateId = `ep-pb-plate-${uid}`;
  const playId = `ep-pb-play-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={plateId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.24" : "0.11"} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={active ? "0.08" : "0.03"} />
        </linearGradient>
        <linearGradient id={playId} x1="9" y1="6" x2="16" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#E2E8F0" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      <rect
        x="2.8"
        y="3.6"
        width="18.4"
        height="16.8"
        rx="5.2"
        fill={`url(#${plateId})`}
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.4" : "0.18"}
        strokeWidth="1"
      />
      <path
        d="M9.7 7.6C9.7 6.95 10.42 6.56 10.97 6.9L14.95 9.38C15.48 9.7 15.48 10.47 14.95 10.8L10.97 13.28C10.42 13.62 9.7 13.22 9.7 12.57V7.6Z"
        fill={`url(#${playId})`}
      />
      <rect x="6.5" y="15.3" width="6.8" height="1.9" rx="0.95" fill={`url(#${playId})`} fillOpacity={active ? "0.95" : "0.78"} />
      <rect x="14.5" y="15.3" width="3" height="1.9" rx="0.95" fill="#FFFFFF" fillOpacity={active ? "0.58" : "0.36"} />
    </svg>
  );
}

/**
 * Custom sculpted crystal Crest emblem for Watch Party & Privacy preferences.
 */
export function AppPartyPrivacyCategoryIcon({ size = 15, active = false, className = "" }: AppIconProps) {
  const uid = useId().replace(/:/g, "");
  const shieldId = `ep-priv-shield-${uid}`;
  const jewelId = `ep-priv-jewel-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={shieldId} x1="5" y1="3" x2="19" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={active ? "0.26" : "0.12"} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={active ? "0.08" : "0.03"} />
        </linearGradient>
        <linearGradient id={jewelId} x1="9" y1="8" x2="15" y2="15" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor={active ? "#E2E8F0" : "#CBD5E1"} />
        </linearGradient>
      </defs>
      <path
        d="M12 3.1C14.9 4.35 17.55 4.85 19.1 5.18V11.35C19.1 15.6 16.15 19.2 12 20.85C7.85 19.2 4.9 15.6 4.9 11.35V5.18C6.45 4.85 9.1 4.35 12 3.1Z"
        fill={`url(#${shieldId})`}
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.42" : "0.2"}
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11.2" r="2.75" fill={`url(#${jewelId})`} />
      <path
        d="M8.7 11.2C9.55 9.75 10.7 9.1 12 9.1"
        stroke="#FFFFFF"
        strokeOpacity={active ? "0.85" : "0.45"}
        strokeWidth="1.05"
        strokeLinecap="round"
      />
    </svg>
  );
}

let cachedPillRefractionUrl: string | null = null;

function buildPillRefractionMapDataUrl(): string {
  if (cachedPillRefractionUrl) return cachedPillRefractionUrl;
  if (typeof document === "undefined") return "";
  const w = 144;
  const h = 90;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const rx = w * 0.5;
  const ry = h * 0.5;
  const r = ry;
  const boxHalfX = rx - r;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - rx;
      const dy = y + 0.5 - ry;
      const qx = Math.abs(dx) - boxHalfX;
      const ex = qx > 0 ? qx : 0;
      const ey = Math.abs(dy);
      const dist = Math.hypot(ex, ey);
      const t = Math.min(1, dist / r);
      const invDist = dist > 1e-4 ? 1 / dist : 0;
      const nx = ex > 0 ? (dx >= 0 ? 1 : -1) * ex * invDist : 0;
      const ny = (dy >= 0 ? 1 : -1) * ey * invDist;
      // Continuous C1 convex dome + steeper peripheral meniscus refraction
      const mag = -0.28 * t + 0.92 * Math.pow(t, 4);
      const sx = Math.max(-1, Math.min(1, nx * mag));
      const sy = Math.max(-1, Math.min(1, ny * mag));
      const idx = (y * w + x) * 4;
      d[idx] = Math.round(128 + sx * 127);
      d[idx + 1] = Math.round(128 + sy * 127);
      d[idx + 2] = 128;
      d[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  cachedPillRefractionUrl = canvas.toDataURL("image/png");
  return cachedPillRefractionUrl;
}

/**
 * Shared SVG refraction filter mounted once at the app root so dragged Liquid Glass
 * slider droplets optically magnify and bend the track and layers beneath them.
 */
export function AppLiquidGlassDefs() {
  const [mapHref, setMapHref] = useState<string>("");

  useEffect(() => {
    const url = buildPillRefractionMapDataUrl();
    if (url) setMapHref(url);
  }, []);

  if (!mapHref) return null;

  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      className="pointer-events-none fixed -top-[9999px] -left-[9999px] h-0 w-0"
    >
      <defs>
        <filter
          id="ep-scrubber-liquid-lens"
          x="-15%"
          y="-15%"
          width="130%"
          height="130%"
          colorInterpolationFilters="sRGB"
        >
          <feImage href={mapHref} result="map" preserveAspectRatio="none" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="map"
            scale="20"
            xChannelSelector="R"
            yChannelSelector="G"
            result="refracted"
          />
          <feColorMatrix in="refracted" type="saturate" values="1.38" result="saturated" />
          <feGaussianBlur in="saturated" stdDeviation="0.22" result="smooth" />
          <feMerge>
            <feMergeNode in="smooth" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}
