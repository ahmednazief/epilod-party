import type { Participant } from "./syncplay";

export const NOT_READY_TAG_PREFIX = "not-ready:";
export const PLAY_BLOCKED_TAG = "not-ready:play-blocked";
export const PEER_LEFT_TAG_PREFIX = "peer-left:";
export const LOCAL_DISCONNECT_TAG = "sync:local-disconnect";

export function peerNotReadyTag(username: string): string {
  return `${NOT_READY_TAG_PREFIX}peer:${username.trim().toLowerCase()}`;
}

export function peerDisconnectedTag(username: string): string {
  return `${PEER_LEFT_TAG_PREFIX}${username.trim().toLowerCase()}`;
}

export function formatPeerDisconnectedNotice(username: string, didPause: boolean): string {
  const clean = username.trim() || "Someone";
  return didPause ? `${clean} disconnected — playback paused.` : `${clean} disconnected.`;
}

export function formatPeerDisconnectedFeedback(username: string, didPause: boolean): string {
  const clean = username.trim() || "Someone";
  return didPause ? `Paused · ${clean} disconnected` : `${clean} disconnected`;
}

/**
 * Fix 08: Readiness gating & auto-ready transition helpers.
 */
export function canToggleReady(loaded: boolean): boolean {
  return loaded;
}

export function resolveReadyToggleTarget(
  loaded: boolean,
  currentReady: boolean,
): boolean | null {
  if (!loaded) {
    return null;
  }
  return !currentReady;
}

export function shouldAutoReadyOnFileLoad(params: {
  syncConnected: boolean;
  loaded: boolean;
  alreadyAutoMarked: boolean;
}): boolean {
  return params.syncConnected && params.loaded && !params.alreadyAutoMarked;
}

export function getNotReadyPeers(
  syncConnected: boolean,
  participants: readonly Participant[],
  localUsername: string,
): Participant[] {
  if (!syncConnected || participants.length === 0) {
    return [];
  }
  const localKey = localUsername.trim().toLowerCase();
  return participants.filter(
    (p) => p.username.trim().toLowerCase() !== localKey && !p.isReady,
  );
}

function dedupeUsernames(usernames: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of usernames) {
    const clean = raw.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export function formatNotReadyNames(usernames: readonly string[]): string {
  const clean = dedupeUsernames(usernames);
  if (clean.length === 0) return "Someone";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  if (clean.length === 3) return `${clean[0]}, ${clean[1]}, and ${clean[2]}`;
  const remaining = clean.length - 2;
  return `${clean[0]}, ${clean[1]}, and ${remaining} ${remaining === 1 ? "other" : "others"}`;
}

export function formatPeerNotReadyNotice(username: string): string {
  const clean = username.trim() || "Someone";
  return `${clean} is not ready.`;
}

export function formatPlayBlockedByNotReadyMessage(usernames: readonly string[]): string {
  const clean = dedupeUsernames(usernames);
  const verb = clean.length > 1 ? "are" : "is";
  return `Cannot play — ${formatNotReadyNames(clean)} ${verb} not ready.`;
}

export function formatPlayBlockedFeedback(usernames: readonly string[]): string {
  const clean = dedupeUsernames(usernames);
  const verb = clean.length > 1 ? "are" : "is";
  return `${formatNotReadyNames(clean)} ${verb} not ready`;
}

export function formatWaitingForNotReadyPill(usernames: readonly string[]): string {
  return `Waiting · ${formatPlayBlockedFeedback(usernames)}`;
}

export interface PlayBlockState {
  blocked: boolean;
  notReadyUsernames: string[];
  message: string | null;
  feedback: string | null;
}

export function getPlayBlockState(params: {
  syncConnected: boolean;
  participants: readonly Participant[];
  localUsername: string;
}): PlayBlockState {
  const peers = getNotReadyPeers(
    params.syncConnected,
    params.participants,
    params.localUsername,
  );
  if (peers.length === 0) {
    return {
      blocked: false,
      notReadyUsernames: [],
      message: null,
      feedback: null,
    };
  }
  const notReadyUsernames = peers.map((p) => p.username);
  return {
    blocked: true,
    notReadyUsernames,
    message: formatPlayBlockedByNotReadyMessage(notReadyUsernames),
    feedback: formatPlayBlockedFeedback(notReadyUsernames),
  };
}
