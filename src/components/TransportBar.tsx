import {
  AudioLines,
  Captions,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Circle,
  Eye,
  EyeOff,
  FolderOpen,
  Keyboard,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { mpvSeek, mpvSetMute, mpvSetPause, mpvSetVolume } from "../lib/mpv";
import { shouldReplayFromStart } from "../lib/playbackEnd";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import {
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
import { useSyncStore } from "../store/useSyncStore";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { Scrubber } from "./ui/Scrubber";
import { StatusDot } from "./ui/StatusDot";

export type CapsuleTab = "room" | "playback" | "subtitles";

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

  const displayedPos = dragSecs !== null ? dragSecs : currentPosSecs;
  const disabled = !loaded || durationSecs <= 0 || locked;

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="num text-[11px] text-secondary w-13 text-right shrink-0">
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
      <span className="num text-[11px] text-muted w-13 shrink-0">
        {formatClock(durationSecs)}
      </span>
    </div>
  );
}

interface TransportBarProps {
  activeTab: CapsuleTab | null;
  onToggleTab: (tab: CapsuleTab) => void;
  onChooseFile: () => void;
  onLeaveRoom: () => void;
  onHideControls?: () => void;
  onToggleFullscreen: () => void;
  expandedDrawer?: ReactNode;
}

export const TransportBar = memo(function TransportBar({
  activeTab,
  onToggleTab,
  onChooseFile,
  onLeaveRoom,
  onHideControls,
  onToggleFullscreen,
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
  const selectedFileName = useAppStore((s) => s.selectedFileName);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);
  const openSettings = useAppStore((s) => s.openSettings);
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
    const positionSecs = usePlayerStore.getState().positionSecs;
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

  const visiblePeers = participants.slice(0, 4);
  const extraPeerCount = Math.max(0, participants.length - visiblePeers.length);

  return (
    <div className="shrink-0 w-full px-4 pb-3 pt-1 flex justify-center select-none bg-canvas">
      <div className="ep-glass-capsule anim-fade-slide-up w-full max-w-[940px] rounded-[26px] px-4 py-2.5 space-y-2">
        {expandedDrawer && <div className="anim-fade-slide-up pb-1.5">{expandedDrawer}</div>}

        {/* Top capsule line: movie title/leave status + elastic scrubber */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 shrink-0 max-w-[230px]">
            <button
              type="button"
              onClick={onLeaveRoom}
              aria-label={roomCode ? "Leave room" : "Back to lobby"}
              title={roomCode ? "Leave room" : "Back to lobby"}
              className="ep-press h-6 w-6 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer shrink-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {roomCode && (
              <StatusDot
                tone={
                  syncStatus.state === "connected"
                    ? "ok"
                    : syncStatus.state === "error"
                      ? "bad"
                      : "warn"
                }
                pulse={
                  syncStatus.state === "connecting" || syncStatus.state === "reconnecting"
                }
              />
            )}
            <button
              type="button"
              onClick={onChooseFile}
              title={selectedFileName ? `Playing: ${selectedFileName} (Click to change)` : "Choose a movie file"}
              className="ep-press truncate text-xs font-medium text-primary/90 hover:text-white cursor-pointer"
            >
              {selectedFileName || "Open Movie…"}
            </button>
          </div>

          <div className="flex-1 min-w-0">
            <PlaybackScrubber locked={ctrlLock.lockedForLocalUser} />
          </div>

          {feedback && (
            <span
              key={feedback.id}
              className="anim-pop-in hidden md:inline-flex px-2.5 py-0.5 text-[11px] font-medium bg-accent/25 text-accent-soft rounded-full whitespace-nowrap shrink-0"
            >
              {feedback.text}
            </span>
          )}
        </div>

        {/* Bottom capsule line: Ready & Hideable Friend Avatars (or Start Party in Solo) | Hero Play Orb | Contextual Popovers */}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          {/* Left: Ready pill + Friend Avatars + Hide Avatars toggle + Volume */}
          <div className="flex items-center gap-1.5 min-w-0">
            {roomCode ? (
              <>
                <button
                  type="button"
                  disabled={!canToggleReady(loaded)}
                  onClick={handleToggleReady}
                  title={loaded ? "Toggle Ready status (R)" : "Load a local video first"}
                  className={`ep-press h-7.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-xs font-medium cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
                    localReady && loaded
                      ? "ep-glass-pill-active text-white"
                      : "bg-white/8 text-secondary hover:text-white hover:bg-white/14"
                  }`}
                >
                  {localReady && loaded ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-ok" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted" />
                  )}
                  <span className="hidden sm:inline">
                    {localReady && loaded ? "Ready" : "Not Ready"}
                  </span>
                </button>

                {/* Comforting Friend Profile Avatars integrated cleanly onto capsule */}
                <div className="inline-flex items-center rounded-full bg-white/6 p-0.5 gap-0.5">
                  {!hideParticipants ? (
                    <button
                      type="button"
                      onClick={() => onToggleTab("room")}
                      aria-label="Open party lounge"
                      title="Friends watching together"
                      className={`ep-press h-6.5 pl-1 pr-2 rounded-full inline-flex items-center gap-1.5 text-xs cursor-pointer transition-colors ${
                        activeTab === "room"
                          ? "bg-accent/30 text-white"
                          : "text-secondary hover:text-white"
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
                          <Users className="h-3.5 w-3.5 text-accent-soft ml-0.5" />
                          <span className="hidden lg:inline text-[11px]">Party</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onToggleTab("room")}
                      aria-label="Open party lounge"
                      title="Party lounge (profile icons hidden)"
                      className={`ep-press h-6.5 px-2 rounded-full inline-flex items-center gap-1 text-[11px] cursor-pointer ${
                        activeTab === "room" ? "bg-accent/30 text-white" : "text-muted hover:text-white"
                      }`}
                    >
                      <Users className="h-3.5 w-3.5" />
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
                    className="ep-press h-6.5 w-6.5 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer"
                  >
                    {hideParticipants ? (
                      <EyeOff className="h-3 w-3 text-accent-soft" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={() => onToggleTab("room")}
                aria-label="Open party lounge"
                title="Start or join a Watch Party"
                className={`ep-press h-7.5 px-3 rounded-full inline-flex items-center gap-1.5 text-xs font-medium cursor-pointer ${
                  activeTab === "room"
                    ? "ep-glass-pill-active text-white"
                    : "bg-white/8 text-secondary hover:text-white hover:bg-white/14"
                }`}
              >
                <Users className="h-3.5 w-3.5 text-accent-soft" />
                <span className="hidden sm:inline">Start Party</span>
              </button>
            )}

            {/* Compact Volume */}
            <div className="hidden md:flex items-center gap-1 pl-1">
              <button
                type="button"
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  void mpvSetMute(next);
                }}
                aria-label={muted ? "Unmute" : "Mute"}
                title="Mute (M)"
                className="ep-press h-7 w-7 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer"
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-3.5 w-3.5 text-muted" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" />
                )}
              </button>
              <div className="w-16">
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
          </div>

          {/* Center: Hero Transport Cluster */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onClick={() => handleSeekRelative(-10)}
              aria-label="Seek back 10 seconds"
              title="Seek -10s (J)"
              className="ep-press h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
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
              className="ep-orb-play h-9.5 w-9.5 rounded-full flex items-center justify-center disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              {paused ? (
                <Play className="h-4 w-4 fill-current ml-0.5" />
              ) : (
                <Pause className="h-4 w-4 fill-current" />
              )}
            </button>

            <button
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onClick={() => handleSeekRelative(10)}
              aria-label="Seek forward 10 seconds"
              title="Seek +10s (L)"
              className="ep-press h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Right: Open File + Subtitles & Audio Popovers + Pure Video + Settings/FS */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onChooseFile}
              aria-label="Open video file"
              title="Open video file"
              className="ep-press h-7.5 w-7.5 sm:w-auto sm:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs text-secondary hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Open</span>
            </button>

            <button
              type="button"
              onClick={() => onToggleTab("subtitles")}
              aria-label="Subtitles popover"
              title="Subtitles & Magic Sync"
              className={`ep-press h-7.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-xs font-medium cursor-pointer ${
                activeTab === "subtitles"
                  ? "ep-glass-pill-active text-white"
                  : "bg-white/8 text-secondary hover:text-white hover:bg-white/14"
              }`}
            >
              <Captions className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">CC</span>
            </button>

            <button
              type="button"
              onClick={() => onToggleTab("playback")}
              aria-label="Audio & playback popover"
              title="Audio & Playback"
              className={`ep-press h-7.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-xs font-medium cursor-pointer ${
                activeTab === "playback"
                  ? "ep-glass-pill-active text-white"
                  : "bg-white/8 text-secondary hover:text-white hover:bg-white/14"
              }`}
            >
              <AudioLines className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Audio</span>
            </button>

            {loaded && onHideControls && (
              <button
                type="button"
                onClick={onHideControls}
                aria-label="Hide player controls"
                title="Pure video (hover bottom edge to wake controls)"
                className="ep-press h-7.5 w-7.5 rounded-full hidden sm:flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={openShortcuts}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="ep-press h-7.5 w-7.5 rounded-full hidden sm:flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <Keyboard className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => openSettings("prefs")}
              aria-label="Preferences"
              title="Preferences"
              className="ep-press h-7.5 w-7.5 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={onToggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              title="Fullscreen (F)"
              className="ep-press h-7.5 w-7.5 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer"
            >
              {isFullscreen ? (
                <Minimize className="h-3.5 w-3.5" />
              ) : (
                <Maximize className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
