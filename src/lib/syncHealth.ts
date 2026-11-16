import { isIdentityTransform, localToRoomSecs, type TimelineSegment } from "./sourceAlignment";
import type { Participant, SyncStatusPayload } from "./syncplay";

export interface RoomSyncHealth {
  maxDriftSecs: number;
  peerCount: number;
  needsResync: boolean;
  statusLabel: string;
}

export const RESYNC_DRIFT_WARN_SECS = 2.0;

export function computeRoomSyncHealth(params: {
  syncStatus: SyncStatusPayload;
  participants: readonly Participant[];
  localUsername: string;
  localLoaded: boolean;
  localPositionSecs: number;
  timelineOffsetSecs?: number;
  timelineScale?: number;
  timelineSegments?: readonly TimelineSegment[];
}): RoomSyncHealth {
  const {
    syncStatus,
    participants,
    localUsername,
    localLoaded,
    localPositionSecs,
    timelineOffsetSecs = 0,
    timelineScale = 1,
    timelineSegments,
  } = params;
  const peerCount = participants.length;

  if (syncStatus.state === "error") {
    return {
      maxDriftSecs: 0,
      peerCount,
      needsResync: true,
      statusLabel: "Reconnect",
    };
  }

  if (syncStatus.state === "reconnecting") {
    return {
      maxDriftSecs: 0,
      peerCount,
      needsResync: true,
      statusLabel: "Reconnecting…",
    };
  }

  if (syncStatus.state !== "connected") {
    return {
      maxDriftSecs: 0,
      peerCount,
      needsResync: false,
      statusLabel: "Connecting…",
    };
  }

  if (!localLoaded || !Number.isFinite(localPositionSecs)) {
    return {
      maxDriftSecs: 0,
      peerCount,
      needsResync: false,
      statusLabel: "In sync",
    };
  }

  const localRoomPos = localToRoomSecs(
    localPositionSecs,
    timelineOffsetSecs,
    timelineScale,
    timelineSegments,
  );
  const hasAlignment =
    !isIdentityTransform({
      offsetSecs: timelineOffsetSecs,
      scale: timelineScale,
    }) || (timelineSegments?.length ?? 0) > 1;

  const localKey = localUsername.trim().toLowerCase();
  let maxDriftSecs = 0;

  for (const peer of participants) {
    if (peer.username.trim().toLowerCase() === localKey) {
      continue;
    }
    if (!peer.fileName || peer.fileMatch === "noFile") {
      continue;
    }
    const compatibleSource =
      peer.fileMatch === "matched" ||
      peer.fileMatch === "sameLengthDifferentEncode" ||
      (peer.fileMatch === "durationMismatch" &&
        (hasAlignment ||
          peer.sourceRelation === "differentCut" ||
          peer.sourceRelation === "fpsMismatch"));
    if (!compatibleSource) {
      continue;
    }
    // Syncplay's user list reports position 0 for peers (real position travels only in playstate
    // messages), so 0 means "unknown" and must not be compared against our own position.
    if (!Number.isFinite(peer.position) || peer.position <= 0) {
      continue;
    }
    const drift = Math.abs(localRoomPos - peer.position);
    if (drift > maxDriftSecs) {
      maxDriftSecs = drift;
    }
  }

  const needsResync = maxDriftSecs >= RESYNC_DRIFT_WARN_SECS;
  return {
    maxDriftSecs,
    peerCount,
    needsResync,
    statusLabel: needsResync ? `Drift ${maxDriftSecs.toFixed(1)}s` : "In sync",
  };
}
