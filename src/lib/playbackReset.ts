import { mpvSetAspectMode, mpvSetLoop, mpvSetSpeed, mpvSetSubDelay } from "./mpv";

/**
 * Fix 12: Reset transient per-video settings when switching to a different video file.
 */
export async function resetMpvPlaybackDefaults(_syncConnected?: boolean): Promise<void> {
  const tasks: Promise<void>[] = [
    mpvSetLoop(false),
    mpvSetAspectMode("auto"),
    mpvSetSubDelay(0),
    mpvSetSpeed(1.0),
  ];
  await Promise.allSettled(tasks);
}
