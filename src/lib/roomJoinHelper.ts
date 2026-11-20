import { consumePendingDeepLink, onDeepLinkInvite, type DeepLinkInvite } from "./inviteLinks";
import { dpapiUnprotectSecret } from "./localLibrary";
import { mpvStop } from "./mpv";
import { scanMediaPaths } from "./playlist";
import { pickInitialSeriesIndex, type SeriesProgressEntry } from "./seriesProgress";
import { syncDisconnect } from "./syncplay";
import {
  BACKUP_ENDPOINT,
  CLOUD_ENDPOINT,
  DEFAULT_ENDPOINT,
  formatServerDisplayName,
  SYNCPLAY_ENDPOINT,
} from "./syncStatusDisplay";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import {
  buildRecentRoomId,
  normalizeRecentServerHost,
  useRecentRoomsStore,
  type RecentRoomEntry,
} from "../store/useRecentRoomsStore";
import { useSeriesProgressStore } from "../store/useSeriesProgressStore";

export async function loadMediaForRecentRoom(
  room: RecentRoomEntry,
  seriesMap: Record<string, SeriesProgressEntry> = useSeriesProgressStore.getState().series,
): Promise<boolean> {
  const { setSelectedFile } = useAppStore.getState();
  const linkedSeries = room.seriesKey ? seriesMap[room.seriesKey] : undefined;
  if (linkedSeries?.folderPath) {
    try {
      const scan = await scanMediaPaths([linkedSeries.folderPath]);
      if (scan.items.length > 0) {
        const idx = pickInitialSeriesIndex(scan.items, linkedSeries);
        usePlaylistStore
          .getState()
          .setPlaylist(scan.items, idx, scan.folderName || linkedSeries.folderName);
        const target = scan.items[idx];
        setSelectedFile(target.path, target.fileName);
        return true;
      }
    } catch {
      // Folder may have been moved; fall back to lastFilePath
    }
  }
  if (room.lastFilePath) {
    try {
      const scan = await scanMediaPaths([room.lastFilePath]);
      if (scan.items.length > 0) {
        const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
        usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
        const target = scan.items[idx];
        setSelectedFile(target.path, target.fileName);
        return true;
      }
    } catch {
      // File may have been moved or removed; still enter the room cleanly
    }
  }
  return false;
}

export async function resolveSavedRoomPassword(room: RecentRoomEntry): Promise<string | null> {
  if (!room.encryptedPassword) return null;
  try {
    const plain = await dpapiUnprotectSecret(room.encryptedPassword);
    return plain || null;
  } catch {
    return null;
  }
}

export async function applyDeepLinkInvite(
  invite: DeepLinkInvite,
  options?: { requireConfirm?: boolean },
): Promise<void> {
  const app = useAppStore.getState();
  const targetEndpoint = invite.serverHost || DEFAULT_ENDPOINT;
  const targetId = buildRecentRoomId(invite.roomName, targetEndpoint, invite.literalRoom);
  const currentId =
    app.screen === "room" && app.roomCode
      ? buildRecentRoomId(app.roomCode, app.serverEndpoint, app.literalRoom)
      : null;

  if (currentId && currentId === targetId) {
    useNotificationStore.getState().push("info", "Already in this Watch Party room.");
    return;
  }

  const officialHosts = [
    DEFAULT_ENDPOINT,
    CLOUD_ENDPOINT,
    SYNCPLAY_ENDPOINT,
    BACKUP_ENDPOINT,
  ].map((h) => h.toLowerCase());
  const isCustomHost = Boolean(
    invite.serverHost && !officialHosts.includes(invite.serverHost.toLowerCase()),
  );
  if ((options?.requireConfirm || isCustomHost) && typeof window !== "undefined" && typeof window.confirm === "function") {
    const serverLabel = formatServerDisplayName(targetEndpoint);
    const hostNotice = isCustomHost
      ? `\n\nWarning: This invite points to a custom server (${serverLabel}). Only join servers you trust.`
      : `\nServer: ${serverLabel}`;
    const leaveNotice =
      app.screen === "room" ? "\nYou will leave your current Watch Party room." : "";
    const ok = window.confirm(
      `Join Watch Party room "${invite.roomName}"?${hostNotice}${leaveNotice}`,
    );
    if (!ok) {
      return;
    }
  }

  if (app.screen === "room") {
    await syncDisconnect().catch(() => undefined);
    app.leaveRoom();
    await mpvStop().catch(() => undefined);
    // Let WatchRoom cleanly unmount before mounting the new room session.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  const recent = useRecentRoomsStore.getState().rooms.find((r) => r.id === targetId);
  const hostOnly = Boolean(recent?.hostOnly);
  useAppStore.getState().setServerEndpoint(normalizeRecentServerHost(targetEndpoint));

  if (recent?.hasPassword) {
    const savedPass = await resolveSavedRoomPassword(recent);
    if (savedPass) {
      useAppStore.getState().setServerPassword(savedPass);
    } else {
      useAppStore.getState().setServerPassword("");
      useAppStore.getState().setPendingDeepLinkPasswordRoomId(recent.id);
      useNotificationStore
        .getState()
        .push("info", "Enter the room password to join this Watch Party.");
      return;
    }
  } else {
    useAppStore.getState().setServerPassword("");
  }

  if (recent) {
    const loaded = await loadMediaForRecentRoom(recent);
    if (!loaded) {
      usePlaylistStore.getState().clearPlaylist();
      useAppStore.getState().setSelectedFile(null, null);
    }
  }

  useAppStore
    .getState()
    .enterRoom(invite.roomName, invite.literalRoom, hostOnly, false);
}

let lastAppliedInviteUri = "";
let lastAppliedInviteAt = 0;

export function subscribeAppDeepLinks(): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;

  const dispatchInviteOnce = async (invite: DeepLinkInvite) => {
    const now = Date.now();
    if (invite.uri === lastAppliedInviteUri && now - lastAppliedInviteAt < 1500) {
      return;
    }
    lastAppliedInviteUri = invite.uri;
    lastAppliedInviteAt = now;
    await consumePendingDeepLink().catch(() => null);
    await applyDeepLinkInvite(invite, { requireConfirm: true });
  };

  void (async () => {
    try {
      const fn = await onDeepLinkInvite((invite) => {
        if (active) {
          void dispatchInviteOnce(invite);
        }
      });
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;

      const initial = await consumePendingDeepLink();
      if (active && initial) {
        await dispatchInviteOnce(initial);
      }
    } catch {
      // Ignore outside Tauri runtime
    }
  })();

  return () => {
    active = false;
    unlisten?.();
  };
}
