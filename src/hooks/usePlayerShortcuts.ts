import { useEffect, useRef } from "react";
import {
  mpvSeek,
  mpvSetMute,
  mpvSetPause,
  mpvSetSpeed,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetSubTrack,
  mpvSetVolume,
  safeMpvCall,
} from "../lib/mpv";
import { shouldReplayFromStart } from "../lib/playbackEnd";
import { SeekAccumulator } from "../lib/seekCoalesce";
import { isTextEntryElement } from "../lib/shortcuts";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import { canChangePlaybackSpeed } from "../lib/syncSpeedGuard";
import { canToggleReady, resolveReadyToggleTarget } from "../lib/syncReady";
import { syncSetReady, syncUserPause, syncUserPlay, syncUserSeek } from "../lib/syncplay";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import {
  formatDelaySigned,
  formatTrackAnnouncement,
  selectSubTrack,
} from "../lib/tracks";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";

interface UsePlayerShortcutsOptions {
  onToggleFullscreen: () => void;
  onExitFullscreen: () => void;
}

export function usePlayerShortcuts({
  onToggleFullscreen,
  onExitFullscreen,
}: UsePlayerShortcutsOptions): void {
  const seekAccRef = useRef(new SeekAccumulator(450));

  useEffect(() => {
    const throttledSeek = createLeadingTrailingThrottle(
      (target: number, synced: boolean) => {
        safeMpvCall(mpvSeek(target), "shortcut:mpvSeek");
        if (synced) {
          void syncUserSeek(target);
        }
      },
      100,
    );

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }
      if (isTextEntryElement(e.target)) {
        return;
      }

      const appState = useAppStore.getState();
      const player = usePlayerStore.getState();
      const sync = useSyncStore.getState();
      const sub = useSubtitleStore.getState();
      const pushNote = useNotificationStore.getState().push;

      // Esc closes open modals first, otherwise exits fullscreen
      if (e.code === "Escape") {
        if (appState.settingsOpen) {
          e.preventDefault();
          appState.closeSettings();
          return;
        }
        if (appState.shortcutsOpen) {
          e.preventDefault();
          appState.closeShortcuts();
          return;
        }
        if (player.isFullscreen) {
          e.preventDefault();
          onExitFullscreen();
          return;
        }
        return;
      }

      // Open/toggle shortcuts modal with ? (or Shift+Slash across keyboard layouts)
      if (e.key === "?" || (e.code === "Slash" && e.shiftKey)) {
        e.preventDefault();
        if (appState.shortcutsOpen) {
          appState.closeShortcuts();
        } else {
          appState.openShortcuts();
        }
        return;
      }

      // Do not trigger player transport keys while modal dialogs are focused/open
      if (appState.settingsOpen || appState.shortcutsOpen) {
        return;
      }

      const syncConnected = sync.status.state === "connected";
      const effectiveUsername = resolveEffectiveUsername(sync.status, appState.username);
      const ctrlLock = getControllerLockState(
        syncConnected,
        sync.participants,
        effectiveUsername,
      );

      if (e.code === "KeyF") {
        e.preventDefault();
        onToggleFullscreen();
        return;
      }

      if (e.code === "KeyR") {
        e.preventDefault();
        if (!canToggleReady(player.loaded)) {
          pushNote("info", "Load a local video file before marking Ready.");
          return;
        }
        const nextReady = resolveReadyToggleTarget(player.loaded, sync.localReady);
        if (nextReady !== null) {
          sync.setLocalReady(nextReady);
          void syncSetReady(nextReady, true);
          player.flashFeedback(nextReady ? "Ready" : "Not Ready");
        }
        return;
      }

      if (!player.loaded) {
        return;
      }

      // Play / Pause
      if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        if (ctrlLock.lockedForLocalUser) {
          pushNote("warn", "Playback is controlled by the room controller.");
          return;
        }

        if (
          shouldReplayFromStart({
            endedAtEof: player.endedAtEof,
            paused: player.paused,
            positionSecs: player.positionSecs,
            durationSecs: player.durationSecs,
          })
        ) {
          player.setEndedAtEof(false);
          player.setPositionSecs(0);
          player.setPaused(false);
          player.flashFeedback("Replay");
          void (async () => {
            try {
              await safeMpvCall(mpvSeek(0), "shortcut:replaySeek");
              await safeMpvCall(mpvSetPause(false), "shortcut:replayPlay");
              if (syncConnected) {
                await syncUserSeek(0);
                await syncUserPlay(0);
              }
            } catch {
              // Sync errors handled cleanly or ignored on disconnect.
            }
          })();
          return;
        }

        const nextPaused = !player.paused;
        player.setPaused(nextPaused);
        player.flashFeedback(nextPaused ? "Paused" : "Playing");
        safeMpvCall(mpvSetPause(nextPaused), "shortcut:mpvSetPause");
        if (syncConnected) {
          if (nextPaused) {
            void syncUserPause(player.positionSecs);
          } else {
            void syncUserPlay(player.positionSecs);
          }
        }
        return;
      }

      // Coalesced Seek (Fix 21)
      let seekDelta = 0;
      if (e.code === "ArrowLeft") seekDelta = -5;
      else if (e.code === "ArrowRight") seekDelta = 5;
      else if (e.code === "KeyJ") seekDelta = -10;
      else if (e.code === "KeyL") seekDelta = 10;

      if (seekDelta !== 0) {
        e.preventDefault();
        if (ctrlLock.lockedForLocalUser) {
          pushNote("warn", "Seeking is restricted to the room controller.");
          return;
        }
        const target = seekAccRef.current.step(
          seekDelta,
          player.positionSecs,
          player.durationSecs,
        );
        player.setEndedAtEof(false);
        player.setPositionSecs(target);
        player.flashFeedback(`${seekDelta > 0 ? "+" : ""}${seekDelta}s`);
        throttledSeek.call(target, syncConnected);
        return;
      }

      // Volume
      if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        e.preventDefault();
        const delta = e.code === "ArrowUp" ? 5 : -5;
        const nextVol = Math.max(0, Math.min(130, player.volume + delta));
        player.setVolume(nextVol);
        player.flashFeedback(`Vol ${nextVol}%`);
        safeMpvCall(mpvSetVolume(nextVol), "shortcut:mpvSetVolume");
        return;
      }

      // Mute
      if (e.code === "KeyM") {
        e.preventDefault();
        const nextMuted = !player.muted;
        player.setMuted(nextMuted);
        player.flashFeedback(nextMuted ? "Muted" : "Unmuted");
        safeMpvCall(mpvSetMute(nextMuted), "shortcut:mpvSetMute");
        return;
      }

      // Speed (Fix 09 locked in synced room)
      if (e.code === "BracketLeft" || e.code === "BracketRight") {
        e.preventDefault();
        const delta = e.code === "BracketRight" ? 0.1 : -0.1;
        const nextSpeed = Math.round(Math.max(0.25, Math.min(3.0, player.speed + delta)) * 100) / 100;
        if (!canChangePlaybackSpeed(syncConnected, nextSpeed)) {
          pushNote("info", "Playback speed is locked to 1.0× while synced with peers.");
          player.flashFeedback("Speed locked (1.0×)");
          return;
        }
        player.setSpeed(nextSpeed);
        player.flashFeedback(`${nextSpeed.toFixed(1)}×`);
        safeMpvCall(mpvSetSpeed(nextSpeed), "shortcut:mpvSetSpeed");
        return;
      }

      // Subtitle visibility
      if (e.code === "KeyV") {
        e.preventDefault();
        const nextVis = !sub.visible;
        sub.setVisible(nextVis);
        player.flashFeedback(nextVis ? "Subtitles On" : "Subtitles Off");
        safeMpvCall(
          mpvSetSubStyle({
            font: sub.font,
            fontSize: sub.fontSize,
            color: sub.color,
            borderSize: sub.borderSize,
            pos: sub.pos,
            visible: nextVis,
            overrideAss: sub.overrideAssStyle,
          }),
          "shortcut:mpvSetSubStyle",
        );
        return;
      }

      // Cycle Subtitle Track (Fix 24 resets delay cleanly)
      if (e.code === "KeyS") {
        e.preventDefault();
        const subTracks = player.tracks.filter((t) => t.type === "sub");
        if (subTracks.length === 0) {
          player.flashFeedback("No subtitle tracks");
          return;
        }
        const currentIdx = subTracks.findIndex((t) => t.selected);
        const nextTrack =
          currentIdx === -1
            ? subTracks[0]
            : currentIdx + 1 < subTracks.length
              ? subTracks[currentIdx + 1]
              : null;

        safeMpvCall(
          selectSubTrack(nextTrack ? nextTrack.id : null, player.tracks, {
            mpvSetSubTrack,
            mpvSetSubDelay,
            setDelaySecs: sub.setDelaySecs,
            setSubtitleVisible: sub.setVisible,
            clearExternalTrackState: sub.clearLoadedTrack,
          }),
          "shortcut:selectSubTrack",
        );
        player.flashFeedback(formatTrackAnnouncement(nextTrack, "sub"));
        return;
      }

      // Subtitle timing nudge
      if (e.code === "KeyZ" || e.code === "KeyX") {
        e.preventDefault();
        const delta = e.code === "KeyX" ? 0.1 : -0.1;
        const nextDelay = sub.nudgeDelay(delta);
        player.flashFeedback(`Sub ${formatDelaySigned(nextDelay)}`);
        safeMpvCall(mpvSetSubDelay(nextDelay), "shortcut:mpvSetSubDelay");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      throttledSeek.cancel();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onExitFullscreen, onToggleFullscreen]);
}
