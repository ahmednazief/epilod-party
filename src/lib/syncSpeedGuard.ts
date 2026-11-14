/**
 * Fix 09: Prevent playback speed drift across synced peers.
 */
export function canChangePlaybackSpeed(syncConnected: boolean, speed: number): boolean {
  if (!syncConnected) {
    return true;
  }
  return Math.abs(speed - 1.0) < 0.001;
}

export function getLockedPlaybackSpeed(syncConnected: boolean, desiredSpeed: number): number {
  return syncConnected ? 1.0 : desiredSpeed;
}

export function shouldResetSpeedForSync(syncConnected: boolean, currentSpeed: number): boolean {
  return syncConnected && Math.abs(currentSpeed - 1.0) >= 0.001;
}
