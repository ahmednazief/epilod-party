import { AppCheckIcon, AppChevronIcon } from "./AppIcons";
import { MenuInterfaceIcon } from "./MenuIcons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresencePayload } from "../../lib/useAnimatedPresence";

export interface SelectMenuOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SelectMenuProps<T extends string = string> {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  label?: string;
  variant?: "field" | "row";
  triggerIcon?: ReactNode;
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
  label,
  variant = "field",
  triggerIcon,
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
      const spaceAbove = Math.max(0, r.top - 16);
      const spaceBelow = Math.max(0, vh - r.bottom - 16);
      const resolvedPlacement =
        placement === "top"
          ? spaceAbove < 120 && spaceBelow > spaceAbove
            ? "bottom"
            : "top"
          : spaceBelow < 120 && spaceAbove > spaceBelow
            ? "top"
            : "bottom";

      if (resolvedPlacement === "top") {
        setMenuStyle({
          left,
          width,
          maxHeight: Math.max(48, Math.min(224, spaceAbove)),
          bottom: Math.max(12, vh - r.top + 6),
        });
      } else {
        setMenuStyle({
          left,
          width,
          maxHeight: Math.max(48, Math.min(224, spaceBelow)),
          top: Math.min(vh - 12, r.bottom + 6),
        });
      }
    };

    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) {
        return;
      }
      setOpen(false);
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
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
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown, true);
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
        } ep-glass-submenu fixed z-[80] overflow-hidden rounded-2xl py-2 flex flex-col`}
      >
        <div className="ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 flex flex-col gap-0.5">
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
                <span className="flex items-center gap-2 min-w-0">
                  {opt.icon && (
                    <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0 text-secondary">
                      {opt.icon}
                    </span>
                  )}
                  <span className="truncate">{opt.label}</span>
                </span>
                {active && <AppCheckIcon size={14} className="text-accent-soft shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
    ) : null;

  const selectedLabel = selectedOption ? selectedOption.label : placeholder;
  const leadingIcon = selectedOption?.icon ?? triggerIcon ?? <MenuInterfaceIcon size={13} />;

  return (
    <div ref={rootRef} className={`relative w-full ${className}`}>
      {variant === "row" ? (
        <button
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={`ep-menu-row ep-press w-full px-3 py-2 flex items-center justify-between gap-3 text-left text-xs disabled:opacity-45 disabled:pointer-events-none cursor-pointer ${
            open ? "bg-white/[0.085] text-white" : "text-secondary hover:text-white"
          }`}
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              {leadingIcon}
            </span>
            <span className="truncate">{label ?? ariaLabel}</span>
          </span>
          <span className="flex items-center gap-1.5 min-w-0 max-w-[54%] shrink-0">
            <span className="truncate text-[11px] font-medium text-white/75">
              {selectedLabel}
            </span>
            <AppChevronIcon
              direction="down"
              size={13}
              className={`text-white/50 shrink-0 transition-transform duration-200 ${
                open ? "rotate-180" : ""
              }`}
            />
          </span>
        </button>
      ) : (
        <button
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className="ep-glass-select ep-press w-full h-9.5 px-3.5 flex items-center justify-between gap-2 text-left text-xs text-primary rounded-xl disabled:opacity-45 disabled:pointer-events-none cursor-pointer"
        >
          <span className="flex items-center gap-2 min-w-0">
            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0 text-accent-soft/85">
              {leadingIcon}
            </span>
            <span className="truncate">{selectedLabel}</span>
          </span>
          <AppChevronIcon
            direction="down"
            size={14}
            className={`text-muted shrink-0 transition-transform duration-200 ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
      )}

      {listbox && (typeof document !== "undefined" ? createPortal(listbox, document.body) : listbox)}
    </div>
  );
}
