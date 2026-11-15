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
import { SelectMenu } from "./ui/SelectMenu";

const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

const FRAME_PILLS: ReadonlyArray<{ value: AspectMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "16:9", label: "16:9" },
  { value: "21:9", label: "21:9" },
  { value: "4:3", label: "4:3" },
  { value: "fill", label: "Fill" },
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
    <div className="anim-tab-in grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-0.5">
      {/* Card 1: Speed */}
      <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-secondary">Playback Speed</span>
          {syncConnected && (
            <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-accent-soft">
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
                className={`ep-press h-7.5 rounded-full text-xs font-medium num transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
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

      {/* Card 2: Picture Frame pills */}
      <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2.5">
        <span className="text-xs font-medium text-secondary block">Picture Frame</span>
        <div className="ep-glass-input p-1 rounded-full grid grid-cols-5 gap-1">
          {FRAME_PILLS.map((item) => {
            const active = aspectMode === item.value;
            return (
              <button
                key={item.value}
                type="button"
                disabled={!loaded}
                onClick={() => {
                  setAspectMode(item.value);
                  void mpvSetAspectMode(item.value);
                }}
                className={`ep-press h-7.5 rounded-full text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:pointer-events-none ${
                  active
                    ? "ep-droplet-indicator text-white"
                    : "text-muted hover:text-primary"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Card 3: Audio Track & Loop */}
      <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-secondary">Audio Track</span>
          <button
            type="button"
            disabled={!loaded}
            aria-pressed={looping}
            onClick={() => {
              const next = !looping;
              setLooping(next);
              void mpvSetLoop(next);
            }}
            className={`ep-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium cursor-pointer disabled:opacity-45 disabled:pointer-events-none transition-colors ${
              looping
                ? "ep-glass-pill-active text-white"
                : "bg-white/[0.07] text-secondary hover:text-white hover:bg-white/[0.12]"
            }`}
          >
            <Repeat className="h-3 w-3" />
            <span>Loop Video</span>
          </button>
        </div>
        <SelectMenu
          ariaLabel="Audio Track"
          placement="top"
          disabled={!loaded}
          value={currentAudioVal}
          options={audioOptions.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(val) => {
            const aid = val === "none" ? null : Number(val);
            void selectAudioTrack(aid, { mpvSetAudioTrack });
          }}
        />
      </div>
    </div>
  );
});
