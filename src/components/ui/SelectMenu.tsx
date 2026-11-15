import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
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
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted shrink-0 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`anim-pop-in ep-glass-sheet absolute z-50 w-full max-h-56 overflow-y-auto rounded-2xl p-1.5 flex flex-col gap-0.5 ${
            placement === "top" ? "bottom-full mb-1.5" : "mt-1.5"
          }`}
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
                className={`ep-menu-row w-full px-3 py-2 flex items-center justify-between gap-2 text-left text-xs cursor-pointer ${
                  active ? "text-white font-medium" : "text-secondary hover:text-primary"
                }`}
              >
                <span className="truncate">{opt.label}</span>
                {active && <Check className="h-3.5 w-3.5 text-accent-soft shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
