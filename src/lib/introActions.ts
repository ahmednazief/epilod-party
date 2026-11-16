import { useAppStore } from "../store/useAppStore";
import {
  buildIntroSegmentKey,
  getEffectiveIntroSegments,
  useIntroStore,
} from "../store/useIntroStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { mpvSeek, type DetectedIntro } from "./mpv";
import { nextClientSeekSeq, resetSharedRelativeSeek } from "./seekCoalesce";
import { getControllerLockState, resolveEffectiveUsername } from "./syncController";
import { syncUserSeek } from "./syncplay";

export interface IntroSeekDeps {
  seekLocal?: (seconds: number) => Promise<unknown> | void;
  seekSync?: (seconds: number) => Promise<unknown> | void;
}

export function getActiveIntroSegments(): DetectedIntro[] {
  const { segments, manualIntro } = useIntroStore.getState();
  return getEffectiveIntroSegments(segments, manualIntro);
}

/** Returns the intro/recap segment currently active (with 1.5s pre-entry margin). */
export function findActiveIntroAt(
  positionSecs: number,
  segments: readonly DetectedIntro[]
): DetectedIntro | null {
  if (!Number.isFinite(positionSecs) || positionSecs < 0) return null;
  for (const seg of segments) {
    const enterAt = Math.max(0, seg.startSecs - 1.5);
    const exitBefore = seg.skipTargetSecs - 1.25;
    if (positionSecs >= enterAt && positionSecs < exitBefore) {
      return seg;
    }
  }
  return null;
}

/** Finds an active segment first, or the next upcoming segment starting within 180s. */
export function findSkippableIntroAt(
  positionSecs: number,
  segments: readonly DetectedIntro[]
): DetectedIntro | null {
  const active = findActiveIntroAt(positionSecs, segments);
  if (active) return active;
  if (!Number.isFinite(positionSecs) || positionSecs < 0) return null;
  for (const seg of segments) {
    if (
      positionSecs < seg.skipTargetSecs - 1.25 &&
      seg.startSecs - positionSecs <= 180
    ) {
      return seg;
    }
  }
  return null;
}

export async function executeSkipIntro(
  segment: DetectedIntro,
  deps?: IntroSeekDeps
): Promise<boolean> {
  const player = usePlayerStore.getState();
  if (!player.loaded) return false;

  const app = useAppStore.getState();
  const sync = useSyncStore.getState();
  const intro = useIntroStore.getState();

  const connected = sync.status.state === "connected";
  const aligning = connected && sync.alignMode;
  const effectiveUser = resolveEffectiveUsername(sync.status, app.username);
  const ctrlLock = getControllerLockState(
    connected,
    sync.participants,
    effectiveUser,
    sync.roomControl
  );

  if (ctrlLock.lockedForLocalUser && !aligning) {
    player.flashFeedback(
      ctrlLock.controllers.length > 0
        ? `Controlled by ${ctrlLock.controllers[0]}`
        : ctrlLock.hostUsername
          ? `Host control (${ctrlLock.hostUsername})`
          : "Controller locked"
    );
    return false;
  }

  const maxSeek =
    player.durationSecs > 1 ? Math.max(0, player.durationSecs - 0.5) : segment.skipTargetSecs;
  const target = Math.min(Math.max(0, segment.skipTargetSecs), maxSeek);
  if (!Number.isFinite(target) || target <= player.positionSecs + 0.5) {
    return false;
  }

  const segKey = buildIntroSegmentKey(intro.videoKey, segment);
  intro.markAutoSkipped(segKey);
  intro.dismissSegment(segKey);

  const seekSeq = nextClientSeekSeq();
  resetSharedRelativeSeek();
  player.setPositionSecs(target);
  const msg =
    segment.label === "Skip Recap & Intro"
      ? "Skipped recap & intro"
      : segment.kind === "recap"
        ? "Skipped recap"
        : "Skipped intro";
  player.flashFeedback(msg);

  const seekSync = deps?.seekSync ?? syncUserSeek;

  try {
    await (deps?.seekLocal
      ? deps.seekLocal(target)
      : mpvSeek(target, { clientSeekSeq: seekSeq }));
  } catch {
    // non-fatal
  }
  if (connected && !aligning) {
    try {
      await seekSync(target);
    } catch {
      // non-fatal
    }
  }
  return true;
}

export async function skipActiveOrUpcomingIntro(
  deps?: IntroSeekDeps
): Promise<boolean> {
  const player = usePlayerStore.getState();
  if (!player.loaded) return false;
  const segments = getActiveIntroSegments();
  const seg = findSkippableIntroAt(player.positionSecs, segments);
  if (!seg) return false;
  return executeSkipIntro(seg, deps);
}
