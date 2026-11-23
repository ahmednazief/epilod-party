import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop, safeInvoke } from "./bridge";
import { getFileDisplayName } from "./fileDrop";
import { scanMediaPaths } from "./playlist";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlaylistStore } from "../store/usePlaylistStore";

/** Window event used to hand an externally opened file to the active WatchRoom. */
export const OPEN_FILE_EVENT = "epilod:open-file";

export async function consumePendingOpenFile(): Promise<string | null> {
  return safeInvoke<string | null>("consume_pending_open_file");
}

export async function onOpenFile(handler: (path: string) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return () => {};
  return listen<string>("app://open-file", (event) => {
    if (typeof event.payload === "string" && event.payload) {
      handler(event.payload);
    }
  });
}

/** Loads a file opened via Windows "Open with" / double-click. */
export async function applyOpenedFile(path: string): Promise<void> {
  const app = useAppStore.getState();
  if (app.screen === "room") {
    // WatchRoom owns the player lifecycle; hand the path over like a drag-and-drop.
    window.dispatchEvent(new CustomEvent<string>(OPEN_FILE_EVENT, { detail: path }));
    return;
  }
  try {
    const scan = await scanMediaPaths([path]);
    if (scan.items.length > 0) {
      const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
      usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
      const target = scan.items[idx];
      app.setSelectedFile(target.path, target.fileName);
    } else {
      usePlaylistStore.getState().clearPlaylist();
      app.setSelectedFile(path, getFileDisplayName(path));
    }
    app.enterRoom("", false, false);
  } catch {
    useNotificationStore.getState().push("warn", "Could not open that video file.");
  }
}

let lastOpenedPath = "";
let lastOpenedAt = 0;

export function subscribeOpenFile(): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;

  const dispatchOnce = async (path: string) => {
    const now = Date.now();
    if (path === lastOpenedPath && now - lastOpenedAt < 1500) return;
    lastOpenedPath = path;
    lastOpenedAt = now;
    await consumePendingOpenFile().catch(() => null);
    await applyOpenedFile(path);
  };

  void (async () => {
    try {
      const fn = await onOpenFile((path) => {
        if (active) void dispatchOnce(path);
      });
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
      const initial = await consumePendingOpenFile();
      if (active && initial) await dispatchOnce(initial);
    } catch {
      // Ignore outside the Tauri runtime
    }
  })();

  return () => {
    active = false;
    unlisten?.();
  };
}