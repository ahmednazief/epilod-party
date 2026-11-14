import {
  Check,
  Copy,
  EyeOff,
  Lock,
  RefreshCw,
  Server,
} from "lucide-react";
import { useState } from "react";
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
import { StatusDot, type StatusTone } from "./ui/StatusDot";

function matchLabel(match: FileMatchStatus): { text: string; className: string } {
  switch (match) {
    case "matched":
      return { text: "Same video", className: "text-secondary" };
    case "sameLengthDifferentEncode":
      return { text: "Same length · check file", className: "text-warn" };
    case "durationMismatch":
      return { text: "Different length", className: "text-bad" };
    case "differentFile":
      return { text: "Check episode", className: "text-warn" };
    default:
      return { text: "No video yet", className: "text-muted" };
  }
}

function getInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
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
  const effectiveUsername = resolveEffectiveUsername(status, username);
  const ctrlLock = getControllerLockState(syncConnected, participants, effectiveUsername);
  const isReady = localReady && loaded;

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
      pushNote("info", `Invite code: ${roomCode}`);
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
        pushNote("info", "Switching watch party to the backup server.");
      } catch (err) {
        pushNote("error", formatUserError(err, "Could not switch to backup server."));
      }
    });
  };

  const handleToggleReady = () => {
    if (!canToggleReady(loaded)) {
      pushNote("info", "Open a video first to mark yourself Ready.");
      return;
    }
    const target = resolveReadyToggleTarget(loaded, localReady);
    if (target !== null) {
      setLocalReady(target);
      void syncSetReady(target, true);
    }
  };

  const showConnectionCard =
    status.state !== "connected" || endpointSummary.isBackupServer;

  return (
    <div className="anim-tab-in p-3.5 space-y-3">
      <div className="p-3.5 bg-canvas border border-hairline rounded-xl flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <span className="text-[11px] font-medium text-muted block">
            {literalRoom ? "Room Name" : "Invite Code"}
          </span>
          <p className="text-sm font-mono font-semibold text-primary tracking-wide truncate">
            {roomCode}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void handleCopyRoom()}>
          {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>

      <div className="px-3.5 py-3 bg-canvas border border-hairline rounded-xl flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-primary">Your Status</span>
        <button
          type="button"
          role="switch"
          aria-checked={isReady}
          disabled={!canToggleReady(loaded)}
          onClick={handleToggleReady}
          title={
            loaded
              ? isReady
                ? "Mark as Not Ready"
                : "Mark as Ready"
              : "Open a video first"
          }
          className={`inline-flex items-center gap-2 pl-3 pr-1.5 py-1 rounded-full text-xs font-medium transition-colors duration-150 cursor-pointer disabled:opacity-45 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent ${
            isReady
              ? "bg-accent text-white hover:bg-accent-hover"
              : "bg-raised text-secondary border border-hairline hover:text-primary"
          }`}
        >
          <span>{isReady ? "Ready" : "Not Ready"}</span>
          <span
            aria-hidden="true"
            className={`h-4 w-4 rounded-full transition-colors ${
              isReady ? "bg-white" : "bg-muted/60"
            }`}
          />
        </button>
      </div>

      {showConnectionCard && (
        <div className="p-3 bg-canvas border border-hairline rounded-xl space-y-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <StatusDot tone={dotTone} pulse={pulse} />
            <span className="text-xs font-medium text-primary truncate">
              {status.state === "connecting"
                ? "Connecting to watch party…"
                : status.state === "reconnecting"
                  ? `Reconnecting in ${status.retryInSecs}s…`
                  : status.state === "error"
                    ? "Connection issue"
                    : endpointSummary.isBackupServer
                      ? "Using backup server"
                      : "Disconnected"}
            </span>
          </div>

          {endpointSummary.detailText && (
            <p
              className={`text-[11px] leading-relaxed ${
                status.state === "error" ? "text-bad" : "text-secondary"
              }`}
            >
              {endpointSummary.detailText}
            </p>
          )}

          {(status.state === "reconnecting" || status.state === "error") && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Button variant="secondary" size="sm" onClick={handleRetryConnect}>
                <RefreshCw className="h-3 w-3" />
                Retry
              </Button>
              {status.suggestBackup && !endpointSummary.isBackupServer && (
                <Button variant="secondary" size="sm" onClick={handleSwitchBackup}>
                  <Server className="h-3 w-3" />
                  Try Backup Server
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {ctrlLock.hasControllers && (
        <div className="p-3 bg-canvas border border-accent/35 rounded-xl space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-accent-soft">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              {ctrlLock.localIsController
                ? "You are the room host"
                : `Hosted by ${ctrlLock.controllers.join(", ")}`}
            </span>
          </div>
          {ctrlLock.lockedForLocalUser && (
            <p className="text-[11px] text-secondary">
              Only the host can play, pause, or seek in this room.
            </p>
          )}
        </div>
      )}

      {serverOverrideNotice && (
        <div className="p-2.5 bg-canvas border border-hairline rounded-xl text-[11px] text-secondary">
          {serverOverrideNotice}
        </div>
      )}

      <div className="space-y-2 pt-1">
        {hideParticipants ? (
          <div className="p-3.5 bg-canvas border border-hairline rounded-xl flex items-center gap-2 text-xs text-muted">
            <EyeOff className="h-3.5 w-3.5 shrink-0" />
            <span>Friend names hidden in Privacy Mode</span>
          </div>
        ) : participants.length === 0 ? (
          <p className="text-xs text-muted px-1 py-2">
            {syncConnected
              ? "Share the invite code above to watch with friends."
              : "Joining watch party…"}
          </p>
        ) : (
          <div className="space-y-2">
            {participants.map((p) => {
              const badge = matchLabel(p.fileMatch);
              const isSelf =
                p.username.trim().toLowerCase() === effectiveUsername.trim().toLowerCase();
              return (
                <div
                  key={p.username}
                  className="p-3 bg-canvas border border-hairline rounded-xl flex items-center gap-3"
                >
                  <div
                    aria-hidden="true"
                    className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                      isSelf
                        ? "bg-raised text-primary border border-hairline"
                        : "bg-accent text-white"
                    }`}
                  >
                    {getInitial(p.username)}
                  </div>

                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-medium text-primary truncate">
                        {p.username}
                        {isSelf ? " (You)" : ""}
                      </span>
                      {p.isController && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium bg-raised text-accent-soft border border-hairline rounded-[4px] shrink-0">
                          Host
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px]">
                      <StatusDot tone={p.isReady ? "ok" : "muted"} />
                      <span className={`${badge.className} truncate`}>
                        {badge.text}
                      </span>
                    </div>
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
