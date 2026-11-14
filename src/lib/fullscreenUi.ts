/**
 * Fix 14: Determine whether top chrome & side drawer remain collapsed in fullscreen
 * while keeping controls toggleable cleanly without DOM overlay over the child HWND.
 */
export function resolveFullscreenChromeState(params: {
  isFullscreen: boolean;
  panelOpen: boolean;
  modalsOpen: boolean;
}): {
  showTopBar: boolean;
  showPanel: boolean;
  showTransportBar: boolean;
} {
  if (!params.isFullscreen) {
    return {
      showTopBar: true,
      showPanel: params.panelOpen,
      showTransportBar: true,
    };
  }
  return {
    showTopBar: params.modalsOpen,
    showPanel: params.panelOpen,
    showTransportBar: true,
  };
}
