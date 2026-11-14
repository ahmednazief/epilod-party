interface LogoMarkProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 28, className = "" }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="14" fill="#15151A" stroke="#1D1D24" strokeWidth="2" />
      {/* Stylized popcorn kernels */}
      <circle cx="24" cy="21" r="6" fill="#F4F4F6" />
      <circle cx="32" cy="18" r="7" fill="#E5A93C" />
      <circle cx="40" cy="21" r="6" fill="#F4F4F6" />
      <circle cx="28" cy="25" r="5" fill="#FBBF24" />
      <circle cx="36" cy="25" r="5" fill="#F4F4F6" />
      {/* Striped cinema bucket */}
      <path d="M19 26H45L41 49C40.7 50.7 39.2 52 37.5 52H26.5C24.8 52 23.3 50.7 23 49L19 26Z" fill="#E5A93C" />
      <path d="M25 26L27 52M32 26V52M39 26L37 52" stroke="#0E0E11" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
