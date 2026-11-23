import type { MpvTrack } from "./mpv";
import { loadJson, saveJson, trimLruMap } from "./persist";
import { buildSeriesKey, extractParentFolderPath } from "./seriesProgress";
import { normalizeSubtitleLang } from "./tracks";

const STORAGE_KEY = "seriesTrackPrefs";
const MAX_ENTRIES = 60;

export interface SeriesTrackPref {
  audioLang?: string | null;
  subLang?: string | null; // normalized lang code (e.g. "ara", "eng") or "off"
  secondarySubLang?: string | null;
  updatedAt: number;
}

/**
 * Derives a deterministic, path-free series key from the parent folder of `filePath`.
 */
export function deriveSeriesKeyForFile(filePath: string | null | undefined): string {
  if (!filePath) return "";
  return buildSeriesKey(extractParentFolderPath(filePath));
}

export function getSeriesTrackPref(seriesKey: string | null): SeriesTrackPref | null {
  if (!seriesKey) return null;
  const map = loadJson<Record<string, SeriesTrackPref>>(STORAGE_KEY, {});
  return map[seriesKey] ?? null;
}

export function saveSeriesTrackPref(
  seriesKey: string | null,
  patch: Partial<Omit<SeriesTrackPref, "updatedAt">>,
): void {
  if (!seriesKey) return;
  const map = loadJson<Record<string, SeriesTrackPref>>(STORAGE_KEY, {});
  const existing = map[seriesKey];
  const nextEntry: SeriesTrackPref = {
    audioLang: patch.audioLang !== undefined ? patch.audioLang : existing?.audioLang,
    subLang: patch.subLang !== undefined ? patch.subLang : existing?.subLang,
    secondarySubLang:
      patch.secondarySubLang !== undefined ? patch.secondarySubLang : existing?.secondarySubLang,
    updatedAt: Date.now(),
  };
  const next = trimLruMap({ ...map, [seriesKey]: nextEntry }, MAX_ENTRIES);
  saveJson(STORAGE_KEY, next);
}

/**
 * Picks the best matching audio track for a normalized language code, preferring default tracks.
 */
export function pickMatchingAudioTrack(
  tracks: readonly MpvTrack[],
  wantLang: string,
): MpvTrack | null {
  const normWant = normalizeSubtitleLang(wantLang);
  if (!normWant) return null;
  const matches = tracks.filter(
    (t) => t.type === "audio" && normalizeSubtitleLang(t.lang) === normWant,
  );
  if (matches.length === 0) return null;
  return matches.find((t) => t.default) ?? matches[0];
}

/**
 * Picks the best matching subtitle track for a normalized language code, checking tagged language
 * (ignoring undetermined tags) and falling back to FFmpeg-detected language.
 */
export function pickMatchingSubTrack(
  tracks: readonly MpvTrack[],
  wantLang: string,
  detectedLangs?: Record<number, string>,
  excludeTrackId?: number | null,
): MpvTrack | null {
  const normWant = normalizeSubtitleLang(wantLang);
  if (!normWant) return null;
  const matches = tracks.filter((t) => {
    if (t.type !== "sub") return false;
    if (excludeTrackId !== undefined && excludeTrackId !== null && t.id === excludeTrackId) {
      return false;
    }
    const resolved =
      normalizeSubtitleLang(t.lang) ?? normalizeSubtitleLang(detectedLangs?.[t.id]);
    return resolved === normWant;
  });
  if (matches.length === 0) return null;
  return (
    matches.find((t) => !t.forced && t.default) ??
    matches.find((t) => !t.forced) ??
    matches.find((t) => t.default) ??
    matches[0]
  );
}
