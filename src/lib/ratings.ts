import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop, safeInvoke } from "./bridge";

export interface RatingVoteEntry {
  username: string;
  avatarId?: string;
  score: number; // 1..10
  updatedAt: number;
}

export interface SyncRatingVotePayload {
  username: string;
  avatarId?: string;
  key: string;
  score: number;
  via: "syncplay" | "cloud";
}

export interface RatingSummary {
  totalVotes: number;
  average: number;
  distribution: number[]; // length 10, index 0 => score 1 .. index 9 => score 10
  majorityScore: number | null;
  majorityCount: number;
  voters: RatingVoteEntry[];
}

export const RATING_LABELS: Record<number, string> = {
  1: "Unwatchable",
  2: "Awful",
  3: "Poor",
  4: "Weak",
  5: "Mixed",
  6: "Decent",
  7: "Good",
  8: "Great",
  9: "Amazing",
  10: "Masterpiece",
};

function normalizeMediaStem(fileName: string | null | undefined): string {
  const cleanName = (fileName ?? "").trim();
  if (!cleanName) return "";
  return cleanName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    // Strip common release/codec/resolution tags so 1080p vs 720p encodes match
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(
      /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|bluray|bdrip|brrip|web[-.\s]?dl|webrip|hdtv|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|av1|10bit|8bit|aac|ac3|eac3|dts(?:-hd)?|truehd|atmos|flac|proper|repack)\b/g,
      " ",
    )
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a deterministic, duration-free ID for persisting personal episode/movie ratings locally.
 */
export function buildEpisodeRatingId(fileName: string | null | undefined): string | null {
  const rawStem = normalizeMediaStem(fileName);
  if (!rawStem) return null;
  const epMatch = rawStem.match(/^(.+?\bs\d{1,2}e\d{1,3})\b/i);
  const stem = epMatch ? epMatch[1].trim() : rawStem;
  const slug = stem
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  let hash = 0x811c9dc5;
  for (let i = 0; i < stem.length; i += 1) {
    hash ^= stem.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(36);
  return `${slug || "media"}_${hex}`.slice(0, 48);
}

/**
 * Builds a deterministic, ASCII-safe key (<= 48 chars) from the media filename
 * and rounded duration so peers watching the same episode/movie share a key.
 */
export function buildRatingKey(
  fileName: string | null | undefined,
  durationSecs: number,
): string | null {
  if (!Number.isFinite(durationSecs) || durationSecs < 30) {
    return null;
  }
  const stem = normalizeMediaStem(fileName);
  if (!stem) return null;
  const slug = stem
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 26);
  // 32-bit FNV-1a hash handles non-ASCII (e.g. Arabic) titles cleanly.
  let hash = 0x811c9dc5;
  for (let i = 0; i < stem.length; i += 1) {
    hash ^= stem.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const durBucket = Math.round(durationSecs / 30);
  const hex = (hash >>> 0).toString(36);
  const raw = `${slug || "media"}_${hex}_${durBucket}`.slice(0, 48);
  return raw;
}

/**
 * Computes average, 1..10 distribution, and majority (mode; ties favor higher score).
 */
export function computeRatingSummary(
  votes: Record<string, RatingVoteEntry>,
): RatingSummary {
  const distribution = new Array<number>(10).fill(0);
  const valid: RatingVoteEntry[] = [];
  let sum = 0;

  for (const entry of Object.values(votes)) {
    const s = Math.round(entry.score);
    if (s < 1 || s > 10) continue;
    valid.push({ ...entry, score: s });
    distribution[s - 1] += 1;
    sum += s;
  }

  let majorityScore: number | null = null;
  let majorityCount = 0;
  for (let i = 9; i >= 0; i -= 1) {
    if (distribution[i] > majorityCount) {
      majorityCount = distribution[i];
      majorityScore = i + 1;
    }
  }

  valid.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));

  return {
    totalVotes: valid.length,
    average: valid.length > 0 ? Math.round((sum / valid.length) * 10) / 10 : 0,
    distribution,
    majorityScore,
    majorityCount,
    voters: valid,
  };
}

export async function syncSendRatingVote(
  key: string,
  score: number,
  avatarId?: string,
): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("sync_send_rating_vote", {
    key,
    score: Math.max(1, Math.min(10, Math.round(score))),
    avatarId: avatarId || null,
  });
}

export async function onSyncRatingVote(
  cb: (payload: SyncRatingVotePayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return () => {};
  return listen<SyncRatingVotePayload>("sync://rating-vote", (e) => {
    if (e.payload) cb(e.payload);
  });
}
