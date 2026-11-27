import {
  AppCloseIcon,
  AppVoiceIcon,
} from "./ui/AppIcons";
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
import {
  cancelSeekbarThumbnails,
  generateSeekbarThumbnails,
  getCachedSeekbarThumbnails,
  getThumbnailFrameStyle,
  type ThumbnailSprite,
} from "../lib/thumbnails";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import { isCaptureHealthy, isLocalVoiceSpeaking, isParticipantSpeaking } from "../lib/voiceActions";
import { useAppStore } from "../store/useAppStore";
import { useChatStore } from "../store/useChatStore";
import { getEffectiveIntroSegments, useIntroStore } from "../store/useIntroStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import {
  getReactionBucketAt,
  getReactionHotspots,
  subscribeReactionTimeline,
} from "../store/useReactionStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useSyncStore } from "../store/useSyncStore";
import { useVoiceStore } from "../store/useVoiceStore";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import { OpenMediaIcon, WatchPartyIcon } from "./ui/LobbyIcons";
import {
  PlayerAudioIcon,
  PlayerCaptionsIcon,
  PlayerChatIcon,
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
import { PresenceAvatar } from "./ui/PresenceAvatar";
import { resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { VoiceMicDeafenPills } from "./ui/VoiceQuickControls";
import { Scrubber } from "./ui/Scrubber";

export type CapsuleTab = "room" | "episodes" | "playback" | "subtitles" | "reactions";
type RightCapsuleTab = "episodes" | "subtitles" | "playback";
type TransportControlKey = "prev" | "back" | "play" | "forward" | "next";
export type PlayBarTier = "wide" | "desktop" | "compact" | "stacked" | "mini";
export type VolumeSliderSize = "none" | "xs" | "sm" | "md" | "lg";

export interface PlayBarLayout {
  tier: PlayBarTier;
  isTwoRowControls: boolean;
  showTextLabels: boolean;
  showResyncLabel: boolean;
  showPartyCount: boolean;
  showPartyAvatarsInline: boolean;
  maxVisibleAvatars: number;
  showPartyChevron: boolean;
  volumeSliderWidth: VolumeSliderSize;
}

/**
 * Derives the play bar's responsive layout strictly from its measured stage width
 * so docked sidebars, DPI scaling, half-screen snaps, and mini windows never collide.
 */
export function resolvePlayBarLayout(outerWidth: number): PlayBarLayout {
  const w = Number.isFinite(outerWidth) && outerWidth > 0 ? outerWidth : 1024;
  if (w >= 1080) {
    return {
      tier: "wide",
      isTwoRowControls: false,
      showTextLabels: true,
      showResyncLabel: w >= 1140,
      showPartyCount: true,
      showPartyAvatarsInline: true,
      maxVisibleAvatars: 3,
      showPartyChevron: true,
      volumeSliderWidth: w >= 1180 ? "lg" : "md",
    };
  }
  if (w >= 860) {
    return {
      tier: "desktop",
      isTwoRowControls: false,
      showTextLabels: false,
      showResyncLabel: false,
      showPartyCount: false,
      showPartyAvatarsInline: true,
      maxVisibleAvatars: w >= 1000 ? 3 : w >= 920 ? 2 : 1,
      showPartyChevron: true,
      volumeSliderWidth: w >= 960 ? "sm" : "xs",
    };
  }
  if (w >= 680) {
    return {
      tier: "compact",
      isTwoRowControls: false,
      showTextLabels: false,
      showResyncLabel: false,
      showPartyCount: false,
      showPartyAvatarsInline: w >= 740,
      maxVisibleAvatars: w >= 780 ? 2 : w >= 740 ? 1 : 0,
      showPartyChevron: w >= 710,
      volumeSliderWidth: "none",
    };
  }
  if (w >= 430) {
    return {
      tier: "stacked",
      isTwoRowControls: true,
      showTextLabels: false,
      showResyncLabel: false,
      showPartyCount: false,
      showPartyAvatarsInline: w >= 540,
      maxVisibleAvatars: w >= 540 ? 2 : 0,
      showPartyChevron: w >= 540,
      volumeSliderWidth: w >= 510 ? "xs" : "none",
    };
  }
  return {
    tier: "mini",
    isTwoRowControls: true,
    showTextLabels: false,
    showResyncLabel: false,
    showPartyCount: false,
    showPartyAvatarsInline: false,
    maxVisibleAvatars: 0,
    showPartyChevron: false,
    volumeSliderWidth: "none",
  };
}

function applyPlayBarFitLevel(base: PlayBarLayout, fitLevel: number): PlayBarLayout {
  if (fitLevel <= 0 || base.tier === "mini") return base;
  const next = { ...base };
  // Step 1: drop only the optional Resync text label first.
  if (fitLevel >= 1) {
    next.showResyncLabel = false;
  }
  // Step 2: trim extra inline avatars & slim the volume slider (never hide volume yet).
  if (fitLevel >= 2) {
    next.maxVisibleAvatars = Math.min(next.maxVisibleAvatars, 2);
    next.showPartyCount = false;
    if (next.volumeSliderWidth === "lg" || next.volumeSliderWidth === "md") {
      next.volumeSliderWidth = "sm";
    }
  }
  // Step 3: collapse remaining text labels (Ready / Episodes / CC / Audio), keep volume slider.
  if (fitLevel >= 3) {
    next.maxVisibleAvatars = Math.min(next.maxVisibleAvatars, 1);
    next.showTextLabels = false;
    if (next.volumeSliderWidth !== "none") {
      next.volumeSliderWidth = "xs";
    }
  }
  // Step 4: last-resort compact mode before 2-row stacking.
  if (fitLevel >= 4) {
    next.volumeSliderWidth = "none";
    next.maxVisibleAvatars = 0;
    next.showPartyAvatarsInline = false;
  }
  if (fitLevel >= 5) {
    next.isTwoRowControls = true;
  }
  return next;
}

function getPlayBarLayoutKey(layout: PlayBarLayout): string {
  return [
    layout.tier,
    layout.isTwoRowControls ? 1 : 0,
    layout.showTextLabels ? 1 : 0,
    layout.showResyncLabel ? 1 : 0,
    layout.showPartyCount ? 1 : 0,
    layout.showPartyAvatarsInline ? 1 : 0,
    layout.maxVisibleAvatars,
    layout.showPartyChevron ? 1 : 0,
    layout.volumeSliderWidth,
  ].join(":");
}

const VOLUME_WIDTH_CLASSES: Record<Exclude<VolumeSliderSize, "none">, string> = {
  xs: "w-12",
  sm: "w-14",
  md: "w-16",
  lg: "w-20",
};

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

function PlaybackScrubber({
  locked,
  compact = false,
}: {
  locked: boolean;
  compact?: boolean;
}) {
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
  const selectedFilePath = useAppStore((s) => s.selectedFilePath);
  const seekbarThumbnails = useAppStore((s) => s.seekbarThumbnails);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const reactionsEnabled = useAppStore((s) => s.reactionsEnabled);
  const durationReady = loaded && durationSecs >= 15;
  const [reactionTick, setReactionTick] = useState(0);
  useEffect(() => {
    if (lowPowerMode || !reactionsEnabled) return;
    return subscribeReactionTimeline(() => setReactionTick((n) => n + 1));
  }, [lowPowerMode, reactionsEnabled]);
  const reactionHotspots = useMemo(
    () =>
      !lowPowerMode && reactionsEnabled && durationReady
        ? getReactionHotspots(durationSecs)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [durationReady, durationSecs, lowPowerMode, reactionsEnabled, reactionTick],
  );
  const durationRef = useRef(durationSecs);
  durationRef.current = durationSecs;
  const [thumbSprite, setThumbSprite] = useState<ThumbnailSprite | null>(() =>
    getCachedSeekbarThumbnails(selectedFilePath, durationSecs),
  );

  useEffect(() => {
    if (
      !seekbarThumbnails ||
      !durationReady ||
      !selectedFilePath ||
      selectedFilePath.startsWith("https://") ||
      selectedFilePath.startsWith("http://")
    ) {
      setThumbSprite(null);
      void cancelSeekbarThumbnails();
      return;
    }
    const cached = getCachedSeekbarThumbnails(selectedFilePath, durationRef.current);
    if (cached) {
      setThumbSprite(cached);
      return;
    }
    setThumbSprite(null);
    let active = true;
    const timer = window.setTimeout(() => {
      void generateSeekbarThumbnails(selectedFilePath, durationRef.current)
        .then((sprite) => {
          if (active && sprite) setThumbSprite(sprite);
        })
        .catch(() => undefined);
    }, 320);
    return () => {
      active = false;
      window.clearTimeout(timer);
      void cancelSeekbarThumbnails();
    };
  }, [durationReady, seekbarThumbnails, selectedFilePath]);
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

  const clockClass = compact
    ? "num text-[10.5px] font-medium min-w-9 shrink-0"
    : "num text-[11.5px] font-medium min-w-12 shrink-0";

  return (
    <div className={`flex items-center w-full ${compact ? "gap-2" : "gap-3"}`}>
      <span className={`${clockClass} text-white/85 text-left`}>
        {formatClock(displayedPos)}
      </span>
      <Scrubber
        className="flex-1"
        ariaLabel="Playback position"
        value={displayedPos}
        min={0}
        max={Math.max(1, durationSecs)}
        highlightRange={introHighlight}
        hotspots={reactionHotspots}
        formatTooltip={(val) =>
          introHighlight && val >= introHighlight.start && val <= introHighlight.end
            ? `${formatClock(val)} · ${introHighlight.kind === "recap" ? "Recap" : "Intro"}`
            : formatClock(val)
        }
        renderPreview={
          !compact && thumbSprite
            ? (val) => {
                const inIntro = Boolean(
                  introHighlight && val >= introHighlight.start && val <= introHighlight.end,
                );
                const bucket =
                  !lowPowerMode && reactionsEnabled ? getReactionBucketAt(val) : null;
                return (
                  <div className="relative rounded-[10px] overflow-hidden bg-black/90 shadow-[0_12px_28px_-6px_rgba(0,0,0,0.82)]">
                    <div style={getThumbnailFrameStyle(thumbSprite, val)} />
                    {bucket && (
                      <div className="pointer-events-none absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-full bg-black/65 border border-white/15 text-[10px] font-semibold text-white num flex items-center gap-0.5">
                        <span>{bucket.topEmoji}</span>
                        <span>×{bucket.total}</span>
                      </div>
                    )}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />
                    <div className="pointer-events-none absolute inset-x-0 bottom-1.5 flex items-center justify-center gap-1.5 px-2 whitespace-nowrap">
                      {inIntro && (
                        <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.85)]" />
                      )}
                      <span className="text-[11px] font-semibold num text-white/95 tracking-tight drop-shadow-[0_1px_3px_rgba(0,0,0,0.95)]">
                        {inIntro
                          ? `${formatClock(val)} · ${introHighlight?.kind === "recap" ? "Recap" : "Intro"}`
                          : formatClock(val)}
                      </span>
                    </div>
                  </div>
                );
              }
            : undefined
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
        className={`${clockClass} text-white/60 enabled:hover:text-white/90 text-right enabled:cursor-pointer disabled:cursor-default transition-colors`}
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
  showLabel,
  compact = false,
}: {
  loaded: boolean;
  paused: boolean;
  showLabel: boolean;
  compact?: boolean;
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
  const resyncTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resyncTimerRef.current !== null) {
        window.clearTimeout(resyncTimerRef.current);
      }
    };
  }, []);

  const liveRoomPositionSecs = useSyncStore((s) => s.liveRoomPositionSecs);
  const effectiveUser = resolveEffectiveUsername(syncStatus, username);
  const health = computeRoomSyncHealth({
    syncStatus,
    participants,
    localUsername: effectiveUser,
    localLoaded: loaded,
    localPositionSecs: posFloored,
    roomPositionSecs: liveRoomPositionSecs,
    timelineOffsetSecs,
    timelineScale,
    timelineSegments,
  });

  const handleResync = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await syncForceResync();
      playSoundCue("resyncSnap", { moviePlaying: loaded && !paused });
      flashFeedback("Resynced with room");
    } catch (err) {
      pushNote("error", formatUserError(err, "Could not resync with room."));
    } finally {
      if (resyncTimerRef.current !== null) {
        window.clearTimeout(resyncTimerRef.current);
      }
      resyncTimerRef.current = window.setTimeout(() => {
        resyncTimerRef.current = null;
        setBusy(false);
      }, 450);
    }
  };

  const sizeClass = showLabel
    ? "h-7.5 w-auto pl-[7.5px] pr-2.5"
    : compact
      ? "h-7 w-7"
      : "h-7.5 w-7.5";

  return (
    <button
      type="button"
      disabled={busy || !loaded}
      onClick={() => void handleResync()}
      aria-label="Resync with room"
      title={
        !loaded
          ? "Load a video file first"
          : health.needsResync
            ? `Resync now (${health.statusLabel}${health.maxDriftSecs >= 2.0 ? ` · ${health.maxDriftSecs.toFixed(1)}s drift` : ""}) — snaps playback back in sync`
            : "Force instant resync with party timestamp"
      }
      className={`ep-bar-icon-btn relative ${sizeClass} rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium shrink-0 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
        health.needsResync
          ? "text-amber-300 hover:text-amber-200"
          : "text-secondary hover:text-white"
      }`}
    >
      <PlayerResyncIcon
        tone={health.needsResync ? "warn" : "ok"}
        size={15}
        className={`shrink-0 ${busy ? "animate-spin" : ""}`}
      />
      {health.needsResync && !showLabel && (
        <span
          aria-hidden="true"
          className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)]"
        />
      )}
      {showLabel && <span className="whitespace-nowrap">Resync</span>}
    </button>
  );
});

interface TransportBarProps {
  visible?: boolean;
  activeTab: CapsuleTab | null;
  chatOpen?: boolean;
  onToggleTab: (tab: CapsuleTab) => void;
  onToggleChat?: () => void;
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
  chatOpen = false,
  onToggleTab,
  onToggleChat,
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

  const setVolume = usePlayerStore((s) => s.setVolume);
  const [socialHover, setSocialHover] = useState<"chat" | "reactions" | null>(null);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);
  const localReady = useSyncStore((s) => s.localReady);
  const alignMode = useSyncStore((s) => s.alignMode);
  const timelineOffsetSecs = useSyncStore((s) => s.timelineOffsetSecs);
  const timelineScale = useSyncStore((s) => s.timelineScale);

  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const peerAvatars = useAppStore((s) => s.peerAvatars);
  const roomCode = useAppStore((s) => s.roomCode);
  const selectedFileName = useAppStore((s) => s.selectedFileName);
  const playerError = usePlayerStore((s) => s.playerError);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const reactionsEnabled = useAppStore((s) => s.reactionsEnabled);
  const chatTriggerPlacement = useAppStore((s) => s.chatTriggerPlacement);
  const fullWidthPlayBar = useAppStore((s) => s.fullWidthPlayBar);
  const openSettings = useAppStore((s) => s.openSettings);
  const unreadChatCount = useChatStore((s) => s.unreadCount);
  const chatTypingCount = useChatStore((s) => Object.keys(s.typingPeers).length);
  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const voiceJoined = useVoiceStore((s) => s.joined);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const voiceGateOpen = useVoiceStore((s) => s.localGateOpen);
  const voiceStreamStatus = useVoiceStore((s) => s.streamStatus);
  const voiceSpeakingPeers = useVoiceStore((s) => s.speakingPeers);
  const voiceRoster = useVoiceStore((s) => s.roster);
  const voicePeerOverrides = useVoiceStore((s) => s.peerOverrides);
  const voiceDuckingMode = useVoiceStore((s) => s.duckingMode);
  const { mismatch } = usePartyFileMismatch();

  const voiceCheckInput = {
    joined: voiceJoined,
    muted: voiceMuted,
    deafened: voiceDeafened,
    localGateOpen: voiceGateOpen,
    streamStatus: voiceStreamStatus,
    speakingPeers: voiceSpeakingPeers,
    roster: voiceRoster,
    peerOverrides: voicePeerOverrides,
  };
  const voicePeersInCall = voiceRoster.filter((r) => r.inVoice);
  const remoteSpeakingCount = voiceSpeakingPeers.filter(
    (s) =>
      s.trim().toLowerCase() !== resolveEffectiveUsername(syncStatus, username).trim().toLowerCase() &&
      !voicePeerOverrides[s.trim().toLowerCase()]?.muted,
  ).length;
  const duckingActive =
    Boolean(roomCode) &&
    voiceEnabled &&
    voiceJoined &&
    !voiceDeafened &&
    voiceDuckingMode !== "off" &&
    remoteSpeakingCount > 0 &&
    !muted &&
    volume > 0;

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

  const outerBarRef = useRef<HTMLDivElement | null>(null);
  const capsuleBarRef = useRef<HTMLDivElement | null>(null);
  const leftCellRef = useRef<HTMLDivElement | null>(null);
  const centerCellRef = useRef<HTMLDivElement | null>(null);
  const rightCellRef = useRef<HTMLDivElement | null>(null);
  const lastMeasuredWidthRef = useRef<number>(0);
  const [fitLevel, setFitLevel] = useState(0);
  const [baseLayout, setBaseLayout] = useState<PlayBarLayout>(() =>
    resolvePlayBarLayout(typeof window !== "undefined" ? window.innerWidth : 1024),
  );
  const barLayout = useMemo(
    () => applyPlayBarFitLevel(baseLayout, fitLevel),
    [baseLayout, fitLevel],
  );
  const layoutKey = getPlayBarLayoutKey(barLayout);

  useLayoutEffect(() => {
    const outerEl = outerBarRef.current;
    if (!outerEl) return;

    const syncStageMetrics = () => {
      const w = outerEl.clientWidth;
      if (w > 0) {
        const delta = w - lastMeasuredWidthRef.current;
        // Only reset fitLevel when expanding noticeably (or on first measure) so shrinking
        // during sidebar dock animation never flickers labels/avatars back on mid-flight.
        if (lastMeasuredWidthRef.current === 0 || delta > 24) {
          lastMeasuredWidthRef.current = w;
          setFitLevel(0);
        } else if (delta < -12) {
          lastMeasuredWidthRef.current = w;
        }
        const next = resolvePlayBarLayout(w);
        const nextKey = getPlayBarLayoutKey(next);
        setBaseLayout((prev) => (getPlayBarLayoutKey(prev) === nextKey ? prev : next));
      }
      const capsuleEl = capsuleBarRef.current;
      const stageEl = outerEl.closest<HTMLElement>('[data-stage-container="true"]');
      if (capsuleEl && stageEl) {
        const bottomGap = fullWidthPlayBar ? 12 : w < 430 ? 20 : w < 650 ? 22 : 28;
        stageEl.style.setProperty("--ep-playbar-clearance", `${capsuleEl.offsetHeight + bottomGap}px`);
      }
    };

    syncStageMetrics();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncStageMetrics) : null;
    ro?.observe(outerEl);
    if (capsuleBarRef.current) ro?.observe(capsuleBarRef.current);
    return () => {
      ro?.disconnect();
    };
  }, [fullWidthPlayBar, layoutKey]);

  // Step down density automatically only when left + center + right genuinely exceed the capsule's inner width.
  useLayoutEffect(() => {
    if (barLayout.isTwoRowControls || fitLevel >= 5) return;
    const capsuleEl = capsuleBarRef.current;
    const leftEl = leftCellRef.current;
    const centerEl = centerCellRef.current;
    const rightEl = rightCellRef.current;
    if (!capsuleEl || !leftEl || !centerEl || !rightEl) return;
    const cs = window.getComputedStyle(capsuleEl);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const innerW = capsuleEl.clientWidth - padX;
    const sideMax = Math.max(0, (innerW - centerEl.offsetWidth - 24) / 2);
    const leftTooWide = leftEl.scrollWidth > sideMax + 4;
    const rightTooWide = rightEl.scrollWidth > sideMax + 4;
    if (leftTooWide || rightTooWide) {
      setFitLevel((lvl) => Math.min(5, lvl + 1));
    }
  });

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
    layoutKey,
  ]);

  const centerDockRef = useRef<HTMLDivElement | null>(null);
  const centerBtnRefs = useRef<Partial<Record<TransportControlKey, HTMLButtonElement | null>>>({});
  const prevTransportKeyRef = useRef<TransportControlKey | null>(null);
  const [hoveredTransport, setHoveredTransport] = useState<TransportControlKey | null>(null);
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
    } else {
      const btn = centerBtnRefs.current[hoveredTransport];
      if (!btn) {
        setTransportLens((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      } else {
        const nextWidth = btn.offsetWidth;
        const nextHeight = btn.offsetHeight;
        const nextLeft = Math.round(btn.offsetLeft);
        const nextTop = Math.round(btn.offsetTop);
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
  }, [hoveredTransport, hasFolderEpisodes, playlistItems.length, layoutKey]);

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

  const isMini = barLayout.tier === "mini";
  const isCompactGap =
    barLayout.tier === "compact" || barLayout.tier === "stacked" || barLayout.tier === "mini";
  const iconBtnSize = isMini ? "h-7 w-7" : "h-7.5 w-7.5";
  const visiblePeers =
    barLayout.showPartyAvatarsInline && barLayout.maxVisibleAvatars > 0
      ? participants.slice(0, barLayout.maxVisibleAvatars)
      : [];
  const extraPeerCount = Math.max(0, participants.length - visiblePeers.length);
  const localHasFile = loaded && !playerError && Boolean(selectedFileName?.trim());
  const aligned = !isIdentityTransform({
    offsetSecs: timelineOffsetSecs,
    scale: timelineScale,
  });
  const scaleCalibrated = Math.abs(timelineScale - 1.0) > 0.001;
  const isExtended = activeTab !== null && activeTab !== "episodes" && Boolean(expandedDrawer);

  const outerPadClass = fullWidthPlayBar
    ? "px-0 pb-0 pt-2"
    : barLayout.tier === "mini"
      ? "px-2 pb-2 pt-1.5"
      : barLayout.tier === "stacked"
        ? "px-2.5 pb-2.5 pt-2"
        : barLayout.tier === "compact"
          ? "px-3 pb-3 pt-2"
          : "px-4 pb-4 pt-2";

  const capsuleClass = fullWidthPlayBar
    ? barLayout.tier === "mini"
      ? "ep-glass-bottom-bar w-full max-w-none rounded-none px-2.5 pt-2 pb-2.5"
      : barLayout.tier === "stacked"
        ? "ep-glass-bottom-bar w-full max-w-none rounded-none px-3 pt-2 pb-2.5"
        : "ep-glass-bottom-bar w-full max-w-none rounded-none px-4 sm:px-6 pt-2.5 pb-3"
    : barLayout.tier === "mini"
      ? "ep-glass-capsule w-full max-w-[1140px] rounded-[22px] px-2.5 py-2"
      : barLayout.tier === "stacked"
        ? "ep-glass-capsule w-full max-w-[1140px] rounded-[24px] px-3 py-2"
        : barLayout.tier === "compact"
          ? "ep-glass-capsule w-full max-w-[1140px] rounded-[26px] px-3 py-2.5"
          : "ep-glass-capsule w-full max-w-[1140px] rounded-[26px] px-4 py-2.5";

  const nudgeVolumeFromWheel = (deltaY: number) => {
    const step = deltaY < 0 ? 5 : -5;
    const base = muted ? 0 : volume;
    const next = Math.max(0, Math.min(130, Math.round(base + step)));
    if (next > 0 && muted) {
      setMutePlayback(false, { flash: false });
    }
    setVolume(next);
    throttledVol.call(next);
  };

  const partyControls = roomCode ? (
    <>
      <button
        type="button"
        disabled={!canToggleReady(loaded)}
        onClick={handleToggleReady}
        title={loaded ? "Toggle Ready status (R)" : "Load a local video first"}
        className={`ep-bar-icon-btn ${
          barLayout.showTextLabels ? "h-7.5 w-auto pl-[7.5px] pr-2.5" : iconBtnSize
        } rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium shrink-0 cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
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
          size={isMini ? 14 : 15}
          className="shrink-0 anim-icon-pop"
        />
        {barLayout.showTextLabels && (
          <span className="whitespace-nowrap">
            {localReady && loaded ? "Ready" : "Not Ready"}
          </span>
        )}
      </button>

      <ResyncButton
        loaded={loaded}
        paused={paused}
        showLabel={barLayout.showResyncLabel}
        compact={isMini}
      />

      <button
        type="button"
        data-capsule-anchor="room"
        onClick={() => onToggleTab("room")}
        aria-label="Watch Party room"
        aria-pressed={activeTab === "room"}
        title={
          mismatch
            ? `${mismatch.title} — Click to open Watch Party`
            : !voiceJoined && voicePeersInCall.length > 0
              ? `${voicePeersInCall.length} in voice chat — Click to join`
              : hideParticipants
                ? "Party lounge (profile icons hidden)"
                : "Friends watching together"
        }
        className={`ep-bar-pill ep-party-pill ${
          !hideParticipants && visiblePeers.length > 0
            ? "h-7.5 w-auto pl-[5px] pr-2.5 gap-2"
            : barLayout.showTextLabels
              ? "h-7.5 w-auto px-2.5 gap-1.5"
              : barLayout.showPartyChevron
                ? "h-7.5 w-auto px-2 gap-1.5"
                : iconBtnSize
        } rounded-full inline-flex items-center justify-center text-xs shrink-0 cursor-pointer ${
          activeTab === "room"
            ? "ep-droplet-indicator text-white font-semibold"
            : "text-secondary hover:text-white"
        }`}
      >
        {!hideParticipants && visiblePeers.length > 0 ? (
          <>
            <span className="flex items-center gap-1.5">
              {visiblePeers.map((p) => {
                const isSelf =
                  p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase();
                const badge = formatParticipantMatchBadge(p, {
                  localHasFile,
                  isSelf,
                  aligned,
                  scaleCalibrated,
                });
                const peerSpeaking = isParticipantSpeaking(
                  p.username,
                  effectiveUsername,
                  voiceCheckInput,
                );
                const presenceStatus = badge.isMismatch
                  ? "mismatch"
                  : p.isReady
                    ? "none"
                    : "notReady";
                return (
                  <PresenceAvatar
                    key={p.username}
                    avatarId={resolvePeerAvatarId(
                      p.username,
                      effectiveUsername,
                      avatarId,
                      peerAvatars,
                    )}
                    size={18}
                    speaking={peerSpeaking}
                    status={presenceStatus}
                    title={`${p.username}${peerSpeaking ? " · Speaking" : p.isReady ? " · Ready" : " · Not Ready"}${
                      badge.isMismatch ? ` · ${badge.text}` : ""
                    }`}
                  />
                );
              })}
            </span>
            {extraPeerCount > 0 && (
              <span className="text-[11px] text-white/80 font-medium leading-none num shrink-0">
                +{extraPeerCount}
              </span>
            )}
            {voiceEnabled && !voiceJoined && voicePeersInCall.length > 0 && (
              <AppVoiceIcon
                active
                size={13}
                className={remoteSpeakingCount > 0 ? "text-ok shrink-0" : "text-accent-soft shrink-0"}
              />
            )}
            {mismatch && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-warn shrink-0"
                aria-hidden="true"
              />
            )}
            {barLayout.showPartyChevron && (
              <PlayerPartyChevronIcon
                open={activeTab === "room"}
                size={11}
                className="shrink-0 opacity-80"
              />
            )}
          </>
        ) : (
          <>
            <WatchPartyIcon bare size={isMini ? 14 : 15} className="shrink-0" />
            {!hideParticipants && barLayout.showTextLabels && (
              <span className="text-[11px]">Party</span>
            )}
            {mismatch && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-warn shrink-0"
                aria-hidden="true"
              />
            )}
            {barLayout.showPartyChevron && (
              <PlayerPartyChevronIcon
                open={activeTab === "room"}
                size={11}
                className="shrink-0 opacity-80"
              />
            )}
          </>
        )}
      </button>

      {voiceEnabled && voiceJoined && !isMini && (
        <VoiceMicDeafenPills
          variant="bare"
          muted={voiceMuted}
          deafened={voiceDeafened}
          speaking={isLocalVoiceSpeaking(voiceCheckInput)}
          captureHealthy={isCaptureHealthy(voiceStreamStatus)}
          size="lg"
          showDeafen={false}
        />
      )}

      {(chatTriggerPlacement === "playbar" || reactionsEnabled) && (() => {
        const showChat = chatTriggerPlacement === "playbar";
        const showReactions = reactionsEnabled;
        const circleDim = isMini ? "h-7 w-7" : "h-7.5 w-7.5";
        const hasVoiceActivity =
          voiceEnabled && (voiceJoined || voicePeersInCall.length > 0) && !chatOpen;
        return (
          <div className="inline-flex items-center gap-1.5 shrink-0">
            {showChat && (
              <button
                type="button"
                data-capsule-anchor="chat"
                aria-pressed={chatOpen}
                onClick={() => onToggleChat?.()}
                onMouseEnter={() => setSocialHover("chat")}
                onMouseLeave={() => setSocialHover((cur) => (cur === "chat" ? null : cur))}
                aria-label="Party Lounge (Chat & Voice)"
                title="Party Lounge (C)"
                className={`ep-bar-icon-btn ep-social-bare-btn ep-press relative ${circleDim} rounded-full inline-flex items-center justify-center shrink-0 cursor-pointer ${
                  chatOpen || socialHover === "chat"
                    ? "text-white"
                    : "text-white/85 hover:text-white"
                }`}
              >
                <PlayerChatIcon
                  active={chatOpen || socialHover === "chat"}
                  size={isMini ? 15 : 17}
                  className="shrink-0"
                />
                {unreadChatCount > 0 && !chatOpen ? (
                  <span className="anim-pop-in absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 rounded-full bg-accent text-[9px] font-semibold text-white flex items-center justify-center ring-1 ring-black/40 num leading-none z-10">
                    {unreadChatCount > 9 ? "9+" : unreadChatCount}
                  </span>
                ) : chatTypingCount > 0 && !chatOpen ? (
                  <svg
                    aria-hidden="true"
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    shapeRendering="geometricPrecision"
                    className="pointer-events-none absolute top-[3px] right-[3px] h-2 w-2 shrink-0 animate-pulse z-10"
                  >
                    <circle
                      cx="4"
                      cy="4"
                      r="2.65"
                      fill="var(--color-accent-soft)"
                      stroke="rgba(6, 6, 10, 0.72)"
                      strokeWidth="1.2"
                    />
                  </svg>
                ) : hasVoiceActivity && !chatOpen ? (
                  <svg
                    aria-hidden="true"
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    shapeRendering="geometricPrecision"
                    className="pointer-events-none absolute top-[3px] right-[3px] h-2 w-2 shrink-0 z-10"
                  >
                    <circle
                      cx="4"
                      cy="4"
                      r="2.65"
                      fill={
                        remoteSpeakingCount > 0
                          ? "var(--color-ok)"
                          : "var(--color-accent-soft)"
                      }
                      stroke="rgba(6, 6, 10, 0.72)"
                      strokeWidth="1.2"
                    />
                  </svg>
                ) : null}
              </button>
            )}

            {showReactions && (
              <button
                type="button"
                data-capsule-anchor="reactions"
                aria-pressed={activeTab === "reactions"}
                onClick={() => onToggleTab("reactions")}
                onMouseEnter={() => setSocialHover("reactions")}
                onMouseLeave={() => setSocialHover((cur) => (cur === "reactions" ? null : cur))}
                aria-label="Live party reactions"
                title="Live party reactions (E, or keys 1–7)"
                className={`ep-bar-icon-btn ep-press ep-reaction-icon-btn ${circleDim} rounded-full inline-flex items-center justify-center shrink-0 cursor-pointer`}
              >
                <PlayerReactionsIcon
                  active={activeTab === "reactions" || socialHover === "reactions"}
                  size={isMini ? 16 : 18}
                  className="shrink-0 block"
                />
              </button>
            )}
          </div>
        );
      })()}
    </>
  ) : (
    <button
      type="button"
      data-capsule-anchor="room"
      onClick={() => onToggleTab("room")}
      aria-label="Open party lounge"
      aria-pressed={activeTab === "room"}
      title="Start or join a Watch Party"
      className={`ep-bar-pill ep-party-pill ${
        barLayout.showTextLabels ? "h-7.5 w-auto pl-[7px] pr-3" : iconBtnSize
      } rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium cursor-pointer shrink-0 ${
        activeTab === "room"
          ? "ep-droplet-indicator text-white font-semibold"
          : "text-secondary hover:text-white"
      }`}
    >
      <WatchPartyIcon bare size={isMini ? 14 : 16} className="shrink-0" />
      {barLayout.showTextLabels && <span className="whitespace-nowrap">Watch Party</span>}
    </button>
  );

  const volumeControl = (
    <div
      className={`group/vol relative flex items-center gap-1 shrink-0 ${
        barLayout.volumeSliderWidth !== "none" ? "pl-0.5" : ""
      }`}
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > 0) {
          nudgeVolumeFromWheel(e.deltaY);
        }
      }}
    >
      {barLayout.volumeSliderWidth === "none" && (
        <div className="pointer-events-none opacity-0 translate-y-1 group-hover/vol:pointer-events-auto group-hover/vol:opacity-100 group-hover/vol:translate-y-0 group-focus-within/vol:pointer-events-auto group-focus-within/vol:opacity-100 group-focus-within/vol:translate-y-0 transition-all duration-150 absolute bottom-full left-1/2 -translate-x-1/2 pb-2 z-40">
          <div className="ep-glass-submenu rounded-full px-3 py-2 flex items-center gap-2 shadow-lg">
            <div className="w-24 shrink-0">
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
            <span className="text-[10.5px] font-medium text-secondary num w-8 text-right shrink-0">
              {muted ? 0 : Math.round(volume)}%
            </span>
          </div>
        </div>
      )}
      <GlassHoverTip
        label="Auto-ducking movie"
        detail="Lowering volume while friends speak"
        accent="admin"
        disabled={!duckingActive}
      >
        <button
          type="button"
          onClick={() => toggleMutePlayback()}
          aria-label={muted ? "Unmute" : "Mute"}
          data-muted={muted || volume === 0 ? "true" : "false"}
          className={`ep-bar-icon-btn ep-vol-btn relative ${iconBtnSize} rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer shrink-0`}
          title={
            duckingActive
              ? undefined
              : barLayout.volumeSliderWidth === "none"
                ? `Mute (M) · Volume ${muted ? 0 : Math.round(volume)}% (scroll wheel or open Audio menu to adjust)`
                : "Mute (M)"
          }
        >
          <PlayerVolumeIcon
            muted={muted || volume === 0}
            size={isMini ? 16 : 18}
          />
          {duckingActive && (
            <svg
              aria-hidden="true"
              width="8"
              height="8"
              viewBox="0 0 8 8"
              shapeRendering="geometricPrecision"
              className="anim-pop-in pointer-events-none absolute top-[3px] right-[3px] h-2 w-2 shrink-0"
            >
              <circle
                cx="4"
                cy="4"
                r="2.65"
                fill="var(--color-accent-soft)"
                stroke="rgba(6, 6, 10, 0.72)"
                strokeWidth="1.2"
              />
            </svg>
          )}
        </button>
      </GlassHoverTip>
      {barLayout.volumeSliderWidth !== "none" && (
        <div
          className={`${VOLUME_WIDTH_CLASSES[barLayout.volumeSliderWidth]} shrink-0 transition-[width] duration-200 ease-[var(--ease-glass)]`}
        >
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
      )}
    </div>
  );

  const skipEpSize = isMini ? "h-7 w-7" : "h-8 w-8";
  const seekBtnSize = isMini ? "h-8.5 w-8.5" : "h-9 w-9";
  const playOrbSize = isMini ? "h-9.5 w-9.5" : "h-10.5 w-10.5";

  const transportCluster = (
    <div
      ref={centerDockRef}
      onMouseLeave={() => {
        setHoveredTransport(null);
        setTransportPressed(false);
      }}
      onPointerUp={() => setTransportPressed(false)}
      onPointerCancel={() => setTransportPressed(false)}
      className={`relative flex items-center shrink-0 justify-self-center ${
        isMini
          ? "gap-1"
          : barLayout.tier === "compact"
            ? "gap-1"
            : "gap-1.5 sm:gap-2"
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 left-0 z-0 ${
          transportLens.animateSlide
            ? "transition-[transform,width,height] duration-[240ms] ease-[var(--spring-soft)]"
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
          className={`ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 ${skipEpSize} ${
            isMini ? "" : "mr-0.5"
          } rounded-full flex items-center justify-center text-white/62 hover:text-white disabled:opacity-30 disabled:pointer-events-none cursor-pointer`}
        >
          <PlayerSkipEpisodeIcon direction="prev" size={isMini ? 16 : 18} />
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
        className={`ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 ${seekBtnSize} rounded-full flex items-center justify-center text-white/84 hover:text-white disabled:opacity-35 disabled:pointer-events-none cursor-pointer`}
      >
        <PlayerSeekIcon direction="back" size={isMini ? 21 : 24} />
      </button>

      <button
        type="button"
        disabled={!loaded || ctrlLock.lockedForLocalUser}
        onMouseEnter={() => {
          setHoveredTransport(null);
          setTransportPressed(false);
        }}
        onClick={handlePlayPause}
        aria-label={paused ? "Play" : "Pause"}
        title={
          !loaded
            ? "Choose a video file to start"
            : ctrlLock.lockedForLocalUser
              ? formatControllerLockReason(ctrlLock)
              : paused && playBlock.message
                ? playBlock.message
                : paused
                  ? "Play (Space)"
                  : "Pause (Space)"
        }
        className={`ep-orb-play relative z-10 ${playOrbSize} rounded-full flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer`}
      >
        {paused ? (
          <PlayerPlayIcon key="play" size={isMini ? 21 : 24} className="relative z-10 anim-icon-pop" />
        ) : (
          <PlayerPauseIcon key="pause" size={isMini ? 21 : 24} className="relative z-10 anim-icon-pop" />
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
        className={`ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 ${seekBtnSize} rounded-full flex items-center justify-center text-white/84 hover:text-white disabled:opacity-35 disabled:pointer-events-none cursor-pointer`}
      >
        <PlayerSeekIcon direction="forward" size={isMini ? 21 : 24} />
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
          className={`ep-bar-icon-btn ep-transport-btn ep-transport-bubble relative z-10 ${skipEpSize} ${
            isMini ? "" : "ml-0.5"
          } rounded-full flex items-center justify-center text-white/62 hover:text-white disabled:opacity-30 disabled:pointer-events-none cursor-pointer`}
        >
          <PlayerSkipEpisodeIcon direction="next" size={isMini ? 16 : 18} />
        </button>
      )}
    </div>
  );

  const mediaItems = (
    <>
      <button
        type="button"
        onClick={onChooseFile}
        aria-label="Open video file"
        title="Open video file(s)"
        className={`ep-bar-icon-btn ${iconBtnSize} rounded-full inline-flex items-center justify-center text-xs text-secondary hover:text-white shrink-0 cursor-pointer`}
      >
        <OpenMediaIcon bare size={isMini ? 14 : 16} className="shrink-0" />
      </button>

      <div
        ref={rightDockRef}
        className={`relative inline-flex items-center shrink-0 ${
          isCompactGap ? "gap-0.5" : "gap-1"
        }`}
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
            className={`relative z-10 ${
              barLayout.showTextLabels ? "h-7.5 w-auto pl-1.5 pr-2.5 max-w-[140px]" : iconBtnSize
            } rounded-full inline-flex items-center justify-center gap-1.5 text-xs min-w-0 shrink-0 cursor-pointer ${
              activeTab === "episodes"
                ? "ep-press border border-transparent text-white font-semibold"
                : "ep-bar-icon-btn text-secondary hover:text-white"
            }`}
          >
            <PlayerEpisodesIcon
              active={activeTab === "episodes"}
              size={isMini ? 16 : 18}
              className="shrink-0"
            />
            {barLayout.showTextLabels && (
              <span className="truncate num">
                {activePlaylistItem?.episodeBadge ||
                  (playlistItems.length > 1 ? `Episodes (${playlistItems.length})` : "Episodes")}
              </span>
            )}
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
          className={`relative z-10 ${
            barLayout.showTextLabels ? "h-7.5 w-auto pl-1.5 pr-2.5" : iconBtnSize
          } rounded-full inline-flex items-center justify-center gap-1.5 text-xs shrink-0 cursor-pointer ${
            activeTab === "subtitles"
              ? "ep-press border border-transparent text-white font-semibold"
              : "ep-bar-icon-btn text-secondary hover:text-white"
          }`}
        >
          <PlayerCaptionsIcon
            active={activeTab === "subtitles"}
            size={isMini ? 16 : 18}
            className="shrink-0"
          />
          {barLayout.showTextLabels && <span>CC</span>}
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
          className={`relative z-10 ${
            barLayout.showTextLabels ? "h-7.5 w-auto pl-1.5 pr-2.5" : iconBtnSize
          } rounded-full inline-flex items-center justify-center gap-1.5 text-xs shrink-0 cursor-pointer ${
            activeTab === "playback"
              ? "ep-press border border-transparent text-white font-semibold"
              : "ep-bar-icon-btn text-secondary hover:text-white"
          }`}
        >
          <PlayerAudioIcon
            active={activeTab === "playback"}
            size={isMini ? 16 : 18}
            className="shrink-0"
          />
          {barLayout.showTextLabels && <span>Audio</span>}
        </button>
      </div>

      <button
        type="button"
        onClick={() => openSettings("prefs")}
        aria-label="Preferences"
        title="Preferences"
        className={`ep-bar-icon-btn ${iconBtnSize} rounded-full flex items-center justify-center shrink-0 text-muted hover:text-white cursor-pointer`}
      >
        <PlayerSettingsIcon size={isMini ? 16 : 18} />
      </button>

      <button
        type="button"
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        title="Fullscreen (F / Enter)"
        className={`ep-bar-icon-btn ${iconBtnSize} rounded-full flex items-center justify-center shrink-0 text-secondary hover:text-white cursor-pointer`}
      >
        <PlayerFullscreenIcon
          key={isFullscreen ? "min" : "max"}
          isFullscreen={isFullscreen}
          size={isMini ? 16 : 18}
          className="anim-icon-pop"
        />
      </button>
    </>
  );

  return (
    <div
      ref={outerBarRef}
      aria-hidden={!visible}
      className={`w-full flex flex-col items-center gap-2 select-none pointer-events-none ep-chrome-transition origin-bottom ${outerPadClass} ${
        visible
          ? "opacity-100 translate-y-0 scale-100"
          : fullWidthPlayBar
            ? "opacity-0 translate-y-full"
            : "opacity-0 translate-y-5 scale-[0.982]"
      }`}
    >
      {activeTab === null &&
        loaded &&
        paused &&
        playBlock.blocked && (
          <span
            data-glass-region="true"
            className="ep-glass-pill anim-pop-in px-3 py-1 text-[11px] font-medium text-warn rounded-full whitespace-nowrap"
          >
            {formatWaitingForNotReadyPill(playBlock.notReadyUsernames)}
          </span>
        )}

      <div
        ref={capsuleBarRef}
        data-glass-region="true"
        data-capsule-bar="true"
        data-bar-tier={barLayout.tier}
        data-bar-style={fullWidthPlayBar ? "full-width" : "floating"}
        onMouseEnter={() => onBarHoverChange?.(true)}
        onMouseLeave={() => onBarHoverChange?.(false)}
        className={`${capsuleClass} ${isMini ? "space-y-1.5" : "space-y-2"} ${
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
          <PlaybackScrubber locked={ctrlLock.lockedForLocalUser} compact={isMini} />
        </div>

        {/* Controls rows adapt cleanly to measured stage container width */}
        {barLayout.tier === "mini" ? (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <div className="flex items-center justify-center">
              <div ref={centerCellRef} className="shrink-0">
              {transportCluster}
            </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 w-full min-w-0">
              <div className="inline-flex items-center gap-0.5 shrink-0">
                {partyControls}
              </div>
              <div className="inline-flex flex-wrap items-center justify-center gap-0.5 max-w-full">
                {volumeControl}
                {mediaItems}
              </div>
            </div>
          </div>
        ) : barLayout.isTwoRowControls ? (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <div className="flex items-center justify-center">
              <div ref={centerCellRef} className="shrink-0">
              {transportCluster}
            </div>
            </div>
            <div className="flex items-center justify-between gap-2 w-full min-w-0">
              <div className="flex items-center gap-0.5 min-w-0">
                <div className="flex items-center gap-0.5 shrink-0">
                  {partyControls}
                </div>
                {volumeControl}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                {mediaItems}
              </div>
            </div>
          </div>
        ) : (
          <div
            className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center pt-0.5 ${
              barLayout.tier === "compact" ? "gap-1.5" : "gap-2 lg:gap-3"
            }`}
          >
            <div
              ref={leftCellRef}
              className={`flex items-center min-w-0 max-w-full overflow-x-clip overflow-y-visible justify-self-start ${
                isCompactGap ? "gap-0.5" : "gap-1.5"
              }`}
            >
              {partyControls}
              {volumeControl}
            </div>

            <div ref={centerCellRef} className="shrink-0">
              {transportCluster}
            </div>

            <div
              ref={rightCellRef}
              className={`flex items-center min-w-0 max-w-full overflow-x-clip overflow-y-visible justify-self-end ${
                isCompactGap ? "gap-0.5" : "gap-1"
              }`}
            >
              {mediaItems}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
