import { useId, type InputHTMLAttributes, type ReactNode } from "react";

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
  name,
  className = "",
  ...rest
}: TextFieldProps) {
  const fallbackId = useId();
  const inputId =
    id ||
    (label
      ? `ep-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      : fallbackId);

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
          name={name ?? inputId}
          className={`ep-glass-input w-full h-10 px-3.5 text-sm text-primary placeholder:text-muted rounded-xl focus:outline-none ${
            error ? "ring-2 ring-bad/60" : ""
          } ${rightSlot ? "pr-10" : ""} ${className}`}
          {...rest}
        />
        {rightSlot && (
          <div className="absolute right-2.5 flex items-center">{rightSlot}</div>
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
