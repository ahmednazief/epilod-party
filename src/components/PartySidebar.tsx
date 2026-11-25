import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { usePartyFileMismatch } from "../hooks/usePartyFileMismatch";
import { useWindowDragHeader } from "../hooks/useWindowDragHeader";
import { formatUserError } from "../lib/errors";
import { formatParticipantMatchBadge, formatReadableMediaName } from "../lib/fileMismatch";
import { formatInviteClipboardText } from "../lib/inviteLinks";
import type { LocalMatchCandidate } from "../lib/localLibrary";
import { MAX_PARTY_SIDEBAR_WIDTH, MIN_PARTY_SIDEBAR_WIDTH } from "../lib/partyLayout";
import { formatDisplayMediaTitle } from "../lib/playlist";
import { toggleReadyStatus } from "../lib/playerActions";
import { isTextEntryElement } from "../lib/shortcuts";
import { playSoundCue } from "../lib/soundEffects";
import {
  findMatchingFpsPreset,
  formatSignedOffset,
  FPS_PRESETS,
  isIdentityTransform,
} from "../lib/sourceAlignment";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import {
  LOCAL_DISCONNECT_TAG,
  NOT_READY_TAG_PREFIX,
  PEER_LEFT_TAG_PREFIX,
} from "../lib/syncReady";
import {
  describeSyncEndpoint,
  isCloudEndpoint,
  SYNCPLAY_ENDPOINT,
} from "../lib/syncStatusDisplay";
import {
  enqueueSyncLifecycle,
  onSyncHealth,
  syncReconnect,
  syncSetRoomAdmin,
  syncSwitchBackup,
  type Participant,
  type SyncHealthPayload,
} from "../lib/syncplay";
import {
  applyTimelineTransform,
  nudgeTimelineOffset,
  resetTimelineAlignment,
  runP2pAutoAlign,
  setSceneAlignMode,
} from "../lib/timelineActions";
import { usePresencePayload } from "../lib/useAnimatedPresence";
import { formatVoiceHotkey } from "../lib/voice";
import { isLocalVoiceSpeaking, toggleVoiceSession } from "../lib/voiceActions";
import { useAppStore } from "../store/useAppStore";
import { clearPartyChat } from "../store/useChatStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { clearReactions } from "../store/useReactionStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";
import { useVoiceStore } from "../store/useVoiceStore";
import { formatRoomCodeDisplay } from "./HomeScreen";
import {
  buildMemberMeta,
  MemberActionMenuPortal,
  type MemberMenuCoords,
  ParticipantDriftBadge,
  resolveHostPeerPosition,
  RoomAlignReadout,
  SecondAnchorButton,
  voiceTransportLabel,
} from "./PartyLoungeShared";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import {
  AppAlertIcon,
  AppChevronIcon,
  AppFolderIcon,
  AppHeadphonesIcon,
  AppMemberMenuArrowIcon,
  AppMicIcon,
  AppResetIcon,
  AppSeasonFolderIcon,
  AppSignalBarsIcon,
  AppSlidersIcon,
  AppVoiceTuneIcon,
  AppVoiceWaveIcon,
} from "./ui/AppIcons";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import { WatchPartyIcon } from "./ui/LobbyIcons";
import {
  PartyAdminIcon,
  PartyAlignSceneIcon,
  PartyCopyIcon,
  PartyFpsMatchIcon,
  PartyHostIcon,
  PartyLeaveIcon,
  PartyServerIcon,
  PartyUnpinIcon,
  PartyViewersIcon,
  PlayerCollapseLeftIcon,
  PlayerEyeIcon,
  PlayerPlayIcon,
  PlayerReadyIcon,
  PlayerResyncIcon,
} from "./ui/PlayerIcons";
import { PresenceAvatar } from "./ui/PresenceAvatar";
import { resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { StatusDot } from "./ui/StatusDot";
import { VoiceMicDeafenPills } from "./ui/VoiceQuickControls";
import { VoiceQuickSettingsTray } from "./ui/VoiceQuickSettingsTray";

interface PartySidebarProps {
  docked: boolean;
  exiting: boolean;
  width: number;
  topChromeOffset: boolean;
  onClose: () => void;
  onUnpin: () => void;
  onChooseFile?: () => void;
  onChooseFolder?: () => void;
  onSwitchEpisode?: (index: number) => void;
  onOpenLocalMatch?: (candidate: LocalMatchCandidate) => void;
  onResizingChange?: (resizing: boolean) => void;
  onDockTransitionEnd?: () => void;
}

export const PartySidebar = memo(function PartySidebar({
  docked,
  exiting,
  width,
  topChromeOffset,
  onClose,
  onUnpin,
  onChooseFile,
  onChooseFolder,
  onSwitchEpisode,
  onOpenLocalMatch,
  onResizingChange,
  onDockTransitionEnd,
}: PartySidebarProps) {
  const roomCode = useAppStore((s) => s.roomCode);
  const literalRoom = useAppStore((s) => s.literalRoom);
  const hostOnlyRoom = useAppStore((s) => s.hostOnlyRoom);
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const selectedFileName = useAppStore((s) => s.selectedFileName);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const setRoomCode = useAppStore((s) => s.setRoomCode);
  const setHostOnlyRoom = useAppStore((s) => s.setHostOnlyRoom);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);
  const setPartySidebarWidth = useAppStore((s) => s.setPartySidebarWidth);
  const openSettings = useAppStore((s) => s.openSettings);

  const status = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);
  const localReady = useSyncStore((s) => s.localReady);
  const timelineOffsetSecs = useSyncStore((s) => s.timelineOffsetSecs);
  const timelineScale = useSyncStore((s) => s.timelineScale);
  const alignMode = useSyncStore((s) => s.alignMode);
  const alignAnchor1 = useSyncStore((s) => s.alignAnchor1);
  const timelineSegments = useSyncStore((s) => s.timelineSegments);
  const p2pStatus = useSyncStore((s) => s.p2pStatus);

  const localLoaded = usePlayerStore((s) => s.loaded);
  const playerError = usePlayerStore((s) => s.playerError);
  const pushNote = useNotificationStore((s) => s.push);
  const { mismatch, localMatches } = usePartyFileMismatch();

  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const voiceJoined = useVoiceStore((s) => s.joined);
  const voiceJoining = useVoiceStore((s) => s.joining);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const voiceGateOpen = useVoiceStore((s) => s.localGateOpen);
  const voiceSpeakingPeers = useVoiceStore((s) => s.speakingPeers);
  const voiceRoster = useVoiceStore((s) => s.roster);
  const voiceStreamStatus = useVoiceStore((s) => s.streamStatus);
  const voiceStreamError = useVoiceStore((s) => s.streamError);
  const voiceSpeakerLeak = useVoiceStore((s) => s.speakerLeakDetected);
  const voiceBtHfpDropped = useVoiceStore((s) => s.bluetoothHfpDropped);
  const voiceLowBandwidth = useVoiceStore((s) => s.lowBandwidthWarning);
  const voicePeerOverrides = useVoiceStore((s) => s.peerOverrides);
  const voiceInputMode = useVoiceStore((s) => s.inputMode);
  const voicePttVk = useVoiceStore((s) => s.pttVk);
  const voicePttMod = useVoiceStore((s) => s.pttMod);

  const { isMaximized, handleMaximizedHeaderMouseDown } = useWindowDragHeader();

  const [copied, setCopied] = useState(false);
  const [busyAdminUser, setBusyAdminUser] = useState<string | null>(null);
  const [timingOpen, setTimingOpen] = useState(false);
  const [btPreJoinConfirm, setBtPreJoinConfirm] = useState(false);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [syncHealth, setSyncHealth] = useState<SyncHealthPayload | null>(null);
  const [healthCopied, setHealthCopied] = useState(false);
  const [openMemberUser, setOpenMemberUser] = useState<string | null>(null);
  const [memberMenuCoords, setMemberMenuCoords] = useState<MemberMenuCoords | null>(null);
  const [resizing, setResizing] = useState(false);
  const [dockExpanded, setDockExpanded] = useState(() => !docked || (reducedMotion && !exiting));

  const asideRef = useRef<HTMLElement | null>(null);
  const podRef = useRef<HTMLDivElement | null>(null);
  const voiceSetupBtnRef = useRef<HTMLButtonElement | null>(null);
  const voiceSetupBoxRef = useRef<HTMLDivElement | null>(null);
  const [voiceSetupCoords, setVoiceSetupCoords] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const memberAnchorRefs = useRef<Record<string, HTMLElement | null>>({});
  const memberMenuBoxRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const healthCopyTimerRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!docked) {
      setDockExpanded(true);
      return;
    }
    if (reducedMotion) {
      setDockExpanded(!exiting);
      return;
    }
    if (exiting) {
      setDockExpanded(false);
      return;
    }
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setDockExpanded(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [docked, exiting, reducedMotion]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void onSyncHealth((payload) => {
      if (active) setSyncHealth(payload);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      if (healthCopyTimerRef.current !== null) window.clearTimeout(healthCopyTimerRef.current);
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);

  const voiceCaptureHealthy =
    voiceStreamStatus !== "micBusy" &&
    voiceStreamStatus !== "reconnecting" &&
    voiceStreamStatus !== "permissionDenied";
  const localSpeaking = isLocalVoiceSpeaking({
    joined: voiceJoined,
    muted: voiceMuted,
    deafened: voiceDeafened,
    localGateOpen: voiceGateOpen,
    streamStatus: voiceStreamStatus,
  });

  const voicePeersInCall = voiceRoster.filter((r) => r.inVoice);
  const blockedVoicePeers = voicePeersInCall.filter((r) => r.transport === "blocked");
  const relayedVoicePeers = voicePeersInCall.filter((r) => r.transport === "relayed");
  const hasVoiceSectionActive = voiceJoined || voicePeersInCall.length > 0;

  const toggleMemberMenu = useCallback((peerKey: string) => {
    setVoiceSetupOpen(false);
    setOpenMemberUser((prev) => (prev === peerKey ? null : peerKey));
  }, []);

  // Position member card cleanly to the right of its sidebar row
  useLayoutEffect(() => {
    if (!openMemberUser) {
      setMemberMenuCoords(null);
      return;
    }

    const updatePosition = () => {
      const anchor = memberAnchorRefs.current[openMemberUser];
      const aside = asideRef.current;
      if (!anchor) {
        setOpenMemberUser(null);
        return;
      }
      const r = anchor.getBoundingClientRect();
      const asideRect = aside?.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const menuWidth = 216;
      const preferredLeft = asideRect ? asideRect.right + 10 : r.right + 10;
      const left = Math.max(12, Math.min(preferredLeft, vw - menuWidth - 12));
      const spaceBelow = vh - r.top - 14;
      if (spaceBelow < 185) {
        setMemberMenuCoords({
          peerKey: openMemberUser,
          left,
          bottom: Math.max(12, vh - r.bottom),
          origin: "left bottom",
        });
      } else {
        setMemberMenuCoords({
          peerKey: openMemberUser,
          left,
          top: Math.max(12, Math.min(r.top - 6, vh - 210)),
          origin: "left top",
        });
      }
    };

    const onScroll = (e: Event) => {
      if (
        memberMenuBoxRef.current &&
        e.target instanceof Node &&
        memberMenuBoxRef.current.contains(e.target)
      ) {
        return;
      }
      setOpenMemberUser(null);
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [openMemberUser, width]);

  useEffect(() => {
    if (!openMemberUser) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const anchor = memberAnchorRefs.current[openMemberUser];
      if (
        memberMenuBoxRef.current &&
        !memberMenuBoxRef.current.contains(target) &&
        (!anchor || !anchor.contains(target))
      ) {
        setOpenMemberUser(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpenMemberUser(null);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openMemberUser]);

  // Position Audio & Devices tray upward inside the sidebar column above the Self Voice Pod
  useLayoutEffect(() => {
    if (!voiceSetupOpen) {
      setVoiceSetupCoords(null);
      return;
    }

    const updatePosition = () => {
      const aside = asideRef.current;
      const pod = podRef.current;
      if (!aside || !pod) {
        setVoiceSetupOpen(false);
        return;
      }
      const asideRect = aside.getBoundingClientRect();
      const podRect = pod.getBoundingClientRect();
      const vh = window.innerHeight || 720;
      const trayWidth = Math.max(232, Math.min(272, Math.round(asideRect.width - 20)));
      const left = Math.max(10, Math.round(asideRect.left + (asideRect.width - trayWidth) / 2));
      const bottom = Math.max(14, Math.round(vh - podRect.top + 8));
      setVoiceSetupCoords({ left, bottom, width: trayWidth });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [voiceSetupOpen, width, voiceJoined]);

  useEffect(() => {
    if (!voiceSetupOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        voiceSetupBoxRef.current &&
        !voiceSetupBoxRef.current.contains(target) &&
        (!voiceSetupBtnRef.current || !voiceSetupBtnRef.current.contains(target))
      ) {
        setVoiceSetupOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setVoiceSetupOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [voiceSetupOpen]);

  const handleResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeCleanupRef.current?.();
    const startX = e.clientX;
    const startW = width;
    setResizing(true);
    onResizingChange?.(true);

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      setPartySidebarWidth(
        Math.max(MIN_PARTY_SIDEBAR_WIDTH, Math.min(MAX_PARTY_SIDEBAR_WIDTH, startW + delta)),
      );
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };
    const onUp = () => {
      setResizing(false);
      onResizingChange?.(false);
      cleanup();
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handleToggleVoice = async (listenOnly = false, skipBtCheck = false) => {
    const res = await toggleVoiceSession({
      listenOnly,
      skipBtCheck: skipBtCheck || btPreJoinConfirm,
    });
    if (res === "needsBtConfirm") {
      setBtPreJoinConfirm(true);
    } else if (res === "joined" || res === "left") {
      setBtPreJoinConfirm(false);
    }
  };

  const handleCopyRoom = async () => {
    try {
      const text = formatInviteClipboardText(roomCode, literalRoom, serverEndpoint);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      const p = usePlayerStore.getState();
      playSoundCue("codeCopied", { moviePlaying: p.loaded && !p.paused });
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1800);
    } catch {
      pushNote("info", `Room code: ${roomCode}`);
    }
  };

  const handleRetryConnect = () => {
    void enqueueSyncLifecycle(async () => {
      try {
        await syncReconnect();
      } catch (err) {
        pushNote("error", formatUserError(err, "Could not retry connection."));
      }
    });
  };

  const handleSwitchBackup = () => {
    const targetEndpoint = isCloudEndpoint(endpointSummary.activeEndpoint)
      ? SYNCPLAY_ENDPOINT
      : undefined;
    void enqueueSyncLifecycle(async () => {
      try {
        await syncSwitchBackup({
          username,
          roomCode,
          literalRoom,
          password: serverPassword || null,
          hostOnly: hostOnlyRoom,
          targetEndpoint,
        });
        pushNote(
          "info",
          targetEndpoint
            ? "Switching room to Syncplay fallback server."
            : "Switching room to backup connection route.",
        );
      } catch (err) {
        pushNote("error", formatUserError(err, "Backup route switch failed."));
      }
    });
  };

  const handleLeaveParty = () => {
    setHostOnlyRoom(false);
    setRoomCode("");
    useSyncStore.getState().reset();
    useVoiceStore.getState().resetSession();
    clearPartyChat();
    clearReactions();
    useSubtitleStore.getState().clearSharedSubtitles();
    const noteStore = useNotificationStore.getState();
    noteStore.dismissByTagPrefix(NOT_READY_TAG_PREFIX);
    noteStore.dismissByTagPrefix(PEER_LEFT_TAG_PREFIX);
    noteStore.dismissByTag(LOCAL_DISCONNECT_TAG);
    pushNote("info", "Left Watch Party — continuing solo playback.");
  };

  const handleTogglePeerAdmin = async (peerUsername: string, grant: boolean) => {
    if (busyAdminUser) return;
    setBusyAdminUser(peerUsername);
    try {
      await syncSetRoomAdmin(peerUsername, grant);
      pushNote(
        grant ? "success" : "info",
        grant
          ? `${peerUsername} can now control room playback.`
          : `Removed admin control from ${peerUsername}.`,
      );
    } catch (err) {
      pushNote("error", formatUserError(err, "Could not update admin permission."));
    } finally {
      setBusyAdminUser((prev) => (prev === peerUsername ? null : prev));
    }
  };

  const endpointSummary = describeSyncEndpoint(status, serverEndpoint);
  const syncConnected = status.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(status, username);
  const ctrlLock = getControllerLockState(
    syncConnected,
    participants,
    effectiveUsername,
    roomControl,
  );
  const hostPeerPos = resolveHostPeerPosition(participants, roomControl);

  const readyCount = participants.filter((p) => p.isReady).length;
  const allReady = participants.length > 0 && readyCount === participants.length;
  const hasConnectionIssue = status.state === "reconnecting" || status.state === "error";
  const hasTimelineAlignment =
    !isIdentityTransform({
      offsetSecs: timelineOffsetSecs,
      scale: timelineScale,
    }) || timelineSegments.length > 1;
  const scaleCalibrated = Math.abs(timelineScale - 1.0) > 0.001;
  const matchedPreset = findMatchingFpsPreset(timelineScale);
  const directP2pPeers =
    p2pStatus?.peers.filter(
      (p) => p.transport === "directLan" || p.transport === "directWan",
    ) ?? [];
  const hasDirectP2p = directP2pPeers.length > 0;
  const probingAudio = p2pStatus?.peers.some((p) => p.autoAlignState === "probing") ?? false;
  const activeAutoSummary =
    p2pStatus?.peers.find((p) => Boolean(p.summary))?.summary ?? null;
  const p2pLinkLabel = hasDirectP2p
    ? directP2pPeers.some((p) => p.transport === "directLan")
      ? "Direct LAN"
      : `Direct P2P${directP2pPeers[0]?.rttMs != null ? ` · ${directP2pPeers[0].rttMs}ms` : ""}`
    : p2pStatus?.peers.some((p) => p.transport === "punching")
      ? "Linking P2P…"
      : "Relay mode";
  const otherPeers = participants.filter(
    (p) => p.username.trim().toLowerCase() !== effectiveUsername.trim().toLowerCase(),
  );
  const suggestedFpsPeer = otherPeers.find(
    (p) => p.sourceRelation === "fpsMismatch" && typeof p.suggestedFpsScale === "number",
  );
  const hasSourceDifference = otherPeers.some(
    (p) =>
      p.sourceRelation === "differentCut" ||
      p.sourceRelation === "fpsMismatch" ||
      p.sourceRelation === "differentEncode" ||
      p.fileMatch === "durationMismatch" ||
      p.fileMatch === "sameLengthDifferentEncode",
  );
  const showTimingControls = syncConnected && localLoaded && otherPeers.length > 0;
  const timingSummaryText =
    timelineSegments.length > 1
      ? `${timelineSegments.length} cuts synced`
      : hasTimelineAlignment
        ? `${formatSignedOffset(timelineOffsetSecs)}${matchedPreset && matchedPreset.id !== "normal" ? ` · ${matchedPreset.label}` : scaleCalibrated ? ` · ${timelineScale.toFixed(3)}×` : ""}`
        : probingAudio
          ? "Matching audio…"
          : hasSourceDifference
            ? "Adjust for source"
            : "0.0s";

  const getMemberMeta = (p: Participant) =>
    buildMemberMeta({
      participant: p,
      effectiveUsername,
      ctrlLock,
      syncConnected,
      localLoaded,
      scaleCalibrated,
      hasTimelineAlignment,
      voiceEnabled,
      voiceJoined,
      voiceMuted,
      voiceDeafened,
      voiceCaptureHealthy,
      localSpeaking,
      voiceRoster,
      voiceSpeakingPeers,
      voicePeerOverrides,
    });

  const activeMenuParticipant = openMemberUser
    ? participants.find((p) => p.username.trim().toLowerCase() === openMemberUser) ?? null
    : null;
  const activeMenuPayload = usePresencePayload(
    activeMenuParticipant && memberMenuCoords && memberMenuCoords.peerKey === openMemberUser
      ? { participant: activeMenuParticipant, coords: memberMenuCoords }
      : null,
    160,
  );
  const voiceSetupPresence = usePresencePayload(
    voiceSetupOpen && voiceSetupCoords ? voiceSetupCoords : null,
    190,
  );

  // Split participants cleanly with zero duplicate rows
  const memberEntries = participants.map((p) => ({
    participant: p,
    meta: getMemberMeta(p),
  }));
  const voiceMembers = hasVoiceSectionActive
    ? memberEntries.filter((m) => m.meta.peerInVoice)
    : [];
  const watchingOnlyMembers = hasVoiceSectionActive
    ? memberEntries.filter((m) => !m.meta.peerInVoice)
    : memberEntries;

  const renderMemberRow = ({
    participant: p,
    meta,
  }: {
    participant: Participant;
    meta: ReturnType<typeof getMemberMeta>;
  }) => {
    const localHasFile = localLoaded && !playerError && Boolean(selectedFileName?.trim());
    const badge = formatParticipantMatchBadge(p, {
      localHasFile,
      isSelf: meta.isSelf,
      aligned: hasTimelineAlignment,
      scaleCalibrated,
    });
    const readablePeer = formatReadableMediaName(p.fileName);
    const cleanMediaTitle = p.fileName
      ? readablePeer.isPrivate
        ? "Private title"
        : formatDisplayMediaTitle(p.fileName).title || readablePeer.label
      : null;
    const peerVoiceBlocked =
      meta.voiceEntry?.transport === "blocked" || meta.voiceEntry?.transport === "unavailable";
    const baseTransport =
      meta.voiceEntry?.transport === "relayed" && meta.voiceEntry.relayVia
        ? `Relayed via ${meta.voiceEntry.relayVia}`
        : voiceTransportLabel(meta.voiceEntry?.transport);
    const voiceHealthSuffix = meta.voiceEntry?.healthReason
      ? ` · ${meta.voiceEntry.healthReason}${meta.voiceEntry.healthFix ? ` (${meta.voiceEntry.healthFix})` : ""}`
      : meta.voiceEntry?.bitrateKbps
        ? ` · ${Math.round(meta.voiceEntry.bitrateKbps)} kbps`
        : "";
    const voiceTransportDetail = meta.isSelf
      ? voiceCaptureHealthy
        ? voiceMuted
          ? "Mic muted"
          : "Mic ready"
        : voiceStreamStatus === "micBusy"
          ? "Mic busy in another app"
          : voiceStreamStatus === "permissionDenied"
            ? "Microphone access denied"
            : "Reconnecting audio…"
      : `${baseTransport}${voiceHealthSuffix}`;
    const voiceTipLabel = meta.voiceEntry?.deafened
      ? "Deafened"
      : meta.peerLocallyMuted
        ? "Muted by you"
        : meta.voiceEntry?.muted
          ? "Mic muted"
          : meta.peerSpeaking && !meta.peerLocallyMuted
            ? "Speaking"
            : "In voice";
    const voiceTipAccent: "speaking" | "bad" | "warn" | "ok" =
      meta.voiceEntry?.deafened || meta.voiceEntry?.muted || meta.peerLocallyMuted
        ? "bad"
        : peerVoiceBlocked || (meta.isSelf && !voiceCaptureHealthy)
          ? "warn"
          : meta.peerSpeaking
            ? "speaking"
            : "ok";
    const isMenuOpen =
      memberMenuCoords?.peerKey === meta.peerKey && openMemberUser === meta.peerKey;
    const customVolPct = Math.round(meta.peerVolOv.volume * 100);

    const hasVoiceIssue =
      peerVoiceBlocked ||
      Boolean(meta.voiceEntry?.deafened) ||
      Boolean(meta.voiceEntry?.muted) ||
      Boolean(meta.peerLocallyMuted) ||
      (!meta.isSelf && customVolPct !== 100);
    const hasSyncLag =
      !meta.isSelf &&
      (p.buffering || (typeof p.lagSecs === "number" && Math.abs(p.lagSecs) >= 1.5));
    const hasAbnormalState = badge.isMismatch || !p.isReady || hasSyncLag;
    const hoverDetail = [
      cleanMediaTitle ? `${badge.text} · ${cleanMediaTitle}` : badge.text,
      meta.peerInVoice ? voiceTransportDetail : p.isReady ? "Ready" : "Waiting for video",
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div
        key={p.username}
        onClick={() => {
          if (!meta.hasMemberActions) return;
          toggleMemberMenu(meta.peerKey);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!meta.hasMemberActions) return;
          toggleMemberMenu(meta.peerKey);
        }}
        className={`group px-2 py-1.5 rounded-lg flex items-center gap-2.5 min-w-0 transition-colors hover:bg-white/[0.05] ${
          meta.hasMemberActions ? "cursor-pointer" : ""
        }`}
      >
        <PresenceAvatar
          avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
          size={26}
          speaking={meta.peerSpeaking && !meta.peerLocallyMuted}
          status={badge.isMismatch ? "mismatch" : "none"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5 min-w-0">
            <GlassHoverTip
              label={`${p.username}${meta.isSelf ? " (you)" : ""}`}
              detail={hoverDetail}
              accent={
                badge.isMismatch
                  ? "warn"
                  : meta.peerSpeaking && !meta.peerLocallyMuted
                    ? "speaking"
                    : "default"
              }
              disabled={isMenuOpen}
              className="inline-flex items-center gap-1 min-w-0"
            >
              <span className="inline-flex items-center gap-1 min-w-0">
                <span
                  className={`text-[13px] font-medium truncate transition-colors ${
                    meta.peerSpeaking && !meta.peerLocallyMuted
                      ? "text-white"
                      : isMenuOpen
                        ? "text-white"
                        : "text-white/85 group-hover:text-white"
                  }`}
                >
                  {p.username}
                </span>
                {meta.isSelf && <span className="text-[10.5px] text-muted shrink-0">you</span>}
                {meta.isRowHost && (
                  <span aria-label="Room Host" className="inline-flex items-center shrink-0 opacity-75">
                    <PartyHostIcon size={12} />
                  </span>
                )}
                {!meta.isRowHost && meta.isRowAdmin && (
                  <span aria-label="Room Admin" className="inline-flex items-center shrink-0 opacity-75">
                    <PartyAdminIcon size={11} />
                  </span>
                )}
              </span>
            </GlassHoverTip>

            <div className="flex items-center gap-1 shrink-0">
              {meta.peerInVoice && hasVoiceIssue && (
                <GlassHoverTip
                  label={voiceTipLabel}
                  detail={voiceTransportDetail}
                  accent={voiceTipAccent}
                  disabled={isMenuOpen}
                >
                  <span
                    aria-label={`${p.username} ${voiceTipLabel}`}
                    className={`inline-flex items-center gap-1 px-1 py-0.5 rounded text-[10px] font-medium ${
                      peerVoiceBlocked
                        ? "text-warn"
                        : meta.voiceEntry?.deafened || meta.voiceEntry?.muted || meta.peerLocallyMuted
                          ? "text-bad"
                          : "text-secondary"
                    }`}
                  >
                    {meta.voiceEntry?.deafened ? (
                      <AppHeadphonesIcon deafened size={12} />
                    ) : (
                      <AppMicIcon
                        muted={Boolean(meta.voiceEntry?.muted || meta.peerLocallyMuted)}
                        speaking={false}
                        size={12}
                      />
                    )}
                    {!meta.isSelf && !meta.peerLocallyMuted && customVolPct !== 100 && (
                      <span className="num text-[9.5px] text-secondary">{customVolPct}%</span>
                    )}
                  </span>
                </GlassHoverTip>
              )}

              <ParticipantDriftBadge participant={p} hostPeerPos={hostPeerPos} hideWhenOk />

              {!p.isReady && (
                <GlassHoverTip label="Not ready" detail="Waiting for video" accent="warn">
                  <span
                    aria-label="Not ready"
                    className="inline-flex items-center shrink-0 cursor-default"
                  >
                    <PlayerReadyIcon ready={false} size={12} />
                  </span>
                </GlassHoverTip>
              )}

              {meta.hasMemberActions ? (
                <GlassHoverTip label="Member actions" detail="Voice & role" disabled={isMenuOpen}>
                  <button
                    ref={(el) => {
                      memberAnchorRefs.current[meta.peerKey] = el;
                    }}
                    type="button"
                    aria-label={`Actions for ${p.username}`}
                    aria-expanded={isMenuOpen}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMemberMenu(meta.peerKey);
                    }}
                    className={`ep-press h-5.5 w-5.5 rounded-md flex items-center justify-center cursor-pointer ${
                      isMenuOpen
                        ? "text-white bg-white/15 opacity-100"
                        : "text-secondary hover:text-white hover:bg-white/[0.08] opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <AppMemberMenuArrowIcon open={isMenuOpen} size={13} />
                  </button>
                </GlassHoverTip>
              ) : (
                <span className="w-5.5 shrink-0" aria-hidden="true" />
              )}
            </div>
          </div>

          {hasAbnormalState && (
            <div className="flex items-center gap-1.5 text-[10.5px] leading-tight min-w-0 mt-0.5">
              {badge.isMismatch ? (
                <span className={`font-medium truncate ${badge.className}`}>{badge.text}</span>
              ) : !p.isReady ? (
                <span className="text-warn/90 truncate">Not ready</span>
              ) : hasSyncLag ? (
                <span className="text-warn font-medium num truncate">
                  {p.buffering
                    ? "Buffering"
                    : `${(p.lagSecs ?? 0) > 0 ? "-" : "+"}${Math.abs(p.lagSecs ?? 0).toFixed(1)}s`}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    );
  };

  const selfStatusText = voiceJoined
    ? voiceJoining
      ? "Connecting…"
      : !voiceCaptureHealthy
        ? voiceStreamStatus === "micBusy"
          ? "Mic in use"
          : voiceStreamStatus === "permissionDenied"
            ? "Mic blocked"
            : "Reconnecting…"
        : voiceDeafened
          ? "Deafened"
          : voiceMuted
            ? "Mic muted"
            : "In Voice"
    : localReady
      ? "Ready"
      : "Not ready";

  const asideEl = (
    <aside
      ref={asideRef}
      aria-label="Party Lounge"
      data-docked-sidebar={docked ? "true" : undefined}
      onContextMenu={(e) => {
        if (isTextEntryElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ width: `${width}px` }}
      className={`ep-party-sidebar relative h-full flex flex-col shrink-0 select-none overflow-hidden ${
        docked
          ? `ep-party-dock-panel ${exiting ? "pointer-events-none" : ""}`
          : `fixed top-0 left-0 bottom-0 z-[42] ${
              exiting ? "ep-party-sidebar-out pointer-events-none" : "ep-party-sidebar-in"
            }`
      }`}
    >
      {/* Right drag-to-resize grip */}
      <div
        aria-hidden="true"
        onPointerDown={handleResizePointerDown}
        className="absolute top-0 bottom-0 right-0 w-2 z-20 cursor-col-resize group flex justify-end"
      >
        <span
          className={`w-[2px] h-full transition-opacity ${
            resizing
              ? "bg-accent-soft/75 opacity-100"
              : "bg-accent-soft/45 opacity-0 group-hover:opacity-100"
          }`}
        />
      </div>

      {/* Zone 1: Drag-Enabled Lounge Header */}
      <div
        data-tauri-drag-region={isMaximized ? "false" : "deep"}
        onMouseDown={handleMaximizedHeaderMouseDown}
        className={`ep-chat-header-zone px-3.5 pb-2 flex items-center justify-between gap-2 shrink-0 ep-party-zone-stagger-1 ${
          !docked && topChromeOffset ? "pt-[48px]" : "pt-3.5"
        }`}
      >
        <div className="min-w-0 flex items-center gap-2">
          <WatchPartyIcon bare size={16} className="shrink-0" />
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold tracking-tight text-white leading-tight truncate">
              Party Lounge
            </h2>
            <div className="flex items-center gap-1.5 mt-0.5 leading-none">
              <GlassHoverTip
                disabled={!syncConnected || !syncHealth}
                label={
                  healthCopied
                    ? "Copied diagnostics"
                    : syncHealth
                      ? `RTT ${syncHealth.rttMs !== null ? `${Math.round(syncHealth.rttMs)}ms` : "—"} · Drift ${syncHealth.driftSecs.toFixed(2)}s`
                      : "Connected"
                }
                detail={
                  healthCopied
                    ? undefined
                    : syncHealth
                      ? `Jitter ${Math.round(syncHealth.jitterMs)}ms · Click to copy`
                      : undefined
                }
                accent={syncConnected ? "ok" : "warn"}
              >
                <button
                  type="button"
                  disabled={!syncConnected || !syncHealth}
                  onClick={() => {
                    if (!syncHealth) return;
                    void navigator.clipboard
                      ?.writeText(JSON.stringify(syncHealth, null, 2))
                      .catch(() => undefined);
                    setHealthCopied(true);
                    if (healthCopyTimerRef.current !== null) {
                      window.clearTimeout(healthCopyTimerRef.current);
                    }
                    healthCopyTimerRef.current = window.setTimeout(() => {
                      healthCopyTimerRef.current = null;
                      setHealthCopied(false);
                    }, 1500);
                  }}
                  className={`inline-flex items-center gap-1.5 text-[10.5px] font-medium ${
                    syncConnected && syncHealth ? "cursor-pointer hover:text-white" : "cursor-default"
                  } ${
                    status.state === "error"
                      ? "text-bad"
                      : status.state === "reconnecting"
                        ? "text-warn"
                        : syncConnected
                          ? "text-secondary/90"
                          : "text-muted"
                  }`}
                >
                  <StatusDot
                    tone={
                      status.state === "error"
                        ? "bad"
                        : syncConnected
                          ? "ok"
                          : "warn"
                    }
                    pulse={!syncConnected}
                  />
                  <span>
                    {status.state === "error"
                      ? "Paused"
                      : status.state === "reconnecting"
                        ? "Reconnecting"
                        : syncConnected
                          ? healthCopied
                            ? "Copied"
                            : participants.length <= 1
                              ? "Just you"
                              : `${participants.length} watching`
                          : "Connecting…"}
                  </span>
                </button>
              </GlassHoverTip>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <GlassHoverTip label="Unpin to Play Bar" detail="Return to compact popover">
            <button
              type="button"
              onClick={onUnpin}
              aria-label="Unpin Party Lounge to Play Bar"
              className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
            >
              <PartyUnpinIcon size={14} />
            </button>
          </GlassHoverTip>

          <button
            type="button"
            onClick={onClose}
            aria-label="Hide Party Lounge"
            title="Collapse Party Lounge (P)"
            className="ep-bar-icon-btn h-7 w-7 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-secondary hover:text-white cursor-pointer"
          >
            <PlayerCollapseLeftIcon size={15} />
          </button>
        </div>
      </div>

      {/* Zone 2: Compact Invite Pill & Active Alerts */}
      <div className="px-3 pb-2 space-y-2 shrink-0 ep-party-zone-stagger-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleCopyRoom()}
            title="Click to copy invite code"
            className="ep-menu-row ep-press flex-1 min-w-0 h-8 px-2.5 rounded-lg bg-white/[0.035] hover:bg-white/[0.07] flex items-center justify-between gap-2 text-left cursor-pointer"
          >
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <span className="text-[10.5px] text-muted shrink-0">
                {literalRoom ? "Room" : "Invite"}
              </span>
              <span className="text-[12.5px] font-semibold tracking-[0.12em] text-white/90 num truncate">
                {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)}
              </span>
            </span>
            <span
              className={`inline-flex items-center gap-1 text-[10.5px] font-medium shrink-0 transition-colors ${
                copied ? "text-ok" : "text-muted"
              }`}
            >
              <PartyCopyIcon copied={copied} size={12} />
              <span>{copied ? "Copied" : "Copy"}</span>
            </span>
          </button>

          <GlassHoverTip label="Leave Watch Party" detail="Keep watching solo" accent="bad">
            <button
              type="button"
              onClick={handleLeaveParty}
              aria-label="Leave Watch Party"
              className="ep-press h-8 px-2 rounded-lg bg-white/[0.035] hover:bg-bad/15 inline-flex items-center justify-center gap-1 text-[11px] font-medium text-muted hover:text-bad shrink-0 cursor-pointer"
            >
              <PartyLeaveIcon size={12} />
              <span>Leave</span>
            </button>
          </GlassHoverTip>
        </div>

        <AnimatedCollapse open={hasConnectionIssue}>
          <div className="px-2 py-1.5 rounded-xl bg-bad/10 flex items-center justify-between gap-2 text-[10.5px] text-bad">
            <span className="truncate">{endpointSummary.detailText || "Connection interrupted"}</span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={handleRetryConnect}
                className="ep-bar-icon-btn h-6 px-2 rounded-full inline-flex items-center gap-1 font-medium text-white cursor-pointer"
              >
                <PlayerResyncIcon tone="warn" size={11} />
                <span>Retry</span>
              </button>
              {status.state === "reconnecting" && status.suggestBackup && !endpointSummary.isBackupServer && (
                <button
                  type="button"
                  onClick={handleSwitchBackup}
                  className="ep-bar-icon-btn h-6 px-2 rounded-full inline-flex items-center gap-1 font-medium text-secondary hover:text-white cursor-pointer"
                >
                  <PartyServerIcon size={11} />
                  <span>Backup</span>
                </button>
              )}
            </div>
          </div>
        </AnimatedCollapse>

        <AnimatedCollapse open={Boolean(mismatch)}>
          {mismatch && (
            <div
              role="alert"
              className="ep-glass-warning-inline rounded-[14px] px-2.5 py-2 flex items-start gap-2 text-left"
            >
              <AppAlertIcon variant="warn" size={13} className="text-warn shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[11px] font-semibold text-white truncate">
                    {mismatch.title}
                  </span>
                  {mismatch.deltaBadge && (
                    <span className="num text-[10px] font-semibold text-warn shrink-0">
                      {mismatch.deltaBadge}
                    </span>
                  )}
                </div>
                <p className="text-[10.5px] text-secondary leading-snug">{mismatch.message}</p>
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {mismatch.matchedPlaylistItem && onSwitchEpisode && (
                    <button
                      type="button"
                      onClick={() => onSwitchEpisode(mismatch.matchedPlaylistItem!.index)}
                      className="ep-warning-action ep-press h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10px] font-semibold text-white cursor-pointer"
                    >
                      <PlayerPlayIcon size={9} />
                      <span>Open {mismatch.matchedPlaylistItem.label}</span>
                    </button>
                  )}
                  {!mismatch.matchedPlaylistItem && localMatches.length > 0 && onOpenLocalMatch && (
                    <button
                      type="button"
                      title={`${localMatches[0].path}\n${localMatches[0].reason}`}
                      onClick={() => onOpenLocalMatch(localMatches[0])}
                      className="ep-warning-action ep-press h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10px] font-semibold text-white cursor-pointer max-w-[200px]"
                    >
                      <PlayerPlayIcon size={9} className="shrink-0" />
                      <span className="truncate">Open &amp; Sync: {localMatches[0].fileName}</span>
                    </button>
                  )}
                  {onChooseFile && (
                    <button
                      type="button"
                      onClick={onChooseFile}
                      className={`${
                        mismatch.matchedPlaylistItem || localMatches.length > 0
                          ? "ep-bar-pill text-secondary hover:text-white"
                          : "ep-warning-action ep-press text-white font-semibold"
                      } h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10px] font-medium cursor-pointer`}
                    >
                      <AppFolderIcon size={10} />
                      <span>{mismatch.kind === "notOpenOnPc" ? "Open Video…" : "Change…"}</span>
                    </button>
                  )}
                  {mismatch.kind === "notOpenOnPc" &&
                    !mismatch.matchedPlaylistItem &&
                    localMatches.length === 0 &&
                    onChooseFolder && (
                      <button
                        type="button"
                        onClick={onChooseFolder}
                        className="ep-bar-pill h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10px] font-medium text-secondary hover:text-white cursor-pointer"
                      >
                        <AppSeasonFolderIcon size={10} />
                        <span>Folder…</span>
                      </button>
                    )}
                </div>
              </div>
            </div>
          )}
        </AnimatedCollapse>
      </div>

      {/* Zone 3: Scrollable Voice Lounge, Watchers & Source Timing */}
      <div className="ep-menu-scroll ep-chat-feed-mask flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2.5 py-1.5 space-y-3 ep-party-zone-stagger-3">
        {/* Voice Lounge Channel Section */}
        {syncConnected && (
          <div className="space-y-1">
            {!voiceEnabled ? (
              <div className="px-2 py-1.5 rounded-lg bg-white/[0.03] flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">Voice chat disabled</span>
                <button
                  type="button"
                  onClick={() => openSettings("voice")}
                  className="ep-press px-2 py-0.5 rounded-md text-[10.5px] font-medium text-secondary hover:text-white hover:bg-white/[0.08] cursor-pointer"
                >
                  Enable
                </button>
              </div>
            ) : hasVoiceSectionActive ? (
              <>
                <div className="flex items-center gap-1">
                  {voiceJoined ? (
                    <div className="flex-1 min-w-0 px-2 py-1 flex items-center justify-between gap-2 text-[11px]">
                      <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider text-secondary/85 truncate">
                        <AppVoiceWaveIcon active speaking={false} size={12} />
                        <span>Voice Lounge</span>
                      </span>
                      <span className="num text-[10.5px] text-muted shrink-0">
                        {voiceMembers.length}
                      </span>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={voiceJoining}
                        onClick={() => void handleToggleVoice(false)}
                        title="Click to join Voice Lounge"
                        className="ep-press flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-white/[0.035] hover:bg-white/[0.07] flex items-center justify-between gap-2 text-[11px] text-secondary hover:text-white cursor-pointer disabled:opacity-60"
                      >
                        <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider truncate">
                          <AppVoiceWaveIcon active={false} speaking={false} size={12} />
                          <span>{voiceJoining ? "Joining…" : "Voice Lounge"}</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 shrink-0">
                          <span className="num text-[10.5px] text-muted">
                            {voiceMembers.length}
                          </span>
                          <span className="text-[10.5px] font-medium text-accent-soft">
                            Join
                          </span>
                        </span>
                      </button>
                      <GlassHoverTip label="Listen Only" detail="Join muted without capturing mic">
                        <button
                          type="button"
                          disabled={voiceJoining}
                          onClick={() => void handleToggleVoice(true)}
                          aria-label="Listen Only"
                          className="ep-press h-6.5 w-6.5 rounded-md flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.08] cursor-pointer disabled:opacity-60 shrink-0"
                        >
                          <AppHeadphonesIcon size={13} />
                        </button>
                      </GlassHoverTip>
                    </>
                  )}
                </div>

                {!hideParticipants && (
                  <div className="pl-2 flex flex-col gap-0.5">
                    {voiceMembers.map((entry) => renderMemberRow(entry))}
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={voiceJoining}
                  onClick={() => void handleToggleVoice(false)}
                  title="Click to join Voice Lounge"
                  className="ep-press flex-1 min-w-0 px-2 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] flex items-center justify-between gap-2 text-left cursor-pointer disabled:opacity-60"
                >
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <AppVoiceWaveIcon active={false} speaking={false} size={13} className="text-secondary shrink-0" />
                    <span className="text-[12px] font-medium text-white/90 truncate">
                      {voiceJoining ? "Joining Voice…" : "Voice Lounge"}
                    </span>
                  </span>
                  <span className="text-[10.5px] font-medium text-muted shrink-0">Join</span>
                </button>
                <GlassHoverTip label="Listen Only" detail="Join muted without capturing mic">
                  <button
                    type="button"
                    disabled={voiceJoining}
                    onClick={() => void handleToggleVoice(true)}
                    aria-label="Listen Only"
                    className="ep-press h-8 w-8 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] flex items-center justify-center text-secondary hover:text-white cursor-pointer disabled:opacity-60 shrink-0"
                  >
                    <AppHeadphonesIcon size={13} />
                  </button>
                </GlassHoverTip>
              </div>
            )}

            <AnimatedCollapse open={btPreJoinConfirm && !voiceJoined} innerClassName="pt-0.5">
              <div
                role="alert"
                className="ep-glass-warning-inline rounded-[12px] px-2.5 py-2 space-y-1.5 text-[10.5px]"
              >
                <p className="text-secondary leading-snug">
                  Bluetooth mic active — hands-free mode reduces movie audio quality.
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleToggleVoice(false, true)}
                    className="ep-warning-action ep-press h-6 px-2.5 rounded-full text-[10px] font-semibold text-white cursor-pointer"
                  >
                    Join Anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggleVoice(true, true)}
                    className="ep-bar-pill ep-press h-6 px-2.5 rounded-full text-[10px] font-medium text-secondary hover:text-white cursor-pointer"
                  >
                    Listen Only
                  </button>
                  <button
                    type="button"
                    onClick={() => setBtPreJoinConfirm(false)}
                    className="h-6 px-1.5 text-[10px] text-muted hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </AnimatedCollapse>

            <AnimatedCollapse
              open={
                voiceJoined &&
                (voiceStreamStatus === "micBusy" ||
                  voiceStreamStatus === "reconnecting" ||
                  voiceStreamStatus === "permissionDenied" ||
                  Boolean(voiceStreamError) ||
                  voiceBtHfpDropped ||
                  voiceSpeakerLeak ||
                  voiceLowBandwidth ||
                  blockedVoicePeers.length > 0)
              }
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-secondary px-2 pt-0.5">
                {voiceStreamStatus === "micBusy" && (
                  <span className="text-bad font-medium">Mic in use by another app</span>
                )}
                {voiceStreamStatus === "reconnecting" && (
                  <span className="text-warn font-medium">Reconnecting audio device…</span>
                )}
                {voiceStreamStatus === "permissionDenied" && (
                  <span className="text-bad font-medium">Microphone permission denied</span>
                )}
                {voiceStreamError &&
                  voiceStreamStatus !== "micBusy" &&
                  voiceStreamStatus !== "reconnecting" &&
                  voiceStreamStatus !== "permissionDenied" && (
                    <span className="text-warn">{voiceStreamError}</span>
                  )}
                {voiceBtHfpDropped && (
                  <span className="text-warn font-medium">
                    Bluetooth mic dropped — switch mic or Listen Only
                  </span>
                )}
                {voiceSpeakerLeak && (
                  <span className="text-warn font-medium">
                    Speaker echo guard active (headphones recommended)
                  </span>
                )}
                {voiceLowBandwidth && (
                  <span className="text-warn">Low upload bandwidth — audio adapted</span>
                )}
                {blockedVoicePeers.length > 0 && (
                  <span className="text-warn">
                    Voice blocked for {blockedVoicePeers.map((b) => b.username).join(", ")}
                  </span>
                )}
              </div>
            </AnimatedCollapse>
          </div>
        )}

        {/* Watching / Watching Only Roster */}
        <AnimatedCollapse
          open={watchingOnlyMembers.length > 0 || !hasVoiceSectionActive || hideParticipants}
          durationMs={220}
          innerClassName="space-y-1"
        >
          <div className="px-2 flex items-center justify-between gap-2 text-[10.5px]">
            <div className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-secondary/85">
              <PartyViewersIcon size={12} className="shrink-0" />
              <span>{hasVoiceSectionActive ? "Watching Only" : "Watching"}</span>
              <span className="num text-muted font-medium">
                {hasVoiceSectionActive ? watchingOnlyMembers.length : participants.length}
              </span>
            </div>
            {!hideParticipants && participants.length > 0 && !allReady && (
              <span className="font-medium num text-warn">
                {readyCount}/{participants.length} ready
              </span>
            )}
          </div>

          {hideParticipants ? (
            <button
              type="button"
              onClick={() => setHideParticipants(false)}
              className="ep-menu-row ep-press w-full px-2.5 py-2 rounded-xl flex items-center justify-between gap-2 text-left text-xs text-secondary hover:text-white cursor-pointer"
            >
              <span className="inline-flex items-center gap-2">
                <PlayerEyeIcon hidden size={14} />
                <span>Profile icons hidden</span>
              </span>
              <span className="text-[11px] font-medium text-accent-soft">Show</span>
            </button>
          ) : participants.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-muted">
              {syncConnected ? "Syncing participant list…" : "Connecting to room…"}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {watchingOnlyMembers.map((entry) => renderMemberRow(entry))}
              {participants.length === 1 && (
                <div className="px-2.5 pt-1 text-[10.5px] text-muted leading-relaxed">
                  Waiting for friends — share the invite code above to watch together.
                </div>
              )}
            </div>
          )}
        </AnimatedCollapse>

        {/* Progressive Source Timing Drawer */}
        {showTimingControls &&
          (hasSourceDifference || hasTimelineAlignment || alignMode || probingAudio || timingOpen ? (
            <div className="flex flex-col pt-0.5">
              <button
                type="button"
                aria-expanded={timingOpen || alignMode}
                onClick={() => setTimingOpen((o) => !o)}
                className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center justify-between gap-2 text-left cursor-pointer"
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  <AppSlidersIcon size={13} className="text-accent-soft shrink-0" />
                  <span className="text-[11.5px] font-medium text-secondary truncate">
                    Source Timing
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 shrink-0">
                  <span
                    className={`text-[10.5px] font-medium num ${
                      hasTimelineAlignment
                        ? "text-ok"
                        : hasSourceDifference
                          ? "text-warn"
                          : "text-muted"
                    }`}
                  >
                    {timingSummaryText}
                  </span>
                  <AppChevronIcon
                    direction="right"
                    size={12}
                    className={`text-muted transition-transform duration-200 ${
                      timingOpen || alignMode ? "rotate-90" : ""
                    }`}
                  />
                </span>
              </button>

              <AnimatedCollapse open={timingOpen || alignMode}>
                <div className="pt-1.5 px-0.5">
                  <div className="ep-glass-well rounded-2xl p-2 space-y-2">
                    <div className="flex items-center justify-between gap-2 px-1 text-[10.5px]">
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <StatusDot
                          tone={hasDirectP2p ? "ok" : probingAudio ? "warn" : "muted"}
                          pulse={probingAudio}
                        />
                        <span className={hasDirectP2p ? "text-secondary font-medium" : "text-muted"}>
                          {p2pLinkLabel}
                        </span>
                      </span>
                      {hasDirectP2p && !alignMode && (
                        <button
                          type="button"
                          onClick={() => void runP2pAutoAlign(true)}
                          disabled={probingAudio}
                          className="ep-bar-pill ep-press h-5.5 px-2 rounded-full inline-flex items-center gap-1 text-[10px] font-medium text-accent-soft hover:text-white disabled:opacity-50 cursor-pointer"
                        >
                          <PartyAlignSceneIcon size={10} />
                          <span>
                            {probingAudio
                              ? "Matching…"
                              : hasTimelineAlignment
                                ? "Re-align"
                                : "Auto-Align"}
                          </span>
                        </button>
                      )}
                    </div>

                    {activeAutoSummary && (
                      <div className="px-2 py-1 rounded-lg bg-white/[0.05] text-[10px] text-secondary truncate">
                        {activeAutoSummary}
                      </div>
                    )}

                    {suggestedFpsPeer && !scaleCalibrated && suggestedFpsPeer.suggestedFpsScale && (
                      <button
                        type="button"
                        onClick={() =>
                          void applyTimelineTransform(
                            {
                              offsetSecs: timelineOffsetSecs,
                              scale: suggestedFpsPeer.suggestedFpsScale!,
                            },
                            `FPS matched (${suggestedFpsPeer.suggestedFpsLabel ?? "calibrated"})`,
                          )
                        }
                        className="ep-glass-primary-pill ep-press w-full h-7 rounded-xl px-2.5 flex items-center justify-between gap-2 text-[10.5px] font-medium text-white cursor-pointer"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <PartyFpsMatchIcon size={11} />
                          <span>Match {suggestedFpsPeer.suggestedFpsLabel}</span>
                        </span>
                        <span className="text-[10px] text-white/75">1-click</span>
                      </button>
                    )}

                    {alignMode ? (
                      <RoomAlignReadout timelineScale={timelineScale} />
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void setSceneAlignMode(true)}
                          className="ep-bar-icon-btn ep-press flex-1 h-7 px-2 rounded-xl inline-flex items-center justify-center gap-1.5 text-[10.5px] font-medium text-primary hover:text-white cursor-pointer"
                        >
                          <PartyAlignSceneIcon size={11} />
                          <span>Align Scene…</span>
                        </button>
                        {hasTimelineAlignment && (
                          <button
                            type="button"
                            onClick={() => void resetTimelineAlignment()}
                            className="ep-bar-icon-btn ep-press h-7 px-2 rounded-xl inline-flex items-center gap-1 text-[10.5px] text-muted hover:text-white cursor-pointer"
                          >
                            <AppResetIcon size={11} />
                            <span>Reset</span>
                          </button>
                        )}
                      </div>
                    )}

                    {alignAnchor1 && !alignMode && (
                      <SecondAnchorButton anchorRoomSecs={alignAnchor1.roomSecs} />
                    )}

                    <div className="space-y-1">
                      <div className="flex items-center justify-between px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                        <span>Quick Nudge</span>
                        <span className="normal-case font-medium num text-secondary">
                          {formatSignedOffset(timelineOffsetSecs)}
                        </span>
                      </div>
                      <div className="ep-glass-tray p-0.5 rounded-xl grid grid-cols-6 gap-0.5 text-[10px]">
                        {[-5, -0.5, -0.1, 0.1, 0.5, 5].map((delta) => (
                          <button
                            key={delta}
                            type="button"
                            onClick={() => void nudgeTimelineOffset(delta)}
                            className="ep-press ep-tray-option h-6 rounded-[8px] num text-secondary hover:text-white cursor-pointer"
                          >
                            {delta > 0 ? `+${delta}s` : `${delta}s`}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="px-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/70">
                        Framerate Ratio
                      </div>
                      <SegmentedTabs
                        ariaLabel="Framerate ratio"
                        size="sm"
                        fullWidth
                        value={
                          FPS_PRESETS.find((p) => Math.abs(timelineScale - p.scale) <= 0.0002)?.id ??
                          null
                        }
                        items={FPS_PRESETS.map((preset) => ({
                          value: preset.id,
                          label: preset.label,
                          title: preset.shortLabel,
                        }))}
                        onChange={(presetId) => {
                          const preset = FPS_PRESETS.find((p) => p.id === presetId);
                          if (!preset) return;
                          void applyTimelineTransform(
                            { offsetSecs: timelineOffsetSecs, scale: preset.scale },
                            preset.id === "normal"
                              ? "Playback speed set to 1.0×"
                              : `FPS ratio: ${preset.shortLabel}`,
                          );
                        }}
                      />
                    </div>
                  </div>
                </div>
              </AnimatedCollapse>
            </div>
          ) : (
            <div className="pt-0.5 flex justify-start px-0.5">
              <button
                type="button"
                onClick={() => setTimingOpen(true)}
                className="ep-press inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium text-muted hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                <AppSlidersIcon size={11} />
                <span>Timing &amp; Sync</span>
              </button>
            </div>
          ))}
      </div>

      {/* Zone 4: Discord-Style 2-Row Voice & User Dock */}
      <div ref={podRef} className="ep-party-pod-zone shrink-0">
        <AnimatedCollapse open={voiceEnabled && voiceJoined} durationMs={220}>
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between gap-2">
            <GlassHoverTip
              label={!voiceCaptureHealthy ? "Voice Issue" : "Voice Connected"}
              detail={
                relayedVoicePeers.length > 0
                  ? `Relayed via ${relayedVoicePeers[0].relayVia}`
                  : voiceInputMode === "ptt"
                    ? `Push-to-Talk · Hold ${formatVoiceHotkey(voicePttVk, voicePttMod)}`
                    : voicePeersInCall.length > 0
                      ? `${voicePeersInCall.length + 1} in Voice Lounge`
                      : "Direct P2P audio ready"
              }
              accent={!voiceCaptureHealthy ? "warn" : "ok"}
              className="min-w-0 flex-1"
            >
              <div className="min-w-0 flex items-center gap-2 cursor-default">
                <AppSignalBarsIcon
                  bars={voiceCaptureHealthy ? 4 : 1}
                  speaking={voiceCaptureHealthy}
                  size={14}
                  className="shrink-0"
                />
                <div className="min-w-0">
                  <div
                    className={`text-[12px] font-semibold leading-tight truncate ${
                      !voiceCaptureHealthy ? "text-warn" : "text-ok"
                    }`}
                  >
                    {voiceJoining
                      ? "Voice Connecting…"
                      : !voiceCaptureHealthy
                        ? "Voice Issue"
                        : "Voice Connected"}
                  </div>
                  {(relayedVoicePeers.length > 0 || voiceInputMode === "ptt") && (
                    <div className="text-[10px] text-muted leading-tight truncate mt-0.5">
                      {relayedVoicePeers.length > 0
                        ? `Relayed via ${relayedVoicePeers[0].relayVia}`
                        : `PTT · ${formatVoiceHotkey(voicePttVk, voicePttMod)}`}
                    </div>
                  )}
                </div>
              </div>
            </GlassHoverTip>

            <GlassHoverTip label="Disconnect" detail="Leave voice chat" accent="bad">
              <button
                type="button"
                disabled={voiceJoining}
                aria-label="Disconnect voice"
                onClick={() => void handleToggleVoice(false)}
                className="ep-press h-7 w-7 rounded-lg flex items-center justify-center text-secondary hover:text-bad hover:bg-bad/15 cursor-pointer disabled:opacity-60 shrink-0"
              >
                <PartyLeaveIcon size={14} />
              </button>
            </GlassHoverTip>
          </div>
        </AnimatedCollapse>

        <div className="px-3 py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <PresenceAvatar
              avatarId={avatarId}
              size={30}
              speaking={localSpeaking}
              status={
                voiceJoined && !voiceCaptureHealthy
                  ? "alert"
                  : voiceJoined && voiceMuted
                    ? "muted"
                    : !localReady && localLoaded
                      ? "notReady"
                      : "none"
              }
            />
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold text-white truncate leading-tight">
                {effectiveUsername}
              </div>
              <div
                className={`text-[10.5px] truncate leading-tight mt-0.5 ${
                  voiceJoined && !voiceCaptureHealthy
                    ? "text-warn font-medium"
                    : voiceJoined && voiceDeafened
                      ? "text-bad/90"
                      : localSpeaking
                        ? "text-ok font-medium"
                        : "text-muted"
                }`}
              >
                {selfStatusText}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            {voiceEnabled && voiceJoined ? (
              <>
                <VoiceMicDeafenPills
                  variant="flat"
                  muted={voiceMuted}
                  deafened={voiceDeafened}
                  speaking={localSpeaking}
                  captureHealthy={voiceCaptureHealthy}
                />
                <GlassHoverTip
                  label="Audio & Devices"
                  detail="Mic, output, mode & ducking"
                  disabled={voiceSetupOpen}
                >
                  <button
                    ref={voiceSetupBtnRef}
                    type="button"
                    aria-label="Voice & Audio Quick Setup"
                    aria-expanded={voiceSetupOpen}
                    onClick={() => {
                      setOpenMemberUser(null);
                      setVoiceSetupOpen((o) => !o);
                    }}
                    className={`ep-press h-8 w-8 rounded-lg flex items-center justify-center cursor-pointer ${
                      voiceSetupOpen
                        ? "bg-white/15 text-white"
                        : "text-secondary hover:text-white hover:bg-white/[0.08]"
                    }`}
                  >
                    <AppVoiceTuneIcon active={voiceSetupOpen} size={16} />
                  </button>
                </GlassHoverTip>
              </>
            ) : (
              <>
                <GlassHoverTip
                  label={localReady ? "Marked Ready" : "Not Ready"}
                  detail="Toggle Ready status (R)"
                  accent={localReady ? "ok" : "warn"}
                >
                  <button
                    type="button"
                    onClick={() => toggleReadyStatus()}
                    aria-label={localReady ? "Mark not ready" : "Mark ready"}
                    className={`ep-press h-7 px-2 rounded-lg inline-flex items-center gap-1 text-[10.5px] font-medium cursor-pointer ${
                      localReady
                        ? "text-ok hover:bg-white/[0.08]"
                        : "text-warn bg-warn/10 hover:bg-warn/18"
                    }`}
                  >
                    <PlayerReadyIcon ready={localReady} size={12} />
                    <span>{localReady ? "Ready" : "Ready?"}</span>
                  </button>
                </GlassHoverTip>

                {voiceEnabled && (
                  <GlassHoverTip
                    label="Audio & Devices"
                    detail="Mic, output & sensitivity"
                    disabled={voiceSetupOpen}
                  >
                    <button
                      ref={voiceSetupBtnRef}
                      type="button"
                      aria-label="Voice & Audio Quick Setup"
                      aria-expanded={voiceSetupOpen}
                      onClick={() => {
                        setOpenMemberUser(null);
                        setVoiceSetupOpen((o) => !o);
                      }}
                      className={`ep-press h-8 w-8 rounded-lg flex items-center justify-center cursor-pointer ${
                        voiceSetupOpen
                          ? "bg-white/15 text-white"
                          : "text-secondary hover:text-white hover:bg-white/[0.08]"
                      }`}
                    >
                      <AppVoiceTuneIcon active={voiceSetupOpen} size={16} />
                    </button>
                  </GlassHoverTip>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Member Actions Card (pops cleanly to the right of the sidebar row) */}
      {activeMenuPayload.mounted && activeMenuPayload.value && (
        <MemberActionMenuPortal
          menuBoxRef={memberMenuBoxRef}
          menuPeer={activeMenuPayload.value.participant}
          menuMeta={getMemberMeta(activeMenuPayload.value.participant)}
          coords={activeMenuPayload.value.coords}
          exiting={activeMenuPayload.exiting}
          effectiveUsername={effectiveUsername}
          avatarId={avatarId}
          voiceEnabled={voiceEnabled}
          busyAdminUser={busyAdminUser}
          onTogglePeerAdmin={(u, grant) => void handleTogglePeerAdmin(u, grant)}
          onFixFps={(scale, label) => {
            setTimingOpen(true);
            void applyTimelineTransform(
              { offsetSecs: timelineOffsetSecs, scale },
              `FPS matched (${label ?? "calibrated"})`,
            );
          }}
          onAlignScene={() => {
            setTimingOpen(true);
            void setSceneAlignMode(true);
          }}
          onCloseMenu={() => setOpenMemberUser(null)}
        />
      )}

      {/* Audio & Devices Tray (opens upward inside the sidebar column above the Self Voice Pod) */}
      {voiceSetupPresence.mounted &&
        voiceSetupPresence.value &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={voiceSetupBoxRef}
            style={{
              left: `${voiceSetupPresence.value.left}px`,
              bottom: `${voiceSetupPresence.value.bottom}px`,
              width: `${voiceSetupPresence.value.width}px`,
              transformOrigin: "bottom center",
            }}
            className={`ep-glass-submenu fixed z-[80] rounded-2xl p-2 ${
              voiceSetupPresence.exiting
                ? "ep-popover-bloom-out pointer-events-none"
                : "ep-popover-bloom"
            }`}
          >
            <VoiceQuickSettingsTray
              open={voiceSetupOpen}
              onOpenFullSettings={() => {
                setVoiceSetupOpen(false);
                openSettings("voice");
              }}
            />
          </div>,
          document.body,
        )}
    </aside>
  );

  if (!docked) {
    return asideEl;
  }

  return (
    <div
      data-open={dockExpanded ? "true" : "false"}
      data-resizing={resizing ? "true" : undefined}
      style={{ width: dockExpanded ? `${width}px` : "0px" }}
      onTransitionEnd={(e) => {
        if (!resizing && e.target === e.currentTarget && e.propertyName === "width") {
          onDockTransitionEnd?.();
        }
      }}
      className={`ep-party-dock-slot ${exiting ? "pointer-events-none" : ""}`}
    >
      {asideEl}
    </div>
  );
});
