import appIcon from "../assets/app-icon.png";

interface BrandMarkProps {
  size?: number;
  className?: string;
}

export function BrandMark({ size = 44, className = "" }: BrandMarkProps) {
  return (
    <img
      src={appIcon}
      width={size}
      height={size}
      alt="Epilod Party"
      draggable={false}
      className={`block shrink-0 select-none object-contain ${className}`}
    />
  );
}
