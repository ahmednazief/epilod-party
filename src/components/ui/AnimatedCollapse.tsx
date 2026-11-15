import { useEffect, useState, type ReactNode } from "react";
import {
  prefersReducedMotion,
  useAnimatedPresence,
} from "../../lib/useAnimatedPresence";

interface AnimatedCollapseProps {
  open: boolean;
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}

/**
 * Fluid accordion/drawer wrapper animating grid track height (0fr <-> 1fr), opacity, and Y offset
 * on both expand and collapse before unmounting hidden controls.
 */
export function AnimatedCollapse({
  open,
  children,
  className = "",
  innerClassName = "",
}: AnimatedCollapseProps) {
  const { mounted } = useAnimatedPresence(open, 250);
  const [revealed, setRevealed] = useState(open);

  useEffect(() => {
    if (!open) {
      setRevealed(false);
      return;
    }
    if (prefersReducedMotion()) {
      setRevealed(true);
      return;
    }
    // Wait two frames so CSS computes initial 0fr state before transitioning to 1fr.
    let innerFrame = 0;
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => setRevealed(true));
    });
    return () => {
      window.cancelAnimationFrame(outerFrame);
      if (innerFrame) window.cancelAnimationFrame(innerFrame);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className={`ep-collapse ${className}`}
      data-open={revealed ? "true" : "false"}
      aria-hidden={!open}
    >
      <div className={`ep-collapse-inner ${innerClassName}`}>{children}</div>
    </div>
  );
}
