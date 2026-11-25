import { useEffect, useRef, useState } from "react";
import { AppCloseIcon } from "./AppIcons";
import { prefersReducedMotion } from "../../lib/useAnimatedPresence";
import {
  useNotificationStore,
  type NotificationItem,
  type NotificationKind,
} from "../../store/useNotificationStore";

const KIND_STYLES: Record<NotificationKind, string> = {
  info: "text-primary",
  success: "text-ok",
  warn: "text-warn",
  error: "text-bad",
};

interface RenderedNotification {
  item: NotificationItem;
  exiting: boolean;
}

interface NotificationStripProps {
  inline?: boolean;
  belowTitleBar?: boolean;
}

export function NotificationStrip({
  inline = false,
  belowTitleBar = true,
}: NotificationStripProps = {}) {
  const items = useNotificationStore((s) => s.items);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const [entries, setEntries] = useState<RenderedNotification[]>(() =>
    items.map((item) => ({ item, exiting: false })),
  );

  const exitTimersRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const activeIds = new Set(items.map((i) => i.id));
    for (const id of activeIds) {
      const existingTimer = exitTimersRef.current.get(id);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        exitTimersRef.current.delete(id);
      }
    }
    setEntries((prev) => {
      const next: RenderedNotification[] = [];
      const seen = new Set<number>();
      for (const entry of prev) {
        seen.add(entry.item.id);
        if (activeIds.has(entry.item.id)) {
          next.push({ item: entry.item, exiting: false });
        } else if (!prefersReducedMotion()) {
          next.push({ item: entry.item, exiting: true });
        }
      }
      for (const item of items) {
        if (!seen.has(item.id)) {
          next.push({ item, exiting: false });
        }
      }
      return next;
    });
  }, [items]);

  const exitingIds = entries.filter((e) => e.exiting).map((e) => e.item.id);
  const exitingKey = exitingIds.join(",");

  useEffect(() => {
    if (!exitingKey) return;
    for (const id of exitingIds) {
      if (exitTimersRef.current.has(id)) continue;
      const timer = window.setTimeout(() => {
        exitTimersRef.current.delete(id);
        const activeIdsNow = new Set(useNotificationStore.getState().items.map((i) => i.id));
        setEntries((prev) =>
          prev.filter((entry) => entry.item.id !== id || activeIdsNow.has(entry.item.id)),
        );
      }, 175);
      exitTimersRef.current.set(id, timer);
    }
  }, [exitingKey]);

  useEffect(() => {
    return () => {
      for (const timer of exitTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      exitTimersRef.current.clear();
    };
  }, []);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div
      className={
        inline
          ? "pointer-events-none flex flex-col items-center gap-1.5 max-w-md w-full"
          : `pointer-events-none fixed left-1/2 -translate-x-1/2 z-[65] flex flex-col items-center gap-1.5 max-w-md w-full px-4 transition-[top] duration-300 ${
              belowTitleBar ? "top-14" : "top-4"
            }`
      }
    >
      {entries.map(({ item, exiting }) => (
        <div
          key={item.id}
          role="status"
          data-glass-region="true"
          className={`${
            exiting
              ? "pointer-events-none anim-fade-slide-down"
              : "pointer-events-auto anim-fade-slide-up"
          } ep-glass-pill flex items-center justify-between gap-3 px-4 py-2 text-xs rounded-full ${KIND_STYLES[item.kind]}`}
        >
          <span className="truncate">{item.message}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {item.action && (
              <button
                type="button"
                onClick={() => {
                  const fn = item.action?.onClick;
                  dismiss(item.id);
                  fn?.();
                }}
                className="ep-glass-primary-pill ep-press h-6 px-2.5 rounded-full text-[11px] font-semibold text-white cursor-pointer"
              >
                {item.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
              className="ep-bar-icon-btn ep-press h-5 w-5 -mr-1 rounded-full inline-flex items-center justify-center text-muted hover:text-primary shrink-0 cursor-pointer"
            >
              <AppCloseIcon size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
