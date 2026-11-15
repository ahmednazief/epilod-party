import {
  mpvSeek,
  mpvSetAudioTrack,
  mpvSetMute,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetSubTrack,
  safeMpvCall,
} from "./mpv";
import { playSoundCue } from "./soundEffects";
import { getControllerLockState, resolveEffectiveUsername } from "./syncController";
import { syncSetReady, syncUserSeek } from "./syncplay";
import { canToggleReady, resolveReadyToggleTarget } from "./syncReady";
import type { MpvTrack } from "./mpv";
import { formatTrackAnnouncement, isBitmapSubtitleTrack, selectSubTrack } from "./tracks";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";

export function toggleMutePlayback(): void {
  const player = usePlayerStore.getState();
  const nextMuted = !player.muted;
  player.setMuted(nextMuted);
  player.flashFeedback(nextMuted ? "Muted" : "Unmuted");
  safeMpvCall(mpvSetMute(nextMuted));
}

export function seekPlaybackRelative(deltaSecs: number): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;
  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  const connected = sync.status.state === "connected";
  const lock = getControllerLockState(
    connected,
    sync.participants,
    resolveEffectiveUsername(sync.status, app.username),
  );
  if (lock.lockedForLocalUser) {
    useNotificationStore.getState().push("warn", "Seeking is restricted to the room controller.");
    return;
  }
  const maxCap = player.durationSecs > 0 ? player.durationSecs : Number.POSITIVE_INFINITY;
  const next = Math.max(0, Math.min(maxCap, player.positionSecs + deltaSecs));
  player.setEndedAtEof(false);
  player.setPositionSecs(next);
  player.flashFeedback(`${deltaSecs > 0 ? "+" : ""}${deltaSecs}s`);
  safeMpvCall(mpvSeek(next));
  if (connected) {
    void syncUserSeek(next);
  }
}

function pushSubStyle(visible: boolean): void {
  const sub = useSubtitleStore.getState();
  safeMpvCall(
    mpvSetSubStyle({
      font: sub.font,
      fontSize: sub.fontSize,
      color: sub.color,
      borderSize: sub.borderSize,
      pos: sub.pos,
      visible,
      overrideAss: sub.overrideAssStyle,
    }),
  );
}

let lastAutoSubSignature = "";

/**
 * When a new file's track list arrives, make sure the subtitle bundled with the
 * episode is actually on: pick the default (or first text) embedded track if mpv
 * didn't select one, and push subtitle visibility/style to mpv. Runs once per
 * distinct track set so a user choosing "Off" is never overridden.
 */
export function autoEnableEmbeddedSubtitle(tracks: readonly MpvTrack[]): void {
  const subs = tracks.filter((t) => t.type === "sub");
  if (subs.length === 0) {
    lastAutoSubSignature = "";
    return;
  }
  const signature = subs.map((t) => `${t.id}:${t.external ? "e" : "i"}`).join("|");
  if (signature === lastAutoSubSignature) return;
  lastAutoSubSignature = signature;

  const sub = useSubtitleStore.getState();
  sub.setVisible(true);
  if (!subs.some((t) => t.selected)) {
    const pick =
      subs.find((t) => t.external) ??
      subs.find((t) => !isBitmapSubtitleTrack(t)) ??
      subs[0];
    safeMpvCall(mpvSetSubTrack(pick.id));
  }
  pushSubStyle(true);
}

/** CC button: make sure subtitles are on (selecting the first track if needed). */
export function ensureSubtitlesOn(): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;
  const subs = player.tracks.filter((t) => t.type === "sub");
  if (subs.length === 0) return;
  const sub = useSubtitleStore.getState();
  const selected = subs.find((t) => t.selected);
  if (selected && sub.visible) return;
  sub.setVisible(true);
  if (!selected) {
    const pick = subs.find((t) => !isBitmapSubtitleTrack(t)) ?? subs[0];
    safeMpvCall(mpvSetSubTrack(pick.id));
  }
  pushSubStyle(true);
  player.flashFeedback("Subtitles On");
}

export function toggleSubtitlesVisibility(): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;
  const sub = useSubtitleStore.getState();
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
  );
}

export function cycleSubtitleTrack(): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;
  const sub = useSubtitleStore.getState();
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
  );
  player.flashFeedback(formatTrackAnnouncement(nextTrack, "sub"));
}

export function cycleAudioTrack(): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;
  const audioTracks = player.tracks.filter((t) => t.type === "audio");
  if (audioTracks.length === 0) {
    player.flashFeedback("No audio tracks");
    return;
  }
  const currentIdx = audioTracks.findIndex((t) => t.selected);
  const nextTrack = audioTracks[(currentIdx + 1) % audioTracks.length];
  safeMpvCall(mpvSetAudioTrack(nextTrack.id));
  player.flashFeedback(formatTrackAnnouncement(nextTrack, "audio"));
}

export function toggleReadyStatus(): void {
  const player = usePlayerStore.getState();
  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  if (!canToggleReady(player.loaded)) {
    useNotificationStore.getState().push("info", "Load a video file before marking yourself Ready.");
    return;
  }
  const target = resolveReadyToggleTarget(player.loaded, sync.localReady);
  if (target === null) return;
  sync.setLocalReady(target);
  void syncSetReady(target, true);
  player.flashFeedback(target ? "Ready" : "Not Ready");

  const connected = sync.status.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(sync.status, app.username);
  const othersAllReady =
    connected &&
    sync.participants.length >= 2 &&
    sync.participants.every(
      (p) =>
        p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase() ||
        p.isReady,
    );
  if (target && !othersAllReady) {
    playSoundCue("peerReady", { moviePlaying: player.loaded && !player.paused });
  }
}
