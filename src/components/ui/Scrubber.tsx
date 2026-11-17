import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface ScrubberChangeMeta {
  phase: "start" | "move" | "commit" | "key";
}

interface ScrubberProps {
  value: number;
  min?: number;
  max: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  formatTooltip?: (val: number) => string;
  tooltipPlacement?: "top" | "bottom";
  tooltipVariant?: "pill" | "plain";
  onChange: (val: number, meta?: ScrubberChangeMeta) => void;
  onCommit?: (val: number) => void;
  highlightRange?: { start: number; end: number } | null;
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
  tooltipPlacement = "top",
  tooltipVariant = "pill",
  onChange,
  onCommit,
  highlightRange = null,
  className = "",
}: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerDownXRef = useRef(0);
  const pointerDownValRef = useRef(value);
  const lastValRef = useRef(value);
  const draggingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);

  const safeMax = max > min ? max : min + 1;
  const ratio = clamp((value - min) / (safeMax - min), 0, 1);
  const highlightSpan = useMemo(() => {
    if (!highlightRange || safeMax <= min) return null;
    const s = clamp((highlightRange.start - min) / (safeMax - min), 0, 1);
    const e = clamp((highlightRange.end - min) / (safeMax - min), 0, 1);
    if (e <= s) return null;
    return { leftPct: s * 100, widthPct: (e - s) * 100 };
  }, [highlightRange, min, safeMax]);

  const valueFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const r = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
    const raw = min + r * (safeMax - min);
    const snapped = step > 0 ? Math.round(raw / step) * step : raw;
    return clamp(snapped, min, max > min ? max : min);
  };

  const updateHoverPosition = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relX = clamp(clientX - rect.left, 0, rect.width);
    setHoverX(relX);
    setHoverRatio(rect.width > 0 ? relX / rect.width : 0);
    if (formatTooltip && tooltipVariant !== "plain" && !disabled) {
      window.dispatchEvent(new Event("ep:glass-layout"));
    }
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || max <= min || e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore environments where synthetic pointers cannot be captured.
    }
    draggingRef.current = true;
    activePointerIdRef.current = e.pointerId;
    pointerDownXRef.current = e.clientX;
    dragMovedRef.current = false;
    setDragging(true);
    updateHoverPosition(e.clientX);
    const next = valueFromClientX(e.clientX);
    pointerDownValRef.current = next;
    lastValRef.current = next;
    onChange(next, { phase: "start" });
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    updateHoverPosition(e.clientX);
    if (!draggingRef.current || activePointerIdRef.current !== e.pointerId || disabled || max <= min) {
      return;
    }
    if (!dragMovedRef.current && Math.abs(e.clientX - pointerDownXRef.current) >= 6) {
      dragMovedRef.current = true;
    }
    const next = valueFromClientX(e.clientX);
    lastValRef.current = next;
    onChange(next, { phase: dragMovedRef.current ? "move" : "start" });
  };

  const finishPointerDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    if (activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) {
      return;
    }
    const moved = dragMovedRef.current;
    const isCancel = e.type === "pointercancel" || e.type === "lostpointercapture";
    const finalVal = isCancel
      ? lastValRef.current
      : moved
        ? valueFromClientX(e.clientX)
        : pointerDownValRef.current;

    draggingRef.current = false;
    activePointerIdRef.current = null;
    dragMovedRef.current = false;
    setDragging(false);

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore capture release errors on detached pointers.
    }

    onChange(finalVal, { phase: "commit" });
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
      onChange(next, { phase: "key" });
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
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      onLostPointerCapture={finishPointerDrag}
      onPointerLeave={() => {
        setHoverRatio(null);
      }}
      onKeyDown={handleKeyDown}
      className={`ep-scrubber group relative h-6 flex items-center select-none touch-none ${
        disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer"
      } ${className}`}
    >
      {formatTooltip &&
        hoverVal !== null &&
        !disabled &&
        (tooltipVariant === "plain" ? (
          <div
            className={`anim-pop-in pointer-events-none absolute z-30 -translate-x-1/2 text-[11px] leading-none font-semibold num text-white/95 drop-shadow-[0_1px_3px_rgba(0,0,0,0.85)] whitespace-nowrap select-none ${
              tooltipPlacement === "bottom" ? "top-7" : "-top-3"
            }`}
            style={{ left: `clamp(12px, ${hoverX}px, calc(100% - 12px))` }}
          >
            {formatTooltip(hoverVal)}
          </div>
        ) : (
          <div
            data-glass-region="true"
            className={`anim-pop-in ep-glass-pill pointer-events-none absolute z-30 -translate-x-1/2 px-2.5 py-0.5 text-[11px] font-medium num text-primary rounded-full whitespace-nowrap ${
              tooltipPlacement === "bottom" ? "top-7" : "-top-8"
            }`}
            style={{ left: `clamp(18px, ${hoverX}px, calc(100% - 18px))` }}
          >
            {formatTooltip(hoverVal)}
          </div>
        ))}
      <div className="relative w-full h-1.5 group-hover:h-2.5 bg-white/14 rounded-full overflow-hidden transition-[height] duration-200 ease-out">
        <div
          className="ep-scrubber-fill absolute inset-0 origin-left will-change-transform"
          style={{ transform: `scaleX(${ratio})` }}
        />
        {highlightSpan && (
          <div
            aria-hidden="true"
            className="ep-scrubber-intro-range absolute inset-y-0 rounded-full pointer-events-none"
            style={{
              left: `${highlightSpan.leftPct}%`,
              width: `${highlightSpan.widthPct}%`,
            }}
          />
        )}
      </div>
      <div className="pointer-events-none absolute inset-0 overflow-x-clip">
        <div className="absolute inset-y-0 left-[7px] right-[7px] flex items-center">
          <div className="w-full" style={{ transform: `translateX(${ratio * 100}%)` }}>
            <div
              className={`-ml-[7px] h-3.5 w-3.5 rounded-full bg-white shadow-md transition-[opacity,scale,transform] duration-150 ${
                dragging
                  ? "opacity-100 scale-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 scale-90 group-hover:scale-100"
              }`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
