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

  const readyCount = participants.filter((p) => p.isReady).length;

  return (
    <div className="anim-tab-in flex flex-col gap-2.5">
      {/* Card 1: Invite Pass & Room Connection */}
      <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2.5 min-w-0">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-xs font-medium text-secondary truncate">
            {literalRoom ? "Party Room" : "Invite Pass"}
          </span>

          {status.state === "reconnecting" || status.state === "error" ? (
            <div className="inline-flex items-center gap-1.5 shrink-0">
              <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-bad">
                <StatusDot tone={status.state === "error" ? "bad" : "warn"} pulse />
                {status.state === "error" ? "Paused" : "Reconnecting"}
              </span>
              <button
                type="button"
                onClick={handleRetryConnect}
                title={endpointSummary.detailText || "Retry connection"}
                className="ep-press inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bad/20 hover:bg-bad/30 text-[10.5px] font-medium text-bad cursor-pointer"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                Retry
              </button>
              {status.suggestBackup && !endpointSummary.isBackupServer && (
                <button
                  type="button"
                  onClick={handleSwitchBackup}
                  className="ep-press inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.08] hover:bg-white/[0.14] text-[10.5px] font-medium text-secondary hover:text-white cursor-pointer"
                >
                  <Server className="h-2.5 w-2.5" />
                  Backup
                </button>
              )}
            </div>
          ) : ctrlLock.hasControllers ? (
            <span
              title={
                ctrlLock.lockedForLocalUser
                  ? "Play, pause, and seeking follow the host."
                  : undefined
              }
              className="inline-flex items-center gap-1 text-[10.5px] font-medium text-accent-soft truncate"
            >
              <Lock className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {ctrlLock.localIsController ? "You host" : ctrlLock.controllers[0]}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium text-secondary shrink-0">
              <StatusDot tone={syncConnected ? "ok" : "warn"} pulse={!syncConnected} />
              <span>{syncConnected ? "Connected" : "Connecting…"}</span>
            </span>
          )}
        </div>

        <div className="ep-glass-input rounded-xl pl-3 pr-1.5 py-1 flex items-center justify-between gap-2 min-w-0">
          <span
            title={serverOverrideNotice || undefined}
            className="text-xs font-mono font-semibold tracking-wider text-white tabular-nums truncate"
          >
            {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)}
          </span>
          <Button
            variant={copied ? "primary" : "secondary"}
            size="sm"
            onClick={() => void handleCopyRoom()}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? "Copied" : "Invite"}</span>
          </Button>
        </div>
      </div>

      {/* Card 2: Watching Together & Peer Status */}
      <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2.5 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Users className="h-3.5 w-3.5 text-accent-soft shrink-0" />
            <span className="text-xs font-medium text-secondary">Watching Together</span>
            <span className="px-1.5 py-0.5 rounded-full bg-white/[0.08] text-[10.5px] font-medium text-white/90 num">
              {participants.length}
            </span>
          </div>

          {!hideParticipants && participants.length > 0 && (
            <span className="text-[10.5px] font-medium text-muted num shrink-0">
              {readyCount === participants.length
                ? "All Ready"
                : `${readyCount}/${participants.length} Ready`}
            </span>
          )}
        </div>

        {hideParticipants ? (
          <div className="ep-glass-input rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-xs text-muted">
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
          <div className="ep-glass-input rounded-xl px-3 py-2 text-xs text-muted">
            {syncConnected
              ? "Waiting for friends — share the invite pass on the left."
              : "Connecting to your watch room…"}
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-44 overflow-y-auto">
            {participants.map((p) => {
              const badge = matchLabel(p.fileMatch);
              const isSelf =
                p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase();
              return (
                <div
                  key={p.username}
                  className="ep-glass-input rounded-xl px-2.5 py-1.5 flex items-center gap-2.5 min-w-0"
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
                    <div className="flex items-center justify-between gap-1.5 text-[10.5px] min-w-0">
                      <span className={`font-medium shrink-0 ${badge.className}`}>
                        {badge.text}
                      </span>
                      {p.fileName && (
                        <span className="text-muted truncate" title={p.fileName}>
                          {p.fileName}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {participants.length === 1 && (
              <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.02] px-3 py-1.5 flex items-center justify-between gap-2 text-[11px] text-muted min-w-0">
                <span className="truncate">Waiting for friends to join…</span>
                <button
                  type="button"
                  onClick={() => void handleCopyRoom()}
                  className="text-accent-soft hover:text-white font-medium shrink-0 cursor-pointer"
                >
                  {copied ? "Copied" : "Copy Pass"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
