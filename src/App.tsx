import { getCurrentWindow } from "@tauri-apps/api/window";
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { HomeScreen } from "./components/HomeScreen";
import { NotificationStrip } from "./components/ui/NotificationStrip";
import { AppLiquidGlassDefs } from "./components/ui/AppIcons";

function lazyWithRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await loader();
    } catch {
      await new Promise((r) => window.setTimeout(r, 250));
      return loader();
    }
  });
}

const loadWatchRoom = () =>
  import("./components/WatchRoom").then((m) => ({ default: m.WatchRoom }));

const WatchRoom = lazyWithRetry(loadWatchRoom);
const SettingsModal = lazyWithRetry(() =>
  import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal })),
);
const ShortcutsModal = lazyWithRetry(() =>
  import("./components/ShortcutsModal").then((m) => ({ default: m.ShortcutsModal })),
);
import { isDesktop } from "./lib/bridge";
import { bootstrapUserdataStorage, scheduleUserdataSync } from "./lib/dataBackup";
import { enqueueMpvLifecycle, mpvStop, setAllowNetworkShares } from "./lib/mpv";
import { subscribeOpenFile } from "./lib/openFile";
import { subscribeAppDeepLinks } from "./lib/roomJoinHelper";
import { isTextEntryElement } from "./lib/shortcuts";
import { useAppStore } from "./store/useAppStore";
import { usePlayerStore } from "./store/usePlayerStore";
import { useRatingStore } from "./store/useRatingStore";
import { useRecentRoomsStore } from "./store/useRecentRoomsStore";
import { useResumeStore } from "./store/useResumeStore";
import { useSeriesProgressStore } from "./store/useSeriesProgressStore";
import { useUpdaterStore } from "./store/useUpdaterStore";

const PERIODIC_UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;

export function App() {
  const screen = useAppStore((s) => s.screen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const closeShortcuts = useAppStore((s) => s.closeShortcuts);
  const autoCheckUpdates = useAppStore((s) => s.autoCheckUpdates);
  const autoDownloadUpdates = useAppStore((s) => s.autoDownloadUpdates);
  const allowNetworkShares = useAppStore((s) => s.allowNetworkShares);

  const [settingsEverOpened, setSettingsEverOpened] = useState(settingsOpen);
  const [shortcutsEverOpened, setShortcutsEverOpened] = useState(shortcutsOpen);

  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);

  useEffect(() => {
    if (shortcutsOpen) setShortcutsEverOpened(true);
  }, [shortcutsOpen]);

  useEffect(() => {
    if (!isDesktop()) return;
    let raf1 = 0;
    let raf2 = 0;
    let cancelled = false;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          const win = getCurrentWindow();
          void win
            .show()
            .then(() => win.setFocus())
            .catch(() => undefined);
        } catch {
          // Ignore outside Tauri runtime
        }
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, []);

  useEffect(() => {
    const syncVisibility = () => {
      if (typeof document !== "undefined") {
        document.documentElement.dataset.appHidden = document.hidden ? "true" : "false";
      }
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  useEffect(() => {
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === "function") {
      const id = win.requestIdleCallback(() => {
        void loadWatchRoom().catch(() => undefined);
      }, { timeout: 2500 });
      return () => win.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => {
      void loadWatchRoom().catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  const updateStatus = useUpdaterStore((s) => s.status);
  const isCheckingUpdate = useUpdaterStore((s) => s.isChecking);
  const isDownloadingUpdate = useUpdaterStore((s) => s.isDownloading);
  const isApplyingUpdate = useUpdaterStore((s) => s.isApplying);
  const userPausedVersion = useUpdaterStore((s) => s.userPausedVersion);
  const autoDownloadedVersion = useUpdaterStore((s) => s.autoDownloadedVersion);
  const updateError = useUpdaterStore((s) => s.error);
  const initUpdater = useUpdaterStore((s) => s.init);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const startUpdateDownload = useUpdaterStore((s) => s.startDownload);
  const markAutoDownloadAttempted = useUpdaterStore((s) => s.markAutoDownloadAttempted);

  useEffect(() => {
    void bootstrapUserdataStorage(useUpdaterStore.getState().status?.currentVersion ?? "0.1.5");
    const unsubs = [
      useAppStore.subscribe(() => scheduleUserdataSync()),
      useRatingStore.subscribe(() => scheduleUserdataSync()),
      useSeriesProgressStore.subscribe(() => scheduleUserdataSync()),
      useResumeStore.subscribe(() => scheduleUserdataSync()),
      useRecentRoomsStore.subscribe(() => scheduleUserdataSync()),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    if (useAppStore.getState().screen === "home") {
      usePlayerStore.getState().setEngineSurfaceVisible(false);
      void enqueueMpvLifecycle(() => mpvStop().catch(() => undefined));
    }
    const stopDeepLinks = subscribeAppDeepLinks();
    const stopOpenFile = subscribeOpenFile();
    return () => {
      stopDeepLinks();
      stopOpenFile();
    };
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    void setAllowNetworkShares(allowNetworkShares).catch(() => undefined);
  }, [allowNetworkShares]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await initUpdater();
      if (active && useAppStore.getState().autoCheckUpdates) {
        await checkForUpdates(true);
      }
    })();

    const timer = window.setInterval(() => {
      if (useAppStore.getState().autoCheckUpdates) {
        void checkForUpdates(true);
      }
    }, PERIODIC_UPDATE_CHECK_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [initUpdater, checkForUpdates, autoCheckUpdates]);

  useEffect(() => {
    if (!autoDownloadUpdates) return;
    if (updateStatus?.availability !== "updateAvailable") return;
    const version = updateStatus.availableRelease?.version;
    if (!version) return;
    if (isCheckingUpdate || isDownloadingUpdate || isApplyingUpdate || updateError) return;
    if (userPausedVersion === version || autoDownloadedVersion === version) return;

    const previewAutoDownload =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("autoDownload") === "1";
    if (!isDesktop() && !previewAutoDownload) return;

    markAutoDownloadAttempted(version);
    void startUpdateDownload();
  }, [
    autoDownloadUpdates,
    autoDownloadedVersion,
    isApplyingUpdate,
    isCheckingUpdate,
    isDownloadingUpdate,
    markAutoDownloadAttempted,
    startUpdateDownload,
    updateError,
    updateStatus,
    userPausedVersion,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTextEntryElement(e.target)) return;

      const appState = useAppStore.getState();
      if (e.key === "?" || (e.code === "Slash" && e.shiftKey)) {
        e.preventDefault();
        if (appState.shortcutsOpen) {
          appState.closeShortcuts();
        } else {
          appState.openShortcuts();
        }
        return;
      }

      if (appState.screen === "home" && e.code === "Escape") {
        if (appState.settingsOpen) {
          e.preventDefault();
          appState.closeSettings();
        } else if (appState.shortcutsOpen) {
          e.preventDefault();
          appState.closeShortcuts();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (screen === "room") {
    return (
      <div
        className="h-full w-full"
        onContextMenu={(e) => {
          if (!isTextEntryElement(e.target)) e.preventDefault();
        }}
      >
        <AppLiquidGlassDefs />
        <Suspense fallback={<div className="h-full w-full bg-canvas" />}>
          <WatchRoom />
        </Suspense>
      </div>
    );
  }

  return (
    <div
      className="h-full w-full"
      onContextMenu={(e) => {
        if (!isTextEntryElement(e.target)) e.preventDefault();
      }}
    >
      <AppLiquidGlassDefs />
      <HomeScreen />
      <NotificationStrip belowTitleBar />
      {(settingsOpen || settingsEverOpened) && (
        <Suspense fallback={null}>
          <SettingsModal open={settingsOpen} onClose={closeSettings} />
        </Suspense>
      )}
      {(shortcutsOpen || shortcutsEverOpened) && (
        <Suspense fallback={null}>
          <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
        </Suspense>
      )}
    </div>
  );
}

export default App;
