import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white font-medium hover:bg-accent-hover active:translate-y-px border border-transparent",
  secondary:
    "bg-raised text-primary hover:bg-hover border border-hairline active:translate-y-px",
  ghost:
    "bg-transparent text-secondary hover:text-primary hover:bg-hover border border-transparent",
  danger:
    "bg-raised text-bad hover:bg-hover border border-bad/40 active:translate-y-px",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-xs rounded-[var(--radius-ui)] gap-1.5",
  md: "h-9 px-3.5 text-sm rounded-[var(--radius-ui)] gap-2",
  lg: "h-10 px-4 text-sm rounded-[var(--radius-ui)] gap-2",
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
      className={`inline-flex items-center justify-center whitespace-nowrap select-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45 disabled:pointer-events-none cursor-pointer ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
