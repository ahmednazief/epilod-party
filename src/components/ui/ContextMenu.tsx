import { AppCheckIcon } from "./AppIcons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePresencePayload } from "../../lib/useAnimatedPresence";

export type ContextMenuEntry =
  | {
      type: "divider";
      id: string;
    }
  | {
      type: "label";
      id: string;
      text: string;
    }
  | {
      type?: "item";
      id: string;
      label: string;
      shortcut?: string;
      icon?: ReactNode;
      checked?: boolean;
      disabled?: boolean;
      accent?: boolean;
      onSelect: () => void;
    };

interface ContextMenuProps {
  position: { x: number; y: number } | null;
  entries: ContextMenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ position, entries, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number; maxHeight: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!position) return;
    const pad = 12;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 720;
    const rect = menuRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 268;
    const height = rect?.height ?? 320;

    // Always keep the bottom of the right-click menu cleanly above the play bar
    let maxBottom = vh - pad;
    const barCandidates = document.querySelectorAll<HTMLElement>('[data-capsule-bar="true"]');
    const capsules =
      barCandidates.length > 0
        ? barCandidates
        : document.querySelectorAll<HTMLElement>(".ep-glass-capsule");
    capsules.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) <= 0.05
      ) {
        return;
      }
      const cr = el.getBoundingClientRect();
      if (cr.height > 20 && cr.top > vh * 0.35) {
        maxBottom = Math.min(maxBottom, cr.top - 14);
      }
    });

    const left = Math.max(pad, Math.min(position.x, vw - width - pad));
    const top = Math.max(pad, Math.min(position.y, maxBottom - height));
    const maxHeight = Math.max(160, Math.floor(maxBottom - top));
    setCoords({ left, top, maxHeight });
  }, [position, entries.length]);

  useEffect(() => {
    if (!position) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const handleBlur = () => onClose();

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [onClose, position]);

  const activeMenu = position ? { position, entries } : null;
  const { mounted, exiting, value: renderedMenu } = usePresencePayload(activeMenu, 170);

  if (!mounted || !renderedMenu) return null;

  const activePosition = renderedMenu.position;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Player context menu"
      data-glass-region="true"
      onContextMenu={(e) => e.preventDefault()}
      style={{
        left: `${coords?.left ?? activePosition.x}px`,
        top: `${coords?.top ?? activePosition.y}px`,
        maxHeight: coords ? `${coords.maxHeight}px` : undefined,
      }}
      className={`ep-glass-sheet ${
        exiting ? "anim-pop-out pointer-events-none" : "anim-pop-in"
      } fixed z-50 w-[272px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-[18px] p-1.5 select-none border border-white/[0.12]`}
    >
      {renderedMenu.entries.map((entry) => {
        if (entry.type === "divider") {
          return <div key={entry.id} className="ep-hairline-divider my-1 mx-1.5" role="separator" />;
        }
        if (entry.type === "label") {
          return (
            <div
              key={entry.id}
              className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted"
            >
              {entry.text}
            </div>
          );
        }

        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
            className={`ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs cursor-pointer disabled:opacity-35 disabled:pointer-events-none ${
              entry.accent ? "text-accent-soft font-medium" : "text-primary/95 hover:text-white"
            }`}
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
                {entry.checked ? (
                  <AppCheckIcon size={14} className="text-ok" />
                ) : (
                  entry.icon
                )}
              </span>
              <span className="truncate">{entry.label}</span>
            </span>

            {entry.shortcut && (
              <kbd className="ep-glass-input px-1.5 py-0.5 text-[10px] font-medium text-secondary rounded-md shrink-0">
                {entry.shortcut}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}
