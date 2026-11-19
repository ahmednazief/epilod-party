import { getFileDisplayName } from "./fileDrop";
import { cleanEpisodeTitle, formatEpisodeBadge, parseEpisodeCode, type PlaylistItem } from "./playlist";

export const SERIES_PROGRESS_MAX = 20;

export interface SeriesProgressEntry {
  seriesKey: string;
  folderPath: string;
  folderName: string;
  lastEpisodeKey: string | null;
  watchedKeys: string[];
  updatedAt: number;
}

export function normalizeFolderPath(folderPath: string): string {
  return folderPath.trim().replace(/[\\/]+$/, "").toLowerCase();
}

export function extractParentFolderPath(filePath: string): string {
  const trimmed = filePath.trim();
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSlash <= 0) return "";
  return trimmed.slice(0, lastSlash);
}

/**
 * Deterministic 32-bit FNV-1a hash of the normalized folder path so seriesKey
 * can be stored in recent rooms without leaking local directory paths.
 */
export function buildSeriesKey(folderPath: string): string {
  const norm = normalizeFolderPath(folderPath);
  if (!norm) return "";
  let hash = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    hash ^= norm.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `series_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildEpisodeKey(
  itemOrFileName: Pick<PlaylistItem, "fileName" | "season" | "episode"> | string,
): string {
  if (typeof itemOrFileName === "string") {
    const base = getFileDisplayName(itemOrFileName).trim();
    const code = parseEpisodeCode(base);
    if (code) {
      return formatEpisodeBadge(code);
    }
    return cleanEpisodeTitle(base).toLowerCase() || base.toLowerCase();
  }
  if (typeof itemOrFileName.episode === "number" && Number.isFinite(itemOrFileName.episode)) {
    return formatEpisodeBadge({
      season: itemOrFileName.season,
      episode: itemOrFileName.episode,
    });
  }
  const base = getFileDisplayName(itemOrFileName.fileName).trim();
  const code = parseEpisodeCode(base);
  if (code) {
    return formatEpisodeBadge(code);
  }
  return cleanEpisodeTitle(base).toLowerCase() || base.toLowerCase();
}

/**
 * Picks the next unwatched episode index after `currentIndex` (or from 0 when `currentIndex < 0`).
 * Returns `null` if there is no unwatched episode after `currentIndex`.
 */
export function pickNextUnwatchedIndex(
  items: readonly PlaylistItem[],
  currentIndex: number,
  watchedKeys: readonly string[],
): number | null {
  if (items.length === 0) return null;
  const watchedSet = new Set(watchedKeys);
  const start = currentIndex < 0 ? 0 : currentIndex + 1;
  for (let i = start; i < items.length; i++) {
    const key = buildEpisodeKey(items[i]);
    if (!watchedSet.has(key)) {
      return i;
    }
  }
  return null;
}

/**
 * Picks the best initial episode index when opening a series folder:
 * first unwatched episode, falling back to `lastEpisodeKey`, or `0`.
 */
export function pickInitialSeriesIndex(
  items: readonly PlaylistItem[],
  entry: Pick<SeriesProgressEntry, "watchedKeys" | "lastEpisodeKey"> | null | undefined,
): number {
  if (items.length === 0) return -1;
  if (!entry) return 0;
  const firstUnwatched = pickNextUnwatchedIndex(items, -1, entry.watchedKeys);
  if (firstUnwatched !== null) {
    return firstUnwatched;
  }
  if (entry.lastEpisodeKey) {
    const lastIdx = items.findIndex((it) => buildEpisodeKey(it) === entry.lastEpisodeKey);
    if (lastIdx !== -1) return lastIdx;
  }
  return 0;
}
