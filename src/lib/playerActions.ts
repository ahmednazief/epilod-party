import {
  captureFrozenBackdropFrame,
  getLastCapturedBackdropFrame,
  mpvSeek,
  mpvSetAudioTrack,
  mpvSetLoop,
  mpvSetMute,
  mpvSetPause,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetSubTrack,
  mpvSetVisible,
  safeMpvCall,
} from "./mpv";
import { shouldReplayFromStart } from "./playbackEnd";
import {
  nextClientSeekSeq,
  resetSharedRelativeSeek,
  stepSharedRelativeSeek,
} from "./seekCoalesce";
import { playSoundCue } from "./soundEffects";
import {
  formatControllerLockReason,
  getControllerLockState,
  resolveEffectiveUsername,
} from "./syncController";
import { syncSetReady, syncUserPause, syncUserPlay, syncUserSeek, type SyncStatusPayload } from "./syncplay";
import {
  canToggleReady,
  formatPeerDisconnectedFeedback,
  formatPeerDisconnectedNotice,
  getPlayBlockState,
  LOCAL_DISCONNECT_TAG,
  PLAY_BLOCKED_TAG,
  peerDisconnectedTag,
  peerNotReadyTag,
  resolveReadyToggleTarget,
} from "./syncReady";
import type { MpvTrack } from "./mpv";
import {
  formatTrackAnnouncement,
  isBitmapSubtitleTrack,
  isClosedCaptionTrack,
  selectAudioTrack,
  selectSubTrack,
} from "./tracks";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";

/**
 * Hides the Win32 child mpv HWND around native file dialogs while preserving a
 * frozen backdrop frame so the viewport never flashes solid black.
 */
export async function runWithHiddenMpvSurface<T>(
  mpvActive: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (mpvActive) {
    const pNow = usePlayerStore.getState();
    const cached = getLastCapturedBackdropFrame();
    if (cached && !pNow.frozenFrame) {
      pNow.setFrozenFrame(cached);
    }
    if (pNow.loaded && pNow.engineSurfaceVisible) {
      const snap = await captureFrozenBackdropFrame();
      if (snap) {
        usePlayerStore.getState().setFrozenFrame(snap);
      }
    }
    try {
      await mpvSetVisible(false);
    } catch {
      // Engine may not be alive if runtime exited.
    }
  }
  try {
    return await fn();
  } finally {
    if (mpvActive) {
      const appState = useAppStore.getState();
      const pState = usePlayerStore.getState();
      safeMpvCall(
        mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !pState.playerError),
        "mpvSetVisible",
      );
    }
  }
}
import { buildSubStyleParams, useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";

export interface AudioActionDeps {
  mpvSetMute?: (muted: boolean) => Promise<void>;
  mpvSetAudioTrack?: (aid: number | null) => Promise<void>;
}

export interface LoopActionDeps {
  mpvSetLoop?: (looping: boolean) => Promise<void>;
  mpvSeek?: (seconds: number) => Promise<void>;
  mpvSetPause?: (paused: boolean) => Promise<void>;
  syncUserSeek?: (position: number) => Promise<void>;
  syncUserPlay?: (position: number) => Promise<void>;
}

function withSelectedAudioTrack(tracks: readonly MpvTrack[], targetAid: number | null): MpvTrack[] {
  return tracks.map((t) =>
    t.type === "audio"
      ? { ...t, selected: targetAid !== null && t.id === targetAid }
      : t,
  );
}

function findFallbackAudioTrack(tracks: readonly MpvTrack[]): MpvTrack | undefined {
  const audioTracks = tracks.filter((t) => t.type === "audio");
  return audioTracks.find((t) => t.default) ?? audioTracks[0];
}

/**
 * Applies mute state to both store and mpv, and if unmuting after `aid="no"`
 * (from "Mute / Off"), automatically restores the preferred audio track so sound resumes.
 */
export function setMutePlayback(
  nextMuted: boolean,
  options?: { flash?: boolean; deps?: AudioActionDeps },
): void {
  const player = usePlayerStore.getState();
  const setMute = options?.deps?.mpvSetMute ?? mpvSetMute;
  const setAudioTrack = options?.deps?.mpvSetAudioTrack ?? mpvSetAudioTrack;

  player.setMuted(nextMuted);
  if (options?.flash !== false) {
    player.flashFeedback(nextMuted ? "Muted" : "Unmuted");
  }
  safeMpvCall(setMute(nextMuted), "setMutePlayback:mpvSetMute");

  if (!nextMuted) {
    const audioTracks = player.tracks.filter((t) => t.type === "audio");
    const hasSelectedAudio = audioTracks.some((t) => t.selected);
    if (!hasSelectedAudio && audioTracks.length > 0) {
      const fallback = findFallbackAudioTrack(player.tracks);
      if (fallback) {
        player.setTracks(withSelectedAudioTrack(player.tracks, fallback.id));
        safeMpvCall(
          selectAudioTrack(fallback.id, { mpvSetAudioTrack: setAudioTrack }),
          "setMutePlayback:restoreAudioTrack",
        );
      }
    }
  }
}

export function toggleMutePlayback(deps?: AudioActionDeps): void {
  const nextMuted = !usePlayerStore.getState().muted;
  setMutePlayback(nextMuted, { flash: true, deps });
}

/**
 * Selects an audio track or "Mute / Off" (`aid === null`) while keeping `muted`
 * state and mpv `mute` synchronized with track selection.
 */
export function selectAudioTrackOption(aid: number | null, deps?: AudioActionDeps): void {
  const player = usePlayerStore.getState();
  const setMute = deps?.mpvSetMute ?? mpvSetMute;
  const setAudioTrack = deps?.mpvSetAudioTrack ?? mpvSetAudioTrack;

  if (aid === null) {
    const audioTracks = player.tracks.filter((t) => t.type === "audio");
    const hasSelectedAudio = audioTracks.some((t) => t.selected);
    // Re-clicking "Mute / Off" while already muted with no selected track restores audio cleanly.
    if (player.muted && !hasSelectedAudio && audioTracks.length > 0) {
      setMutePlayback(false, { flash: false, deps });
      return;
    }

    player.setTracks(withSelectedAudioTrack(player.tracks, null));
    safeMpvCall(
      selectAudioTrack(null, { mpvSetAudioTrack: setAudioTrack }),
      "selectAudioTrackOption:off",
    );
    if (!player.muted) {
      player.setMuted(true);
    }
    safeMpvCall(setMute(true), "selectAudioTrackOption:mpvMute");
    return;
  }

  player.setTracks(withSelectedAudioTrack(player.tracks, aid));
  safeMpvCall(
    selectAudioTrack(aid, { mpvSetAudioTrack: setAudioTrack }),
    "selectAudioTrackOption",
  );
  if (player.muted) {
    player.setMuted(false);
    safeMpvCall(setMute(false), "selectAudioTrackOption:mpvUnmute");
  }
}

function replayFromStartForLoop(reasonContext: string, deps?: LoopActionDeps): void {
  const player = usePlayerStore.getState();
  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  const seek = deps?.mpvSeek ?? mpvSeek;
  const setPause = deps?.mpvSetPause ?? mpvSetPause;
  const syncSeek = deps?.syncUserSeek ?? syncUserSeek;
  const syncPlay = deps?.syncUserPlay ?? syncUserPlay;

  const connected = sync.status.state === "connected";
  const aligning = connected && sync.alignMode;
  const effectiveUsername = resolveEffectiveUsername(sync.status, app.username);
  const lock = getControllerLockState(connected, sync.participants, effectiveUsername);
  if (connected && !aligning && lock.lockedForLocalUser) {
    return;
  }

  const playBlock = getPlayBlockState({
    syncConnected: connected,
    participants: sync.participants,
    localUsername: effectiveUsername,
  });

  const seq = nextClientSeekSeq();
  resetSharedRelativeSeek();
  player.setEndedAtEof(false);
  player.setPositionSecs(0);
  safeMpvCall(
    deps?.mpvSeek ? seek(0) : mpvSeek(0, { clientSeekSeq: seq }),
    `${reasonContext}:mpvSeekZero`,
  );

  if (connected && !aligning && playBlock.blocked) {
    player.setPaused(true);
    safeMpvCall(setPause(true), `${reasonContext}:mpvSetPauseTrue`);
    void syncSeek(0);
    return;
  }

  player.setPaused(false);
  safeMpvCall(setPause(false), `${reasonContext}:mpvSetPauseFalse`);
  if (connected && !aligning) {
    void syncSeek(0);
    void syncPlay(0);
  }
}

/**
 * Toggles current-file loop mode, respecting room controller lock and
 * immediately rewinding/replaying if enabled while paused at EOF.
 */
export function toggleLoopPlayback(deps?: LoopActionDeps): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;

  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  const connected = sync.status.state === "connected";
  const aligning = connected && sync.alignMode;
  const effectiveUsername = resolveEffectiveUsername(sync.status, app.username);
  const lock = getControllerLockState(connected, sync.participants, effectiveUsername);

  if (connected && !aligning && lock.lockedForLocalUser) {
    useNotificationStore
      .getState()
      .push("warn", "Playback control is restricted to the room controller.");
    return;
  }

  const nextLooping = !player.looping;
  const setLoop = deps?.mpvSetLoop ?? mpvSetLoop;

  player.setLooping(nextLooping);
  player.flashFeedback(nextLooping ? "Loop On" : "Loop Off");
  safeMpvCall(setLoop(nextLooping), "toggleLoopPlayback:mpvSetLoop");

  if (
    nextLooping &&
    shouldReplayFromStart({
      endedAtEof: player.endedAtEof,
      paused: player.paused,
      positionSecs: player.positionSecs,
      durationSecs: player.durationSecs,
    })
  ) {
    replayFromStartForLoop("toggleLoopPlayback", deps);
  }
}

/**
 * Handles an EOF event while loop mode is active so playback immediately wraps
 * back to start without entering `endedAtEof` or triggering Auto-Next.
 */
export function handleLoopPlaybackAtEof(deps?: LoopActionDeps): void {
  const setLoop = deps?.mpvSetLoop ?? mpvSetLoop;
  safeMpvCall(setLoop(true), "handleLoopPlaybackAtEof:mpvSetLoop");
  replayFromStartForLoop("loopEof", deps);
}

/**
 * Detects an internal mpv `loop-file` wrap from near EOF back to `0` so Watch
 * Party rooms push `seek(0)` instead of snapping playback back to duration.
 */
export function detectAndSyncLoopWrap(
  prevPos: number,
  nextPos: number,
  lastWrapSyncAt: number,
  nowMs = Date.now(),
  deps?: LoopActionDeps,
): number {
  const player = usePlayerStore.getState();
  if (!player.loaded || !player.looping || player.durationSecs <= 3) {
    return lastWrapSyncAt;
  }

  const nearEndThreshold = Math.max(
    1.5,
    player.durationSecs - Math.min(2.5, player.durationSecs * 0.25),
  );
  if (prevPos < nearEndThreshold || nextPos < 0 || nextPos >= 1.5 || prevPos - nextPos < 1.5) {
    return lastWrapSyncAt;
  }

  if (nowMs - lastWrapSyncAt < 1500) {
    return lastWrapSyncAt;
  }

  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  const connected = sync.status.state === "connected";
  const aligning = connected && sync.alignMode;
  if (!connected || aligning) {
    return lastWrapSyncAt;
  }

  const lock = getControllerLockState(
    connected,
    sync.participants,
    resolveEffectiveUsername(sync.status, app.username),
  );
  if (lock.lockedForLocalUser) {
    return lastWrapSyncAt;
  }

  const syncSeek = deps?.syncUserSeek ?? syncUserSeek;
  const syncPlay = deps?.syncUserPlay ?? syncUserPlay;
  void syncSeek(nextPos);
  if (!player.paused) {
    void syncPlay(nextPos);
  }
  return nowMs;
}

export function seekPlaybackRelative(
  deltaSecs: number,
  options?: { showFeedback?: boolean; lockReasonText?: string },
): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;
  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  const connected = sync.status.state === "connected";
  const aligning = connected && sync.alignMode;
  const lock = getControllerLockState(
    connected,
    sync.participants,
    resolveEffectiveUsername(sync.status, app.username),
    sync.roomControl,
  );
  if (lock.lockedForLocalUser && !aligning) {
    useNotificationStore
      .getState()
      .push("warn", options?.lockReasonText ?? formatControllerLockReason(lock));
    return;
  }
  const next = stepSharedRelativeSeek(
    deltaSecs,
    player.positionSecs,
    player.durationSecs,
  );
  const seq = nextClientSeekSeq();
  player.setEndedAtEof(false);
  player.setPositionSecs(next);
  if (options?.showFeedback !== false) {
    player.flashSeekCue({
      direction: deltaSecs < 0 ? "back" : "forward",
      deltaSecs: Math.abs(deltaSecs),
    });
  }
  safeMpvCall(mpvSeek(next, { clientSeekSeq: seq }));
  if (connected && !aligning) {
    void syncUserSeek(next);
  }
}

function pushSubStyle(visible: boolean): void {
  const sub = useSubtitleStore.getState();
  safeMpvCall(mpvSetSubStyle(buildSubStyleParams(sub, { visible })));
}

let lastAutoSubSignature = "";

/** Reset per-file auto-subtitle tracking before loading a new video. */
export function resetAutoSubtitleState(): void {
  lastAutoSubSignature = "";
}

function isArabicSubtitleTrack(t: MpvTrack): boolean {
  const lang = t.lang?.trim().toLowerCase() ?? "";
  if (lang === "ar" || lang === "ara" || lang === "arb" || lang === "arabic") {
    return true;
  }
  const title = t.title?.trim().toLowerCase() ?? "";
  return /\barabic\b|العربية|عربي/.test(title);
}

function isEnglishSubtitleTrack(t: MpvTrack): boolean {
  const lang = t.lang?.trim().toLowerCase() ?? "";
  if (lang === "en" || lang === "eng" || lang === "english") {
    return true;
  }
  const title = t.title?.trim().toLowerCase() ?? "";
  return /\benglish\b|\beng\b/.test(title);
}

function scoreSubtitleTrack(t: MpvTrack): number {
  let score = 0;
  if (t.external) score += 100_000;
  if (isArabicSubtitleTrack(t)) {
    score += 10_000;
  } else if (isEnglishSubtitleTrack(t)) {
    score += 5_000;
  }
  if (!t.forced) score += 1_000;
  if (!isBitmapSubtitleTrack(t)) score += 500;
  if (!isClosedCaptionTrack(t)) score += 100;
  if (t.default) score += 50;
  return score;
}

function pickPreferredSubtitleTrack(subs: readonly MpvTrack[]): MpvTrack {
  let best = subs[0];
  let bestScore = scoreSubtitleTrack(best);
  for (let i = 1; i < subs.length; i++) {
    const candidate = subs[i];
    const score = scoreSubtitleTrack(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * When a new file's track list arrives, prioritize Arabic (if available), then English,
 * then fallback text/default tracks—even when mpv pre-selected another default language.
 * Runs once per distinct file + track set so a user choosing "Off" or another track is
 * never overridden.
 */
export function autoEnableEmbeddedSubtitle(tracks: readonly MpvTrack[]): void {
  const subs = tracks.filter((t) => t.type === "sub");
  if (subs.length === 0) {
    lastAutoSubSignature = "";
    return;
  }
  const activeFile = (useAppStore.getState().selectedFilePath ?? "").toLowerCase();
  const signature = `${activeFile}::${subs.map((t) => `${t.id}:${t.external ? "e" : "i"}`).join("|")}`;
  if (signature === lastAutoSubSignature) return;
  lastAutoSubSignature = signature;

  const sub = useSubtitleStore.getState();
  sub.setVisible(true);
  const currentSelected = subs.find((t) => t.selected);
  const pick = pickPreferredSubtitleTrack(subs);
  if (!currentSelected) {
    safeMpvCall(mpvSetSubTrack(pick.id));
  } else if (
    pick.id !== currentSelected.id &&
    scoreSubtitleTrack(pick) > scoreSubtitleTrack(currentSelected)
  ) {
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
    const pick = pickPreferredSubtitleTrack(subs);
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
  pushSubStyle(nextVis);
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
  player.flashFeedback(
    formatTrackAnnouncement(
      nextTrack,
      "sub",
      nextTrack ? player.detectedSubLangs[nextTrack.id] : null,
    ),
  );
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
  selectAudioTrackOption(nextTrack.id);
  player.flashFeedback(formatTrackAnnouncement(nextTrack, "audio"));
}

export function togglePlayback(options?: { showFeedback?: boolean }): void {
  const player = usePlayerStore.getState();
  if (!player.loaded) return;

  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  const syncConnected = sync.status.state === "connected";
  const aligning = syncConnected && sync.alignMode;
  const effectiveUsername = resolveEffectiveUsername(sync.status, app.username);
  const ctrlLock = getControllerLockState(
    syncConnected,
    sync.participants,
    effectiveUsername,
    sync.roomControl,
  );
  if (ctrlLock.lockedForLocalUser && !aligning) {
    useNotificationStore.getState().push("warn", formatControllerLockReason(ctrlLock));
    return;
  }

  const isReplay = shouldReplayFromStart({
    endedAtEof: player.endedAtEof,
    paused: player.paused,
    positionSecs: player.positionSecs,
    durationSecs: player.durationSecs,
  });
  const wantsToPlay = isReplay || player.paused;

  if (wantsToPlay && !aligning) {
    const block = getPlayBlockState({
      syncConnected,
      participants: sync.participants,
      localUsername: effectiveUsername,
    });
    if (block.blocked && block.message) {
      useNotificationStore.getState().push("warn", block.message, 5500, PLAY_BLOCKED_TAG);
      if (block.feedback) {
        player.flashFeedback(block.feedback);
      }
      return;
    }
  }

  if (isReplay) {
    const seq = nextClientSeekSeq();
    resetSharedRelativeSeek();
    player.setEndedAtEof(false);
    player.setPositionSecs(0);
    player.setPaused(false);
    if (options?.showFeedback) {
      player.flashFeedback("Replay");
    }
    void (async () => {
      try {
        await safeMpvCall(mpvSeek(0, { clientSeekSeq: seq }), "playback:replaySeek");
        await safeMpvCall(mpvSetPause(false), "playback:replayPlay");
        if (syncConnected && !aligning) {
          sync.setLocalReady(true);
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
  if (options?.showFeedback) {
    player.flashFeedback(nextPaused ? "Paused" : "Playing");
  }
  void safeMpvCall(mpvSetPause(nextPaused), "playback:mpvSetPause");
  if (syncConnected && !aligning) {
    if (nextPaused) {
      void syncUserPause(player.positionSecs).catch(() => undefined);
    } else {
      sync.setLocalReady(true);
      void syncUserPlay(player.positionSecs).catch(() => undefined);
    }
  }
}

function pausePlaybackLocally(reasonTag: string, syncWithRoom: boolean): void {
  const player = usePlayerStore.getState();
  player.setPaused(true);
  void safeMpvCall(mpvSetPause(true), reasonTag);
  if (syncWithRoom) {
    void syncUserPause(player.positionSecs).catch(() => undefined);
  }
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

  const connected = sync.status.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(sync.status, app.username);
  const ctrlLock = getControllerLockState(
    connected,
    sync.participants,
    effectiveUsername,
    sync.roomControl,
  );

  sync.setLocalReady(target);
  void syncSetReady(target, true).catch(() => undefined);

  const pausedByNotReady = !target && !player.paused && !ctrlLock.lockedForLocalUser;
  if (pausedByNotReady) {
    pausePlaybackLocally("ready:mpvSetPause", connected);
  }

  player.flashFeedback(
    target ? "Ready" : pausedByNotReady ? "Paused · Not Ready" : "Not Ready",
  );

  if (target) {
    useNotificationStore.getState().dismissByTag(peerNotReadyTag(effectiveUsername));
    const othersAllReady =
      connected &&
      sync.participants.length >= 2 &&
      sync.participants.every(
        (p) =>
          p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase() ||
          p.isReady,
      );
    if (!othersAllReady) {
      playSoundCue("peerReady", { moviePlaying: player.loaded && !player.paused });
    }
  }
}

/**
 * Pause playback automatically when a peer disconnects from the Watch Party
 * (unless playback is locked to a remaining controller) and notify the room.
 */
export function handlePeerDisconnected(peerName: string): boolean {
  const cleanName = peerName.trim() || "Someone";
  const noteStore = useNotificationStore.getState();
  noteStore.dismissByTag(peerNotReadyTag(cleanName));

  const player = usePlayerStore.getState();
  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  const connected = sync.status.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(sync.status, app.username);
  const ctrlLock = getControllerLockState(
    connected,
    sync.participants,
    effectiveUsername,
    sync.roomControl,
  );

  const shouldPause = player.loaded && !player.paused && !ctrlLock.lockedForLocalUser;
  if (shouldPause) {
    pausePlaybackLocally("peerLeft:mpvSetPause", connected);
  }

  noteStore.push(
    shouldPause ? "warn" : "info",
    formatPeerDisconnectedNotice(cleanName, shouldPause),
    shouldPause ? 5500 : 4500,
    peerDisconnectedTag(cleanName),
  );
  if (player.loaded) {
    player.flashFeedback(formatPeerDisconnectedFeedback(cleanName, shouldPause));
  }
  return shouldPause;
}

/**
 * Tracks Syncplay connection outages so unexpected disconnects (`reconnecting` / `error`)
 * pause active Watch Party playback once per outage without fighting intentional solo mode
 * or spamming across retry ticks.
 */
export class SyncDisconnectTracker {
  private outageHandled = false;

  reset(): void {
    this.outageHandled = false;
  }

  onStatus(status: SyncStatusPayload, inRoom: boolean): boolean {
    const noteStore = useNotificationStore.getState();
    if (!inRoom) {
      this.outageHandled = false;
      noteStore.dismissByTag(LOCAL_DISCONNECT_TAG);
      return false;
    }

    if (status.state === "connected") {
      this.outageHandled = false;
      noteStore.dismissByTag(LOCAL_DISCONNECT_TAG);
      return false;
    }

    if (status.state === "disconnected") {
      this.outageHandled = false;
      return false;
    }

    if (status.state === "connecting") {
      return false;
    }

    if (this.outageHandled) {
      return false;
    }
    this.outageHandled = true;

    const player = usePlayerStore.getState();
    if (!player.loaded || player.paused) {
      return false;
    }

    pausePlaybackLocally("syncDisconnect:mpvSetPause", false);
    noteStore.push(
      "warn",
      "Disconnected from Watch Party — playback paused.",
      5500,
      LOCAL_DISCONNECT_TAG,
    );
    player.flashFeedback("Disconnected · Paused");
    return true;
  }
}
