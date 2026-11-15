import { useId } from "react";

interface LobbyIconProps {
  size?: number;
  className?: string;
  bare?: boolean;
}

/**
 * Dedicated multi-layered icon for Watch Party:
 * synced widescreen cinema frame + wireless broadcast arc + friends silhouette trio.
 */
export function WatchPartyIcon({ size = 24, className = "", bare = false }: LobbyIconProps) {
  const uid = useId().replace(/:/g, "");
  const badgeId = `ep-party-badge-${uid}`;
  const screenId = `ep-party-screen-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={bare ? "3.5 2.5 25 26" : "0 0 32 32"}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={badgeId} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#5B21B6" stopOpacity="0.22" />
        </linearGradient>
        <linearGradient id={screenId} x1="6" y1="7" x2="26" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#C4B5FD" />
          <stop offset="45%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#5B21B6" />
        </linearGradient>
      </defs>

      {!bare && (
        /* Soft glass squircle housing */
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="10"
          fill={`url(#${badgeId})`}
          stroke="#DDD6FE"
          strokeOpacity="0.34"
          strokeWidth="1"
        />
      )}

      {/* Subtle sync signal arc above cinema screen */}
      <path
        d="M12.2 5.3C14.5 3.9 17.5 3.9 19.8 5.3"
        stroke="#EDE9FE"
        strokeOpacity="0.8"
        strokeWidth="1.4"
        strokeLinecap="round"
      />

      {/* Widescreen cinema display */}
      <rect
        x="5.5"
        y="7.4"
        width="21"
        height="13.2"
        rx="3.4"
        fill={`url(#${screenId})`}
        stroke="#F5F3FF"
        strokeOpacity="0.45"
        strokeWidth="0.9"
      />

      {/* Crisp centered play triangle */}
      <path
        d="M14.3 10.9L19.3 13.7C19.6 13.88 19.6 14.32 19.3 14.5L14.3 17.3C14 17.47 13.6 17.25 13.6 16.9V11.3C13.6 10.95 14 10.73 14.3 10.9Z"
        fill="#FFFFFF"
      />

      {/* Companion viewers flanking foreground */}
      <circle cx="9.6" cy="21.5" r="2.15" fill="#DDD6FE" />
      <path
        d="M5.8 27C6.1 24.9 7.6 23.8 9.6 23.8C11.1 23.8 12.2 24.4 12.9 25.4"
        fill="#DDD6FE"
      />
      <circle cx="22.4" cy="21.5" r="2.15" fill="#DDD6FE" />
      <path
        d="M19.1 25.4C19.8 24.4 20.9 23.8 22.4 23.8C24.4 23.8 25.9 24.9 26.2 27"
        fill="#DDD6FE"
      />

      {/* Center host viewer silhouette */}
      <circle cx="16" cy="20.7" r="2.55" fill="#FFFFFF" stroke="#4C1D95" strokeOpacity="0.28" strokeWidth="0.7" />
      <path
        d="M11.1 27.4C11.5 24.8 13.4 23.4 16 23.4C18.6 23.4 20.5 24.8 20.9 27.4Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

/**
 * Dedicated multi-layered icon for Open Media:
 * sculpted obsidian-silver cinema clapper slate paired with a luminous play lens.
 */
export function OpenMediaIcon({ size = 24, className = "", bare = false }: LobbyIconProps) {
  const uid = useId().replace(/:/g, "");
  const badgeId = `ep-media-badge-${uid}`;
  const slateId = `ep-media-slate-${uid}`;
  const discId = `ep-media-disc-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={bare ? "3.5 2.5 26 26" : "0 0 32 32"}
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={badgeId} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#94A3B8" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id={slateId} x1="6" y1="10" x2="23" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#CBD5E1" />
          <stop offset="100%" stopColor="#64748B" />
        </linearGradient>
        <linearGradient id={discId} x1="16" y1="15" x2="27" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#DDD6FE" />
        </linearGradient>
      </defs>

      {!bare && (
        /* Soft obsidian-silver frosted glass housing */
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="10"
          fill={`url(#${badgeId})`}
          stroke="#FFFFFF"
          strokeOpacity="0.24"
          strokeWidth="1"
        />
      )}

      {/* Tilted open cinema clapper top arm */}
      <g transform="rotate(-12 6.5 11.5)">
        <rect x="6" y="7.2" width="18" height="3.6" rx="1.4" fill="#E2E8F0" />
        <path d="M9.4 7.2H11.8L10.3 10.8H7.9L9.4 7.2Z" fill="#334155" />
        <path d="M14.4 7.2H16.8L15.3 10.8H12.9L14.4 7.2Z" fill="#334155" />
        <path d="M19.4 7.2H21.8L20.3 10.8H17.9L19.4 7.2Z" fill="#334155" />
      </g>

      {/* Media frame body */}
      <rect
        x="5.8"
        y="11.4"
        width="18.2"
        height="13.8"
        rx="3.2"
        fill={`url(#${slateId})`}
        stroke="#F8FAFC"
        strokeOpacity="0.38"
        strokeWidth="0.9"
      />

      {/* Subtle inner frame grooves */}
      <rect x="8.2" y="13.8" width="9" height="1.5" rx="0.75" fill="#1E293B" fillOpacity="0.45" />
      <rect x="8.2" y="16.8" width="5.5" height="1.5" rx="0.75" fill="#1E293B" fillOpacity="0.35" />

      {/* Luminous play badge overlapping bottom-right */}
      <circle
        cx="21.4"
        cy="20.8"
        r="6"
        fill={`url(#${discId})`}
        stroke="#8B5CF6"
        strokeOpacity="0.55"
        strokeWidth="1.1"
      />
      <path
        d="M19.9 18.4L24.2 20.8L19.9 23.2V18.4Z"
        fill="#1E1B4B"
      />
    </svg>
  );
}
