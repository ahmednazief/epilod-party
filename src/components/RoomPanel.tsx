import {
  Check,
  CheckCircle2,
  Circle,
  Copy,
  EyeOff,
  Lock,
  RefreshCw,
  Server,
  Shield,
} from "lucide-react";
import { useState } from "react";
import { formatUserError } from "../lib/errors";
import { getControllerLockState } from "../lib/syncController";
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
import { StatusDot, type StatusTone } from "./ui/StatusDot";

function matchLabel(match: FileMatchStatus): { text: string; className: string } {
  switch (match) {
    case "matched":
      return { text: "Exact match", className: "text-ok" };
    case "sameLengthDifferentEncode":
      return { text: "Same length · diff encode", className: "text-ok" };
    case "durationMismatch":
      return { text: "Duration differs", className: "text-bad" };
    case "differentFile":
      return { text: "Different filename", className: "text-warn" };
    default:
      return { text: "No file loaded", className: "text-muted" };
  }
}

export function RoomPanel() {
  const roomCode = useAppStore((s) => s.roomCode);
  const literalRoom = useAppStore((s) => s.literalRoom);
  const username = useAppStore((s) => s.username);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const hideParticipants = useAppStore((s) => s.hideParticipants);

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
  const ctrlLock = getControllerLockState(syncConnected, participants, username);

  let dotTone: StatusTone = "muted";
  let pulse = false;
  if (status.state === "connected") dotTone = "ok";
  else if (status.state === "connecting" || status.state === "reconnecting") {
    dotTone = "warn";
    pulse = true;
  } else if (status.state === "error") dotTone = "bad";

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
        pushNote("info", "Switching room session to backup server (:8998).");
      } catch (err) {
        pushNote("error", formatUserError(err, "Backup switch failed."));
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
    <div className="anim-tab-in p-3 space-y-4">
      <div className="p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted">
            {literalRoom ? "Syncplay Room" : "Room Code"}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void handleCopyRoom()}>
            {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
        <p className="text-sm font-mono font-medium text-primary break-all">{roomCode}</p>
      </div>

      <div className="p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StatusDot tone={dotTone} pulse={pulse} />
            <span className="text-xs font-medium text-primary truncate">
              {endpointSummary.badgeText}
            </span>
          </div>
          {status.state === "connected" && status.tls && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-raised text-ok border border-hairline rounded-[4px] shrink-0">
              <Shield className="h-2.5 w-2.5" />
              TLS
            </span>
          )}
        </div>

        {endpointSummary.detailText && (
          <p
            className={`text-[11px] leading-relaxed ${
              endpointSummary.isBackupServer || status.state === "reconnecting"
                ? "text-warn"
                : status.state === "error"
                  ? "text-bad"
                  : "text-secondary"
            }`}
          >
            {endpointSummary.detailText}
          </p>
        )}

        {(status.state === "reconnecting" || status.state === "error") && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={handleRetryConnect}>
              <RefreshCw className="h-3 w-3" />
              Retry Now
            </Button>
            {status.suggestBackup && !endpointSummary.isBackupServer && (
              <Button variant="secondary" size="sm" onClick={handleSwitchBackup}>
                <Server className="h-3 w-3" />
                Switch to :8998
              </Button>
            )}
          </div>
        )}
      </div>

      {ctrlLock.hasControllers && (
        <div className="p-2.5 bg-canvas border border-accent/40 rounded-[var(--radius-ui)] space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-accent">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              {ctrlLock.localIsController
                ? "You are a room controller"
                : `Managed room (${ctrlLock.controllers.join(", ")})`}
            </span>
          </div>
          {ctrlLock.lockedForLocalUser && (
            <p className="text-[11px] text-secondary">
              Play, pause, and seeking are locked to room controllers.
            </p>
          )}
        </div>
      )}

      {serverOverrideNotice && (
        <div className="p-2.5 bg-canvas border border-hairline rounded-[var(--radius-ui)] text-[11px] text-secondary">
          {serverOverrideNotice}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-secondary">Your Status</span>
          <Button
            variant={localReady && loaded ? "primary" : "secondary"}
            size="sm"
            disabled={!canToggleReady(loaded)}
            onClick={handleToggleReady}
          >
            {localReady && loaded ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <Circle className="h-3.5 w-3.5" />
            )}
            <span>{localReady && loaded ? "Ready" : "Not Ready"}</span>
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-secondary">
            Participants ({participants.length})
          </span>
        </div>

        {hideParticipants ? (
          <div className="p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] flex items-center gap-2 text-xs text-muted">
            <EyeOff className="h-3.5 w-3.5 shrink-0" />
            <span>Hidden in Privacy Mode</span>
          </div>
        ) : participants.length === 0 ? (
          <p className="text-xs text-muted p-2">
            {syncConnected ? "Only you are in this room so far." : "Waiting to join room…"}
          </p>
        ) : (
          <div className="space-y-1.5">
            {participants.map((p) => {
              const badge = matchLabel(p.fileMatch);
              const isSelf = p.username.trim().toLowerCase() === username.trim().toLowerCase();
              return (
                <div
                  key={p.username}
                  className="p-2.5 bg-canvas border border-hairline rounded-[var(--radius-ui)] space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot tone={p.isReady ? "ok" : "muted"} />
                      <span className="text-xs font-medium text-primary truncate">
                        {p.username}
                        {isSelf ? " (you)" : ""}
                      </span>
                      {p.isController && (
                        <span className="px-1 py-0.5 text-[10px] bg-raised text-accent border border-hairline rounded-[3px]">
                          Host
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-secondary shrink-0">
                      {p.isReady ? "Ready" : "Not ready"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-muted truncate">{p.fileName || "No file"}</span>
                    <span className={`${badge.className} shrink-0`}>{badge.text}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
