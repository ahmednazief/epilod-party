import { Lock, Repeat } from "lucide-react";
import { memo } from "react";
import {
  mpvSetAspectMode,
  mpvSetAudioTrack,
  mpvSetLoop,
  mpvSetSpeed,
  type AspectMode,
} from "../lib/mpv";
import { canChangePlaybackSpeed } from "../lib/syncSpeedGuard";
import { buildAudioTrackOptions, selectAudioTrack } from "../lib/tracks";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { SelectMenu, type SelectMenuOption } from "./ui/SelectMenu";

const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

const ASPECT_OPTIONS: ReadonlyArray<SelectMenuOption<AspectMode>> = [
  { value: "auto", label: "Auto (Original)" },
  { value: "16:9", label: "16:9 Widescreen" },
  { value: "4:3", label: "4:3 Classic" },
  { value: "21:9", label: "21:9 Cinema" },
  { value: "fill", label: "Stretch / Fill" },
];

export const PlaybackPanel = memo(function PlaybackPanel() {
  const loaded = usePlayerStore((s) => s.loaded);
  const speed = usePlayerStore((s) => s.speed);
  const looping = usePlayerStore((s) => s.looping);
  const aspectMode = usePlayerStore((s) => s.aspectMode);
  const tracks = usePlayerStore((s) => s.tracks);

  const setSpeed = usePlayerStore((s) => s.setSpeed);
  const setLooping = usePlayerStore((s) => s.setLooping);
  const setAspectMode = usePlayerStore((s) => s.setAspectMode);
  const syncConnected = useSyncStore((s) => s.status.state === "connected");
  const pushNote = useNotificationStore((s) => s.push);

  const audioOptions = buildAudioTrackOptions(tracks);
  const selectedAudio = tracks.find((t) => t.type === "audio" && t.selected);
  const currentAudioVal = selectedAudio ? String(selectedAudio.id) : "none";

  const handleSpeedClick = (nextSpeed: number) => {
    if (!canChangePlaybackSpeed(syncConnected, nextSpeed)) {
      pushNote("info", "Playback speed stays synced at 1.0× while watching with peers.");
      return;
    }
    setSpeed(nextSpeed);
    void mpvSetSpeed(nextSpeed);
  };

  return (
    <div className="anim-tab-in px-4 py-3.5 space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-secondary">Speed</span>
          {syncConnected && (
            <span className="inline-flex items-center gap-1 text-[11px] text-accent-soft">
              <Lock className="h-3 w-3" />
              Synced 1.0×
            </span>
          )}
        </div>
        <div className="ep-glass-input p-1 rounded-full grid grid-cols-5 gap-1">
          {SPEED_PRESETS.map((preset) => {
            const active = Math.abs(speed - preset) < 0.01;
            const disabled = !loaded || (syncConnected && preset !== 1.0);
            return (
              <button
                key={preset}
                type="button"
                disabled={disabled}
                onClick={() => handleSpeedClick(preset)}
                className={`ep-press h-7 rounded-full text-xs font-medium num transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
                  active
                    ? "ep-droplet-indicator text-white"
                    : "text-muted hover:text-primary"
                }`}
              >
                {preset === 1 ? "1×" : `${preset}×`}
              </button>
            );
          })}
        </div>
      </div>

      <div className="ep-hairline-divider" />

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-secondary block">Audio Track</span>
        <SelectMenu
          ariaLabel="Audio Track"
          disabled={!loaded}
          value={currentAudioVal}
          options={audioOptions.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(val) => {
            const aid = val === "none" ? null : Number(val);
            void selectAudioTrack(aid, { mpvSetAudioTrack });
          }}
        />
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-secondary block">Picture Frame</span>
        <SelectMenu
          ariaLabel="Aspect Ratio"
          disabled={!loaded}
          value={aspectMode}
          options={ASPECT_OPTIONS}
          onChange={(val) => {
            setAspectMode(val);
            void mpvSetAspectMode(val);
          }}
        />
      </div>

      <div className="ep-hairline-divider" />

      <button
        type="button"
        disabled={!loaded}
        onClick={() => {
          const next = !looping;
          setLooping(next);
          void mpvSetLoop(next);
        }}
        className="ep-menu-row ep-press w-full px-2.5 py-2 flex items-center justify-between gap-3 cursor-pointer disabled:opacity-45 disabled:pointer-events-none"
      >
        <span className="inline-flex items-center gap-2 text-xs font-medium text-primary">
          <Repeat className="h-3.5 w-3.5 text-secondary" />
          Loop Video
        </span>
        <span
          className={`ep-switch-track w-10 h-6 rounded-full p-0.5 flex items-center transition-colors ${
            looping ? "bg-accent justify-end" : "bg-white/18 justify-start"
          }`}
        >
          <span className="ep-switch-thumb h-5 w-5 rounded-full bg-white shadow" />
        </span>
      </button>
    </div>
  );
});
