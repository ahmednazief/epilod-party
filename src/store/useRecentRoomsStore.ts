import { create } from "zustand";
import { getFileDisplayName } from "../lib/fileDrop";
import { loadJson, saveJson } from "../lib/persist";
import {
  formatDisplayMediaTitle,
  formatEpisodeBadge,
  formatSeasonFolderTitle,
  parseEpisodeCode,
} from "../lib/playlist";
import type { SeriesProgressEntry } from "../lib/seriesProgress";
import {
  sanitizeCustomServerEndpoint,
  validateServerEndpointInput,
} from "../lib/webviewHardening";

export const RECENT_ROOMS_MAX = 3;
export const PINNED_ROOMS_MAX = 20;
const STORAGE_KEY = "recentRooms";

export interface RecentRoomEntry {
  id: string;
  roomName: string;
  serverHost: string;
  literalRoom: boolean;
  hasPassword: boolean;
  encryptedPassword?: string;
  hostOnly?: boolean;
  nickname?: string;
  seriesKey?: string;
  lastFilePath?: string;
  lastJoinedAt: number;
  pinned: boolean;
}

export function normalizeRecentServerHost(serverHost: string): string {
  const validated = validateServerEndpointInput(serverHost);
  if (validated.ok && validated.endpoint) {
    return validated.endpoint;
  }
  return sanitizeCustomServerEndpoint(serverHost) || serverHost.trim();
}

export function getRecentRoomMediaLabel(
  room: Pick<RecentRoomEntry, "seriesKey" | "lastFilePath">,
  seriesMap: Record<string, SeriesProgressEntry>,
  activeMediaHint?: string | null,
): string | null {
  const seriesEntry = room.seriesKey ? seriesMap[room.seriesKey] : undefined;
  if (seriesEntry?.folderName) {
    return formatSeasonFolderTitle(seriesEntry.folderName);
  }

  const rawSource = room.lastFilePath || activeMediaHint || "";
  if (!rawSource.trim()) return null;

  const fileName = getFileDisplayName(rawSource);
  const display = formatDisplayMediaTitle(fileName);
  if (display.subtitle) {
    const epCode = parseEpisodeCode(fileName);
    return epCode ? `${display.subtitle} · ${formatEpisodeBadge(epCode)}` : display.subtitle;
  }

  return display.title || fileName || null;
}

export function buildRecentRoomId(
  roomName: string,
  serverHost: string,
  literalRoom: boolean,
): string {
  const normalizedHost = normalizeRecentServerHost(serverHost).toLowerCase();
  return `${normalizedHost}::${roomName.trim().toLowerCase()}::${literalRoom ? "1" : "0"}`;
}

export function sortRecentRooms(rooms: readonly RecentRoomEntry[]): RecentRoomEntry[] {
  return [...rooms].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return b.lastJoinedAt - a.lastJoinedAt;
  });
}

function trimRecentRooms(rooms: readonly RecentRoomEntry[]): RecentRoomEntry[] {
  const sorted = sortRecentRooms(rooms);
  const pinned = sorted.filter((r) => r.pinned).slice(0, PINNED_ROOMS_MAX);
  const unpinned = sorted.filter((r) => !r.pinned).slice(0, RECENT_ROOMS_MAX);
  return [...pinned, ...unpinned];
}

function sanitizeLoadedRecentRooms(raw: unknown): RecentRoomEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byId = new Map<string, RecentRoomEntry>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<RecentRoomEntry>;
    if (typeof rec.roomName !== "string" || typeof rec.serverHost !== "string") continue;
    const cleanRoom = rec.roomName.trim();
    const cleanHost = normalizeRecentServerHost(rec.serverHost);
    if (!cleanRoom || !cleanHost) continue;

    const literalRoom = Boolean(rec.literalRoom);
    const id = buildRecentRoomId(cleanRoom, cleanHost, literalRoom);
    const lastJoinedAt =
      typeof rec.lastJoinedAt === "number" && Number.isFinite(rec.lastJoinedAt)
        ? rec.lastJoinedAt
        : 0;
    const pinned = Boolean(rec.pinned);
    const nickname =
      typeof rec.nickname === "string" && rec.nickname.trim()
        ? rec.nickname.trim().slice(0, 40)
        : undefined;
    const seriesKey =
      typeof rec.seriesKey === "string" && rec.seriesKey.trim()
        ? rec.seriesKey.trim()
        : undefined;
    const lastFilePath =
      typeof rec.lastFilePath === "string" && rec.lastFilePath.trim()
        ? rec.lastFilePath.trim()
        : undefined;
    const encryptedPassword =
      typeof rec.encryptedPassword === "string" && rec.encryptedPassword.trim()
        ? rec.encryptedPassword.trim()
        : undefined;

    const normalized: RecentRoomEntry = {
      id,
      roomName: cleanRoom,
      serverHost: cleanHost,
      literalRoom,
      hasPassword: Boolean(rec.hasPassword),
      encryptedPassword,
      hostOnly: rec.hostOnly ? true : undefined,
      nickname,
      seriesKey,
      lastFilePath,
      lastJoinedAt,
      pinned,
    };

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, normalized);
    } else {
      byId.set(id, {
        ...normalized,
        pinned: existing.pinned || normalized.pinned,
        encryptedPassword: normalized.encryptedPassword ?? existing.encryptedPassword,
        nickname: normalized.nickname ?? existing.nickname,
        seriesKey: normalized.seriesKey ?? existing.seriesKey,
        lastFilePath: normalized.lastFilePath ?? existing.lastFilePath,
        lastJoinedAt: Math.max(existing.lastJoinedAt, normalized.lastJoinedAt),
      });
    }
  }
  return trimRecentRooms(Array.from(byId.values()));
}

interface RecentRoomsState {
  rooms: RecentRoomEntry[];
  storageError: boolean;
  recordJoin: (input: {
    roomName: string;
    serverHost: string;
    literalRoom: boolean;
    hasPassword: boolean;
    hostOnly?: boolean;
    nickname?: string;
    seriesKey?: string;
    lastFilePath?: string;
  }) => void;
  togglePin: (id: string) => void;
  setNickname: (id: string, nickname: string) => void;
  setSeriesKey: (id: string, seriesKey: string) => void;
  setLastFilePath: (id: string, filePath: string) => void;
  setEncryptedPassword: (id: string, encryptedPassword: string | undefined) => void;
  clearSeriesLinks: () => void;
  removeRoom: (id: string) => void;
  hydrateRooms: (rooms: RecentRoomEntry[]) => void;
  clearAll: () => void;
}

export const useRecentRoomsStore = create<RecentRoomsState>((set, get) => {
  const commit = (next: RecentRoomEntry[]) => {
    const saved = saveJson(STORAGE_KEY, next);
    set({ rooms: next, storageError: !saved });
  };

  return {
    rooms: sanitizeLoadedRecentRooms(loadJson<unknown>(STORAGE_KEY, [])),
    storageError: false,

    recordJoin: ({
      roomName,
      serverHost,
      literalRoom,
      hasPassword,
      hostOnly,
      nickname,
      seriesKey,
      lastFilePath,
    }) => {
      const cleanRoom = roomName.trim();
      const cleanHost = normalizeRecentServerHost(serverHost);
      if (!cleanRoom || !cleanHost) return;

      const id = buildRecentRoomId(cleanRoom, cleanHost, literalRoom);
      const existing = get().rooms.find((r) => r.id === id);
      const entry: RecentRoomEntry = {
        id,
        roomName: cleanRoom,
        serverHost: cleanHost,
        literalRoom,
        hasPassword,
        encryptedPassword: hasPassword ? existing?.encryptedPassword : undefined,
        hostOnly: hostOnly ?? existing?.hostOnly,
        nickname: nickname?.trim().slice(0, 40) || existing?.nickname,
        seriesKey: seriesKey || existing?.seriesKey,
        lastFilePath: lastFilePath?.trim() || existing?.lastFilePath,
        lastJoinedAt: Date.now(),
        pinned: existing?.pinned ?? false,
      };
      commit(trimRecentRooms([entry, ...get().rooms.filter((r) => r.id !== id)]));
    },

    togglePin: (id) => {
      commit(
        sortRecentRooms(
          get().rooms.map((r) => (r.id === id ? { ...r, pinned: !r.pinned } : r)),
        ),
      );
    },

    setNickname: (id, nickname) => {
      const trimmed = nickname.trim().slice(0, 40);
      commit(
        get().rooms.map((r) => (r.id === id ? { ...r, nickname: trimmed || undefined } : r)),
      );
    },

    setSeriesKey: (id, seriesKey) => {
      const cleanKey = seriesKey.trim();
      commit(
        get().rooms.map((r) => (r.id === id ? { ...r, seriesKey: cleanKey || undefined } : r)),
      );
    },

    setLastFilePath: (id, filePath) => {
      const cleanPath = filePath.trim();
      if (!cleanPath) return;
      const existing = get().rooms.find((r) => r.id === id);
      if (!existing || existing.lastFilePath === cleanPath) return;
      commit(
        get().rooms.map((r) => (r.id === id ? { ...r, lastFilePath: cleanPath } : r)),
      );
    },

    setEncryptedPassword: (id, encryptedPassword) => {
      const clean = encryptedPassword?.trim() || undefined;
      commit(
        get().rooms.map((r) =>
          r.id === id
            ? {
                ...r,
                encryptedPassword: clean,
                hasPassword: clean ? true : r.hasPassword,
              }
            : r,
        ),
      );
    },

    clearSeriesLinks: () => {
      if (!get().rooms.some((r) => r.seriesKey)) return;
      commit(get().rooms.map((r) => (r.seriesKey ? { ...r, seriesKey: undefined } : r)));
    },

    removeRoom: (id) => {
      commit(get().rooms.filter((r) => r.id !== id));
    },

    hydrateRooms: (rooms) => {
      commit(trimRecentRooms(rooms));
    },

    clearAll: () => {
      commit([]);
    },
  };
});
