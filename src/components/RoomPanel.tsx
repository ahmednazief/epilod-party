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
import {
  enqueueSyncLifecycle,
  syncReconnect,
  syncSwitchBackup,
  type FileMatchStatus,
} from "../lib/syncplay";
import { sanitizeRoomCodeInput } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { useSyncStore } from "../store/useSyncStore";
import { formatRoomCodeDisplay, generateRoomCode } from "./HomeScreen";
import { Button } from "./ui/Button";
import { OtpCodeInput } from "./ui/OtpCodeInput";
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

const AVATAR_TONES = [
  "bg-accent text-white",
  "bg-emerald-500/85 text-slate-950",
  "bg-amber-400/90 text-slate-950",
  "bg-sky-400/90 text-slate-950",
];

export const RoomPanel = memo(function RoomPanel() {
  const roomCode = useAppStore((s) => s.roomCode);
  const literalRoom = useAppStore((s) => s.literalRoom);
  const username = useAppStore((s) => s.username);
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
      <div className="anim-tab-in px-3.5 pb-3.5 pt-2 space-y-2.5">
        <div className="ep-glass-well rounded-2xl p-4 space-y-3">
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
            className="ep-glass-primary-pill ep-press w-full h-9.5 rounded-xl text-xs font-medium text-white inline-flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>Create Room &amp; Copy Invite</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="ep-glass-well rounded-2xl p-3.5 space-y-2.5">
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
            <div className="space-y-1.5">
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
    <div className="anim-tab-in px-3.5 pb-3.5 pt-2 space-y-2.5">
      {/* Room invite code well */}
      <div className="ep-glass-well rounded-2xl px-3.5 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-muted">
            {literalRoom ? "Party Room" : "6-Digit Invite Pass"}
          </div>
          <p className="text-sm font-mono font-semibold tracking-wider text-white truncate pt-0.5 tabular-nums">
            {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)}
          </p>
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

      {/* Only surface connection actions when actually reconnecting/erroring */}
      {(status.state === "reconnecting" || status.state === "error") && (
        <div className="space-y-2 rounded-2xl bg-bad/12 px-3.5 py-3">
          <div className="flex items-center gap-2 text-xs text-bad font-medium">
            <StatusDot tone={status.state === "error" ? "bad" : "warn"} pulse />
            <span>
              {status.state === "error"
                ? "Connection paused"
                : "Reconnecting to friends…"}
            </span>
          </div>
          {endpointSummary.detailText && (
            <p className="text-[11px] text-secondary leading-relaxed">
              {endpointSummary.detailText}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button variant="secondary" size="sm" onClick={handleRetryConnect}>
              <RefreshCw className="h-3 w-3" />
              Retry Now
            </Button>
            {status.suggestBackup && !endpointSummary.isBackupServer && (
              <Button variant="secondary" size="sm" onClick={handleSwitchBackup}>
                <Server className="h-3 w-3" />
                Alternate Route
              </Button>
            )}
          </div>
        </div>
      )}

      {ctrlLock.hasControllers && (
        <div className="rounded-2xl bg-accent/15 px-3.5 py-2.5 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-accent-soft">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              {ctrlLock.localIsController
                ? "You are hosting playback"
                : `Hosted by ${ctrlLock.controllers.join(", ")}`}
            </span>
          </div>
          {ctrlLock.lockedForLocalUser && (
            <p className="text-[11px] text-secondary">
              Play, pause, and seeking follow the host.
            </p>
          )}
        </div>
      )}

      {serverOverrideNotice && (
        <p className="text-[11px] text-secondary px-1">{serverOverrideNotice}</p>
      )}

      {/* Friends list */}
      <div className="pt-1 space-y-1.5">
        <div className="px-1 flex items-center justify-between text-[11px] font-medium text-muted">
          <span>Watching Together ({participants.length})</span>
        </div>

        {hideParticipants ? (
          <div className="px-2 py-2.5 flex items-center justify-between gap-2 text-xs text-muted">
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
          <p className="text-xs text-muted px-2 py-2">
            {syncConnected
              ? "Waiting for friends — share the invite pass above."
              : "Connecting to your watch room…"}
          </p>
        ) : (
          <div className="space-y-0.5">
            {participants.map((p, idx) => {
              const badge = matchLabel(p.fileMatch);
              const isSelf =
                p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase();
              return (
                <div
                  key={p.username}
                  className="ep-menu-row px-2 py-1.5 flex items-center justify-between gap-2.5"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`h-7 w-7 rounded-full text-xs font-semibold flex items-center justify-center shrink-0 ring-2 ${
                        p.isReady ? "ring-ok/85" : "ring-white/15"
                      } ${AVATAR_TONES[idx % AVATAR_TONES.length]}`}
                    >
                      {p.username.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-white truncate">
                          {p.username}
                          {isSelf ? " (you)" : ""}
                        </span>
                        {p.isController && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-accent/25 text-accent-soft rounded-full">
                            Host
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted truncate">
                        {p.fileName || "No video selected"}
                      </div>
                    </div>
                  </div>
                  <span className={`text-[11px] font-medium shrink-0 ${badge.className}`}>
                    {badge.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
