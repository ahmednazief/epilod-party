import { Lock, Repeat } from "lucide-react";
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
import { Button } from "./ui/Button";
import { SelectMenu, type SelectMenuOption } from "./ui/SelectMenu";

const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 2.0] as const;

const ASPECT_OPTIONS: ReadonlyArray<SelectMenuOption<AspectMode>> = [
  { value: "auto", label: "Auto (Original)" },
  { value: "16:9", label: "16:9 Widescreen" },
  { value: "4:3", label: "4:3 Classic" },
  { value: "21:9", label: "21:9 Cinema" },
  { value: "fill", label: "Stretch / Fill" },
];

export function PlaybackPanel() {
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
      pushNote("info", "Playback speed stays locked to 1.0× while synced with peers.");
      return;
    }
    setSpeed(nextSpeed);
    void mpvSetSpeed(nextSpeed);
  };

  return (
    <div className="anim-tab-in p-3 space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-secondary">Playback Speed</span>
          {syncConnected && (
            <span className="inline-flex items-center gap-1 text-[11px] text-accent">
              <Lock className="h-3 w-3" />
              Locked 1.0×
            </span>
          )}
        </div>
        <div className="grid grid-cols-5 gap-1">
          {SPEED_PRESETS.map((preset) => {
            const active = Math.abs(speed - preset) < 0.01;
            const disabled = !loaded || (syncConnected && preset !== 1.0);
            return (
              <Button
                key={preset}
                variant={active ? "primary" : "secondary"}
                size="sm"
                disabled={disabled}
                onClick={() => handleSpeedClick(preset)}
              >
                <span className="num">{preset === 1 ? "1×" : `${preset}×`}</span>
              </Button>
            );
          })}
        </div>
      </div>

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
        <span className="text-xs font-medium text-secondary block">Aspect Ratio</span>
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

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs font-medium text-secondary">Loop Video</span>
        <Button
          variant={looping ? "primary" : "secondary"}
          size="sm"
          disabled={!loaded}
          onClick={() => {
            const next = !looping;
            setLooping(next);
            void mpvSetLoop(next);
          }}
        >
          <Repeat className="h-3.5 w-3.5" />
          <span>{looping ? "Looping" : "Off"}</span>
        </Button>
      </div>
    </div>
  );
}
