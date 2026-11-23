import { getCurrentWindow, LogicalSize, PhysicalSize } from "@tauri-apps/api/window";
import { PictureInPicture2, Pin } from "lucide-react";
import {
  AppCloseIcon,
  AppDownloadIcon,
  AppMaximizeIcon,
  AppMinimizeIcon,
  AppResetIcon,
  AppUpdateProgressIcon,
} from "./ui/AppIcons";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { isDesktop } from "../lib/bridge";
import { windowDragFromMaximized } from "../lib/mpv";
import { useAppStore } from "../store/useAppStore";
import { useUpdaterStore } from "../store/useUpdaterStore";

function isTitleBarInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"]',
    ),
  );
}

// Kept at module scope so exiting WatchRoom while in mini mode still restores
// the pre-mini window dimensions after TitleBar remounts on HomeScreen.
let savedMiniBounds: { width: number; height: number; wasMaximized: boolean } | null = null;

interface TitleBarProps {
  leftSlot: ReactNode;
  rightActions?: ReactNode;
  onOpenUpdates?: () => void;
  glassControls?: boolean;
}

export function TitleBar({ leftSlot, rightActions, onOpenUpdates, glassControls = false }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const openSettings = useAppStore((s) => s.openSettings);
  const screen = useAppStore((s) => s.screen);
  const alwaysOnTop = useAppStore((s) => s.alwaysOnTop);
  const miniMode = useAppStore((s) => s.miniMode);
  const setAlwaysOnTop = useAppStore((s) => s.setAlwaysOnTop);
  const setMiniMode = useAppStore((s) => s.setMiniMode);
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
        if (useAppStore.getState().alwaysOnTop) {
          await win.setAlwaysOnTop(true);
        }
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
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
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

  const handleToggleAlwaysOnTop = async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    if (!isDesktop()) return;
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
    } catch {
      // Ignore outside Tauri runtime
    }
  };

  const handleToggleMiniMode = async () => {
    const next = !miniMode;
    setMiniMode(next);
    if (!isDesktop()) return;
    try {
      const win = getCurrentWindow();
      if (next) {
        const wasMax = await win.isMaximized();
        if (wasMax) {
          await win.unmaximize();
        }
        const size = await win.innerSize();
        savedMiniBounds = {
          width: size.width,
          height: size.height,
          wasMaximized: wasMax,
        };
        await win.setMinSize(new LogicalSize(360, 200));
        await win.setSize(new LogicalSize(480, 270));
        await win.setAlwaysOnTop(true);
      } else {
        const prev = savedMiniBounds;
        savedMiniBounds = null;
        await win.setMinSize(new LogicalSize(1024, 640));
        await win.setAlwaysOnTop(useAppStore.getState().alwaysOnTop);
        if (prev) {
          await win.setSize(new PhysicalSize(prev.width, prev.height));
          if (prev.wasMaximized) {
            await win.maximize();
          }
        }
      }
      window.dispatchEvent(new Event("resize"));
    } catch {
      // Ignore outside Tauri runtime
    }
  };

  useEffect(() => {
    // Leaving the room while in mini mode must restore the normal window size.
    if (screen !== "room" && miniMode) {
      void handleToggleMiniMode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, miniMode]);

  const handleMaximizedTitleMouseDown = (e: ReactMouseEvent<HTMLElement>) => {
    if (!isDesktop() || !isMaximized || e.button !== 0 || isTitleBarInteractiveTarget(e.target)) {
      return;
    }
    if (e.detail === 2) {
      e.preventDefault();
      void handleToggleMaximize();
      return;
    }
    if (e.detail !== 1) return;

    e.preventDefault();
    dragCleanupRef.current?.();
    const startX = e.screenX;
    const startY = e.screenY;

    const cleanup = () => {
      window.removeEventListener("mousemove", handleMove, true);
      window.removeEventListener("mouseup", handleUp, true);
      window.removeEventListener("blur", handleUp);
      if (dragCleanupRef.current === cleanup) {
        dragCleanupRef.current = null;
      }
    };

    const handleUp = () => {
      cleanup();
    };

    const handleMove = (moveEv: MouseEvent) => {
      if ((moveEv.buttons & 1) === 0) {
        cleanup();
        return;
      }
      if (Math.hypot(moveEv.screenX - startX, moveEv.screenY - startY) >= 4) {
        cleanup();
        setIsMaximized(false);
        void windowDragFromMaximized().catch(() => undefined);
      }
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("mousemove", handleMove, true);
    window.addEventListener("mouseup", handleUp, true);
    window.addEventListener("blur", handleUp);
  };

  return (
    <header
      data-tauri-drag-region={isMaximized ? "false" : "deep"}
      onMouseDown={handleMaximizedTitleMouseDown}
      className="h-[46px] shrink-0 flex items-center select-none px-4 pt-1"
    >
      <div className="flex items-center gap-2.5 min-w-0 pr-3 h-full">
        {leftSlot}
      </div>

      <div
        className="flex-1 h-full min-w-2"
        aria-hidden="true"
      />

      <div className="flex items-center gap-2 h-full shrink-0">
        {isDownloadingUpdate ? (
          <button
            type="button"
            data-glass-region={glassControls ? "true" : undefined}
            onClick={handleOpenUpdates}
            aria-label={
              isVerifying
                ? "Updating — Verifying package 100%"
                : `Updating${availableRelease ? ` v${availableRelease.version}` : ""} (${rawPercent}%)`
            }
            title={updateProgress?.message || "Downloading update in background"}
            className="ep-glass-pill ep-update-pill ep-press relative overflow-hidden h-7 pl-2 pr-2.5 rounded-full inline-flex items-center gap-2 text-xs font-medium text-white cursor-pointer"
          >
            <AppUpdateProgressIcon
              progress={progressFraction}
              verifying={isVerifying}
              size={16}
              className="shrink-0"
            />
            <span className="text-[11.5px] font-medium text-white whitespace-nowrap">
              {isVerifying ? (
                <>
                  <span className="hidden sm:inline">Verifying Update</span>
                  <span className="sm:hidden">Verifying</span>
                </>
              ) : (
                <>
                  <span className="hidden sm:inline">
                    {`Updating${availableRelease ? ` v${availableRelease.version}` : ""}`}
                  </span>
                  <span className="sm:hidden">
                    {availableRelease ? `v${availableRelease.version}` : "Updating"}
                  </span>
                </>
              )}
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
            <span className="num text-[11px] font-semibold text-accent-soft shrink-0">
              {isVerifying ? 100 : rawPercent}%
            </span>
          </button>
        ) : availability === "downloadedReady" && availableRelease ? (
          <div
            data-glass-region={glassControls ? "true" : undefined}
            className="ep-glass-pill ep-update-pill h-7 pl-2.5 pr-[2px] rounded-full inline-flex items-center gap-2"
          >
            <button
              type="button"
              onClick={handleOpenUpdates}
              title={`View Epilod Party v${availableRelease.version} release details`}
              className="ep-press inline-flex items-center gap-1.5 text-[11.5px] font-medium text-white hover:text-accent-soft cursor-pointer"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse shrink-0" />
              <span className="whitespace-nowrap">
                <span className="hidden sm:inline">Update Ready · </span>v{availableRelease.version}
              </span>
            </button>
            <button
              type="button"
              disabled={isApplyingUpdate}
              onClick={() => void applyAndRestartUpdate()}
              title={`Restart now and install Epilod Party v${availableRelease.version}`}
              className="ep-glass-primary-pill ep-press h-5.5 px-2.5 rounded-full inline-flex items-center gap-1 text-[11px] font-semibold text-white cursor-pointer disabled:opacity-60 shrink-0"
            >
              <AppResetIcon clockwise size={12} className={isApplyingUpdate ? "animate-spin" : ""} />
              <span>{isApplyingUpdate ? "Restarting..." : "Restart"}</span>
            </button>
          </div>
        ) : availability === "updateAvailable" && availableRelease ? (
          <div
            data-glass-region={glassControls ? "true" : undefined}
            className="ep-glass-pill ep-update-pill h-7 pl-2.5 pr-[2px] rounded-full inline-flex items-center gap-2"
          >
            <button
              type="button"
              onClick={handleOpenUpdates}
              title={`Update available: Epilod Party v${availableRelease.version}`}
              className="ep-press inline-flex items-center gap-1.5 text-[11.5px] font-medium text-white hover:text-accent-soft cursor-pointer"
            >
              <AppDownloadIcon size={14} className="text-accent-soft shrink-0" />
              <span className="whitespace-nowrap">
                {isUpdatePaused ? (
                  <>
                    <span className="hidden sm:inline">Update Paused · </span>v{availableRelease.version}
                  </>
                ) : updateError ? (
                  <>
                    <span className="hidden sm:inline">Update Retry · </span>v{availableRelease.version}
                  </>
                ) : (
                  <>
                    <span className="hidden sm:inline">Update Available · </span>v{availableRelease.version}
                  </>
                )}
              </span>
              {isUpdatePaused && rawPercent > 0 && (
                <span className="num text-[11px] font-semibold text-accent-soft shrink-0">
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
          {screen === "room" && (
            <button
              type="button"
              aria-label={miniMode ? "Exit mini mode" : "Mini mode"}
              aria-pressed={miniMode}
              title={miniMode ? "Exit Mini Mode" : "Mini Mode (480×270)"}
              onClick={() => void handleToggleMiniMode()}
              className={`ep-bar-icon-btn h-7 w-7 rounded-full inline-flex items-center justify-center cursor-pointer ${
                miniMode ? "text-accent-soft bg-white/[0.12]" : "text-white/70 hover:text-white"
              }`}
            >
              <PictureInPicture2 size={13} />
            </button>
          )}

          <button
            type="button"
            aria-label={alwaysOnTop ? "Unpin window from top" : "Keep window always on top"}
            aria-pressed={alwaysOnTop}
            title={alwaysOnTop ? "Always on top: On" : "Always on top"}
            onClick={() => void handleToggleAlwaysOnTop()}
            className={`ep-bar-icon-btn h-7 w-7 rounded-full inline-flex items-center justify-center cursor-pointer ${
              alwaysOnTop ? "text-accent-soft bg-white/[0.12]" : "text-white/70 hover:text-white"
            }`}
          >
            <Pin size={13} />
          </button>

          <button
            type="button"
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => void handleMinimize()}
            className="ep-bar-icon-btn h-7 w-7 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white cursor-pointer"
          >
            <AppMinimizeIcon size={14} />
          </button>

          <button
            type="button"
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            title={isMaximized ? "Restore" : "Maximize"}
            onClick={() => void handleToggleMaximize()}
            className="ep-bar-icon-btn h-7 w-7 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white cursor-pointer"
          >
            <AppMaximizeIcon restored={isMaximized} size={13} />
          </button>

          <button
            type="button"
            aria-label="Close window"
            title="Close"
            onClick={() => void handleClose()}
            className="ep-press h-7 w-7 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white hover:bg-bad/80 cursor-pointer"
          >
            <AppCloseIcon size={14} />
          </button>
        </div>
      </div>
    </header>
  );
}
