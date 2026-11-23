import { loadJson, saveJson, trimLruMap } from "./persist";
import { formatDisplayMediaTitle, formatSeasonFolderTitle } from "./playlist";

export interface ShowOfficialRatings {
  showKey: string;
  showTitle: string;
  source: "tvmaze" | "cinemeta";
  showRating: number | null;
  /** Keyed by canonical badge like "S02E04" */
  episodes: Record<string, number>;
  updatedAt: number;
}

const CACHE_KEY = "officialRatingsV2";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_SHOWS = 80;

const inFlightRequests = new Map<string, Promise<ShowOfficialRatings | null>>();

function loadCache(): Record<string, ShowOfficialRatings> {
  const raw = loadJson<unknown>(CACHE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, ShowOfficialRatings>;
}

function saveCache(map: Record<string, ShowOfficialRatings>): void {
  saveJson(CACHE_KEY, trimLruMap(map, CACHE_MAX_SHOWS));
}

export function normalizeShowQuery(raw: string): string {
  return raw
    .replace(/\s*·\s*Season\s*\d+$/i, "")
    .replace(/\b(?:s|season)\s*\d+\b/gi, "")
    .replace(/\s*[\[(](?:19|20)\d{2}[\])]\s*$/g, "")
    .replace(/[\s\-–—]+$/g, "")
    .trim();
}

export function buildEpisodeBadgeKey(season: number | null | undefined, episode: number | null | undefined): string | null {
  if (!season || !episode || season <= 0 || episode <= 0) return null;
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function deriveShowTitleForRatings(
  folderName: string | null | undefined,
  firstFileName?: string | null,
): string {
  if (firstFileName) {
    const parsed = formatDisplayMediaTitle(firstFileName);
    if (parsed.subtitle) {
      const cleaned = normalizeShowQuery(parsed.subtitle);
      if (cleaned) return cleaned;
    }
  }
  if (folderName) {
    const cleaned = normalizeShowQuery(formatSeasonFolderTitle(folderName));
    if (cleaned && cleaned !== "Season Queue") return cleaned;
  }
  return "";
}

export function getCachedShowRatings(showTitle: string): ShowOfficialRatings | null {
  const key = showTitle.trim().toLowerCase();
  if (!key) return null;
  const cache = loadCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > CACHE_TTL_MS) return null;
  return entry;
}

export function seedOfficialRatingsCache(entry: ShowOfficialRatings): void {
  const key = entry.showKey.trim().toLowerCase();
  if (!key) return;
  const cache = loadCache();
  cache[key] = { ...entry, showKey: key, updatedAt: Date.now() };
  saveCache(cache);
}

interface TvMazeEpisodeDto {
  season?: number;
  number?: number;
  rating?: { average?: number | null };
}

interface TvMazeShowSummary {
  id: number;
  name?: string;
  weight?: number;
  rating?: { average?: number | null };
}

interface TvMazeSearchHit {
  score?: number;
  show?: TvMazeShowSummary;
}

function normalizeTitleForMatch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fetchFromTvMaze(showTitle: string, signal?: AbortSignal): Promise<ShowOfficialRatings | null> {
  const searchUrl = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(showTitle)}`;
  const searchRes = await fetch(searchUrl, { signal });
  if (!searchRes.ok) return null;

  const hits = (await searchRes.json()) as TvMazeSearchHit[];
  if (!Array.isArray(hits) || hits.length === 0) return null;

  const targetNorm = normalizeTitleForMatch(showTitle);
  const ranked = hits
    .filter((h): h is { score?: number; show: TvMazeShowSummary } => Boolean(h?.show?.id))
    .map((h) => {
      const show = h.show;
      const candNorm = normalizeTitleForMatch(show.name ?? "");
      const titleBoost = candNorm === targetNorm ? 1.0 : candNorm.startsWith(targetNorm) ? 0.35 : 0;
      const ratingBoost = typeof show.rating?.average === "number" && show.rating.average > 0 ? 0.45 : 0;
      const weightBoost = ((show.weight ?? 0) / 100) * 0.25;
      const score = (h.score ?? 0) + titleBoost + ratingBoost + weightBoost;
      return { show, rank: score };
    })
    .sort((a, b) => b.rank - a.rank);

  for (const { show } of ranked.slice(0, 3)) {
    const epUrl = `https://api.tvmaze.com/shows/${show.id}/episodes`;
    const epRes = await fetch(epUrl, { signal });
    if (!epRes.ok) continue;
    const epList = (await epRes.json()) as TvMazeEpisodeDto[];
    if (!Array.isArray(epList)) continue;

    const episodes: Record<string, number> = {};
    for (const ep of epList) {
      const badge = buildEpisodeBadgeKey(ep.season, ep.number);
      const avg = ep.rating?.average;
      if (badge && typeof avg === "number" && Number.isFinite(avg) && avg > 0) {
        episodes[badge] = Math.round(avg * 10) / 10;
      }
    }

    const showAvg =
      typeof show.rating?.average === "number" && Number.isFinite(show.rating.average) && show.rating.average > 0
        ? Math.round(show.rating.average * 10) / 10
        : null;

    if (Object.keys(episodes).length > 0) {
      return {
        showKey: showTitle.trim().toLowerCase(),
        showTitle: show.name?.trim() || showTitle,
        source: "tvmaze",
        showRating: showAvg,
        episodes,
        updatedAt: Date.now(),
      };
    }
  }

  return null;
}

async function fetchFromCinemeta(showTitle: string, signal?: AbortSignal): Promise<ShowOfficialRatings | null> {
  const url = `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(showTitle)}.json`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    metas?: Array<{ name?: string; imdbRating?: string | number }>;
  };
  const first = data.metas?.[0];
  if (!first) return null;
  const parsed = Number(first.imdbRating);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return {
    showKey: showTitle.trim().toLowerCase(),
    showTitle: first.name?.trim() || showTitle,
    source: "cinemeta",
    showRating: Math.round(parsed * 10) / 10,
    episodes: {},
    updatedAt: Date.now(),
  };
}

/**
 * Fetches official per-episode ratings from free public sources (TVmaze primary, Cinemeta fallback)
 * with a 7-day localStorage cache and in-flight deduplication.
 * Caller `AbortSignal` is intentionally not passed to the shared network request so React
 * StrictMode cleanup or transient unmounts cannot abort and poison a deduplicated fetch.
 */
export async function fetchShowOfficialRatings(
  showTitle: string,
  _signal?: AbortSignal,
): Promise<ShowOfficialRatings | null> {
  const cleanTitle = showTitle.trim();
  const key = cleanTitle.toLowerCase();
  if (!key) return null;

  const cached = getCachedShowRatings(cleanTitle);
  if (cached) return cached;

  const existingPromise = inFlightRequests.get(key);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    try {
      const tvmaze = await fetchFromTvMaze(cleanTitle).catch(() => null);
      if (tvmaze) {
        const cache = loadCache();
        cache[key] = tvmaze;
        saveCache(cache);
        return tvmaze;
      }
      const cinemeta = await fetchFromCinemeta(cleanTitle).catch(() => null);
      if (cinemeta) {
        const cache = loadCache();
        cache[key] = cinemeta;
        saveCache(cache);
        return cinemeta;
      }
      return null;
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, promise);
  return promise;
}
