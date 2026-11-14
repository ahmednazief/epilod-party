import { useLayoutEffect, useRef, useState } from "react";

export interface SegmentedTabItem<T extends string> {
  value: T;
  label: string;
}

interface SegmentedTabsProps<T extends string> {
  items: readonly SegmentedTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className = "",
}: SegmentedTabsProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });

  useLayoutEffect(() => {
    const activeBtn = buttonRefs.current[value];
    const container = containerRef.current;
    if (!activeBtn || !container) return;
    setIndicator({
      left: activeBtn.offsetLeft,
      width: activeBtn.offsetWidth,
    });
  }, [value, items]);

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`relative inline-flex items-center p-0.5 bg-canvas border border-hairline rounded-[var(--radius-ui)] ${className}`}
    >
      {indicator.width > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 bg-hover border border-accent/35 rounded-[4px] transition-[transform,width] duration-200 ease-out"
          style={{
            width: `${indicator.width}px`,
            transform: `translateX(${indicator.left}px)`,
          }}
        />
      )}
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              buttonRefs.current[item.value] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={`relative z-10 flex-1 px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent rounded-[4px] ${
              active ? "text-[#C4B5FD]" : "text-muted hover:text-secondary"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
