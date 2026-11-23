interface GlassSwitchTrackProps {
  checked: boolean;
  size?: "sm" | "md";
  className?: string;
}

/** Visual switch track + spring-animated thumb for both standalone switches and row controls. */
export function GlassSwitchTrack({
  checked,
  size = "sm",
  className = "",
}: GlassSwitchTrackProps) {
  const trackSize = size === "md" ? "w-10 h-6" : "w-7.5 h-4";
  const thumbSize = size === "md" ? "w-5 h-5" : "w-3 h-3";
  const slideOffset =
    size === "md"
      ? checked
        ? "translate-x-4"
        : "translate-x-0"
      : checked
        ? "translate-x-3.5"
        : "translate-x-0";

  return (
    <span
      className={`ep-switch-track ${trackSize} rounded-full p-0.5 flex items-center shrink-0 overflow-hidden ${
        checked
          ? "bg-accent shadow-[0_0_12px_-2px_rgba(124,58,237,0.45)] hover:ring-1 hover:ring-white/25"
          : "bg-white/15"
      } ${className}`}
    >
      <span className={`ep-switch-slide block ${slideOffset}`}>
        <span
          className={`ep-switch-thumb block ${thumbSize} rounded-full bg-white shadow-sm`}
        />
      </span>
    </span>
  );
}

interface GlassSwitchProps {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/** Accessible clickable switch button backed by the spring-animated GlassSwitchTrack. */
export function GlassSwitch({
  checked,
  onChange,
  ariaLabel,
  size = "sm",
  disabled = false,
  className = "",
}: GlassSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className={`ep-press inline-flex items-center rounded-full cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${className}`}
    >
      <GlassSwitchTrack checked={checked} size={size} />
    </button>
  );
}
