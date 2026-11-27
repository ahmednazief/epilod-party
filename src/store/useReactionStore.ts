export interface ReactionSpawnItem {
  id: number;
  username: string;
  avatarId: string;
  emoji: string;
  isSelf: boolean;
  showBadge: boolean;
}

type ReactionListener = (item: ReactionSpawnItem) => void;
type ClearListener = () => void;

const BADGE_REFRESH_MS = 1150;
const MAX_BURST_SPAWN = 25;
const MAX_TIMELINE_BUCKETS = 120;
const BUCKET_WIDTH_SECS = 5;

interface TimelineBucket {
  total: number;
  counts: Record<string, number>;
}

let nextReactionId = 1;
const reactionListeners = new Set<ReactionListener>();
const clearListeners = new Set<ClearListener>();
const lastBadgeAt = new Map<string, number>();
const pendingTimers = new Set<number>();
const timelineBuckets = new Map<number, TimelineBucket>();
const timelineListeners = new Set<() => void>();

function recordTimelineReaction(emoji: string, count: number, positionSecs?: number): void {
  if (typeof positionSecs !== "number" || !Number.isFinite(positionSecs) || positionSecs < 0) {
    return;
  }
  const bucketSecs = Math.floor(positionSecs / BUCKET_WIDTH_SECS) * BUCKET_WIDTH_SECS;
  let bucket = timelineBuckets.get(bucketSecs);
  if (!bucket) {
    if (timelineBuckets.size >= MAX_TIMELINE_BUCKETS) {
      const oldestKey = timelineBuckets.keys().next().value;
      if (oldestKey !== undefined) timelineBuckets.delete(oldestKey);
    }
    bucket = { total: 0, counts: {} };
    timelineBuckets.set(bucketSecs, bucket);
  }
  bucket.total += count;
  bucket.counts[emoji] = (bucket.counts[emoji] ?? 0) + count;
  for (const listener of timelineListeners) {
    listener();
  }
}

export function getReactionHotspots(
  durationSecs: number,
  minCount = 3,
): Array<{ secs: number; total: number; topEmoji: string }> {
  if (!Number.isFinite(durationSecs) || durationSecs < 30 || timelineBuckets.size === 0) {
    return [];
  }
  const out: Array<{ secs: number; total: number; topEmoji: string }> = [];
  for (const [secs, bucket] of timelineBuckets.entries()) {
    if (secs >= durationSecs || bucket.total < minCount) continue;
    let topEmoji = "❤️";
    let topCount = 0;
    for (const [em, c] of Object.entries(bucket.counts)) {
      if (c > topCount) {
        topCount = c;
        topEmoji = em;
      }
    }
    out.push({ secs, total: bucket.total, topEmoji });
  }
  out.sort((a, b) => b.total - a.total);
  return out.slice(0, 12);
}

export function getReactionBucketAt(
  secs: number,
): { total: number; topEmoji: string } | null {
  if (!Number.isFinite(secs) || secs < 0 || timelineBuckets.size === 0) return null;
  const bucketSecs = Math.floor(secs / BUCKET_WIDTH_SECS) * BUCKET_WIDTH_SECS;
  const bucket = timelineBuckets.get(bucketSecs);
  if (!bucket || bucket.total < 2) return null;
  let topEmoji = "❤️";
  let topCount = 0;
  for (const [em, c] of Object.entries(bucket.counts)) {
    if (c > topCount) {
      topCount = c;
      topEmoji = em;
    }
  }
  return { total: bucket.total, topEmoji };
}

export function subscribeReactionTimeline(listener: () => void): () => void {
  timelineListeners.add(listener);
  return () => {
    timelineListeners.delete(listener);
  };
}

function emitSingle(
  username: string,
  avatarId: string,
  emoji: string,
  isSelf: boolean,
): void {
  const key = username.trim().toLowerCase() || "viewer";
  const now = performance.now();
  const prevBadge = lastBadgeAt.get(key);
  const showBadge = prevBadge === undefined || now - prevBadge >= BADGE_REFRESH_MS;
  if (showBadge) {
    lastBadgeAt.set(key, now);
  }

  const item: ReactionSpawnItem = {
    id: nextReactionId++,
    username: username.trim() || "Viewer",
    avatarId,
    emoji,
    isSelf,
    showBadge,
  };

  for (const listener of reactionListeners) {
    listener(item);
  }
}

/**
 * Enqueues one or more floating reaction spawns for the canvas overlay without
 * triggering React component re-renders. Bursts > 1 are staggered smoothly.
 */
export function enqueueReactionBurst(params: {
  username: string;
  avatarId: string;
  emoji: string;
  count?: number;
  isSelf?: boolean;
  positionSecs?: number;
}): void {
  const cleanEmoji = params.emoji.trim();
  if (!cleanEmoji) return;

  const count = Math.max(1, Math.min(MAX_BURST_SPAWN, Math.round(params.count ?? 1)));
  recordTimelineReaction(cleanEmoji, count, params.positionSecs);
  if (reactionListeners.size === 0) return;
  const isSelf = Boolean(params.isSelf);

  emitSingle(params.username, params.avatarId, cleanEmoji, isSelf);
  if (count <= 1) return;

  const totalSpanMs = Math.min(320, count * 44);
  const stepMs = totalSpanMs / (count - 1);
  for (let i = 1; i < count; i++) {
    const delay = Math.round(i * stepMs + Math.random() * 18);
    const timerId = globalThis.setTimeout(() => {
      pendingTimers.delete(timerId);
      emitSingle(params.username, params.avatarId, cleanEmoji, isSelf);
    }, delay) as unknown as number;
    pendingTimers.add(timerId);
  }
}

export function subscribeReactions(
  onSpawn: ReactionListener,
  onClear?: ClearListener,
): () => void {
  reactionListeners.add(onSpawn);
  if (onClear) clearListeners.add(onClear);
  return () => {
    reactionListeners.delete(onSpawn);
    if (onClear) clearListeners.delete(onClear);
  };
}

export function clearReactions(): void {
  for (const timerId of pendingTimers) {
    globalThis.clearTimeout(timerId);
  }
  pendingTimers.clear();
  lastBadgeAt.clear();
  timelineBuckets.clear();
  for (const listener of timelineListeners) {
    listener();
  }
  for (const listener of clearListeners) {
    listener();
  }
}
