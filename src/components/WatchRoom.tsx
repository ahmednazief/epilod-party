import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppChevronIcon,
  AppDownloadIcon,
  AppFolderIcon,
  AppKeyboardIcon,
  AppMicIcon,
  AppRepeatIcon,
  AppSeasonFolderIcon,
  AppSparkleIcon,
} from "./ui/AppIcons";
import { OpenMediaIcon, WatchPartyIcon } from "./ui/LobbyIcons";
import {
  MenuAddFileIcon,
  MenuAspectFrameIcon,
  MenuAutoNextIcon,
  MenuPlayBarLayoutIcon,
  MenuScreenIcon,
  MenuSpeedIcon,
  MenuSubtitlesOffIcon,
} from "./ui/MenuIcons";
import {
  PartyAlignSceneIcon,
  PartyCopyIcon,
  PartyCreateIcon,
  PartyLeaveIcon,
  PartyViewersIcon,
  PlayerAudioIcon,
  PlayerCaptionsIcon,
  PlayerChatIcon,
  PlayerEpisodesIcon,
  PlayerFollowIcon,
  PlayerFullscreenIcon,
  PlayerPauseIcon,
  PlayerPlayIcon,
  PlayerReactionsIcon,
  PlayerReadyIcon,
  PlayerSkipIntroIcon,
  PlayerResyncIcon,
  PlayerSeekCueIcon,
  PlayerSettingsIcon,
  PlayerSkipEpisodeIcon,
  PlayerVolumeIcon,
} from "./ui/PlayerIcons";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePartyFileMismatch } from "../hooks/usePartyFileMismatch";
import { checkLocalFilesExist, type LocalMatchCandidate } from "../lib/localLibrary";
import { usePlayerShortcuts } from "../hooks/usePlayerShortcuts";
import {
  canTriggerAutoNextOnEof,
  resolveEpisodeLoadSyncPlan,
  resolveFollowPartyEpisode,
  type EpisodeLoadTrigger,
  type RecentEpisodeSwitch,
} from "../lib/autoNext";
import { isDesktop, safeInvoke } from "../lib/bridge";
import { formatUserError } from "../lib/errors";
import { getFileDisplayName, splitDroppedFiles } from "../lib/fileDrop";
import { OPEN_FILE_EVENT } from "../lib/openFile";
import { buildRatingKey, onSyncRatingVote } from "../lib/ratings";
import { resolveFullscreenChromeState } from "../lib/fullscreenUi";
import { logFrontendEvent } from "../lib/logger";
import {
  captureCleanFrozenFrame,
  enqueueMpvLifecycle,
  getLastCleanFreezeFrame,
  isMpvNotRunningError,
  mpvAddSubtitle,
  mpvGetSurfaceState,
  mpvLoad,
  mpvResize,
  mpvSeek,
  mpvSetAudioTrack,
  mpvSetDialogueBoost,
  mpvSetPause,
  mpvSetSecondarySubTrack,
  mpvSetSpeed,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetVisible,
  mpvShowOsdText,
  mpvStart,
  mpvStop,
  onMpvCommandWarning,
  onMpvDuration,
  onMpvEnded,
  onMpvError,
  onMpvFileLoaded,
  onMpvPaused,
  onMpvSurfaceClick,
  onMpvSurfaceDblClick,
  onMpvSurfaceState,
  detectEmbeddedSubtitleLanguages,
  detectVideoIntro,
  introCancelDetect,
  type DetectedSubtitleLang,
  onMpvChapters,
  onMpvSeekSettled,
  onMpvTime,
  onMpvTracks,
  onAutoSyncProgress,
  onWindowFullscreen,
  onWindowRestored,
  safeMpvCall,
  setAllowNetworkShares,
  subscribeMpvRuntimeLost,
  mpvSetLoop,
  mpvSetAspectMode,
  mpvSetVideoMarginLeft,
  mpvSetVideoMarginRight,
  mpvSetMute,
  mpvSetSubTrack,
  mpvSetVolume,
  subtitleAutoFetchOnline,
  subtitleCancelAutoSync,
  type AspectMode,
  windowIsFullscreen,
  windowSetFullscreen,
} from "../lib/mpv";
import { classifyMpvEnd } from "../lib/playbackEnd";
import {
  autoEnableEmbeddedSubtitle,
  detectAndSyncLoopWrap,
  ensureSubtitlesOn,
  handleLoopPlaybackAtEof,
  handlePeerDisconnected,
  resetAutoSubtitleState,
  runWithHiddenMpvSurface,
  seekPlaybackRelative,
  seekPlaybackTo,
  selectAudioTrackOption,
  SyncDisconnectTracker,
  toggleLoopPlayback,
  toggleMutePlayback,
  togglePlayback,
  toggleReadyStatus,
  toggleSubtitlesVisibility,
} from "../lib/playerActions";
import { checkDropDuringDialog, handlePlayerCrashSync } from "../lib/playerLifecycle";
import { resetMpvPlaybackDefaults } from "../lib/playbackReset";
import {
  formatDisplayMediaTitle,
  matchPeerEpisodeInPlaylist,
  naturalCompare,
  scanMediaPaths,
  type PlaylistItem,
} from "../lib/playlist";
import { isTextEntryElement } from "../lib/shortcuts";
import {
  nextClientSeekSeq,
  resetSharedRelativeSeek,
  shouldAcceptMpvTimeEvent,
} from "../lib/seekCoalesce";
import {
  executeSkipIntro,
  findActiveIntroAt,
  findSkippableIntroAt,
} from "../lib/introActions";
import {
  formatControlNoticeMessage,
  formatControllerLockReason,
  formatControllerOverrideNotice,
  getControllerLockState,
  resolveEffectiveUsername,
} from "../lib/syncController";
import { shouldAnnounceFile } from "../lib/syncFileAnnounce";
import {
  formatPeerNotReadyNotice,
  formatPlayBlockedByNotReadyMessage,
  formatPlayBlockedFeedback,
  getNotReadyPeers,
  getPlayBlockState,
  NOT_READY_TAG_PREFIX,
  PLAY_BLOCKED_TAG,
  peerDisconnectedTag,
  peerNotReadyTag,
  shouldAutoReadyOnFileLoad,
} from "../lib/syncReady";
import { shouldResetSpeedForSync, canChangePlaybackSpeed } from "../lib/syncSpeedGuard";
import {
  buildAudioTrackOptions,
  buildSubTrackOptions,
  buildUntaggedSubtitleProbeList,
  formatSubtitleTrackDisplay,
  normalizeSubtitleLang,
  selectSubTrack,
} from "../lib/tracks";
import {
  buildAlignmentPairKey,
  formatSignedOffset,
  isIdentityTransform,
  loadSavedSourceAlignment,
  saveSourceAlignment,
} from "../lib/sourceAlignment";
import { playSoundCue, RoomSoundTracker } from "../lib/soundEffects";
import {
  enqueueSyncLifecycle,
  onSyncControlNotice,
  onSyncError,
  onSyncParticipants,
  onSyncAutoAligned,
  onSyncP2pStatus,
  onSyncPeerLeft,
  onSyncPeerNotReady,
  onSyncPeerSeek,
  onSyncPlayBlocked,
  onSyncReaction,
  onSyncChat,
  onSyncChatEdit,
  onSyncChatReact,
  onSyncChatTyping,
  onSyncSubtitleShared,
  onSyncRoomControl,
  onSyncRoomRerolled,
  onSyncRoomState,
  onSyncServerOverride,
  onSyncStatus,
  onSyncTimelineSegments,
  onSyncTimelineTransform,
  syncConnect,
  syncDisconnect,
  syncForceResync,
  syncSetFile,
  syncSetReady,
  syncSetTimelineTransform,
  syncSwitchBackup,
  syncUserPause,
  syncUserPlay,
  syncUserSeek,
} from "../lib/syncplay";
import { isCloudEndpoint, SYNCPLAY_ENDPOINT } from "../lib/syncStatusDisplay";
import {
  applyTimelineTransform,
  captureSceneAnchor,
  findAlignmentTargetPeer,
  setSceneAlignMode,
} from "../lib/timelineActions";
import { measurePhysicalRect, useViewportRect } from "../lib/useViewportRect";
import { ViewportSyncTracker } from "../lib/viewportSync";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import {
  useAnimatedPresence,
  usePresencePayload,
} from "../lib/useAnimatedPresence";
import {
  buildMediaFileKey,
  formatResumeClock,
  RESUME_COMPLETE_RATIO,
  RESUME_MIN_SECS,
} from "../lib/resume";
import {
  deriveSeriesKeyForFile,
  getSeriesTrackPref,
  pickMatchingAudioTrack,
  pickMatchingSubTrack,
  saveSeriesTrackPref,
} from "../lib/seriesTrackPrefs";
import { applySharedRoomSubtitle } from "../lib/sharedSubtitleActions";
import { getPerFileSubtitlePref } from "../lib/subtitlePrefs";
import {
  buildEpisodeKey,
  buildSeriesKey,
  extractParentFolderPath,
  pickInitialSeriesIndex,
} from "../lib/seriesProgress";
import { usePlayerStore } from "../store/usePlayerStore";
import { buildRecentRoomId, useRecentRoomsStore } from "../store/useRecentRoomsStore";
import { useResumeStore } from "../store/useResumeStore";
import { useSeriesProgressStore } from "../store/useSeriesProgressStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useRatingStore } from "../store/useRatingStore";
import {
  buildIntroSegmentKey,
  getEffectiveIntroSegments,
  normalizeIntroVideoKey,
  useIntroStore,
} from "../store/useIntroStore";
import {
  buildSubStyleParams,
  hasMatchingSubtitleTrack,
  useSubtitleStore,
} from "../store/useSubtitleStore";
import { enqueueReactionBurst } from "../store/useReactionStore";
import { useChatStore } from "../store/useChatStore";
import { useSyncStore } from "../store/useSyncStore";
import { useVoiceStore } from "../store/useVoiceStore";
import {
  onVoiceDevicesChanged,
  onVoiceLevel,
  onVoiceLocalState,
  onVoiceRoster,
  onVoiceSpeaking,
  onVoiceStatus,
  voiceListDevices,
  voiceSetConfig,
  voiceSetMoviePlaying,
} from "../lib/voice";
import {
  diffVoiceRosterPeers,
  joinVoiceSession,
  VOICE_HEALTH_NOTE_TAG,
  VOICE_PEER_BLOCKED_NOTE_TAG,
} from "../lib/voiceActions";
import { StageSpeakerOverlay } from "./ui/StageSpeakerOverlay";
import { computeMpvMarginRatios, resolveDualSidebarLayout } from "../lib/partyLayout";
import { getActiveShowcaseConfig } from "../lib/showcaseMode";
import { ChatSidebar } from "./ChatSidebar";
import { EpisodesPanel } from "./EpisodesPanel";
import { PartySidebar } from "./PartySidebar";
import { FloatingChatPeeks } from "./FloatingChatPeeks";
import { FloatingReactionsOverlay } from "./FloatingReactionsOverlay";
import { SkipIntroOverlay } from "./SkipIntroOverlay";
import { NextEpisodeOverlay } from "./NextEpisodeOverlay";
import { RatingOverlay } from "./RatingOverlay";
import { FileMismatchBanner } from "./FileMismatchBanner";
import { formatRoomCodeDisplay } from "./HomeScreen";
import { FrozenVideoFrame } from "./FrozenVideoFrame";
import { PlaybackPanel } from "./PlaybackPanel";
import { ReactionPopover } from "./ReactionPopover";
import { RoomPanel } from "./RoomPanel";
import { SubtitlePanel } from "./SubtitlePanel";

const SettingsModal = lazy(() =>
  import("./SettingsModal").then((m) => ({ default: m.SettingsModal })),
);
const ShortcutsModal = lazy(() =>
  import("./ShortcutsModal").then((m) => ({ default: m.ShortcutsModal })),
);
import { TitleBar } from "./TitleBar";
import { formatClock, TransportBar, type CapsuleTab } from "./TransportBar";
import { VideoGlassBackdrop } from "./VideoGlassBackdrop";
import { ViewportPlaceholder } from "./ViewportPlaceholder";
import { ContextMenu, type ContextMenuEntry } from "./ui/ContextMenu";
import { NotificationStrip } from "./ui/NotificationStrip";
import { StatusDot } from "./ui/StatusDot";

type SideTab = CapsuleTab;

interface CapsulePopoverLayout {
  left: number;
  bottom: number;
  width: number;
}

/**
 * Anchors play bar menus (Watch Party, Episodes, CC, Audio) centered directly above
 * their trigger button and clamped inside the play bar's horizontal footprint.
 */
function computeCapsulePopoverLayout(tab: SideTab): CapsulePopoverLayout {
  const winW = window.innerWidth;
  const maxWidth =
    tab === "room"
      ? 352
      : tab === "episodes"
        ? 344
        : tab === "reactions"
          ? 368
          : 356;
  const barEl = document.querySelector<HTMLElement>('[data-capsule-bar="true"]');
  const anchorEl = document.querySelector<HTMLElement>(`[data-capsule-anchor="${tab}"]`);

  const barRect = barEl?.getBoundingClientRect();
  const isFullWidth = barEl?.dataset.barStyle === "full-width";
  const barHeight = barEl ? Math.max(barEl.offsetHeight, barRect?.height ?? 0) : isFullWidth ? 88 : 104;
  // Anchor popovers cleanly above either the floating capsule (16px inset + 18px gap) or docked full-width bar (12px gap).
  const restingBottomGap = isFullWidth ? 0 : 16;
  const popoverGap = isFullWidth ? 12 : 18;
  const barTopDist = Math.max(
    barHeight + restingBottomGap,
    barRect && barRect.height > 0 ? window.innerHeight - barRect.top : 0,
  );
  const minBottom = isFullWidth ? barHeight + 12 : 136;
  const bottom = Math.max(minBottom, Math.round(barTopDist + popoverGap));

  const minLeft = barRect && barRect.width > 0 ? Math.max(8, Math.round(barRect.left)) : 12;
  const maxRight =
    barRect && barRect.width > 0 ? Math.min(winW - 8, Math.round(barRect.right)) : winW - 12;
  const stageAvailableW = Math.max(200, maxRight - minLeft);
  const width = Math.min(maxWidth, Math.min(Math.max(200, winW - 16), stageAvailableW));
  const maxLeft = Math.max(minLeft, maxRight - width);

  const btnRect = anchorEl?.getBoundingClientRect();
  const desiredLeft =
    btnRect && btnRect.width > 0
      ? btnRect.left + btnRect.width / 2 - width / 2
      : (minLeft + maxRight) / 2 - width / 2;

  return {
    left: Math.round(Math.max(minLeft, Math.min(desiredLeft, maxLeft))),
    bottom,
    width,
  };
}

const AlignModePill = memo(function AlignModePill({
  timelineScale,
}: {
  timelineScale: number;
}) {
  const positionSecs = usePlayerStore((s) => s.positionSecs);
  const liveRoomPositionSecs = useSyncStore((s) => s.liveRoomPositionSecs);

  return (
    <div
      data-glass-region="true"
      className="pointer-events-auto ep-glass-pill anim-pop-in px-3 py-1.5 rounded-full flex items-center gap-2.5 text-[11.5px]"
    >
      <span className="text-secondary whitespace-nowrap">
        Aligning locally · Friend{" "}
        <span className="num text-white font-medium">{formatClock(liveRoomPositionSecs)}</span>{" "}
        · Yours{" "}
        <span className="num text-accent-soft font-medium">{formatClock(positionSecs)}</span>
      </span>
      <button
        type="button"
        onClick={() => void captureSceneAnchor()}
        className="ep-glass-primary-pill ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium text-white cursor-pointer whitespace-nowrap"
      >
        <PartyAlignSceneIcon size={12} />
        <span>
          Match Here ({formatSignedOffset(positionSecs - timelineScale * liveRoomPositionSecs)})
        </span>
      </button>
      <button
        type="button"
        onClick={() => void setSceneAlignMode(false)}
        className="ep-bar-icon-btn ep-press h-6.5 px-2 rounded-full text-[11px] text-secondary hover:text-white cursor-pointer"
      >
        Cancel
      </button>
    </div>
  );
});

export function WatchRoom() {
  const {
    username,
    roomCode,
    literalRoom,
    serverEndpoint,
    serverPassword,
    allowNetworkShares,
    hashFilenames,
    fullWidthPlayBar,
    settingsOpen,
    shortcutsOpen,
    selectedFilePath,
    selectedFileName,
  } = useAppStore(
    useShallow((s) => ({
      username: s.username,
      roomCode: s.roomCode,
      literalRoom: s.literalRoom,
      serverEndpoint: s.serverEndpoint,
      serverPassword: s.serverPassword,
      allowNetworkShares: s.allowNetworkShares,
      hashFilenames: s.hashFilenames,
      fullWidthPlayBar: s.fullWidthPlayBar,
      settingsOpen: s.settingsOpen,
      shortcutsOpen: s.shortcutsOpen,
      selectedFilePath: s.selectedFilePath,
      selectedFileName: s.selectedFileName,
    })),
  );

  const closeSettings = useAppStore((s) => s.closeSettings);
  const openSettings = useAppStore((s) => s.openSettings);
  const miniMode = useAppStore((s) => s.miniMode);
  const startWhenAllReady = useAppStore((s) => s.startWhenAllReady);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const skipIntroEnabled = useAppStore((s) => s.skipIntroMode !== "off");
  const outroNextEnabled = useAppStore((s) => s.outroNextMode !== "off");
  const outroRatingEnabled = useAppStore((s) => s.outroRatingEnabled);
  const segmentDetectEnabled = skipIntroEnabled || outroNextEnabled;
  const autoFetchSubtitles = useAppStore((s) => s.autoFetchSubtitles);
  const preferredSubtitleLangs = useAppStore((s) => s.preferredSubtitleLangs);
  const openSubtitlesApiKey = useAppStore((s) => s.openSubtitlesApiKey);
  const reactionsEnabled = useAppStore((s) => s.reactionsEnabled);
  const closeShortcuts = useAppStore((s) => s.closeShortcuts);
  const openShortcuts = useAppStore((s) => s.openShortcuts);
  const [settingsEverOpened, setSettingsEverOpened] = useState(settingsOpen);
  const [shortcutsEverOpened, setShortcutsEverOpened] = useState(shortcutsOpen);

  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);

  useEffect(() => {
    if (shortcutsOpen) setShortcutsEverOpened(true);
  }, [shortcutsOpen]);
  const setFullWidthPlayBar = useAppStore((s) => s.setFullWidthPlayBar);
  const leaveRoom = useAppStore((s) => s.leaveRoom);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);

  const loaded = usePlayerStore((s) => s.loaded);
  const engineSurfaceVisible = usePlayerStore((s) => s.engineSurfaceVisible);
  const frozenFrame = usePlayerStore((s) => s.frozenFrame);
  const paused = usePlayerStore((s) => s.paused);
  const muted = usePlayerStore((s) => s.muted);
  const pausedPosHalf = usePlayerStore((s) => (s.paused ? Math.round(s.positionSecs * 2) : 0));
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const speed = usePlayerStore((s) => s.speed);
  const looping = usePlayerStore((s) => s.looping);
  const aspectMode = usePlayerStore((s) => s.aspectMode);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const setSpeed = usePlayerStore((s) => s.setSpeed);
  const setAspectMode = usePlayerStore((s) => s.setAspectMode);
  const playerError = usePlayerStore((s) => s.playerError);
  const feedback = usePlayerStore((s) => s.feedback);
  const seekCue = usePlayerStore((s) => s.seekCue);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);
  const localReady = useSyncStore((s) => s.localReady);
  const timelineOffsetSecs = useSyncStore((s) => s.timelineOffsetSecs);
  const timelineScale = useSyncStore((s) => s.timelineScale);
  const alignMode = useSyncStore((s) => s.alignMode);
  const subVisible = useSubtitleStore((s) => s.visible);
  const setSubVisible = useSubtitleStore((s) => s.setVisible);
  const setSubDelaySecs = useSubtitleStore((s) => s.setDelaySecs);
  const clearSubLoadedTrack = useSubtitleStore((s) => s.clearLoadedTrack);
  const loadedSubPath = useSubtitleStore((s) => s.originalFilePath ?? s.loadedFilePath);
  const tracks = usePlayerStore((s) => s.tracks);
  const detectedSubLangs = usePlayerStore((s) => s.detectedSubLangs);
  const introVideoKey = useIntroStore((s) => s.videoKey);
  const introChapters = useIntroStore((s) => s.chapters);
  const introSegments = useIntroStore((s) => s.segments);
  const manualIntro = useIntroStore((s) => s.manualIntro);
  const detectedOutro = useIntroStore((s) => s.outro);
  const introDismissedKeys = useIntroStore((s) => s.dismissedKeys);
  const pushNote = useNotificationStore((s) => s.push);
  const notificationCount = useNotificationStore((s) => s.items.length);

  const playlistItems = usePlaylistStore((s) => s.items);
  const playlistIndex = usePlaylistStore((s) => s.currentIndex);
  const folderName = usePlaylistStore((s) => s.folderName);
  const hasFolderEpisodes = Boolean(folderName) || playlistItems.length > 1;
  const autoPlayNext = usePlaylistStore((s) => s.autoPlayNext);
  const followPartyEpisode = usePlaylistStore((s) => s.followPartyEpisode);
  const setAutoPlayNext = usePlaylistStore((s) => s.setAutoPlayNext);
  const setFollowPartyEpisode = usePlaylistStore((s) => s.setFollowPartyEpisode);
  const activePlaylistItem =
    playlistIndex >= 0 && playlistIndex < playlistItems.length
      ? playlistItems[playlistIndex]
      : null;
  const displayMedia = formatDisplayMediaTitle(selectedFileName || "");
  const cleanHeaderTitle = selectedFileName
    ? displayMedia.subtitle
      ? `${displayMedia.subtitle} — ${displayMedia.title}`
      : displayMedia.title || selectedFileName
    : roomCode
      ? "Watch Theater"
      : "Media Player";

  const showcaseCfg = getActiveShowcaseConfig();
  const [sideTab, setSideTab] = useState<SideTab>(showcaseCfg?.initialTab ?? "room");
  const [panelOpen, setPanelOpen] = useState(Boolean(showcaseCfg?.initialTab));
  const [chromeIdle, setChromeIdle] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [viewportTick, setViewportTick] = useState(0);
  const [seekSettledTick, setSeekSettledTick] = useState(0);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const [loadingMedia, setLoadingMedia] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [popoverPos, setPopoverPos] = useState<CapsulePopoverLayout | null>(null);
  const [windowWidth, setWindowWidth] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  const [chatResizing, setChatResizing] = useState(false);
  const [chatLayoutTransitioning, setChatLayoutTransitioning] = useState(false);
  const [partyResizing, setPartyResizing] = useState(false);
  const [partyLayoutTransitioning, setPartyLayoutTransitioning] = useState(false);
  const [pinLeftExiting, setPinLeftExiting] = useState(false);
  const [surfaceHoldPending, setSurfaceHoldPending] = useState(false);
  const chatTransitionTimerRef = useRef<number | null>(null);
  const chatTransitionSeqRef = useRef(0);
  const partyTransitionTimerRef = useRef<number | null>(null);
  const partyTransitionSeqRef = useRef(0);
  const partyUnpinBloomTimerRef = useRef<number | null>(null);
  const surfaceHoldTimerRef = useRef<number | null>(null);
  const surfaceRestoreSeqRef = useRef(0);

  const chatSidebarOpen = useChatStore((s) => s.chatOpen);
  const chatSidebarWidth = useChatStore((s) => s.sidebarWidth);
  const unreadChatCount = useChatStore((s) => s.unreadCount);
  const setChatOpen = useChatStore((s) => s.setChatOpen);
  const partyDisplayMode = useAppStore((s) => s.partyDisplayMode);
  const partySidebarOpen = useAppStore((s) => s.partySidebarOpen);
  const partySidebarWidth = useAppStore((s) => s.partySidebarWidth);
  const setPartyDisplayMode = useAppStore((s) => s.setPartyDisplayMode);
  const setPartySidebarOpen = useAppStore((s) => s.setPartySidebarOpen);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const chatTriggerPlacement = useAppStore((s) => s.chatTriggerPlacement);
  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const voiceJoined = useVoiceStore((s) => s.joined);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const voiceGateOpen = useVoiceStore((s) => s.localGateOpen);
  const voiceStreamStatus = useVoiceStore((s) => s.streamStatus);
  const voiceSpeakingPeers = useVoiceStore((s) => s.speakingPeers);
  const voicePeerOverrides = useVoiceStore((s) => s.peerOverrides);
  const micCue = useVoiceStore((s) => s.micCue);
  const avatarId = useAppStore((s) => s.avatarId);
  const voiceCaptureHealthy =
    voiceStreamStatus !== "micBusy" &&
    voiceStreamStatus !== "reconnecting" &&
    voiceStreamStatus !== "permissionDenied";
  const localVoiceSpeaking = voiceJoined && !voiceMuted && voiceGateOpen && voiceCaptureHealthy;

  useEffect(() => {
    void voiceSetMoviePlaying(loaded && !paused).catch(() => undefined);
  }, [loaded, paused]);

  useEffect(() => {
    voicePeerMapRef.current = null;
    voiceLeftAtRef.current.clear();
    lastVoiceInviteToastAtRef.current = 0;
  }, [roomCode]);
  const effectivePartySidebarOpen =
    Boolean(roomCode) && partyDisplayMode === "sidebar" && partySidebarOpen && !miniMode;
  const effectiveChatSidebarOpen = Boolean(roomCode) && chatSidebarOpen && !miniMode;
  const partySidebarPresence = useAnimatedPresence(effectivePartySidebarOpen, 280);
  const chatSidebarPresence = useAnimatedPresence(effectiveChatSidebarOpen, 280);
  const {
    partyDocked,
    chatDocked,
    effectivePartyWidth,
    effectiveChatWidth,
  } = resolveDualSidebarLayout({
    windowWidth,
    partyOpen: effectivePartySidebarOpen || partySidebarPresence.mounted,
    partyPreferredWidth: partySidebarWidth,
    chatOpen: effectiveChatSidebarOpen || chatSidebarPresence.mounted,
    chatPreferredWidth: chatSidebarWidth,
  });
  const partyDockedOffsetPx = partyDocked && effectivePartySidebarOpen ? effectivePartyWidth : 0;

  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastLeftMarginRatioRef = useRef(-1);
  const lastMarginRatioRef = useRef(-1);
  const viewportTrackerRef = useRef(new ViewportSyncTracker());
  const soundTrackerRef = useRef(new RoomSoundTracker());
  const syncDisconnectTrackerRef = useRef(new SyncDisconnectTracker());
  const voicePeerMapRef = useRef<Record<string, boolean> | null>(null);
  const voiceLeftAtRef = useRef<Map<string, number>>(new Map());
  const lastVoiceInviteToastAtRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const mpvLifecycleActiveRef = useRef(false);
  const mpvStartedRef = useRef(false);
  const mpvStartPromiseRef = useRef<Promise<void> | null>(null);
  const listenersReadyPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const loadInFlightRef = useRef(false);
  const roomSessionStartedRef = useRef(false);
  const activeBackendRoomRef = useRef<string | null>(null);
  const autoCloudFallbackRoomRef = useRef<string | null>(null);
  const panelOpenRef = useRef(false);
  const sideTabRef = useRef<SideTab>(sideTab);
  const contextMenuOpenRef = useRef(false);
  const barHoveredRef = useRef(false);
  const barLeaveCooldownUntilRef = useRef(0);
  const idleTimerRef = useRef<number | null>(null);
  const chromeIdleRef = useRef(false);
  chromeIdleRef.current = chromeIdle;
  const lastWakeTimerResetRef = useRef(0);
  const announcedFileKeyRef = useRef<string | null>(null);
  const autoReadyMarkedRef = useRef(false);
  const dialogOpenRef = useRef(false);
  const leavingRef = useRef(false);
  const loadGenRef = useRef(0);
  const eofHandledLoadGenRef = useRef(-1);
  const lastTimePosRef = useRef(0);
  const lastLoopSyncAtRef = useRef(0);
  const introDetectGenRef = useRef(0);
  const introCheckedSigRef = useRef("");
  const autoSubFetchedKeyRef = useRef("");
  const autoLoadedPathRef = useRef<string | null>(null);
  const justAdvancedFromPathRef = useRef<string | null>(null);
  const recentLocalSwitchesRef = useRef<RecentEpisodeSwitch[]>([]);
  const recentFollowTimestampsRef = useRef<number[]>([]);
  const pendingPairedSubRef = useRef<{ videoPath: string; subPath: string } | null>(null);
  const loadSubtitlePathRef = useRef<((path: string) => Promise<void>) | null>(null);
  const selectEpisodeAtIndexRef = useRef<
    ((index: number, trigger?: EpisodeLoadTrigger) => Promise<void>) | null
  >(null);
  const lastPeerFileRef = useRef<string | null>(null);
  const restoredAlignmentPairRef = useRef<string | null>(null);
  const resumeAppliedKeyRef = useRef<string | null>(null);
  const subPrefAppliedKeyRef = useRef<string | null>(null);
  const seriesTrackAppliedKeyRef = useRef<string | null>(null);
  const lastResumeSaveAtRef = useRef<number>(0);
  const watchedMarkedPathRef = useRef<string | null>(null);
  const jumpedFromEarlyToEndRef = useRef<boolean>(false);

  const markCurrentEpisodeWatchedIfEligible = useCallback((isEof = false) => {
    const appNow = useAppStore.getState();
    if (!appNow.trackWatchedEpisodes) return;
    const pNow = usePlayerStore.getState();
    if (!pNow.loaded || pNow.durationSecs <= 0 || !appNow.selectedFilePath) return;
    if (!isEof && pNow.positionSecs < pNow.durationSecs * 0.9) return;
    if (jumpedFromEarlyToEndRef.current) return;
    if (watchedMarkedPathRef.current === appNow.selectedFilePath) return;

    const plNow = usePlaylistStore.getState();
    if (plNow.items.length === 0) return;
    const folderPath = extractParentFolderPath(plNow.items[0].path);
    if (!folderPath) return;
    const epItem = plNow.items[plNow.currentIndex] ?? appNow.selectedFileName ?? appNow.selectedFilePath;
    const epKey = buildEpisodeKey(epItem);
    const seriesKey = useSeriesProgressStore.getState().upsertSeries({
      folderPath,
      folderName: plNow.folderName || "Series",
      lastEpisodeKey: epKey,
    });
    if (seriesKey) {
      useSeriesProgressStore.getState().markWatched(seriesKey, epKey, true);
      watchedMarkedPathRef.current = appNow.selectedFilePath;
    }
  }, []);

  const saveCurrentResumePosition = useCallback(() => {
    const appNow = useAppStore.getState();
    if (!appNow.rememberPlaybackPosition) return;
    const pNow = usePlayerStore.getState();
    if (!pNow.loaded || pNow.durationSecs <= 0 || !appNow.selectedFileName) return;
    const key = buildMediaFileKey(appNow.selectedFileName, pNow.durationSecs);
    if (!key) return;
    const linkedRoomId = appNow.roomCode
      ? buildRecentRoomId(appNow.roomCode, appNow.serverEndpoint, appNow.literalRoom)
      : undefined;
    useResumeStore.getState().savePosition(key, pNow.positionSecs, pNow.durationSecs, {
      filePath: appNow.selectedFilePath,
      fileName: appNow.selectedFileName,
      linkedRoomId,
    });
    lastResumeSaveAtRef.current = Date.now();
  }, []);

  panelOpenRef.current = panelOpen;
  sideTabRef.current = sideTab;
  contextMenuOpenRef.current = contextMenu !== null;

  const canAutoHideChromeNow = useCallback(() => {
    if (getActiveShowcaseConfig() !== null) return false;
    const p = usePlayerStore.getState();
    const app = useAppStore.getState();
    const sync = useSyncStore.getState();
    const shouldAutoHidePlaying = !p.paused;
    const shouldAutoHidePausedFullscreen = p.paused && (p.isFullscreen || app.miniMode);
    return (
      p.loaded &&
      (shouldAutoHidePlaying || shouldAutoHidePausedFullscreen) &&
      !sync.alignMode &&
      !panelOpenRef.current &&
      !contextMenuOpenRef.current &&
      !app.settingsOpen &&
      !app.shortcutsOpen &&
      !p.playerError
    );
  }, []);

  const wakeChrome = useCallback(() => {
    barLeaveCooldownUntilRef.current = 0;
    const now = Date.now();
    if (
      !chromeIdleRef.current &&
      !barHoveredRef.current &&
      canAutoHideChromeNow() &&
      idleTimerRef.current !== null &&
      now - lastWakeTimerResetRef.current < 120
    ) {
      return;
    }
    lastWakeTimerResetRef.current = now;
    if (chromeIdleRef.current) {
      chromeIdleRef.current = false;
      setChromeIdle(false);
    }
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (canAutoHideChromeNow() && !barHoveredRef.current) {
      const p = usePlayerStore.getState();
      const delayMs = p.isFullscreen ? 2200 : 2600;
      idleTimerRef.current = window.setTimeout(() => {
        chromeIdleRef.current = true;
        setChromeIdle(true);
      }, delayMs);
    }
  }, [canAutoHideChromeNow]);

  const handleBarHoverChange = useCallback(
    (hovered: boolean) => {
      const wasHovered = barHoveredRef.current;
      barHoveredRef.current = hovered;
      if (hovered) {
        wakeChrome();
        return;
      }
      if (wasHovered) {
        barLeaveCooldownUntilRef.current = Date.now() + 650;
        if (idleTimerRef.current !== null) {
          window.clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        if (canAutoHideChromeNow()) {
          idleTimerRef.current = window.setTimeout(() => {
            setChromeIdle(true);
          }, 180);
        }
      }
    },
    [canAutoHideChromeNow, wakeChrome],
  );

  const onPassivePointerMove = useCallback(() => {
    if (!barHoveredRef.current && Date.now() < barLeaveCooldownUntilRef.current) {
      return;
    }
    wakeChrome();
  }, [wakeChrome]);

  const stageRect = useViewportRect(stageRef, viewportTick);

  const toggleFullscreen = useCallback(() => {
    const next = !usePlayerStore.getState().isFullscreen;
    usePlayerStore.getState().setIsFullscreen(next);
    void windowSetFullscreen(next).catch((err) => {
      pushNote("error", formatUserError(err, "Fullscreen toggle failed."));
    });
  }, [pushNote]);

  const exitFullscreen = useCallback(() => {
    if (!usePlayerStore.getState().isFullscreen) return;
    usePlayerStore.getState().setIsFullscreen(false);
    void windowSetFullscreen(false).catch(() => undefined);
  }, []);

  const hideChrome = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    chromeIdleRef.current = true;
    setChromeIdle(true);
  }, []);

  const toggleReactionsPopover = useCallback(() => {
    wakeChrome();
    if (panelOpenRef.current && sideTabRef.current === "reactions") {
      setPanelOpen(false);
    } else {
      setSideTab("reactions");
      setPanelOpen(true);
    }
  }, [wakeChrome]);

  const syncMpvRightMarginNow = useCallback((force = false) => {
    const stageEl = stageRef.current;
    const vpEl = viewportRef.current;
    if (!stageEl || !vpEl || !isDesktop() || !mpvStartedRef.current) return;
    const sRect = stageEl.getBoundingClientRect();
    const vRect = vpEl.getBoundingClientRect();
    const { leftRatio, rightRatio } = computeMpvMarginRatios(sRect, vRect);
    if (force || Math.abs(leftRatio - lastLeftMarginRatioRef.current) >= 0.0004) {
      lastLeftMarginRatioRef.current = leftRatio;
      safeMpvCall(mpvSetVideoMarginLeft(leftRatio), "mpvSetVideoMarginLeft");
    }
    if (force || Math.abs(rightRatio - lastMarginRatioRef.current) >= 0.0004) {
      lastMarginRatioRef.current = rightRatio;
      safeMpvCall(mpvSetVideoMarginRight(rightRatio), "mpvSetVideoMarginRight");
    }
  }, []);

  const restoreLiveMpvSurfaceAfterPause = useCallback(async () => {
    const restoreSeq = ++surfaceRestoreSeqRef.current;
    if (surfaceHoldTimerRef.current !== null) {
      window.clearTimeout(surfaceHoldTimerRef.current);
      surfaceHoldTimerRef.current = null;
    }

    setSurfaceHoldPending(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    if (!mountedRef.current || surfaceRestoreSeqRef.current !== restoreSeq) return;

    const settled = measurePhysicalRect(stageRef.current ?? viewportRef.current);
    if (settled.width > 0 && settled.height > 0) {
      const plan = viewportTrackerRef.current.planResize(settled);
      if (plan.send || plan.forceFlag) {
        await safeMpvCall(mpvResize(settled, true), "restore:mpvResize");
      }
    }
    syncMpvRightMarginNow(true);
    if (!mountedRef.current || surfaceRestoreSeqRef.current !== restoreSeq) return;

    const pNow = usePlayerStore.getState();
    const aNow = useAppStore.getState();
    if (
      aNow.settingsOpen ||
      aNow.shortcutsOpen ||
      Boolean(pNow.playerError) ||
      dialogOpenRef.current
    ) {
      setSurfaceHoldPending(false);
      return;
    }

    await safeMpvCall(mpvSetVisible(true), "restore:mpvSetVisible");
    if (!mountedRef.current || surfaceRestoreSeqRef.current !== restoreSeq) return;

    surfaceHoldTimerRef.current = window.setTimeout(() => {
      surfaceHoldTimerRef.current = null;
      if (mountedRef.current && surfaceRestoreSeqRef.current === restoreSeq) {
        setSurfaceHoldPending(false);
      }
    }, 72);
  }, [syncMpvRightMarginNow]);

  const finishChatLayoutTransition = useCallback(
    (expectedSeq?: number) => {
      if (expectedSeq !== undefined && chatTransitionSeqRef.current !== expectedSeq) return;
      if (chatTransitionTimerRef.current !== null) {
        window.clearTimeout(chatTransitionTimerRef.current);
        chatTransitionTimerRef.current = null;
      }
      requestAnimationFrame(() => {
        syncMpvRightMarginNow(true);
      });
      setChatLayoutTransitioning(false);
    },
    [syncMpvRightMarginNow],
  );

  const setChatSidebarOpenSmooth = useCallback(
    (nextOpen: boolean) => {
      if (useChatStore.getState().chatOpen === nextOpen) return;
      const seq = ++chatTransitionSeqRef.current;
      if (chatTransitionTimerRef.current !== null) {
        window.clearTimeout(chatTransitionTimerRef.current);
        chatTransitionTimerRef.current = null;
      }

      const playerNow = usePlayerStore.getState();
      const chatDockedNow = chatDocked || windowWidth >= (effectivePartySidebarOpen ? 1080 : 860);
      const liveMarginAnimate =
        !reducedMotion &&
        isDesktop() &&
        mpvStartedRef.current &&
        chatDockedNow &&
        playerNow.loaded &&
        !playerNow.playerError;

      setChatOpen(nextOpen);
      if (!liveMarginAnimate) return;

      setChatLayoutTransitioning(true);
      chatTransitionTimerRef.current = window.setTimeout(() => {
        chatTransitionTimerRef.current = null;
        finishChatLayoutTransition(seq);
      }, nextOpen ? 400 : 310);
    },
    [
      chatDocked,
      effectivePartySidebarOpen,
      finishChatLayoutTransition,
      reducedMotion,
      setChatOpen,
      windowWidth,
    ],
  );

  const finishPartyLayoutTransition = useCallback(
    (expectedSeq?: number) => {
      if (expectedSeq !== undefined && partyTransitionSeqRef.current !== expectedSeq) return;
      if (partyTransitionTimerRef.current !== null) {
        window.clearTimeout(partyTransitionTimerRef.current);
        partyTransitionTimerRef.current = null;
      }
      requestAnimationFrame(() => {
        syncMpvRightMarginNow(true);
      });
      setPartyLayoutTransitioning(false);
    },
    [syncMpvRightMarginNow],
  );

  const setPartySidebarOpenSmooth = useCallback(
    (nextOpen: boolean) => {
      if (useAppStore.getState().partySidebarOpen === nextOpen && partyTransitionTimerRef.current === null) {
        return;
      }
      const seq = ++partyTransitionSeqRef.current;
      if (partyTransitionTimerRef.current !== null) {
        window.clearTimeout(partyTransitionTimerRef.current);
        partyTransitionTimerRef.current = null;
      }

      const playerNow = usePlayerStore.getState();
      const partyDockedNow = windowWidth >= 860;
      const liveMarginAnimate =
        !reducedMotion &&
        isDesktop() &&
        mpvStartedRef.current &&
        partyDockedNow &&
        playerNow.loaded &&
        !playerNow.playerError;

      setPartySidebarOpen(nextOpen);
      if (!liveMarginAnimate) {
        requestAnimationFrame(() => syncMpvRightMarginNow(true));
        return;
      }

      setPartyLayoutTransitioning(true);
      partyTransitionTimerRef.current = window.setTimeout(() => {
        partyTransitionTimerRef.current = null;
        finishPartyLayoutTransition(seq);
      }, nextOpen ? 400 : 310);
    },
    [finishPartyLayoutTransition, reducedMotion, setPartySidebarOpen, syncMpvRightMarginNow, windowWidth],
  );

  const handleDockPartyLeft = useCallback(() => {
    wakeChrome();
    if (partyUnpinBloomTimerRef.current !== null) {
      window.clearTimeout(partyUnpinBloomTimerRef.current);
      partyUnpinBloomTimerRef.current = null;
    }
    setPinLeftExiting(true);
    setPanelOpen(false);
    setPartyDisplayMode("sidebar");
    setPartySidebarOpenSmooth(true);
    window.setTimeout(() => {
      setPinLeftExiting(false);
    }, 220);
  }, [setPartyDisplayMode, setPartySidebarOpenSmooth, wakeChrome]);

  const handleUnpinPartyToPopover = useCallback(() => {
    wakeChrome();
    if (partyUnpinBloomTimerRef.current !== null) {
      window.clearTimeout(partyUnpinBloomTimerRef.current);
      partyUnpinBloomTimerRef.current = null;
    }
    setPartySidebarOpenSmooth(false);
    const delayMs = reducedMotion ? 0 : 140;
    partyUnpinBloomTimerRef.current = window.setTimeout(() => {
      partyUnpinBloomTimerRef.current = null;
      setPartyDisplayMode("popover");
      setSideTab("room");
      setPanelOpen(true);
    }, delayMs);
  }, [reducedMotion, setPartyDisplayMode, setPartySidebarOpenSmooth, wakeChrome]);

  const toggleOrFocusPartyLounge = useCallback(() => {
    wakeChrome();
    const appNow = useAppStore.getState();
    if (!appNow.roomCode) {
      if (panelOpenRef.current && sideTabRef.current === "room") {
        setPanelOpen(false);
      } else {
        setSideTab("room");
        setPanelOpen(true);
      }
      return;
    }
    if (appNow.partyDisplayMode !== "sidebar") {
      if (panelOpenRef.current && sideTabRef.current === "room") {
        handleDockPartyLeft();
      } else {
        if (panelOpenRef.current) setPanelOpen(false);
        setPartyDisplayMode("sidebar");
        setPartySidebarOpenSmooth(true);
      }
      return;
    }
    if (panelOpenRef.current) {
      setPanelOpen(false);
    }
    setPartySidebarOpenSmooth(!appNow.partySidebarOpen);
  }, [handleDockPartyLeft, setPartyDisplayMode, setPartySidebarOpenSmooth, wakeChrome]);

  // Pump live video-margin-ratio-left & right updates on every frame during dock springs / handle drags
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    if (!chatLayoutTransitioning && !chatResizing && !partyLayoutTransitioning && !partyResizing) {
      return;
    }

    let rafId = 0;
    const step = () => {
      syncMpvRightMarginNow();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [
    chatLayoutTransitioning,
    chatResizing,
    partyLayoutTransitioning,
    partyResizing,
    syncMpvRightMarginNow,
  ]);

  // Keep settled GPU left & right margins synced immediately on drag, open/close, breakpoint, or media load
  useLayoutEffect(() => {
    syncMpvRightMarginNow();
  }, [
    effectivePartySidebarOpen,
    partyDocked,
    effectivePartyWidth,
    effectiveChatSidebarOpen,
    chatDocked,
    effectiveChatWidth,
    roomCode,
    windowWidth,
    loaded,
    syncMpvRightMarginNow,
  ]);

  const setChatSidebarOpenSmoothRef = useRef(setChatSidebarOpenSmooth);
  setChatSidebarOpenSmoothRef.current = setChatSidebarOpenSmooth;
  const setPartySidebarOpenSmoothRef = useRef(setPartySidebarOpenSmooth);
  setPartySidebarOpenSmoothRef.current = setPartySidebarOpenSmooth;
  const partyDockedRef = useRef(partyDocked);
  partyDockedRef.current = partyDocked;
  const effectivePartyOpenRef = useRef(effectivePartySidebarOpen);
  effectivePartyOpenRef.current = effectivePartySidebarOpen;

  const toggleChatSidebar = useCallback(() => {
    wakeChrome();
    setChatSidebarOpenSmooth(!useChatStore.getState().chatOpen);
  }, [setChatSidebarOpenSmooth, wakeChrome]);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (chatTransitionTimerRef.current !== null) {
        window.clearTimeout(chatTransitionTimerRef.current);
        chatTransitionTimerRef.current = null;
      }
      if (partyTransitionTimerRef.current !== null) {
        window.clearTimeout(partyTransitionTimerRef.current);
        partyTransitionTimerRef.current = null;
      }
      if (partyUnpinBloomTimerRef.current !== null) {
        window.clearTimeout(partyUnpinBloomTimerRef.current);
        partyUnpinBloomTimerRef.current = null;
      }
      if (surfaceHoldTimerRef.current !== null) {
        window.clearTimeout(surfaceHoldTimerRef.current);
        surfaceHoldTimerRef.current = null;
      }
    };
  }, []);

  const prevDualDockedRef = useRef(
    `${Boolean(roomCode)}:${effectiveChatSidebarOpen && chatDocked}:${effectivePartySidebarOpen && partyDocked}`,
  );
  useEffect(() => {
    const sig = `${Boolean(roomCode)}:${effectiveChatSidebarOpen && chatDocked}:${effectivePartySidebarOpen && partyDocked}`;
    if (sig === prevDualDockedRef.current) return;
    prevDualDockedRef.current = sig;
    syncMpvRightMarginNow(true);
  }, [
    effectiveChatSidebarOpen,
    chatDocked,
    effectivePartySidebarOpen,
    partyDocked,
    roomCode,
    syncMpvRightMarginNow,
  ]);

  const handleSeekToChatTimestamp = useCallback(
    (secs: number) => {
      const p = usePlayerStore.getState();
      if (!p.loaded) {
        pushNote("info", "Load the video file first to jump to timestamps.");
        return;
      }
      const sync = useSyncStore.getState();
      const appState = useAppStore.getState();
      const syncConnected = sync.status.state === "connected";
      const effUser = resolveEffectiveUsername(sync.status, appState.username);
      const ctrlLock = getControllerLockState(
        syncConnected,
        sync.participants,
        effUser,
        sync.roomControl,
      );
      if (ctrlLock.lockedForLocalUser && !(syncConnected && sync.alignMode)) {
        pushNote("warn", formatControllerLockReason(ctrlLock));
        return;
      }
      const clamped = p.durationSecs > 0 ? Math.max(0, Math.min(secs, p.durationSecs)) : Math.max(0, secs);
      const clientSeekSeq = nextClientSeekSeq();
      p.setEndedAtEof(false);
      p.setPositionSecs(clamped);
      p.flashFeedback(`Jumped to ${formatClock(clamped)}`);
      safeMpvCall(mpvSeek(clamped, { clientSeekSeq }), "chat:mpvSeek");
      if (syncConnected && !sync.alignMode) {
        void syncUserSeek(clamped);
      }
    },
    [pushNote],
  );

  usePlayerShortcuts({
    onToggleFullscreen: toggleFullscreen,
    onExitFullscreen: exitFullscreen,
    hasOpenOverlay: useCallback(
      () =>
        panelOpenRef.current ||
        contextMenuOpenRef.current ||
        useChatStore.getState().chatOpen ||
        (effectivePartyOpenRef.current && !partyDockedRef.current),
      [],
    ),
    onToggleReactions: toggleReactionsPopover,
    onToggleChat: toggleChatSidebar,
    onToggleParty: toggleOrFocusPartyLounge,
    onWakeChrome: wakeChrome,
  });

  const ensureMpvStarted = useCallback(async () => {
    if (!isDesktop() || !mountedRef.current || mpvStartedRef.current) return;
    if (mpvStartPromiseRef.current) {
      await mpvStartPromiseRef.current;
      return;
    }

    const startPromise = enqueueMpvLifecycle(async () => {
      await listenersReadyPromiseRef.current;
      if (!mountedRef.current || mpvStartedRef.current) return;

      const rawRect = measurePhysicalRect(stageRef.current ?? viewportRef.current);
      const initialRect = {
        x: rawRect.x,
        y: rawRect.y,
        width: Math.max(1, rawRect.width),
        height: Math.max(1, rawRect.height),
      };

      mpvLifecycleActiveRef.current = true;
      lastMarginRatioRef.current = -1;
      try {
        await mpvStart(initialRect);
      } catch (err) {
        mpvLifecycleActiveRef.current = false;
        throw err;
      }

      if (!mountedRef.current) {
        return;
      }

      mpvStartedRef.current = true;
      viewportTrackerRef.current.markInvalidated();
      setViewportTick((t) => t + 1);
      const appState = useAppStore.getState();
      const playerNow = usePlayerStore.getState();
      syncMpvRightMarginNow(true);
      safeMpvCall(mpvSetVolume(playerNow.volume), "mpvSetVolume:start");
      safeMpvCall(mpvSetMute(playerNow.muted), "mpvSetMute:start");
      if (playerNow.dialogueBoost) {
        safeMpvCall(mpvSetDialogueBoost(true), "mpvSetDialogueBoost:start");
      }
      safeMpvCall(
        mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !playerNow.playerError),
        "mpvSetVisible:start",
      );
    }).finally(() => {
      mpvStartPromiseRef.current = null;
    });

    mpvStartPromiseRef.current = startPromise;
    await startPromise;
  }, [syncMpvRightMarginNow]);

  // Load media + subtitle files safely
  const loadSubtitlePath = useCallback(
    async (path: string) => {
      if (!usePlayerStore.getState().loaded) {
        pushNote("info", "Open a video file before loading a subtitle.");
        return;
      }
      const subState = useSubtitleStore.getState();
      try {
        await mpvAddSubtitle(path, subState.encodingHint);
        await mpvSetSubDelay(0);
        subState.setDelaySecs(0);
        subState.setLoadedTrack(path, path);
        await mpvSetSubStyle(buildSubStyleParams(useSubtitleStore.getState(), { visible: true }));
        pushNote("success", `Loaded subtitle: ${getFileDisplayName(path)}`);
      } catch (err) {
        pushNote("error", formatUserError(err, "Could not load subtitle file."));
      }
    },
    [pushNote],
  );
  loadSubtitlePathRef.current = loadSubtitlePath;

  const loadVideoPath = useCallback(
    async (
      path: string,
      pairedSubPath?: string | null,
      options?: { trigger?: EpisodeLoadTrigger },
    ) => {
      const trigger: EpisodeLoadTrigger = options?.trigger ?? "manual";
      const gen = ++loadGenRef.current;
      loadInFlightRef.current = true;
      setLoadingMedia(true);
      const displayName = getFileDisplayName(path);
      const prevSelectedPath = useAppStore.getState().selectedFilePath;
      saveCurrentResumePosition();
      resumeAppliedKeyRef.current = null;
      subPrefAppliedKeyRef.current = null;
      seriesTrackAppliedKeyRef.current = null;
      watchedMarkedPathRef.current = null;
      jumpedFromEarlyToEndRef.current = false;
      const switchNowMs = Date.now();
      const prunedSwitches = recentLocalSwitchesRef.current.filter(
        (sw) => switchNowMs - sw.atMs < 10_000,
      );
      if (prevSelectedPath && prevSelectedPath.toLowerCase() !== path.toLowerCase()) {
        justAdvancedFromPathRef.current = prevSelectedPath;
        prunedSwitches.push({ path: prevSelectedPath, atMs: switchNowMs, trigger });
      }
      prunedSwitches.push({ path, atMs: switchNowMs, trigger });
      recentLocalSwitchesRef.current = prunedSwitches.slice(-12);
      const wasPlayingBeforeLoad = trigger === "autoNext" || !usePlayerStore.getState().paused;
      autoLoadedPathRef.current = path;
      void subtitleCancelAutoSync().catch(() => undefined);
      setSelectedFile(path, displayName);
      usePlaylistStore.getState().selectByPath(path);
      useSubtitleStore.getState().clearLoadedTrack();
      useSubtitleStore.getState().clearSecondaryTrack();
      if (useIntroStore.getState().videoKey !== normalizeIntroVideoKey(path)) {
        useIntroStore.getState().resetForVideo(path);
      }
      introCheckedSigRef.current = "";
      autoSubFetchedKeyRef.current = "";
      resetAutoSubtitleState();
      pendingPairedSubRef.current = pairedSubPath
        ? { videoPath: path, subPath: pairedSubPath }
        : null;
      autoReadyMarkedRef.current = false;
      announcedFileKeyRef.current = null;
      restoredAlignmentPairRef.current = null;
      lastTimePosRef.current = 0;
      lastLoopSyncAtRef.current = 0;
      resetSharedRelativeSeek();
      try {
        await ensureMpvStarted();
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        await mpvLoad(path);
        if (loadGenRef.current !== gen) return;
        usePlayerStore.getState().setLoaded(true);
        if (!mountedRef.current) return;
        usePlayerStore.getState().setPlayerError(null);
        await resetMpvPlaybackDefaults(useSyncStore.getState().status.state === "connected");
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        await mpvSetSubStyle(buildSubStyleParams(useSubtitleStore.getState()));
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        const appNow = useAppStore.getState();
        if (!useAppStore.getState().roomCode) {
          usePlayerStore.getState().setPaused(false);
          await mpvSetPause(false);
          if (loadGenRef.current !== gen || !mountedRef.current) return;
        } else {
          const syncNow = useSyncStore.getState();
          const syncConnNow = syncNow.status.state === "connected";
          const effUserNow = resolveEffectiveUsername(syncNow.status, appNow.username);
          const lockNow = getControllerLockState(
            syncConnNow,
            syncNow.participants,
            effUserNow,
            syncNow.roomControl,
          );
          const otherPeersWithFile = syncNow.participants.filter(
            (p) =>
              p.username.trim().toLowerCase() !== effUserNow.trim().toLowerCase() &&
              Boolean(p.fileName),
          );
          const syncDisconnectedNow =
            syncNow.status.state === "reconnecting" || syncNow.status.state === "error";
          if (syncDisconnectedNow) {
            usePlayerStore.getState().setPaused(true);
            await mpvSetPause(true);
            if (loadGenRef.current !== gen || !mountedRef.current) return;
          } else if (!lockNow.lockedForLocalUser && otherPeersWithFile.length === 0) {
            usePlayerStore.getState().setPaused(false);
            await mpvSetPause(false);
            if (loadGenRef.current !== gen || !mountedRef.current) return;
            if (syncConnNow) {
              let resumeStartSecs = 0;
              if (appNow.rememberPlaybackPosition) {
                const durNow = usePlayerStore.getState().durationSecs;
                const directKey = durNow > 0 ? buildMediaFileKey(displayName, durNow) : null;
                const directSaved = directKey ? useResumeStore.getState().getPosition(directKey) : null;
                const normPath = path.trim().toLowerCase();
                const normName = displayName.trim().toLowerCase();
                const matchedSaved =
                  directSaved ??
                  Object.values(useResumeStore.getState().entries)
                    .filter((entry) => {
                      const entryPath = entry.filePath?.trim().toLowerCase();
                      if (entryPath) return entryPath === normPath;
                      const entryName = entry.fileName
                        ? getFileDisplayName(entry.fileName).trim().toLowerCase()
                        : "";
                      return Boolean(entryName && entryName === normName);
                    })
                    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
                  null;
                if (
                  matchedSaved &&
                  matchedSaved.durationSecs > 0 &&
                  matchedSaved.positionSecs >= RESUME_MIN_SECS &&
                  matchedSaved.positionSecs <= matchedSaved.durationSecs * RESUME_COMPLETE_RATIO
                ) {
                  resumeStartSecs = matchedSaved.positionSecs;
                }
              }
              useSyncStore.getState().setLocalReady(true);
              autoReadyMarkedRef.current = true;
              void syncSetReady(true, true);
              void syncUserSeek(resumeStartSecs);
              void syncUserPlay(resumeStartSecs);
            }
          } else {
            const pQueue = usePlaylistStore.getState();
            const manuallyNotReadyBlocked =
              syncConnNow &&
              getPlayBlockState({
                syncConnected: true,
                participants: syncNow.participants,
                localUsername: effUserNow,
              }).blocked;
            const loadPlan = resolveEpisodeLoadSyncPlan({
              roomCode: appNow.roomCode,
              syncConnected: syncConnNow,
              syncReconnectingOrError: syncDisconnectedNow,
              lockedForLocalUser: lockNow.lockedForLocalUser,
              participants: syncNow.participants,
              localUsername: effUserNow,
              targetFileName: displayName,
              targetPath: path,
              playlistItems: pQueue.items,
              trigger,
              wasPlayingBeforeLoad,
              manuallyNotReadyBlocked,
            });
            if (loadPlan.shouldAutoPlay) {
              usePlayerStore.getState().setPaused(false);
              await mpvSetPause(false);
              if (loadGenRef.current !== gen || !mountedRef.current) return;
              if (syncConnNow) {
                useSyncStore.getState().setLocalReady(true);
                autoReadyMarkedRef.current = true;
                void syncSetReady(true, true);
                if (loadPlan.shouldResetRoomToZero) {
                  void syncUserSeek(0);
                }
                void syncUserPlay(0);
              }
            } else if (loadPlan.shouldResetRoomToZero) {
              void syncUserSeek(0);
              if (loadPlan.shouldSendPauseToRoom) {
                void syncUserPause(0);
              }
            }
          }
        }
        if (!isDesktop()) {
          const pendingSub = pendingPairedSubRef.current;
          if (pendingSub && pendingSub.videoPath.toLowerCase() === path.toLowerCase()) {
            pendingPairedSubRef.current = null;
            await loadSubtitlePath(pendingSub.subPath);
          }
        }
        usePlayerStore.getState().flashFeedback(`Loaded ${displayName}`);
      } catch (err) {
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        pendingPairedSubRef.current = null;
        if (isMpvNotRunningError(err)) {
          mpvStartedRef.current = false;
          mpvStartPromiseRef.current = null;
          mpvLifecycleActiveRef.current = false;
        }
        usePlayerStore.getState().setEngineSurfaceVisible(false);
        const msg = formatUserError(err, "Failed opening video file.");
        usePlayerStore.getState().setPlayerError(msg);
        pushNote("error", msg);
        void logFrontendEvent("error", "player.load", msg, "ERR_LOAD");
      } finally {
        if (loadGenRef.current === gen) {
          loadInFlightRef.current = false;
          setLoadingMedia(false);
        }
      }
    },
    [ensureMpvStarted, loadSubtitlePath, pushNote, setSelectedFile],
  );

  const selectEpisodeAtIndex = useCallback(
    async (index: number, trigger: EpisodeLoadTrigger = "manual") => {
      const pState = usePlaylistStore.getState();
      if (index < 0 || index >= pState.items.length) return;
      const s = useSyncStore.getState();
      const connected = s.status.state === "connected";
      const ctrlLock = getControllerLockState(
        connected,
        s.participants,
        resolveEffectiveUsername(s.status, useAppStore.getState().username),
        s.roomControl,
      );
      if (ctrlLock.lockedForLocalUser) {
        pushNote("warn", formatControllerLockReason(ctrlLock));
        return;
      }
      const target = pState.items[index];
      pState.setCurrentIndex(index);
      await loadVideoPath(target.path, target.subtitlePath, { trigger });
    },
    [loadVideoPath, pushNote],
  );
  selectEpisodeAtIndexRef.current = selectEpisodeAtIndex;

  const switchToPartyEpisode = useCallback(
    async (index: number, trigger: EpisodeLoadTrigger = "manual") => {
      const pState = usePlaylistStore.getState();
      if (index < 0 || index >= pState.items.length) return;
      const target = pState.items[index];
      pState.setCurrentIndex(index);
      await loadVideoPath(target.path, target.subtitlePath, { trigger });
    },
    [loadVideoPath],
  );

  const handlePrevEpisode = useCallback(() => {
    const { currentIndex } = usePlaylistStore.getState();
    if (currentIndex > 0) {
      void selectEpisodeAtIndex(currentIndex - 1);
    }
  }, [selectEpisodeAtIndex]);

  const handleNextEpisode = useCallback(() => {
    const { currentIndex, items } = usePlaylistStore.getState();
    if (currentIndex >= 0 && currentIndex < items.length - 1) {
      void selectEpisodeAtIndex(currentIndex + 1);
    }
  }, [selectEpisodeAtIndex]);

  const handleOutroNextEpisode = useCallback(() => {
    const { currentIndex, items } = usePlaylistStore.getState();
    if (currentIndex >= 0 && currentIndex < items.length - 1) {
      void selectEpisodeAtIndex(currentIndex + 1, "autoNext");
    }
  }, [selectEpisodeAtIndex]);

  const loadMediaInputs = useCallback(
    async (paths: string[], options?: { append?: boolean }) => {
      const clean = paths.map((p) => p.trim()).filter(Boolean);
      if (clean.length === 0) return;
      let scan: Awaited<ReturnType<typeof scanMediaPaths>>;
      try {
        scan = await scanMediaPaths(clean);
      } catch {
        await loadVideoPath(clean[0]);
        return;
      }

      if (scan.items.length > 0) {
        const pStore = usePlaylistStore.getState();
        if (options?.append && pStore.items.length > 0) {
          const mergedMap = new Map<string, PlaylistItem>();
          for (const it of pStore.items) mergedMap.set(it.path.toLowerCase(), it);
          let addedCount = 0;
          for (const it of scan.items) {
            const key = it.path.toLowerCase();
            if (!mergedMap.has(key)) {
              mergedMap.set(key, it);
              addedCount += 1;
            }
          }
          const merged = Array.from(mergedMap.values()).sort((a, b) => {
            const sa = a.season ?? Number.MAX_SAFE_INTEGER;
            const sb = b.season ?? Number.MAX_SAFE_INTEGER;
            if (sa !== sb) return sa - sb;
            const ea = a.episode ?? Number.MAX_SAFE_INTEGER;
            const eb = b.episode ?? Number.MAX_SAFE_INTEGER;
            if (ea !== eb) return ea - eb;
            return naturalCompare(a.fileName, b.fileName);
          });
          const curPath = useAppStore.getState().selectedFilePath?.toLowerCase() ?? "";
          const keepIdx = merged.findIndex((it) => it.path.toLowerCase() === curPath);
          const nextIdx = keepIdx !== -1 ? keepIdx : 0;
          pStore.setPlaylist(merged, nextIdx, scan.folderName ?? pStore.folderName);
          if (addedCount > 0) {
            pushNote("success", `Added ${addedCount} episode${addedCount === 1 ? "" : "s"} to queue.`);
          }
          if (!usePlayerStore.getState().loaded && merged.length > 0) {
            await loadVideoPath(merged[nextIdx].path, merged[nextIdx].subtitlePath);
          }
          return;
        }

        let targetIndex = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
        let matchedPeer = false;
        const sState = useSyncStore.getState();
        if (sState.status.state === "connected" && pStore.followPartyEpisode) {
          const myName = resolveEffectiveUsername(sState.status, useAppStore.getState().username).toLowerCase();
          const leader =
            sState.participants.find((p) => p.isController && p.fileName) ??
            sState.participants.find((p) => p.username.toLowerCase() !== myName && p.fileName);
          if (leader?.fileName) {
            const peerMatch = matchPeerEpisodeInPlaylist(leader.fileName, scan.items);
            if (peerMatch !== -1) {
              targetIndex = peerMatch;
              matchedPeer = true;
              lastPeerFileRef.current = leader.fileName.trim();
            }
          }
        }
        if (
          !matchedPeer &&
          useAppStore.getState().trackWatchedEpisodes &&
          splitDroppedFiles(clean).directorySuspected
        ) {
          const folderPath = extractParentFolderPath(scan.items[0].path);
          const saved = folderPath
            ? useSeriesProgressStore.getState().getSeries(buildSeriesKey(folderPath))
            : null;
          if (saved) {
            targetIndex = pickInitialSeriesIndex(scan.items, saved);
          }
        }

        pStore.setPlaylist(scan.items, targetIndex, scan.folderName);
        const target = scan.items[targetIndex];
        const explicitMultiOrFolder = clean.length > 1 || splitDroppedFiles(clean).directorySuspected;
        if (scan.items.length > 1 && explicitMultiOrFolder) {
          pushNote(
            "success",
            `Queued ${scan.items.length} episodes${scan.folderName ? ` from ${scan.folderName}` : ""}`,
          );
        }
        await loadVideoPath(target.path, target.subtitlePath);
        if (scan.looseSubtitlePath && !target.subtitlePath) {
          pendingPairedSubRef.current = { videoPath: target.path, subPath: scan.looseSubtitlePath };
        }
        return;
      }

      if (scan.looseSubtitlePath) {
        await loadSubtitlePath(scan.looseSubtitlePath);
        return;
      }

      const split = splitDroppedFiles(clean);
      if (split.unsupportedFiles.length > 0) {
        pushNote("warn", `Unsupported file type: ${split.unsupportedFiles.join(", ")}`);
      } else {
        pushNote("warn", "No playable video or subtitle files found.");
      }
    },
    [loadSubtitlePath, loadVideoPath, pushNote],
  );

  const handleChooseFile = useCallback(
    async (append = false) => {
      if (!isDesktop()) {
        pushNote("warn", "File dialog requires the Windows desktop app.");
        return;
      }
      if (dialogOpenRef.current) {
        return;
      }
      dialogOpenRef.current = true;
      let picked: string[] = [];
      try {
        picked = await runWithHiddenMpvSurface(mpvStartedRef.current, async () => {
          const chosen = await open({
            multiple: true,
            title: append ? "Add Episode Files" : "Choose Video File(s)",
            filters: [
              {
                name: "Video Files",
                extensions: ["mkv", "mp4", "ts", "m2ts", "avi", "webm", "flv", "wmv", "ogv", "3gp", "*"],
              },
            ],
          });
          return Array.isArray(chosen)
            ? chosen
            : typeof chosen === "string" && chosen
              ? [chosen]
              : [];
        });
      } finally {
        dialogOpenRef.current = false;
      }
      if (picked.length > 0) {
        await loadMediaInputs(picked, append ? { append: true } : undefined);
      }
    },
    [loadMediaInputs, pushNote],
  );

  const handleChooseSeasonFolder = useCallback(async () => {
    if (!isDesktop()) {
      pushNote("warn", "Folder picker requires the Windows desktop app.");
      return;
    }
    if (dialogOpenRef.current) {
      return;
    }
    dialogOpenRef.current = true;
    let chosenFolder: string | null = null;
    try {
      chosenFolder = await runWithHiddenMpvSurface(mpvStartedRef.current, async () => {
        const chosen = await open({
          directory: true,
          multiple: false,
          title: "Choose Season Folder",
        });
        return typeof chosen === "string" && chosen ? chosen : null;
      });
    } finally {
      dialogOpenRef.current = false;
    }
    if (chosenFolder) {
      await loadMediaInputs([chosenFolder]);
    }
  }, [loadMediaInputs, pushNote]);

  // Sync network share policy on mount
  useEffect(() => {
    void setAllowNetworkShares(allowNetworkShares);
  }, [allowNetworkShares]);

  // Connect / tear down Syncplay lifecycle serialized via FIFO queue (Fix 03 / Fix 17)
  const connectRoom = useCallback(
    (endpoint: string, password: string) => {
      if (!isDesktop() || !roomCode) return;
      void enqueueSyncLifecycle(async () => {
        await listenersReadyPromiseRef.current;
        if (!mountedRef.current) return;
        const syncState = useSyncStore.getState();
        syncState.setParticipants([]);
        syncState.setServerOverrideNotice(null);
        syncState.setLastError(null);
        try {
          const appNow = useAppStore.getState();
          const claimEmpty =
            appNow.creatingRoom && !literalRoom && /^\d{6}$/.test(roomCode);
          if (claimEmpty) {
            appNow.setCreatingRoom(false);
          }
          await syncConnect({
            endpoint,
            username,
            roomCode,
            literalRoom,
            password: password || null,
            hostOnly: appNow.hostOnlyRoom,
            claimEmpty,
          });
        } catch (err) {
          pushNote("error", formatUserError(err, "Could not connect to Syncplay server."));
        }
      });
    },
    [literalRoom, pushNote, roomCode, username],
  );

  // Auto-play preselected file or season folder when entering WatchRoom
  useEffect(() => {
    if (
      !selectedFilePath ||
      !isDesktop() ||
      usePlayerStore.getState().loaded ||
      autoLoadedPathRef.current === selectedFilePath
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      autoLoadedPathRef.current = selectedFilePath;
      const pState = usePlaylistStore.getState();
      const activeItem =
        pState.items.find((it) => it.path.toLowerCase() === selectedFilePath.toLowerCase()) ??
        (pState.currentIndex >= 0 ? pState.items[pState.currentIndex] : undefined);
      if (activeItem) {
        void loadVideoPath(selectedFilePath, activeItem.subtitlePath);
      } else {
        setLoadingMedia(true);
        void scanMediaPaths([selectedFilePath])
          .then((scan) => {
            if (scan.items.length > 0) {
              const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
              usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
              const matched = scan.items[idx];
              void loadVideoPath(matched.path, matched.subtitlePath);
            } else {
              void loadVideoPath(selectedFilePath);
            }
          })
          .catch(() => {
            void loadVideoPath(selectedFilePath);
          });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [loadVideoPath, selectedFilePath, recoveryTick]);

  const introChaptersSig = useMemo(
    () => introChapters.map((c) => `${c.time.toFixed(2)}:${c.title ?? ""}`).join("|"),
    [introChapters]
  );
  const introSiblingsSig = useMemo(
    () => playlistItems.map((it) => it.path).join("\n"),
    [playlistItems]
  );
  const { introAudioIdx, introSubIdx, introSubCodec } = useMemo(() => {
    const audioTracks = tracks.filter((t) => t.type === "audio");
    const selAudio = audioTracks.findIndex((t) => t.selected);
    const subTracks = tracks.filter((t) => t.type === "sub" && !t.external);
    const isBitmap = (c?: string | null) => {
      const l = (c ?? "").toLowerCase();
      return (
        l.includes("pgs") ||
        l.includes("dvd") ||
        l.includes("dvb") ||
        l.includes("xsub") ||
        l.includes("eia_") ||
        l.includes("cea_") ||
        l.includes("arib")
      );
    };
    const pickedSubIdx = subTracks.findIndex((t) => t.selected && !isBitmap(t.codec));
    const fallbackSubIdx =
      pickedSubIdx >= 0
        ? pickedSubIdx
        : subTracks.findIndex((t) => !t.forced && !isBitmap(t.codec));
    return {
      introAudioIdx: selAudio >= 0 ? selAudio : null,
      introSubIdx: fallbackSubIdx >= 0 ? fallbackSubIdx : null,
      introSubCodec:
        fallbackSubIdx >= 0 ? subTracks[fallbackSubIdx]?.codec ?? null : null,
    };
  }, [tracks]);

  useEffect(() => {
    if (!loaded || !segmentDetectEnabled || !selectedFilePath) {
      introDetectGenRef.current += 1;
      useIntroStore.getState().setDetecting(false);
      void introCancelDetect();
      return;
    }

    const durationRounded = durationSecs > 0 ? Math.round(durationSecs) : 0;
    const reqSig = [
      normalizeIntroVideoKey(selectedFilePath),
      durationRounded > 0 ? "dur" : "nodur",
      introChaptersSig,
      introSiblingsSig,
      loadedSubPath ?? "",
      introAudioIdx ?? "",
      introSubIdx ?? "",
    ].join("::");

    if (introCheckedSigRef.current === reqSig) {
      return;
    }

    const curIntroState = useIntroStore.getState();
    // Skip redundant FFmpeg/audio scan if we already have chapter or cached audio match and chapters haven't changed
    if (
      introChapters.length === 0 &&
      curIntroState.segments.some((s) => s.source === "audioMatch") &&
      (!outroNextEnabled || Boolean(curIntroState.outro))
    ) {
      introCheckedSigRef.current = reqSig;
      return;
    }

    let cancelled = false;
    const gen = ++introDetectGenRef.current;
    const delayMs = introChapters.length > 0 ? 120 : 340;
    const timer = window.setTimeout(() => {
      if (cancelled || introDetectGenRef.current !== gen) return;
      useIntroStore.getState().setDetecting(true);
      void detectVideoIntro({
        videoPath: selectedFilePath,
        durationSecs: durationSecs > 0 ? durationSecs : 0,
        chapters: introChapters,
        siblingPaths: playlistItems.map((it) => it.path),
        subtitlePath: loadedSubPath,
        embeddedSubIdx: introSubIdx,
        embeddedSubCodec: introSubCodec,
        audioStreamIdx: introAudioIdx,
        lowPower: lowPowerMode,
      })
        .then((outcome) => {
          if (cancelled || introDetectGenRef.current !== gen) return;
          if (durationRounded > 0 || outcome.segments.length > 0) {
            introCheckedSigRef.current = reqSig;
          }
          useIntroStore.getState().setDetectedOutcome(selectedFilePath, outcome);
        })
        .catch(() => {
          if (cancelled || introDetectGenRef.current !== gen) return;
          useIntroStore.getState().setDetecting(false);
        });
    }, delayMs);

    return () => {
      // The backend cancels the previous run itself when a new one begins; an async cancel IPC
      // here could land after the next run starts and wrongly abort it.
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    loaded,
    segmentDetectEnabled,
    outroNextEnabled,
    selectedFilePath,
    durationSecs,
    introChapters,
    introChaptersSig,
    playlistItems,
    introSiblingsSig,
    loadedSubPath,
    introAudioIdx,
    introSubIdx,
    introSubCodec,
    lowPowerMode,
  ]);

  const subLangProbeCacheRef = useRef<Map<string, DetectedSubtitleLang[]>>(new Map());
  const subLangProbePendingRef = useRef<Set<string>>(new Set());
  const untaggedSubProbeTargets = useMemo(
    () => buildUntaggedSubtitleProbeList(tracks),
    [tracks],
  );
  const untaggedSubProbeSig = untaggedSubProbeTargets
    .map((t) => `${t.trackId}:${t.ffIndex ?? "x"}:${t.subStreamIdx}`)
    .join("|");

  useEffect(() => {
    if (!loaded || !selectedFilePath || untaggedSubProbeTargets.length === 0) return;
    const targetPath = selectedFilePath;
    const probeKey = `${targetPath}::${untaggedSubProbeSig}`;
    const cached = subLangProbeCacheRef.current.get(probeKey);
    if (cached) {
      if (cached.length > 0) {
        usePlayerStore.getState().mergeDetectedSubLangs(cached);
      }
      return;
    }
    if (subLangProbePendingRef.current.has(probeKey)) return;
    subLangProbePendingRef.current.add(probeKey);

    let cancelled = false;
    void detectEmbeddedSubtitleLanguages(targetPath, untaggedSubProbeTargets)
      .then((detected) => {
        subLangProbePendingRef.current.delete(probeKey);
        if (subLangProbeCacheRef.current.size >= 64) {
          const oldest = subLangProbeCacheRef.current.keys().next().value;
          if (oldest !== undefined) subLangProbeCacheRef.current.delete(oldest);
        }
        subLangProbeCacheRef.current.set(probeKey, detected);
        if (cancelled || useAppStore.getState().selectedFilePath !== targetPath) {
          return;
        }
        if (detected.length > 0) {
          usePlayerStore.getState().mergeDetectedSubLangs(detected);
        }
      })
      .catch(() => {
        subLangProbePendingRef.current.delete(probeKey);
      });

    return () => {
      cancelled = true;
    };
  }, [loaded, selectedFilePath, untaggedSubProbeSig, untaggedSubProbeTargets]);

  useEffect(() => {
    if (!loaded || !selectedFilePath || !isDesktop() || autoFetchSubtitles === "off") {
      return;
    }
    const targetPath = selectedFilePath;
    const langs = preferredSubtitleLangs || "eng";
    const mode = autoFetchSubtitles;
    const fetchKey = `${loadGenRef.current}::${targetPath}::${mode}::${langs}`;
    if (autoSubFetchedKeyRef.current === fetchKey) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || useAppStore.getState().selectedFilePath !== targetPath) {
        return;
      }
      const subNow = useSubtitleStore.getState();
      if (subNow.loadedFilePath || pendingPairedSubRef.current?.videoPath.toLowerCase() === targetPath.toLowerCase()) {
        autoSubFetchedKeyRef.current = fetchKey;
        return;
      }
      if (getSeriesTrackPref(deriveSeriesKeyForFile(targetPath))?.subLang === "off") {
        autoSubFetchedKeyRef.current = fetchKey;
        return;
      }
      const playerNow = usePlayerStore.getState();
      const subTracksNow = playerNow.tracks.filter((t) => t.type === "sub");
      if (mode === "missing" && subTracksNow.length > 0) {
        autoSubFetchedKeyRef.current = fetchKey;
        return;
      }
      if (
        mode === "language" &&
        hasMatchingSubtitleTrack(subTracksNow, langs, playerNow.detectedSubLangs)
      ) {
        autoSubFetchedKeyRef.current = fetchKey;
        return;
      }

      autoSubFetchedKeyRef.current = fetchKey;
      subNow.setAutoFetchState("searching", "Finding matching subtitles online…");

      void subtitleAutoFetchOnline({
        videoPath: targetPath,
        languages: langs,
        apiKey: openSubtitlesApiKey || null,
        privateTitles: useAppStore.getState().hashFilenames,
      })
        .then(async (res) => {
          if (cancelled || !mountedRef.current || useAppStore.getState().selectedFilePath !== targetPath) {
            return;
          }
          const latestSub = useSubtitleStore.getState();
          if (latestSub.loadedFilePath) {
            return;
          }
          if (res.found && res.downloaded) {
            await mpvAddSubtitle(res.downloaded.subtitlePath, "utf8");
            await mpvSetSubDelay(0);
            latestSub.setDelaySecs(0);
            latestSub.setLoadedTrack(res.downloaded.subtitlePath, res.downloaded.subtitlePath);
            await mpvSetSubStyle(buildSubStyleParams(useSubtitleStore.getState(), { visible: true }));
            const exactSuffix = res.downloaded.matchKind === "hash" ? " (Exact Match)" : "";
            latestSub.setAutoFetchState(
              "loaded",
              `Auto-loaded ${res.downloaded.languageLabel}${exactSuffix}`,
            );
            pushNote(
              "success",
              `Auto-loaded ${res.downloaded.languageLabel} subtitle${exactSuffix}`,
            );
          } else {
            latestSub.setAutoFetchState("none", "No automatic subtitle match found — try Search Online");
          }
        })
        .catch(() => {
          if (!cancelled && mountedRef.current && useAppStore.getState().selectedFilePath === targetPath) {
            useSubtitleStore
              .getState()
              .setAutoFetchState("none", "Online auto-fetch unavailable — try Search Online");
          }
        });
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loaded, selectedFilePath, autoFetchSubtitles, preferredSubtitleLangs, openSubtitlesApiKey, pushNote]);

  useEffect(() => {
    const timer = roomCode && !(roomSessionStartedRef.current && activeBackendRoomRef.current === roomCode)
      ? window.setTimeout(() => {
          roomSessionStartedRef.current = true;
          activeBackendRoomRef.current = roomCode;
          connectRoom(serverEndpoint, serverPassword);
        }, 0)
      : null;
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      if (!roomSessionStartedRef.current) {
        return;
      }
      if (activeBackendRoomRef.current && activeBackendRoomRef.current !== roomCode) {
        return;
      }
      roomSessionStartedRef.current = false;
      activeBackendRoomRef.current = null;
      autoCloudFallbackRoomRef.current = null;
      void enqueueSyncLifecycle(async () => {
        await syncDisconnect();
      });
    };
    // Initial room mount + room transition lifecycle; server config changes use onApplyServerConfig
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  // Stop embedded mpv child HWND only when leaving WatchRoom completely
  // Tear down any remaining Syncplay/mpv session when leaving WatchRoom entirely (HMR / ErrorBoundary / route switch)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const hadMpv = mpvLifecycleActiveRef.current || mpvStartedRef.current;
      mpvLifecycleActiveRef.current = false;
      mpvStartedRef.current = false;
      mpvStartPromiseRef.current = null;
      usePlayerStore.getState().setEngineSurfaceVisible(false);
      if (roomSessionStartedRef.current) {
        roomSessionStartedRef.current = false;
        activeBackendRoomRef.current = null;
        void enqueueSyncLifecycle(async () => {
          await syncDisconnect();
        });
      }
      if (hadMpv && isDesktop()) {
        void enqueueMpvLifecycle(async () => {
          await mpvStop().catch(() => undefined);
        });
      }
    };
  }, []);

  // Reconcile frontend loaded state with actual backend mpv surface state after mount / HMR / ErrorBoundary recovery
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    const reconcile = async () => {
      await listenersReadyPromiseRef.current;
      if (cancelled || !mountedRef.current) return;
      const genBefore = loadGenRef.current;
      try {
        const st = await mpvGetSurfaceState();
        if (
          cancelled ||
          !mountedRef.current ||
          loadGenRef.current !== genBefore ||
          loadInFlightRef.current
        ) {
          return;
        }
        const p = usePlayerStore.getState();
        p.setEngineSurfaceVisible(st.surfaceVisible);
        if (st.running) {
          mpvStartedRef.current = true;
          mpvLifecycleActiveRef.current = true;
          viewportTrackerRef.current.markInvalidated();
          setViewportTick((t) => t + 1);
          const appState = useAppStore.getState();
          safeMpvCall(
            mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !p.playerError),
            "mpvSetVisible:reconcile",
          );
          if (!st.hasMedia && p.loaded && !loadInFlightRef.current) {
            p.resetForNewFile();
            autoLoadedPathRef.current = null;
            setRecoveryTick((n) => n + 1);
          }
        } else {
          mpvStartedRef.current = false;
          mpvStartPromiseRef.current = null;
          mpvLifecycleActiveRef.current = false;
          if (p.loaded && !loadInFlightRef.current) {
            p.resetForNewFile();
            autoLoadedPathRef.current = null;
            setRecoveryTick((n) => n + 1);
          }
        }
      } catch {
        // Ignore outside Tauri runtime or transient unmount.
      }
    };
    void reconcile();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to mpv, window, and syncplay backend events
  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];
    const peerNotReadyPauseTimers = new Set<number>();
    let blockedVoiceTimer: number | null = null;
    let blockedVoiceNotified = false;
    let reconnectingVoiceTimer: number | null = null;
    let settled = false;
    let resolveReady!: () => void;
    listenersReadyPromiseRef.current = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const markListenersReady = () => {
      if (!settled) {
        settled = true;
        resolveReady();
      }
    };

    const unsubRuntimeLost = subscribeMpvRuntimeLost((reason) => {
      if (!active || leavingRef.current || loadInFlightRef.current) return;
      const p = usePlayerStore.getState();
      if (!p.loaded && !mpvStartedRef.current) return;
      mpvStartedRef.current = false;
      mpvStartPromiseRef.current = null;
      mpvLifecycleActiveRef.current = false;
      p.setEngineSurfaceVisible(false);
      if (p.loaded && !p.playerError) {
        const msg = "Playback engine stopped unexpectedly.";
        p.setPlayerError(msg);
        pushNote("error", msg);
        void logFrontendEvent("error", "player.runtime_lost", reason, "ERR_MPV_RUNTIME_LOST");
        const s = useSyncStore.getState();
        void handlePlayerCrashSync({
          syncConnected: s.status.state === "connected",
          wasPaused: p.paused,
          positionSecs: p.positionSecs,
          setLocalReady: s.setLocalReady,
          syncSetReady,
          syncUserPause,
          clearAnnouncementCache: () => {
            announcedFileKeyRef.current = null;
            autoReadyMarkedRef.current = false;
          },
        });
      }
    });
    unlisteners.push(unsubRuntimeLost);

    const setup = async () => {
      try {
        const fns = await Promise.all([
          onMpvTime((position, clientSeekSeq) => {
            if (!active || !shouldAcceptMpvTimeEvent(clientSeekSeq)) return;
            const prevPos = lastTimePosRef.current;
            lastTimePosRef.current = position;
            usePlayerStore.getState().setPositionSecs(position);
            const durNow = usePlayerStore.getState().durationSecs;
            if (durNow > 0 && prevPos < durNow * 0.3 && position >= durNow * 0.9 && position - prevPos > durNow * 0.5) {
              jumpedFromEarlyToEndRef.current = true;
            }
            if (Date.now() - lastResumeSaveAtRef.current >= 10_000) {
              saveCurrentResumePosition();
            }
            markCurrentEpisodeWatchedIfEligible(false);
            lastLoopSyncAtRef.current = detectAndSyncLoopWrap(
              prevPos,
              position,
              lastLoopSyncAtRef.current,
            );
          }),
          onMpvSeekSettled(() => {
            if (active) setSeekSettledTick((t) => t + 1);
          }),
          onMpvDuration((duration) => {
            if (active) usePlayerStore.getState().setDurationSecs(duration);
          }),
          onMpvPaused((paused) => {
            if (active) usePlayerStore.getState().setPaused(paused);
          }),
          onMpvFileLoaded(() => {
            if (!active) return;
            usePlayerStore.getState().setLoaded(true);
            usePlayerStore.getState().setPlayerError(null);
            viewportTrackerRef.current.markInvalidated();
            setViewportTick((t) => t + 1);
            if (usePlayerStore.getState().looping) {
              safeMpvCall(mpvSetLoop(true), "fileLoaded:mpvSetLoop");
            }
            const pendingSub = pendingPairedSubRef.current;
            const activePath = useAppStore.getState().selectedFilePath;
            if (
              pendingSub &&
              activePath &&
              activePath.toLowerCase() === pendingSub.videoPath.toLowerCase()
            ) {
              pendingPairedSubRef.current = null;
              void loadSubtitlePathRef.current?.(pendingSub.subPath);
            }
          }),
          onMpvSurfaceState((st) => {
            if (!active) return;
            const p = usePlayerStore.getState();
            p.setEngineSurfaceVisible(st.surfaceVisible);
            if (!st.running) {
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              mpvLifecycleActiveRef.current = false;
            } else {
              mpvStartedRef.current = true;
            }
          }),
          onMpvEnded((payload) => {
            if (!active) return;
            const decision = classifyMpvEnd(payload);
            if (decision.kind === "eof") {
              if (usePlayerStore.getState().looping) {
                lastTimePosRef.current = 0;
                lastLoopSyncAtRef.current = Date.now();
                handleLoopPlaybackAtEof();
                return;
              }
              usePlayerStore.getState().setEndedAtEof(true);
              usePlayerStore.getState().setPaused(true);
              markCurrentEpisodeWatchedIfEligible(true);
              const playlist = usePlaylistStore.getState();
              const seriesFolder = playlist.items[0] ? extractParentFolderPath(playlist.items[0].path) : "";
              const seriesKey = seriesFolder ? buildSeriesKey(seriesFolder) : "";
              const watchedKeys = seriesKey
                ? (useSeriesProgressStore.getState().getSeries(seriesKey)?.watchedKeys ?? [])
                : [];
              const syncNow = useSyncStore.getState();
              const syncConnNow = syncNow.status.state === "connected";
              const effUserNow = resolveEffectiveUsername(
                syncNow.status,
                useAppStore.getState().username,
              );
              const lockNow = getControllerLockState(
                syncConnNow,
                syncNow.participants,
                effUserNow,
                syncNow.roomControl,
              );
              const eofCheck = canTriggerAutoNextOnEof({
                autoPlayNext: playlist.autoPlayNext,
                currentIndex: playlist.currentIndex,
                itemsLength: playlist.items.length,
                items: playlist.items,
                watchedKeys,
                loadInFlight: loadInFlightRef.current,
                eofHandledForGen: eofHandledLoadGenRef.current,
                currentLoadGen: loadGenRef.current,
                lockedForLocalUser: lockNow.lockedForLocalUser,
              });
              if (eofCheck.advance && eofCheck.nextIndex !== null) {
                eofHandledLoadGenRef.current = loadGenRef.current;
                const nextEp = playlist.items[eofCheck.nextIndex];
                pushNote("info", `Up next: ${nextEp.episodeBadge ?? nextEp.cleanTitle}`);
                void selectEpisodeAtIndexRef.current?.(eofCheck.nextIndex, "autoNext");
              }
            } else if (decision.kind === "error") {
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              mpvLifecycleActiveRef.current = false;
              const p = usePlayerStore.getState();
              const s = useSyncStore.getState();
              p.setEngineSurfaceVisible(false);
              p.setPlayerError(decision.message);
              pushNote("error", decision.message);
              void logFrontendEvent("error", "player.ended", decision.message, "ERR_MPV_ENDED");
              void handlePlayerCrashSync({
                syncConnected: s.status.state === "connected",
                wasPaused: p.paused,
                positionSecs: p.positionSecs,
                setLocalReady: s.setLocalReady,
                syncSetReady,
                syncUserPause,
                clearAnnouncementCache: () => {
                  announcedFileKeyRef.current = null;
                  autoReadyMarkedRef.current = false;
                },
              });
            }
          }),
          onMpvTracks((tracks) => {
            if (!active) return;
            usePlayerStore.getState().setTracks(tracks);
            autoEnableEmbeddedSubtitle(tracks);
          }),
          onAutoSyncProgress((stage) => {
            if (!active) return;
            useSubtitleStore.getState().setAutoSyncStage(stage);
          }),
          onMpvChapters((chapters) => {
            if (!active) return;
            useIntroStore.getState().setChapters(chapters);
          }),
          onMpvCommandWarning((msg) => {
            if (active) pushNote("warn", msg);
          }),
          onMpvError((msg) => {
            if (!active) return;
            mpvStartedRef.current = false;
            mpvStartPromiseRef.current = null;
            mpvLifecycleActiveRef.current = false;
            const p = usePlayerStore.getState();
            const s = useSyncStore.getState();
            p.setEngineSurfaceVisible(false);
            p.setPlayerError(msg);
            pushNote("error", msg);
            void logFrontendEvent("error", "player.error", msg, "ERR_MPV");
            void handlePlayerCrashSync({
              syncConnected: s.status.state === "connected",
              wasPaused: p.paused,
              positionSecs: p.positionSecs,
              setLocalReady: s.setLocalReady,
              syncSetReady,
              syncUserPause,
              clearAnnouncementCache: () => {
                announcedFileKeyRef.current = null;
                autoReadyMarkedRef.current = false;
              },
            });
          }),
          onMpvSurfaceClick(() => {
            if (active) hideChrome();
          }),
          onMpvSurfaceDblClick(() => {
            if (active) toggleFullscreen();
          }),
          onWindowFullscreen((fs) => {
            if (active) {
              usePlayerStore.getState().setIsFullscreen(fs);
              setViewportTick((t) => t + 1);
            }
          }),
          onWindowRestored(() => {
            if (active) {
              viewportTrackerRef.current.markInvalidated();
              setViewportTick((t) => t + 1);
            }
          }),
          onSyncStatus((status) => {
            if (!active) return;
            useSyncStore.getState().setStatus(status);
            if (status.state === "connected") {
              const appNow = useAppStore.getState();
              if (appNow.roomCode) {
                useRecentRoomsStore.getState().recordJoin({
                  roomName: appNow.roomCode,
                  serverHost: appNow.serverEndpoint,
                  literalRoom: appNow.literalRoom,
                  hasPassword: Boolean(appNow.serverPassword),
                  hostOnly: appNow.hostOnlyRoom,
                  lastFilePath: appNow.selectedFilePath || undefined,
                });
              }
            } else {
              useNotificationStore.getState().dismissByTagPrefix(NOT_READY_TAG_PREFIX);
            }
            syncDisconnectTrackerRef.current.onStatus(
              status,
              Boolean(useAppStore.getState().roomCode),
            );
            const appNow = useAppStore.getState();
            if (
              status.state === "error" &&
              status.suggestBackup &&
              status.endpoint &&
              isCloudEndpoint(status.endpoint) &&
              status.message?.includes("capacity or rate-limited") &&
              appNow.roomCode &&
              autoCloudFallbackRoomRef.current !== appNow.roomCode
            ) {
              autoCloudFallbackRoomRef.current = appNow.roomCode;
              void enqueueSyncLifecycle(async () => {
                try {
                  await syncSwitchBackup({
                    username: appNow.username,
                    roomCode: appNow.roomCode,
                    literalRoom: appNow.literalRoom,
                    password: appNow.serverPassword || null,
                    hostOnly: appNow.hostOnlyRoom,
                    targetEndpoint: SYNCPLAY_ENDPOINT,
                  });
                  pushNote("info", "Epilod Cloud is at capacity — switched to Syncplay fallback.");
                } catch {
                  // Manual Retry / Backup buttons remain available in RoomPanel.
                }
              });
            }
          }),
          onSyncRoomRerolled(({ roomCode: nextCode }) => {
            if (!active || !nextCode) return;
            if (useAppStore.getState().roomCode === nextCode) return;
            activeBackendRoomRef.current = nextCode;
            useAppStore.getState().applyRerolledRoomCode(nextCode);
            try {
              void navigator.clipboard?.writeText(nextCode).catch(() => undefined);
            } catch {
              // ignore clipboard restriction
            }
            pushNote(
              "info",
              `Code was already in use — switched to ${formatRoomCodeDisplay(nextCode)} and copied it.`,
              6500,
            );
          }),
          onSyncParticipants((list) => {
            if (!active) return;
            const prevParticipants = useSyncStore.getState().participants;
            useSyncStore.getState().setParticipants(list);
            const syncState = useSyncStore.getState();
            const effUser = resolveEffectiveUsername(syncState.status, useAppStore.getState().username);
            const notReady = getNotReadyPeers(
              syncState.status.state === "connected",
              list,
              effUser,
            );
            const noteStore = useNotificationStore.getState();
            for (const p of list) {
              noteStore.dismissByTag(peerDisconnectedTag(p.username));
            }
            if (notReady.length === 0) {
              noteStore.dismissByTagPrefix(NOT_READY_TAG_PREFIX);
            } else {
              const notReadyKeys = new Set(notReady.map((p) => p.username.trim().toLowerCase()));
              for (const p of list) {
                const key = p.username.trim().toLowerCase();
                if (p.isReady && !notReadyKeys.has(key)) {
                  noteStore.dismissByTag(peerNotReadyTag(p.username));
                }
              }
              const prevReadySig = prevParticipants
                .map((p) => `${p.username.toLowerCase()}:${p.isReady ? 1 : 0}`)
                .join("|");
              const nextReadySig = list
                .map((p) => `${p.username.toLowerCase()}:${p.isReady ? 1 : 0}`)
                .join("|");
              if (prevReadySig !== nextReadySig) {
                noteStore.dismissByTag(PLAY_BLOCKED_TAG);
              }
            }
          }),
          onSyncPeerNotReady(({ username: peerName, manual }) => {
            if (!active) return;
            const notice = formatPeerNotReadyNotice(peerName);
            pushNote("warn", notice, 5500, peerNotReadyTag(peerName));
            const pState = usePlayerStore.getState();
            pState.flashFeedback(`${peerName.trim() || "Someone"} is not ready`);

            const sState = useSyncStore.getState();
            const effUser = resolveEffectiveUsername(sState.status, useAppStore.getState().username);
            const ctrlLock = getControllerLockState(
              sState.status.state === "connected",
              sState.participants,
              effUser,
              sState.roomControl,
            );

            if (!pState.paused) {
              if (ctrlLock.hasControllers && ctrlLock.localIsController) {
                pState.setPaused(true);
                void safeMpvCall(mpvSetPause(true), "peerNotReady:mpvSetPause");
                void syncUserPause(pState.positionSecs).catch(() => undefined);
              } else if (!ctrlLock.lockedForLocalUser && manual) {
                const timerId = window.setTimeout(() => {
                  peerNotReadyPauseTimers.delete(timerId);
                  if (!active) return;
                  const playerNow = usePlayerStore.getState();
                  const syncNow = useSyncStore.getState();
                  if (playerNow.paused || syncNow.status.state !== "connected") return;
                  const peerStillNotReady = syncNow.participants.some(
                    (p) =>
                      p.username.trim().toLowerCase() === peerName.trim().toLowerCase() &&
                      !p.isReady,
                  );
                  if (peerStillNotReady) {
                    playerNow.setPaused(true);
                    void safeMpvCall(mpvSetPause(true), "peerNotReadyFallback:mpvSetPause");
                    void syncUserPause(playerNow.positionSecs).catch(() => undefined);
                  }
                }, 300);
                peerNotReadyPauseTimers.add(timerId);
              }
            }
          }),
          onSyncPeerLeft(({ username: peerName }) => {
            if (!active) return;
            handlePeerDisconnected(peerName);
            if (useAppStore.getState().osdEnabled && usePlayerStore.getState().loaded) {
              safeMpvCall(mpvShowOsdText(`${peerName} left`), "osd:peerLeft");
            }
          }),
          onSyncPlayBlocked(({ usernames }) => {
            if (!active) return;
            const playerNow = usePlayerStore.getState();
            playerNow.setPaused(true);
            const msg = formatPlayBlockedByNotReadyMessage(usernames);
            const fb = formatPlayBlockedFeedback(usernames);
            pushNote("warn", msg, 5500, PLAY_BLOCKED_TAG);
            playerNow.flashFeedback(fb);
          }),
          onSyncError((msg) => {
            if (!active) return;
            useSyncStore.getState().setLastError(msg);
            if (/password|auth/i.test(msg)) {
              const appNow = useAppStore.getState();
              if (appNow.roomCode) {
                const roomId = buildRecentRoomId(
                  appNow.roomCode,
                  appNow.serverEndpoint,
                  appNow.literalRoom,
                );
                useRecentRoomsStore.getState().setEncryptedPassword(roomId, undefined);
              }
            }
            pushNote("error", msg);
          }),
          onSyncServerOverride((setBy) => {
            if (!active) return;
            const notice = formatControllerOverrideNotice(setBy);
            useSyncStore.getState().setServerOverrideNotice(notice);
            pushNote("info", notice);
          }),
          onSyncTimelineTransform((tx) => {
            if (!active) return;
            const syncStore = useSyncStore.getState();
            syncStore.setTimelineTransform(tx);
            if (syncStore.status.state === "connected") {
              usePlayerStore.getState().setSpeed(tx.scale);
            }
            const appNow = useAppStore.getState();
            const playerNow = usePlayerStore.getState();
            const effUser = resolveEffectiveUsername(syncStore.status, appNow.username);
            const targetPeer = findAlignmentTargetPeer(syncStore.participants, effUser);
            const pairKey = buildAlignmentPairKey(
              appNow.selectedFileName,
              playerNow.durationSecs,
              targetPeer?.fileName,
              targetPeer?.fileDuration,
            );
            saveSourceAlignment(pairKey, tx);
          }),
          onSyncRoomState(({ position, paused: roomPaused }) => {
            if (!active) return;
            useSyncStore.getState().setLiveRoomState(position, roomPaused);
          }),
          onSyncTimelineSegments((segments) => {
            if (!active) return;
            useSyncStore.getState().setTimelineSegments(segments);
          }),
          onSyncP2pStatus((p2p) => {
            if (!active) return;
            useSyncStore.getState().setP2pStatus(p2p);
          }),
          onSyncAutoAligned((evt) => {
            if (!active) return;
            usePlayerStore.getState().flashFeedback(evt.summary);
            pushNote("info", evt.summary);
          }),
          onSyncRoomControl((rc) => {
            if (!active) return;
            useSyncStore.getState().setRoomControl(rc);
          }),
          onSyncControlNotice((notice) => {
            if (!active) return;
            const formatted = formatControlNoticeMessage(
              notice,
              useSyncStore.getState().roomControl,
            );
            if (!formatted) return;
            pushNote(formatted.level, formatted.text, 5500);
            if (formatted.feedback) {
              usePlayerStore.getState().flashFeedback(formatted.feedback);
            }
            if (useAppStore.getState().osdEnabled && usePlayerStore.getState().loaded) {
              safeMpvCall(mpvShowOsdText(formatted.feedback || formatted.text), "osd:controlNotice");
            }
          }),
          onSyncRatingVote((vote) => {
            if (!active) return;
            const rStore = useRatingStore.getState();
            rStore.receivePeerVote(vote.key, vote.username, vote.avatarId, vote.score);
            const localKey =
              rStore.activeKey ??
              buildRatingKey(
                useAppStore.getState().selectedFileName,
                usePlayerStore.getState().durationSecs,
              );
            if (localKey && localKey !== vote.key) {
              const peer = useSyncStore
                .getState()
                .participants.find(
                  (p) => p.username.trim().toLowerCase() === vote.username.trim().toLowerCase(),
                );
              if (!peer || peer.sourceRelation !== "differentMedia") {
                rStore.receivePeerVote(localKey, vote.username, vote.avatarId, vote.score);
              }
            }
          }),
          onSyncReaction((reaction) => {
            if (!active) return;
            if (!useAppStore.getState().reactionsEnabled) return;
            enqueueReactionBurst({
              username: reaction.username,
              avatarId: reaction.avatarId,
              emoji: reaction.emoji,
              count: reaction.count,
              isSelf: false,
            });
          }),
          onSyncChat((chatMsg) => {
            if (!active) return;
            const chatStore = useChatStore.getState();
            const appState = useAppStore.getState();
            const syncState = useSyncStore.getState();
            const allowPeek = appState.chatPeeksEnabled;
            const localUsername = resolveEffectiveUsername(syncState.status, appState.username);
            const added = chatStore.receiveRemoteMessage(
              {
                id: chatMsg.id,
                sender: chatMsg.username,
                avatarId: chatMsg.avatarId,
                text: chatMsg.text,
                replyToId: chatMsg.replyToId ?? null,
                via: chatMsg.via,
              },
              { allowPeek, localUsername },
            );
            if (added && !chatStore.chatOpen) {
              playSoundCue("chatMessage", {
                moviePlaying: !usePlayerStore.getState().paused,
              });
            }
          }),
          onSyncChatEdit((edit) => {
            if (!active) return;
            useChatStore
              .getState()
              .applyMessageEdit(edit.targetMsgId, edit.username, edit.text, { isSelf: false });
          }),
          onSyncChatReact((react) => {
            if (!active) return;
            useChatStore
              .getState()
              .toggleMessageReaction(react.targetMsgId, react.username, react.emoji);
          }),
          onSyncChatTyping((typing) => {
            if (!active) return;
            useChatStore.getState().setPeerTyping(typing.username, typing.isTyping);
          }),
          onSyncSubtitleShared((payload) => {
            if (!active) return;
            const added = useSubtitleStore.getState().addSharedSubtitle({
              id: payload.id,
              sender: payload.sender,
              fileName: payload.fileName,
              ext: payload.ext,
              lang: payload.lang ?? null,
              content: payload.content,
              sizeBytes: payload.sizeBytes,
            });
            if (added) {
              useNotificationStore.getState().push(
                "info",
                `${payload.sender} shared "${payload.fileName}"`,
                10000,
                `shared-sub:${payload.id}`,
                {
                  label: "Apply",
                  onClick: () => {
                    void applySharedRoomSubtitle(payload.id);
                  },
                },
              );
            }
          }),
          onSyncPeerSeek(({ username, deltaSecs }) => {
            if (!active) return;
            const rawAbs = Math.abs(deltaSecs);
            if (!Number.isFinite(rawAbs) || rawAbs < 1) return;
            const snapped =
              Math.abs(rawAbs - 10) <= 1.2
                ? 10
                : Math.abs(rawAbs - 5) <= 0.9
                  ? 5
                  : Math.round(rawAbs);
            usePlayerStore.getState().flashSeekCue({
              direction: deltaSecs < 0 ? "back" : "forward",
              deltaSecs: snapped,
              actor: username,
            });
          }),
          onVoiceRoster((roster) => {
            if (!active) return;
            const prevState = useVoiceStore.getState();
            prevState.setRoster(roster);

            const selfUser = resolveEffectiveUsername(
              useSyncStore.getState().status,
              useAppStore.getState().username,
            );
            const diff = diffVoiceRosterPeers(voicePeerMapRef.current, roster, selfUser);
            const isSeed = voicePeerMapRef.current === null;
            voicePeerMapRef.current = diff.nextMap;

            const pNow = usePlayerStore.getState();
            const moviePlayingNow = pNow.loaded && !pNow.paused;
            const nowMs = Date.now();

            if (!isSeed && prevState.voiceEnabled) {
              for (const user of diff.joinedUsers) {
                const key = user.trim().toLowerCase();
                const leftAt = voiceLeftAtRef.current.get(key) ?? 0;
                if (nowMs - leftAt < 4000) continue; // Suppress rapid reconnect flap
                if (prevState.joined) {
                  playSoundCue("peerVoiceJoined", { moviePlaying: moviePlayingNow });
                } else {
                  playSoundCue("peerVoiceJoined", { moviePlaying: moviePlayingNow });
                  if (nowMs - lastVoiceInviteToastAtRef.current > 12000) {
                    lastVoiceInviteToastAtRef.current = nowMs;
                    pushNote("info", `${user} started voice chat`, 8000, "voice-peer-started", {
                      label: "Join",
                      onClick: () => {
                        void joinVoiceSession().then((outcome) => {
                          if (outcome === "needsBtConfirm") {
                            setSideTab("room");
                            setPanelOpen(true);
                          }
                        });
                      },
                    });
                  }
                }
              }
              if (prevState.joined) {
                for (const user of diff.leftUsers) {
                  voiceLeftAtRef.current.set(user.trim().toLowerCase(), nowMs);
                  playSoundCue("peerVoiceLeft", { moviePlaying: moviePlayingNow });
                }
              }
            }

            // Surface blocked P2P voice peers globally after 4s grace window
            const blockedNames = roster
              .filter((r) => r.inVoice && r.transport === "blocked")
              .map((r) => r.username);
            if (prevState.joined && blockedNames.length > 0) {
              if (blockedVoiceTimer === null && !blockedVoiceNotified) {
                blockedVoiceTimer = window.setTimeout(() => {
                  blockedVoiceTimer = null;
                  if (!active || !useVoiceStore.getState().joined) return;
                  const currentBlocked = useVoiceStore
                    .getState()
                    .roster.filter((r) => r.inVoice && r.transport === "blocked");
                  if (currentBlocked.length === 0) return;
                  blockedVoiceNotified = true;
                  const names = currentBlocked.map((b) => b.username).join(", ");
                  pushNote(
                    "warn",
                    `Direct voice blocked for ${names} — check Relay settings in Voice & Audio.`,
                    7500,
                    VOICE_PEER_BLOCKED_NOTE_TAG,
                    {
                      label: "Voice & Audio",
                      onClick: () => useAppStore.getState().openSettings("voice"),
                    },
                  );
                }, 4000);
              }
            } else {
              if (blockedVoiceTimer !== null) {
                window.clearTimeout(blockedVoiceTimer);
                blockedVoiceTimer = null;
              }
              if (blockedVoiceNotified) {
                blockedVoiceNotified = false;
                useNotificationStore.getState().dismissByTag(VOICE_PEER_BLOCKED_NOTE_TAG);
              }
            }
          }),
          onVoiceSpeaking((speakers) => {
            if (!active) return;
            useVoiceStore.getState().setSpeakingPeers(speakers);
          }),
          onVoiceLevel((lvl) => {
            if (!active) return;
            useVoiceStore.getState().setLocalLevel(lvl.db, lvl.speechProb, lvl.gateOpen);
          }),
          onVoiceLocalState((st) => {
            if (!active) return;
            const prevVoice = useVoiceStore.getState();
            const changed =
              prevVoice.muted !== st.muted || prevVoice.deafened !== st.deafened;
            prevVoice.applyLocalState(st.muted, st.deafened, st.pttActive);
            if (changed && prevVoice.joined) {
              prevVoice.flashMicCue(st.muted || st.deafened);
              const p = usePlayerStore.getState();
              p.flashFeedback(
                st.deafened
                  ? "Audio & Mic Deafened"
                  : st.muted
                    ? "Mic Muted"
                    : "Mic Unmuted",
              );
              playSoundCue(st.muted || st.deafened ? "micMuted" : "micUnmuted", {
                moviePlaying: p.loaded && !p.paused,
              });
            }
          }),
          onVoiceStatus((st) => {
            if (!active) return;
            const vNow = useVoiceStore.getState();
            vNow.applyStatusPayload(st);
            if (!vNow.joined) return;
            const noteStore = useNotificationStore.getState();
            if (st.streamStatus === "micBusy" || st.streamStatus === "permissionDenied") {
              if (reconnectingVoiceTimer !== null) {
                window.clearTimeout(reconnectingVoiceTimer);
                reconnectingVoiceTimer = null;
              }
              const msg =
                st.streamStatus === "permissionDenied"
                  ? "Microphone permission denied by Windows Privacy."
                  : st.streamError ?? "Microphone is in exclusive use by another app.";
              pushNote("error", msg, 8000, VOICE_HEALTH_NOTE_TAG, {
                label: "Voice & Audio",
                onClick: () => useAppStore.getState().openSettings("voice"),
              });
            } else if (st.streamStatus === "reconnecting") {
              if (reconnectingVoiceTimer === null) {
                reconnectingVoiceTimer = window.setTimeout(() => {
                  reconnectingVoiceTimer = null;
                  if (!active) return;
                  const s = useVoiceStore.getState();
                  if (s.joined && s.streamStatus === "reconnecting") {
                    pushNote(
                      "warn",
                      s.streamError ?? "Audio device lost — reconnecting…",
                      6500,
                      VOICE_HEALTH_NOTE_TAG,
                      {
                        label: "Voice & Audio",
                        onClick: () => useAppStore.getState().openSettings("voice"),
                      },
                    );
                  }
                }, 2200);
              }
            } else if (st.bluetoothHfpDropped) {
              pushNote(
                "warn",
                "Bluetooth mic dropped into low-quality mode — switch mic or Listen Only.",
                7500,
                VOICE_HEALTH_NOTE_TAG,
                {
                  label: "Voice & Audio",
                  onClick: () => useAppStore.getState().openSettings("voice"),
                },
              );
            } else if (st.streamStatus === "live") {
              if (reconnectingVoiceTimer !== null) {
                window.clearTimeout(reconnectingVoiceTimer);
                reconnectingVoiceTimer = null;
              }
              noteStore.dismissByTag(VOICE_HEALTH_NOTE_TAG);
            }
          }),
          onVoiceDevicesChanged(() => {
            if (!active) return;
            const s = useVoiceStore.getState();
            void voiceListDevices(s.inputDevice, s.outputDevice)
              .then((d) => {
                if (active) useVoiceStore.getState().setDevices(d);
              })
              .catch(() => undefined);
          }),
        ]);

        if (!active) {
          fns.forEach((fn) => fn());
        } else {
          unlisteners.push(...fns);
        }
      } finally {
        markListenersReady();
      }

      // Sync initial fullscreen state if OS entered fullscreen externally
      const initialFs = await windowIsFullscreen().catch(() => false);
      if (active) usePlayerStore.getState().setIsFullscreen(initialFs);
      void voiceSetConfig(useVoiceStore.getState().toConfigDto()).catch(() => undefined);
      useVoiceStore.getState().syncAllPeerVolumesToBackend();
    };

    void setup();

    return () => {
      active = false;
      markListenersReady();
      if (blockedVoiceTimer !== null) {
        window.clearTimeout(blockedVoiceTimer);
        blockedVoiceTimer = null;
      }
      if (reconnectingVoiceTimer !== null) {
        window.clearTimeout(reconnectingVoiceTimer);
        reconnectingVoiceTimer = null;
      }
      for (const timerId of peerNotReadyPauseTimers) {
        window.clearTimeout(timerId);
      }
      peerNotReadyPauseTimers.clear();
      unlisteners.forEach((fn) => fn());
    };
  }, [hideChrome, pushNote, toggleFullscreen]);

  // Tauri native drag-and-drop (Fixes 16 & 19)
  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const bindDrop = async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onDragDropEvent(async (event) => {
          if (disposed) return;
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsDragActive(true);
            return;
          }
          if (payload.type === "leave") {
            setIsDragActive(false);
            return;
          }
          if (payload.type === "drop") {
            setIsDragActive(false);
            const dropGate = checkDropDuringDialog(dialogOpenRef.current);
            if (!dropGate.allowed) {
              if (dropGate.notice) pushNote("info", dropGate.notice);
              return;
            }
            await loadMediaInputs(payload.paths || []);
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch {
        // Ignore if running outside Tauri webview window
      }
    };

    void bindDrop();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadMediaInputs, pushNote]);

  // Files opened from Windows ("Open with" / double-click) while a room is active.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path) void loadMediaInputs([path]);
    };
    window.addEventListener(OPEN_FILE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FILE_EVENT, onOpen);
  }, [loadMediaInputs]);

  // Keep child mpv HWND spanning the full stage container so live margin shifts never recreate its swapchain (Fix 15)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current || surfaceHoldPending) {
      return;
    }
    const plan = viewportTrackerRef.current.planResize(stageRect);
    if (plan.send) {
      safeMpvCall(mpvResize(stageRect, plan.forceFlag), "mpvResize");
    }
  }, [stageRect, surfaceHoldPending]);

  const modalPresence = useAnimatedPresence(settingsOpen || shortcutsOpen, 200);
  const modalBlockingVideo = settingsOpen || shortcutsOpen || modalPresence.mounted;
  const videoSurfacePaused = modalBlockingVideo;

  // Hide child HWND while fullscreen modals or player failure cover video (Fix 16)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    const shouldShow = !videoSurfacePaused && !playerError && !dialogOpenRef.current;
    if (!shouldShow) {
      ++surfaceRestoreSeqRef.current;
      if (surfaceHoldTimerRef.current !== null) {
        window.clearTimeout(surfaceHoldTimerRef.current);
        surfaceHoldTimerRef.current = null;
      }
      setSurfaceHoldPending(false);

      const cached = getLastCleanFreezeFrame();
      if (cached && !usePlayerStore.getState().frozenFrame) {
        usePlayerStore.getState().setFrozenFrame(cached);
      }
      if (
        !playerError &&
        usePlayerStore.getState().loaded &&
        usePlayerStore.getState().engineSurfaceVisible
      ) {
        let cancelled = false;
        void (async () => {
          const snap = await captureCleanFrozenFrame(1280, 720);
          if (snap && !cancelled) {
            usePlayerStore.getState().setFrozenFrame(snap);
          }
          if (!cancelled) {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
          }
          if (!cancelled) {
            safeMpvCall(mpvSetVisible(false), "mpvSetVisible");
          }
        })();
        return () => {
          cancelled = true;
        };
      }
      safeMpvCall(mpvSetVisible(false), "mpvSetVisible");
      return;
    }

    if (!usePlayerStore.getState().engineSurfaceVisible) {
      void restoreLiveMpvSurfaceAfterPause();
    } else {
      safeMpvCall(mpvSetVisible(true), "mpvSetVisible");
    }
  }, [videoSurfacePaused, playerError, loaded, restoreLiveMpvSurfaceAfterPause]);

  // Wake/auto-hide cinema chrome & allow Escape to close floating popover
  useEffect(() => {
    wakeChrome();
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [
    loaded,
    paused,
    isFullscreen,
    fullWidthPlayBar,
    panelOpen,
    contextMenu,
    settingsOpen,
    shortcutsOpen,
    playerError,
    alignMode,
    wakeChrome,
  ]);

  useEffect(() => {
    const onPointerActivity = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-docked-sidebar="true"]')) {
        return;
      }
      onPassivePointerMove();
    };
    const onDocumentMouseLeave = () => {
      barHoveredRef.current = false;
      if (canAutoHideChromeNow()) {
        hideChrome();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Tab" && !isTextEntryElement(e.target)) {
        wakeChrome();
      }
      if (
        e.code === "Escape" &&
        !useAppStore.getState().settingsOpen &&
        !useAppStore.getState().shortcutsOpen
      ) {
        if (panelOpenRef.current) {
          setPanelOpen(false);
        } else if (effectivePartyOpenRef.current && !partyDockedRef.current) {
          setPartySidebarOpenSmoothRef.current(false);
        } else if (useChatStore.getState().chatOpen) {
          setChatSidebarOpenSmoothRef.current(false);
        }
      }
    };
    window.addEventListener("mousemove", onPointerActivity, { passive: true });
    document.addEventListener("mouseleave", onDocumentMouseLeave);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onPointerActivity);
      document.removeEventListener("mouseleave", onDocumentMouseLeave);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canAutoHideChromeNow, hideChrome, onPassivePointerMove, wakeChrome]);

  const syncStatusState = syncStatus.state;
  const syncActiveEndpoint =
    syncStatus.state === "disconnected" ? serverEndpoint : syncStatus.endpoint || serverEndpoint;

  // Fix 02 + Fix 08 + Fix 09: Announce loaded file per session, auto-ready once loaded, and lock speed 1.0x
  useEffect(() => {
    const syncConnected = syncStatusState === "connected";

    const decision = shouldAnnounceFile(announcedFileKeyRef.current, {
      syncConnected,
      endpoint: syncActiveEndpoint,
      username,
      roomCode,
      fileName: selectedFileName,
      loaded,
      durationSecs,
      hashIdentity: hashFilenames,
    });
    announcedFileKeyRef.current = decision.nextKey;

    if (decision.announce && selectedFileName) {
      void syncSetFile({
        name: selectedFileName,
        path: selectedFilePath,
        durationSecs,
        hashIdentity: hashFilenames,
      });
    }

    if (
      shouldAutoReadyOnFileLoad({
        syncConnected,
        loaded,
        alreadyAutoMarked: autoReadyMarkedRef.current,
      })
    ) {
      autoReadyMarkedRef.current = true;
      useSyncStore.getState().setLocalReady(true);
      void syncSetReady(true, false);
    }

    if (shouldResetSpeedForSync(syncConnected, speed, timelineScale)) {
      usePlayerStore.getState().setSpeed(timelineScale);
      safeMpvCall(mpvSetSpeed(timelineScale), "mpvSetSpeed");
    }
  }, [
    durationSecs,
    hashFilenames,
    loaded,
    roomCode,
    selectedFileName,
    selectedFilePath,
    speed,
    syncActiveEndpoint,
    syncStatusState,
    timelineScale,
    username,
  ]);

  // Auto-restore previously saved source offset/FPS calibration when resuming with a differing peer encode
  useEffect(() => {
    if (syncStatus.state !== "connected" || !loaded || !selectedFileName || durationSecs <= 0) {
      if (syncStatus.state !== "connected") {
        restoredAlignmentPairRef.current = null;
      }
      return;
    }
    const effUser = resolveEffectiveUsername(syncStatus, username);
    const peer = findAlignmentTargetPeer(participants, effUser);
    if (!peer || peer.fileMatch === "matched") {
      return;
    }
    const pairKey = buildAlignmentPairKey(
      selectedFileName,
      durationSecs,
      peer.fileName,
      peer.fileDuration,
    );
    if (!pairKey || restoredAlignmentPairRef.current === pairKey) {
      return;
    }
    restoredAlignmentPairRef.current = pairKey;
    const currentIdentity = isIdentityTransform({
      offsetSecs: timelineOffsetSecs,
      scale: timelineScale,
    });
    if (!currentIdentity) return;
    const saved = loadSavedSourceAlignment(pairKey);
    if (!saved) return;
    useSyncStore.getState().setTimelineTransform(saved);
    usePlayerStore.getState().setSpeed(saved.scale);
    safeMpvCall(mpvSetSpeed(saved.scale), "restore:mpvSetSpeed");
    void syncSetTimelineTransform(saved).catch(() => undefined);
    pushNote(
      "info",
      `Restored saved source alignment (${formatSignedOffset(saved.offsetSecs)}).`,
    );
  }, [
    durationSecs,
    loaded,
    participants,
    pushNote,
    selectedFileName,
    syncStatus,
    timelineOffsetSecs,
    timelineScale,
    username,
  ]);

  // Subtle room audio cues when joining, peers entering/leaving, or all viewers ready
  useEffect(() => {
    soundTrackerRef.current.reset();
    syncDisconnectTrackerRef.current.reset();
    return () => {
      soundTrackerRef.current.reset();
      syncDisconnectTrackerRef.current.reset();
    };
  }, [roomCode]);

  useEffect(() => {
    const cues = soundTrackerRef.current.update(syncStatus, participants, username);
    if (cues.length === 0) return;
    const player = usePlayerStore.getState();
    const moviePlaying = player.loaded && !player.paused;
    for (const cue of cues) {
      playSoundCue(cue, { moviePlaying });
    }
  }, [participants, syncStatus, username]);

  // Follow controller / party member when switching episodes within a loaded season queue
  useEffect(() => {
    const syncConnectedNow = syncStatus.state === "connected";
    const effUserNow = resolveEffectiveUsername(syncStatus, username);
    const ctrlLockNow = getControllerLockState(
      syncConnectedNow,
      participants,
      effUserNow,
      roomControl,
    );
    const nowMs = Date.now();
    const decision = resolveFollowPartyEpisode({
      syncConnected: syncConnectedNow,
      followPartyEpisode,
      participants,
      localUsername: effUserNow,
      playlistItems,
      playlistIndex,
      loadInFlight: loadingMedia || loadInFlightRef.current,
      previousPeerFile: lastPeerFileRef.current,
      justAdvancedFromPath: justAdvancedFromPathRef.current,
      hasControllers: ctrlLockNow.hasControllers,
      localIsController: ctrlLockNow.localIsController,
      recentLocalSwitches: recentLocalSwitchesRef.current,
      recentFollowTimestamps: recentFollowTimestampsRef.current,
      nowMs,
    });
    lastPeerFileRef.current = decision.nextPeerFile;
    if (decision.action === "follow") {
      recentFollowTimestampsRef.current = [
        ...recentFollowTimestampsRef.current.filter((t) => nowMs - t < 10_000),
        nowMs,
      ].slice(-10);
      pushNote(
        "info",
        `Following ${decision.leaderUsername} to ${
          decision.target.episodeBadge ?? decision.target.cleanTitle
        }`,
      );
      void switchToPartyEpisode(decision.targetIndex, "follow");
    }
  }, [
    followPartyEpisode,
    loadingMedia,
    participants,
    playlistIndex,
    playlistItems,
    pushNote,
    roomControl,
    switchToPartyEpisode,
    syncStatus,
    username,
  ]);

  const chrome = resolveFullscreenChromeState({
    isFullscreen,
    panelOpen,
    modalsOpen: settingsOpen || shortcutsOpen,
  });

  const showFloatingCapsule = chrome.showTransportBar && !chromeIdle;
  const showWindowBar = !isFullscreen && !chromeIdle;
  const desktopRuntime = isDesktop();
  const showVideoBackdrop =
    loaded &&
    !playerError &&
    !videoSurfacePaused &&
    !surfaceHoldPending &&
    (!desktopRuntime || engineSurfaceVisible);

  useEffect(() => {
    if (showcaseCfg) return;
    if (!frozenFrame) return;
    if (
      loaded &&
      !playerError &&
      !videoSurfacePaused &&
      !surfaceHoldPending &&
      (!desktopRuntime || engineSurfaceVisible)
    ) {
      const timer = window.setTimeout(() => {
        usePlayerStore.getState().setFrozenFrame(null);
      }, 48);
      return () => window.clearTimeout(timer);
    }
  }, [
    frozenFrame,
    loaded,
    playerError,
    videoSurfacePaused,
    surfaceHoldPending,
    desktopRuntime,
    engineSurfaceVisible,
  ]);

  useEffect(() => {
    const rootEl = document.documentElement;
    rootEl.classList.toggle("ep-video-active", showVideoBackdrop);
    return () => {
      rootEl.classList.remove("ep-video-active");
    };
  }, [showVideoBackdrop]);

  useEffect(() => {
    if (!hasFolderEpisodes && panelOpen && sideTab === "episodes") {
      setPanelOpen(false);
    }
  }, [hasFolderEpisodes, panelOpen, sideTab]);

  useLayoutEffect(() => {
    const reactionsAvailable = Boolean(roomCode) && reactionsEnabled;
    if (
      !panelOpen ||
      (sideTab === "episodes" && !hasFolderEpisodes) ||
      (sideTab === "reactions" && !reactionsAvailable)
    ) {
      setPopoverPos(null);
      return;
    }
    const updatePosition = () => setPopoverPos(computeCapsulePopoverLayout(sideTab));
    updatePosition();
    window.addEventListener("resize", updatePosition);
    const barEl = document.querySelector<HTMLElement>('[data-capsule-bar="true"]');
    const ro =
      barEl && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updatePosition)
        : null;
    if (barEl) ro?.observe(barEl);
    return () => {
      window.removeEventListener("resize", updatePosition);
      ro?.disconnect();
    };
  }, [
    panelOpen,
    sideTab,
    hasFolderEpisodes,
    reactionsEnabled,
    playlistItems.length,
    loaded,
    roomCode,
    syncStatus.state,
    isFullscreen,
    fullWidthPlayBar,
    effectivePartySidebarOpen,
    effectivePartyWidth,
    partyDocked,
    effectiveChatSidebarOpen,
    effectiveChatWidth,
    chatDocked,
    windowWidth,
  ]);

  const chatPeeksCount = useChatStore((s) => s.peeks.length);
  const chatPeeksEnabled = useAppStore((s) => s.chatPeeksEnabled);

  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    if (useAppStore.getState().globalShortcutsEnabled) {
      void safeInvoke("set_global_shortcuts_enabled", { enabled: true }).catch(() => undefined);
    }
    void listen<string>("app://global-shortcut", (event) => {
      if (disposed) return;
      if (event.payload === "toggle-play") {
        togglePlayback();
      } else if (event.payload === "seek-back") {
        seekPlaybackRelative(-10);
      } else if (event.payload === "seek-forward") {
        seekPlaybackRelative(10);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
      void safeInvoke("set_global_shortcuts_enabled", { enabled: false }).catch(() => undefined);
    };
  }, []);

  const wasAllReadyRef = useRef<boolean>(false);
  const allReadyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const allReady = participants.length > 1 && participants.every((p) => p.isReady);
    const prevAllReady = wasAllReadyRef.current;
    wasAllReadyRef.current = allReady;
    if (
      !startWhenAllReady ||
      syncStatus.state !== "connected" ||
      !loaded ||
      !paused ||
      !allReady
    ) {
      if (allReadyTimerRef.current !== null) {
        window.clearTimeout(allReadyTimerRef.current);
        allReadyTimerRef.current = null;
      }
      return;
    }
    if (prevAllReady) {
      return;
    }
    const effUser = resolveEffectiveUsername(syncStatus, username);
    const lock = getControllerLockState(true, participants, effUser, roomControl);
    if (lock.lockedForLocalUser) {
      return;
    }
    if (allReadyTimerRef.current !== null) {
      window.clearTimeout(allReadyTimerRef.current);
    }
    allReadyTimerRef.current = window.setTimeout(() => {
      allReadyTimerRef.current = null;
      const sNow = useSyncStore.getState();
      const pNow = usePlayerStore.getState();
      const stillAllReady =
        sNow.participants.length > 1 && sNow.participants.every((p) => p.isReady);
      if (stillAllReady && pNow.loaded && pNow.paused) {
        togglePlayback();
      }
    }, 2000);
  }, [startWhenAllReady, syncStatus, participants, loaded, paused, username, roomControl]);

  useEffect(() => {
    return () => {
      if (allReadyTimerRef.current !== null) {
        window.clearTimeout(allReadyTimerRef.current);
        allReadyTimerRef.current = null;
      }
    };
  }, []);

  const fileMismatch = usePartyFileMismatch();

  const handleOpenLocalMatch = useCallback(
    async (candidate: LocalMatchCandidate) => {
      try {
        const existsList = await checkLocalFilesExist([candidate.path]);
        if (isDesktop() && !existsList[0]) {
          fileMismatch.refreshLocalMatches();
          pushNote("warn", "That file was moved or deleted — refreshing local matches.");
          return;
        }
        await loadMediaInputs([candidate.path]);
      } catch (err) {
        pushNote("error", formatUserError(err, "Could not open matched video."));
      }
    },
    [fileMismatch, loadMediaInputs, pushNote],
  );

  useEffect(() => {
    if (miniMode) {
      setPanelOpen(false);
      setChatOpen(false);
      setChromeIdle(true);
    }
  }, [miniMode]);

  useEffect(() => {
    return () => {
      saveCurrentResumePosition();
    };
  }, [saveCurrentResumePosition]);

  const syncConnectedState = syncStatus.state === "connected";

  useEffect(() => {
    if (!loaded || durationSecs <= 0 || !selectedFileName) return;
    if (!syncConnectedState || !roomCode) return;
    const appNow = useAppStore.getState();
    const roomId = buildRecentRoomId(roomCode, appNow.serverEndpoint, literalRoom);
    if (selectedFilePath) {
      useRecentRoomsStore.getState().setLastFilePath(roomId, selectedFilePath);
    }
    if (!appNow.trackWatchedEpisodes) return;
    const plNow = usePlaylistStore.getState();
    if (plNow.items.length === 0 || !plNow.folderName) return;
    const folderPath = extractParentFolderPath(plNow.items[0].path);
    if (!folderPath) return;
    const epItem = plNow.items[plNow.currentIndex] ?? selectedFileName;
    const seriesKey = useSeriesProgressStore.getState().upsertSeries({
      folderPath,
      folderName: plNow.folderName,
      lastEpisodeKey: buildEpisodeKey(epItem),
    });
    if (seriesKey) {
      useRecentRoomsStore.getState().setSeriesKey(roomId, seriesKey);
    }
  }, [loaded, durationSecs, selectedFileName, selectedFilePath, syncConnectedState, roomCode, literalRoom]);

  useEffect(() => {
    if (!loaded || durationSecs <= 0 || !selectedFileName) return;
    const appNow = useAppStore.getState();

    // Upsert local series progress even when watching solo
    if (appNow.trackWatchedEpisodes) {
      const plNow = usePlaylistStore.getState();
      if (plNow.items.length > 0 && plNow.folderName) {
        const folderPath = extractParentFolderPath(plNow.items[0].path);
        if (folderPath) {
          const epItem = plNow.items[plNow.currentIndex] ?? selectedFileName;
          useSeriesProgressStore.getState().upsertSeries({
            folderPath,
            folderName: plNow.folderName,
            lastEpisodeKey: buildEpisodeKey(epItem),
          });
        }
      }
    }

    const fileKey = buildMediaFileKey(selectedFileName, durationSecs);
    const savedSub = getPerFileSubtitlePref(fileKey);
    if (fileKey && subPrefAppliedKeyRef.current !== fileKey && tracks.some((t) => t.type === "sub")) {
      subPrefAppliedKeyRef.current = fileKey;
      if (savedSub && Math.abs(savedSub.delaySecs) >= 0.05) {
        useSubtitleStore.getState().setDelaySecs(savedSub.delaySecs);
        safeMpvCall(mpvSetSubDelay(savedSub.delaySecs), "restoreSubDelay");
        const sign = savedSub.delaySecs >= 0 ? "+" : "";
        useNotificationStore.getState().push(
          "info",
          `Subtitle delay restored (${sign}${savedSub.delaySecs.toFixed(1)}s)`,
          4500,
          `sub-delay:${fileKey}`,
        );
      }
      if (savedSub?.secondaryTrackLang) {
        const wantLang = savedSub.secondaryTrackLang.trim().toLowerCase();
        const matchTrack = tracks.find(
          (t) =>
            t.type === "sub" &&
            !t.selected &&
            (t.lang ?? "").trim().toLowerCase() === wantLang,
        );
        if (matchTrack) {
          useSubtitleStore.getState().setSecondarySubId(matchTrack.id);
          safeMpvCall(mpvSetSecondarySubTrack(matchTrack.id, 10), "restoreSecondarySub");
        }
      }
    }

    if (
      fileKey &&
      seriesTrackAppliedKeyRef.current !== fileKey &&
      tracks.some((t) => t.type === "audio" || t.type === "sub")
    ) {
      seriesTrackAppliedKeyRef.current = fileKey;
      const seriesKey = deriveSeriesKeyForFile(appNow.selectedFilePath);
      const seriesPref = getSeriesTrackPref(seriesKey);
      if (seriesPref) {
        const detectedNow = usePlayerStore.getState().detectedSubLangs;
        let nextTracks = tracks;
        let tracksUpdated = false;

        if (seriesPref.audioLang) {
          const wantAudio = normalizeSubtitleLang(seriesPref.audioLang);
          const currentAudio = nextTracks.find((t) => t.type === "audio" && t.selected);
          const currentAudioLang = normalizeSubtitleLang(currentAudio?.lang);
          if (wantAudio && currentAudioLang !== wantAudio) {
            const audioMatch = pickMatchingAudioTrack(nextTracks, wantAudio);
            if (audioMatch) {
              nextTracks = nextTracks.map((t) =>
                t.type === "audio" ? { ...t, selected: t.id === audioMatch.id } : t,
              );
              tracksUpdated = true;
              safeMpvCall(mpvSetAudioTrack(audioMatch.id), "restoreSeriesAudioTrack");
            }
          }
        }

        const hasSelectedExternalSub = nextTracks.some(
          (t) => t.type === "sub" && t.selected && t.external,
        );
        let activePrimarySubId =
          nextTracks.find((t) => t.type === "sub" && t.selected)?.id ?? null;

        if (!savedSub?.subtitleFile && !hasSelectedExternalSub) {
          if (seriesPref.subLang === "off") {
            if (activePrimarySubId !== null) {
              activePrimarySubId = null;
              nextTracks = nextTracks.map((t) =>
                t.type === "sub" ? { ...t, selected: false } : t,
              );
              tracksUpdated = true;
              safeMpvCall(mpvSetSubTrack(null), "restoreSeriesSubOff");
              useSubtitleStore.getState().setVisible(false);
            }
          } else if (seriesPref.subLang) {
            const wantSub = normalizeSubtitleLang(seriesPref.subLang);
            const currentSub = nextTracks.find((t) => t.type === "sub" && t.selected);
            const currentSubLang = currentSub
              ? normalizeSubtitleLang(currentSub.lang) ??
                normalizeSubtitleLang(detectedNow[currentSub.id])
              : null;
            if (wantSub && currentSubLang !== wantSub) {
              const subMatch = pickMatchingSubTrack(nextTracks, wantSub, detectedNow);
              if (subMatch) {
                activePrimarySubId = subMatch.id;
                nextTracks = nextTracks.map((t) =>
                  t.type === "sub" ? { ...t, selected: t.id === subMatch.id } : t,
                );
                tracksUpdated = true;
                safeMpvCall(mpvSetSubTrack(subMatch.id), "restoreSeriesSubTrack");
                useSubtitleStore.getState().setVisible(true);
              }
            }
          }
        }

        if (!savedSub?.secondaryTrackLang && seriesPref.secondarySubLang) {
          const secMatch = pickMatchingSubTrack(
            nextTracks,
            seriesPref.secondarySubLang,
            detectedNow,
            activePrimarySubId,
          );
          if (secMatch) {
            useSubtitleStore.getState().setSecondarySubId(secMatch.id);
            safeMpvCall(mpvSetSecondarySubTrack(secMatch.id, 10), "restoreSeriesSecondarySub");
          }
        }

        if (tracksUpdated) {
          usePlayerStore.getState().setTracks(nextTracks);
        }
      }
    }
    if (!appNow.rememberPlaybackPosition) return;
    if (!fileKey || resumeAppliedKeyRef.current === fileKey) return;

    const saved = useResumeStore.getState().getPosition(fileKey);
    if (!saved || saved.positionSecs < RESUME_MIN_SECS || saved.positionSecs > durationSecs * RESUME_COMPLETE_RATIO) {
      resumeAppliedKeyRef.current = fileKey;
      return;
    }

    const clock = formatResumeClock(saved.positionSecs);
    if (!appNow.roomCode) {
      resumeAppliedKeyRef.current = fileKey;
      seekPlaybackTo(saved.positionSecs);
      useNotificationStore.getState().push(
        "info",
        `Resumed from ${clock}`,
        7000,
        `resume:${fileKey}`,
        {
          label: "Start over",
          onClick: () => seekPlaybackTo(0),
        },
      );
    } else {
      const syncNow = useSyncStore.getState();
      if (syncNow.status.state === "connecting") {
        return;
      }
      resumeAppliedKeyRef.current = fileKey;
      const syncConnNow = syncNow.status.state === "connected";
      const effUserRaw = resolveEffectiveUsername(syncNow.status, appNow.username);
      const effUser = effUserRaw.trim().toLowerCase();
      const otherPeerLoaded = syncNow.participants.some(
        (p) => p.username.trim().toLowerCase() !== effUser && Boolean(p.fileName?.trim()),
      );
      const lockNow = getControllerLockState(
        syncConnNow,
        syncNow.participants,
        effUserRaw,
        syncNow.roomControl,
      );
      if (!otherPeerLoaded && !lockNow.lockedForLocalUser) {
        seekPlaybackTo(saved.positionSecs);
        if (syncConnNow && !usePlayerStore.getState().paused) {
          void syncUserPlay(saved.positionSecs);
        }
        useNotificationStore.getState().push(
          "info",
          `Resumed from ${clock}`,
          7000,
          `resume:${fileKey}`,
          {
            label: "Start over",
            onClick: () => seekPlaybackTo(0),
          },
        );
      }
    }
  }, [loaded, durationSecs, selectedFileName, tracks, syncStatus.state]);
  const visibleFileMismatch =
    !panelOpen &&
    !effectivePartySidebarOpen &&
    !alignMode &&
    !settingsOpen &&
    !shortcutsOpen &&
    !fileMismatch.dismissed
      ? fileMismatch.mismatch
      : null;

  const activePopover =
    panelOpen &&
    popoverPos &&
    (sideTab === "room" ||
      sideTab === "playback" ||
      sideTab === "subtitles" ||
      (sideTab === "reactions" && Boolean(roomCode) && reactionsEnabled) ||
      (sideTab === "episodes" && hasFolderEpisodes))
      ? { tab: sideTab, pos: popoverPos }
      : null;
  const popover = usePresencePayload(activePopover, 200);
  const seekCuePresence = usePresencePayload(seekCue, 240);
  const micCuePresence = usePresencePayload(micCue, 220);
  const syncConnectedNow = syncStatus.state === "connected";
  const effectiveUserNow = resolveEffectiveUsername(syncStatus, username);
  const ctrlLockNow = getControllerLockState(
    syncConnectedNow,
    participants,
    effectiveUserNow,
    roomControl,
  );
  const introLockedNow = ctrlLockNow.lockedForLocalUser && !(syncConnectedNow && alignMode);
  const effectiveIntroSegments = useMemo(
    () => getEffectiveIntroSegments(introSegments, manualIntro),
    [introSegments, manualIntro],
  );
  const activeFloatingIntroKey = usePlayerStore((s) => {
    if (!loaded || !skipIntroEnabled || introLockedNow || popover.mounted) return "";
    const seg = findActiveIntroAt(Math.floor(s.positionSecs * 2) / 2, effectiveIntroSegments);
    if (!seg) return "";
    const segKey = buildIntroSegmentKey(introVideoKey, seg);
    return introDismissedKeys.includes(segKey) ? "" : segKey;
  });
  const activeFloatingIntro = activeFloatingIntroKey !== "";
  const ratingBarActive = useRatingStore(
    (s) => outroRatingEnabled && s.open && Boolean(s.activeKey),
  );
  const activeOutroWindow = usePlayerStore((s) => {
    if (!loaded || !outroNextEnabled || !hasFolderEpisodes || introLockedNow || popover.mounted) {
      return false;
    }
    if (s.endedAtEof) return true;
    if (detectedOutro && s.positionSecs >= Math.max(0, detectedOutro.startSecs - 2)) {
      return true;
    }
    return s.durationSecs >= 90 && s.durationSecs - s.positionSecs <= 42;
  });
  const edgeRailPinned =
    Boolean(roomCode) &&
    chatTriggerPlacement === "edge" &&
    !chatSidebarOpen &&
    !chatSidebarPresence.mounted &&
    unreadChatCount > 0;
  const backdropPresence = useAnimatedPresence(
    Boolean(
      showFloatingCapsule ||
        showWindowBar ||
        popover.mounted ||
        contextMenu ||
        visibleFileMismatch ||
        alignMode ||
        notificationCount > 0 ||
        Boolean(feedback) ||
        seekCuePresence.mounted ||
        micCuePresence.mounted ||
        ratingBarActive ||
        activeOutroWindow ||
        edgeRailPinned ||
        Boolean(activeFloatingIntro) ||
        (chatPeeksEnabled && chatPeeksCount > 0 && !popover.mounted),
    ),
    320,
  );

  const handleToggleCapsuleTab = (tab: SideTab) => {
    wakeChrome();
    if (panelOpen && sideTab === tab) {
      setPanelOpen(false);
    } else {
      setSideTab(tab);
      setPanelOpen(true);
      // CC button: open the menu AND make sure subtitles are on.
      if (tab === "subtitles") ensureSubtitlesOn();
    }
  };

  const handleLeaveRoom = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    saveCurrentResumePosition();
    eofHandledLoadGenRef.current = -1;
    justAdvancedFromPathRef.current = null;
    recentLocalSwitchesRef.current = [];
    recentFollowTimestampsRef.current = [];
    autoLoadedPathRef.current = null;
    soundTrackerRef.current.reset();
    pendingPairedSubRef.current = null;
    lastPeerFileRef.current = null;
    announcedFileKeyRef.current = null;
    autoReadyMarkedRef.current = false;
    autoCloudFallbackRoomRef.current = null;
    if (usePlayerStore.getState().isFullscreen) {
      void windowSetFullscreen(false).catch(() => undefined);
    }
    leaveRoom();
  };

  const hasPrevEpisodeNow = playlistItems.length > 1 && playlistIndex > 0;
  const hasNextEpisodeNow =
    playlistItems.length > 1 && playlistIndex >= 0 && playlistIndex < playlistItems.length - 1;

  const activeContextIntro =
    contextMenu && loaded && skipIntroEnabled
      ? findSkippableIntroAt(
          usePlayerStore.getState().positionSecs,
          effectiveIntroSegments,
        )
      : null;

  const audioTrackOptions = buildAudioTrackOptions(tracks);
  const selectedAudioTrack = tracks.find((t) => t.type === "audio" && t.selected) ?? null;
  const currentAudioVal = selectedAudioTrack ? String(selectedAudioTrack.id) : "none";
  const audioBadge = !loaded
    ? undefined
    : muted
      ? "Muted"
      : selectedAudioTrack?.lang?.trim().toUpperCase() ||
        selectedAudioTrack?.title?.trim() ||
        (selectedAudioTrack ? `Track ${selectedAudioTrack.id}` : "Off");

  const subTrackOptions = buildSubTrackOptions(tracks);
  const selectedSubTrack = tracks.find((t) => t.type === "sub" && t.selected) ?? null;
  const currentSubVal = selectedSubTrack ? String(selectedSubTrack.id) : "none";
  const subBadge = !loaded ? undefined : subVisible && selectedSubTrack ? "On" : "Off";

  const quickEpisodeWindowStart =
    playlistItems.length > 12
      ? Math.max(0, Math.min(playlistItems.length - 12, playlistIndex - 4))
      : 0;
  const quickEpisodesSlice = playlistItems.slice(
    quickEpisodeWindowStart,
    quickEpisodeWindowStart + 12,
  );

  const speedLabel = Math.abs(speed - 1.0) < 0.01 ? "1×" : `${speed}×`;
  const playbackSubmenuEntries: ContextMenuEntry[] = [
    {
      type: "label",
      id: "sub-lbl-speed",
      text: "Speed Rate",
    },
    ...([0.75, 1.0, 1.25, 1.5, 2.0] as const).map((preset) => {
      const active = Math.abs(speed - preset) < 0.01;
      const disabled =
        !loaded || (syncConnectedNow && !canChangePlaybackSpeed(true, preset, timelineScale));
      return {
        id: `ctx-speed-${preset}`,
        label: preset === 1 ? "1.0× (Normal)" : `${preset}×`,
        icon: <MenuSpeedIcon size={14} />,
        checked: loaded && active,
        disabled,
        onSelect: () => {
          setSpeed(preset);
          safeMpvCall(mpvSetSpeed(preset), "contextMenu:mpvSetSpeed");
        },
      } satisfies ContextMenuEntry;
    }),
    { type: "divider", id: "sub-div-loop" },
    {
      id: "ctx-loop-toggle",
      label: "Loop Current Video",
      icon: <AppRepeatIcon size={14} />,
      checked: loaded && looping,
      disabled: !loaded,
      onSelect: toggleLoopPlayback,
    },
  ];

  const audioSubmenuEntries: ContextMenuEntry[] = [
    {
      id: "mute-toggle",
      label: "Mute Audio",
      shortcut: "M",
      icon: <PlayerVolumeIcon muted={muted} size={14} />,
      checked: muted,
      onSelect: toggleMutePlayback,
    },
    {
      type: "label",
      id: "sub-lbl-audio-tracks",
      text: "Available Tracks",
    },
    ...(!loaded
      ? ([
          {
            id: "ctx-audio-unloaded",
            label: "Open a video to switch tracks",
            icon: <PlayerAudioIcon size={14} />,
            disabled: true,
            onSelect: () => undefined,
          },
        ] satisfies ContextMenuEntry[])
      : audioTrackOptions.map((opt) => {
          const active = opt.value === currentAudioVal;
          const t = opt.track;
          const aid = opt.value === "none" ? null : Number(opt.value);
          const label = t
            ? t.title?.trim() ||
              (t.lang ? `${t.lang.trim().toUpperCase()} Audio` : `Audio Track ${t.id}`)
            : "Mute / Off";
          const badge = t?.lang?.trim().toUpperCase() || t?.codec?.trim().toUpperCase();
          return {
            id: `ctx-audio-${opt.value}`,
            label,
            badge,
            icon: t ? (
              <PlayerAudioIcon size={14} />
            ) : (
              <PlayerVolumeIcon muted size={14} />
            ),
            checked: active,
            onSelect: () => selectAudioTrackOption(aid),
          } satisfies ContextMenuEntry;
        })),
    { type: "divider", id: "sub-div-audio-panel" },
    {
      id: "open-audio",
      label: "Audio & Speed Menu…",
      icon: <PlayerAudioIcon active size={14} className="text-accent-soft" />,
      onSelect: () => {
        setSideTab("playback");
        setPanelOpen(true);
      },
    },
  ];

  const subtitleSubmenuEntries: ContextMenuEntry[] = [
    {
      id: "toggle-subs",
      label: subVisible ? "Hide Subtitles" : "Show Subtitles",
      shortcut: "V",
      checked: loaded && subVisible,
      icon: <PlayerCaptionsIcon size={14} />,
      disabled: !loaded,
      onSelect: toggleSubtitlesVisibility,
    },
    {
      type: "label",
      id: "sub-lbl-sub-tracks",
      text: "Available Tracks",
    },
    ...(!loaded
      ? ([
          {
            id: "ctx-sub-unloaded",
            label: "Open a video to select subtitles",
            icon: <PlayerCaptionsIcon size={14} />,
            disabled: true,
            onSelect: () => undefined,
          },
        ] satisfies ContextMenuEntry[])
      : subTrackOptions.map((opt) => {
          const active = opt.value === currentSubVal;
          const t = opt.track;
          const sid = opt.value === "none" ? null : Number(opt.value);
          const display = t
            ? formatSubtitleTrackDisplay(t, { detectedLang: detectedSubLangs[t.id] })
            : null;
          const label = display ? display.label : "Off";
          const badge = display && display.metaTags.length > 0 ? display.metaTags.join(" · ") : undefined;
          return {
            id: `ctx-sub-${opt.value}`,
            label,
            badge,
            icon: t ? <PlayerCaptionsIcon size={14} /> : <MenuSubtitlesOffIcon size={14} />,
            checked: active,
            onSelect: () => {
              const seriesKey = deriveSeriesKeyForFile(useAppStore.getState().selectedFilePath);
              if (sid === null) {
                saveSeriesTrackPref(seriesKey, { subLang: "off" });
              } else if (t && !t.external) {
                const subLang =
                  normalizeSubtitleLang(t.lang) ?? normalizeSubtitleLang(detectedSubLangs[t.id]);
                if (subLang) {
                  saveSeriesTrackPref(seriesKey, { subLang });
                }
              }
              void selectSubTrack(sid, tracks, {
                mpvSetSubTrack,
                mpvSetSubDelay,
                setDelaySecs: setSubDelaySecs,
                setSubtitleVisible: setSubVisible,
                clearExternalTrackState: clearSubLoadedTrack,
              });
            },
          } satisfies ContextMenuEntry;
        })),
    { type: "divider", id: "sub-div-sub-panel" },
    {
      id: "open-subtitles",
      label: "Subtitles & Magic Sync…",
      icon: <AppSparkleIcon size={14} className="text-accent-soft" />,
      onSelect: () => {
        setSideTab("subtitles");
        setPanelOpen(true);
      },
    },
  ];

  const mediaOpenSubmenuEntries: ContextMenuEntry[] = [
    {
      id: "open-file",
      label: "Open Video File(s)…",
      icon: <OpenMediaIcon bare size={14} />,
      onSelect: () => void handleChooseFile(),
    },
    {
      id: "open-folder",
      label: "Open Season Folder…",
      icon: <AppSeasonFolderIcon size={14} />,
      onSelect: () => void handleChooseSeasonFolder(),
    },
    {
      id: "add-episodes",
      label: "Add Episode Files…",
      icon: <MenuAddFileIcon size={14} />,
      onSelect: () => void handleChooseFile(true),
    },
  ];

  const episodesSubmenuEntries: ContextMenuEntry[] = [
    {
      id: "prev-ep",
      label: "Previous Episode",
      icon: <PlayerSkipEpisodeIcon direction="prev" size={14} />,
      disabled: !hasPrevEpisodeNow || ctrlLockNow.lockedForLocalUser,
      onSelect: handlePrevEpisode,
    },
    {
      id: "next-ep",
      label: "Next Episode",
      icon: <PlayerSkipEpisodeIcon direction="next" size={14} />,
      disabled: !hasNextEpisodeNow || ctrlLockNow.lockedForLocalUser,
      onSelect: handleNextEpisode,
    },
    {
      id: "ctx-auto-next",
      label: "Auto-Next Episode",
      icon: <MenuAutoNextIcon size={14} />,
      checked: autoPlayNext,
      onSelect: () => setAutoPlayNext(!autoPlayNext),
    },
    ...(quickEpisodesSlice.length > 0
      ? ([
          {
            type: "label",
            id: "sub-lbl-ep-queue",
            text: "Up Next in Folder",
          },
          ...quickEpisodesSlice.map((item, offset) => {
            const idx = quickEpisodeWindowStart + offset;
            const epDisp = formatDisplayMediaTitle(item.fileName);
            return {
              id: `ctx-ep-${idx}`,
              label: epDisp.title || item.cleanTitle,
              badge: item.episodeBadge || `#${idx + 1}`,
              icon: <PlayerEpisodesIcon size={14} />,
              checked: idx === playlistIndex,
              disabled: ctrlLockNow.lockedForLocalUser,
              onSelect: () => void selectEpisodeAtIndex(idx),
            } satisfies ContextMenuEntry;
          }),
          { type: "divider", id: "sub-div-ep-drawer" },
          {
            id: "open-episodes",
            label: "Open Episodes Drawer…",
            icon: <PlayerEpisodesIcon active size={14} className="text-accent-soft" />,
            accent: true,
            onSelect: () => {
              setSideTab("episodes");
              setPanelOpen(true);
            },
          },
        ] satisfies ContextMenuEntry[])
      : []),
  ];

  const pictureWindowSubmenuEntries: ContextMenuEntry[] = [
    {
      type: "label",
      id: "sub-lbl-aspect",
      text: "Aspect Ratio",
    },
    ...(
      [
        { value: "auto", label: "Auto (Original)" },
        { value: "16:9", label: "16:9 Widescreen" },
        { value: "21:9", label: "21:9 Cinema" },
        { value: "4:3", label: "4:3 Classic" },
        { value: "fill", label: "Fill Screen" },
      ] as ReadonlyArray<{ value: AspectMode; label: string }>
    ).map((mode) => ({
      id: `ctx-aspect-${mode.value}`,
      label: mode.label,
      icon: <MenuAspectFrameIcon size={14} />,
      checked: loaded && aspectMode === mode.value,
      disabled: !loaded,
      onSelect: () => {
        setAspectMode(mode.value);
        safeMpvCall(mpvSetAspectMode(mode.value), "contextMenu:mpvSetAspectMode");
      },
    })),
    { type: "divider", id: "sub-div-window" },
    {
      type: "label",
      id: "sub-lbl-window",
      text: "Display",
    },
    {
      id: "toggle-fullscreen",
      label: isFullscreen ? "Exit Fullscreen" : "Fullscreen",
      shortcut: "F",
      checked: isFullscreen,
      icon: <PlayerFullscreenIcon isFullscreen={isFullscreen} size={14} />,
      onSelect: toggleFullscreen,
    },
    {
      id: "toggle-playbar-style",
      label: "Full-Width Play Bar",
      checked: fullWidthPlayBar,
      icon: <MenuPlayBarLayoutIcon size={14} />,
      onSelect: () => {
        setFullWidthPlayBar(!fullWidthPlayBar);
        wakeChrome();
      },
    },
  ];

  const contextMenuEntries: ContextMenuEntry[] = [
    {
      type: "label",
      id: "ctx-lbl-playback",
      text: "Player",
    },
    {
      id: "play-pause",
      label: paused ? "Play" : "Pause",
      shortcut: "Space",
      icon: paused ? <PlayerPlayIcon size={14} /> : <PlayerPauseIcon size={14} />,
      disabled: !loaded || ctrlLockNow.lockedForLocalUser,
      onSelect: () => togglePlayback(),
    },
    ...(activeContextIntro
      ? ([
          {
            id: "skip-intro",
            label: activeContextIntro.label,
            shortcut: "I",
            icon: <PlayerSkipIntroIcon size={14} />,
            accent: true,
            disabled: !loaded || (ctrlLockNow.lockedForLocalUser && !(syncConnectedNow && alignMode)),
            onSelect: () => {
              void executeSkipIntro(activeContextIntro);
            },
          },
        ] satisfies ContextMenuEntry[])
      : []),
    {
      type: "submenu",
      id: "sub-playback-opts",
      label: "Controls & Speed",
      badge: loaded ? (looping ? `Loop · ${speedLabel}` : speedLabel) : undefined,
      icon: <MenuSpeedIcon size={14} />,
      children: playbackSubmenuEntries,
    },

    {
      type: "label",
      id: "ctx-lbl-tracks",
      text: "Tracks",
    },
    {
      type: "submenu",
      id: "sub-audio",
      label: "Audio",
      badge: audioBadge,
      icon: <PlayerAudioIcon size={14} />,
      children: audioSubmenuEntries,
    },
    {
      type: "submenu",
      id: "sub-subtitles",
      label: "Subtitles",
      badge: subBadge,
      icon: <PlayerCaptionsIcon size={14} />,
      children: subtitleSubmenuEntries,
    },

    {
      type: "label",
      id: "ctx-lbl-media",
      text: "Library",
    },
    {
      type: "submenu",
      id: "sub-open-media",
      label: "Open File or Folder",
      icon: <AppFolderIcon size={14} />,
      children: mediaOpenSubmenuEntries,
    },
    ...(hasFolderEpisodes
      ? ([
          {
            type: "submenu",
            id: "sub-episodes",
            label: "Episodes",
            badge:
              playlistItems.length > 0
                ? `${Math.max(1, playlistIndex + 1)}/${playlistItems.length}`
                : undefined,
            icon: <PlayerEpisodesIcon active size={14} />,
            children: episodesSubmenuEntries,
          },
        ] satisfies ContextMenuEntry[])
      : []),
    {
      type: "submenu",
      id: "sub-picture-window",
      label: "Picture & Window",
      badge: isFullscreen ? "Full" : loaded ? (aspectMode === "auto" ? "Auto" : aspectMode) : undefined,
      icon: <MenuScreenIcon size={14} />,
      children: pictureWindowSubmenuEntries,
    },

    { type: "divider", id: "div-party" },
    {
      type: "label",
      id: "ctx-lbl-party",
      text: "Session",
    },
    ...(roomCode
      ? ([
          {
            id: "toggle-ready",
            label: localReady && loaded ? "Mark Not Ready" : "Mark Ready",
            shortcut: "R",
            checked: localReady && loaded,
            icon: <PlayerReadyIcon ready={localReady && loaded} size={14} />,
            disabled: !loaded,
            onSelect: toggleReadyStatus,
          },
          {
            type: "submenu",
            id: "sub-party-controls",
            label: "Watch Party Room",
            badge: syncConnectedNow ? "Live" : undefined,
            icon: <WatchPartyIcon bare size={14} />,
            children: [
              {
                id: "force-resync",
                label: "Resync With Party",
                icon: <PlayerResyncIcon tone="ok" size={14} />,
                disabled: !syncConnectedNow,
                onSelect: () => {
                  void syncForceResync().then(() => {
                    usePlayerStore.getState().flashFeedback("Resynced with room");
                  });
                },
              },
              {
                id: "copy-room-code",
                label: "Copy Room Code",
                badge: formatRoomCodeDisplay(roomCode),
                icon: <PartyCopyIcon size={14} />,
                onSelect: () => {
                  void navigator.clipboard
                    ?.writeText(roomCode)
                    .then(() => {
                      usePlayerStore.getState().flashFeedback("Room code copied");
                    })
                    .catch(() => undefined);
                },
              },
              {
                id: "follow-party-ep",
                label: "Follow Party Episode",
                checked: followPartyEpisode,
                icon: <PlayerFollowIcon active={followPartyEpisode} size={14} />,
                onSelect: () => setFollowPartyEpisode(!followPartyEpisode),
              },
              { type: "divider", id: "sub-div-party-lounge" },
              {
                id: "party-lounge",
                label: "Party Lounge & Source Sync…",
                shortcut: "P",
                icon: <PartyViewersIcon size={14} />,
                onSelect: toggleOrFocusPartyLounge,
              },
              {
                id: "open-chat",
                label: "Party Chat…",
                shortcut: "C",
                icon: <PlayerChatIcon size={14} />,
                onSelect: () => {
                  setChatSidebarOpenSmooth(true);
                },
              },
              ...(reactionsEnabled
                ? ([
                    {
                      id: "open-reactions",
                      label: "Live Party Reactions…",
                      shortcut: "E",
                      icon: <PlayerReactionsIcon size={14} />,
                      onSelect: () => {
                        setSideTab("reactions");
                        setPanelOpen(true);
                      },
                    },
                  ] satisfies ContextMenuEntry[])
                : []),
            ],
          },
        ] satisfies ContextMenuEntry[])
      : ([
          {
            id: "party-lounge",
            label: "Start Watch Party…",
            icon: <PartyCreateIcon size={14} />,
            onSelect: () => {
              setSideTab("room");
              setPanelOpen(true);
            },
          },
        ] satisfies ContextMenuEntry[])),

    { type: "divider", id: "div-app" },
    {
      type: "label",
      id: "ctx-lbl-app",
      text: "System",
    },
    {
      type: "submenu",
      id: "sub-prefs-help",
      label: "Settings & Help",
      icon: <PlayerSettingsIcon size={14} />,
      children: [
        {
          id: "preferences",
          label: "Preferences…",
          icon: <AppSparkleIcon size={14} className="text-accent-soft" />,
          onSelect: () => openSettings("prefs"),
        },
        {
          id: "updates",
          label: "Check for Updates…",
          icon: <AppDownloadIcon size={14} />,
          onSelect: () => openSettings("updates"),
        },
        {
          id: "shortcuts",
          label: "Keyboard Shortcuts…",
          shortcut: "?",
          icon: <AppKeyboardIcon size={14} />,
          onSelect: openShortcuts,
        },
      ],
    },
    {
      id: "leave-room",
      label: roomCode ? "Leave Watch Party" : "Back to Lobby",
      icon: <PartyLeaveIcon size={14} />,
      onSelect: handleLeaveRoom,
    },
  ];

  return (
    <div
      ref={stageRef}
      onMouseEnter={wakeChrome}
      onPointerDown={(e) => {
        if (e.target instanceof Element && e.target.closest('[data-docked-sidebar="true"]')) {
          return;
        }
        wakeChrome();
      }}
      onContextMenu={(e) => {
        if (isTextEntryElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        wakeChrome();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
      className={`relative h-full w-full text-primary overflow-hidden flex ${
        showVideoBackdrop ? "bg-transparent" : "bg-canvas"
      }`}
    >
      {roomCode && partySidebarPresence.mounted && (
        <PartySidebar
          docked={partyDocked}
          exiting={partySidebarPresence.exiting}
          width={effectivePartyWidth}
          topChromeOffset={!isFullscreen}
          onClose={() => setPartySidebarOpenSmooth(false)}
          onUnpin={handleUnpinPartyToPopover}
          onChooseFile={() => void handleChooseFile()}
          onChooseFolder={() => void handleChooseSeasonFolder()}
          onSwitchEpisode={(idx) => void switchToPartyEpisode(idx)}
          onOpenLocalMatch={(cand) => void handleOpenLocalMatch(cand)}
          onResizingChange={setPartyResizing}
          onDockTransitionEnd={() => finishPartyLayoutTransition()}
        />
      )}

      <div
        aria-hidden={!showWindowBar}
        style={{
          left: `${partyDockedOffsetPx}px`,
          transition: partyResizing ? "none" : undefined,
        }}
        className={`ep-top-scrim absolute top-0 right-0 z-[46] ep-chrome-transition origin-top transition-[left,opacity,transform] ${
          showWindowBar
            ? "opacity-100 translate-y-0 scale-100"
            : "opacity-0 -translate-y-3 scale-[0.988] pointer-events-none"
        }`}
      >
        <TitleBar
          leftSlot={
            <div
              className="inline-flex items-center gap-2 min-w-0 max-w-[60vw] pl-1"
              style={
                roomCode && (partyDockedOffsetPx > 0 || (effectiveChatSidebarOpen && chatDocked))
                  ? {
                      maxWidth: `${Math.max(
                        180,
                        windowWidth -
                          partyDockedOffsetPx -
                          (effectiveChatSidebarOpen && chatDocked ? effectiveChatWidth : 0) -
                          28,
                      )}px`,
                    }
                  : undefined
              }
            >
              <button
                type="button"
                onClick={handleLeaveRoom}
                aria-label={roomCode ? "Leave room" : "Back to lobby"}
                title={roomCode ? "Leave room" : "Back to lobby"}
                className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-white/80 hover:text-white cursor-pointer shrink-0"
              >
                <AppChevronIcon direction="left" size={16} />
              </button>
              <span className="text-[13px] font-medium text-white/90 truncate max-w-[360px]">
                {cleanHeaderTitle}
              </span>
              {activePlaylistItem?.episodeBadge && (
                <span className="hidden min-[360px]:inline shrink-0 num text-[11px] font-medium text-white/60">
                  {activePlaylistItem.episodeBadge}
                </span>
              )}
              {roomCode && !effectivePartySidebarOpen && (
                <button
                  type="button"
                  onClick={toggleOrFocusPartyLounge}
                  aria-label="Open Watch Party panel"
                  title="Watch Party room · Click to view invite & viewers"
                  className="ep-press shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] text-white/80 hover:text-white hover:bg-white/[0.12] num cursor-pointer"
                >
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
                  <span>{formatRoomCodeDisplay(roomCode)}</span>
                </button>
              )}
            </div>
          }
          glassControls={showVideoBackdrop}
        />
      </div>
      {!showWindowBar && !isFullscreen && (
        <div
          data-tauri-drag-region
          onMouseEnter={wakeChrome}
          onMouseMove={wakeChrome}
          onClick={wakeChrome}
          style={{ left: `${partyDockedOffsetPx}px` }}
          title="Move mouse here to show window controls"
          className="absolute top-0 right-0 h-2.5 z-[46] cursor-pointer"
        />
      )}

      {/* Main video stage: shrinks smoothly when Left Party Lounge or Right ChatSidebar is docked */}
      <div
        data-stage-container="true"
        className="relative flex-1 min-w-0 h-full overflow-hidden"
      >
        {/* WebGL2 Cinema Liquid Glass backdrop renderer over mpv */}
        <VideoGlassBackdrop
          active={showVideoBackdrop && !lowPowerMode}
          visible={backdropPresence.mounted}
          playing={!paused}
          viewportRef={stageRef}
          layoutKey={`${showFloatingCapsule}:${showWindowBar}:${fullWidthPlayBar}:${popover.mounted}:${popover.exiting}:${popover.value?.tab ?? sideTab}:${popover.value?.pos.left ?? 0}:${popover.value?.pos.bottom ?? 0}:${popover.value?.pos.width ?? 0}:${Boolean(contextMenu)}:${contextMenu?.x ?? 0}:${contextMenu?.y ?? 0}:${Boolean(visibleFileMismatch)}:${visibleFileMismatch?.signature ?? ""}:${alignMode}:${notificationCount}:${feedback?.id ?? 0}:${seekCuePresence.mounted}:${seekCuePresence.exiting}:${seekCuePresence.value?.id ?? 0}:${micCuePresence.mounted}:${micCuePresence.exiting}:${micCuePresence.value?.id ?? 0}:${ratingBarActive}:${activeOutroWindow}:${unreadChatCount}:${Boolean(activeContextIntro)}:${Boolean(activeFloatingIntro)}:${chatPeeksCount}:${effectivePartySidebarOpen}:${effectivePartyWidth}:${partyDocked}:${effectiveChatSidebarOpen}:${effectiveChatWidth}:${chatDocked}:${viewportTick}`}
          pausedRefreshKey={`${pausedPosHalf}:${seekSettledTick}:${effectivePartySidebarOpen}:${effectivePartyWidth}:${partyDocked}:${viewportTick}`}
        />
        {seekCuePresence.mounted && seekCuePresence.value && (
          <div
            key={`${seekCuePresence.value.direction}:${seekCuePresence.value.actor ?? ""}`}
            role="status"
            aria-live="polite"
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 z-[45] select-none ${
              seekCuePresence.value.direction === "back"
                ? "left-[12%] sm:left-[18%]"
                : "right-[12%] sm:right-[18%]"
            }`}
          >
            <div
              className={
                seekCuePresence.exiting
                  ? seekCuePresence.value.direction === "back"
                    ? "ep-seek-cue-back-out"
                    : "ep-seek-cue-forward-out"
                  : seekCuePresence.value.direction === "back"
                    ? "ep-seek-cue-back-in"
                    : "ep-seek-cue-forward-in"
              }
            >
              <div
                data-glass-region="true"
                className={`ep-glass-seek-bubble rounded-full px-4 py-2 inline-flex items-center gap-2 ${
                  seekCuePresence.value.step > 1
                    ? seekCuePresence.value.step % 2 === 0
                      ? "ep-seek-bubble-bounce-a"
                      : "ep-seek-bubble-bounce-b"
                    : ""
                }`}
              >
                {seekCuePresence.value.direction === "back" && (
                  <PlayerSeekCueIcon direction="back" size={17} className="relative z-10 shrink-0" />
                )}
                <div className="relative z-10 flex items-center gap-1.5 whitespace-nowrap">
                  {seekCuePresence.value.actor && (
                    <span className="text-[11.5px] font-medium text-accent-soft max-w-[110px] truncate">
                      {seekCuePresence.value.actor}
                    </span>
                  )}
                  <span className="text-[13.5px] font-semibold tracking-tight text-white/95 num">
                    {seekCuePresence.value.direction === "back" ? "-" : "+"}
                    {Math.round(seekCuePresence.value.deltaSecs) >= 60
                      ? `${Math.floor(Math.round(seekCuePresence.value.deltaSecs) / 60)}m ${Math.round(seekCuePresence.value.deltaSecs) % 60}s`
                      : `${Math.round(seekCuePresence.value.deltaSecs)}s`}
                  </span>
                </div>
                {seekCuePresence.value.direction === "forward" && (
                  <PlayerSeekCueIcon direction="forward" size={17} className="relative z-10 shrink-0" />
                )}
              </div>
            </div>
          </div>
        )}
        {micCuePresence.mounted && micCuePresence.value && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute top-[44%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-[46] select-none"
          >
            <div className={micCuePresence.exiting ? "ep-mic-cue-out" : "ep-mic-cue-in"}>
              <div
                data-glass-region="true"
                className={`ep-glass-mic-cue relative rounded-full px-4 py-2.5 inline-flex items-center gap-2.5 ${
                  micCuePresence.value.muted
                    ? "ep-glass-mic-cue-muted"
                    : "ep-glass-mic-cue-live"
                } ${
                  micCuePresence.value.step > 1
                    ? micCuePresence.value.step % 2 === 0
                      ? "ep-seek-bubble-bounce-a"
                      : "ep-seek-bubble-bounce-b"
                    : ""
                }`}
              >
                <span className="relative inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/[0.08] shrink-0">
                  <span
                    key={`halo-${micCuePresence.value.id}`}
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-0 rounded-full ${
                      micCuePresence.value.muted
                        ? "ep-mic-halo-muted"
                        : "ep-mic-halo-live"
                    }`}
                  />
                  <AppMicIcon
                    muted={micCuePresence.value.muted}
                    speaking={!micCuePresence.value.muted}
                    size={16}
                    className={`relative z-10 ${
                      micCuePresence.value.muted ? "text-bad" : "text-ok"
                    }`}
                  />
                </span>
                <div className="relative z-10 flex items-center gap-2 whitespace-nowrap">
                  <span className="text-[13px] font-semibold tracking-tight text-white">
                    {micCuePresence.value.muted ? "Mic Muted" : "Mic Live"}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-md bg-white/[0.09] text-[10px] font-semibold text-white/75 tracking-wide">
                    M
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        <div
          className={`pointer-events-none absolute left-1/2 -translate-x-1/2 z-[45] flex flex-col items-center gap-2 max-w-[520px] w-[calc(100%-2rem)] transition-[top] duration-300 ${
            showWindowBar ? "top-14" : "top-4"
          }`}
        >
        <NotificationStrip inline />
        {feedback && (
          <span
            key={feedback.id}
            data-glass-region="true"
            className="ep-glass-pill anim-pop-in px-3 py-1 text-[11px] font-medium text-accent-soft rounded-full whitespace-nowrap"
          >
            {feedback.text}
          </span>
        )}
        <FileMismatchBanner
          inline
          mismatch={visibleFileMismatch}
          localMatches={fileMismatch.localMatches}
          searchingLocalMatches={fileMismatch.searchingLocalMatches}
          showWindowBar={showWindowBar}
          onChooseFile={() => void handleChooseFile()}
          onChooseFolder={() => void handleChooseSeasonFolder()}
          onSwitchEpisode={(idx) => void switchToPartyEpisode(idx)}
          onOpenLocalMatch={(cand) => void handleOpenLocalMatch(cand)}
          onMatchFps={(scale, label) => {
            void applyTimelineTransform(
              { offsetSecs: timelineOffsetSecs, scale },
              `FPS matched (${label ?? "calibrated"})`,
            );
          }}
          onAlignScene={() => void setSceneAlignMode(true)}
          onDismiss={fileMismatch.dismiss}
        />
        {syncStatus.state === "connected" && alignMode && !panelOpen && !effectivePartySidebarOpen && (
          <AlignModePill timelineScale={timelineScale} />
        )}
      </div>

      {/* Full-window video viewport: title bar and glass play bar float directly over the film */}
      <div
        data-showcase-stage="true"
        ref={viewportRef}
        className={`absolute inset-0 z-0 ${
          showVideoBackdrop ? "bg-transparent" : "bg-canvas"
        }`}
      >
        <FrozenVideoFrame
          frame={
            loaded && !playerError && (!engineSurfaceVisible || videoSurfacePaused || surfaceHoldPending)
              ? frozenFrame
              : null
          }
        />
        <ViewportPlaceholder
          loaded={loaded}
          isLoading={
            loadingMedia ||
            (desktopRuntime &&
              Boolean(selectedFilePath) &&
              !loaded &&
              !playerError &&
              autoLoadedPathRef.current !== selectedFilePath)
          }
          isDragActive={isDragActive}
          playerError={playerError}
          clearanceBottom={
            showFloatingCapsule
              ? panelOpen && sideTab === "room"
                ? "extended"
                : "bar"
              : "none"
          }
          onChooseFile={() => void handleChooseFile()}
          onChooseFolder={() => void handleChooseSeasonFolder()}
          onRetryPlayer={() => {
            void (async () => {
              usePlayerStore.getState().setPlayerError(null);
              usePlayerStore.getState().setEngineSurfaceVisible(false);
              await enqueueMpvLifecycle(async () => {
                await mpvStop().catch(() => undefined);
              });
              viewportTrackerRef.current.markInvalidated();
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              mpvLifecycleActiveRef.current = false;
              const currentFile = useAppStore.getState().selectedFilePath;
              if (currentFile) {
                const matchItem = usePlaylistStore
                  .getState()
                  .items.find((it) => it.path.toLowerCase() === currentFile.toLowerCase());
                await loadVideoPath(currentFile, matchItem?.subtitlePath);
              }
            })();
          }}
        />
        {showVideoBackdrop && !panelOpen && (
          <div
            className={`absolute inset-0 z-10 ${
              chromeIdle ? "cursor-none" : "cursor-default"
            }`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => (chromeIdle ? wakeChrome() : hideChrome())}
            onDoubleClick={toggleFullscreen}
            aria-hidden="true"
          />
        )}
        {panelOpen && (
          <div
            className="absolute inset-0 z-20"
            onClick={() => setPanelOpen(false)}
            aria-hidden="true"
          />
        )}
      </div>

      {popover.mounted && popover.value && (
        <aside
          key="capsule-popover"
          aria-label={
            popover.value.tab === "room"
              ? "Watch Party"
              : popover.value.tab === "episodes"
                ? "Season episodes"
                : popover.value.tab === "playback"
                  ? "Audio and playback menu"
                  : popover.value.tab === "reactions"
                    ? "Live party reactions"
                    : "Subtitles menu"
          }
          data-glass-region={popover.value.tab === "reactions" ? undefined : "true"}
          style={{
            left: popover.value.pos.left,
            bottom: popover.value.pos.bottom,
            width: popover.value.pos.width,
            maxHeight: `max(110px, min(460px, calc(100vh - ${
              popover.value.pos.bottom + (showWindowBar ? 56 : 14)
            }px)))`,
          }}
          className={`${
            popover.value.tab === "reactions"
              ? "pointer-events-none fixed z-40 select-none overflow-visible"
              : "ep-glass-capsule ep-capsule-morph fixed z-40 select-none"
          } ${
            popover.exiting
              ? pinLeftExiting && popover.value.tab === "room"
                ? "ep-popover-pin-left-out pointer-events-none"
                : "ep-popover-bloom-out pointer-events-none"
              : "ep-popover-bloom"
          } ${
            popover.value.tab === "room" || popover.value.tab === "episodes"
              ? "flex flex-col overflow-hidden rounded-[22px] p-3"
              : popover.value.tab === "reactions"
                ? ""
                : "flex flex-col overflow-hidden rounded-[22px] p-3.5"
          }`}
        >
          {popover.value.tab === "playback" || popover.value.tab === "subtitles" ? (
            <div
              key={popover.value.tab}
              className="ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden -mr-2.5 pr-2.5 -ml-1 pl-1"
            >
              <div className="anim-tab-in">
                {popover.value.tab === "playback" ? <PlaybackPanel /> : <SubtitlePanel />}
              </div>
            </div>
          ) : (
            <div
              key={popover.value.tab}
              className={
                popover.value.tab === "room" || popover.value.tab === "episodes"
                  ? "flex flex-col flex-1 min-h-0 anim-tab-in"
                  : "anim-tab-in"
              }
            >
              {popover.value.tab === "room" && (
                <RoomPanel
                  onClose={() => setPanelOpen(false)}
                  onDockLeft={handleDockPartyLeft}
                  onChooseFile={() => void handleChooseFile()}
                  onChooseFolder={() => void handleChooseSeasonFolder()}
                  onSwitchEpisode={(idx) => void switchToPartyEpisode(idx)}
                  onOpenLocalMatch={(cand) => void handleOpenLocalMatch(cand)}
                />
              )}
              {popover.value.tab === "episodes" && (
                <EpisodesPanel
                  onSelectEpisode={(idx) => void selectEpisodeAtIndex(idx)}
                  onOpenSeasonFolder={() => void handleChooseSeasonFolder()}
                  onAddEpisodes={() => void handleChooseFile(true)}
                  onClose={() => setPanelOpen(false)}
                />
              )}
              {popover.value.tab === "reactions" && <ReactionPopover />}
            </div>
          )}
        </aside>
      )}

      <FloatingChatPeeks
        chromeVisible={showFloatingCapsule}
        popoverOpen={popover.mounted}
        localUsername={effectiveUserNow}
        onOpenChat={() => {
          wakeChrome();
          setChatSidebarOpenSmooth(true);
        }}
      />

      <FloatingReactionsOverlay
        enabled={Boolean(roomCode) && reactionsEnabled}
        chromeVisible={showFloatingCapsule}
        localUsername={effectiveUserNow}
        dockOpen={popover.mounted && popover.value?.tab === "reactions"}
      />

      <SkipIntroOverlay
        chromeVisible={showFloatingCapsule}
        popoverOpen={popover.mounted}
        lockedForLocalUser={introLockedNow}
      />

      <NextEpisodeOverlay
        chromeVisible={showFloatingCapsule}
        popoverOpen={popover.mounted}
        lockedForLocalUser={introLockedNow}
        onNextEpisode={handleOutroNextEpisode}
      />

      <RatingOverlay popoverOpen={popover.mounted} />

      <StageSpeakerOverlay
        enabled={
          Boolean(roomCode) &&
          voiceEnabled &&
          voiceJoined &&
          !effectivePartySidebarOpen &&
          !(panelOpen && sideTab === "room") &&
          (isFullscreen || chromeIdle)
        }
        speakers={voiceSpeakingPeers.filter(
          (name) => !voicePeerOverrides[name.trim().toLowerCase()]?.muted,
        )}
        localUsername={effectiveUserNow}
        localAvatarId={avatarId}
        localSpeaking={localVoiceSpeaking}
        localMuted={voiceMuted}
        localDeafened={voiceDeafened}
        localCaptureHealthy={voiceCaptureHealthy}
      />

      {/* Slim vertical liquid-glass bar on the right edge (only when placement is "edge") */}
      {roomCode &&
        chatTriggerPlacement === "edge" &&
        !chatSidebarOpen &&
        !chatSidebarPresence.mounted && (
          <button
            type="button"
            onClick={() => {
              wakeChrome();
              setChatSidebarOpenSmooth(true);
            }}
            aria-label="Open Party Chat"
            title="Open Party Chat (C)"
            className={`ep-chat-edge-rail absolute right-0 top-1/2 -translate-y-1/2 z-[36] rounded-l-2xl py-3 px-1.5 flex flex-col items-center gap-1.5 cursor-pointer ${
              showFloatingCapsule || unreadChatCount > 0
                ? "opacity-100"
                : "opacity-0 hover:opacity-100 focus-visible:opacity-100"
            }`}
          >
            <PlayerChatIcon size={16} className="text-white/85" />
            {unreadChatCount > 0 && (
              <span className="min-w-[16px] h-4 px-1 rounded-full bg-accent text-[9.5px] font-semibold text-white flex items-center justify-center num leading-none">
                {unreadChatCount > 9 ? "9+" : unreadChatCount}
              </span>
            )}
          </button>
        )}

      <div className="absolute bottom-0 inset-x-0 z-30 pointer-events-none">
        <TransportBar
          visible={showFloatingCapsule}
          activeTab={panelOpen ? sideTab : null}
          chatOpen={chatSidebarOpen}
          onToggleTab={handleToggleCapsuleTab}
          onToggleChat={toggleChatSidebar}
          onCloseDrawer={() => setPanelOpen(false)}
          onChooseFile={() => void handleChooseFile()}
          onLeaveRoom={handleLeaveRoom}
          onToggleFullscreen={toggleFullscreen}
          onPrevEpisode={handlePrevEpisode}
          onNextEpisode={handleNextEpisode}
          onTogglePartySidebar={toggleOrFocusPartyLounge}
          onBarHoverChange={handleBarHoverChange}
          drawerTabs={null}
          expandedDrawer={null}
        />
      </div>
      {!showFloatingCapsule && (
        <div
          onMouseEnter={wakeChrome}
          onMouseMove={wakeChrome}
          onClick={wakeChrome}
          title="Move mouse here to show controls"
          className={`absolute bottom-0 inset-x-0 z-20 cursor-pointer ${
            fullWidthPlayBar || isFullscreen ? "h-5" : "h-3"
          }`}
        />
      )}
      </div>

      {roomCode && chatSidebarPresence.mounted && (
        <ChatSidebar
          docked={chatDocked}
          exiting={chatSidebarPresence.exiting}
          width={effectiveChatWidth}
          topChromeOffset={!isFullscreen}
          partySidebarOpen={effectivePartySidebarOpen}
          onClose={() => setChatSidebarOpenSmooth(false)}
          onSeekToTimestamp={handleSeekToChatTimestamp}
          onResizingChange={setChatResizing}
          onDockTransitionEnd={() => finishChatLayoutTransition()}
        />
      )}

      <ContextMenu
        position={contextMenu}
        entries={contextMenuEntries}
        onClose={() => setContextMenu(null)}
      />

      {(settingsOpen || settingsEverOpened) && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onClose={closeSettings}
            onApplyServerConfig={(endpoint, password) => connectRoom(endpoint, password)}
          />
        </Suspense>
      )}
      {(shortcutsOpen || shortcutsEverOpened) && (
        <Suspense fallback={null}>
          <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
        </Suspense>
      )}
    </div>
  );
}
