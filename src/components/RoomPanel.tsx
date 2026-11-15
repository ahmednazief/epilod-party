import {
  ArrowRight,
  Check,
  ClipboardPaste,
  Copy,
  EyeOff,
  Lock,
  RefreshCw,
  Server,
  Users,
} from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { formatUserError } from "../lib/errors";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import { describeSyncEndpoint } from "../lib/syncStatusDisplay";
import { playSoundCue } from "../lib/soundEffects";
import {
  enqueueSyncLifecycle,
  syncForceResync,
  syncReconnect,
  syncSwitchBackup,
  type FileMatchStatus,
} from "../lib/syncplay";
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
      return { text: "Picking a movie…", className: "text-muted" };
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
      setTimeout(() => setCopied(false), 1800);
    } catch {
      pushNote("info", `Room code: ${roomCode}`);
    }
  };

  const handleForceResync = async () => {
    try {
      await syncForceResync();
      const p = usePlayerStore.getState();
      playSoundCue("peerReady", { moviePlaying: p.loaded && !p.paused });
      p.flashFeedback("Resynced with room");
    } catch (err) {
      pushNote("error", formatUserError(err, "Could not resync playback."));
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
        <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-full bg-accent/25 text-accent-soft flex items-center justify-center shrink-0">
              <Users className="h-4 w-4" />
            </span>
            <div>
              <div className="text-xs font-medium text-white">Turn this into a Watch Party</div>
              <div className="text-[11px] text-secondary">
                Keep playing smoothly while friends sync in
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleStartPartyMidMovie}
            className="ep-glass-primary-pill ep-press w-full h-9 rounded-xl text-xs font-medium text-white inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>Create Room &amp; Copy Invite</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-secondary">
              {literalRoom ? "Join a Syncplay room" : "Join by 6-digit code"}
            </span>
            {!literalRoom && (
              <button
                type="button"
                onClick={() => void handlePasteMidMovie()}
                className="ep-press inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.07] hover:bg-white/[0.12] text-[10px] font-medium text-secondary hover:text-white cursor-pointer"
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
                  ? "Verifying 6-digit pass…"
                  : "Enters automatically as soon as the 6th digit is filled"}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="anim-tab-in space-y-2 pt-0.5">
      {/* Row 1: Compact Invite Pass + Host Pill + Participant Count / Connection Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <div className="ep-glass-well rounded-2xl px-3 py-1.5 inline-flex items-center gap-3">
            <div className="min-w-0">
              <span className="text-[10px] font-medium text-muted block leading-tight">
                {literalRoom ? "Party Room" : "6-Digit Invite Pass"}
              </span>
              <span className="text-xs font-mono font-semibold tracking-wider text-white tabular-nums">
                {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)}
              </span>
            </div>
            <Button
              variant={copied ? "primary" : "secondary"}
              size="sm"
              onClick={() => void handleCopyRoom()}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? "Copied" : "Invite"}</span>
            </Button>
          </div>

          {ctrlLock.hasControllers && (
            <div
              title={
                ctrlLock.lockedForLocalUser
                  ? "Play, pause, and seeking follow the host."
                  : undefined
              }
              className="rounded-2xl bg-accent/15 px-3 py-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-accent-soft"
            >
              <Lock className="h-3.5 w-3.5 shrink-0" />
              <span>
                {ctrlLock.localIsController
                  ? "You are hosting playback"
                  : `Hosted by ${ctrlLock.controllers.join(", ")}`}
              </span>
            </div>
          )}

          {serverOverrideNotice && (
            <span className="text-[11px] text-secondary truncate max-w-[240px]">
              {serverOverrideNotice}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {(status.state === "reconnecting" || status.state === "error") && (
            <div className="inline-flex items-center gap-1.5 rounded-2xl bg-bad/15 px-2.5 py-1 text-[11px] text-bad font-medium">
              <StatusDot tone={status.state === "error" ? "bad" : "warn"} pulse />
              <span>
                {status.state === "error" ? "Paused" : "Reconnecting…"}
              </span>
              {endpointSummary.detailText && (
                <span className="hidden xl:inline text-secondary font-normal">
                  · {endpointSummary.detailText}
                </span>
              )}
              <Button variant="secondary" size="sm" onClick={handleRetryConnect}>
                <RefreshCw className="h-3 w-3" />
                Retry
              </Button>
              {status.suggestBackup && !endpointSummary.isBackupServer && (
                <Button variant="secondary" size="sm" onClick={handleSwitchBackup}>
                  <Server className="h-3 w-3" />
                  Backup
                </Button>
              )}
            </div>
          )}

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleForceResync()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Resync</span>
          </Button>

          <span className="text-[11px] font-medium text-muted px-1">
            Watching Together ({participants.length})
          </span>
        </div>
      </div>

      {/* Row 2: Horizontal Friends Grid */}
      {hideParticipants ? (
        <div className="ep-glass-well rounded-2xl px-3.5 py-2 flex items-center justify-between gap-2 text-xs text-muted">
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
        <div className="ep-glass-well rounded-2xl px-3.5 py-2.5 text-xs text-muted">
          {syncConnected
            ? "Waiting for friends — share the invite pass above."
            : "Connecting to your watch room…"}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-32 overflow-y-auto">
          {participants.map((p) => {
            const badge = matchLabel(p.fileMatch);
            const isSelf =
              p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase();
            return (
              <div
                key={p.username}
                className="ep-glass-well rounded-2xl px-3 py-2 flex items-center gap-2.5 min-w-0"
              >
                <ProfileAvatar
                  avatarId={resolvePeerAvatarId(p.username, effectiveUsername, avatarId)}
                  size={30}
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
                  <div className="flex items-center justify-between gap-1.5 text-[10.5px]">
                    <span className={`font-medium shrink-0 ${badge.className}`}>
                      {badge.text}
                    </span>
                    <span className="text-muted truncate">
                      {p.fileName || "No video"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
