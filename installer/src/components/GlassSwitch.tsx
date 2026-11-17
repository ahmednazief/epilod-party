interface GlassSwitchTrackProps {
  checked: boolean;
}

/** Visual switch track + spring-animated thumb with dark greyish liquid glass finish. */
export function GlassSwitchTrack({ checked }: GlassSwitchTrackProps) {
  return (
    <span
      aria-hidden="true"
      className={`ep-switch-track h-4 w-7.5 rounded-full p-0.5 flex items-center shrink-0 border ${
        checked
          ? "bg-white/35 border-white/30"
          : "bg-white/10 border-white/10"
      }`}
    >
      <span className={`ep-switch-slide block ${checked ? "translate-x-3.5" : "translate-x-0"}`}>
        <span className="ep-switch-thumb block h-3 w-3 rounded-full bg-white shadow-sm" />
      </span>
    </span>
  );
}
