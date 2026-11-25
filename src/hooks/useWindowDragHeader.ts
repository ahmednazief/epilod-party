import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { isDesktop } from "../lib/bridge";
import { windowDragFromMaximized } from "../lib/mpv";

function isHeaderInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"]',
    ),
  );
}

/**
 * Shared Tauri window header drag/maximize behavior so both TitleBar and
 * top-left docked sidebars support smooth drag-out-of-maximized and double-click toggle.
 */
export function useWindowDragHeader() {
  const [isMaximized, setIsMaximized] = useState(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

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
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    if (!isDesktop()) return;
    const win = getCurrentWindow();
    await win.toggleMaximize();
    try {
      setIsMaximized(await win.isMaximized());
    } catch {
      // Ignore state refresh failure
    }
  }, []);

  const handleMaximizedHeaderMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!isDesktop() || !isMaximized || e.button !== 0 || isHeaderInteractiveTarget(e.target)) {
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
    },
    [handleToggleMaximize, isMaximized],
  );

  return {
    isMaximized,
    handleToggleMaximize,
    handleMaximizedHeaderMouseDown,
  };
}
