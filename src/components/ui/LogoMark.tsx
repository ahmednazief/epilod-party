import appIcon from "../../assets/app-icon.png";
import watchPartyIcon from "../../assets/watch-party-icon.png";

interface LogoMarkProps {
  size?: number;
  variant?: "app" | "party";
  className?: string;
}

export function LogoMark({
  size = 28,
  variant = "app",
  className = "",
}: LogoMarkProps) {
  return (
    <img
      src={variant === "party" ? watchPartyIcon : appIcon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`block shrink-0 select-none object-contain ${className}`}
    />
  );
}
