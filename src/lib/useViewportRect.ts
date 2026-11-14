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
    const update = () => {
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

    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro && ref.current) {
      ro.observe(ref.current);
    }

    window.addEventListener("resize", update);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);

    const dpr = window.devicePixelRatio || 1;
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(resolution: ${dpr}dppx)`)
        : null;
    mq?.addEventListener?.("change", update);

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
      mq?.removeEventListener?.("change", update);
    };
  }, [ref, refreshSignal]);

  return rect;
}
