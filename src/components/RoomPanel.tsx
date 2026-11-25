import {
  AppAlertIcon,
  AppChevronIcon,
  AppCloseIcon,
  AppFolderIcon,
  AppHeadphonesIcon,
  AppMemberMenuArrowIcon,
  AppMicIcon,
  AppResetIcon,
  AppSeasonFolderIcon,
  AppSignalBarsIcon,
  AppSlidersIcon,
  AppSpeakerVolumeIcon,
  AppVoiceTuneIcon,
  AppVoiceWaveIcon,
} from "./ui/AppIcons";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { usePartyFileMismatch } from "../hooks/usePartyFileMismatch";
import { formatUserError } from "../lib/errors";
import { formatInviteClipboardText } from "../lib/inviteLinks";
import type { LocalMatchCandidate } from "../lib/localLibrary";
import {
  formatParticipantMatchBadge,
  formatReadableMediaName,
} from "../lib/fileMismatch";
import { formatDisplayMediaTitle } from "../lib/playlist";
import {
  findMatchingFpsPreset,
  formatSignedOffset,
  FPS_PRESETS,
  isIdentityTransform,
} from "../lib/sourceAlignment";
import { isTextEntryElement } from "../lib/shortcuts";
import { playSoundCue } from "../lib/soundEffects";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import { computeParticipantDrift } from "../lib/syncHealth";
import {
  enqueueSyncLifecycle,
  onSyncHealth,
  syncPrewarm,
  syncReconnect,
  syncSetRoomAdmin,
  syncSwitchBackup,
  type SyncHealthPayload,
} from "../lib/syncplay";
import {
  DEFAULT_ENDPOINT,
  describeSyncEndpoint,
  isCloudEndpoint,
  SYNCPLAY_ENDPOINT,
} from "../lib/syncStatusDisplay";
import {
  LOCAL_DISCONNECT_TAG,
  NOT_READY_TAG_PREFIX,
  PEER_LEFT_TAG_PREFIX,
} from "../lib/syncReady";
import {
  applyTimelineTransform,
  captureSceneAnchor,
  captureSecondDriftAnchor,
  nudgeTimelineOffset,
  resetTimelineAlignment,
  runP2pAutoAlign,
  setSceneAlignMode,
} from "../lib/timelineActions";
import { useAnimatedPresence, usePresencePayload } from "../lib/useAnimatedPresence";
import { sanitizeRoomCodeInput } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { clearPartyChat } from "../store/useChatStore";
import { clearReactions } from "../store/useReactionStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";
import { formatRoomCodeDisplay, generateRoomCode } from "./HomeScreen";
import { formatClock } from "./TransportBar";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import { Button } from "./ui/Button";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { WatchPartyIcon } from "./ui/LobbyIcons";
import { OtpCodeInput } from "./ui/OtpCodeInput";
import {
  PartyAdminIcon,
  PartyAlignSceneIcon,
  PartyCopyIcon,
  PartyCreateIcon,
  PartyDockLeftIcon,
  PartyFpsMatchIcon,
  PartyHostIcon,
  PartyLeaveIcon,
  PartyPasteIcon,
  PartyServerIcon,
  PartyViewersIcon,
  PlayerEyeIcon,
  PlayerPlayIcon,
  PlayerReadyIcon,
  PlayerResyncIcon,
} from "./ui/PlayerIcons";
import { PresenceAvatar } from "./ui/PresenceAvatar";
import { resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { Scrubber } from "./ui/Scrubber";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { StatusDot } from "./ui/StatusDot";
import { VoiceQuickSettingsTray } from "./ui/VoiceQuickSettingsTray";
import { VoiceMicDeafenPills } from "./ui/VoiceQuickControls";
import { formatVoiceHotkey, type VoicePeerRosterDto } from "../lib/voice";
import {
  getActiveVoiceSpeakerNames,
  isLocalVoiceSpeaking,
  toggleVoiceSession,
} from "../lib/voiceActions";
import { useVoiceStore } from "../store/useVoiceStore";

function voiceTransportLabel(transport: string | undefined): string {
  switch (transport) {
    case "directLan":
      return "Direct LAN";
    case "directIpv6":
      return "Direct IPv6";
    case "directWan":
      return "Direct P2P";
    case "relayed":
      return "Relayed P2P";
    case "blocked":
    case "unavailable":
      return "Strict NAT blocked";
    default:
      return "Direct P2P";
  }
}

interface RoomPanelProps {
  onClose?: () => void;
  onDockLeft?: () => void;
  onChooseFile?: () => void;
  onChooseFolder?: () => void;
  onSwitchEpisode?: (index: number) => void;
  onOpenLocalMatch?: (candidate: LocalMatchCandidate) => void;
}

const ParticipantDriftBadge = memo(function ParticipantDriftBadge({
  participant,
  hostPeerPos,
}: {
  participant: Parameters<typeof computeParticipantDrift>[0];
  hostPeerPos: number | null;
}) {
  const liveRoomPositionSecs = useSyncStore((s) =>
    hostPeerPos !== null && hostPeerPos > 0 ? 0 : s.liveRoomPositionSecs,
  );
  const refPos = hostPeerPos !== null && hostPeerPos > 0 ? hostPeerPos : liveRoomPositionSecs;
  const driftInfo = computeParticipantDrift(participant, refPos);
  if (!driftInfo) return null;
  const dotClass =
    driftInfo.level === "ok"
      ? "bg-ok"
      : driftInfo.level === "warn"
        ? "bg-warn"
        : "bg-bad";
  return (
    <GlassHoverTip
      label={driftInfo.label}
      detail={driftInfo.detail}
      accent={driftInfo.level}
    >
      <span
        aria-label={`${driftInfo.label}: ${driftInfo.detail}`}
        className="inline-flex items-center justify-center h-4 px-1 rounded-full bg-white/[0.06] cursor-default shrink-0"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      </span>
    </GlassHoverTip>
  );
});

const RoomAlignReadout = memo(function RoomAlignReadout({
  timelineScale,
}: {
  timelineScale: number;
}) {
  const liveRoomPositionSecs = useSyncStore((s) => s.liveRoomPositionSecs);
  const localPositionSecs = usePlayerStore((s) => s.positionSecs);
  const liveAlignDelta = localPositionSecs - timelineScale * liveRoomPositionSecs;

  return (
    <div className="p-2 rounded-xl bg-white/[0.05] border border-white/[0.08] space-y-2">
      <div className="text-[11px] text-secondary leading-snug">
        Scrub your video to the same moment your friend is on, then click{" "}
        <span className="text-white font-medium">Match Here</span>.
      </div>
      <div className="flex items-center justify-between text-[11px] num">
        <span className="text-muted">
          Friend:{" "}
          <span className="text-white font-medium">
            {formatClock(liveRoomPositionSecs)}
          </span>
        </span>
        <span className="text-muted">
          Yours:{" "}
          <span className="text-accent-soft font-medium">
            {formatClock(localPositionSecs)}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void captureSceneAnchor()}
          className="ep-glass-primary-pill ep-press flex-1 h-7.5 rounded-xl inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-white cursor-pointer"
        >
          <PartyAlignSceneIcon size={12} />
          <span>Match Here ({formatSignedOffset(liveAlignDelta)})</span>
        </button>
        <button
          type="button"
          onClick={() => void setSceneAlignMode(false)}
          className="ep-bar-icon-btn ep-press h-7.5 px-2.5 rounded-xl text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
});

const SecondAnchorButton = memo(function SecondAnchorButton({
  anchorRoomSecs,
}: {
  anchorRoomSecs: number;
}) {
  const localPositionSecs = usePlayerStore((s) => Math.floor(s.positionSecs));
  if (Math.abs(localPositionSecs - anchorRoomSecs) < 30) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => void captureSecondDriftAnchor()}
      className="ep-menu-row ep-press w-full px-2 py-1 rounded-lg text-[10.5px] text-accent-soft hover:text-white text-left cursor-pointer"
    >
      Still drifting? Set 2nd anchor point here to calibrate FPS
    </button>
  );
});

export const RoomPanel = memo(function RoomPanel({
  onClose,
  onDockLeft,
  onChooseFile,
  onChooseFolder,
  onSwitchEpisode,
  onOpenLocalMatch,
}: RoomPanelProps) {
  const roomCode = useAppStore((s) => s.roomCode);
  const literalRoom = useAppStore((s) => s.literalRoom);
  const hostOnlyRoom = useAppStore((s) => s.hostOnlyRoom);
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const selectedFileName = useAppStore((s) => s.selectedFileName);
  const setRoomCode = useAppStore((s) => s.setRoomCode);
  const setHostOnlyRoom = useAppStore((s) => s.setHostOnlyRoom);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);

  const status = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);
  const serverOverrideNotice = useSyncStore((s) => s.serverOverrideNotice);
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

  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [hostOnlyMidMovie, setHostOnlyMidMovie] = useState(false);
  const [busyAdminUser, setBusyAdminUser] = useState<string | null>(null);
  const [verifyingJoin, setVerifyingJoin] = useState(false);
  const [timingOpen, setTimingOpen] = useState(false);
  const [openMemberUser, setOpenMemberUser] = useState<string | null>(null);
  const [memberMenuCoords, setMemberMenuCoords] = useState<{
    peerKey: string;
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const memberAnchorRefs = useRef<Record<string, HTMLElement | null>>({});
  const memberMenuBoxRef = useRef<HTMLDivElement | null>(null);
  const voiceSetupBtnRef = useRef<HTMLButtonElement | null>(null);
  const voiceSetupBoxRef = useRef<HTMLDivElement | null>(null);
  const [voiceSetupCoords, setVoiceSetupCoords] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    origin: string;
  } | null>(null);
  const verifyTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const healthCopyTimerRef = useRef<number | null>(null);

  const openSettings = useAppStore((s) => s.openSettings);
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
  const setVoicePeerVolume = useVoiceStore((s) => s.setPeerVolume);
  const [btPreJoinConfirm, setBtPreJoinConfirm] = useState(false);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [syncHealth, setSyncHealth] = useState<SyncHealthPayload | null>(null);
  const [healthCopied, setHealthCopied] = useState(false);
  const [draftMidMovieCode, setDraftMidMovieCode] = useState(() => generateRoomCode());
  const prewarmedMidMovieRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || roomCode) return;
    const ep = (serverEndpoint || DEFAULT_ENDPOINT).trim();
    const key = `${ep}|${draftMidMovieCode}`;
    if (!ep || prewarmedMidMovieRef.current === key) return;
    prewarmedMidMovieRef.current = key;
    void syncPrewarm(ep, draftMidMovieCode);
  }, [open, roomCode, serverEndpoint, draftMidMovieCode]);

  useEffect(() => {
    if (!open || roomCode || literalRoom) return;
    const cleaned = joinCode.replace(/\D/g, "");
    if (cleaned.length !== 6) return;
    const ep = (serverEndpoint || DEFAULT_ENDPOINT).trim();
    const key = `${ep}|${cleaned}`;
    if (!ep || prewarmedMidMovieRef.current === key) return;
    const timer = window.setTimeout(() => {
      prewarmedMidMovieRef.current = key;
      void syncPrewarm(ep, cleaned);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [open, roomCode, literalRoom, joinCode, serverEndpoint]);

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
  const voiceControlsPresence = useAnimatedPresence(voiceEnabled && voiceJoined, 180);

  const voicePeersInCall = voiceRoster.filter((r) => r.inVoice);
  const blockedVoicePeers = voicePeersInCall.filter((r) => r.transport === "blocked");
  const relayedVoicePeers = voicePeersInCall.filter((r) => r.transport === "relayed");

  const toggleMemberMenu = useCallback((peerKey: string) => {
    setOpenMemberUser((prev) => (prev === peerKey ? null : peerKey));
  }, []);

  useLayoutEffect(() => {
    if (!openMemberUser) {
      setMemberMenuCoords(null);
      return;
    }

    const updatePosition = () => {
      const anchor = memberAnchorRefs.current[openMemberUser];
      if (!anchor) {
        setOpenMemberUser(null);
        return;
      }
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const menuWidth = 216;
      const left = Math.max(12, Math.min(r.right - menuWidth, vw - menuWidth - 12));
      const spaceBelow = vh - r.bottom - 14;
      const spaceAbove = r.top - 14;
      if (spaceBelow < 175 && spaceAbove > spaceBelow) {
        setMemberMenuCoords({
          peerKey: openMemberUser,
          left,
          bottom: Math.max(12, vh - r.top + 6),
        });
      } else {
        setMemberMenuCoords({
          peerKey: openMemberUser,
          left,
          top: Math.min(vh - 12, r.bottom + 6),
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
  }, [openMemberUser]);

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

  useLayoutEffect(() => {
    if (!voiceSetupOpen) {
      setVoiceSetupCoords(null);
      return;
    }

    const updatePosition = () => {
      const btn = voiceSetupBtnRef.current;
      if (!btn) {
        setVoiceSetupOpen(false);
        return;
      }
      const r = btn.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const stageEl = document.querySelector<HTMLElement>('[data-showcase-stage="true"]');
      const stageRight = stageEl ? stageEl.getBoundingClientRect().right : vw;
      const menuWidth = 244;
      const sheet = btn.closest('.ep-glass-sheet, [data-glass-region="true"]');
      const sheetRect = sheet ? sheet.getBoundingClientRect() : null;

      // Prefer opening cleanly beside the Watch Party sheet (right side if space allows, else left)
      if (sheetRect) {
        const clampedTop = Math.max(12, Math.min(Math.round(r.top - 10), vh - 290));
        if (sheetRect.left >= menuWidth + 22 && sheetRect.left > stageRight - sheetRect.right) {
          setVoiceSetupCoords({
            left: Math.round(sheetRect.left - menuWidth - 10),
            top: clampedTop,
            origin: "right center",
          });
          return;
        }
        if (stageRight - sheetRect.right >= menuWidth + 22) {
          setVoiceSetupCoords({
            left: Math.round(sheetRect.right + 10),
            top: clampedTop,
            origin: "left center",
          });
          return;
        }
        if (sheetRect.left >= menuWidth + 22) {
          setVoiceSetupCoords({
            left: Math.round(sheetRect.left - menuWidth - 10),
            top: clampedTop,
            origin: "right center",
          });
          return;
        }
      }

      const left = Math.max(12, Math.min(r.right - menuWidth, stageRight - menuWidth - 12));
      const spaceBelow = vh - r.bottom - 14;
      const spaceAbove = r.top - 14;
      if (spaceBelow < 240 && spaceAbove > spaceBelow) {
        setVoiceSetupCoords({
          left,
          bottom: Math.max(12, vh - r.top + 6),
          origin: "bottom right",
        });
      } else {
        setVoiceSetupCoords({
          left,
          top: Math.min(vh - 12, r.bottom + 6),
          origin: "top right",
        });
      }
    };

    const onScroll = (e: Event) => {
      if (
        voiceSetupBoxRef.current &&
        e.target instanceof Node &&
        voiceSetupBoxRef.current.contains(e.target)
      ) {
        return;
      }
      setVoiceSetupOpen(false);
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [voiceSetupOpen]);

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

  useEffect(() => {
    return () => {
      if (verifyTimerRef.current !== null) {
        window.clearTimeout(verifyTimerRef.current);
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      if (healthCopyTimerRef.current !== null) {
        window.clearTimeout(healthCopyTimerRef.current);
      }
    };
  }, []);

  const endpointSummary = describeSyncEndpoint(status, serverEndpoint);
  const syncConnected = status.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(status, username);
  const ctrlLock = getControllerLockState(
    syncConnected,
    participants,
    effectiveUsername,
    roomControl,
  );

  const handleCopyRoom = async () => {
    try {
      const text = formatInviteClipboardText(roomCode, literalRoom, serverEndpoint);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      const p = usePlayerStore.getState();
      playSoundCue("codeCopied", { moviePlaying: p.loaded && !p.paused });
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
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

  const handleAutoVerifyOtp = (sixDigits: string) => {
    if (verifyingJoin) return;
    const cleaned = sixDigits.replace(/\D/g, "").slice(0, 6);
    if (cleaned.length !== 6) return;
    setVerifyingJoin(true);
    const p = usePlayerStore.getState();
    playSoundCue("codeCopied", { moviePlaying: p.loaded && !p.paused });
    if (verifyTimerRef.current !== null) {
      window.clearTimeout(verifyTimerRef.current);
    }
    verifyTimerRef.current = window.setTimeout(() => {
      verifyTimerRef.current = null;
      setVerifyingJoin(false);
      useAppStore.getState().setCreatingRoom(false);
      setHostOnlyRoom(false);
      setRoomCode(cleaned);
    }, 220);
  };

  const handlePasteMidMovie = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip) return;
      if (literalRoom) {
        setJoinCode(sanitizeRoomCodeInput(clip, true));
        return;
      }
      const digits = clip.replace(/\D/g, "").slice(0, 6);
      if (!digits) {
        pushNote("info", "Clipboard does not contain a 6-digit code.");
        return;
      }
      setJoinCode(digits);
      if (digits.length === 6) {
        handleAutoVerifyOtp(digits);
      }
    } catch {
      // Clipboard may be unavailable outside user focus
    }
  };

  const handleStartPartyMidMovie = () => {
    const code = draftMidMovieCode;
    setDraftMidMovieCode(generateRoomCode());
    try {
      void navigator.clipboard?.writeText(code).catch(() => undefined);
    } catch {
      // ignore
    }
    setHostOnlyRoom(hostOnlyMidMovie);
    useAppStore.getState().setCreatingRoom(!literalRoom);
    setRoomCode(code);
    pushNote(
      "success",
      hostOnlyMidMovie
        ? `Host-only Watch Party started — invite code ${formatRoomCodeDisplay(code)}`
        : `Watch Party started — invite code ${formatRoomCodeDisplay(code)}`,
    );
  };

  const handleJoinPartyMidMovie = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = sanitizeRoomCodeInput(joinCode, literalRoom);
    if (cleaned.length < (literalRoom ? 1 : 6)) {
      pushNote("info", "Enter a valid room code to join.");
      return;
    }
    useAppStore.getState().setCreatingRoom(false);
    setHostOnlyRoom(false);
    setRoomCode(cleaned);
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
  const hostPeer = useMemo(
    () =>
      roomControl.hostUsername
        ? participants.find(
            (hp) =>
              hp.username.trim().toLowerCase() ===
              roomControl.hostUsername?.trim().toLowerCase(),
          )
        : undefined,
    [participants, roomControl.hostUsername],
  );
  const hostPeerPos = hostPeer && hostPeer.position > 0 ? hostPeer.position : null;
  const roomActiveSpeakers = getActiveVoiceSpeakerNames(effectiveUsername, {
    joined: voiceJoined,
    muted: voiceMuted,
    deafened: voiceDeafened,
    localGateOpen: voiceGateOpen,
    streamStatus: voiceStreamStatus,
    speakingPeers: voiceSpeakingPeers,
    roster: voiceRoster,
    peerOverrides: voicePeerOverrides,
  });
  const roomVoiceCount =
    voiceJoined
      ? 1 +
        voicePeersInCall.filter(
          (r) => r.username.trim().toLowerCase() !== effectiveUsername.trim().toLowerCase(),
        ).length
      : voicePeersInCall.length;

  const getMemberMeta = (p: (typeof participants)[number]) => {
    const normName = (n: string | null | undefined) => (n ?? "").trim().toLowerCase();
    const peerKey = normName(p.username);
    const isSelf = peerKey === normName(effectiveUsername);
    const canQuickFixFps =
      !isSelf &&
      !scaleCalibrated &&
      p.sourceRelation === "fpsMismatch" &&
      typeof p.suggestedFpsScale === "number";
    const canQuickAlign =
      !isSelf &&
      !hasTimelineAlignment &&
      p.sourceRelation === "differentCut" &&
      localLoaded;
    const isRowHost =
      Boolean(p.isHost) ||
      (ctrlLock.hostControlActive
        ? peerKey !== "" && peerKey === normName(ctrlLock.hostUsername)
        : p.isController && !p.isAdmin);
    const isRowAdmin =
      Boolean(p.isAdmin) ||
      (ctrlLock.hostControlActive &&
        !isRowHost &&
        ctrlLock.adminUsernames.some((a) => normName(a) === peerKey));
    const canManageAdmin = ctrlLock.localIsHost && !isSelf && syncConnected && !isRowHost;
    const voiceEntry: VoicePeerRosterDto | null = isSelf
      ? voiceJoined
        ? {
            username: p.username,
            voiceId: 0,
            epoch: 0,
            inVoice: true,
            muted: voiceMuted,
            deafened: voiceDeafened,
            transport: "directLan",
            relayVia: null,
            rttMs: null,
            lossPct: 0,
            jitterMs: 0,
            bitrateKbps: 0,
            qualityBars: voiceCaptureHealthy ? 4 : 1,
            healthReason: null,
            healthFix: null,
          }
        : null
      : voiceRoster.find((r) => normName(r.username) === peerKey) ?? null;
    const peerInVoice = Boolean(voiceEntry?.inVoice);
    const peerSpeaking = isSelf
      ? localSpeaking
      : peerInVoice &&
        !voiceEntry?.muted &&
        !voiceEntry?.deafened &&
        voiceSpeakingPeers.some((s) => normName(s) === peerKey);
    const peerVolOv = voicePeerOverrides[peerKey] ?? { volume: 1.0, muted: false };
    const peerLocallyMuted = !isSelf && peerVolOv.muted;
    const hasMemberActions =
      !isSelf &&
      (canManageAdmin ||
        voiceEnabled ||
        peerInVoice ||
        (canQuickFixFps && Boolean(p.suggestedFpsScale)) ||
        canQuickAlign);

    return {
      peerKey,
      isSelf,
      canQuickFixFps,
      canQuickAlign,
      isRowHost,
      isRowAdmin,
      canManageAdmin,
      voiceEntry,
      peerInVoice,
      peerSpeaking,
      peerVolOv,
      peerLocallyMuted,
      hasMemberActions,
    };
  };

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

  useEffect(() => {
    window.dispatchEvent(new Event("ep:glass-layout"));
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event("ep:glass-layout"));
    }, 65);
    return () => window.clearTimeout(timer);
  }, [voiceSetupOpen, voiceSetupPresence.mounted]);

  return (
    <div
      className="flex flex-col flex-1 min-h-0 gap-2.5"
      onContextMenu={(e) => {
        if (isTextEntryElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Unified Minimal Header */}
      <div className="flex items-center justify-between gap-2 shrink-0 px-2 pt-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <WatchPartyIcon bare size={16} className="shrink-0" />
          <span className="text-[13px] font-semibold text-white truncate">Watch Party</span>
          {roomCode && (
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
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                  syncConnected && syncHealth ? "cursor-pointer hover:text-white" : "cursor-default"
                } ${
                  status.state === "error"
                    ? "text-bad"
                    : status.state === "reconnecting"
                      ? "text-warn"
                      : syncConnected
                        ? "text-secondary"
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
                          : "Connected"
                        : "Connecting…"}
                </span>
              </button>
            </GlassHoverTip>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {roomCode && onDockLeft && (
            <GlassHoverTip label="Dock to Left" detail="Keep Party & Voice beside the video">
              <button
                type="button"
                onClick={onDockLeft}
                aria-label="Dock Party Lounge to left"
                className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer"
              >
                <PartyDockLeftIcon size={14} />
              </button>
            </GlassHoverTip>
          )}
          {roomCode && (
            <GlassHoverTip label="Leave Watch Party" detail="Keep watching solo">
              <button
                type="button"
                onClick={handleLeaveParty}
                className="ep-bar-icon-btn h-7 px-2 rounded-full inline-flex items-center gap-1 text-[11.5px] font-medium text-secondary hover:text-bad cursor-pointer"
              >
                <PartyLeaveIcon size={14} className="shrink-0" />
                <span>Leave</span>
              </button>
            </GlassHoverTip>
          )}
          {onClose && (
            <GlassHoverTip label="Close" detail="Esc">
              <button
                type="button"
                onClick={onClose}
                aria-label="Close Watch Party menu"
                className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
              >
                <AppCloseIcon size={14} />
              </button>
            </GlassHoverTip>
          )}
        </div>
      </div>

      {!roomCode ? (
        <div className="anim-tab-in flex flex-col gap-3.5 px-1 pb-0.5">
          <div className="space-y-2">
            <p className="text-[11.5px] text-secondary leading-relaxed">
              Start a synced room while your video keeps playing, or paste a friend’s code to join.
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={hostOnlyMidMovie}
              onClick={() => setHostOnlyMidMovie((prev) => !prev)}
              className="ep-menu-row ep-press w-full flex items-center justify-between gap-2.5 px-2 py-1.5 rounded-xl bg-white/[0.045] hover:bg-white/[0.08] text-left cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <PartyHostIcon size={13} className="shrink-0" />
                <span className="text-[11.5px] font-medium text-primary truncate">
                  Only host can control
                </span>
              </span>
              <GlassSwitchTrack checked={hostOnlyMidMovie} size="sm" />
            </button>
            <button
              type="button"
              onClick={handleStartPartyMidMovie}
              className="ep-glass-primary-pill ep-press w-full h-9 rounded-full inline-flex items-center justify-center gap-2 text-xs font-medium text-white cursor-pointer"
            >
              <PartyCreateIcon size={16} className="shrink-0" />
              <span>Start Watch Party</span>
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-medium text-secondary">
                {literalRoom ? "Join Syncplay room" : "Join with 6-digit code"}
              </span>
              {!literalRoom && (
                <button
                  type="button"
                  onClick={() => void handlePasteMidMovie()}
                  className="ep-bar-icon-btn h-6.5 px-2 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
                >
                  <PartyPasteIcon size={13} className="shrink-0" />
                  <span>Paste</span>
                </button>
              )}
            </div>

            {literalRoom ? (
              <form onSubmit={handleJoinPartyMidMovie} className="flex items-center gap-2">
                <input
                  id="room-panel-join-name"
                  name="roomPanelJoinName"
                  type="text"
                  value={joinCode}
                  placeholder="Exact room name…"
                  aria-label="Room Name"
                  onChange={(e) => setJoinCode(sanitizeRoomCodeInput(e.target.value, true))}
                  className="ep-glass-input flex-1 h-8.5 px-3 rounded-xl text-xs num tracking-wide text-primary placeholder:tracking-normal placeholder:text-muted focus:outline-none min-w-0"
                />
                <Button type="submit" variant="secondary" size="sm">
                  Join
                </Button>
              </form>
            ) : (
              <div className="space-y-1.5">
                <OtpCodeInput
                  compact
                  value={joinCode}
                  verifying={verifyingJoin}
                  onChange={setJoinCode}
                  onComplete={handleAutoVerifyOtp}
                />
                <div className={`text-[10.5px] ${verifyingJoin ? "text-ok font-medium" : "text-muted"}`}>
                  {verifyingJoin ? "Joining room…" : "Connects automatically once all 6 digits are entered"}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="ep-menu-scroll anim-tab-in flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden gap-2 -mr-2 pr-2 -ml-1 pl-1">
          {hasConnectionIssue && (
            <div className="px-2 py-1 flex items-center justify-between gap-2 text-[11px] text-bad">
              <span className="truncate">{endpointSummary.detailText || "Connection interrupted"}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={handleRetryConnect}
                  className="ep-bar-icon-btn h-6 px-2 rounded-full inline-flex items-center gap-1 font-medium text-white cursor-pointer"
                >
                  <PlayerResyncIcon tone="warn" size={12} />
                  <span>Retry</span>
                </button>
                {status.suggestBackup && !endpointSummary.isBackupServer && (
                  <button
                    type="button"
                    onClick={handleSwitchBackup}
                    className="ep-bar-icon-btn h-6 px-2 rounded-full inline-flex items-center gap-1 font-medium text-secondary hover:text-white cursor-pointer"
                  >
                    <PartyServerIcon size={12} />
                    <span>Backup</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Direct Click-to-Copy Passcode Row */}
          <button
            type="button"
            onClick={() => void handleCopyRoom()}
            className="ep-menu-row ep-press w-full px-2 py-1.5 flex items-center justify-between gap-3 text-left cursor-pointer"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] text-secondary">
                <span>{literalRoom ? "Syncplay Room" : "Share Code"}</span>
                {ctrlLock.hasControllers && (
                  <GlassHoverTip
                    label={
                      ctrlLock.hostControlActive
                        ? ctrlLock.localIsHost
                          ? "Host-only control"
                          : ctrlLock.localIsAdmin
                            ? "Admin control"
                            : "Host-only room"
                        : "Room Host"
                    }
                    detail={
                      ctrlLock.hostControlActive
                        ? ctrlLock.localIsHost
                          ? "Assign Admins via member arrow"
                          : ctrlLock.localIsAdmin
                            ? "You can control playback"
                            : `Controlled by ${ctrlLock.hostUsername ?? "the host"}${
                                ctrlLock.adminUsernames.length > 0 ? " & admins" : ""
                              }`
                        : serverOverrideNotice || "Created this room"
                    }
                    accent={ctrlLock.localIsAdmin && !ctrlLock.localIsHost ? "admin" : "host"}
                  >
                    <span className="inline-flex items-center gap-1 text-accent-soft font-medium">
                      <span>·</span>
                      <PartyHostIcon size={12} />
                      <span>
                        {ctrlLock.localIsHost
                          ? "You host"
                          : ctrlLock.localIsAdmin
                            ? "Admin"
                            : ctrlLock.hostUsername ?? ctrlLock.controllers[0]}
                      </span>
                    </span>
                  </GlassHoverTip>
                )}
              </div>
              <div className="text-[19px] leading-tight font-semibold tracking-[0.16em] text-white num truncate">
                {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)}
              </div>
            </div>

            <span
              className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium shrink-0 transition-colors ${
                copied ? "text-ok" : "text-secondary"
              }`}
            >
              <PartyCopyIcon copied={copied} size={15} />
              <span>{copied ? "Copied" : "Copy"}</span>
            </span>
          </button>

          {mismatch && (
            <div
              role="alert"
              className="ep-glass-warning-inline rounded-[14px] px-2.5 py-2 flex items-start gap-2 text-left"
            >
              <AppAlertIcon variant="warn" size={14} className="text-warn shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[11.5px] font-semibold text-white truncate">
                    {mismatch.title}
                  </span>
                  {mismatch.deltaBadge && (
                    <span className="num text-[10px] font-semibold text-warn shrink-0">
                      {mismatch.deltaBadge}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-secondary leading-snug">{mismatch.message}</p>
                {(mismatch.matchedPlaylistItem ||
                  (!mismatch.matchedPlaylistItem && localMatches.length > 0 && onOpenLocalMatch) ||
                  onChooseFile ||
                  (mismatch.kind === "notOpenOnPc" && onChooseFolder)) && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {mismatch.matchedPlaylistItem && onSwitchEpisode && (
                      <button
                        type="button"
                        onClick={() => onSwitchEpisode(mismatch.matchedPlaylistItem!.index)}
                        className="ep-warning-action ep-press h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-semibold text-white cursor-pointer"
                      >
                        <PlayerPlayIcon size={10} />
                        <span>Open {mismatch.matchedPlaylistItem.label}</span>
                      </button>
                    )}
                    {!mismatch.matchedPlaylistItem && localMatches.length > 0 && onOpenLocalMatch && (
                      <button
                        type="button"
                        title={`${localMatches[0].path}\n${localMatches[0].reason}`}
                        onClick={() => onOpenLocalMatch(localMatches[0])}
                        className="ep-warning-action ep-press h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-semibold text-white cursor-pointer max-w-[210px]"
                      >
                        <PlayerPlayIcon size={10} className="shrink-0" />
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
                        } h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium cursor-pointer`}
                      >
                        <AppFolderIcon size={11} />
                        <span>
                          {mismatch.kind === "notOpenOnPc" ? "Open Video…" : "Change Video…"}
                        </span>
                      </button>
                    )}
                    {mismatch.kind === "notOpenOnPc" &&
                      !mismatch.matchedPlaylistItem &&
                      localMatches.length === 0 &&
                      onChooseFolder && (
                        <button
                          type="button"
                          onClick={onChooseFolder}
                          className="ep-bar-pill h-6 px-2.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium text-secondary hover:text-white cursor-pointer"
                        >
                          <AppSeasonFolderIcon size={11} />
                          <span>Season Folder…</span>
                        </button>
                      )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Opt-in Room Voice Bar */}
          {syncConnected && (
            <div className="px-2 py-1 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                {!voiceEnabled ? (
                  <button
                    type="button"
                    onClick={() => openSettings("voice")}
                    className="ep-bar-pill ep-press h-7 px-3 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium text-muted hover:text-white cursor-pointer"
                  >
                    <AppVoiceWaveIcon active={false} speaking={false} size={13} />
                    <span>Voice Disabled</span>
                  </button>
                ) : voiceJoined ? (
                  <GlassHoverTip
                    label={
                      voiceDeafened
                        ? "Voice deafened"
                        : voiceMuted
                          ? "Mic muted"
                          : voiceInputMode === "ptt"
                            ? `PTT · Hold ${formatVoiceHotkey(voicePttVk, voicePttMod)}`
                            : "Voice connected"
                    }
                    detail={
                      roomVoiceCount > 1
                        ? `${roomVoiceCount} in voice · Headphones or PTT recommended`
                        : "Headphones or PTT recommended"
                    }
                    accent={
                      roomActiveSpeakers.length > 0
                        ? "speaking"
                        : voiceDeafened
                          ? "bad"
                          : "ok"
                    }
                    className="inline-flex items-center min-w-0"
                  >
                    <div className="flex items-center gap-2 min-w-0 cursor-default">
                      <AppVoiceWaveIcon
                        active
                        speaking={roomActiveSpeakers.length > 0}
                        size={13}
                        className="shrink-0"
                      />
                      <span
                        className={`text-[11.5px] font-medium truncate ${
                          roomActiveSpeakers.length > 0
                            ? "text-white"
                            : voiceDeafened
                              ? "text-bad/90"
                              : voiceMuted
                                ? "text-secondary"
                                : "text-white/90"
                        }`}
                      >
                        {voiceJoining
                          ? "Starting Voice…"
                          : roomActiveSpeakers.length > 0
                            ? roomActiveSpeakers.length === 1
                              ? `${roomActiveSpeakers[0]} speaking`
                              : roomActiveSpeakers.length === 2
                                ? `${roomActiveSpeakers[0]}, ${roomActiveSpeakers[1]} speaking`
                                : `${roomActiveSpeakers[0]}, ${roomActiveSpeakers[1]} +${roomActiveSpeakers.length - 2} speaking`
                            : voiceDeafened
                              ? "Deafened"
                              : voiceMuted
                                ? "Mic muted"
                                : voiceInputMode === "ptt"
                                  ? `PTT · ${formatVoiceHotkey(voicePttVk, voicePttMod)}`
                                  : roomVoiceCount > 1
                                    ? `Voice · ${roomVoiceCount}`
                                    : "Voice connected"}
                      </span>
                    </div>
                  </GlassHoverTip>
                ) : (
                  <GlassHoverTip
                    label="Join voice"
                    detail="Talk with peers in this room"
                    className="inline-flex items-center min-w-0"
                  >
                    <button
                      type="button"
                      disabled={voiceJoining}
                      onClick={() => void handleToggleVoice(false)}
                      className="ep-glass-primary-pill ep-press h-7 px-3 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium text-white cursor-pointer disabled:opacity-60"
                    >
                      <AppVoiceWaveIcon active={false} speaking={false} size={13} />
                      <span>
                        {voiceJoining
                          ? "Starting Voice…"
                          : roomVoiceCount > 0
                            ? `Join Voice (${roomVoiceCount})`
                            : "Join Voice"}
                      </span>
                    </button>
                  </GlassHoverTip>
                )}

                {voiceEnabled && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!voiceJoined && (
                      <GlassHoverTip
                        label="Listen Only"
                        detail="Join muted without capturing mic"
                      >
                        <button
                          type="button"
                          disabled={voiceJoining}
                          onClick={() => void handleToggleVoice(true)}
                          aria-label="Listen Only"
                          className="ep-bar-pill ep-press h-7 w-7 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer disabled:opacity-60"
                        >
                          <AppHeadphonesIcon size={14} />
                        </button>
                      </GlassHoverTip>
                    )}

                    {voiceControlsPresence.mounted && (
                      <div
                        className={`inline-flex items-center gap-1.5 ${
                          voiceControlsPresence.exiting
                            ? "anim-pop-out pointer-events-none"
                            : "anim-pop-in"
                        }`}
                      >
                        <VoiceMicDeafenPills
                          muted={voiceMuted}
                          deafened={voiceDeafened}
                          speaking={localSpeaking}
                          captureHealthy={voiceCaptureHealthy}
                        />
                      </div>
                    )}

                    <GlassHoverTip
                      label="Audio & Devices"
                      detail={
                        !voiceCaptureHealthy ||
                        voiceBtHfpDropped ||
                        voiceSpeakerLeak ||
                        blockedVoicePeers.length > 0
                          ? "Voice alert — inspect audio or Voice Health"
                          : "Mic, output, mode & ducking"
                      }
                      accent={
                        !voiceCaptureHealthy || voiceBtHfpDropped || voiceSpeakerLeak
                          ? "warn"
                          : "default"
                      }
                      disabled={voiceSetupOpen}
                    >
                      <button
                        ref={voiceSetupBtnRef}
                        type="button"
                        aria-label="Voice & Audio Quick Setup"
                        aria-expanded={voiceSetupOpen}
                        data-tone={
                          !voiceCaptureHealthy || voiceBtHfpDropped || voiceSpeakerLeak
                            ? "warn"
                            : undefined
                        }
                        onClick={() => {
                          setOpenMemberUser(null);
                          setVoiceSetupOpen((o) => !o);
                        }}
                        className={`ep-bar-pill ep-press h-7 w-7 rounded-full flex items-center justify-center cursor-pointer ${
                          voiceSetupOpen
                            ? "bg-white/15 text-white border-white/30"
                            : "text-secondary hover:text-white"
                        }`}
                      >
                        <AppVoiceTuneIcon active={voiceSetupOpen} size={14} />
                      </button>
                    </GlassHoverTip>

                    {voiceControlsPresence.mounted && (
                      <div
                        className={`inline-flex items-center ${
                          voiceControlsPresence.exiting
                            ? "anim-pop-out pointer-events-none"
                            : "anim-pop-in"
                        }`}
                      >
                        <GlassHoverTip
                          label="Leave Voice"
                          detail="Disconnect voice chat"
                          accent="bad"
                        >
                          <button
                            type="button"
                            disabled={voiceJoining}
                            aria-label="Leave Voice"
                            data-tone="leave"
                            onClick={() => void handleToggleVoice(false)}
                            className="ep-bar-pill ep-press h-7 w-7 rounded-full flex items-center justify-center cursor-pointer disabled:opacity-60"
                          >
                            <PartyLeaveIcon size={13} />
                          </button>
                        </GlassHoverTip>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <AnimatedCollapse open={btPreJoinConfirm && !voiceJoined} innerClassName="pt-1">
                <div
                  role="alert"
                  className="ep-glass-warning-inline rounded-[12px] px-2.5 py-2 space-y-1.5 text-[11px]"
                >
                  <p className="text-secondary leading-snug">
                    Bluetooth mic active — Windows hands-free mode cuts movie audio quality. Use a wired mic or Listen Only for full stereo.
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleToggleVoice(false, true)}
                      className="ep-warning-action ep-press h-6 px-2.5 rounded-full text-[10.5px] font-semibold text-white cursor-pointer"
                    >
                      Join Anyway
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleVoice(true, true)}
                      className="ep-bar-pill ep-press h-6 px-2.5 rounded-full text-[10.5px] font-medium text-secondary hover:text-white cursor-pointer"
                    >
                      Listen Only
                    </button>
                    <button
                      type="button"
                      onClick={() => setBtPreJoinConfirm(false)}
                      className="h-6 px-2 text-[10.5px] text-muted hover:text-white cursor-pointer"
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
                    relayedVoicePeers.length > 0 ||
                    blockedVoicePeers.length > 0)
                }
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-secondary px-0.5 pt-0.5">
                  {voiceStreamStatus === "micBusy" && (
                    <span className="text-bad font-medium">
                      Mic in exclusive use by another app
                    </span>
                  )}
                  {voiceStreamStatus === "reconnecting" && (
                    <span className="text-warn font-medium">
                      Reconnecting audio device…
                    </span>
                  )}
                  {voiceStreamStatus === "permissionDenied" && (
                    <span className="text-bad font-medium">
                      Microphone permission denied
                    </span>
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
                    <span className="text-warn">
                      Low upload bandwidth — audio quality adapted
                    </span>
                  )}
                  {relayedVoicePeers.length > 0 && (
                    <GlassHoverTip
                      label="Relayed Voice"
                      detail="1-hop encrypted relay via peer"
                      accent="admin"
                    >
                      <span className="text-accent-soft cursor-default">
                        Relayed via {relayedVoicePeers[0].relayVia}
                      </span>
                    </GlassHoverTip>
                  )}
                  {blockedVoicePeers.length > 0 && (
                    <span className="text-warn">
                      Voice blocked for{" "}
                      {blockedVoicePeers
                        .map((b) =>
                          b.healthReason ? `${b.username} (${b.healthReason})` : b.username,
                        )
                        .join(", ")}
                    </span>
                  )}
                </div>
              </AnimatedCollapse>
            </div>
          )}

          {/* Viewers Header */}
          <div className="px-2 pt-1 flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 font-medium text-secondary">
              <PartyViewersIcon size={14} className="shrink-0" />
              <span>Watching</span>
              <span className="num text-muted">{participants.length}</span>
            </div>
            {!hideParticipants && participants.length > 0 && (
              <span className={`font-medium num ${allReady ? "text-ok" : "text-warn"}`}>
                {allReady ? "All ready" : `${readyCount}/${participants.length} ready`}
              </span>
            )}
          </div>

          {hideParticipants ? (
            <button
              type="button"
              onClick={() => setHideParticipants(false)}
              className="ep-menu-row ep-press w-full px-2 py-1.5 flex items-center justify-between gap-2 text-left text-xs text-secondary hover:text-white cursor-pointer"
            >
              <span className="inline-flex items-center gap-2">
                <PlayerEyeIcon hidden size={14} />
                <span>Profile icons hidden</span>
              </span>
              <span className="text-[11px] font-medium text-accent-soft">Show</span>
            </button>
          ) : participants.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted">
              {syncConnected ? "Syncing participant list…" : "Connecting to room…"}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {participants.map((p) => {
                const {
                  peerKey,
                  isSelf,
                  isRowHost,
                  isRowAdmin,
                  voiceEntry,
                  peerInVoice,
                  peerSpeaking,
                  peerLocallyMuted,
                  hasMemberActions,
                } = getMemberMeta(p);
                const localHasFile =
                  localLoaded && !playerError && Boolean(selectedFileName?.trim());
                const badge = formatParticipantMatchBadge(p, {
                  localHasFile,
                  isSelf,
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
                  voiceEntry?.transport === "blocked" || voiceEntry?.transport === "unavailable";
                const baseTransport =
                  voiceEntry?.transport === "relayed" && voiceEntry.relayVia
                    ? `Relayed via ${voiceEntry.relayVia}`
                    : voiceTransportLabel(voiceEntry?.transport);
                const voiceHealthSuffix = voiceEntry?.healthReason
                  ? ` · ${voiceEntry.healthReason}${voiceEntry.healthFix ? ` (${voiceEntry.healthFix})` : ""}`
                  : voiceEntry?.bitrateKbps
                    ? ` · ${Math.round(voiceEntry.bitrateKbps)} kbps`
                    : "";
                const voiceTransportDetail = isSelf
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
                const voiceTipLabel = voiceEntry?.deafened
                  ? "Deafened"
                  : peerLocallyMuted
                    ? "Muted by you"
                    : voiceEntry?.muted
                      ? "Mic muted"
                      : peerSpeaking && !peerLocallyMuted
                        ? "Speaking"
                        : "In voice";
                const voiceTipAccent: "speaking" | "bad" | "warn" | "ok" = voiceEntry?.deafened ||
                  voiceEntry?.muted ||
                  peerLocallyMuted
                  ? "bad"
                  : peerVoiceBlocked || (isSelf && !voiceCaptureHealthy)
                    ? "warn"
                    : peerSpeaking
                      ? "speaking"
                      : "ok";
                const isMenuOpen = memberMenuCoords?.peerKey === peerKey && openMemberUser === peerKey;

                return (
                  <div
                    key={p.username}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!hasMemberActions) return;
                      toggleMemberMenu(peerKey);
                    }}
                    className="px-2 py-1.5 rounded-xl flex items-start gap-2.5 min-w-0 hover:bg-white/[0.045] transition-colors"
                  >
                    <PresenceAvatar
                      avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                      size={26}
                      speaking={peerSpeaking && !peerLocallyMuted}
                      status={badge.isMismatch ? "mismatch" : "none"}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[12.5px] font-medium text-white truncate">
                            {p.username}
                          </span>
                          {isSelf && <span className="text-[11px] text-muted shrink-0">you</span>}
                          {isRowHost && (
                            <GlassHoverTip
                              label="Room Host"
                              detail="Controls room & playback"
                              accent="host"
                            >
                              <span
                                aria-label="Room Host"
                                className="inline-flex items-center justify-center shrink-0 cursor-default"
                              >
                                <PartyHostIcon size={14} />
                              </span>
                            </GlassHoverTip>
                          )}
                          {!isRowHost && isRowAdmin && (
                            <GlassHoverTip
                              label="Room Admin"
                              detail="Can control playback"
                              accent="admin"
                            >
                              <span
                                aria-label="Room Admin"
                                className="inline-flex items-center justify-center shrink-0 cursor-default"
                              >
                                <PartyAdminIcon size={13} />
                              </span>
                            </GlassHoverTip>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {peerInVoice && (
                            <GlassHoverTip
                              label={voiceTipLabel}
                              detail={voiceTransportDetail}
                              accent={voiceTipAccent}
                              disabled={isMenuOpen}
                            >
                              <button
                                type="button"
                                disabled={isSelf}
                                aria-label={`${p.username} ${voiceTipLabel}`}
                                onClick={() => toggleMemberMenu(peerKey)}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                                  isSelf ? "cursor-default" : "cursor-pointer hover:bg-white/10"
                                } ${
                                  peerVoiceBlocked
                                    ? "text-warn bg-warn/10"
                                    : voiceEntry?.deafened || voiceEntry?.muted || peerLocallyMuted
                                      ? "text-bad bg-bad/10"
                                      : peerSpeaking
                                        ? "text-white"
                                        : "text-secondary"
                                }`}
                              >
                                {voiceEntry?.deafened ? (
                                  <AppHeadphonesIcon deafened size={12} />
                                ) : (
                                  <AppMicIcon
                                    muted={Boolean(voiceEntry?.muted || peerLocallyMuted)}
                                    speaking={peerSpeaking && !peerLocallyMuted}
                                    size={12}
                                  />
                                )}
                                {!isSelf && voiceEntry?.transport === "relayed" && (
                                  <span>Relay</span>
                                )}
                                {!isSelf && !peerVoiceBlocked && (
                                  <AppSignalBarsIcon
                                    bars={voiceEntry?.qualityBars}
                                    speaking={peerSpeaking && !peerLocallyMuted}
                                    size={11}
                                    className="shrink-0"
                                  />
                                )}
                              </button>
                            </GlassHoverTip>
                          )}
                          <ParticipantDriftBadge participant={p} hostPeerPos={hostPeerPos} />
                          {!isSelf && (p.buffering || (typeof p.lagSecs === "number" && Math.abs(p.lagSecs) >= 1.5)) && (
                            <span
                              title={
                                p.buffering
                                  ? `${p.username} is buffering`
                                  : `Behind by ${Math.abs(p.lagSecs ?? 0).toFixed(1)}s`
                              }
                              className="px-1.5 py-0.5 rounded-full bg-warn/15 text-warn text-[10px] font-medium num shrink-0"
                            >
                              {p.buffering
                                ? "Buffering"
                                : `${(p.lagSecs ?? 0) > 0 ? "-" : "+"}${Math.abs(p.lagSecs ?? 0).toFixed(1)}s`}
                            </span>
                          )}
                          <GlassHoverTip
                            label={p.isReady ? "Ready" : "Not ready"}
                            detail={p.isReady ? "Ready to watch" : "Waiting for video"}
                            accent={p.isReady ? "ok" : "warn"}
                          >
                            <span
                              aria-label={p.isReady ? "Ready" : "Not ready"}
                              className="inline-flex items-center shrink-0 cursor-default"
                            >
                              <PlayerReadyIcon ready={p.isReady} size={14} />
                            </span>
                          </GlassHoverTip>
                          {hasMemberActions ? (
                            <GlassHoverTip
                              label="Member actions"
                              detail="Voice & role"
                              disabled={isMenuOpen}
                            >
                              <button
                                ref={(el) => {
                                  memberAnchorRefs.current[peerKey] = el;
                                }}
                                type="button"
                                aria-label={`Actions for ${p.username}`}
                                aria-expanded={isMenuOpen}
                                aria-haspopup="menu"
                                onClick={() => toggleMemberMenu(peerKey)}
                                className={`ep-press h-5.5 w-5.5 rounded-full flex items-center justify-center cursor-pointer transition-colors ${
                                  isMenuOpen
                                    ? "text-white bg-white/15"
                                    : "text-secondary hover:text-white hover:bg-white/[0.08]"
                                }`}
                              >
                                <AppMemberMenuArrowIcon open={isMenuOpen} size={14} />
                              </button>
                            </GlassHoverTip>
                          ) : (
                            <span aria-hidden="true" className="w-5.5 shrink-0" />
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] min-w-0">
                        <span className={`font-medium shrink-0 ${badge.className}`}>
                          {badge.text}
                        </span>
                        {cleanMediaTitle && (
                          <>
                            <span className="text-muted/50 shrink-0">·</span>
                            <span className="text-muted truncate" title={p.fileName ?? undefined}>
                              {cleanMediaTitle}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {participants.length === 1 && (
                <div className="px-2 pt-1 pb-0.5 text-[11px] text-muted">
                  Waiting for friends — share the code above to watch together
                </div>
              )}
            </div>
          )}

          {showTimingControls &&
            (hasSourceDifference || hasTimelineAlignment || alignMode || probingAudio || timingOpen ? (
              <div className="flex flex-col pt-1">
                <button
                  type="button"
                  aria-expanded={timingOpen || alignMode}
                  onClick={() => setTimingOpen((o) => !o)}
                  className="ep-menu-row ep-press w-full px-2 py-1.5 flex items-center justify-between gap-2 text-left cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <AppSlidersIcon size={13} className="text-accent-soft shrink-0" />
                    <span className="text-[11.5px] font-medium text-secondary truncate">
                      Source Timing
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 shrink-0">
                    <span
                      className={`text-[11px] font-medium num ${
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
                                ? "Re-align Audio"
                                : "Auto-Align Audio"}
                          </span>
                        </button>
                      )}
                    </div>

                    {activeAutoSummary && (
                      <div className="px-2 py-1 rounded-lg bg-white/[0.05] border border-white/[0.07] text-[10.5px] text-secondary truncate">
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
                        className="ep-glass-primary-pill ep-press w-full h-7.5 rounded-xl px-2.5 flex items-center justify-between gap-2 text-[11px] font-medium text-white cursor-pointer"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <PartyFpsMatchIcon size={12} />
                          <span>Match {suggestedFpsPeer.suggestedFpsLabel}</span>
                        </span>
                        <span className="text-[10px] text-white/75">1-click fix</span>
                      </button>
                    )}

                    {alignMode ? (
                      <RoomAlignReadout timelineScale={timelineScale} />
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void setSceneAlignMode(true)}
                          className="ep-bar-icon-btn ep-press flex-1 h-7.5 px-2.5 rounded-xl inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-primary hover:text-white cursor-pointer"
                        >
                          <PartyAlignSceneIcon size={12} />
                          <span>Align to Friend’s Scene…</span>
                        </button>
                        {hasTimelineAlignment && (
                          <GlassHoverTip label="Reset timing" detail="Clear offset & speed">
                            <button
                              type="button"
                              onClick={() => void resetTimelineAlignment()}
                              className="ep-bar-icon-btn ep-press h-7.5 px-2 rounded-xl inline-flex items-center gap-1 text-[11px] text-muted hover:text-white cursor-pointer"
                            >
                              <AppResetIcon size={12} />
                              <span>Reset</span>
                            </button>
                          </GlassHoverTip>
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
                      <div className="ep-glass-tray p-0.5 rounded-xl grid grid-cols-6 gap-0.5 text-[10.5px]">
                        {[-5, -0.5, -0.1, 0.1, 0.5, 5].map((delta) => (
                          <button
                            key={delta}
                            type="button"
                            onClick={() => void nudgeTimelineOffset(delta)}
                            className="ep-press ep-tray-option h-6.5 rounded-[9px] num text-secondary hover:text-white cursor-pointer"
                          >
                            {delta > 0 ? `+${delta}s` : `${delta}s`}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1.5">
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
              <div className="pt-0.5 flex justify-end px-1">
                <button
                  type="button"
                  onClick={() => setTimingOpen(true)}
                  className="ep-press inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium text-muted hover:text-white hover:bg-white/[0.06] cursor-pointer"
                >
                  <AppSlidersIcon size={11} />
                  <span>Timing &amp; Sync</span>
                </button>
              </div>
            ))}
        </div>
      )}

      {activeMenuPayload.mounted &&
        activeMenuPayload.value &&
        typeof document !== "undefined" &&
        (() => {
          const { participant: menuPeer, coords } = activeMenuPayload.value;
          const menuMeta = getMemberMeta(menuPeer);
          const adminBusy = busyAdminUser === menuPeer.username;
          const statusLabel = menuMeta.isRowHost
            ? "Host"
            : menuMeta.isRowAdmin
              ? "Admin"
              : menuMeta.peerInVoice
                ? "In voice"
                : "Viewer";

          return createPortal(
            <div
              ref={memberMenuBoxRef}
              role="menu"
              aria-label={`Actions for ${menuPeer.username}`}
              style={{
                left: `${coords.left}px`,
                ...(coords.top !== undefined ? { top: `${coords.top}px` } : {}),
                ...(coords.bottom !== undefined ? { bottom: `${coords.bottom}px` } : {}),
              }}
              className={`${
                activeMenuPayload.exiting
                  ? "anim-pop-out pointer-events-none"
                  : "anim-pop-in"
              } ep-glass-submenu fixed z-[80] w-[216px] rounded-2xl p-1.5 flex flex-col gap-1`}
            >
              <div className="px-2 py-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <PresenceAvatar
                    avatarId={resolvePeerAvatarId(menuPeer.username, effectiveUsername, avatarId)}
                    size={18}
                    speaking={menuMeta.peerSpeaking && !menuMeta.peerLocallyMuted}
                    avatarClassName="ring-1 ring-white/20"
                  />
                  <span className="text-[11.5px] font-medium text-white truncate">
                    {menuPeer.username}
                  </span>
                </div>
                <span className="text-[10px] font-medium text-secondary shrink-0">
                  {statusLabel}
                </span>
              </div>

              {!menuMeta.isSelf && (menuMeta.peerInVoice || voiceEnabled) && (
                <div className="space-y-1 pb-0.5">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      setVoicePeerVolume(
                        menuPeer.username,
                        menuMeta.peerVolOv.volume,
                        !menuMeta.peerVolOv.muted,
                      )
                    }
                    className={`ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center justify-between gap-2 text-left text-[11.5px] font-medium cursor-pointer ${
                      menuMeta.peerLocallyMuted
                        ? "text-bad"
                        : "text-secondary hover:text-white"
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <AppMicIcon
                        muted={menuMeta.peerLocallyMuted}
                        speaking={menuMeta.peerSpeaking}
                        size={14}
                      />
                      <span>
                        {menuMeta.peerLocallyMuted ? "Unmute in Voice" : "Mute in Voice"}
                      </span>
                    </span>
                  </button>

                  <div className="px-2 pt-0.5 pb-1.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-[10.5px]">
                      <span className="inline-flex items-center gap-1.5 text-secondary">
                        <AppSpeakerVolumeIcon
                          muted={menuMeta.peerLocallyMuted || menuMeta.peerVolOv.volume === 0}
                          size={13}
                        />
                        <span>Voice Volume</span>
                      </span>
                      <span className="num font-medium text-white/90">
                        {Math.round(menuMeta.peerVolOv.volume * 100)}%
                      </span>
                    </div>
                    <Scrubber
                      ariaLabel={`${menuPeer.username} voice volume`}
                      min={0}
                      max={200}
                      step={5}
                      value={Math.round(menuMeta.peerVolOv.volume * 100)}
                      alwaysShowThumb
                      formatTooltip={(v) => `${Math.round(v)}%`}
                      onChange={(v) =>
                        setVoicePeerVolume(
                          menuPeer.username,
                          v / 100,
                          menuMeta.peerVolOv.muted,
                        )
                      }
                    />
                  </div>
                </div>
              )}

              {menuMeta.canManageAdmin && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={Boolean(busyAdminUser)}
                  onClick={() => {
                    void handleTogglePeerAdmin(menuPeer.username, !menuMeta.isRowAdmin);
                    setOpenMemberUser(null);
                  }}
                  className={`ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center gap-2 text-left text-[11.5px] font-medium cursor-pointer disabled:opacity-50 ${
                    menuMeta.isRowAdmin
                      ? "text-secondary hover:text-bad"
                      : "text-accent-soft hover:text-white"
                  }`}
                >
                  <PartyAdminIcon size={14} revoke={menuMeta.isRowAdmin} className="shrink-0" />
                  <span>
                    {adminBusy
                      ? "Updating…"
                      : menuMeta.isRowAdmin
                        ? "Remove Admin"
                        : "Make Admin"}
                  </span>
                </button>
              )}

              {menuMeta.canQuickFixFps && menuPeer.suggestedFpsScale && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMemberUser(null);
                    setTimingOpen(true);
                    void applyTimelineTransform(
                      { offsetSecs: timelineOffsetSecs, scale: menuPeer.suggestedFpsScale! },
                      `FPS matched (${menuPeer.suggestedFpsLabel ?? "calibrated"})`,
                    );
                  }}
                  className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center gap-2 text-left text-[11.5px] font-medium text-white cursor-pointer"
                >
                  <PartyFpsMatchIcon size={14} className="shrink-0" />
                  <span>Fix FPS</span>
                </button>
              )}

              {menuMeta.canQuickAlign && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMemberUser(null);
                    setTimingOpen(true);
                    void setSceneAlignMode(true);
                  }}
                  className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center gap-2 text-left text-[11.5px] font-medium text-warn cursor-pointer"
                >
                  <PartyAlignSceneIcon size={14} className="shrink-0" />
                  <span>Align Scene</span>
                </button>
              )}
            </div>,
            document.body,
          );
        })()}

      {voiceSetupPresence.mounted &&
        voiceSetupPresence.value &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={voiceSetupBoxRef}
            style={{
              left: `${voiceSetupPresence.value.left}px`,
              transformOrigin: voiceSetupPresence.value.origin,
              ...(voiceSetupPresence.value.top !== undefined
                ? { top: `${voiceSetupPresence.value.top}px` }
                : {}),
              ...(voiceSetupPresence.value.bottom !== undefined
                ? { bottom: `${voiceSetupPresence.value.bottom}px` }
                : {}),
            }}
            className={`ep-glass-submenu fixed z-[80] w-[244px] rounded-2xl p-2 ${
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
    </div>
  );
});
