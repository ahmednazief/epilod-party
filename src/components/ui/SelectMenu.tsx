import { AppCheckIcon, AppChevronIcon } from "./AppIcons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePresencePayload } from "../../lib/useAnimatedPresence";

export interface SelectMenuOption<T extends string = string> {
  value: T;
  label: string;
}

interface SelectMenuProps<T extends string = string> {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
  placement?: "bottom" | "top";
  className?: string;
}

export function SelectMenu<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "Select…",
  placement = "bottom",
  className = "",
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<{
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }

    const updatePosition = () => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
      const vh = typeof window !== "undefined" ? window.innerHeight : 720;
      const width = Math.min(Math.max(r.width, 160), vw - 24);
      const left = Math.max(12, Math.min(r.left, vw - width - 12));
      if (placement === "top") {
        setMenuStyle({
          left,
          width,
          maxHeight: Math.min(224, Math.max(110, r.top - 18)),
          bottom: Math.max(12, vh - r.top + 6),
        });
      } else {
        setMenuStyle({
          left,
          width,
          maxHeight: Math.min(224, Math.max(110, vh - r.bottom - 18)),
          top: Math.min(vh - 12, r.bottom + 6),
        });
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        rootRef.current &&
        !rootRef.current.contains(target) &&
        (!listRef.current || !listRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const listMenu = usePresencePayload(open && menuStyle ? menuStyle : null, 170);

  const listbox =
    listMenu.mounted && listMenu.value ? (
      <div
        ref={listRef}
        role="listbox"
        aria-label={ariaLabel}
        data-glass-region="true"
        style={{
          left: `${listMenu.value.left}px`,
          width: `${listMenu.value.width}px`,
          maxHeight: `${listMenu.value.maxHeight}px`,
          ...(listMenu.value.top !== undefined ? { top: `${listMenu.value.top}px` } : {}),
          ...(listMenu.value.bottom !== undefined
            ? { bottom: `${listMenu.value.bottom}px` }
            : {}),
        }}
        className={`${
          listMenu.exiting ? "anim-pop-out pointer-events-none" : "anim-pop-in"
        } ep-glass-sheet fixed z-50 overflow-y-auto rounded-2xl p-1.5 flex flex-col gap-0.5`}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={active}
              data-active={active}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`ep-menu-row ep-press w-full px-3 py-2 flex items-center justify-between gap-2 text-left text-xs cursor-pointer ${
                active ? "text-white font-medium" : "text-secondary hover:text-primary"
              }`}
            >
              <span className="truncate">{opt.label}</span>
              {active && <AppCheckIcon size={14} className="text-accent-soft shrink-0" />}
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div ref={rootRef} className={`relative w-full ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="ep-glass-input ep-press w-full h-9.5 px-3.5 flex items-center justify-between gap-2 text-left text-xs text-primary rounded-xl focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-45 disabled:pointer-events-none cursor-pointer"
      >
        <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        <AppChevronIcon
          direction="down"
          size={14}
          className={`text-muted shrink-0 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {listbox && (typeof document !== "undefined" ? createPortal(listbox, document.body) : listbox)}
    </div>
  );
}
