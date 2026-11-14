export function clampSeekTarget(targetSecs: number, durationSecs: number): number {
  if (!Number.isFinite(targetSecs)) {
    return 0;
  }
  const ceiling = durationSecs > 0 && Number.isFinite(durationSecs) ? durationSecs : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(ceiling, targetSecs));
}

/**
 * Fix 21: Rapid keyboard seek accumulator that adds deltas against any in-flight target
 * inside a short coalescing window rather than re-reading stale mpv position ticks.
 */
export class SeekAccumulator {
  private pendingTargetSecs: number | null = null;
  private lastDeltaAtMs = 0;

  constructor(private readonly windowMs = 450) {}

  step(deltaSecs: number, reportedPosSecs: number, durationSecs: number, nowMs = Date.now()): number {
    const base =
      this.pendingTargetSecs !== null && nowMs - this.lastDeltaAtMs <= this.windowMs
        ? this.pendingTargetSecs
        : reportedPosSecs;

    const clamped = clampSeekTarget(base + deltaSecs, durationSecs);
    this.pendingTargetSecs = clamped;
    this.lastDeltaAtMs = nowMs;
    return clamped;
  }

  currentTarget(nowMs = Date.now()): number | null {
    if (this.pendingTargetSecs !== null && nowMs - this.lastDeltaAtMs <= this.windowMs) {
      return this.pendingTargetSecs;
    }
    return null;
  }

  clear(): void {
    this.pendingTargetSecs = null;
    this.lastDeltaAtMs = 0;
  }
}
