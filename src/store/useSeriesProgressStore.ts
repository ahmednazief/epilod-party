import { create } from "zustand";
import { loadJson, saveJson, trimLruMap } from "../lib/persist";
import {
  buildSeriesKey,
  SERIES_PROGRESS_MAX,
  type SeriesProgressEntry,
} from "../lib/seriesProgress";

const STORAGE_KEY = "seriesProgress";

interface SeriesProgressState {
  series: Record<string, SeriesProgressEntry>;
  upsertSeries: (input: {
    folderPath: string;
    folderName: string;
    lastEpisodeKey?: string | null;
  }) => string | null;
  markWatched: (seriesKey: string, episodeKey: string, watched: boolean) => void;
  markAllAboveWatched: (seriesKey: string, episodeKeys: readonly string[]) => void;
  relocateSeriesFolder: (seriesKey: string, newFolderPath: string, newFolderName?: string) => string | null;
  getSeries: (seriesKey: string) => SeriesProgressEntry | null;
  removeSeries: (seriesKey: string) => void;
  clearAll: () => void;
}

function sanitizeLoadedSeriesMap(raw: unknown): Record<string, SeriesProgressEntry> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, SeriesProgressEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rec = value as Partial<SeriesProgressEntry>;
    if (typeof rec.folderPath !== "string" || !rec.folderPath.trim()) continue;
    const seriesKey = typeof rec.seriesKey === "string" && rec.seriesKey.trim() ? rec.seriesKey : key;
    if (!seriesKey) continue;
    out[seriesKey] = {
      seriesKey,
      folderPath: rec.folderPath.trim(),
      folderName:
        typeof rec.folderName === "string" && rec.folderName.trim()
          ? rec.folderName.trim()
          : "Series",
      lastEpisodeKey: typeof rec.lastEpisodeKey === "string" ? rec.lastEpisodeKey : null,
      watchedKeys: Array.isArray(rec.watchedKeys)
        ? rec.watchedKeys.filter((k): k is string => typeof k === "string" && Boolean(k))
        : [],
      updatedAt:
        typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
    };
  }
  return trimLruMap(out, SERIES_PROGRESS_MAX);
}

export const useSeriesProgressStore = create<SeriesProgressState>((set, get) => ({
  series: sanitizeLoadedSeriesMap(loadJson<unknown>(STORAGE_KEY, {})),

  upsertSeries: ({ folderPath, folderName, lastEpisodeKey }) => {
    const seriesKey = buildSeriesKey(folderPath);
    if (!seriesKey) return null;
    const existing = get().series[seriesKey];
    const nextEntry: SeriesProgressEntry = {
      seriesKey,
      folderPath: folderPath.trim(),
      folderName: folderName.trim() || existing?.folderName || "Series",
      lastEpisodeKey:
        lastEpisodeKey !== undefined ? lastEpisodeKey : (existing?.lastEpisodeKey ?? null),
      watchedKeys: existing?.watchedKeys ?? [],
      updatedAt: Date.now(),
    };
    const next = trimLruMap(
      {
        ...get().series,
        [seriesKey]: nextEntry,
      },
      SERIES_PROGRESS_MAX,
    );
    saveJson(STORAGE_KEY, next);
    set({ series: next });
    return seriesKey;
  },

  markWatched: (seriesKey, episodeKey, watched) => {
    const existing = get().series[seriesKey];
    if (!existing || !episodeKey) return;
    const currentSet = new Set(existing.watchedKeys);
    if (watched) {
      currentSet.add(episodeKey);
    } else {
      currentSet.delete(episodeKey);
    }
    const next = {
      ...get().series,
      [seriesKey]: {
        ...existing,
        watchedKeys: Array.from(currentSet),
        updatedAt: Date.now(),
      },
    };
    saveJson(STORAGE_KEY, next);
    set({ series: next });
  },

  markAllAboveWatched: (seriesKey, episodeKeys) => {
    const existing = get().series[seriesKey];
    if (!existing || episodeKeys.length === 0) return;
    const currentSet = new Set(existing.watchedKeys);
    for (const k of episodeKeys) {
      if (k) currentSet.add(k);
    }
    const next = {
      ...get().series,
      [seriesKey]: {
        ...existing,
        watchedKeys: Array.from(currentSet),
        updatedAt: Date.now(),
      },
    };
    saveJson(STORAGE_KEY, next);
    set({ series: next });
  },

  relocateSeriesFolder: (seriesKey, newFolderPath, newFolderName) => {
    const existing = get().series[seriesKey];
    if (!existing) return null;
    const newKey = buildSeriesKey(newFolderPath);
    if (!newKey) return null;
    const nextMap = { ...get().series };
    delete nextMap[seriesKey];
    nextMap[newKey] = {
      ...existing,
      seriesKey: newKey,
      folderPath: newFolderPath.trim(),
      folderName: newFolderName?.trim() || existing.folderName,
      updatedAt: Date.now(),
    };
    const trimmed = trimLruMap(nextMap, SERIES_PROGRESS_MAX);
    saveJson(STORAGE_KEY, trimmed);
    set({ series: trimmed });
    return newKey;
  },

  getSeries: (seriesKey) => {
    if (!seriesKey) return null;
    return get().series[seriesKey] ?? null;
  },

  removeSeries: (seriesKey) => {
    if (!get().series[seriesKey]) return;
    const next = { ...get().series };
    delete next[seriesKey];
    saveJson(STORAGE_KEY, next);
    set({ series: next });
  },

  clearAll: () => {
    saveJson(STORAGE_KEY, {});
    set({ series: {} });
  },
}));
