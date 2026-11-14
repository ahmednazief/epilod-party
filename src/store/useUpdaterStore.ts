import { create } from "zustand";
import {
  applyAndRestartUpdate,
  cancelUpdateDownload,
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  onUpdateProgress,
  type AppUpdateStatus,
  type UpdateProgressEvent,
} from "../lib/updater";

interface UpdaterStoreState {
  status: AppUpdateStatus | null;
  progress: UpdateProgressEvent | null;
  isChecking: boolean;
  isDownloading: boolean;
  isPaused: boolean;
  isApplying: boolean;
  hasCheckedStartup: boolean;
  error: string | null;
  init: () => Promise<void>;
  checkForUpdates: (quiet?: boolean) => Promise<void>;
  startDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  applyAndRestart: () => Promise<void>;
  clearError: () => void;
}

let unlistenProgressPromise: Promise<() => void> | null = null;
let initStatusPromise: Promise<void> | null = null;
let statusRevision = 0;

function toErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const useUpdaterStore = create<UpdaterStoreState>((set, get) => ({
  status: null,
  progress: null,
  isChecking: false,
  isDownloading: false,
  isPaused: false,
  isApplying: false,
  hasCheckedStartup: false,
  error: null,

  init: async () => {
    if (!unlistenProgressPromise) {
      unlistenProgressPromise = onUpdateProgress((evt) => {
        if (evt.stage === "paused") {
          set({ progress: evt, isDownloading: false, isPaused: true, error: null });
          return;
        }
        if (evt.stage === "ready") {
          set({ progress: evt, isDownloading: false, isPaused: false });
          return;
        }
        set({ progress: evt, isPaused: false });
      }).catch(() => () => {});
    }

    if (get().status) return;
    if (initStatusPromise) {
      await initStatusPromise;
      return;
    }

    const revBefore = statusRevision;
    initStatusPromise = (async () => {
      try {
        const status = await getUpdateStatus();
        // Never overwrite a newer status fetched concurrently by checkForUpdates / downloadUpdate
        if (statusRevision === revBefore && !get().status) {
          statusRevision += 1;
          set({ status });
        }
      } catch {
        // Ignore initialization errors when offline/preview
      } finally {
        initStatusPromise = null;
      }
    })();

    await initStatusPromise;
  },

  checkForUpdates: async (quiet = false) => {
    if (get().isChecking || get().isDownloading || get().isApplying) return;
    set({
      isChecking: true,
      hasCheckedStartup: true,
      ...(get().isPaused ? {} : { progress: null }),
      ...(quiet ? {} : { error: null }),
    });
    try {
      const next = await checkForUpdates();
      statusRevision += 1;
      set({ status: next, ...(quiet ? {} : { error: null }) });
    } catch (err) {
      if (!quiet) {
        set({ error: toErrorMessage(err) });
      }
    } finally {
      set({ isChecking: false });
    }
  },

  startDownload: async () => {
    const current = get();
    if (current.isDownloading || current.isApplying) return;
    const manifest = current.status?.availableRelease ?? null;
    if (!manifest) return;

    await get().init();
    set({
      isDownloading: true,
      isPaused: false,
      error: null,
      progress: {
        stage: "downloading",
        downloadedBytes: current.progress?.downloadedBytes ?? 0,
        totalBytes: manifest.sizeBytes,
        percent: current.progress?.percent ?? 0,
        speedBps: 0,
        message: `Starting verified download for v${manifest.version}...`,
      },
    });

    try {
      const updated = await downloadUpdate(manifest);
      statusRevision += 1;
      set({
        status: updated,
        isDownloading: false,
        isPaused: false,
        error: null,
      });
    } catch (err) {
      const msg = toErrorMessage(err);
      if (msg.toLowerCase().includes("paused")) {
        set({
          isDownloading: false,
          isPaused: true,
          error: null,
        });
      } else {
        set({
          isDownloading: false,
          isPaused: false,
          progress: null,
          error: msg,
        });
      }
    }
  },

  cancelDownload: async () => {
    if (!get().isDownloading) return;
    try {
      await cancelUpdateDownload();
    } catch (err) {
      set({ error: toErrorMessage(err) });
    }
  },

  applyAndRestart: async () => {
    if (get().isApplying || get().isDownloading) return;
    set({ isApplying: true, error: null });
    try {
      await applyAndRestartUpdate();
    } catch (err) {
      set({ isApplying: false, error: toErrorMessage(err) });
    }
  },

  clearError: () => set({ error: null }),
}));
