import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!position) {
      setCoords(null);
      return;
    }
    const pad = 12;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 720;
    const rect = menuRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 268;
    const height = rect?.height ?? 320;

    const left = Math.max(pad, Math.min(position.x, vw - width - pad));
    const top = Math.max(pad, Math.min(position.y, vh - height - pad));
    setCoords({ left, top });
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

  if (!position) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Player context menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{
        left: `${coords?.left ?? position.x}px`,
        top: `${coords?.top ?? position.y}px`,
      }}
      className="ep-glass-sheet anim-pop-in fixed z-50 w-[272px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded-[18px] p-1.5 select-none border border-white/[0.12]"
    >
      {entries.map((entry) => {
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
                  <Check className="h-3.5 w-3.5 text-ok" />
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
