import { AppCloseIcon } from "./ui/AppIcons";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { formatUserError } from "../lib/errors";
import { formatDisplayMediaTitle } from "../lib/playlist";
import { playSoundCue } from "../lib/soundEffects";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import {
  enqueueSyncLifecycle,
  syncReconnect,
  syncSwitchBackup,
  type FileMatchStatus,
} from "../lib/syncplay";
import { describeSyncEndpoint } from "../lib/syncStatusDisplay";
import { sanitizeRoomCodeInput } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { formatRoomCodeDisplay, generateRoomCode } from "./HomeScreen";
import { Button } from "./ui/Button";
import { WatchPartyIcon } from "./ui/LobbyIcons";
import { OtpCodeInput } from "./ui/OtpCodeInput";
import {
  PartyCopyIcon,
  PartyCreateIcon,
  PartyHostIcon,
  PartyLeaveIcon,
  PartyPasteIcon,
  PartyServerIcon,
  PartyViewersIcon,
  PlayerEyeIcon,
  PlayerReadyIcon,
  PlayerResyncIcon,
} from "./ui/PlayerIcons";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { StatusDot } from "./ui/StatusDot";

function matchLabel(match: FileMatchStatus): { text: string; className: string } {
  switch (match) {
    case "matched":
      return { text: "In sync", className: "text-ok" };
    case "sameLengthDifferentEncode":
      return { text: "Same length", className: "text-warn" };
    case "durationMismatch":
      return { text: "Length differs", className: "text-bad" };
    case "differentFile":
      return { text: "Different video", className: "text-warn" };
    default:
      return { text: "Picking a video…", className: "text-muted" };
  }
}

interface RoomPanelProps {
  onClose?: () => void;
}

export const RoomPanel = memo(function RoomPanel({ onClose }: RoomPanelProps) {
  const roomCode = useAppStore((s) => s.roomCode);
  const literalRoom = useAppStore((s) => s.literalRoom);
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const setRoomCode = useAppStore((s) => s.setRoomCode);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);

  const status = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const serverOverrideNotice = useSyncStore((s) => s.serverOverrideNotice);
  const pushNote = useNotificationStore((s) => s.push);

  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [verifyingJoin, setVerifyingJoin] = useState(false);
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
  const ctrlLock = getControllerLockState(syncConnected, participants, effectiveUsername);

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
        });
        pushNote("info", "Switching room to backup connection route.");
      } catch (err) {
        pushNote("error", formatUserError(err, "Backup route switch failed."));
      }
    });
  };

  const handleLeaveParty = () => {
    setRoomCode("");
    useSyncStore.getState().reset();
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
    setRoomCode(code);
    pushNote("success", `Watch Party started — invite code ${formatRoomCodeDisplay(code)}`);
  };

  const handleJoinPartyMidMovie = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = sanitizeRoomCodeInput(joinCode, literalRoom);
    if (cleaned.length < (literalRoom ? 1 : 6)) {
      pushNote("info", "Enter a valid room code to join.");
      return;
    }
    setRoomCode(cleaned);
  };

  const readyCount = participants.filter((p) => p.isReady).length;
  const allReady = participants.length > 0 && readyCount === participants.length;
  const hasConnectionIssue = status.state === "reconnecting" || status.state === "error";

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
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

      <div className="ep-hairline-divider mx-1" role="separator" />

      {!roomCode ? (
        <div className="anim-tab-in flex flex-col gap-2.5 px-1 pb-0.5">
          <div className="space-y-2">
            <p className="text-[11.5px] text-secondary leading-relaxed">
              Start a synced room while your video keeps playing, or paste a friend’s code to join.
            </p>
            <button
              type="button"
              onClick={handleStartPartyMidMovie}
              className="ep-glass-primary-pill ep-press w-full h-9 rounded-full inline-flex items-center justify-center gap-2 text-xs font-medium text-white cursor-pointer"
            >
              <PartyCreateIcon size={16} className="shrink-0" />
              <span>Start Watch Party</span>
            </button>
          </div>

          <div className="ep-hairline-divider" role="separator" />

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
        <div className="anim-tab-in flex flex-col min-h-0 gap-1.5">
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
                    <span>{ctrlLock.localIsController ? "You host" : ctrlLock.controllers[0]}</span>
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

          <div className="ep-hairline-divider mx-1" role="separator" />

          {/* Viewers Header */}
          <div className="px-2 pt-0.5 flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 font-medium text-secondary">
              <PartyViewersIcon size={14} className="shrink-0" />
              <span>Watching</span>
              <span className="num text-muted">{participants.length}</span>
            </div>
            {!hideParticipants && participants.length > 0 && (
              <span className={`font-medium num ${allReady ? "text-ok" : "text-muted"}`}>
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
            <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
              {participants.map((p) => {
                const badge = matchLabel(p.fileMatch);
                const isSelf =
                  p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase();
                const cleanMediaTitle = p.fileName
                  ? formatDisplayMediaTitle(p.fileName).title
                  : null;
                return (
                  <div
                    key={p.username}
                    className="px-2 py-1.5 rounded-xl flex items-center gap-2.5 min-w-0 hover:bg-white/[0.045] transition-colors"
                  >
                    <ProfileAvatar
                      avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                      size={26}
                      className={`ring-2 shrink-0 ${p.isReady ? "ring-ok/80" : "ring-white/15"}`}
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[12.5px] font-medium text-white truncate">
                          {p.username}
                        </span>
                        {isSelf && <span className="text-[11px] text-muted shrink-0">you</span>}
                        {p.isController && (
                          <span
                            title="Room host"
                            className="inline-flex items-center gap-1 text-[10.5px] font-medium text-accent-soft shrink-0"
                          >
                            <PartyHostIcon size={11} />
                            <span>Host</span>
                          </span>
                        )}
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
                    <PlayerReadyIcon
                      ready={p.isReady}
                      size={14}
                      className="shrink-0"
                    />
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
        </div>
      )}
    </div>
  );
});
