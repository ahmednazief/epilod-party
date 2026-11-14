import {
  Captions,
  CheckCircle2,
  Circle,
  Keyboard,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { mpvSeek, mpvSetMute, mpvSetPause, mpvSetSubStyle, mpvSetVolume } from "../lib/mpv";
import { shouldReplayFromStart } from "../lib/playbackEnd";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import { canToggleReady, resolveReadyToggleTarget } from "../lib/syncReady";
import {
  syncSetReady,
  syncSetScrubbing,
  syncUserPause,
  syncUserPlay,
  syncUserSeek,
} from "../lib/syncplay";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
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
  const scrubbingRef = useRef(false);

  const throttledSeek = useMemo(
    () =>
      createLeadingTrailingThrottle((secs: number) => {
        void mpvSeek(secs);
      }, 90),
    [],
  );

  useEffect(() => {
    return () => {
      throttledSeek.cancel();
      if (scrubbingRef.current) {
        scrubbingRef.current = false;
        void syncSetScrubbing(false);
      }
    };
  }, [throttledSeek]);

  const displayedPos = dragSecs !== null ? dragSecs : positionSecs;
  const disabled = !loaded || durationSecs <= 0 || locked;

  return (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <Scrubber
        className="flex-1 min-w-20"
        ariaLabel="Playback position"
        value={displayedPos}
        min={0}
        max={Math.max(1, durationSecs)}
        step={0.5}
        disabled={disabled}
        formatTooltip={formatClock}
        onChange={(val) => {
          if (!scrubbingRef.current) {
            scrubbingRef.current = true;
            void syncSetScrubbing(true);
          }
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
          if (scrubbingRef.current) {
            scrubbingRef.current = false;
            void syncSetScrubbing(false);
          }
        }}
      />
      <span className="num text-xs text-secondary shrink-0 whitespace-nowrap">
        {formatClock(displayedPos)}{" "}
        <span className="text-muted">/ {formatClock(durationSecs)}</span>
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

  const subVisible = useSubtitleStore((s) => s.visible);
  const setSubVisible = useSubtitleStore((s) => s.setVisible);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const localReady = useSyncStore((s) => s.localReady);
  const setLocalReady = useSyncStore((s) => s.setLocalReady);

  const username = useAppStore((s) => s.username);
  const openShortcuts = useAppStore((s) => s.openShortcuts);
  const pushNote = useNotificationStore((s) => s.push);

  const syncConnected = syncStatus.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);
  const ctrlLock = getControllerLockState(syncConnected, participants, effectiveUsername);

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
      pushNote("warn", "Playback is controlled by the room host.");
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
      pushNote("warn", "Seeking is controlled by the room host.");
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
      pushNote("info", "Open a video first to mark yourself Ready.");
      return;
    }
    const target = resolveReadyToggleTarget(loaded, localReady);
    if (target !== null) {
      setLocalReady(target);
      void syncSetReady(target, true);
    }
  };

  const handleToggleSubtitles = () => {
    const sub = useSubtitleStore.getState();
    const next = !sub.visible;
    setSubVisible(next);
    void mpvSetSubStyle({
      font: sub.font,
      fontSize: sub.fontSize,
      color: sub.color,
      borderSize: sub.borderSize,
      pos: sub.pos,
      visible: next,
      overrideAss: sub.overrideAssStyle,
    });
  };

  return (
    <div className="shrink-0 bg-chrome border-t border-hairline px-3.5 py-2.5 flex items-center gap-3 select-none">
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          variant="primary"
          size="sm"
          className="h-8 w-8 px-0"
          disabled={!loaded || ctrlLock.lockedForLocalUser}
          onClick={handlePlayPause}
          aria-label={paused ? "Play" : "Pause"}
          title={ctrlLock.lockedForLocalUser ? "Controlled by room host" : paused ? "Play (Space)" : "Pause (Space)"}
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          className="h-8 px-2 num"
          disabled={!loaded || ctrlLock.lockedForLocalUser}
          onClick={() => handleSeekRelative(-10)}
          aria-label="Seek back 10 seconds"
          title="Back 10s (J)"
        >
          -10s
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-8 px-2 num"
          disabled={!loaded || ctrlLock.lockedForLocalUser}
          onClick={() => handleSeekRelative(10)}
          aria-label="Seek forward 10 seconds"
          title="Forward 10s (L)"
        >
          +10s
        </Button>
      </div>

      <PlaybackScrubber locked={ctrlLock.lockedForLocalUser} />

      <div className="flex items-center gap-1.5 shrink-0">
        <div className="hidden md:flex items-center gap-1.5 pr-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = !muted;
              setMuted(next);
              void mpvSetMute(next);
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute (M)" : "Mute (M)"}
          >
            {muted || volume === 0 ? (
              <VolumeX className="h-4 w-4 text-muted" />
            ) : (
              <Volume2 className="h-4 w-4" />
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
        </div>

        <Button
          variant={subVisible ? "ghost" : "secondary"}
          size="sm"
          disabled={!loaded}
          onClick={handleToggleSubtitles}
          aria-label={subVisible ? "Hide subtitles" : "Show subtitles"}
          title="Toggle subtitles (V)"
        >
          <Captions className={`h-4 w-4 ${subVisible ? "text-primary" : "text-muted"}`} />
        </Button>

        <Button
          variant={localReady && loaded ? "primary" : "secondary"}
          size="sm"
          disabled={!canToggleReady(loaded)}
          onClick={handleToggleReady}
          title={loaded ? "Toggle Ready status (R)" : "Open a video first"}
          className="hidden sm:inline-flex"
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
          <Keyboard className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          title="Fullscreen (F)"
        >
          {isFullscreen ? (
            <Minimize className="h-4 w-4" />
          ) : (
            <Maximize className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
