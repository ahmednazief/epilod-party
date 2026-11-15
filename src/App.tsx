import { useEffect } from "react";
import { SettingsModal } from "./components/SettingsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { HomeScreen } from "./components/HomeScreen";
import { WatchRoom } from "./components/WatchRoom";
import { isDesktop } from "./lib/bridge";
import { enqueueMpvLifecycle, mpvStop } from "./lib/mpv";
import { isTextEntryElement } from "./lib/shortcuts";
import { useAppStore } from "./store/useAppStore";
import { usePlayerStore } from "./store/usePlayerStore";
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
    if (!isDesktop()) return;
    if (useAppStore.getState().screen === "home") {
      usePlayerStore.getState().setEngineSurfaceVisible(false);
      void enqueueMpvLifecycle(() => mpvStop().catch(() => undefined));
    }
  }, []);

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

  if (screen === "room") {
    return (
      <div
        className="h-full w-full"
        onContextMenu={(e) => {
          if (!isTextEntryElement(e.target)) e.preventDefault();
        }}
      >
        <WatchRoom />
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
      <HomeScreen />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
      <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}

export default App;
