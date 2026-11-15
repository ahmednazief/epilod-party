import {
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Eye,
  EyeOff,
  Lock,
  RefreshCw,
  Server,
} from "lucide-react";
import { memo, useState } from "react";
import { formatUserError } from "../lib/errors";
import { getControllerLockState, resolveEffectiveUsername } from "../lib/syncController";
import { canToggleReady, resolveReadyToggleTarget } from "../lib/syncReady";
import { describeSyncEndpoint } from "../lib/syncStatusDisplay";
import {
  enqueueSyncLifecycle,
  syncReconnect,
  syncSetReady,
  syncSwitchBackup,
  type FileMatchStatus,
} from "../lib/syncplay";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { Button } from "./ui/Button";
import { StatusDot } from "./ui/StatusDot";

function matchLabel(match: FileMatchStatus): { text: string; className: string } {
  switch (match) {
    case "matched":
      return { text: "Watching in sync", className: "text-ok" };
    case "sameLengthDifferentEncode":
      return { text: "Same length · different encode", className: "text-warn" };
    case "durationMismatch":
      return { text: "Different video length", className: "text-bad" };
    case "differentFile":
      return { text: "Different file", className: "text-warn" };
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
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);

  const loaded = usePlayerStore((s) => s.loaded);

  const status = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const localReady = useSyncStore((s) => s.localReady);
  const serverOverrideNotice = useSyncStore((s) => s.serverOverrideNotice);
  const setLocalReady = useSyncStore((s) => s.setLocalReady);
  const pushNote = useNotificationStore((s) => s.push);

  const [copied, setCopied] = useState(false);

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

  const handleToggleReady = () => {
    if (!canToggleReady(loaded)) {
      pushNote("info", "Load a local video file first.");
      return;
    }
    const target = resolveReadyToggleTarget(loaded, localReady);
    if (target !== null) {
      setLocalReady(target);
      void syncSetReady(target, true);
    }
  };

  return (
    <div className="anim-tab-in px-4 py-3.5 space-y-4">
      {/* Room invite code row — borderless typography + tactile Copy pill */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-muted">
            {literalRoom ? "Party Room" : "Invite Code"}
          </div>
          <p className="text-sm font-mono font-medium text-white truncate pt-0.5">
            {roomCode}
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
        <div className="space-y-2 rounded-2xl bg-bad/10 px-3.5 py-3">
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

      <div className="ep-hairline-divider" />

      {/* Quick Comfort Controls: Ready & Profile Icon Visibility */}
      <div className="space-y-1">
        <div className="ep-menu-row px-2.5 py-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-primary">Your Status</span>
          <button
            type="button"
            disabled={!canToggleReady(loaded)}
            onClick={handleToggleReady}
            className={`ep-press h-7 px-3 rounded-full inline-flex items-center gap-1.5 text-xs font-medium cursor-pointer disabled:opacity-45 ${
              localReady && loaded
                ? "ep-glass-primary-pill text-white"
                : "bg-white/10 text-secondary hover:text-white"
            }`}
          >
            {localReady && loaded ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Circle className="h-3.5 w-3.5" />
            )}
            <span>{localReady && loaded ? "Ready" : "Not Ready"}</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => setHideParticipants(!hideParticipants)}
          className="ep-menu-row ep-press w-full px-2.5 py-2 flex items-center justify-between gap-2 text-left cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs text-primary">
            {hideParticipants ? (
              <EyeOff className="h-3.5 w-3.5 text-accent-soft" />
            ) : (
              <Eye className="h-3.5 w-3.5 text-secondary" />
            )}
            <span>Friend Profile Icons</span>
          </div>
          <span
            className={`text-[11px] font-medium ${
              hideParticipants ? "text-accent-soft" : "text-ok"
            }`}
          >
            {hideParticipants ? "Hidden" : "Visible"}
          </span>
        </button>
      </div>

      <div className="ep-hairline-divider" />

      {/* Borderless NSMenu-style Friends list */}
      <div className="space-y-2">
        <div className="px-1 flex items-center justify-between text-[11px] font-medium text-muted">
          <span>Watching Together ({participants.length})</span>
        </div>

        {hideParticipants ? (
          <div className="px-2.5 py-3 flex items-center justify-between gap-2 text-xs text-muted">
            <span className="inline-flex items-center gap-2">
              <EyeOff className="h-3.5 w-3.5 shrink-0 text-accent-soft" />
              Profile icons tucked away for focus
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
              ? "Waiting for friends — share the invite code above."
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
                  className="ep-menu-row px-2.5 py-2 flex items-center justify-between gap-2.5"
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
