import { getFileDisplayName } from "./fileDrop";
import { formatDisplayMediaTitle, formatSeasonFolderTitle } from "./playlist";
import type { ResumeEntry } from "./resume";
import {
  extractParentFolderPath,
  normalizeFolderPath,
  type SeriesProgressEntry,
} from "./seriesProgress";
import type { RecentRoomEntry } from "../store/useRecentRoomsStore";

export interface ContinueWatchingItem {
  kind: "series" | "movie";
  id: string;
  title: string;
  badgeText: string | null;
  progressRatio: number | null;
  timeLeftLabel: string | null;
  updatedAt: number;
  seriesEntry?: SeriesProgressEntry;
  /** Other season keys belonging to the same show (collapsed into this entry). */
  relatedSeriesKeys?: string[];
  resumeKey?: string;
  resumeEntry?: ResumeEntry;
  linkedRoom?: RecentRoomEntry;
}

export function formatTimeLeftShort(positionSecs: number, durationSecs: number): string | null {
  if (!Number.isFinite(positionSecs) || !Number.isFinite(durationSecs) || durationSecs <= 0) {
    return null;
  }
  const rem = Math.max(0, Math.round(durationSecs - positionSecs));
  if (rem < 60) {
    return `${rem}s left`;
  }
  const mins = Math.round(rem / 60);
  if (mins < 60) {
    return `${mins}m left`;
  }
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m left` : `${hrs}h left`;
}

function formatSeriesContinueTitle(entry: SeriesProgressEntry): string {
  const formatted = formatSeasonFolderTitle(entry.folderName);
  if (/^Season\s+\d+$/i.test(formatted) || formatted === "Season Queue") {
    const parentPath = extractParentFolderPath(entry.folderPath);
    const parentName = parentPath ? getFileDisplayName(parentPath) : "";
    const parentFormatted = parentName ? formatSeasonFolderTitle(parentName) : "";
    if (
      parentFormatted &&
      parentFormatted !== "Season Queue" &&
      !/^Season\s+\d+$/i.test(parentFormatted)
    ) {
      return formatted === "Season Queue" ? parentFormatted : `${parentFormatted} · ${formatted}`;
    }
  }
  return formatted || entry.folderName;
}

function findMatchingResumeForSeries(
  series: SeriesProgressEntry,
  resumeEntries: Record<string, ResumeEntry>,
): { key: string; entry: ResumeEntry } | null {
  const normSeriesFolder = normalizeFolderPath(series.folderPath);
  if (!normSeriesFolder) return null;

  let best: { key: string; entry: ResumeEntry } | null = null;
  for (const [key, entry] of Object.entries(resumeEntries)) {
    if (!entry.filePath) continue;
    const parentNorm = normalizeFolderPath(extractParentFolderPath(entry.filePath));
    if (parentNorm !== normSeriesFolder) continue;
    if (!best || entry.updatedAt > best.entry.updatedAt) {
      best = { key, entry };
    }
  }
  return best;
}

function deriveShowGroupKey(entry: SeriesProgressEntry): string {
  const formatted = formatSeasonFolderTitle(entry.folderName);
  const parentPath = extractParentFolderPath(entry.folderPath);
  const normParent = parentPath ? normalizeFolderPath(parentPath) : "";

  // Case 1: Nested season folder (e.g. ".../X-Files/Season 1" and ".../X-Files/Season 2")
  if (
    normParent &&
    (/^Season\s+\d+$/i.test(formatted) ||
      /^(?:season|s|cour|part|series)\s*0*\d+$/i.test(entry.folderName.trim()))
  ) {
    return `show-parent:${normParent}`;
  }

  // Case 2: Flat sibling season folders (e.g. ".../Series/X-Files Season 1" & ".../Series/X-Files Season 2")
  const strippedShow = formatted
    .replace(/[\s·._-]+(?:season|s|cour|part)\s*0*\d+$/i, "")
    .trim()
    .toLowerCase();
  if (strippedShow && strippedShow !== formatted.trim().toLowerCase()) {
    return `show-name:${normParent}::${strippedShow}`;
  }

  return `series:${entry.seriesKey}`;
}

export function buildContinueWatchingItems(
  seriesMap: Record<string, SeriesProgressEntry>,
  resumeEntries: Record<string, ResumeEntry>,
  recentRooms: readonly RecentRoomEntry[],
  maxItems = 4,
): ContinueWatchingItem[] {
  const items: ContinueWatchingItem[] = [];
  const coveredFolders = new Set<string>();
  const seriesByShowGroup = new Map<string, ContinueWatchingItem>();

  for (const entry of Object.values(seriesMap)) {
    const normFolder = normalizeFolderPath(entry.folderPath);
    if (normFolder) coveredFolders.add(normFolder);

    const linkedRoom = recentRooms.find((r) => r.seriesKey === entry.seriesKey);
    const activeResume = findMatchingResumeForSeries(entry, resumeEntries);
    const hasResume =
      activeResume &&
      activeResume.entry.durationSecs > 0 &&
      activeResume.entry.positionSecs > 0;

    const progressRatio = hasResume
      ? Math.max(0.02, Math.min(0.98, activeResume.entry.positionSecs / activeResume.entry.durationSecs))
      : null;
    const timeLeftLabel = hasResume
      ? formatTimeLeftShort(activeResume.entry.positionSecs, activeResume.entry.durationSecs)
      : null;

    const lastEp = entry.lastEpisodeKey;
    const lastAlreadyWatched = Boolean(lastEp && entry.watchedKeys.includes(lastEp));
    const badgeText = hasResume
      ? lastEp
        ? `Resume ${lastEp}`
        : "Resume"
      : lastEp
        ? lastAlreadyWatched
          ? `After ${lastEp}`
          : lastEp
        : null;

    const candidate: ContinueWatchingItem = {
      kind: "series",
      id: `series:${entry.seriesKey}`,
      title: formatSeriesContinueTitle(entry),
      badgeText,
      progressRatio,
      timeLeftLabel,
      updatedAt: Math.max(entry.updatedAt, activeResume?.entry.updatedAt ?? 0),
      seriesEntry: entry,
      relatedSeriesKeys: [entry.seriesKey],
      linkedRoom,
    };

    const groupKey = deriveShowGroupKey(entry);
    const existing = seriesByShowGroup.get(groupKey);
    if (!existing) {
      seriesByShowGroup.set(groupKey, candidate);
    } else if (candidate.updatedAt > existing.updatedAt) {
      candidate.relatedSeriesKeys = [
        ...(existing.relatedSeriesKeys ?? []),
        entry.seriesKey,
      ];
      seriesByShowGroup.set(groupKey, candidate);
    } else {
      existing.relatedSeriesKeys = [
        ...(existing.relatedSeriesKeys ?? []),
        entry.seriesKey,
      ];
    }
  }

  for (const groupedItem of seriesByShowGroup.values()) {
    items.push(groupedItem);
  }

  for (const [resumeKey, entry] of Object.entries(resumeEntries)) {
    if (!entry.filePath || !entry.fileName || entry.durationSecs <= 0) continue;
    const parentNorm = normalizeFolderPath(extractParentFolderPath(entry.filePath));
    if (parentNorm && coveredFolders.has(parentNorm)) {
      continue;
    }

    const display = formatDisplayMediaTitle(getFileDisplayName(entry.fileName));
    const title = display.title || getFileDisplayName(entry.fileName);
    const linkedRoom = entry.linkedRoomId
      ? recentRooms.find((r) => r.id === entry.linkedRoomId)
      : undefined;
    const progressRatio = Math.max(0.02, Math.min(0.98, entry.positionSecs / entry.durationSecs));
    const timeLeftLabel = formatTimeLeftShort(entry.positionSecs, entry.durationSecs);

    items.push({
      kind: "movie",
      id: `movie:${resumeKey}`,
      title,
      badgeText: "Movie",
      progressRatio,
      timeLeftLabel,
      updatedAt: entry.updatedAt,
      resumeKey,
      resumeEntry: entry,
      linkedRoom,
    });
  }

  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxItems);
}
