import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "ep-glass-primary-pill ep-press text-white font-medium",
  secondary: "ep-glass-pill ep-press text-primary hover:text-white hover:brightness-110",
  ghost:
    "ep-press bg-transparent text-secondary hover:text-primary hover:bg-white/[0.08]",
  danger:
    "ep-glass-pill ep-press text-bad hover:bg-bad/15",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7.5 px-3 text-xs rounded-full gap-1.5",
  md: "h-9 px-4 text-sm rounded-full gap-2",
  lg: "h-10.5 px-5 text-sm rounded-full gap-2",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`inline-flex items-center justify-center whitespace-nowrap select-none disabled:opacity-45 disabled:pointer-events-none cursor-pointer ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
