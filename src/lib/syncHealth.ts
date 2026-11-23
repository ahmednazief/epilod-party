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
  roomPositionSecs?: number | null;
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
    roomPositionSecs,
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
    // messages), and Cloud snapshots emit 0 (reporting live delta in lagSecs), so 0 means
    // "no per-peer snapshot position".
    let drift = 0;
    if (Number.isFinite(peer.position) && peer.position > 0) {
      drift = Math.abs(localRoomPos - peer.position);
    } else if (
      typeof roomPositionSecs === "number" &&
      Number.isFinite(roomPositionSecs) &&
      roomPositionSecs > 0
    ) {
      const peerLag =
        typeof peer.lagSecs === "number" && Number.isFinite(peer.lagSecs) ? peer.lagSecs : 0;
      const peerRoomPos = roomPositionSecs - peerLag;
      drift = Math.abs(localRoomPos - peerRoomPos);
    } else {
      continue;
    }
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

export interface ParticipantDriftInfo {
  deltaSecs: number;
  absSecs: number;
  level: "ok" | "warn" | "bad";
  label: string;
  detail: string;
}

export function computeParticipantDrift(
  participant: Pick<Participant, "fileName" | "fileMatch" | "position" | "lagSecs">,
  referencePositionSecs: number,
): ParticipantDriftInfo | null {
  if (!participant.fileName || participant.fileMatch === "noFile") {
    return null;
  }
  let deltaSecs: number | null = null;
  if (typeof participant.lagSecs === "number" && Number.isFinite(participant.lagSecs)) {
    // Cloud server computes lagSecs = roomPos - reportedPosition; positive lag means peer is behind.
    deltaSecs = -participant.lagSecs;
  } else if (
    Number.isFinite(participant.position) &&
    participant.position > 0 &&
    Number.isFinite(referencePositionSecs) &&
    referencePositionSecs > 0
  ) {
    deltaSecs = participant.position - referencePositionSecs;
  }
  if (deltaSecs === null) {
    return null;
  }
  const absSecs = Math.abs(deltaSecs);
  const level: "ok" | "warn" | "bad" = absSecs < 0.5 ? "ok" : absSecs < 2.0 ? "warn" : "bad";
  const sign = deltaSecs >= 0 ? "+" : "-";
  return {
    deltaSecs,
    absSecs,
    level,
    label: level === "ok" ? "In sync" : "Playback drift",
    detail: `${sign}${absSecs.toFixed(1)}s vs room`,
  };
}
