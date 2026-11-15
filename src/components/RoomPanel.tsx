import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  RefreshCw,
  Server,
  Users,
} from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { formatUserError } from "../lib/errors";
import { formatDisplayMediaTitle } from "../lib/playlist";
import { playSoundCue } from "../lib/soundEffects";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import {
  enqueueSyncLifecycle,
  syncForceResync,
  syncReconnect,
  syncSetReady,
  syncSwitchBackup,
  type FileMatchStatus,
} from "../lib/syncplay";
import { canToggleReady, resolveReadyToggleTarget } from "../lib/syncReady";
import { describeSyncEndpoint } from "../lib/syncStatusDisplay";
import { sanitizeRoomCodeInput } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { formatRoomCodeDisplay, generateRoomCode } from "./HomeScreen";
import { Button } from "./ui/Button";
import { OtpCodeInput } from "./ui/OtpCodeInput";
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

export const RoomPanel = memo(function RoomPanel() {
  const roomCode = useAppStore((s) => s.roomCode);
  const literalRoom = useAppStore((s) => s.literalRoom);
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const setRoomCode = useAppStore((s) => s.setRoomCode);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);

  const loaded = usePlayerStore((s) => s.loaded);
  const paused = usePlayerStore((s) => s.paused);
  const flashFeedback = usePlayerStore((s) => s.flashFeedback);

  const status = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const localReady = useSyncStore((s) => s.localReady);
  const setLocalReady = useSyncStore((s) => s.setLocalReady);
  const serverOverrideNotice = useSyncStore((s) => s.serverOverrideNotice);
  const pushNote = useNotificationStore((s) => s.push);

  const [copied, setCopied] = useState(false);
  const [resyncBusy, setResyncBusy] = useState(false);
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
      setTimeout(() => setCopied(false), 1800);
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

  const handleResync = async () => {
    if (resyncBusy) return;
    setResyncBusy(true);
    try {
      await syncForceResync();
      playSoundCue("peerReady", { moviePlaying: loaded && !paused });
      flashFeedback("Resynced with room");
    } catch (err) {
      pushNote("error", formatUserError(err, "Could not resync with room."));
    } finally {
      window.setTimeout(() => setResyncBusy(false), 450);
    }
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

  if (!roomCode) {
    return (
      <div className="anim-tab-in grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-0.5">
        <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2.5 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="h-8.5 w-8.5 rounded-full bg-accent/20 border border-accent-soft/20 text-accent-soft flex items-center justify-center shrink-0">
              <Users className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white">Host a Watch Party</div>
              <div className="text-[11px] text-secondary truncate">
                Playback keeps playing smoothly while friends sync in
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleStartPartyMidMovie}
            className="ep-glass-primary-pill ep-press w-full h-9 rounded-full text-xs font-medium text-white inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>Create Room &amp; Copy Passcode</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-secondary">
              {literalRoom ? "Join a Syncplay room" : "Join with 6-digit pass"}
            </span>
            {!literalRoom && (
              <button
                type="button"
                onClick={() => void handlePasteMidMovie()}
                className="ep-bar-pill ep-press inline-flex items-center gap-1 h-6.5 px-2.5 rounded-full text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
              >
                <ClipboardPaste className="h-3 w-3" />
                <span>Paste</span>
              </button>
            )}
          </div>

          {literalRoom ? (
            <form onSubmit={handleJoinPartyMidMovie} className="flex items-center gap-2">
              <input
                type="text"
                value={joinCode}
                placeholder="Exact Syncplay room name…"
                aria-label="Room Name"
                onChange={(e) => setJoinCode(sanitizeRoomCodeInput(e.target.value, true))}
                className="ep-glass-input flex-1 h-9 px-3 rounded-xl text-xs font-mono tracking-wider text-primary placeholder:font-sans placeholder:tracking-normal placeholder:text-muted focus:outline-none min-w-0"
              />
              <Button type="submit" variant="secondary" size="sm">
                Join
              </Button>
            </form>
          ) : (
            <div className="space-y-1">
              <OtpCodeInput
                compact
                value={joinCode}
                verifying={verifyingJoin}
                onChange={setJoinCode}
                onComplete={handleAutoVerifyOtp}
              />
              <div className={`text-[10px] ${verifyingJoin ? "text-ok font-medium" : "text-muted"}`}>
                {verifyingJoin
                  ? "Joining room…"
                  : "Enters automatically as soon as all 6 digits are filled"}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const readyCount = participants.filter((p) => p.isReady).length;
  const allReady = participants.length > 0 && readyCount === participants.length;

  return (
    <div className="anim-tab-in grid grid-cols-1 md:grid-cols-[310px_minmax(0,1fr)] gap-2.5 pt-0.5">
      {/* Left Zone: Passcode, Status & Ready/Resync/Leave Controls */}
      <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2 min-w-0">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {status.state === "reconnecting" || status.state === "error" ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-bad">
                <StatusDot tone={status.state === "error" ? "bad" : "warn"} pulse />
                {status.state === "error" ? "Paused" : "Reconnecting"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-secondary">
                <StatusDot tone={syncConnected ? "ok" : "warn"} pulse={!syncConnected} />
                <span>{syncConnected ? "Connected" : "Connecting…"}</span>
              </span>
            )}

            {ctrlLock.hasControllers && (
              <span
                title={
                  ctrlLock.lockedForLocalUser
                    ? "Play, pause, and seeking follow the host."
                    : undefined
                }
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/15 text-[10px] font-medium text-accent-soft truncate"
              >
                <Lock className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">
                  {ctrlLock.localIsController ? "You host" : ctrlLock.controllers[0]}
                </span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {(status.state === "reconnecting" || status.state === "error") && (
              <>
                <button
                  type="button"
                  onClick={handleRetryConnect}
                  title={endpointSummary.detailText || "Retry connection"}
                  className="ep-press inline-flex items-center gap-1 h-6 px-2 rounded-full bg-bad/20 hover:bg-bad/30 text-[10.5px] font-medium text-bad cursor-pointer"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  Retry
                </button>
                {status.suggestBackup && !endpointSummary.isBackupServer && (
                  <button
                    type="button"
                    onClick={handleSwitchBackup}
                    className="ep-bar-pill ep-press inline-flex items-center gap-1 h-6 px-2 rounded-full text-[10.5px] font-medium text-secondary hover:text-white cursor-pointer"
                  >
                    <Server className="h-2.5 w-2.5" />
                    Backup
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              onClick={handleLeaveParty}
              title="Leave Watch Party and continue watching solo"
              className="ep-bar-pill ep-press inline-flex items-center gap-1 h-6.5 px-2.5 rounded-full text-[11px] font-medium text-secondary hover:text-bad cursor-pointer"
            >
              <LogOut className="h-3 w-3" />
              <span>Leave</span>
            </button>
          </div>
        </div>

        {/* Readable Passcode Surface */}
        <div className="rounded-xl bg-white/[0.045] border border-white/[0.10] px-3 py-1.5 flex items-center justify-between gap-2 min-w-0">
          <div className="min-w-0">
            <div className="text-[9.5px] uppercase tracking-wider text-muted font-medium">
              {literalRoom ? "Syncplay Room" : "Invite Pass"}
            </div>
            <div
              title={serverOverrideNotice || undefined}
              className="text-base font-mono font-semibold tracking-[0.14em] text-white num truncate"
            >
              {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)}
            </div>
          </div>

          <Button
            variant={copied ? "primary" : "secondary"}
            size="sm"
            onClick={() => void handleCopyRoom()}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>

        {/* Direct Sync Controls */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={!canToggleReady(loaded)}
            onClick={handleToggleReady}
            title={loaded ? "Toggle Ready status (R)" : "Load a local video first"}
            className={`ep-press h-7.5 px-3 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
              localReady && loaded
                ? "ep-glass-pill-active text-white"
                : "ep-bar-pill text-secondary hover:text-white"
            }`}
          >
            {localReady && loaded ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-ok shrink-0" />
            ) : (
              <Circle className="h-3.5 w-3.5 text-muted shrink-0" />
            )}
            <span>{localReady && loaded ? "Ready" : "Not Ready"}</span>
          </button>

          <button
            type="button"
            disabled={resyncBusy}
            onClick={() => void handleResync()}
            title="Force instant resync with party timestamp"
            className="ep-bar-pill ep-press h-7.5 px-3 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-medium text-secondary hover:text-white cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${resyncBusy ? "animate-spin" : ""}`} />
            <span>Resync</span>
          </button>
        </div>
      </div>

      {/* Right Zone: Horizontal Balanced Viewers Grid */}
      <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Users className="h-3.5 w-3.5 text-accent-soft shrink-0" />
            <span className="text-xs font-medium text-white truncate">Watching Together</span>
            <span className="px-1.5 py-0.5 rounded-full bg-white/[0.08] text-[10.5px] font-medium text-white/90 num">
              {participants.length}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!hideParticipants && participants.length > 0 && (
              <span
                className={`text-[10.5px] font-medium num ${
                  allReady ? "text-ok" : "text-muted"
                }`}
              >
                {allReady ? "All Ready" : `${readyCount}/${participants.length} Ready`}
              </span>
            )}
            <button
              type="button"
              onClick={() => setHideParticipants(!hideParticipants)}
              aria-label={hideParticipants ? "Show profile icons" : "Hide profile icons"}
              title={hideParticipants ? "Show profile icons" : "Hide profile icons"}
              className="ep-bar-icon-btn h-6.5 w-6.5 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
            >
              {hideParticipants ? (
                <EyeOff className="h-3.5 w-3.5 text-accent-soft" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {hideParticipants ? (
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] px-3 py-2 flex items-center justify-between gap-2 text-xs text-muted">
            <span className="inline-flex items-center gap-2">
              <EyeOff className="h-3.5 w-3.5 shrink-0 text-accent-soft" />
              Profile icons hidden for focus
            </span>
            <button
              type="button"
              onClick={() => setHideParticipants(false)}
              className="text-accent-soft hover:text-white font-medium cursor-pointer"
            >
              Show
            </button>
          </div>
        ) : participants.length === 0 ? (
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.07] px-3 py-2.5 text-xs text-muted">
            {syncConnected
              ? "Waiting for friends — share the invite pass on the left."
              : "Connecting to your watch room…"}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-28 overflow-y-auto pr-0.5">
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
                  className={`rounded-xl px-2.5 py-2 flex items-center gap-2.5 min-w-0 border transition-colors ${
                    p.isReady
                      ? "bg-ok/[0.045] border-ok/25"
                      : "bg-white/[0.035] border-white/[0.07]"
                  }`}
                >
                  <ProfileAvatar
                    avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                    size={28}
                    className={`ring-2 shrink-0 ${p.isReady ? "ring-ok/85" : "ring-white/15"}`}
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-medium text-white truncate">
                        {p.username}
                        {isSelf ? " (you)" : ""}
                      </span>
                      {p.isController && (
                        <span className="px-1.5 py-0.5 text-[9.5px] font-medium bg-accent/25 text-accent-soft rounded-full shrink-0">
                          Host
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[10.5px] min-w-0">
                      <span className={`font-medium shrink-0 ${badge.className}`}>
                        {badge.text}
                      </span>
                      {cleanMediaTitle && (
                        <span className="text-muted truncate" title={p.fileName ?? undefined}>
                          {cleanMediaTitle}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {participants.length === 1 && (
              <div className="rounded-xl bg-white/[0.025] border border-white/[0.07] px-3 py-2 flex items-center justify-between gap-2 min-w-0">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-secondary truncate">
                    Waiting for friends…
                  </div>
                  <div className="text-[10.5px] text-muted truncate">
                    Share code {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)} to sync
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyRoom()}
                  className="ep-bar-pill ep-press h-7 px-2.5 rounded-full text-[11px] font-medium text-white shrink-0 cursor-pointer"
                >
                  {copied ? "Copied" : "Invite"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
