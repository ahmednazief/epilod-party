import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { isDesktop } from "../lib/bridge";

interface TitleBarProps {
  leftSlot: ReactNode;
  rightActions?: ReactNode;
}

export function TitleBar({ leftSlot, rightActions }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

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
