import { useAppStore, type OutroNextMode } from "../store/useAppStore";
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

export interface ResolveActiveOutroInput {
  loaded: boolean;
  hasNextEpisode: boolean;
  outroNextMode: OutroNextMode;
  lockedForLocalUser: boolean;
  popoverOpen: boolean;
  positionSecs: number;
  durationSecs: number;
  videoKey: string | null;
  detectedOutro: DetectedIntro | null;
  introActive?: boolean;
  dismissedOutroKeys: readonly string[];
}

export interface ActiveOutroPrompt {
  outroKey: string;
  startSecs: number;
  endSecs: number;
  isDetectedOutro: boolean;
}

/**
 * Resolves whether the floating "Next Episode" pill should show right now because playback has
 * entered either the detected outro/ED segment or the near-end closing fallback window.
 */
export function resolveActiveOutroPrompt(
  input: ResolveActiveOutroInput,
): ActiveOutroPrompt | null {
  if (
    !input.loaded ||
    !input.hasNextEpisode ||
    input.outroNextMode === "off" ||
    input.lockedForLocalUser ||
    input.popoverOpen ||
    input.introActive
  ) {
    return null;
  }
  if (
    !Number.isFinite(input.positionSecs) ||
    input.positionSecs < 0 ||
    !Number.isFinite(input.durationSecs) ||
    input.durationSecs <= 0
  ) {
    return null;
  }

  if (input.detectedOutro) {
    const enterAt = Math.max(0, input.detectedOutro.startSecs - 1.0);
    const reachesTail = input.detectedOutro.endSecs >= input.durationSecs - 25;
    const inRange =
      input.positionSecs >= enterAt &&
      (reachesTail
        ? input.positionSecs <= input.durationSecs
        : input.positionSecs < input.detectedOutro.endSecs - 0.5);
    if (!inRange) return null;

    const outroKey = buildIntroSegmentKey(input.videoKey, input.detectedOutro);
    if (input.dismissedOutroKeys.includes(outroKey)) return null;
    return {
      outroKey,
      startSecs: input.detectedOutro.startSecs,
      endSecs: input.detectedOutro.endSecs,
      isDetectedOutro: true,
    };
  }

  if (input.durationSecs < 90) {
    return null;
  }
  const fallbackWindowSecs = Math.min(40, Math.max(15, Math.round(input.durationSecs * 0.035)));
  const startSecs = Math.max(5, input.durationSecs - fallbackWindowSecs);
  if (input.positionSecs < startSecs) {
    return null;
  }
  const outroKey = `${input.videoKey ?? ""}::outroFallback::${Math.round(startSecs * 10)}`;
  if (input.dismissedOutroKeys.includes(outroKey)) {
    return null;
  }
  return {
    outroKey,
    startSecs,
    endSecs: input.durationSecs,
    isDetectedOutro: false,
  };
}
