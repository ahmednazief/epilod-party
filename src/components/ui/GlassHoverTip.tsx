import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePresencePayload } from "../../lib/useAnimatedPresence";

interface GlassHoverTipProps {
  label: string;
  detail?: string;
  accent?: "default" | "speaking" | "host" | "admin" | "ok" | "warn" | "bad";
  placement?: "top" | "bottom";
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

interface TipCoords {
  anchorX: number;
  top?: number;
  bottom?: number;
  resolvedPlacement: "top" | "bottom";
}

const ACCENT_DOT_CLASS: Record<NonNullable<GlassHoverTipProps["accent"]>, string> = {
  default: "",
  speaking: "bg-[#4ADE80]",
  host: "bg-[#FDE68A] shadow-[0_0_8px_rgba(253,230,138,0.65)]",
  admin: "bg-[#C4B5FD] shadow-[0_0_8px_rgba(196,181,253,0.65)]",
  ok: "bg-ok shadow-[0_0_8px_rgba(74,222,128,0.65)]",
  warn: "bg-warn shadow-[0_0_8px_rgba(251,191,36,0.65)]",
  bad: "bg-bad shadow-[0_0_8px_rgba(248,113,113,0.65)]",
};

/**
 * Floating iOS liquid-glass pill explanation shown on hover, matching the emoji reaction hint style.
 */
export function GlassHoverTip({
  label,
  detail,
  accent = "default",
  placement = "top",
  disabled = false,
  className = "inline-flex items-center",
  children,
}: GlassHoverTipProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<TipCoords | null>(null);
  const [nudgeX, setNudgeX] = useState(0);

  const clearTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const showSoon = useCallback(() => {
    if (disabled) return;
    clearTimer();
    openTimerRef.current = window.setTimeout(() => {
      setOpen(true);
    }, 180);
  }, [clearTimer, disabled]);

  const hideNow = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
    return () => clearTimer();
  }, [clearTimer, disabled, open]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      setNudgeX(0);
      return;
    }

    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 720;
      const resolvedPlacement =
        placement === "top"
          ? r.top < 54 && vh - r.bottom > r.top
            ? "bottom"
            : "top"
          : vh - r.bottom < 54 && r.top > vh - r.bottom
            ? "top"
            : "bottom";

      setCoords({
        anchorX: r.left + r.width / 2,
        resolvedPlacement,
        ...(resolvedPlacement === "top"
          ? { bottom: Math.max(12, vh - r.top + 14) }
          : { top: Math.min(vh - 12, r.bottom + 14) }),
      });
    };

    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, placement]);

  const payload = usePresencePayload(open && !disabled && coords ? coords : null, 150);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!payload.mounted || payload.exiting) {
      setEntered(false);
      return;
    }
    let f2 = 0;
    const f1 = window.requestAnimationFrame(() => {
      f2 = window.requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      window.cancelAnimationFrame(f1);
      if (f2) window.cancelAnimationFrame(f2);
    };
  }, [payload.mounted, payload.exiting]);

  useLayoutEffect(() => {
    if (!payload.mounted || !tipRef.current || !payload.value) return;
    const halfW = tipRef.current.offsetWidth / 2;
    const vw = window.innerWidth || 1280;
    const margin = 12;
    const minCenter = margin + halfW;
    const maxCenter = Math.max(minCenter, vw - margin - halfW);
    const clampedCenter = Math.min(maxCenter, Math.max(minCenter, payload.value.anchorX));
    const nextNudge = Math.round(clampedCenter - payload.value.anchorX);
    setNudgeX(nextNudge);
  }, [payload.mounted, payload.value, label, detail]);

  const dotClass = ACCENT_DOT_CLASS[accent];

  return (
    <span
      ref={anchorRef}
      onMouseEnter={showSoon}
      onMouseLeave={hideNow}
      onFocusCapture={showSoon}
      onBlurCapture={hideNow}
      className={className}
    >
      {children}
      {payload.mounted &&
        payload.value &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            aria-hidden="true"
            style={{
              left: `${payload.value.anchorX + nudgeX}px`,
              ...(payload.value.top !== undefined ? { top: `${payload.value.top}px` } : {}),
              ...(payload.value.bottom !== undefined
                ? { bottom: `${payload.value.bottom}px` }
                : {}),
            }}
            className="pointer-events-none fixed z-[90] -translate-x-1/2"
          >
            <div
              ref={tipRef}
              className={`ep-glass-reaction-hint h-7 px-2.5 rounded-full flex items-center gap-1.5 whitespace-nowrap transition-[opacity,transform] duration-150 ease-[var(--spring-fluid)] ${
                payload.exiting || !entered
                  ? payload.value.resolvedPlacement === "top"
                    ? "opacity-0 scale-95 translate-y-1"
                    : "opacity-0 scale-95 -translate-y-1"
                  : "opacity-100 scale-100 translate-y-0"
              }`}
            >
              {dotClass && <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotClass}`} />}
              <span className="text-[11px] font-medium tracking-tight text-white/95">
                {label}
              </span>
              {detail && (
                <>
                  <span className="text-[10px] text-white/30">·</span>
                  <span className="text-[10px] font-medium text-white/60">{detail}</span>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
