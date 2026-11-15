import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.dataset.reducedMotion === "true") return true;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface AnimatedPresenceState {
  mounted: boolean;
  exiting: boolean;
}

/**
 * Keeps an element mounted cleanly across its CSS exit animation before unmounting.
 * Immediately cancels exit if `active` turns back to `true`, and skips delay under reduced motion.
 */
export function useAnimatedPresence(
  active: boolean,
  exitMs = 190,
): AnimatedPresenceState {
  const [state, setState] = useState<{
    mounted: boolean;
    exiting: boolean;
    prevActive: boolean;
  }>(() => ({
    mounted: active,
    exiting: false,
    prevActive: active,
  }));

  if (active !== state.prevActive) {
    if (active) {
      setState({ mounted: true, exiting: false, prevActive: true });
    } else if (state.mounted && !prefersReducedMotion() && exitMs > 0) {
      setState({ mounted: true, exiting: true, prevActive: false });
    } else {
      setState({ mounted: false, exiting: false, prevActive: false });
    }
  }

  useEffect(() => {
    if (!state.exiting) return;
    const timer = window.setTimeout(() => {
      setState((prev) =>
        prev.exiting
          ? { mounted: false, exiting: false, prevActive: false }
          : prev,
      );
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [state.exiting, exitMs]);

  return {
    mounted: active || state.mounted,
    exiting: !active && state.exiting,
  };
}

/**
 * Like `useAnimatedPresence`, while retaining the last non-null payload across the exit window
 * so menus/popovers can animate out at their last coordinates and content.
 */
export function usePresencePayload<T>(
  value: T | null | undefined,
  exitMs = 190,
): {
  mounted: boolean;
  exiting: boolean;
  value: T | null;
} {
  const active = value != null;
  const { mounted, exiting } = useAnimatedPresence(active, exitMs);
  const lastValueRef = useRef<T | null>(value ?? null);

  useLayoutEffect(() => {
    if (value != null) {
      lastValueRef.current = value;
    } else if (!mounted) {
      lastValueRef.current = null;
    }
  }, [value, mounted]);

  const current =
    value != null ? value : mounted ? lastValueRef.current : null;

  return {
    mounted: mounted && current != null,
    exiting,
    value: current ?? null,
  };
}
