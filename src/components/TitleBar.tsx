import { getCurrentWindow } from "@tauri-apps/api/window";
import { Download, Minus, RefreshCw, RotateCw, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { isDesktop } from "../lib/bridge";
import { useAppStore } from "../store/useAppStore";
import { useUpdaterStore } from "../store/useUpdaterStore";

interface TitleBarProps {
  leftSlot: ReactNode;
  rightActions?: ReactNode;
  onOpenUpdates?: () => void;
}

export function TitleBar({ leftSlot, rightActions, onOpenUpdates }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  const openSettings = useAppStore((s) => s.openSettings);
  const updateStatus = useUpdaterStore((s) => s.status);
  const updateProgress = useUpdaterStore((s) => s.progress);
  const isDownloadingUpdate = useUpdaterStore((s) => s.isDownloading);
  const isUpdatePaused = useUpdaterStore((s) => s.isPaused);
  const isApplyingUpdate = useUpdaterStore((s) => s.isApplying);
  const updateError = useUpdaterStore((s) => s.error);
  const applyAndRestartUpdate = useUpdaterStore((s) => s.applyAndRestart);

  const handleOpenUpdates = () => {
    if (onOpenUpdates) {
      onOpenUpdates();
    } else {
      openSettings("updates");
    }
  };

  const availableRelease = updateStatus?.availableRelease ?? null;
  const availability = updateStatus?.availability;

  useEffect(() => {
    if (!isDesktop()) return;
    let active = true;
    let unlisten: (() => void) | null = null;

    const bind = async () => {
      try {
        const win = getCurrentWindow();
        const max = await win.isMaximized();
        if (active) setIsMaximized(max);
        const fn = await win.onResized(async () => {
          try {
            const next = await win.isMaximized();
            if (active) setIsMaximized(next);
          } catch {
            // Ignore resize query failure during teardown
          }
        });
        if (active) unlisten = fn;
        else fn();
      } catch {
        // Ignore outside Tauri runtime
      }
    };

    void bind();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const handleMinimize = async () => {
    if (!isDesktop()) return;
    await getCurrentWindow().minimize();
  };

  const handleToggleMaximize = async () => {
    if (!isDesktop()) return;
    const win = getCurrentWindow();
    await win.toggleMaximize();
    try {
      setIsMaximized(await win.isMaximized());
    } catch {
      // Ignore state refresh failure
    }
  };

  const handleClose = async () => {
    if (!isDesktop()) return;
    await getCurrentWindow().close();
  };

  return (
    <header className="h-[46px] shrink-0 flex items-center select-none px-4 pt-1">
      <div className="flex items-center gap-2.5 min-w-0 pr-3 h-full">
        {leftSlot}
      </div>

      <div
        data-tauri-drag-region
        className="flex-1 h-full min-w-8"
        aria-hidden="true"
      />

      <div className="flex items-center gap-2 h-full shrink-0">
        {isDownloadingUpdate ? (
          <button
            type="button"
            onClick={handleOpenUpdates}
            title={updateProgress?.message || "Downloading update in background"}
            className="ep-glass-pill ep-press border border-accent-soft/45 bg-accent/18 hover:bg-accent/28 inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium text-white cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5 text-accent-soft animate-spin shrink-0" />
            <span>
              {updateProgress?.stage === "verifying"
                ? "Verifying Update..."
                : `Updating · ${Math.max(0, Math.min(100, Math.round(updateProgress?.percent ?? 0)))}%`}
            </span>
          </button>
        ) : availability === "downloadedReady" && availableRelease ? (
          <div className="ep-glass-pill inline-flex items-center gap-1.5 pl-2.5 pr-1 py-0.5 rounded-full border border-ok/40 bg-ok/14">
            <button
              type="button"
              onClick={handleOpenUpdates}
              title={`View Epilod Party v${availableRelease.version} release details`}
              className="ep-press inline-flex items-center gap-1.5 text-[11.5px] font-medium text-white hover:text-accent-soft cursor-pointer"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse shrink-0" />
              <span>Update Ready · v{availableRelease.version}</span>
            </button>
            <button
              type="button"
              disabled={isApplyingUpdate}
              onClick={() => void applyAndRestartUpdate()}
              title={`Restart now and install Epilod Party v${availableRelease.version}`}
              className="ep-press inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-ok/30 hover:bg-ok/45 border border-ok/45 text-[11px] font-semibold text-white cursor-pointer disabled:opacity-60"
            >
              <RotateCw className={`h-3 w-3 ${isApplyingUpdate ? "animate-spin" : ""}`} />
              <span>{isApplyingUpdate ? "Restarting..." : "Restart"}</span>
            </button>
          </div>
        ) : availability === "updateAvailable" && availableRelease ? (
          <button
            type="button"
            onClick={handleOpenUpdates}
            title={`Update available: Epilod Party v${availableRelease.version}`}
            className="ep-glass-pill ep-press border border-accent-soft/45 bg-accent/18 hover:bg-accent/28 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-white cursor-pointer"
          >
            <Download className="h-3.5 w-3.5 text-accent-soft shrink-0" />
            <span>
              {isUpdatePaused
                ? `Update Paused · v${availableRelease.version}`
                : updateError
                  ? `Update Retry · v${availableRelease.version}`
                  : `Update Available · v${availableRelease.version}`}
            </span>
          </button>
        ) : null}

        {rightActions && (
          <div className="flex items-center gap-2">
            {rightActions}
          </div>
        )}

        <div className="flex items-center gap-1 pl-1">
          <button
            type="button"
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => void handleMinimize()}
            className="ep-press h-7 w-7 rounded-full inline-flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            title={isMaximized ? "Restore" : "Maximize"}
            onClick={() => void handleToggleMaximize()}
            className="ep-press h-7 w-7 rounded-full inline-flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
          >
            {isMaximized ? (
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M2.5 2.5V0.75H9.25V7.5H7.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="0.75"
                  y="2.5"
                  width="6.75"
                  height="6.75"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            ) : (
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                aria-hidden="true"
              >
                <rect
                  x="0.8"
                  y="0.8"
                  width="8.4"
                  height="8.4"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            )}
          </button>

          <button
            type="button"
            aria-label="Close window"
            title="Close"
            onClick={() => void handleClose()}
            className="ep-press h-7 w-7 rounded-full inline-flex items-center justify-center text-secondary hover:text-[#FCA5A5] hover:bg-[#FCA5A5]/15 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
