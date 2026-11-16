import { useEffect } from "react";
import {
  mpvSeek,
  mpvSetSpeed,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetSubTrack,
  mpvSetVolume,
  safeMpvCall,
} from "../lib/mpv";
import { skipActiveOrUpcomingIntro } from "../lib/introActions";
import { toggleMutePlayback, togglePlayback, toggleReadyStatus } from "../lib/playerActions";
import { PRESET_REACTIONS, triggerPartyReaction } from "../lib/reactions";
import { nextClientSeekSeq, stepSharedRelativeSeek } from "../lib/seekCoalesce";
import { isTextEntryElement } from "../lib/shortcuts";
import {
  formatControllerLockReason,
  getControllerLockState,
  resolveEffectiveUsername,
} from "../lib/syncController";
import { canChangePlaybackSpeed } from "../lib/syncSpeedGuard";
import { syncUserSeek } from "../lib/syncplay";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import {
  formatDelaySigned,
  formatTrackAnnouncement,
  selectSubTrack,
} from "../lib/tracks";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { buildSubStyleParams, useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";

interface UsePlayerShortcutsOptions {
  onToggleFullscreen: () => void;
  onExitFullscreen: () => void;
  onToggleReactions?: () => void;
}

export function usePlayerShortcuts({
  onToggleFullscreen,
  onExitFullscreen,
  onToggleReactions,
}: UsePlayerShortcutsOptions): void {
  useEffect(() => {
    const throttledSeek = createLeadingTrailingThrottle(
      (target: number, synced: boolean, seekSeq: number) => {
        safeMpvCall(mpvSeek(target, { clientSeekSeq: seekSeq }), "shortcut:mpvSeek");
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
        sync.roomControl,
      );

      if (e.code === "KeyF") {
        e.preventDefault();
        onToggleFullscreen();
        return;
      }

      if (e.code === "KeyR") {
        e.preventDefault();
        toggleReadyStatus();
        return;
      }

      if (appState.roomCode && appState.reactionsEnabled) {
        if (e.code === "KeyE") {
          e.preventDefault();
          onToggleReactions?.();
          return;
        }
        const presetByKey =
          PRESET_REACTIONS.find((p) => p.shortcut === e.key) ??
          (e.code.startsWith("Digit")
            ? PRESET_REACTIONS[Number(e.code.slice(5)) - 1]
            : undefined);
        if (presetByKey) {
          e.preventDefault();
          triggerPartyReaction(presetByKey.emoji);
          return;
        }
      }

      if (!player.loaded) {
        return;
      }

      // Play / Pause
      if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        togglePlayback({ showFeedback: true });
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
        const aligning = syncConnected && sync.alignMode;
        if (ctrlLock.lockedForLocalUser && !aligning) {
          pushNote("warn", formatControllerLockReason(ctrlLock));
          return;
        }
        const target = stepSharedRelativeSeek(
          seekDelta,
          player.positionSecs,
          player.durationSecs,
        );
        const seekSeq = nextClientSeekSeq();
        player.setEndedAtEof(false);
        player.setPositionSecs(target);
        player.flashFeedback(`${seekDelta > 0 ? "+" : ""}${seekDelta}s`);
        throttledSeek.call(target, syncConnected && !aligning, seekSeq);
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
        toggleMutePlayback();
        return;
      }

      // Speed (Fix 09 locked to calibrated room scale in synced room)
      if (e.code === "BracketLeft" || e.code === "BracketRight") {
        e.preventDefault();
        const delta = e.code === "BracketRight" ? 0.1 : -0.1;
        const nextSpeed = Math.round(Math.max(0.25, Math.min(3.0, player.speed + delta)) * 100) / 100;
        const targetSpeed = sync.timelineScale;
        if (!canChangePlaybackSpeed(syncConnected, nextSpeed, targetSpeed)) {
          pushNote(
            "info",
            `Playback speed is locked to ${targetSpeed.toFixed(targetSpeed === 1 ? 1 : 3)}× while synced with peers.`,
          );
          player.flashFeedback(`Speed locked (${targetSpeed.toFixed(targetSpeed === 1 ? 1 : 3)}×)`);
          return;
        }
        player.setSpeed(nextSpeed);
        player.flashFeedback(`${nextSpeed.toFixed(1)}×`);
        safeMpvCall(mpvSetSpeed(nextSpeed), "shortcut:mpvSetSpeed");
        return;
      }

      // Skip detected intro
      if (e.code === "KeyI") {
        e.preventDefault();
        if (useAppStore.getState().skipIntroMode !== "off") {
          void skipActiveOrUpcomingIntro();
        }
        return;
      }

      if (e.code === "KeyV") {
        e.preventDefault();
        const nextVis = !sub.visible;
        sub.setVisible(nextVis);
        player.flashFeedback(nextVis ? "Subtitles On" : "Subtitles Off");
        safeMpvCall(
          mpvSetSubStyle(buildSubStyleParams(sub, { visible: nextVis })),
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
  }, [onExitFullscreen, onToggleFullscreen, onToggleReactions]);
}
