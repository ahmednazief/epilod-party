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

let nextReactionId = 1;
const reactionListeners = new Set<ReactionListener>();
const clearListeners = new Set<ClearListener>();
const lastBadgeAt = new Map<string, number>();
const pendingTimers = new Set<number>();

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
}): void {
  const cleanEmoji = params.emoji.trim();
  if (!cleanEmoji || reactionListeners.size === 0) return;

  const count = Math.max(1, Math.min(MAX_BURST_SPAWN, Math.round(params.count ?? 1)));
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
  for (const listener of clearListeners) {
    listener();
  }
}
