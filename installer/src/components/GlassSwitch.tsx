interface GlassSwitchTrackProps {
  checked: boolean;
}

/** Visual switch track + spring-animated thumb matching the main Epilod Party UI. */
export function GlassSwitchTrack({ checked }: GlassSwitchTrackProps) {
  return (
    <span
      aria-hidden="true"
      className={`ep-switch-track h-4 w-7.5 rounded-full p-0.5 flex items-center shrink-0 ${
        checked
          ? "bg-[#7C3AED] shadow-[0_0_12px_-2px_rgba(124,58,237,0.45)]"
          : "bg-white/15"
      }`}
    >
      <span className={`ep-switch-slide block ${checked ? "translate-x-3.5" : "translate-x-0"}`}>
        <span className="ep-switch-thumb block h-3 w-3 rounded-full bg-white shadow-sm" />
      </span>
    </span>
  );
}
