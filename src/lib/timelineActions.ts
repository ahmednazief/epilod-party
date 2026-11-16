import { formatUserError } from "./errors";
import { mpvSetSpeed, safeMpvCall } from "./mpv";
import {
  buildAlignmentPairKey,
  fitTwoPointAlignment,
  formatSignedOffset,
  isIdentityTransform,
  localToRoomSecs,
  saveSourceAlignment,
  type TimelineTransform,
} from "./sourceAlignment";
import { resolveEffectiveUsername } from "./syncController";
import {
  syncAlignSceneHere,
  syncNudgeTimelineOffset,
  syncRunP2pAutoAlign,
  syncSetAlignMode,
  syncSetTimelineTransform,
  type Participant,
} from "./syncplay";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";

export function findAlignmentTargetPeer(
  participants: readonly Participant[],
  localUsername: string,
): Participant | null {
  const localKey = localUsername.trim().toLowerCase();
  const peers = participants.filter(
    (p) => p.username.trim().toLowerCase() !== localKey && Boolean(p.fileName),
  );
  if (peers.length === 0) return null;
  return (
    peers.find((p) => p.isController && p.fileMatch !== "matched") ??
    peers.find(
      (p) =>
        p.sourceRelation === "fpsMismatch" ||
        p.sourceRelation === "differentCut" ||
        p.fileMatch === "durationMismatch" ||
        p.fileMatch === "sameLengthDifferentEncode",
    ) ??
    peers.find((p) => p.isController) ??
    peers[0]
  );
}

export function persistCurrentAlignment(tx: TimelineTransform): void {
  const app = useAppStore.getState();
  const player = usePlayerStore.getState();
  const sync = useSyncStore.getState();
  const effUser = resolveEffectiveUsername(sync.status, app.username);
  const peer = findAlignmentTargetPeer(sync.participants, effUser);
  const pairKey = buildAlignmentPairKey(
    app.selectedFileName,
    player.durationSecs,
    peer?.fileName,
    peer?.fileDuration,
  );
  saveSourceAlignment(pairKey, tx);
}

export async function applyTimelineTransform(
  tx: TimelineTransform,
  notice?: string,
): Promise<void> {
  const sync = useSyncStore.getState();
  sync.setTimelineSegments([]);
  sync.setTimelineTransform(tx);
  const player = usePlayerStore.getState();
  if (sync.status.state === "connected") {
    player.setSpeed(tx.scale);
    safeMpvCall(mpvSetSpeed(tx.scale), "timeline:mpvSetSpeed");
  }
  persistCurrentAlignment(tx);
  try {
    await syncSetTimelineTransform(tx);
    if (notice) {
      player.flashFeedback(notice);
      useNotificationStore.getState().push("success", notice);
    }
  } catch (err) {
    useNotificationStore
      .getState()
      .push("error", formatUserError(err, "Could not update source timing."));
  }
}

export async function nudgeTimelineOffset(deltaSecs: number): Promise<void> {
  const sync = useSyncStore.getState();
  const nextTx: TimelineTransform = {
    offsetSecs: sync.timelineOffsetSecs + deltaSecs,
    scale: sync.timelineScale,
  };
  sync.setTimelineTransform(nextTx);
  persistCurrentAlignment(nextTx);
  usePlayerStore.getState().flashFeedback(`Offset ${formatSignedOffset(nextTx.offsetSecs)}`);
  try {
    await syncNudgeTimelineOffset(deltaSecs);
  } catch (err) {
    useNotificationStore
      .getState()
      .push("error", formatUserError(err, "Could not adjust timing offset."));
  }
}

export async function setSceneAlignMode(enabled: boolean): Promise<void> {
  const sync = useSyncStore.getState();
  sync.setAlignMode(enabled);
  try {
    await syncSetAlignMode(enabled);
    if (enabled) {
      usePlayerStore.getState().flashFeedback("Aligning locally");
    }
  } catch (err) {
    sync.setAlignMode(false);
    useNotificationStore
      .getState()
      .push("error", formatUserError(err, "Could not toggle scene alignment mode."));
  }
}

export async function captureSceneAnchor(): Promise<void> {
  const player = usePlayerStore.getState();
  const sync = useSyncStore.getState();
  const localPos = player.positionSecs;
  try {
    const tx = await syncAlignSceneHere(localPos);
    sync.setTimelineTransform(tx);
    sync.setAlignMode(false);
    const roomPos = localToRoomSecs(localPos, tx.offsetSecs, tx.scale);
    if (!sync.alignAnchor1) {
      sync.setAlignAnchor1({ roomSecs: roomPos, localSecs: localPos });
    }
    if (sync.status.state === "connected") {
      player.setSpeed(tx.scale);
    }
    persistCurrentAlignment(tx);
    const label = isIdentityTransform(tx)
      ? "Synced at 0.0s"
      : `Aligned (${formatSignedOffset(tx.offsetSecs)})`;
    player.flashFeedback(label);
    useNotificationStore.getState().push("success", `${label} — playback matched to party.`);
  } catch (err) {
    useNotificationStore
      .getState()
      .push("error", formatUserError(err, "Could not align to party scene."));
  }
}

export async function captureSecondDriftAnchor(): Promise<void> {
  const sync = useSyncStore.getState();
  const player = usePlayerStore.getState();
  const anchor1 = sync.alignAnchor1;
  if (!anchor1) {
    await captureSceneAnchor();
    return;
  }
  const localPos = player.positionSecs;
  const roomPos = sync.alignMode
    ? sync.liveRoomPositionSecs
    : localToRoomSecs(localPos, sync.timelineOffsetSecs, sync.timelineScale);
  const fitted = fitTwoPointAlignment(anchor1, {
    roomSecs: roomPos,
    localSecs: localPos,
  });
  if (!fitted) {
    useNotificationStore
      .getState()
      .push(
        "info",
        "Move at least 30 seconds away from your first point before calibrating drift.",
      );
    return;
  }
  sync.setAlignMode(false);
  try {
    await syncSetAlignMode(false);
  } catch {
    // ignore if already off
  }
  await applyTimelineTransform(
    { offsetSecs: fitted.offsetSecs, scale: fitted.scale },
    `Calibrated · ${fitted.snappedLabel}`,
  );
  sync.setAlignAnchor1(null);
}

export async function resetTimelineAlignment(): Promise<void> {
  const sync = useSyncStore.getState();
  sync.resetTimelineAlignment();
  await applyTimelineTransform({ offsetSecs: 0, scale: 1.0 }, "Source timing reset");
}

export async function runP2pAutoAlign(force = true): Promise<void> {
  usePlayerStore.getState().flashFeedback("Matching audio via P2P…");
  try {
    await syncRunP2pAutoAlign(force);
  } catch (err) {
    useNotificationStore
      .getState()
      .push("error", formatUserError(err, "Could not start direct P2P audio alignment."));
  }
}
