import type { SyncStatusPayload } from "./syncplay";

export const SYNCPLAY_ENDPOINT = "syncplay.pl:8999";
export const CLOUD_ENDPOINT = "wss://epilod-sync.ahmednazief.workers.dev";
// Flip to CLOUD_ENDPOINT to make Epilod Cloud (Cloudflare) the default.
export const DEFAULT_ENDPOINT = SYNCPLAY_ENDPOINT;
export const BACKUP_ENDPOINT = "syncplay.pl:8998";

export function isCloudEndpoint(endpoint: string): boolean {
  const low = endpoint.trim().toLowerCase();
  return low.startsWith("wss://") || low.startsWith("ws://");
}

export function formatServerDisplayName(endpoint: string): string {
  const trimmed = endpoint.trim();
  const low = trimmed.toLowerCase();
  if (low === CLOUD_ENDPOINT.toLowerCase()) {
    return "Epilod Cloud";
  }
  if (low === SYNCPLAY_ENDPOINT.toLowerCase()) {
    return "Syncplay Public";
  }
  if (low === BACKUP_ENDPOINT.toLowerCase()) {
    return "Syncplay Backup (:8998)";
  }
  return trimmed;
}

export interface SyncDisplaySummary {
  activeEndpoint: string;
  isBackupServer: boolean;
  badgeText: string;
  detailText: string | null;
}

/**
 * Fix 04: Derive the displayed server endpoint directly from live backend sync state
 * (rather than saved preference) and warn clearly when switched to backup 8998.
 */
export function describeSyncEndpoint(
  status: SyncStatusPayload,
  configuredEndpoint: string,
): SyncDisplaySummary {
  const activeEndpoint =
    status.state === "disconnected" ? configuredEndpoint : status.endpoint || configuredEndpoint;
  const isBackupServer =
    activeEndpoint.trim().toLowerCase() === BACKUP_ENDPOINT;
  const isCloud = isCloudEndpoint(activeEndpoint);
  const displayLabel = formatServerDisplayName(activeEndpoint);

  if (status.state === "connected") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: isBackupServer ? `${activeEndpoint} (Backup)` : displayLabel,
      detailText: isBackupServer
        ? "Connected to backup server (:8998). Peers must also use the backup server to see this room."
        : null,
    };
  }
  if (status.state === "connecting") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: `Connecting to ${displayLabel}…`,
      detailText: null,
    };
  }
  if (status.state === "reconnecting") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: `Reconnecting (${displayLabel}) in ${status.retryInSecs}s`,
      detailText: status.suggestBackup
        ? isCloud
          ? "Epilod Cloud unreachable or at daily free cap — switch to Syncplay (syncplay.pl:8999) in Settings."
          : "Primary server unreachable — you can try switching everyone in your room to the backup server (:8998)."
        : null,
    };
  }
  if (status.state === "error") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: `Connection failed (${displayLabel})`,
      detailText: status.message,
    };
  }
  return {
    activeEndpoint,
    isBackupServer,
    badgeText: "Disconnected",
    detailText: null,
  };
}
