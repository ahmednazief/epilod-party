import {
  AppAlertIcon,
  AppChevronIcon,
  AppCloseIcon,
  AppFolderIcon,
  AppResetIcon,
  AppSeasonFolderIcon,
  AppSlidersIcon,
} from "./ui/AppIcons";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { usePartyFileMismatch } from "../hooks/usePartyFileMismatch";
import { formatUserError } from "../lib/errors";
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
import { playSoundCue } from "../lib/soundEffects";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import {
  enqueueSyncLifecycle,
  syncReconnect,
  syncSetRoomAdmin,
  syncSwitchBackup,
} from "../lib/syncplay";
import { describeSyncEndpoint } from "../lib/syncStatusDisplay";
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
import { sanitizeRoomCodeInput } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { formatRoomCodeDisplay, generateRoomCode } from "./HomeScreen";
import { formatClock } from "./TransportBar";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import { Button } from "./ui/Button";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { WatchPartyIcon } from "./ui/LobbyIcons";
import { OtpCodeInput } from "./ui/OtpCodeInput";
import {
  PartyAdminIcon,
  PartyAlignSceneIcon,
  PartyCopyIcon,
  PartyCreateIcon,
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
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { StatusDot } from "./ui/StatusDot";

interface RoomPanelProps {
  onClose?: () => void;
  onChooseFile?: () => void;
  onChooseFolder?: () => void;
  onSwitchEpisode?: (index: number) => void;
}

export const RoomPanel = memo(function RoomPanel({
  onClose,
  onChooseFile,
  onChooseFolder,
  onSwitchEpisode,
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
  const liveRoomPositionSecs = useSyncStore((s) => s.liveRoomPositionSecs);
  const localLoaded = usePlayerStore((s) => s.loaded);
  const playerError = usePlayerStore((s) => s.playerError);
  const localPositionSecs = usePlayerStore((s) => s.positionSecs);
  const pushNote = useNotificationStore((s) => s.push);
  const { mismatch } = usePartyFileMismatch();

  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [hostOnlyMidMovie, setHostOnlyMidMovie] = useState(false);
  const [busyAdminUser, setBusyAdminUser] = useState<string | null>(null);
  const [verifyingJoin, setVerifyingJoin] = useState(false);
  const [timingOpen, setTimingOpen] = useState(false);
  const verifyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (verifyTimerRef.current !== null) {
        window.clearTimeout(verifyTimerRef.current);
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
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      const p = usePlayerStore.getState();
      playSoundCue("codeCopied", { moviePlaying: p.loaded && !p.paused });
      window.setTimeout(() => setCopied(false), 1800);
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
    void enqueueSyncLifecycle(async () => {
      try {
        await syncSwitchBackup({
          username,
          roomCode,
          literalRoom,
          password: serverPassword || null,
          hostOnly: hostOnlyRoom,
        });
        pushNote("info", "Switching room to backup connection route.");
      } catch (err) {
        pushNote("error", formatUserError(err, "Backup route switch failed."));
      }
    });
  };

  const handleLeaveParty = () => {
    setHostOnlyRoom(false);
    setRoomCode("");
    useSyncStore.getState().reset();
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
    const code = generateRoomCode();
    try {
      void navigator.clipboard?.writeText(code).catch(() => undefined);
    } catch {
      // ignore
    }
    setHostOnlyRoom(hostOnlyMidMovie);
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
  const canSetSecondAnchor =
    Boolean(alignAnchor1) &&
    Math.abs((alignMode ? liveRoomPositionSecs : localPositionSecs) - (alignAnchor1?.roomSecs ?? 0)) >= 30;
  const liveAlignDelta = localPositionSecs - timelineScale * liveRoomPositionSecs;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2.5">
      {/* Unified Minimal Header */}
      <div className="flex items-center justify-between gap-2 shrink-0 px-1 pt-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <WatchPartyIcon bare size={16} className="shrink-0" />
          <span className="text-[13px] font-semibold text-white truncate">Watch Party</span>
          {roomCode && (
            <span
              className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
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
                      ? "Connected"
                      : "Connecting…"}
              </span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {roomCode && (
            <button
              type="button"
              onClick={handleLeaveParty}
              title="Leave Watch Party and keep watching solo"
              className="ep-bar-icon-btn h-7 px-2 rounded-full inline-flex items-center gap-1 text-[11.5px] font-medium text-secondary hover:text-bad cursor-pointer"
            >
              <PartyLeaveIcon size={14} className="shrink-0" />
              <span>Leave</span>
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Watch Party menu"
              title="Close (Esc)"
              className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
            >
              <AppCloseIcon size={14} />
            </button>
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
        <div className="ep-menu-scroll anim-tab-in flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden gap-2 pr-1">
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
            title={serverOverrideNotice || "Click to copy share code"}
            className="ep-menu-row ep-press w-full px-2 py-1.5 flex items-center justify-between gap-3 text-left cursor-pointer"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] text-secondary">
                <span>{literalRoom ? "Syncplay Room" : "Share Code"}</span>
                {ctrlLock.hasControllers && (
                  <span className="inline-flex items-center gap-1 text-accent-soft font-medium">
                    <span>·</span>
                    <PartyHostIcon size={11} />
                    <span>
                      {ctrlLock.localIsHost
                        ? "You host"
                        : ctrlLock.localIsAdmin
                          ? "Admin"
                          : ctrlLock.hostUsername ?? ctrlLock.controllers[0]}
                    </span>
                  </span>
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

          {ctrlLock.hostControlActive && (
            <div className="px-2 py-1 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-between gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1.5 text-secondary min-w-0 truncate">
                <PartyHostIcon size={12} className="shrink-0" />
                <span className="truncate">
                  {ctrlLock.localIsHost
                    ? "Host-only control · Give friends Admin below"
                    : ctrlLock.localIsAdmin
                      ? "Admin active · You can control playback"
                      : `Host-only · Controlled by ${ctrlLock.hostUsername ?? "the host"}${
                          ctrlLock.adminUsernames.length > 0 ? " & admins" : ""
                        }`}
                </span>
              </span>
            </div>
          )}

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
                    {onChooseFile && (
                      <button
                        type="button"
                        onClick={onChooseFile}
                        className={`${
                          mismatch.matchedPlaylistItem
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
                const isSelf =
                  p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase();
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
                const normName = (n: string | null | undefined) => (n ?? "").trim().toLowerCase();
                const isRowHost =
                  Boolean(p.isHost) ||
                  (ctrlLock.hostControlActive
                    ? normName(p.username) !== "" &&
                      normName(p.username) === normName(ctrlLock.hostUsername)
                    : p.isController && !p.isAdmin);
                const isRowAdmin =
                  Boolean(p.isAdmin) ||
                  (ctrlLock.hostControlActive &&
                    !isRowHost &&
                    ctrlLock.adminUsernames.some((a) => normName(a) === normName(p.username)));
                const canManageAdmin = ctrlLock.localIsHost && !isSelf && syncConnected && !isRowHost;
                const adminBusy = busyAdminUser === p.username;
                return (
                  <div
                    key={p.username}
                    className="px-2 py-1.5 rounded-xl flex items-start gap-2.5 min-w-0 hover:bg-white/[0.045] transition-colors"
                  >
                    <ProfileAvatar
                      avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                      size={26}
                      className={`ring-2 shrink-0 mt-0.5 ${
                        badge.isMismatch ? "ring-warn/85" : p.isReady ? "ring-ok/80" : "ring-warn/75"
                      }`}
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[12.5px] font-medium text-white truncate">
                            {p.username}
                          </span>
                          {isSelf && <span className="text-[11px] text-muted shrink-0">you</span>}
                          {isRowHost && (
                            <span
                              title="Room host"
                              className="inline-flex items-center gap-1 text-[10.5px] font-medium text-accent-soft shrink-0"
                            >
                              <PartyHostIcon size={11} />
                              <span>Host</span>
                            </span>
                          )}
                          {!isRowHost && isRowAdmin && (
                            <span
                              title="Room admin (can control playback)"
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-accent/20 border border-accent-soft/30 text-[10px] font-medium text-accent-soft shrink-0"
                            >
                              <PartyAdminIcon size={10} />
                              <span>Admin</span>
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {!p.isReady && (
                            <span className="text-[10.5px] font-medium text-warn">Not ready</span>
                          )}
                          <PlayerReadyIcon
                            ready={p.isReady}
                            size={14}
                            className="shrink-0"
                          />
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
                      {(canManageAdmin || (canQuickFixFps && p.suggestedFpsScale) || canQuickAlign) && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          {canManageAdmin && (
                            <button
                              type="button"
                              disabled={Boolean(busyAdminUser)}
                              onClick={() => void handleTogglePeerAdmin(p.username, !isRowAdmin)}
                              className={`ep-press px-2 py-0.5 rounded-full text-[10.5px] font-medium inline-flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                                isRowAdmin
                                  ? "ep-bar-pill text-secondary hover:bg-bad/20 hover:text-bad"
                                  : "ep-bar-pill text-accent-soft hover:text-white"
                              }`}
                            >
                              <PartyAdminIcon size={10} />
                              <span>
                                {adminBusy
                                  ? "Updating…"
                                  : isRowAdmin
                                    ? "Remove Admin"
                                    : "Make Admin"}
                              </span>
                            </button>
                          )}
                          {canQuickFixFps && p.suggestedFpsScale && (
                            <button
                              type="button"
                              onClick={() => {
                                setTimingOpen(true);
                                void applyTimelineTransform(
                                  { offsetSecs: timelineOffsetSecs, scale: p.suggestedFpsScale! },
                                  `FPS matched (${p.suggestedFpsLabel ?? "calibrated"})`,
                                );
                              }}
                              className="ep-glass-primary-pill ep-press px-2.5 py-0.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium text-white cursor-pointer"
                            >
                              <PartyFpsMatchIcon size={11} />
                              <span>Fix FPS</span>
                            </button>
                          )}
                          {canQuickAlign && (
                            <button
                              type="button"
                              onClick={() => {
                                setTimingOpen(true);
                                void setSceneAlignMode(true);
                              }}
                              className="ep-press px-2 py-0.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium bg-warn/20 text-warn hover:bg-warn/30 cursor-pointer"
                            >
                              <PartyAlignSceneIcon size={11} />
                              <span>Align</span>
                            </button>
                          )}
                        </div>
                      )}
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

          {showTimingControls && (
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
                          <button
                            type="button"
                            onClick={() => void resetTimelineAlignment()}
                            title="Reset source offset & speed"
                            className="ep-bar-icon-btn ep-press h-7.5 px-2 rounded-xl inline-flex items-center gap-1 text-[11px] text-muted hover:text-white cursor-pointer"
                          >
                            <AppResetIcon size={12} />
                            <span>Reset</span>
                          </button>
                        )}
                      </div>
                    )}

                    {canSetSecondAnchor && !alignMode && (
                      <button
                        type="button"
                        onClick={() => void captureSecondDriftAnchor()}
                        className="ep-menu-row ep-press w-full px-2 py-1 rounded-lg text-[10.5px] text-accent-soft hover:text-white text-left cursor-pointer"
                      >
                        Still drifting? Set 2nd anchor point here to calibrate FPS
                      </button>
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
          )}
        </div>
      )}
    </div>
  );
});
