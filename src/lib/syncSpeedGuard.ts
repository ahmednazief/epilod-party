/**
 * Fix 09: Prevent playback speed drift across synced peers (preserving calibrated FPS scale).
 */
export function canChangePlaybackSpeed(
  syncConnected: boolean,
  speed: number,
  targetSpeed = 1.0,
): boolean {
  if (!syncConnected) {
    return true;
  }
  const safeTarget = Number.isFinite(targetSpeed) && targetSpeed > 0 ? targetSpeed : 1.0;
  return Math.abs(speed - safeTarget) < 0.001;
}

export function getLockedPlaybackSpeed(
  syncConnected: boolean,
  desiredSpeed: number,
  targetSpeed = 1.0,
): number {
  const safeTarget = Number.isFinite(targetSpeed) && targetSpeed > 0 ? targetSpeed : 1.0;
  return syncConnected ? safeTarget : desiredSpeed;
}

export function shouldResetSpeedForSync(
  syncConnected: boolean,
  currentSpeed: number,
  targetSpeed = 1.0,
): boolean {
  const safeTarget = Number.isFinite(targetSpeed) && targetSpeed > 0 ? targetSpeed : 1.0;
  return syncConnected && Math.abs(currentSpeed - safeTarget) >= 0.001;
}
