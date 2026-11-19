import { getFileDisplayName } from "./fileDrop";
import {
  cleanEpisodeTitle,
  formatEpisodeBadge,
  hashFilenameForMatch,
  matchPeerEpisodeInPlaylist,
  parseEpisodeCode,
  type PlaylistItem,
} from "./playlist";
import { pickNextUnwatchedIndex } from "./seriesProgress";
import type { Participant } from "./syncplay";

export type EpisodeLoadTrigger = "autoNext" | "manual" | "follow";

export interface RecentEpisodeSwitch {
  path: string;
  atMs: number;
  trigger: EpisodeLoadTrigger;
}

const RECENT_EPISODE_GUARD_MS = 6000;
const LOCAL_SWITCH_GRACE_MS = 2500;
const FOLLOW_BURST_WINDOW_MS = 6000;
const FOLLOW_BURST_LIMIT = 3;

export interface AutoNextEofCheckInput {
  autoPlayNext: boolean;
  currentIndex: number;
  itemsLength: number;
  loadInFlight: boolean;
  eofHandledForGen: number;
  currentLoadGen: number;
  lockedForLocalUser: boolean;
  items?: readonly PlaylistItem[];
  watchedKeys?: readonly string[];
}

export interface AutoNextEofDecision {
  advance: boolean;
  nextIndex: number | null;
}

/**
 * Decides whether a natural EOF event may advance to the next playlist episode without
 * double-skipping episodes or tripping controller locks.
 */
export function canTriggerAutoNextOnEof(input: AutoNextEofCheckInput): AutoNextEofDecision {
  if (!input.autoPlayNext || input.loadInFlight || input.lockedForLocalUser) {
    return { advance: false, nextIndex: null };
  }
  if (input.eofHandledForGen === input.currentLoadGen) {
    return { advance: false, nextIndex: null };
  }
  if (input.currentIndex < 0 || input.currentIndex >= input.itemsLength - 1) {
    return { advance: false, nextIndex: null };
  }
  if (input.items && input.watchedKeys && input.watchedKeys.length > 0) {
    const nextUnwatched = pickNextUnwatchedIndex(input.items, input.currentIndex, input.watchedKeys);
    if (nextUnwatched === null) {
      return { advance: false, nextIndex: null };
    }
    return { advance: true, nextIndex: nextUnwatched };
  }
  return { advance: true, nextIndex: input.currentIndex + 1 };
}

function buildSyntheticTargetItem(
  targetFileName: string,
  targetPath: string | null | undefined,
): PlaylistItem {
  const baseName = getFileDisplayName(targetFileName);
  const code = parseEpisodeCode(baseName);
  return {
    path: targetPath || baseName,
    fileName: baseName,
    cleanTitle: cleanEpisodeTitle(baseName),
    season: code ? code.season : null,
    episode: code ? code.episode : null,
    episodeBadge: code ? formatEpisodeBadge(code) : null,
    subtitlePath: null,
  };
}

/**
 * Returns `true` when `peerFileName` refers to the target episode/file rather than an older or
 * different episode still open on a peer's PC.
 */
export function peerMatchesTargetEpisode(
  peerFileName: string | null | undefined,
  targetFileName: string,
  targetPath?: string | null,
  playlistItems?: readonly PlaylistItem[],
): boolean {
  const rawPeer = peerFileName?.trim();
  const baseTarget = getFileDisplayName(targetFileName).trim();
  if (!rawPeer || !baseTarget) {
    return false;
  }

  const peerBase = getFileDisplayName(rawPeer).toLowerCase();
  const targetLower = baseTarget.toLowerCase();
  if (peerBase === targetLower) {
    return true;
  }

  if (/^[a-f0-9]{12}$/i.test(peerBase) && hashFilenameForMatch(baseTarget) === peerBase) {
    return true;
  }

  if (playlistItems && playlistItems.length > 0) {
    const targetIdx = playlistItems.findIndex((it) =>
      targetPath
        ? it.path.toLowerCase() === targetPath.toLowerCase()
        : it.fileName.toLowerCase() === targetLower,
    );
    const peerIdx = matchPeerEpisodeInPlaylist(rawPeer, playlistItems);
    if (peerIdx !== -1 && targetIdx !== -1) {
      return peerIdx === targetIdx;
    }
  }

  const synthetic = buildSyntheticTargetItem(baseTarget, targetPath);
  return matchPeerEpisodeInPlaylist(rawPeer, [synthetic]) === 0;
}

export interface EpisodeLoadSyncPlanInput {
  roomCode: string;
  syncConnected: boolean;
  syncReconnectingOrError: boolean;
  lockedForLocalUser: boolean;
  participants: readonly Participant[];
  localUsername: string;
  targetFileName: string;
  targetPath?: string | null;
  playlistItems?: readonly PlaylistItem[];
  trigger: EpisodeLoadTrigger;
  wasPlayingBeforeLoad?: boolean;
  manuallyNotReadyBlocked?: boolean;
}

export interface EpisodeLoadSyncPlan {
  otherPeersWithFileCount: number;
  compatiblePeerCount: number;
  shouldResetRoomToZero: boolean;
  shouldAutoPlay: boolean;
  shouldSendPauseToRoom: boolean;
}

/**
 * Coordinates playback & Syncplay state when opening or auto-advancing to an episode so moving
 * from Ep 1 -> Ep 2 resets a room's stale end-of-episode playhead instead of snapping Ep 2 to
 * the previous episode's EOF timestamp.
 */
export function resolveEpisodeLoadSyncPlan(
  input: EpisodeLoadSyncPlanInput,
): EpisodeLoadSyncPlan {
  const myKey = input.localUsername.trim().toLowerCase();
  const otherPeersWithFile = input.participants.filter(
    (p) => p.username.trim().toLowerCase() !== myKey && Boolean(p.fileName?.trim()),
  );
  const compatiblePeers = otherPeersWithFile.filter((p) =>
    peerMatchesTargetEpisode(
      p.fileName,
      input.targetFileName,
      input.targetPath,
      input.playlistItems,
    ),
  );

  if (!input.roomCode) {
    return {
      otherPeersWithFileCount: 0,
      compatiblePeerCount: 0,
      shouldResetRoomToZero: false,
      shouldAutoPlay: true,
      shouldSendPauseToRoom: false,
    };
  }

  if (input.syncReconnectingOrError || input.lockedForLocalUser) {
    return {
      otherPeersWithFileCount: otherPeersWithFile.length,
      compatiblePeerCount: compatiblePeers.length,
      shouldResetRoomToZero: false,
      shouldAutoPlay: false,
      shouldSendPauseToRoom: false,
    };
  }

  // Nobody else is already on this new target episode (we're solo in room or first to advance).
  if (compatiblePeers.length === 0) {
    const wantsPlay =
      (otherPeersWithFile.length === 0 ||
        input.trigger === "autoNext" ||
        Boolean(input.wasPlayingBeforeLoad)) &&
      !input.manuallyNotReadyBlocked;
    return {
      otherPeersWithFileCount: otherPeersWithFile.length,
      compatiblePeerCount: 0,
      shouldResetRoomToZero: input.syncConnected,
      shouldAutoPlay: wantsPlay,
      shouldSendPauseToRoom: input.syncConnected && !wantsPlay,
    };
  }

  // At least one peer already has this exact episode open: defer to live Syncplay timeline.
  return {
    otherPeersWithFileCount: otherPeersWithFile.length,
    compatiblePeerCount: compatiblePeers.length,
    shouldResetRoomToZero: false,
    shouldAutoPlay: false,
    shouldSendPauseToRoom: false,
  };
}

export interface FollowPartyEpisodeInput {
  syncConnected: boolean;
  followPartyEpisode: boolean;
  participants: readonly Participant[];
  localUsername: string;
  playlistItems: readonly PlaylistItem[];
  playlistIndex: number;
  loadInFlight: boolean;
  previousPeerFile: string | null;
  justAdvancedFromPath?: string | null;
  hasControllers?: boolean;
  localIsController?: boolean;
  recentLocalSwitches?: readonly RecentEpisodeSwitch[];
  recentFollowTimestamps?: readonly number[];
  nowMs?: number;
}

export type FollowPartyEpisodeResult =
  | { action: "noop"; nextPeerFile: string | null }
  | {
      action: "follow";
      targetIndex: number;
      leaderUsername: string;
      target: PlaylistItem;
      nextPeerFile: string;
    };

/**
 * Resolves whether `Follow` should switch to a peer's episode while ignoring momentary participant
 * list gaps and preventing backwards snap-backs right after local Auto-Next.
 */
export function resolveFollowPartyEpisode(
  input: FollowPartyEpisodeInput,
): FollowPartyEpisodeResult {
  if (!input.syncConnected) {
    return { action: "noop", nextPeerFile: null };
  }
  if (!input.followPartyEpisode || input.playlistItems.length === 0 || input.loadInFlight) {
    return { action: "noop", nextPeerFile: input.previousPeerFile };
  }

  const myKey = input.localUsername.trim().toLowerCase();
  const otherPeers = input.participants.filter(
    (p) => p.username.trim().toLowerCase() !== myKey && Boolean(p.fileName?.trim()),
  );
  if (otherPeers.length === 0) {
    // Keep previousPeerFile across brief file transitions so re-announcing the old episode does not
    // bounce a viewer backwards right after advancing.
    return { action: "noop", nextPeerFile: input.previousPeerFile };
  }

  const leader = otherPeers.find((p) => p.isController) ?? otherPeers[0];
  const peerFile = leader.fileName?.trim() || null;
  if (input.hasControllers && input.localIsController && !leader.isController) {
    return { action: "noop", nextPeerFile: peerFile ?? input.previousPeerFile };
  }
  if (!peerFile || peerFile === input.previousPeerFile) {
    return { action: "noop", nextPeerFile: input.previousPeerFile };
  }

  const matchedIdx = matchPeerEpisodeInPlaylist(peerFile, input.playlistItems);
  if (matchedIdx === -1 || matchedIdx === input.playlistIndex) {
    return { action: "noop", nextPeerFile: peerFile };
  }

  const target = input.playlistItems[matchedIdx];
  if (
    input.previousPeerFile === null &&
    matchedIdx < input.playlistIndex &&
    input.justAdvancedFromPath &&
    target.path.toLowerCase() === input.justAdvancedFromPath.toLowerCase()
  ) {
    return { action: "noop", nextPeerFile: peerFile };
  }

  const nowMs = input.nowMs ?? Date.now();
  if (input.recentLocalSwitches && input.recentLocalSwitches.length > 0) {
    const targetLower = target.path.toLowerCase();
    const recentlyVisitedTarget = input.recentLocalSwitches.some(
      (sw) =>
        nowMs - sw.atMs < RECENT_EPISODE_GUARD_MS &&
        sw.path.toLowerCase() === targetLower,
    );
    if (recentlyVisitedTarget) {
      return { action: "noop", nextPeerFile: peerFile };
    }
    const withinLocalGrace = input.recentLocalSwitches.some(
      (sw) =>
        (sw.trigger === "manual" || sw.trigger === "autoNext") &&
        nowMs - sw.atMs < LOCAL_SWITCH_GRACE_MS,
    );
    if (withinLocalGrace) {
      return { action: "noop", nextPeerFile: peerFile };
    }
  }

  if (input.recentFollowTimestamps && input.recentFollowTimestamps.length > 0) {
    const recentFollows = input.recentFollowTimestamps.filter(
      (t) => nowMs - t < FOLLOW_BURST_WINDOW_MS,
    );
    if (recentFollows.length >= FOLLOW_BURST_LIMIT) {
      return { action: "noop", nextPeerFile: peerFile };
    }
  }

  return {
    action: "follow",
    targetIndex: matchedIdx,
    leaderUsername: leader.username,
    target,
    nextPeerFile: peerFile,
  };
}
