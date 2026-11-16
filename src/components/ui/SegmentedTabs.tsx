import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface SegmentedTabItem<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

interface SegmentedTabsProps<T extends string> {
  items: readonly SegmentedTabItem<T>[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  fullWidth?: boolean;
  className?: string;
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  size = "md",
  fullWidth = false,
  className = "",
}: SegmentedTabsProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const prevValueRef = useRef<T | null>(value);
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });
  const [morphing, setMorphing] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      if (value === null) {
        setIndicator({ left: 0, width: 0 });
        return;
      }
      const activeBtn = buttonRefs.current[value];
      if (!activeBtn) {
        setIndicator({ left: 0, width: 0 });
        return;
      }
      setIndicator({
        left: activeBtn.offsetLeft,
        width: activeBtn.offsetWidth,
      });
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(container);
    return () => {
      ro?.disconnect();
    };
  }, [value, items]);

  useEffect(() => {
    if (prevValueRef.current !== null && value !== null && prevValueRef.current !== value) {
      setMorphing(true);
      const timer = window.setTimeout(() => setMorphing(false), 185);
      prevValueRef.current = value;
      return () => window.clearTimeout(timer);
    }
    prevValueRef.current = value;
  }, [value]);

  const padClass = "p-1";
  const insetClass = "top-1 bottom-1";
  const btnSizeClass =
    size === "sm" ? "h-8 px-2.5 text-[11px]" : "h-8.5 px-3.5 py-1.5 text-xs";

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`ep-glass-tray relative ${fullWidth ? "flex w-full" : "inline-flex"} items-center gap-1 ${padClass} rounded-full ${className}`}
    >
      {indicator.width > 0 && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute ${insetClass} left-0 transition-[transform,width] duration-[420ms] ease-[cubic-bezier(0.22,1.30,0.36,1)]`}
          style={{
            width: `${indicator.width}px`,
            transform: `translateX(${indicator.left}px)`,
          }}
        >
          <span
            data-morphing={morphing ? "true" : undefined}
            className="ep-droplet-indicator ep-droplet-core block h-full w-full rounded-full"
          />
        </span>
      )}
      {items.map((item) => {
        const active = value !== null && item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              buttonRefs.current[item.value] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              if (!item.disabled) onChange(item.value);
            }}
            className={`ep-press relative z-10 flex-1 ${btnSizeClass} font-medium whitespace-nowrap cursor-pointer rounded-full disabled:opacity-35 disabled:pointer-events-none ${
              active
                ? "text-white font-semibold"
                : "ep-tray-option text-secondary hover:text-white"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
