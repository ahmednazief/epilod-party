import type { PhysicalRect } from "./mpv";

/**
 * Fix 15: Track whether viewport passed through collapsed (0x0) state during minimize
 * so restoring forces an unconditional HWND resize even back to identical dimensions.
 */
export class ViewportSyncTracker {
  private wasZero = false;
  private lastApplied: PhysicalRect | null = null;

  planResize(rect: PhysicalRect, force = false): { send: boolean; forceFlag: boolean } {
    if (rect.width <= 0 || rect.height <= 0) {
      this.wasZero = true;
      this.lastApplied = null;
      return { send: true, forceFlag: false };
    }

    const forceFlag = force || this.wasZero;
    const unchanged =
      !forceFlag &&
      this.lastApplied !== null &&
      this.lastApplied.x === rect.x &&
      this.lastApplied.y === rect.y &&
      this.lastApplied.width === rect.width &&
      this.lastApplied.height === rect.height;

    if (unchanged) {
      return { send: false, forceFlag: false };
    }

    this.wasZero = false;
    this.lastApplied = { ...rect };
    return { send: true, forceFlag };
  }

  markInvalidated(): void {
    this.wasZero = true;
    this.lastApplied = null;
  }
}
