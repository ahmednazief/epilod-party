import { memo } from "react";
import {
  mpvSetAspectMode,
  mpvSetSpeed,
  safeMpvCall,
  type AspectMode,
} from "../lib/mpv";
import {
  selectAudioTrackOption,
  toggleLoopPlayback,
  toggleMutePlayback,
} from "../lib/playerActions";
import { canChangePlaybackSpeed } from "../lib/syncSpeedGuard";
import { buildAudioTrackOptions } from "../lib/tracks";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { AppCheckIcon, AppLockIcon, AppRepeatIcon } from "./ui/AppIcons";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { PlayerVolumeIcon } from "./ui/PlayerIcons";
import { SegmentedTabs } from "./ui/SegmentedTabs";

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
  const muted = usePlayerStore((s) => s.muted);
  const speed = usePlayerStore((s) => s.speed);
  const looping = usePlayerStore((s) => s.looping);
  const aspectMode = usePlayerStore((s) => s.aspectMode);
  const tracks = usePlayerStore((s) => s.tracks);

  const setSpeed = usePlayerStore((s) => s.setSpeed);
  const setAspectMode = usePlayerStore((s) => s.setAspectMode);
  const syncStatus = useSyncStore((s) => s.status);
  const syncConnected = syncStatus.state === "connected";
  const timelineScale = useSyncStore((s) => s.timelineScale);
  const pushNote = useNotificationStore((s) => s.push);

  const audioOptions = buildAudioTrackOptions(tracks);
  const audioCount = audioOptions.filter((o) => o.track !== null).length;
  const selectedAudio = tracks.find((t) => t.type === "audio" && t.selected);
  const currentAudioVal = selectedAudio ? String(selectedAudio.id) : "none";
  const syncedSpeedLabel =
    Math.abs(timelineScale - 1.0) > 0.001 ? `${timelineScale.toFixed(3)}×` : "1.0×";

  const handleSpeedClick = (nextSpeed: number) => {
    if (!canChangePlaybackSpeed(syncConnected, nextSpeed, timelineScale)) {
      pushNote("info", `Playback speed stays synced at ${syncedSpeedLabel} while watching with peers.`);
      return;
    }
    setSpeed(nextSpeed);
    safeMpvCall(mpvSetSpeed(nextSpeed), "mpvSetSpeed");
  };

  return (
    <div role="menu" aria-label="Audio and playback options" className="flex flex-col gap-4">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={muted}
        onClick={() => toggleMutePlayback()}
        className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs text-primary/95 hover:text-white cursor-pointer"
      >
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
            <PlayerVolumeIcon muted={muted} size={14} />
          </span>
          <span className="truncate">Mute Audio</span>
        </span>
        <GlassSwitchTrack checked={muted} size="sm" />
      </button>

      <div className="space-y-2">
        <div className="px-3 flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-white/45">
          <span>Audio Track</span>
          {loaded && (
            <span className="num text-white/40">
              {muted ? "Muted" : audioCount}
            </span>
          )}
        </div>

        {!loaded ? (
          <div className="px-3 py-1.5 text-xs text-muted">
            Open a video to switch audio tracks
          </div>
        ) : (
          <div className="ep-menu-scroll max-h-40 overflow-y-auto overflow-x-hidden pr-1 space-y-1.5">
            {audioOptions.map((opt) => {
              const active = opt.value === currentAudioVal;
              const t = opt.track;
              const primaryLabel = t
                ? t.title?.trim() ||
                  (t.lang ? `${t.lang.trim().toUpperCase()} Audio` : `Audio Track ${t.id}`)
                : "Mute / Off";
              const metaTags: string[] = [];
              if (t?.title?.trim() && t.lang?.trim()) {
                metaTags.push(t.lang.trim().toUpperCase());
              }
              if (t?.codec?.trim()) {
                metaTags.push(t.codec.trim().toUpperCase());
              }
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  data-active={active}
                  onClick={() => {
                    const aid = opt.value === "none" ? null : Number(opt.value);
                    selectAudioTrackOption(aid);
                  }}
                  className={`ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs cursor-pointer ${
                    active ? "text-white font-medium" : "text-primary/90 hover:text-white"
                  }`}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
                      {active ? (
                        <AppCheckIcon size={14} className="text-ok" />
                      ) : t ? (
                        <span className="h-1.5 w-1.5 rounded-full bg-white/25" aria-hidden="true" />
                      ) : (
                        <PlayerVolumeIcon muted size={13} className="opacity-70" />
                      )}
                    </span>
                    <span className="truncate">{primaryLabel}</span>
                  </span>
                  {metaTags.length > 0 && (
                    <span className="text-[10px] num font-medium text-white/55 shrink-0">
                      {metaTags.join(" · ")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="px-3 flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-white/45">
          <span>Playback Speed</span>
          {syncConnected && (
            <span className="inline-flex items-center gap-1 text-accent-soft normal-case tracking-normal font-medium">
              <AppLockIcon size={11} />
              Synced {Math.abs(timelineScale - 1.0) > 0.001 ? `${timelineScale.toFixed(3)}×` : "1×"}
            </span>
          )}
        </div>
        <SegmentedTabs
          ariaLabel="Playback speed"
          size="sm"
          fullWidth
          value={String(SPEED_PRESETS.find((p) => Math.abs(speed - p) < 0.01) ?? 1)}
          items={SPEED_PRESETS.map((preset) => ({
            value: String(preset),
            label: preset === 1 ? "1×" : `${preset}×`,
            disabled:
              !loaded || (syncConnected && !canChangePlaybackSpeed(true, preset, timelineScale)),
          }))}
          onChange={(val) => handleSpeedClick(Number(val))}
        />
      </div>

      <div className="space-y-2">
        <div className="px-3 flex items-center text-[10.5px] font-semibold uppercase tracking-[0.09em] text-white/45">
          <span>Picture Frame</span>
        </div>
        <SegmentedTabs
          ariaLabel="Picture frame aspect mode"
          size="sm"
          fullWidth
          value={loaded ? aspectMode : null}
          items={FRAME_PILLS.map((item) => ({
            value: item.value,
            label: item.label,
            disabled: !loaded,
          }))}
          onChange={(val) => {
            setAspectMode(val);
            safeMpvCall(mpvSetAspectMode(val), "mpvSetAspectMode");
          }}
        />
      </div>

      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={looping}
        disabled={!loaded}
        onClick={() => toggleLoopPlayback()}
        className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs text-primary/95 hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
      >
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
            {looping ? <AppCheckIcon size={14} className="text-ok" /> : <AppRepeatIcon size={14} />}
          </span>
          <span className="truncate">Loop Current Video</span>
        </span>
        <GlassSwitchTrack checked={looping} size="sm" />
      </button>
    </div>
  );
});
