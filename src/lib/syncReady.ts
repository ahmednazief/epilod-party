/**
 * Fix 08: Readiness gating & auto-ready transition helpers.
 */
export function canToggleReady(loaded: boolean): boolean {
  return loaded;
}

export function resolveReadyToggleTarget(
  loaded: boolean,
  currentReady: boolean,
): boolean | null {
  if (!loaded) {
    return null;
  }
  return !currentReady;
}

export function shouldAutoReadyOnFileLoad(params: {
  syncConnected: boolean;
  loaded: boolean;
  alreadyAutoMarked: boolean;
}): boolean {
  return params.syncConnected && params.loaded && !params.alreadyAutoMarked;
}
