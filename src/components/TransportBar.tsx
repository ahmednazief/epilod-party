import {
  CheckCircle2,
  Circle,
  Keyboard,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useMemo, useState } from "react";
import { mpvSeek, mpvSetMute, mpvSetPause, mpvSetVolume } from "../lib/mpv";
import { shouldReplayFromStart } from "../lib/playbackEnd";
import { canToggleReady, resolveReadyToggleTarget } from "../lib/syncReady";
import { getControllerLockState } from "../lib/syncController";
import { syncSetReady, syncUserPause, syncUserPlay, syncUserSeek } from "../lib/syncplay";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { Button } from "./ui/Button";
import { Scrubber } from "./ui/Scrubber";

export function formatClock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const whole = Math.floor(secs);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function PlaybackScrubber({ locked }: { locked: boolean }) {
  const positionSecs = usePlayerStore((s) => s.positionSecs);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const loaded = usePlayerStore((s) => s.loaded);
  const setPositionSecs = usePlayerStore((s) => s.setPositionSecs);
  const setEndedAtEof = usePlayerStore((s) => s.setEndedAtEof);
  const syncConnected = useSyncStore((s) => s.status.state === "connected");

  const [dragSecs, setDragSecs] = useState<number | null>(null);

  const throttledSeek = useMemo(
    () =>
      createLeadingTrailingThrottle((secs: number) => {
        void mpvSeek(secs);
      }, 90),
    [],
  );

  const displayedPos = dragSecs !== null ? dragSecs : positionSecs;
  const disabled = !loaded || durationSecs <= 0 || locked;

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="num text-[11px] text-secondary w-14 text-right shrink-0">
        {formatClock(displayedPos)}
      </span>
      <Scrubber
        className="flex-1"
        ariaLabel="Playback position"
        value={displayedPos}
        min={0}
        max={Math.max(1, durationSecs)}
        step={0.5}
        disabled={disabled}
        formatTooltip={formatClock}
        onChange={(val) => {
          setDragSecs(val);
          throttledSeek.call(val);
        }}
        onCommit={(val) => {
          throttledSeek.cancel();
          setDragSecs(null);
          setEndedAtEof(false);
          setPositionSecs(val);
          void mpvSeek(val);
          if (syncConnected) {
            void syncUserSeek(val);
          }
        }}
      />
      <span className="num text-[11px] text-muted w-14 shrink-0">
        {formatClock(durationSecs)}
      </span>
    </div>
  );
}

interface TransportBarProps {
  onToggleFullscreen: () => void;
}

export function TransportBar({ onToggleFullscreen }: TransportBarProps) {
  const paused = usePlayerStore((s) => s.paused);
  const loaded = usePlayerStore((s) => s.loaded);
  const endedAtEof = usePlayerStore((s) => s.endedAtEof);
  const positionSecs = usePlayerStore((s) => s.positionSecs);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);

  const setPaused = usePlayerStore((s) => s.setPaused);
  const setEndedAtEof = usePlayerStore((s) => s.setEndedAtEof);
  const setPositionSecs = usePlayerStore((s) => s.setPositionSecs);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setMuted = usePlayerStore((s) => s.setMuted);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const localReady = useSyncStore((s) => s.localReady);
  const setLocalReady = useSyncStore((s) => s.setLocalReady);

  const username = useAppStore((s) => s.username);
  const openShortcuts = useAppStore((s) => s.openShortcuts);
  const pushNote = useNotificationStore((s) => s.push);

  const syncConnected = syncStatus.state === "connected";
  const ctrlLock = getControllerLockState(syncConnected, participants, username);

  const throttledVol = useMemo(
    () =>
      createLeadingTrailingThrottle((v: number) => {
        void mpvSetVolume(v);
      }, 60),
    [],
  );

  const handlePlayPause = () => {
    if (!loaded) return;
    if (ctrlLock.lockedForLocalUser) {
      pushNote("warn", "Playback is controlled by the room controller.");
      return;
    }

    if (
      shouldReplayFromStart({
        endedAtEof,
        paused,
        positionSecs,
        durationSecs,
      })
    ) {
      setEndedAtEof(false);
      setPositionSecs(0);
      setPaused(false);
      void (async () => {
        await mpvSeek(0);
        await mpvSetPause(false);
        if (syncConnected) {
          await syncUserSeek(0);
          await syncUserPlay(0);
        }
      })();
      return;
    }

    const nextPaused = !paused;
    setPaused(nextPaused);
    void mpvSetPause(nextPaused);
    if (syncConnected) {
      if (nextPaused) {
        void syncUserPause(positionSecs);
      } else {
        void syncUserPlay(positionSecs);
      }
    }
  };

  const handleSeekRelative = (delta: number) => {
    if (!loaded) return;
    if (ctrlLock.lockedForLocalUser) {
      pushNote("warn", "Seeking is restricted to the room controller.");
      return;
    }
    const maxCap = durationSecs > 0 ? durationSecs : Number.POSITIVE_INFINITY;
    const next = Math.max(0, Math.min(maxCap, positionSecs + delta));
    setEndedAtEof(false);
    setPositionSecs(next);
    void mpvSeek(next);
    if (syncConnected) {
      void syncUserSeek(next);
    }
  };

  const handleToggleReady = () => {
    if (!canToggleReady(loaded)) {
      pushNote("info", "Load a video file before marking yourself Ready.");
      return;
    }
    const target = resolveReadyToggleTarget(loaded, localReady);
    if (target !== null) {
      setLocalReady(target);
      void syncSetReady(target, true);
    }
  };

  return (
    <div className="shrink-0 bg-chrome border-t border-hairline px-3 py-2 space-y-1.5 select-none">
      <PlaybackScrubber locked={ctrlLock.lockedForLocalUser} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            disabled={!loaded || ctrlLock.lockedForLocalUser}
            onClick={handlePlayPause}
            aria-label={paused ? "Play" : "Pause"}
            title={ctrlLock.lockedForLocalUser ? "Controlled by room controller" : paused ? "Play (Space)" : "Pause (Space)"}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{paused ? "Play" : "Pause"}</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            disabled={!loaded || ctrlLock.lockedForLocalUser}
            onClick={() => handleSeekRelative(-10)}
            aria-label="Seek back 10 seconds"
            title="Seek -10s (J)"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!loaded || ctrlLock.lockedForLocalUser}
            onClick={() => handleSeekRelative(10)}
            aria-label="Seek forward 10 seconds"
            title="Seek +10s (L)"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </Button>

          <div className="hidden sm:flex items-center gap-1.5 pl-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = !muted;
                setMuted(next);
                void mpvSetMute(next);
              }}
              aria-label={muted ? "Unmute" : "Mute"}
              title="Mute (M)"
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-3.5 w-3.5 text-muted" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
            <div className="w-20">
              <Scrubber
                ariaLabel="Volume"
                value={muted ? 0 : volume}
                min={0}
                max={130}
                step={1}
                formatTooltip={(v) => `${Math.round(v)}%`}
                onChange={(v) => {
                  const rounded = Math.round(v);
                  if (muted && rounded > 0) {
                    setMuted(false);
                    void mpvSetMute(false);
                  }
                  setVolume(rounded);
                  throttledVol.call(rounded);
                }}
                onCommit={(v) => {
                  throttledVol.cancel();
                  const rounded = Math.round(v);
                  setVolume(rounded);
                  void mpvSetVolume(rounded);
                }}
              />
            </div>
            <span className="num text-[11px] text-muted w-9">{muted ? "0%" : `${volume}%`}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant={localReady && loaded ? "primary" : "secondary"}
            size="sm"
            disabled={!canToggleReady(loaded)}
            onClick={handleToggleReady}
            title={loaded ? "Toggle Ready status (R)" : "Load a local video first"}
          >
            {localReady && loaded ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Circle className="h-3.5 w-3.5" />
            )}
            <span>{localReady && loaded ? "Ready" : "Not Ready"}</span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={openShortcuts}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            title="Fullscreen (F)"
          >
            {isFullscreen ? (
              <Minimize className="h-3.5 w-3.5" />
            ) : (
              <Maximize className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
