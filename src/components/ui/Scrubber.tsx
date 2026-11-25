import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

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
  renderPreview?: (val: number) => ReactNode;
  tooltipPlacement?: "top" | "bottom";
  tooltipVariant?: "pill" | "plain";
  onChange: (val: number, meta?: ScrubberChangeMeta) => void;
  onCommit?: (val: number) => void;
  highlightRange?: { start: number; end: number } | null;
  alwaysShowThumb?: boolean;
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
  renderPreview,
  tooltipPlacement = "top",
  tooltipVariant = "pill",
  onChange,
  onCommit,
  highlightRange = null,
  alwaysShowThumb = false,
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
    const pad = alwaysShowThumb ? 11 : 7;
    const effectivePad = rect.width > pad * 2 ? pad : 0;
    const span = rect.width - effectivePad * 2;
    const r = span > 0 ? clamp((clientX - rect.left - effectivePad) / span, 0, 1) : 0;
    const raw = min + r * (safeMax - min);
    const snapped = step > 0 ? Math.round(raw / step) * step : raw;
    return clamp(snapped, min, max > min ? max : min);
  };

  const updateHoverPosition = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = alwaysShowThumb ? 11 : 7;
    const effectivePad = rect.width > pad * 2 ? pad : 0;
    const span = rect.width - effectivePad * 2;
    const relX = clamp(clientX - rect.left, effectivePad, rect.width - effectivePad);
    setHoverX(relX);
    setHoverRatio(span > 0 ? clamp((relX - effectivePad) / span, 0, 1) : 0);
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
    if (disabled || max <= min || e.currentTarget.closest?.('[aria-hidden="true"]')) return;
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
      {hoverVal !== null && !disabled && (() => {
        const previewNode = renderPreview ? renderPreview(hoverVal) : null;
        if (previewNode) {
          return (
            <div
              className={`ep-glass-thumb-preview pointer-events-none absolute z-30 -translate-x-1/2 ${
                tooltipPlacement === "bottom" ? "top-6" : "bottom-6"
              }`}
              style={{ left: `clamp(min(80px, 50%), ${hoverX}px, max(50%, calc(100% - 80px)))` }}
            >
              {previewNode}
            </div>
          );
        }
        if (!formatTooltip) return null;
        return tooltipVariant === "plain" ? (
          <div
            className={`anim-pop-in pointer-events-none absolute z-30 -translate-x-1/2 text-[11px] leading-none font-semibold num text-white/95 whitespace-nowrap select-none ${
              tooltipPlacement === "bottom" ? "top-7" : "-top-3"
            }`}
            style={{ left: `clamp(min(24px, 50%), ${hoverX}px, max(50%, calc(100% - 24px)))` }}
          >
            {formatTooltip(hoverVal)}
          </div>
        ) : (
          <div
            data-glass-region="true"
            className={`anim-pop-in ep-glass-pill pointer-events-none absolute z-30 -translate-x-1/2 px-2.5 py-0.5 text-[11px] font-medium num text-primary rounded-full whitespace-nowrap ${
              tooltipPlacement === "bottom" ? "top-7" : "-top-8"
            }`}
            style={{ left: `clamp(min(34px, 50%), ${hoverX}px, max(50%, calc(100% - 34px)))` }}
          >
            {formatTooltip(hoverVal)}
          </div>
        );
      })()}
      <div
        className={`ep-scrubber-track relative w-full ${
          alwaysShowThumb
            ? "h-1.5"
            : dragging
              ? "h-2.5"
              : "h-1.5 group-hover:h-2.5"
        } rounded-full overflow-hidden transition-[height] duration-200 ease-out`}
      >
        {ratio > 0 && (
          <div
            className={`ep-scrubber-fill-cap absolute inset-y-0 left-0 pointer-events-none ${
              alwaysShowThumb ? "w-[11px]" : "w-[7px]"
            }`}
          />
        )}
        <div
          className={`absolute inset-y-0 overflow-hidden ${
            alwaysShowThumb ? "left-[11px] right-[11px]" : "left-[7px] right-[7px]"
          }`}
        >
          <div
            className="ep-scrubber-fill absolute inset-y-0 left-0 right-0 will-change-transform"
            style={{
              transform: `translateX(${(ratio - 1) * 100}%)`,
              opacity: ratio > 0 ? 1 : 0,
            }}
          />
        </div>
        {!alwaysShowThumb && !dragging && ratio >= 0.999 && (
          <div className="ep-scrubber-fill-cap ep-scrubber-end-cap absolute inset-y-0 right-0 w-[7px] pointer-events-none" />
        )}
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
      <div
        className="pointer-events-none absolute inset-y-0 -inset-x-2 overflow-x-clip"
      >
        <div
          className={`absolute inset-y-0 flex items-center ${
            alwaysShowThumb ? "left-[19px] right-[19px]" : "left-[15px] right-[15px]"
          }`}
        >
          <div className="w-full" style={{ transform: `translateX(${ratio * 100}%)` }}>
            {alwaysShowThumb ? (
              <div className="-ml-[14px] w-7 flex items-center justify-center">
                <div
                  data-dragging={dragging ? "true" : undefined}
                  className="ep-scrubber-glass-thumb h-[14px] w-[22px] shrink-0 rounded-full"
                />
              </div>
            ) : (
              <div
                data-dragging={dragging ? "true" : undefined}
                className={`-ml-[7px] h-3.5 w-3.5 rounded-full ep-scrubber-glass-thumb ep-scrubber-hover-thumb ${
                  dragging
                    ? "opacity-100 scale-100"
                    : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 scale-90 group-hover:scale-100"
                }`}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
