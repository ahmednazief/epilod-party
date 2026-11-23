import { AppCheckIcon, AppChevronIcon } from "./AppIcons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresencePayload } from "../../lib/useAnimatedPresence";

export interface ContextMenuItemEntry {
  type?: "item";
  id: string;
  label: string;
  shortcut?: string;
  badge?: string;
  icon?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  accent?: boolean;
  closeOnSelect?: boolean;
  onSelect: () => void;
}

export interface ContextMenuSubmenuEntry {
  type: "submenu";
  id: string;
  label: string;
  badge?: string;
  icon?: ReactNode;
  disabled?: boolean;
  accent?: boolean;
  children: ContextMenuEntry[];
}

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
  | ContextMenuItemEntry
  | ContextMenuSubmenuEntry;

interface ContextMenuProps {
  position: { x: number; y: number } | null;
  entries: ContextMenuEntry[];
  onClose: () => void;
}

interface MenuBoxCoords {
  left: number;
  top: number;
  maxHeight: number;
}

interface SubmenuTriggerState {
  id: string;
  rect: { left: number; right: number; top: number; bottom: number };
}

function measureClearBounds() {
  const pad = 12;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;

  let minTop = pad;
  document.querySelectorAll<HTMLElement>("header").forEach((elBar) => {
    const hr = elBar.getBoundingClientRect();
    if (hr.height < 16 || hr.top > vh * 0.25) return;
    let cur: HTMLElement | null = elBar;
    let visible = true;
    while (cur && cur !== document.documentElement) {
      const s = window.getComputedStyle(cur);
      if (s.display === "none" || s.visibility === "hidden" || Number.parseFloat(s.opacity) <= 0.05) {
        visible = false;
        break;
      }
      cur = cur.parentElement;
    }
    if (visible) {
      minTop = Math.max(minTop, Math.ceil(hr.bottom) + 8);
    }
  });

  let maxBottom = vh - pad;
  const barCandidates = document.querySelectorAll<HTMLElement>('[data-capsule-bar="true"]');
  const capsules =
    barCandidates.length > 0
      ? barCandidates
      : document.querySelectorAll<HTMLElement>(".ep-glass-capsule");
  capsules.forEach((barEl) => {
    const style = window.getComputedStyle(barEl);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number.parseFloat(style.opacity) <= 0.05
    ) {
      return;
    }
    const cr = barEl.getBoundingClientRect();
    if (cr.height > 20 && cr.top > vh * 0.35) {
      maxBottom = Math.min(maxBottom, cr.top - 14);
    }
  });

  return { pad, vw, vh, minTop, maxBottom };
}

function findEntryById(entries: readonly ContextMenuEntry[], id: string): ContextMenuSubmenuEntry | null {
  for (const entry of entries) {
    if (entry.type === "submenu" && entry.id === id) {
      return entry;
    }
  }
  return null;
}

export function ContextMenu({ position, entries, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuScrollRef = useRef<HTMLDivElement | null>(null);
  const subMenuRef = useRef<HTMLDivElement | null>(null);
  const subScrollRef = useRef<HTMLDivElement | null>(null);
  const closeSubTimerRef = useRef<number | null>(null);
  const [coords, setCoords] = useState<MenuBoxCoords | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<SubmenuTriggerState | null>(null);
  const [subCoords, setSubCoords] = useState<MenuBoxCoords | null>(null);

  const clearSubmenuTimer = () => {
    if (closeSubTimerRef.current !== null) {
      window.clearTimeout(closeSubTimerRef.current);
      closeSubTimerRef.current = null;
    }
  };

  useEffect(() => {
    clearSubmenuTimer();
    setOpenSubmenu(null);
    setSubCoords(null);
  }, [position]);

  useEffect(() => () => clearSubmenuTimer(), []);

  useLayoutEffect(() => {
    if (!position) return;
    const { pad, vw, minTop, maxBottom } = measureClearBounds();
    const el = menuRef.current;
    const scrollEl = menuScrollRef.current;
    if (scrollEl) {
      scrollEl.scrollTop = 0;
    }
    // Read offsetWidth/scrollHeight instead of getBoundingClientRect() so .anim-pop-in
    // scale(0.94) at frame 0 never under-measures intrinsic menu bounds.
    const width = el?.offsetWidth || 276;
    const chromeHeight =
      el && scrollEl ? Math.max(0, el.offsetHeight - scrollEl.clientHeight) : 18;
    const height = scrollEl
      ? scrollEl.scrollHeight + chromeHeight
      : el?.scrollHeight || el?.offsetHeight || 340;

    const left = Math.max(pad, Math.min(position.x, vw - width - pad));
    const maxHeight = Math.max(140, Math.floor(maxBottom - minTop));
    const clampedHeight = Math.min(height, maxHeight);
    const top = Math.max(minTop, Math.min(position.y, maxBottom - clampedHeight));
    setCoords({ left, top, maxHeight: Math.floor(maxBottom - top) });
  }, [position, entries.length]);

  useLayoutEffect(() => {
    if (!openSubmenu) {
      setSubCoords(null);
      return;
    }
    const el = subMenuRef.current;
    const scrollEl = subScrollRef.current;
    if (scrollEl) {
      scrollEl.scrollTop = 0;
    }
    const { pad, vw, minTop, maxBottom } = measureClearBounds();
    const width = el?.offsetWidth || 256;
    const chromeHeight =
      el && scrollEl ? Math.max(0, el.offsetHeight - scrollEl.clientHeight) : 18;
    const height = scrollEl
      ? scrollEl.scrollHeight + chromeHeight
      : el?.scrollHeight || el?.offsetHeight || 220;
    const r = openSubmenu.rect;

    const fitsRight = r.right + 8 + width <= vw - pad;
    const preferredLeft = fitsRight ? r.right + 8 : r.left - width - 8;
    const left = Math.max(pad, Math.min(preferredLeft, vw - width - pad));

    const maxHeight = Math.max(140, Math.floor(maxBottom - minTop));
    const clampedHeight = Math.min(height, maxHeight);
    const top = Math.max(minTop, Math.min(r.top - 6, maxBottom - clampedHeight));
    setSubCoords({ left, top, maxHeight: Math.floor(maxBottom - top) });
  }, [openSubmenu, entries]);

  useEffect(() => {
    if (!position) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      const inRoot = Boolean(menuRef.current?.contains(target));
      const inSub = Boolean(subMenuRef.current?.contains(target));
      if (!inRoot && !inSub) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        clearSubmenuTimer();
        setOpenSubmenu(null);
        onClose();
      } else if (e.key === "ArrowLeft" && openSubmenu) {
        e.preventDefault();
        clearSubmenuTimer();
        setOpenSubmenu(null);
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
  }, [onClose, position, openSubmenu]);

  const activeMenu = position ? { position, entries } : null;
  const { mounted, exiting, value: renderedMenu } = usePresencePayload(activeMenu, 170);

  const activeSubmenuEntry =
    renderedMenu && openSubmenu ? findEntryById(renderedMenu.entries, openSubmenu.id) : null;
  const activeSubPayload =
    position && openSubmenu && activeSubmenuEntry
      ? { id: openSubmenu.id, rect: openSubmenu.rect, entries: activeSubmenuEntry.children }
      : null;
  const subPresence = usePresencePayload(activeSubPayload, 150);

  if (!mounted || !renderedMenu) return null;

  const activePosition = renderedMenu.position;

  const openSubmenuFromButton = (entryId: string, buttonEl: HTMLButtonElement) => {
    clearSubmenuTimer();
    const r = buttonEl.getBoundingClientRect();
    setOpenSubmenu({
      id: entryId,
      rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    });
  };

  const scheduleCloseSubmenu = () => {
    clearSubmenuTimer();
    closeSubTimerRef.current = window.setTimeout(() => {
      setOpenSubmenu(null);
    }, 150);
  };

  const renderEntry = (entry: ContextMenuEntry, isRoot: boolean, isFirst: boolean) => {
    if (entry.type === "divider") {
      return (
        <div
          key={entry.id}
          className={`ep-hairline-divider -mx-1.5 ${isRoot ? "my-1" : "my-0.5"}`}
          role="separator"
        />
      );
    }
    if (entry.type === "label") {
      return (
        <div
          key={entry.id}
          onPointerEnter={isRoot ? scheduleCloseSubmenu : undefined}
          className={`px-2.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-white/45 select-none ${
            isFirst ? "pt-1" : "pt-2.5"
          }`}
        >
          <span className="block truncate">{entry.text}</span>
        </div>
      );
    }

    if (entry.type === "submenu") {
      const subOpen = openSubmenu?.id === entry.id;
      return (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={subOpen}
          data-active={subOpen}
          disabled={entry.disabled}
          onPointerEnter={(e) => {
            if (!entry.disabled) {
              openSubmenuFromButton(entry.id, e.currentTarget);
            }
          }}
          onClick={(e) => {
            if (!entry.disabled) {
              openSubmenuFromButton(entry.id, e.currentTarget);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" && !entry.disabled) {
              e.preventDefault();
              openSubmenuFromButton(entry.id, e.currentTarget);
            }
          }}
          className={`ep-menu-row ep-press w-full flex items-center justify-between gap-2.5 px-2.5 py-1.5 text-left text-xs cursor-pointer disabled:opacity-35 disabled:pointer-events-none ${
            subOpen
              ? "text-white font-medium"
              : entry.accent
                ? "text-accent-soft font-medium"
                : "text-primary/95 hover:text-white"
          }`}
        >
          <span className="flex items-center gap-2.5 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
              {entry.icon}
            </span>
            <span className="truncate">{entry.label}</span>
          </span>

          <span className="flex items-center gap-1.5 shrink-0">
            {entry.badge && (
              <span className="text-[10.5px] font-medium text-white/65 num max-w-[82px] truncate">
                {entry.badge}
              </span>
            )}
            <AppChevronIcon
              direction="right"
              size={12}
              className={subOpen ? "text-accent-soft" : "text-white/60"}
            />
          </span>
        </button>
      );
    }

    return (
      <button
        key={entry.id}
        type="button"
        role="menuitem"
        data-active={entry.checked ? true : undefined}
        disabled={entry.disabled}
        onPointerEnter={isRoot ? scheduleCloseSubmenu : undefined}
        onClick={() => {
          if (entry.closeOnSelect !== false) {
            onClose();
          }
          entry.onSelect();
        }}
        className={`ep-menu-row ep-press w-full flex items-center justify-between gap-2.5 px-2.5 py-1.5 text-left text-xs cursor-pointer disabled:opacity-35 disabled:pointer-events-none ${
          entry.checked
            ? "text-white font-medium"
            : entry.accent
              ? "text-accent-soft font-medium"
              : "text-primary/95 hover:text-white"
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

        <span className="flex items-center gap-1.5 shrink-0">
          {entry.badge && (
            <span className="text-[10px] font-medium text-white/65 num">{entry.badge}</span>
          )}
          {entry.shortcut && (
            <kbd className="ep-glass-tray px-1.5 py-0.5 text-[10px] font-medium text-white/80 rounded-md shrink-0">
              {entry.shortcut}
            </kbd>
          )}
        </span>
      </button>
    );
  };

  const menuContent = (
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Context menu"
        data-glass-region="true"
        onContextMenu={(e) => e.preventDefault()}
        style={{
          left: `${coords?.left ?? activePosition.x}px`,
          top: `${coords?.top ?? activePosition.y}px`,
          maxHeight: coords ? `${coords.maxHeight}px` : undefined,
        }}
        className={`ep-glass-submenu ${
          exiting ? "anim-pop-out pointer-events-none" : "anim-pop-in"
        } fixed z-[55] w-[276px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[18px] py-2 flex flex-col select-none`}
      >
        <div
          ref={menuScrollRef}
          className="ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 flex flex-col gap-0.5"
        >
          {renderedMenu.entries.map((entry, idx) => renderEntry(entry, true, idx === 0))}
        </div>
      </div>

      {subPresence.mounted && subPresence.value && (
        <div
          ref={subMenuRef}
          role="menu"
          aria-label="Submenu options"
          data-glass-region="true"
          onContextMenu={(e) => e.preventDefault()}
          onPointerEnter={clearSubmenuTimer}
          style={{
            left: `${subCoords?.left ?? subPresence.value.rect.right + 8}px`,
            top: `${subCoords?.top ?? subPresence.value.rect.top}px`,
            maxHeight: subCoords ? `${subCoords.maxHeight}px` : undefined,
          }}
          className={`ep-glass-submenu ${
            subPresence.exiting || exiting ? "anim-pop-out pointer-events-none" : "anim-pop-in"
          } fixed z-[60] w-[256px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[18px] py-2 flex flex-col select-none`}
        >
          <div
            ref={subScrollRef}
            className="ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 flex flex-col gap-1"
          >
            {subPresence.value.entries.map((entry, idx) => renderEntry(entry, false, idx === 0))}
          </div>
        </div>
      )}
    </>
  );

  return typeof document !== "undefined" ? createPortal(menuContent, document.body) : menuContent;
}
