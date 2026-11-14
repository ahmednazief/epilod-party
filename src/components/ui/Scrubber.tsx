import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

interface ScrubberProps {
  value: number;
  min?: number;
  max: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  formatTooltip?: (val: number) => string;
  onChange: (val: number) => void;
  onCommit?: (val: number) => void;
  className?: string;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  if (max <= min) return min;
  return Math.max(min, Math.min(max, v));
}

export function Scrubber({
  value,
  min = 0,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  formatTooltip,
  onChange,
  onCommit,
  className = "",
}: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);

  const safeMax = max > min ? max : min + 1;
  const ratio = clamp((value - min) / (safeMax - min), 0, 1);

  const valueFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const r = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
    const raw = min + r * (safeMax - min);
    const snapped = step > 0 ? Math.round(raw / step) * step : raw;
    return clamp(snapped, min, max > min ? max : min);
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || max <= min) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const next = valueFromClientX(e.clientX);
    onChange(next);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const relX = clamp(e.clientX - rect.left, 0, rect.width);
      setHoverX(relX);
      setHoverRatio(rect.width > 0 ? relX / rect.width : 0);
    }
    if (!dragging || disabled || max <= min) return;
    const next = valueFromClientX(e.clientX);
    onChange(next);
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
    const finalVal = valueFromClientX(e.clientX);
    onChange(finalVal);
    onCommit?.(finalVal);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || max <= min) return;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      next = clamp(value + step, min, max);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      next = clamp(value - step, min, max);
    } else if (e.key === "Home") {
      next = min;
    } else if (e.key === "End") {
      next = max;
    }
    if (next !== null) {
      e.preventDefault();
      onChange(next);
      onCommit?.(next);
    }
  };

  const hoverVal =
    hoverRatio !== null ? min + hoverRatio * Math.max(0, max - min) : null;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      aria-disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => {
        setHoverRatio(null);
      }}
      onKeyDown={handleKeyDown}
      className={`group relative h-6 flex items-center select-none touch-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer"
      } ${className}`}
    >
      {formatTooltip && hoverVal !== null && !disabled && (
        <div
          className="pointer-events-none absolute -top-7 -translate-x-1/2 px-1.5 py-0.5 text-[11px] num bg-raised text-primary border border-hairline rounded-[var(--radius-ui)] whitespace-nowrap"
          style={{ left: `${hoverX}px` }}
        >
          {formatTooltip(hoverVal)}
        </div>
      )}
      <div className="relative w-full h-1.5 group-hover:h-2 bg-raised rounded-full overflow-hidden transition-[height] duration-150">
        <div
          className="absolute inset-0 bg-accent origin-left will-change-transform"
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 flex items-center">
        <div
          className="w-full"
          style={{ transform: `translateX(${ratio * 100}%)` }}
        >
          <div className="-ml-1.5 h-3 w-3 rounded-full bg-primary border border-canvas opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150" />
        </div>
      </div>
    </div>
  );
}
