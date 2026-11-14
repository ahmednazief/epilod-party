import type { InputHTMLAttributes, ReactNode } from "react";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  rightSlot?: ReactNode;
}

export function TextField({
  label,
  hint,
  error,
  rightSlot,
  id,
  className = "",
  ...rest
}: TextFieldProps) {
  const inputId = id || (label ? `ep-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined);

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-secondary">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        <input
          id={inputId}
          className={`w-full h-9 px-3 text-sm bg-canvas text-primary placeholder:text-muted border rounded-[var(--radius-ui)] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
            error ? "border-bad" : "border-hairline hover:border-muted"
          } ${rightSlot ? "pr-9" : ""} ${className}`}
          {...rest}
        />
        {rightSlot && (
          <div className="absolute right-2 flex items-center">{rightSlot}</div>
        )}
      </div>
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
