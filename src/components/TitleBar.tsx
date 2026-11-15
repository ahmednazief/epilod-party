import { getCurrentWindow } from "@tauri-apps/api/window";
import { Download, Minus, RotateCw, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { isDesktop } from "../lib/bridge";
import { useAppStore } from "../store/useAppStore";
import { useUpdaterStore } from "../store/useUpdaterStore";

interface TitleBarProps {
  leftSlot: ReactNode;
  rightActions?: ReactNode;
  onOpenUpdates?: () => void;
  glassControls?: boolean;
}

export function TitleBar({ leftSlot, rightActions, onOpenUpdates, glassControls = false }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  const openSettings = useAppStore((s) => s.openSettings);
  const updateStatus = useUpdaterStore((s) => s.status);
  const updateProgress = useUpdaterStore((s) => s.progress);
  const isDownloadingUpdate = useUpdaterStore((s) => s.isDownloading);
  const isUpdatePaused = useUpdaterStore((s) => s.isPaused);
  const isApplyingUpdate = useUpdaterStore((s) => s.isApplying);
  const updateError = useUpdaterStore((s) => s.error);
  const startUpdateDownload = useUpdaterStore((s) => s.startDownload);
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
  const rawPercent = Math.max(0, Math.min(100, Math.round(updateProgress?.percent ?? 0)));
  const progressFraction = rawPercent / 100;
  const isVerifying = updateProgress?.stage === "verifying";

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
            aria-label={
              isVerifying
                ? "Updating — Verifying package 100%"
                : `Updating${availableRelease ? ` v${availableRelease.version}` : ""} (${rawPercent}%)`
            }
            title={updateProgress?.message || "Downloading update in background"}
            className="ep-glass-pill ep-update-pill ep-press relative overflow-hidden h-7 pl-2 pr-1.5 rounded-full inline-flex items-center gap-2 text-xs font-medium text-white cursor-pointer"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              className="shrink-0"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="rgba(255,255,255,0.14)"
                strokeWidth="1.8"
                fill="none"
              />
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="var(--color-accent-soft)"
                strokeWidth="1.8"
                strokeLinecap="round"
                fill="none"
                strokeDasharray={37.7}
                strokeDashoffset={37.7 * (1 - (isVerifying ? 1 : progressFraction))}
                transform="rotate(-90 8 8)"
                className="transition-[stroke-dashoffset] duration-150 ease-out"
              />
              <circle
                cx="8"
                cy="8"
                r="1.8"
                fill="var(--color-accent-soft)"
                className={isVerifying ? "animate-pulse" : ""}
              />
            </svg>
            <span className="text-[11.5px] font-medium text-white whitespace-nowrap">
              {isVerifying
                ? "Verifying Update"
                : `Updating${availableRelease ? ` v${availableRelease.version}` : ""}`}
            </span>
            <span
              className="hidden sm:inline-flex h-1.5 w-14 rounded-full bg-white/12 overflow-hidden shrink-0"
              aria-hidden="true"
            >
              <span
                className="ep-scrubber-fill h-full w-full origin-left transition-transform duration-150 ease-out"
                style={{ transform: `scaleX(${isVerifying ? 1 : progressFraction})` }}
              />
            </span>
            <span className="ep-update-pct-badge num font-mono text-[11px] font-semibold text-accent-soft px-2 py-0.5 rounded-full shrink-0">
              {isVerifying ? 100 : rawPercent}%
            </span>
          </button>
        ) : availability === "downloadedReady" && availableRelease ? (
          <div
            data-glass-region={glassControls ? "true" : undefined}
            className="ep-glass-pill ep-update-pill h-7 pl-2.5 pr-1 rounded-full inline-flex items-center gap-2"
          >
            <button
              type="button"
              onClick={handleOpenUpdates}
              title={`View Epilod Party v${availableRelease.version} release details`}
              className="ep-press inline-flex items-center gap-1.5 text-[11.5px] font-medium text-white hover:text-accent-soft cursor-pointer"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse shrink-0" />
              <span className="whitespace-nowrap">Update Ready · v{availableRelease.version}</span>
              <span className="ep-update-pct-badge num font-mono text-[10.5px] font-semibold text-ok px-1.5 py-0.5 rounded-full shrink-0">
                100%
              </span>
            </button>
            <button
              type="button"
              disabled={isApplyingUpdate}
              onClick={() => void applyAndRestartUpdate()}
              title={`Restart now and install Epilod Party v${availableRelease.version}`}
              className="ep-glass-primary-pill ep-press h-5.5 px-2.5 rounded-full inline-flex items-center gap-1 text-[11px] font-semibold text-white cursor-pointer disabled:opacity-60 shrink-0"
            >
              <RotateCw className={`h-3 w-3 ${isApplyingUpdate ? "animate-spin" : ""}`} />
              <span>{isApplyingUpdate ? "Restarting..." : "Restart"}</span>
            </button>
          </div>
        ) : availability === "updateAvailable" && availableRelease ? (
          <div
            data-glass-region={glassControls ? "true" : undefined}
            className="ep-glass-pill ep-update-pill h-7 pl-2.5 pr-1 rounded-full inline-flex items-center gap-2"
          >
            <button
              type="button"
              onClick={handleOpenUpdates}
              title={`Update available: Epilod Party v${availableRelease.version}`}
              className="ep-press inline-flex items-center gap-1.5 text-[11.5px] font-medium text-white hover:text-accent-soft cursor-pointer"
            >
              <Download className="h-3.5 w-3.5 text-accent-soft shrink-0" />
              <span className="whitespace-nowrap">
                {isUpdatePaused
                  ? `Update Paused · v${availableRelease.version}`
                  : updateError
                    ? `Update Retry · v${availableRelease.version}`
                    : `Update Available · v${availableRelease.version}`}
              </span>
              {isUpdatePaused && rawPercent > 0 && (
                <span className="ep-update-pct-badge num font-mono text-[10.5px] font-semibold text-accent-soft px-1.5 py-0.5 rounded-full shrink-0">
                  {rawPercent}%
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void startUpdateDownload()}
              title={
                isUpdatePaused
                  ? `Resume downloading Epilod Party v${availableRelease.version}`
                  : `Download Epilod Party v${availableRelease.version} now`
              }
              className="ep-glass-primary-pill ep-press h-5.5 px-2.5 rounded-full inline-flex items-center gap-1 text-[11px] font-semibold text-white cursor-pointer shrink-0"
            >
              <span>{isUpdatePaused ? "Resume" : "Update"}</span>
            </button>
          </div>
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
            className="ep-bar-icon-btn h-7 w-7 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            title={isMaximized ? "Restore" : "Maximize"}
            onClick={() => void handleToggleMaximize()}
            className="ep-bar-icon-btn h-7 w-7 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
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
            className="h-7 w-7 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white hover:bg-bad/80 active:scale-92 transition-[background-color,color,transform] duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
