import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persist";
import {
  sanitizeCustomServerEndpoint,
  validateServerEndpointInput,
} from "../lib/webviewHardening";

export const RECENT_ROOMS_MAX = 10;
export const PINNED_ROOMS_MAX = 20;
export const RECENT_UNPINNED_FLOOR = 5;
const STORAGE_KEY = "recentRooms";

export interface RecentRoomEntry {
  id: string;
  roomName: string;
  serverHost: string;
  literalRoom: boolean;
  hasPassword: boolean;
  hostOnly?: boolean;
  nickname?: string;
  seriesKey?: string;
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
  const unpinned = sorted.filter((r) => !r.pinned);
  const unpinnedLimit =
    pinned.length < RECENT_ROOMS_MAX
      ? RECENT_ROOMS_MAX - pinned.length
      : RECENT_UNPINNED_FLOOR;
  return [...pinned, ...unpinned.slice(0, unpinnedLimit)];
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

    const normalized: RecentRoomEntry = {
      id,
      roomName: cleanRoom,
      serverHost: cleanHost,
      literalRoom,
      hasPassword: Boolean(rec.hasPassword),
      hostOnly: rec.hostOnly ? true : undefined,
      nickname,
      seriesKey,
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
        nickname: normalized.nickname ?? existing.nickname,
        seriesKey: normalized.seriesKey ?? existing.seriesKey,
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
  }) => void;
  togglePin: (id: string) => void;
  setNickname: (id: string, nickname: string) => void;
  setSeriesKey: (id: string, seriesKey: string) => void;
  clearSeriesLinks: () => void;
  removeRoom: (id: string) => void;
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
        hostOnly: hostOnly ?? existing?.hostOnly,
        nickname: nickname?.trim().slice(0, 40) || existing?.nickname,
        seriesKey: seriesKey || existing?.seriesKey,
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

    clearSeriesLinks: () => {
      if (!get().rooms.some((r) => r.seriesKey)) return;
      commit(get().rooms.map((r) => (r.seriesKey ? { ...r, seriesKey: undefined } : r)));
    },

    removeRoom: (id) => {
      commit(get().rooms.filter((r) => r.id !== id));
    },

    clearAll: () => {
      commit([]);
    },
  };
});
