import { useEffect, useState, type RefObject } from "react";
import type { PhysicalRect } from "./mpv";

export function measurePhysicalRect(el: HTMLElement | null): PhysicalRect {
  if (!el) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const rect = el.getBoundingClientRect();
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return {
    x: Math.round(rect.left * dpr),
    y: Math.round(rect.top * dpr),
    width: Math.max(0, Math.round(rect.width * dpr)),
    height: Math.max(0, Math.round(rect.height * dpr)),
  };
}

export function useViewportRect(ref: RefObject<HTMLElement | null>, refreshSignal = 0): PhysicalRect {
  const [rect, setRect] = useState<PhysicalRect>({ x: 0, y: 0, width: 0, height: 0 });

  useEffect(() => {
    let rafId: number | null = null;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

    const commit = () => {
      const next = measurePhysicalRect(ref.current);
      setRect((prev) =>
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };

    const scheduleMeasure = () => {
      if (rafId === null && typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          commit();
        });
      }
      if (trailingTimer !== null) {
        clearTimeout(trailingTimer);
      }
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        commit();
      }, 16);
    };

    commit();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleMeasure) : null;
    if (ro && ref.current) {
      ro.observe(ref.current);
    }

    window.addEventListener("resize", scheduleMeasure);

    let mq: MediaQueryList | null = null;
    const bindDprListener = () => {
      mq?.removeEventListener?.("change", onDprChange);
      if (typeof window.matchMedia !== "function") {
        mq = null;
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
      mq.addEventListener?.("change", onDprChange);
    };
    const onDprChange = () => {
      scheduleMeasure();
      bindDprListener();
    };
    bindDprListener();

    return () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      if (trailingTimer !== null) {
        clearTimeout(trailingTimer);
      }
      ro?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      mq?.removeEventListener?.("change", onDprChange);
    };
  }, [ref, refreshSignal]);

  return rect;
}
