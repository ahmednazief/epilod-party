import { getFileDisplayName } from "./fileDrop";
import { loadJson, saveJson, trimLruMap } from "./persist";

const STORAGE_KEY = "subtitlePrefs";
const MAX_ENTRIES = 200;

export interface PerFileSubtitlePref {
  delaySecs: number;
  trackLang?: string | null;
  subtitleFile?: string | null;
  secondaryTrackLang?: string | null;
  secondaryDelaySecs?: number;
  updatedAt: number;
}

export function getPerFileSubtitlePref(fileKey: string | null): PerFileSubtitlePref | null {
  if (!fileKey) return null;
  const map = loadJson<Record<string, PerFileSubtitlePref>>(STORAGE_KEY, {});
  return map[fileKey] ?? null;
}

export function savePerFileSubtitlePref(
  fileKey: string | null,
  patch: Partial<Omit<PerFileSubtitlePref, "updatedAt">>,
): void {
  if (!fileKey) return;
  const map = loadJson<Record<string, PerFileSubtitlePref>>(STORAGE_KEY, {});
  const existing = map[fileKey];
  const nextEntry: PerFileSubtitlePref = {
    delaySecs: patch.delaySecs ?? existing?.delaySecs ?? 0,
    trackLang: patch.trackLang !== undefined ? patch.trackLang : existing?.trackLang,
    subtitleFile:
      patch.subtitleFile !== undefined
        ? patch.subtitleFile
          ? getFileDisplayName(patch.subtitleFile)
          : null
        : existing?.subtitleFile,
    secondaryTrackLang:
      patch.secondaryTrackLang !== undefined
        ? patch.secondaryTrackLang
        : existing?.secondaryTrackLang,
    secondaryDelaySecs:
      patch.secondaryDelaySecs !== undefined
        ? patch.secondaryDelaySecs
        : existing?.secondaryDelaySecs,
    updatedAt: Date.now(),
  };
  const next = trimLruMap({ ...map, [fileKey]: nextEntry }, MAX_ENTRIES);
  saveJson(STORAGE_KEY, next);
}

export function clearPerFileSubtitlePref(fileKey: string | null): void {
  if (!fileKey) return;
  const map = loadJson<Record<string, PerFileSubtitlePref>>(STORAGE_KEY, {});
  if (!map[fileKey]) return;
  const next = { ...map };
  delete next[fileKey];
  saveJson(STORAGE_KEY, next);
}
