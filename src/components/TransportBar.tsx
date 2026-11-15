import { AppCloseIcon } from "./ui/AppIcons";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUserError } from "../lib/errors";
import { mpvSeek, mpvSetMute, mpvSetPause, mpvSetVolume, safeMpvCall } from "../lib/mpv";
import { shouldReplayFromStart } from "../lib/playbackEnd";
import { playSoundCue } from "../lib/soundEffects";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import { computeRoomSyncHealth } from "../lib/syncHealth";
import {
  syncForceResync,
  syncSetReady,
  syncSetScrubbing,
  syncUserPause,
  syncUserPlay,
  syncUserSeek,
} from "../lib/syncplay";
import { canToggleReady, resolveReadyToggleTarget } from "../lib/syncReady";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useSyncStore } from "../store/useSyncStore";
import { OpenMediaIcon, WatchPartyIcon } from "./ui/LobbyIcons";
import {
  PlayerAudioIcon,
  PlayerCaptionsIcon,
  PlayerEpisodesIcon,
  PlayerEyeIcon,
  PlayerFullscreenIcon,
  PlayerHideBarIcon,
  PlayerPauseIcon,
  PlayerPlayIcon,
  PlayerReadyIcon,
  PlayerResyncIcon,
  PlayerSeekIcon,
  PlayerSettingsIcon,
  PlayerSkipEpisodeIcon,
  PlayerVolumeIcon,
} from "./ui/PlayerIcons";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { Scrubber } from "./ui/Scrubber";

export type CapsuleTab = "room" | "episodes" | "playback" | "subtitles";

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
  const currentPosSecs = usePlayerStore((s) => s.positionSecs);
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
        safeMpvCall(mpvSeek(secs), "mpvSeek");
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

  const displayedPos = dragSecs !== null ? dragSecs : currentPosSecs;
  const disabled = !loaded || durationSecs <= 0 || locked;

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="num text-[11.5px] font-medium text-white/85 w-12 text-left shrink-0">
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
          safeMpvCall(mpvSeek(val), "mpvSeek");
          if (syncConnected) {
            void syncUserSeek(val);
          }
          if (scrubbingRef.current) {
            scrubbingRef.current = false;
            void syncSetScrubbing(false);
          }
        }}
      />
      <span className="num text-[11.5px] font-medium text-white/60 w-12 text-right shrink-0">
        {formatClock(durationSecs)}
      </span>
    </div>
  );
}

const ResyncButton = memo(function ResyncButton({
  loaded,
  paused,
}: {
  loaded: boolean;
  paused: boolean;
}) {
  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const username = useAppStore((s) => s.username);
  const posFloored = usePlayerStore((s) => Math.floor(s.positionSecs));
  const flashFeedback = usePlayerStore((s) => s.flashFeedback);
  const pushNote = useNotificationStore((s) => s.push);
  const [busy, setBusy] = useState(false);

  const effectiveUser = resolveEffectiveUsername(syncStatus, username);
  const health = computeRoomSyncHealth({
    syncStatus,
    participants,
    localUsername: effectiveUser,
    localLoaded: loaded,
    localPositionSecs: posFloored,
  });

  const handleResync = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await syncForceResync();
      playSoundCue("peerReady", { moviePlaying: loaded && !paused });
      flashFeedback("Resynced with room");
    } catch (err) {
      pushNote("error", formatUserError(err, "Could not resync with room."));
    } finally {
      window.setTimeout(() => setBusy(false), 450);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void handleResync()}
      aria-label="Resync with room"
      title={
        health.needsResync
          ? `Resync now (${health.statusLabel}) — snaps playback & connection back in sync`
          : "Force instant resync with party timestamp"
      }
      className={`h-7.5 w-7.5 sm:w-auto sm:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium min-w-0 max-w-full cursor-pointer disabled:opacity-60 ${
        health.needsResync
          ? "ep-press bg-warn/20 border border-warn/45 text-warn hover:bg-warn/30"
          : "ep-bar-icon-btn text-secondary hover:text-white"
      }`}
    >
      <PlayerResyncIcon
        tone={health.needsResync ? "warn" : "ok"}
        size={15}
        className={`shrink-0 ${busy ? "animate-spin" : ""}`}
      />
      <span className="hidden sm:inline truncate">
        {health.maxDriftSecs >= 2.0 ? `Resync · ${health.maxDriftSecs.toFixed(1)}s` : "Resync"}
      </span>
    </button>
  );
});

interface TransportBarProps {
  visible?: boolean;
  activeTab: CapsuleTab | null;
  onToggleTab: (tab: CapsuleTab) => void;
  onCloseDrawer?: () => void;
  onChooseFile: () => void;
  onLeaveRoom?: () => void;
  onHideControls?: () => void;
  onToggleFullscreen: () => void;
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  drawerTabs?: ReactNode;
  expandedDrawer?: ReactNode;
}

export const TransportBar = memo(function TransportBar({
  visible = true,
  activeTab,
  onToggleTab,
  onCloseDrawer,
  onChooseFile,
  onHideControls,
  onToggleFullscreen,
  onPrevEpisode,
  onNextEpisode,
  drawerTabs,
  expandedDrawer,
}: TransportBarProps) {
  const paused = usePlayerStore((s) => s.paused);
  const loaded = usePlayerStore((s) => s.loaded);
  const endedAtEof = usePlayerStore((s) => s.endedAtEof);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const feedback = usePlayerStore((s) => s.feedback);

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
  const avatarId = useAppStore((s) => s.avatarId);
  const roomCode = useAppStore((s) => s.roomCode);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);
  const openSettings = useAppStore((s) => s.openSettings);
  const pushNote = useNotificationStore((s) => s.push);

  const playlistItems = usePlaylistStore((s) => s.items);
  const playlistIndex = usePlaylistStore((s) => s.currentIndex);
  const folderName = usePlaylistStore((s) => s.folderName);
  const hasFolderEpisodes = Boolean(folderName) || playlistItems.length > 1;
  const activePlaylistItem =
    playlistIndex >= 0 && playlistIndex < playlistItems.length ? playlistItems[playlistIndex] : null;
  const hasPrevEpisode = playlistItems.length > 1 && playlistIndex > 0;
  const hasNextEpisode =
    playlistItems.length > 1 && playlistIndex >= 0 && playlistIndex < playlistItems.length - 1;

  const syncConnected = syncStatus.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);
  const ctrlLock = getControllerLockState(syncConnected, participants, effectiveUsername);

  const throttledVol = useMemo(
    () =>
      createLeadingTrailingThrottle((v: number) => {
        safeMpvCall(mpvSetVolume(v), "mpvSetVolume");
      }, 60),
    [],
  );

  useEffect(() => () => throttledVol.cancel(), [throttledVol]);

  const handlePlayPause = () => {
    if (!loaded) return;
    if (ctrlLock.lockedForLocalUser) {
      pushNote("warn", "Playback is controlled by the room controller.");
      return;
    }

    const positionSecs = usePlayerStore.getState().positionSecs;
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
        try {
          await safeMpvCall(mpvSeek(0), "mpvSeek:replay");
          await safeMpvCall(mpvSetPause(false), "mpvSetPause:replay");
          if (syncConnected) {
            await syncUserSeek(0);
            await syncUserPlay(0);
          }
        } catch {
          // Sync notification error already surfaced or non-fatal.
        }
      })();
      return;
    }

    const nextPaused = !paused;
    setPaused(nextPaused);
    safeMpvCall(mpvSetPause(nextPaused), "mpvSetPause");
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
    const positionSecs = usePlayerStore.getState().positionSecs;
    const maxCap = durationSecs > 0 ? durationSecs : Number.POSITIVE_INFINITY;
    const next = Math.max(0, Math.min(maxCap, positionSecs + delta));
    setEndedAtEof(false);
    setPositionSecs(next);
    safeMpvCall(mpvSeek(next), "mpvSeek");
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
      const othersAllReady =
        syncConnected &&
        participants.length >= 2 &&
        participants.every(
          (p) =>
            p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase() ||
            p.isReady,
        );
      if (target && !othersAllReady) {
        playSoundCue("peerReady", { moviePlaying: loaded && !paused });
      }
    }
  };

  const visiblePeers = participants.slice(0, 3);
  const extraPeerCount = Math.max(0, participants.length - visiblePeers.length);
  const isExtended = activeTab !== null && activeTab !== "episodes" && Boolean(expandedDrawer);

  return (
    <div
      aria-hidden={!visible}
      className={`w-full px-4 pb-4 pt-2 flex flex-col items-center gap-2 select-none pointer-events-none ep-chrome-transition origin-bottom ${
        visible
          ? "opacity-100 translate-y-0 scale-100"
          : "opacity-0 translate-y-5 scale-[0.982]"
      }`}
    >
      {feedback && (
        <span
          key={feedback.id}
          data-glass-region="true"
          className="ep-glass-pill anim-pop-in px-3 py-1 text-[11px] font-medium text-accent-soft rounded-full whitespace-nowrap"
        >
          {feedback.text}
        </span>
      )}

      <div
        data-glass-region="true"
        data-capsule-bar="true"
        className={`ep-glass-capsule w-full max-w-[1060px] rounded-[26px] px-4 py-2.5 space-y-2 ${
          visible ? "pointer-events-auto" : "pointer-events-none"
        }`}
      >
        {isExtended && (
          <div className="anim-drawer-bloom pb-1.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="min-w-0 flex-1 max-w-[360px]">{drawerTabs}</div>
              {onCloseDrawer && (
                <button
                  type="button"
                  onClick={onCloseDrawer}
                  aria-label="Close popover"
                  title="Collapse extended deck (Esc)"
                  className="ep-bar-icon-btn h-7.5 w-7.5 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer shrink-0"
                >
                  <AppCloseIcon size={14} />
                </button>
              )}
            </div>
            <div className="max-h-[42vh] overflow-visible">{expandedDrawer}</div>
          </div>
        )}

        {/* Top capsule line: full-width symmetric elastic scrubber */}
        <div className="w-full px-0.5">
          <PlaybackScrubber locked={ctrlLock.lockedForLocalUser} />
        </div>

        {/* Bottom capsule line: Ready & Avatars / Start Party + Volume | Transport Cluster | File, (Episodes if folder), CC, Audio, Shortcuts, Settings, Fullscreen */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 pt-0.5">
          {/* Left: Ready pill + Resync + Friend Avatars (or Start Party in Solo) + Volume */}
          <div className="flex items-center gap-1.5 min-w-0 max-w-full justify-self-start">
            {roomCode ? (
              <>
                <button
                  type="button"
                  disabled={!canToggleReady(loaded)}
                  onClick={handleToggleReady}
                  title={loaded ? "Toggle Ready status (R)" : "Load a local video first"}
                  className={`ep-bar-icon-btn h-7.5 w-7.5 sm:w-auto sm:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium min-w-0 max-w-full cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
                    localReady && loaded
                      ? "text-white hover:text-white"
                      : "text-secondary hover:text-white"
                  }`}
                >
                  <PlayerReadyIcon
                    key={localReady && loaded ? "ready" : "not-ready"}
                    ready={localReady && loaded}
                    size={15}
                    className="shrink-0 anim-icon-pop"
                  />
                  <span className="hidden sm:inline truncate">
                    {localReady && loaded ? "Ready" : "Not Ready"}
                  </span>
                </button>

                <ResyncButton loaded={loaded} paused={paused} />

                <div className="ep-bar-dock inline-flex items-center rounded-full p-0.5 gap-0.5 shrink-0">
                  {!hideParticipants ? (
                    <button
                      type="button"
                      data-capsule-anchor="room"
                      onClick={() => onToggleTab("room")}
                      aria-label="Open party lounge"
                      title="Friends watching together"
                      className={`ep-press h-6.5 pl-1 pr-2 rounded-full inline-flex items-center gap-1.5 text-xs cursor-pointer ${
                        activeTab === "room"
                          ? "bg-accent/20 text-white shadow-[inset_0_1px_0.5px_rgba(255,255,255,0.28)] ring-1 ring-accent-soft/25"
                          : "text-secondary hover:text-white hover:bg-white/[0.08]"
                      }`}
                    >
                      {visiblePeers.length > 0 ? (
                        <>
                          <span className="flex items-center -space-x-1.5">
                            {visiblePeers.map((p) => (
                              <span
                                key={p.username}
                                title={`${p.username}${p.isReady ? " · Ready" : ""}`}
                                className={`h-5 w-5 rounded-full flex items-center justify-center ring-2 ${
                                  p.isReady ? "ring-ok/85" : "ring-canvas/90"
                                }`}
                              >
                                <ProfileAvatar
                                  avatarId={resolvePeerAvatarId(
                                    p.username,
                                    effectiveUsername,
                                    avatarId,
                                  )}
                                  size={20}
                                />
                              </span>
                            ))}
                            {extraPeerCount > 0 && (
                              <span className="h-5 w-5 rounded-full bg-raised text-[10px] text-secondary font-medium flex items-center justify-center ring-2 ring-canvas/90">
                                +{extraPeerCount}
                              </span>
                            )}
                          </span>
                          <span className="hidden lg:inline text-[11px] font-medium num">
                            {participants.length}
                          </span>
                        </>
                      ) : (
                        <>
                          <WatchPartyIcon bare size={15} className="ml-0.5 shrink-0" />
                          <span className="hidden lg:inline text-[11px]">Party</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-capsule-anchor="room"
                      onClick={() => onToggleTab("room")}
                      aria-label="Open party lounge"
                      title="Party lounge (profile icons hidden)"
                      className={`ep-press h-6.5 px-2 rounded-full inline-flex items-center gap-1 text-[11px] cursor-pointer ${
                        activeTab === "room"
                          ? "bg-accent/20 text-white shadow-[inset_0_1px_0.5px_rgba(255,255,255,0.28)] ring-1 ring-accent-soft/25"
                          : "text-muted hover:text-white hover:bg-white/[0.08]"
                      }`}
                    >
                      <WatchPartyIcon bare size={15} className="shrink-0" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setHideParticipants(!hideParticipants)}
                    aria-label={hideParticipants ? "Show profile icons" : "Hide profile icons"}
                    title={
                      hideParticipants
                        ? "Show friend profile icons"
                        : "Hide all profile icons for pure focus"
                    }
                    className="ep-bar-icon-btn h-6.5 w-6.5 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
                  >
                    <PlayerEyeIcon hidden={hideParticipants} size={15} />
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                data-capsule-anchor="room"
                onClick={() => onToggleTab("room")}
                aria-label="Open party lounge"
                title="Start or join a Watch Party"
                className={`h-7.5 w-7.5 sm:w-auto sm:px-3 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium cursor-pointer shrink-0 ${
                  activeTab === "room"
                    ? "ep-press ep-glass-pill-active text-white"
                    : "ep-bar-pill text-secondary hover:text-white"
                }`}
              >
                <WatchPartyIcon bare size={16} className="shrink-0" />
                <span className="hidden sm:inline whitespace-nowrap">Watch Party</span>
              </button>
            )}

            {/* Compact Volume */}
            <div className="flex items-center gap-1 pl-0.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  safeMpvCall(mpvSetMute(next), "mpvSetMute");
                }}
                aria-label={muted ? "Unmute" : "Mute"}
                title="Mute (M)"
                className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer shrink-0"
              >
                <PlayerVolumeIcon
                  key={muted || volume === 0 ? "muted" : "unmuted"}
                  muted={muted || volume === 0}
                  size={17}
                  className="anim-icon-pop"
                />
              </button>
              <div className="hidden sm:block w-14 shrink-0">
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
                      safeMpvCall(mpvSetMute(false), "mpvSetMute");
                    }
                    setVolume(rounded);
                    throttledVol.call(rounded);
                  }}
                  onCommit={(v) => {
                    throttledVol.cancel();
                    const rounded = Math.round(v);
                    setVolume(rounded);
                    safeMpvCall(mpvSetVolume(rounded), "mpvSetVolume");
                  }}
                />
              </div>
            </div>
          </div>

          {/* Center: Hero Transport Cluster */}
          <div className="flex items-center gap-1.5 shrink-0 justify-self-center">
            {hasFolderEpisodes && playlistItems.length > 1 && onPrevEpisode && (
              <button
                type="button"
                disabled={!hasPrevEpisode || ctrlLock.lockedForLocalUser}
                onClick={onPrevEpisode}
                aria-label="Previous episode"
                title="Previous episode"
                className="ep-bar-icon-btn h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                <PlayerSkipEpisodeIcon direction="prev" size={16} />
              </button>
            )}

            <button
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onClick={() => handleSeekRelative(-10)}
              aria-label="Seek back 10 seconds"
              title="Seek -10s (J)"
              className="ep-bar-icon-btn h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <PlayerSeekIcon direction="back" size={19} />
            </button>

            <button
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onClick={handlePlayPause}
              aria-label={paused ? "Play" : "Pause"}
              title={
                ctrlLock.lockedForLocalUser
                  ? "Controlled by room controller"
                  : paused
                    ? "Play (Space)"
                    : "Pause (Space)"
              }
              className="ep-orb-play h-11 w-11 rounded-full flex items-center justify-center disabled:pointer-events-none cursor-pointer"
            >
              {paused ? (
                <PlayerPlayIcon key="play" size={24} className="relative z-10 anim-icon-pop" />
              ) : (
                <PlayerPauseIcon key="pause" size={24} className="relative z-10 anim-icon-pop" />
              )}
            </button>

            <button
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onClick={() => handleSeekRelative(10)}
              aria-label="Seek forward 10 seconds"
              title="Seek +10s (L)"
              className="ep-bar-icon-btn h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <PlayerSeekIcon direction="forward" size={19} />
            </button>

            {hasFolderEpisodes && playlistItems.length > 1 && onNextEpisode && (
              <button
                type="button"
                disabled={!hasNextEpisode || ctrlLock.lockedForLocalUser}
                onClick={onNextEpisode}
                aria-label="Next episode"
                title="Next episode"
                className="ep-bar-icon-btn h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                <PlayerSkipEpisodeIcon direction="next" size={16} />
              </button>
            )}
          </div>

          {/* Right: Open File + (Episodes when folder selected) + CC + Audio + Shortcuts + Settings + Fullscreen */}
          <div className="flex items-center gap-1 min-w-0 max-w-full justify-self-end">
            <button
              type="button"
              onClick={onChooseFile}
              aria-label="Open video file"
              title="Open video file(s)"
              className="ep-bar-icon-btn h-7.5 w-7.5 2xl:w-auto 2xl:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs text-secondary hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              <OpenMediaIcon bare size={16} className="shrink-0" />
              <span className="hidden 2xl:inline">Open</span>
            </button>

            {hasFolderEpisodes && (
              <button
                type="button"
                data-capsule-anchor="episodes"
                onClick={() => onToggleTab("episodes")}
                aria-label="Episodes drawer"
                title="Season folder & episodes queue"
                className={`ep-bar-icon-btn h-7.5 w-7.5 sm:w-auto sm:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium min-w-0 max-w-full cursor-pointer ${
                  activeTab === "episodes"
                    ? "text-white"
                    : "text-secondary hover:text-white"
                }`}
              >
                <PlayerEpisodesIcon active={activeTab === "episodes"} size={17} className="shrink-0" />
                <span className="hidden sm:inline truncate num">
                  {activePlaylistItem?.episodeBadge ||
                    (playlistItems.length > 1 ? `Episodes (${playlistItems.length})` : "Episodes")}
                </span>
              </button>
            )}

            <button
              type="button"
              data-capsule-anchor="subtitles"
              onClick={() => onToggleTab("subtitles")}
              aria-label="Subtitles popover"
              title="Subtitles & Magic Sync"
              className={`ep-bar-icon-btn h-7.5 w-7.5 sm:w-auto sm:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium shrink-0 cursor-pointer ${
                activeTab === "subtitles"
                  ? "text-white"
                  : "text-secondary hover:text-white"
              }`}
            >
              <PlayerCaptionsIcon active={activeTab === "subtitles"} size={17} className="shrink-0" />
              <span className="hidden sm:inline">CC</span>
            </button>

            <button
              type="button"
              data-capsule-anchor="playback"
              onClick={() => onToggleTab("playback")}
              aria-label="Audio & playback popover"
              title="Audio & Playback"
              className={`ep-bar-icon-btn h-7.5 w-7.5 sm:w-auto sm:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium shrink-0 cursor-pointer ${
                activeTab === "playback"
                  ? "text-white"
                  : "text-secondary hover:text-white"
              }`}
            >
              <PlayerAudioIcon active={activeTab === "playback"} size={17} className="shrink-0" />
              <span className="hidden sm:inline">Audio</span>
            </button>

            {loaded && onHideControls && (
              <button
                type="button"
                onClick={onHideControls}
                aria-label="Hide player controls"
                title="Pure video (hover bottom edge to wake controls)"
                className="ep-bar-icon-btn h-7.5 w-7.5 rounded-full hidden sm:flex items-center justify-center shrink-0 text-muted hover:text-white cursor-pointer"
              >
                <PlayerHideBarIcon size={16} />
              </button>
            )}

            <button
              type="button"
              onClick={() => openSettings("prefs")}
              aria-label="Preferences"
              title="Preferences"
              className="ep-bar-icon-btn h-7.5 w-7.5 rounded-full flex items-center justify-center shrink-0 text-muted hover:text-white cursor-pointer"
            >
              <PlayerSettingsIcon size={16} />
            </button>

            <button
              type="button"
              onClick={onToggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              title="Fullscreen (F)"
              className="ep-bar-icon-btn h-7.5 w-7.5 rounded-full flex items-center justify-center shrink-0 text-secondary hover:text-white cursor-pointer"
            >
              <PlayerFullscreenIcon
                key={isFullscreen ? "min" : "max"}
                isFullscreen={isFullscreen}
                size={16}
                className="anim-icon-pop"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
