import { AppCloseIcon } from "./ui/AppIcons";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePartyFileMismatch } from "../hooks/usePartyFileMismatch";
import { formatUserError } from "../lib/errors";
import { formatParticipantMatchBadge } from "../lib/fileMismatch";
import { mpvSeek, mpvSetVolume, safeMpvCall } from "../lib/mpv";
import {
  seekPlaybackRelative,
  setMutePlayback,
  toggleMutePlayback,
  togglePlayback,
  toggleReadyStatus,
} from "../lib/playerActions";
import { nextClientSeekSeq, resetSharedRelativeSeek } from "../lib/seekCoalesce";
import { isIdentityTransform } from "../lib/sourceAlignment";
import { playSoundCue } from "../lib/soundEffects";
import {
  formatControllerLockReason,
  getControllerLockState,
  resolveEffectiveUsername,
} from "../lib/syncController";
import { computeRoomSyncHealth } from "../lib/syncHealth";
import {
  syncForceResync,
  syncSetScrubbing,
  syncUserSeek,
} from "../lib/syncplay";
import {
  canToggleReady,
  formatWaitingForNotReadyPill,
  getPlayBlockState,
} from "../lib/syncReady";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import { useAppStore } from "../store/useAppStore";
import { getEffectiveIntroSegments, useIntroStore } from "../store/useIntroStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useSyncStore } from "../store/useSyncStore";
import { OpenMediaIcon, WatchPartyIcon } from "./ui/LobbyIcons";
import {
  PlayerAudioIcon,
  PlayerCaptionsIcon,
  PlayerEpisodesIcon,
  PlayerFullscreenIcon,
  PlayerPartyChevronIcon,
  PlayerPauseIcon,
  PlayerPlayIcon,
  PlayerReactionsIcon,
  PlayerReadyIcon,
  PlayerResyncIcon,
  PlayerSeekIcon,
  PlayerSettingsIcon,
  PlayerSkipEpisodeIcon,
  PlayerVolumeIcon,
} from "./ui/PlayerIcons";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { Scrubber } from "./ui/Scrubber";

export type CapsuleTab = "room" | "episodes" | "playback" | "subtitles" | "reactions";
type RightCapsuleTab = "episodes" | "subtitles" | "playback";
type TransportControlKey = "prev" | "back" | "play" | "forward" | "next";

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
  const alignMode = useSyncStore((s) => s.alignMode);
  const introSegments = useIntroStore((s) => s.segments);
  const manualIntro = useIntroStore((s) => s.manualIntro);
  const skipIntroEnabled = useAppStore((s) => s.skipIntroMode !== "off");
  const introHighlight = useMemo(() => {
    if (!skipIntroEnabled) return null;
    const effective = getEffectiveIntroSegments(introSegments, manualIntro);
    const seg = effective.find((s) => s.kind === "intro") ?? effective[0] ?? null;
    return seg ? { start: seg.startSecs, end: seg.skipTargetSecs, kind: seg.kind } : null;
  }, [skipIntroEnabled, introSegments, manualIntro]);

  const [dragSecs, setDragSecs] = useState<number | null>(null);
  const [showRemaining, setShowRemaining] = useState(false);
  const scrubbingRef = useRef(false);
  const lastPreviewSecsRef = useRef<number | null>(null);

  const throttledPreviewSeek = useMemo(
    () =>
      createLeadingTrailingThrottle((secs: number) => {
        const seq = nextClientSeekSeq();
        safeMpvCall(mpvSeek(secs, { preview: true, clientSeekSeq: seq }), "mpvSeek:preview");
      }, 90),
    [],
  );

  useEffect(() => {
    if (locked && (scrubbingRef.current || dragSecs !== null)) {
      throttledPreviewSeek.cancel();
      lastPreviewSecsRef.current = null;
      setDragSecs(null);
      scrubbingRef.current = false;
      void syncSetScrubbing(false);
    }
  }, [dragSecs, locked, throttledPreviewSeek]);

  useEffect(() => {
    return () => {
      throttledPreviewSeek.cancel();
      lastPreviewSecsRef.current = null;
      if (scrubbingRef.current) {
        scrubbingRef.current = false;
        void syncSetScrubbing(false);
      }
    };
  }, [throttledPreviewSeek]);

  const displayedPos = dragSecs !== null ? dragSecs : currentPosSecs;
  const disabled = !loaded || durationSecs <= 0 || locked;
  const remainingSecs = Math.max(0, durationSecs - displayedPos);

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="num text-[11.5px] font-medium text-white/85 min-w-12 text-left shrink-0">
        {formatClock(displayedPos)}
      </span>
      <Scrubber
        className="flex-1"
        ariaLabel="Playback position"
        value={displayedPos}
        min={0}
        max={Math.max(1, durationSecs)}
        highlightRange={introHighlight}
        formatTooltip={(val) =>
          introHighlight && val >= introHighlight.start && val <= introHighlight.end
            ? `${formatClock(val)} · ${introHighlight.kind === "recap" ? "Recap" : "Intro"}`
            : formatClock(val)
        }
        step={0.5}
        disabled={disabled}
        onChange={(val, meta) => {
          if (meta?.phase === "commit" || meta?.phase === "key") {
            return;
          }
          if (!scrubbingRef.current) {
            scrubbingRef.current = true;
            void syncSetScrubbing(true);
            lastPreviewSecsRef.current = val;
          }
          setDragSecs(val);
          if (meta?.phase === "move" && lastPreviewSecsRef.current !== val) {
            lastPreviewSecsRef.current = val;
            throttledPreviewSeek.call(val);
          }
        }}
        onCommit={(val) => {
          throttledPreviewSeek.cancel();
          lastPreviewSecsRef.current = null;
          setDragSecs(null);
          resetSharedRelativeSeek();
          const seq = nextClientSeekSeq();
          setEndedAtEof(false);
          setPositionSecs(val);
          scrubbingRef.current = false;
          safeMpvCall(mpvSeek(val, { preview: false, clientSeekSeq: seq }), "mpvSeek");
          if (syncConnected && !alignMode) {
            void syncUserSeek(val);
          } else {
            void syncSetScrubbing(false);
          }
        }}
      />
      <button
        type="button"
        disabled={durationSecs <= 0}
        onClick={() => setShowRemaining((prev) => !prev)}
        aria-label={
          showRemaining
            ? "Showing remaining time, click for total duration"
            : "Showing total duration, click for remaining time"
        }
        title={
          durationSecs > 0
            ? showRemaining
              ? "Click to show total duration"
              : "Click to show remaining time"
            : undefined
        }
        className="num text-[11.5px] font-medium text-white/60 enabled:hover:text-white/90 min-w-12 text-right shrink-0 enabled:cursor-pointer disabled:cursor-default transition-colors"
      >
        {durationSecs > 0 && showRemaining
          ? `-${formatClock(remainingSecs)}`
          : formatClock(durationSecs)}
      </button>
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
  const timelineOffsetSecs = useSyncStore((s) => s.timelineOffsetSecs);
  const timelineScale = useSyncStore((s) => s.timelineScale);
  const timelineSegments = useSyncStore((s) => s.timelineSegments);
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
    timelineOffsetSecs,
    timelineScale,
    timelineSegments,
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
      className={`h-7.5 w-7.5 xl:w-auto xl:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium shrink-0 cursor-pointer disabled:opacity-60 ${
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
      <span className="hidden xl:inline whitespace-nowrap">
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
  onToggleFullscreen: () => void;
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  onBarHoverChange?: (hovered: boolean) => void;
  drawerTabs?: ReactNode;
  expandedDrawer?: ReactNode;
}

export const TransportBar = memo(function TransportBar({
  visible = true,
  activeTab,
  onToggleTab,
  onCloseDrawer,
  onChooseFile,
  onToggleFullscreen,
  onPrevEpisode,
  onNextEpisode,
  onBarHoverChange,
  drawerTabs,
  expandedDrawer,
}: TransportBarProps) {
  const paused = usePlayerStore((s) => s.paused);
  const loaded = usePlayerStore((s) => s.loaded);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const feedback = usePlayerStore((s) => s.feedback);

  const setVolume = usePlayerStore((s) => s.setVolume);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);
  const localReady = useSyncStore((s) => s.localReady);
  const alignMode = useSyncStore((s) => s.alignMode);
  const timelineOffsetSecs = useSyncStore((s) => s.timelineOffsetSecs);
  const timelineScale = useSyncStore((s) => s.timelineScale);

  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const roomCode = useAppStore((s) => s.roomCode);
  const selectedFileName = useAppStore((s) => s.selectedFileName);
  const playerError = usePlayerStore((s) => s.playerError);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const reactionsEnabled = useAppStore((s) => s.reactionsEnabled);
  const fullWidthPlayBar = useAppStore((s) => s.fullWidthPlayBar);
  const openSettings = useAppStore((s) => s.openSettings);
  const { mismatch } = usePartyFileMismatch();

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
  const rawCtrlLock = getControllerLockState(
    syncConnected,
    participants,
    effectiveUsername,
    roomControl,
  );
  const ctrlLock =
    syncConnected && alignMode ? { ...rawCtrlLock, lockedForLocalUser: false } : rawCtrlLock;
  const playBlock = getPlayBlockState({
    syncConnected,
    participants,
    localUsername: effectiveUsername,
  });

  const throttledVol = useMemo(
    () =>
      createLeadingTrailingThrottle((v: number) => {
        safeMpvCall(mpvSetVolume(v), "mpvSetVolume");
      }, 60),
    [],
  );

  useEffect(() => () => throttledVol.cancel(), [throttledVol]);

  const rightDockRef = useRef<HTMLDivElement | null>(null);
  const rightBtnRefs = useRef<Partial<Record<RightCapsuleTab, HTMLButtonElement | null>>>({});
  const prevRightTabRef = useRef<RightCapsuleTab | null>(null);
  const morphTimerRef = useRef<number | null>(null);
  const [dockIndicator, setDockIndicator] = useState<{
    left: number;
    width: number;
    visible: boolean;
    animateSlide: boolean;
  }>({
    left: 0,
    width: 0,
    visible: false,
    animateSlide: false,
  });
  const [dockMorphing, setDockMorphing] = useState(false);

  const rightTab: RightCapsuleTab | null =
    activeTab === "episodes" ||
    activeTab === "subtitles" ||
    activeTab === "playback"
      ? activeTab
      : null;

  useEffect(() => {
    return () => {
      if (morphTimerRef.current !== null) {
        window.clearTimeout(morphTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const dock = rightDockRef.current;
    if (!dock) return;

    const prevTab = prevRightTabRef.current;
    const switchedBetweenTabs = prevTab !== null && rightTab !== null && prevTab !== rightTab;

    if (!rightTab) {
      setDockIndicator((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      setDockMorphing(false);
      if (morphTimerRef.current !== null) {
        window.clearTimeout(morphTimerRef.current);
        morphTimerRef.current = null;
      }
    } else {
      const btn = rightBtnRefs.current[rightTab];
      if (!btn) {
        setDockIndicator((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      } else {
        const nextLeft = btn.offsetLeft;
        const nextWidth = btn.offsetWidth;
        setDockIndicator((prev) =>
          prev.left === nextLeft &&
          prev.width === nextWidth &&
          prev.visible &&
          prev.animateSlide === switchedBetweenTabs
            ? prev
            : {
                left: nextLeft,
                width: nextWidth,
                visible: true,
                animateSlide: switchedBetweenTabs,
              },
        );
      }
      if (switchedBetweenTabs) {
        setDockMorphing(true);
        if (morphTimerRef.current !== null) {
          window.clearTimeout(morphTimerRef.current);
        }
        morphTimerRef.current = window.setTimeout(() => setDockMorphing(false), 185);
      }
    }
    prevRightTabRef.current = rightTab;

    const updateBoundsOnResize = () => {
      if (!rightTab) return;
      const btn = rightBtnRefs.current[rightTab];
      if (!btn) return;
      const nextLeft = btn.offsetLeft;
      const nextWidth = btn.offsetWidth;
      setDockIndicator((prev) =>
        prev.left === nextLeft && prev.width === nextWidth
          ? prev
          : { ...prev, left: nextLeft, width: nextWidth },
      );
    };

    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateBoundsOnResize) : null;
    ro?.observe(dock);
    for (const key of ["episodes", "subtitles", "playback"] as const) {
      const b = rightBtnRefs.current[key];
      if (b) ro?.observe(b);
    }
    return () => {
      ro?.disconnect();
    };
  }, [
    rightTab,
    hasFolderEpisodes,
    activePlaylistItem?.episodeBadge,
    playlistItems.length,
  ]);

  const centerDockRef = useRef<HTMLDivElement | null>(null);
  const centerBtnRefs = useRef<Partial<Record<TransportControlKey, HTMLButtonElement | null>>>({});
  const prevTransportKeyRef = useRef<TransportControlKey | null>(null);
  const transportMorphTimerRef = useRef<number | null>(null);
  const [hoveredTransport, setHoveredTransport] = useState<TransportControlKey | null>(null);
  const [transportMorphing, setTransportMorphing] = useState(false);
  const [transportPressed, setTransportPressed] = useState(false);
  const [transportLens, setTransportLens] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    visible: boolean;
    animateSlide: boolean;
  }>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    visible: false,
    animateSlide: false,
  });

  useEffect(() => {
    return () => {
      if (transportMorphTimerRef.current !== null) {
        window.clearTimeout(transportMorphTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      setHoveredTransport(null);
      setTransportPressed(false);
      return;
    }
    if (!hoveredTransport) return;
    const isEnabled =
      hoveredTransport === "prev"
        ? hasFolderEpisodes && playlistItems.length > 1 && hasPrevEpisode && !ctrlLock.lockedForLocalUser
        : hoveredTransport === "next"
          ? hasFolderEpisodes && playlistItems.length > 1 && hasNextEpisode && !ctrlLock.lockedForLocalUser
          : loaded && !ctrlLock.lockedForLocalUser;
    if (!isEnabled) {
      setHoveredTransport(null);
      setTransportPressed(false);
    }
  }, [
    visible,
    hoveredTransport,
    hasFolderEpisodes,
    playlistItems.length,
    hasPrevEpisode,
    hasNextEpisode,
    loaded,
    ctrlLock.lockedForLocalUser,
  ]);

  useLayoutEffect(() => {
    const dock = centerDockRef.current;
    if (!dock) return;

    const prevKey = prevTransportKeyRef.current;
    const switchedBetween =
      prevKey !== null && hoveredTransport !== null && prevKey !== hoveredTransport;

    if (!hoveredTransport) {
      setTransportLens((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      setTransportMorphing(false);
      if (transportMorphTimerRef.current !== null) {
        window.clearTimeout(transportMorphTimerRef.current);
        transportMorphTimerRef.current = null;
      }
    } else {
      const btn = centerBtnRefs.current[hoveredTransport];
      if (!btn) {
        setTransportLens((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      } else {
        const dockRect = dock.getBoundingClientRect();
        const btnRect = btn.getBoundingClientRect();
        const nextWidth = btn.offsetWidth;
        const nextHeight = btn.offsetHeight;
        const nextLeft = Math.round(((btnRect.left + btnRect.width / 2 - dockRect.left) - nextWidth / 2) * 100) / 100;
        const nextTop = Math.round(((btnRect.top + btnRect.height / 2 - dockRect.top) - nextHeight / 2) * 100) / 100;
        setTransportLens((prev) =>
          prev.left === nextLeft &&
          prev.top === nextTop &&
          prev.width === nextWidth &&
          prev.height === nextHeight &&
          prev.visible &&
          prev.animateSlide === switchedBetween
            ? prev
            : {
                left: nextLeft,
                top: nextTop,
                width: nextWidth,
                height: nextHeight,
                visible: true,
                animateSlide: switchedBetween,
              },
        );
      }
      if (switchedBetween) {
        setTransportMorphing(true);
        if (transportMorphTimerRef.current !== null) {
          window.clearTimeout(transportMorphTimerRef.current);
        }
        transportMorphTimerRef.current = window.setTimeout(() => setTransportMorphing(false), 195);
      }
    }
    prevTransportKeyRef.current = hoveredTransport;

    const updateBounds = () => {
      if (!hoveredTransport) return;
      const btn = centerBtnRefs.current[hoveredTransport];
      if (!btn) return;
      const dockRect = dock.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const nextWidth = btn.offsetWidth;
      const nextHeight = btn.offsetHeight;
      const nextLeft = Math.round(((btnRect.left + btnRect.width / 2 - dockRect.left) - nextWidth / 2) * 100) / 100;
      const nextTop = Math.round(((btnRect.top + btnRect.height / 2 - dockRect.top) - nextHeight / 2) * 100) / 100;
      setTransportLens((prev) =>
        prev.left === nextLeft &&
        prev.top === nextTop &&
        prev.width === nextWidth &&
        prev.height === nextHeight
          ? prev
          : { ...prev, left: nextLeft, top: nextTop, width: nextWidth, height: nextHeight },
      );
    };

    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateBounds) : null;
    ro?.observe(dock);
    for (const key of ["prev", "back", "play", "forward", "next"] as const) {
      const b = centerBtnRefs.current[key];
      if (b) ro?.observe(b);
    }
    return () => {
      ro?.disconnect();
    };
  }, [hoveredTransport, hasFolderEpisodes, playlistItems.length]);

  const handlePlayPause = () => {
    togglePlayback();
  };

  const handleSeekRelative = (delta: number) => {
    seekPlaybackRelative(delta, {
      lockReasonText: "Seeking is restricted to the room controller.",
    });
  };

  const handleToggleReady = () => {
    toggleReadyStatus();
  };

  const visiblePeers = participants.slice(0, 3);
  const extraPeerCount = Math.max(0, participants.length - visiblePeers.length);
  const localHasFile = loaded && !playerError && Boolean(selectedFileName?.trim());
  const aligned = !isIdentityTransform({
    offsetSecs: timelineOffsetSecs,
    scale: timelineScale,
  });
  const scaleCalibrated = Math.abs(timelineScale - 1.0) > 0.001;
  const isExtended = activeTab !== null && activeTab !== "episodes" && Boolean(expandedDrawer);

  return (
    <div
      aria-hidden={!visible}
      className={`w-full flex flex-col items-center gap-2 select-none pointer-events-none ep-chrome-transition origin-bottom ${
        fullWidthPlayBar ? "px-0 pb-0 pt-2" : "px-4 pb-4 pt-2"
      } ${
        visible
          ? "opacity-100 translate-y-0 scale-100"
          : fullWidthPlayBar
            ? "opacity-0 translate-y-full"
            : "opacity-0 translate-y-5 scale-[0.982]"
      }`}
    >
      {activeTab === null &&
        (feedback ? (
          <span
            key={feedback.id}
            data-glass-region="true"
            className="ep-glass-pill anim-pop-in px-3 py-1 text-[11px] font-medium text-accent-soft rounded-full whitespace-nowrap"
          >
            {feedback.text}
          </span>
        ) : (
          loaded &&
          paused &&
          playBlock.blocked && (
            <span
              data-glass-region="true"
              className="ep-glass-pill anim-pop-in px-3 py-1 text-[11px] font-medium text-warn rounded-full whitespace-nowrap"
            >
              {formatWaitingForNotReadyPill(playBlock.notReadyUsernames)}
            </span>
          )
        ))}

      <div
        data-glass-region="true"
        data-capsule-bar="true"
        data-bar-style={fullWidthPlayBar ? "full-width" : "floating"}
        onMouseEnter={() => onBarHoverChange?.(true)}
        onMouseLeave={() => onBarHoverChange?.(false)}
        className={`${
          fullWidthPlayBar
            ? "ep-glass-bottom-bar w-full max-w-none rounded-none px-4 sm:px-6 pt-2.5 pb-3"
            : "ep-glass-capsule w-full max-w-[1140px] rounded-[26px] px-3 sm:px-4 py-2.5"
        } space-y-2 ${visible ? "pointer-events-auto" : "pointer-events-none"}`}
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
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 lg:gap-3 pt-0.5">
          {/* Left: Ready pill + Resync + Friend Avatars + Reactions Orb (or Start Party in Solo) + Volume */}
          <div className="flex items-center gap-1 sm:gap-1.5 min-w-0 max-w-full justify-self-start">
            {roomCode ? (
              <>
                <button
                  type="button"
                  disabled={!canToggleReady(loaded)}
                  onClick={handleToggleReady}
                  title={loaded ? "Toggle Ready status (R)" : "Load a local video first"}
                  className={`ep-bar-icon-btn h-7.5 w-7.5 lg:w-auto lg:px-2.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium shrink-0 cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
                    !loaded
                      ? "text-secondary hover:text-white"
                      : localReady
                        ? "text-white hover:text-white"
                        : "text-warn hover:text-warn"
                  }`}
                >
                  <PlayerReadyIcon
                    key={localReady && loaded ? "ready" : "not-ready"}
                    ready={localReady && loaded}
                    size={15}
                    className="shrink-0 anim-icon-pop"
                  />
                  <span className="hidden lg:inline whitespace-nowrap">
                    {localReady && loaded ? "Ready" : "Not Ready"}
                  </span>
                </button>

                <ResyncButton loaded={loaded} paused={paused} />

                <button
                  type="button"
                  data-capsule-anchor="room"
                  onClick={() => onToggleTab("room")}
                  aria-label="Open party lounge"
                  aria-pressed={activeTab === "room"}
                  title={
                    mismatch
                      ? `${mismatch.title} — Click to open Watch Party`
                      : hideParticipants
                        ? "Party lounge (profile icons hidden)"
                        : "Friends watching together"
                  }
                  className={`ep-bar-pill ep-party-pill h-7.5 w-7.5 rounded-full inline-flex items-center justify-center text-xs shrink-0 cursor-pointer ${
                    !hideParticipants && visiblePeers.length > 0
                      ? "sm:w-auto sm:pl-1 sm:pr-2 xl:pr-2.5 gap-1.5"
                      : "sm:w-auto sm:px-2.5 gap-1.5"
                  } ${
                    activeTab === "room"
                      ? "ep-droplet-indicator text-white font-semibold"
                      : "text-secondary hover:text-white"
                  }`}
                >
                  {!hideParticipants && visiblePeers.length > 0 ? (
                    <>
                      <WatchPartyIcon bare size={14} className="sm:hidden shrink-0" />
                      <span className="hidden sm:flex items-center -space-x-1.5">
                        {visiblePeers.map((p) => {
                          const isSelf =
                            p.username.trim().toLowerCase() ===
                            effectiveUsername.trim().toLowerCase();
                          const badge = formatParticipantMatchBadge(p, {
                            localHasFile,
                            isSelf,
                            aligned,
                            scaleCalibrated,
                          });
                          const ringClass = badge.isMismatch
                            ? "ring-warn/90"
                            : p.isReady
                              ? "ring-ok/85"
                              : "ring-warn/80";
                          return (
                            <ProfileAvatar
                              key={p.username}
                              avatarId={resolvePeerAvatarId(
                                p.username,
                                effectiveUsername,
                                avatarId,
                              )}
                              size={20}
                              title={`${p.username}${p.isReady ? " · Ready" : " · Not Ready"}${
                                badge.isMismatch ? ` · ${badge.text}` : ""
                              }`}
                              className={`ring-2 ${ringClass} shrink-0`}
                            />
                          );
                        })}
                        {extraPeerCount > 0 && (
                          <span className="h-5 w-5 rounded-full bg-raised text-[10px] text-secondary font-medium flex items-center justify-center ring-2 ring-canvas/90 shrink-0">
                            +{extraPeerCount}
                          </span>
                        )}
                      </span>
                      <span className="hidden xl:inline text-[11px] font-medium leading-none num">
                        {participants.length}
                      </span>
                      {mismatch && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-warn shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <PlayerPartyChevronIcon
                        open={activeTab === "room"}
                        size={11}
                        className="hidden sm:block shrink-0 opacity-80"
                      />
                    </>
                  ) : (
                    <>
                      <WatchPartyIcon bare size={15} className="shrink-0" />
                      {!hideParticipants && (
                        <span className="hidden xl:inline text-[11px]">Party</span>
                      )}
                      {mismatch && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-warn shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <PlayerPartyChevronIcon
                        open={activeTab === "room"}
                        size={11}
                        className="hidden sm:block shrink-0 opacity-80"
                      />
                    </>
                  )}
                </button>

                {reactionsEnabled && (
                  <button
                    type="button"
                    data-capsule-anchor="reactions"
                    aria-pressed={activeTab === "reactions"}
                    onClick={() => onToggleTab("reactions")}
                    aria-label="Live party reactions"
                    title="Live party reactions (E, or keys 1–7)"
                    className="ep-reaction-icon-btn h-7.5 w-7.5 rounded-full inline-flex items-center justify-center shrink-0 cursor-pointer"
                  >
                    <PlayerReactionsIcon
                      active={activeTab === "reactions"}
                      size={21}
                      className="shrink-0"
                    />
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                data-capsule-anchor="room"
                onClick={() => onToggleTab("room")}
                aria-label="Open party lounge"
                aria-pressed={activeTab === "room"}
                title="Start or join a Watch Party"
                className={`ep-bar-pill ep-party-pill h-7.5 w-7.5 sm:w-auto sm:px-3 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium cursor-pointer shrink-0 ${
                  activeTab === "room"
                    ? "ep-droplet-indicator text-white font-semibold"
                    : "text-secondary hover:text-white"
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
                onClick={() => toggleMutePlayback()}
                aria-label={muted ? "Unmute" : "Mute"}
                title="Mute (M)"
                data-muted={muted || volume === 0 ? "true" : "false"}
                className="ep-bar-icon-btn ep-vol-btn h-7 w-7 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer shrink-0"
              >
                <PlayerVolumeIcon
                  muted={muted || volume === 0}
                  size={18}
                />
              </button>
              <div className="hidden md:block w-14 lg:w-16 xl:w-20 shrink-0">
                <Scrubber
                  ariaLabel="Volume"
                  value={muted ? 0 : volume}
                  min={0}
                  max={130}
                  step={1}
                  tooltipPlacement="top"
                  tooltipVariant="plain"
                  formatTooltip={(v) => `${Math.round(v)}%`}
                  onChange={(v) => {
                    const rounded = Math.round(v);
                    if (muted && rounded > 0) {
                      setMutePlayback(false, { flash: false });
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
          <div
            ref={centerDockRef}
            onMouseLeave={() => {
              setHoveredTransport(null);
              setTransportPressed(false);
            }}
            onPointerUp={() => setTransportPressed(false)}
            onPointerCancel={() => setTransportPressed(false)}
            className="relative flex items-center gap-1.5 sm:gap-2 shrink-0 justify-self-center"
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 left-0 z-0 ${
                transportLens.animateSlide
                  ? "transition-[transform,width,height] duration-[400ms] ease-[cubic-bezier(0.22,1.28,0.36,1)]"
                  : ""
              }`}
              style={{
                width: `${transportLens.width}px`,
                height: `${transportLens.height}px`,
                transform: `translate3d(${transportLens.left}px, ${transportLens.top}px, 0)`,
              }}
            >
              <span
                data-visible={transportLens.visible ? "true" : "false"}
                data-morphing={transportMorphing ? "true" : undefined}
                data-pressed={transportPressed ? "true" : undefined}
                className="ep-droplet-indicator ep-droplet-core ep-transport-lens block h-full w-full rounded-full"
              />
            </span>

            {hasFolderEpisodes && playlistItems.length > 1 && onPrevEpisode && (
              <button
                ref={(el) => {
                  centerBtnRefs.current.prev = el;
                }}
                type="button"
                disabled={!hasPrevEpisode || ctrlLock.lockedForLocalUser}
                onMouseEnter={() => {
                  if (hasPrevEpisode && !ctrlLock.lockedForLocalUser) {
                    setHoveredTransport("prev");
                  } else {
                    setHoveredTransport(null);
                  }
                }}
                onPointerDown={() => {
                  if (hasPrevEpisode && !ctrlLock.lockedForLocalUser) setTransportPressed(true);
                }}
                onClick={onPrevEpisode}
                aria-label="Previous episode"
                title={
                  hasPrevEpisode
                    ? `Previous: ${playlistItems[playlistIndex - 1]?.episodeBadge || playlistItems[playlistIndex - 1]?.cleanTitle || "Episode"}`
                    : "No previous episode"
                }
                className="ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 h-8 w-8 mr-0.5 rounded-full flex items-center justify-center text-white/62 hover:text-white disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
              >
                <PlayerSkipEpisodeIcon direction="prev" size={18} />
              </button>
            )}

            <button
              ref={(el) => {
                centerBtnRefs.current.back = el;
              }}
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onMouseEnter={() => {
                if (loaded && !ctrlLock.lockedForLocalUser) {
                  setHoveredTransport("back");
                } else {
                  setHoveredTransport(null);
                }
              }}
              onPointerDown={() => {
                if (loaded && !ctrlLock.lockedForLocalUser) setTransportPressed(true);
              }}
              onClick={() => handleSeekRelative(-10)}
              aria-label="Seek back 10 seconds"
              title="Seek -10s (J)"
              className="ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 h-9 w-9 rounded-full flex items-center justify-center text-white/84 hover:text-white disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
            >
              <PlayerSeekIcon direction="back" size={24} />
            </button>

            <button
              ref={(el) => {
                centerBtnRefs.current.play = el;
              }}
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onMouseEnter={() => {
                if (loaded && !ctrlLock.lockedForLocalUser) {
                  setHoveredTransport("play");
                } else {
                  setHoveredTransport(null);
                }
              }}
              onPointerDown={() => {
                if (loaded && !ctrlLock.lockedForLocalUser) setTransportPressed(true);
              }}
              onClick={handlePlayPause}
              aria-label={paused ? "Play" : "Pause"}
              title={
                ctrlLock.lockedForLocalUser
                  ? formatControllerLockReason(ctrlLock)
                  : paused && playBlock.message
                    ? playBlock.message
                    : paused
                      ? "Play (Space)"
                      : "Pause (Space)"
              }
              className="ep-orb-play relative z-10 h-10.5 w-10.5 rounded-full flex items-center justify-center disabled:pointer-events-none cursor-pointer"
            >
              {paused ? (
                <PlayerPlayIcon key="play" size={24} className="relative z-10 anim-icon-pop" />
              ) : (
                <PlayerPauseIcon key="pause" size={24} className="relative z-10 anim-icon-pop" />
              )}
            </button>

            <button
              ref={(el) => {
                centerBtnRefs.current.forward = el;
              }}
              type="button"
              disabled={!loaded || ctrlLock.lockedForLocalUser}
              onMouseEnter={() => {
                if (loaded && !ctrlLock.lockedForLocalUser) {
                  setHoveredTransport("forward");
                } else {
                  setHoveredTransport(null);
                }
              }}
              onPointerDown={() => {
                if (loaded && !ctrlLock.lockedForLocalUser) setTransportPressed(true);
              }}
              onClick={() => handleSeekRelative(10)}
              aria-label="Seek forward 10 seconds"
              title="Seek +10s (L)"
              className="ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 h-9 w-9 rounded-full flex items-center justify-center text-white/84 hover:text-white disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
            >
              <PlayerSeekIcon direction="forward" size={24} />
            </button>

            {hasFolderEpisodes && playlistItems.length > 1 && onNextEpisode && (
              <button
                ref={(el) => {
                  centerBtnRefs.current.next = el;
                }}
                type="button"
                disabled={!hasNextEpisode || ctrlLock.lockedForLocalUser}
                onMouseEnter={() => {
                  if (hasNextEpisode && !ctrlLock.lockedForLocalUser) {
                    setHoveredTransport("next");
                  } else {
                    setHoveredTransport(null);
                  }
                }}
                onPointerDown={() => {
                  if (hasNextEpisode && !ctrlLock.lockedForLocalUser) setTransportPressed(true);
                }}
                onClick={onNextEpisode}
                aria-label="Next episode"
                title={
                  hasNextEpisode
                    ? `Next: ${playlistItems[playlistIndex + 1]?.episodeBadge || playlistItems[playlistIndex + 1]?.cleanTitle || "Episode"}`
                    : "No next episode"
                }
                className="ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 h-8 w-8 ml-0.5 rounded-full flex items-center justify-center text-white/62 hover:text-white disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
              >
                <PlayerSkipEpisodeIcon direction="next" size={18} />
              </button>
            )}
          </div>

          {/* Right: Open File + Liquid Glass Option Dock (Episodes, CC, Audio) + Settings + Fullscreen */}
          <div className="flex items-center gap-1 min-w-0 max-w-full justify-self-end">
            <button
              type="button"
              onClick={onChooseFile}
              aria-label="Open video file"
              title="Open video file(s)"
              className="ep-bar-icon-btn h-7.5 w-7.5 rounded-full hidden sm:inline-flex items-center justify-center text-xs text-secondary hover:text-white shrink-0 cursor-pointer"
            >
              <OpenMediaIcon bare size={16} className="shrink-0" />
            </button>

            <div
              ref={rightDockRef}
              className="relative inline-flex items-center gap-1 min-w-0"
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute top-0 bottom-0 left-0 ${
                  dockIndicator.animateSlide
                    ? "transition-[transform,width] duration-[420ms] ease-[cubic-bezier(0.22,1.30,0.36,1)]"
                    : ""
                }`}
                style={{
                  width: `${dockIndicator.width}px`,
                  transform: `translateX(${dockIndicator.left}px)`,
                }}
              >
                <span
                  data-visible={dockIndicator.visible ? "true" : "false"}
                  data-morphing={dockMorphing ? "true" : undefined}
                  className="ep-droplet-indicator ep-droplet-core block h-full w-full rounded-full"
                />
              </span>

              {hasFolderEpisodes && (
                <button
                  ref={(el) => {
                    rightBtnRefs.current.episodes = el;
                  }}
                  type="button"
                  data-capsule-anchor="episodes"
                  aria-pressed={activeTab === "episodes"}
                  onClick={() => onToggleTab("episodes")}
                  aria-label="Episodes drawer"
                  title="Season folder & episodes queue"
                  className={`relative z-10 h-7.5 w-7.5 lg:w-auto lg:px-2 rounded-full inline-flex items-center justify-center gap-1.5 text-xs min-w-0 max-w-[140px] cursor-pointer ${
                    activeTab === "episodes"
                      ? "ep-press border border-transparent text-white font-semibold"
                      : "ep-bar-icon-btn text-secondary hover:text-white"
                  }`}
                >
                  <PlayerEpisodesIcon active={activeTab === "episodes"} size={18} className="shrink-0" />
                  <span className="hidden lg:inline truncate num">
                    {activePlaylistItem?.episodeBadge ||
                      (playlistItems.length > 1 ? `Episodes (${playlistItems.length})` : "Episodes")}
                  </span>
                </button>
              )}

              <button
                ref={(el) => {
                  rightBtnRefs.current.subtitles = el;
                }}
                type="button"
                data-capsule-anchor="subtitles"
                aria-pressed={activeTab === "subtitles"}
                onClick={() => onToggleTab("subtitles")}
                aria-label="Subtitles popover"
                title="Subtitles & Magic Sync"
                className={`relative z-10 h-7.5 w-7.5 lg:w-auto lg:px-2 rounded-full inline-flex items-center justify-center gap-1.5 text-xs shrink-0 cursor-pointer ${
                  activeTab === "subtitles"
                    ? "ep-press border border-transparent text-white font-semibold"
                    : "ep-bar-icon-btn text-secondary hover:text-white"
                }`}
              >
                <PlayerCaptionsIcon active={activeTab === "subtitles"} size={18} className="shrink-0" />
                <span className="hidden lg:inline">CC</span>
              </button>

              <button
                ref={(el) => {
                  rightBtnRefs.current.playback = el;
                }}
                type="button"
                data-capsule-anchor="playback"
                aria-pressed={activeTab === "playback"}
                onClick={() => onToggleTab("playback")}
                aria-label="Audio & playback popover"
                title="Audio & Playback"
                className={`relative z-10 h-7.5 w-7.5 lg:w-auto lg:px-2 rounded-full inline-flex items-center justify-center gap-1.5 text-xs shrink-0 cursor-pointer ${
                  activeTab === "playback"
                    ? "ep-press border border-transparent text-white font-semibold"
                    : "ep-bar-icon-btn text-secondary hover:text-white"
                }`}
              >
                <PlayerAudioIcon active={activeTab === "playback"} size={18} className="shrink-0" />
                <span className="hidden lg:inline">Audio</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => openSettings("prefs")}
              aria-label="Preferences"
              title="Preferences"
              className="ep-bar-icon-btn h-7.5 w-7.5 rounded-full flex items-center justify-center shrink-0 text-muted hover:text-white cursor-pointer"
            >
              <PlayerSettingsIcon size={18} />
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
                size={18}
                className="anim-icon-pop"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
