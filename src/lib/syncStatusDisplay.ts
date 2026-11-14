import type { SyncStatusPayload } from "./syncplay";

export const DEFAULT_ENDPOINT = "syncplay.pl:8999";
export const BACKUP_ENDPOINT = "syncplay.pl:8998";

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

  if (status.state === "connected") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: isBackupServer ? `${activeEndpoint} (Backup)` : activeEndpoint,
      detailText: isBackupServer
        ? "Connected to backup server (:8998). Peers must also use the backup server to see this room."
        : null,
    };
  }
  if (status.state === "connecting") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: `Connecting to ${activeEndpoint}…`,
      detailText: null,
    };
  }
  if (status.state === "reconnecting") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: `Reconnecting (${activeEndpoint}) in ${status.retryInSecs}s`,
      detailText: status.suggestBackup
        ? "Primary server unreachable — you can try switching everyone in your room to the backup server (:8998)."
        : null,
    };
  }
  if (status.state === "error") {
    return {
      activeEndpoint,
      isBackupServer,
      badgeText: `Connection failed (${activeEndpoint})`,
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
