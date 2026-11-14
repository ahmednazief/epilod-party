export interface CrashSyncHooks {
  syncConnected: boolean;
  wasPaused: boolean;
  positionSecs: number;
  setLocalReady: (ready: boolean) => void;
  syncSetReady: (ready: boolean, manual: boolean) => Promise<void>;
  syncUserPause: (pos: number) => Promise<void>;
  clearAnnouncementCache: () => void;
}

/**
 * Fix 17: When mpv.exe stops/crashes mid-playback while synced, clear localReady
 * and pause Syncplay state cleanly so peers do not stay blocked or out of sync.
 */
export async function handlePlayerCrashSync(hooks: CrashSyncHooks): Promise<void> {
  hooks.clearAnnouncementCache();
  hooks.setLocalReady(false);
  if (!hooks.syncConnected) {
    return;
  }
  await Promise.allSettled([
    hooks.syncSetReady(false, false),
    !hooks.wasPaused ? hooks.syncUserPause(hooks.positionSecs) : Promise.resolve(),
  ]);
}

/**
 * Fix 16: Separate native file dialog open state from video loading so
 * drops arriving while an OS file dialog is open surface a clear prompt.
 */
export function checkDropDuringDialog(dialogOpen: boolean): {
  allowed: boolean;
  notice: string | null;
} {
  if (dialogOpen) {
    return {
      allowed: false,
      notice: "Close the file dialog first to drop a file.",
    };
  }
  return { allowed: true, notice: null };
}
