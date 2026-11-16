import { useId } from "react";

interface InstallerIconProps {
  size?: number;
  className?: string;
}

/**
 * Custom sleek obsidian-crystal Minimize dash for installer window chrome.
 */
export function InstallerMinimizeIcon({ size = 13, className = "" }: InstallerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect x="4.8" y="10.8" width="14.4" height="2.4" rx="1.2" fill="currentColor" fillOpacity="0.24" />
      <path d="M5.5 12H18.5" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom beveled Smoked-Amethyst Close cross for installer window chrome.
 */
export function InstallerCloseIcon({ size = 13, className = "" }: InstallerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M6.5 6.5L17.5 17.5" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" />
      <path d="M17.5 6.5L6.5 17.5" stroke="#DDD6FE" strokeOpacity="0.88" strokeWidth="1.95" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom sleek directional crystal Arrow with beveled lavender chevron.
 */
export function InstallerArrowIcon({
  direction = "right",
  size = 14,
  className = "",
}: InstallerIconProps & { direction?: "left" | "right" }) {
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
 * Custom sculpted crystal Checkmark emblem for install completion badge.
 */
export function InstallerCheckIcon({ size = 13, className = "" }: InstallerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M5.2 12.6L9.8 17.2L18.8 7.4"
        stroke="currentColor"
        strokeWidth="2.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.8 17.2L18.8 7.4"
        stroke="#ECFDF5"
        strokeOpacity="0.55"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Custom crystal precision Sliders icon for Customize setup button.
 */
export function InstallerSlidersIcon({ size = 12, className = "" }: InstallerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M4.5 7.5H19.5" stroke="currentColor" strokeOpacity="0.65" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="9.2" cy="7.5" r="2.4" fill="#A78BFA" fillOpacity="0.4" stroke="currentColor" strokeWidth="1.65" />
      <path d="M4.5 16.5H19.5" stroke="currentColor" strokeOpacity="0.65" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="14.8" cy="16.5" r="2.4" fill="#A78BFA" fillOpacity="0.4" stroke="#DDD6FE" strokeWidth="1.65" />
    </svg>
  );
}

/**
 * Custom frosted crystal Folder icon for installer directory selection.
 */
export function InstallerFolderIcon({ size = 12, className = "" }: InstallerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M3.5 7.5C3.5 6.12 4.62 5 6 5H9.6C10.35 5 11.06 5.34 11.54 5.92L12.7 7.3H18C19.38 7.3 20.5 8.42 20.5 9.8V16.8C20.5 18.18 19.38 19.3 18 19.3H6C4.62 19.3 3.5 18.18 3.5 16.8V7.5Z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M7.5 11.8H16.5" stroke="#DDD6FE" strokeOpacity="0.88" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Custom circular Reset arc icon for restoring default installer path.
 */
export function InstallerResetIcon({ size = 12, className = "" }: InstallerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.8 12A7.2 7.2 0 1 0 6.9 6.9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path d="M5.2 4.4V8.4H9.2" stroke="#C4B5FD" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Custom faceted Smoked-Amethyst crystal Launch play prism for launching Epilod Party.
 */
export function InstallerLaunchIcon({ size = 13, className = "" }: InstallerIconProps) {
  const uid = useId().replace(/:/g, "");
  const prismId = `ep-inst-launch-${uid}`;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={prismId} x1="6" y1="5" x2="19" y2="19" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#DDD6FE" />
        </linearGradient>
      </defs>
      <path
        d="M7.5 6.2C7.5 5.1 8.7 4.45 9.65 5.02L18.45 10.32C19.35 10.86 19.35 12.14 18.45 12.68L9.65 17.98C8.7 18.55 7.5 17.9 7.5 16.8V6.2Z"
        fill={`url(#${prismId})`}
        stroke="#FFFFFF"
        strokeOpacity="0.6"
        strokeWidth="0.9"
      />
    </svg>
  );
}
