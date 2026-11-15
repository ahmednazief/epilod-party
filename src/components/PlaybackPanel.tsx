import { memo } from "react";
import {
  mpvSetAspectMode,
  mpvSetAudioTrack,
  mpvSetLoop,
  mpvSetSpeed,
  safeMpvCall,
  type AspectMode,
} from "../lib/mpv";
import { canChangePlaybackSpeed } from "../lib/syncSpeedGuard";
import { buildAudioTrackOptions, selectAudioTrack } from "../lib/tracks";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { AppCheckIcon, AppLockIcon, AppRepeatIcon } from "./ui/AppIcons";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { PlayerAudioIcon, PlayerVolumeIcon } from "./ui/PlayerIcons";

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
  const audioCount = audioOptions.filter((o) => o.track !== null).length;
  const selectedAudio = tracks.find((t) => t.type === "audio" && t.selected);
  const currentAudioVal = selectedAudio ? String(selectedAudio.id) : "none";

  const handleSpeedClick = (nextSpeed: number) => {
    if (!canChangePlaybackSpeed(syncConnected, nextSpeed)) {
      pushNote("info", "Playback speed stays synced at 1.0× while watching with peers.");
      return;
    }
    setSpeed(nextSpeed);
    safeMpvCall(mpvSetSpeed(nextSpeed), "mpvSetSpeed");
  };

  return (
    <div role="menu" aria-label="Audio and playback options" className="flex flex-col">
      <div className="px-2.5 pt-1 pb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span>Audio Track</span>
        {loaded && <span className="num text-secondary">{audioCount}</span>}
      </div>

      {!loaded ? (
        <div className="px-2.5 py-2 text-xs text-muted">
          Open a video to switch audio tracks
        </div>
      ) : (
        <div className="max-h-40 overflow-y-auto space-y-0.5">
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
                  safeMpvCall(selectAudioTrack(aid, { mpvSetAudioTrack }), "selectAudioTrack");
                }}
                className={`ep-menu-row ep-press w-full flex items-center justify-between gap-2.5 px-2.5 py-1.5 text-left text-xs cursor-pointer ${
                  active ? "text-white font-medium" : "text-primary/90 hover:text-white"
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
                    {active ? (
                      <AppCheckIcon size={14} className="text-ok" />
                    ) : t ? (
                      <PlayerAudioIcon size={14} className="opacity-80" />
                    ) : (
                      <PlayerVolumeIcon muted size={14} className="opacity-80" />
                    )}
                  </span>
                  <span className="truncate">{primaryLabel}</span>
                </span>
                {metaTags.length > 0 && (
                  <span className="text-[10px] num font-medium text-muted shrink-0">
                    {metaTags.join(" · ")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="ep-hairline-divider my-1.5 mx-1.5" role="separator" />

      <div className="px-2.5 pt-0.5 pb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span>Playback Speed</span>
        {syncConnected && (
          <span className="inline-flex items-center gap-1 text-accent-soft normal-case font-medium">
            <AppLockIcon size={11} />
            Synced 1×
          </span>
        )}
      </div>
      <div className="px-1.5 pb-1">
        <div className="ep-glass-input p-0.5 rounded-xl grid grid-cols-5 gap-0.5">
          {SPEED_PRESETS.map((preset) => {
            const active = Math.abs(speed - preset) < 0.01;
            const disabled = !loaded || (syncConnected && preset !== 1.0);
            return (
              <button
                key={preset}
                type="button"
                disabled={disabled}
                onClick={() => handleSpeedClick(preset)}
                className={`ep-press h-7 rounded-[10px] text-[11px] font-medium num cursor-pointer disabled:opacity-35 disabled:pointer-events-none ${
                  active
                    ? "ep-droplet-indicator text-white"
                    : "text-secondary hover:text-white"
                }`}
              >
                {preset === 1 ? "1×" : `${preset}×`}
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
        Picture Frame
      </div>
      <div className="px-1.5 pb-1">
        <div className="ep-glass-input p-0.5 rounded-xl grid grid-cols-5 gap-0.5">
          {FRAME_PILLS.map((item) => {
            const active = aspectMode === item.value;
            return (
              <button
                key={item.value}
                type="button"
                disabled={!loaded}
                onClick={() => {
                  setAspectMode(item.value);
                  safeMpvCall(mpvSetAspectMode(item.value), "mpvSetAspectMode");
                }}
                className={`ep-press h-7 rounded-[10px] text-[11px] font-medium cursor-pointer disabled:opacity-35 disabled:pointer-events-none ${
                  active
                    ? "ep-droplet-indicator text-white"
                    : "text-secondary hover:text-white"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="ep-hairline-divider my-1.5 mx-1.5" role="separator" />

      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={looping}
        disabled={!loaded}
        onClick={() => {
          const next = !looping;
          setLooping(next);
          safeMpvCall(mpvSetLoop(next), "mpvSetLoop");
        }}
        className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs text-primary/95 hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
      >
        <span className="flex items-center gap-2.5 min-w-0">
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
