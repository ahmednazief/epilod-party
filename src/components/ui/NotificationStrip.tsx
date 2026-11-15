import { useEffect, useState } from "react";
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

export function NotificationStrip() {
  const items = useNotificationStore((s) => s.items);
  const dismiss = useNotificationStore((s) => s.dismiss);
  const [entries, setEntries] = useState<RenderedNotification[]>(() =>
    items.map((item) => ({ item, exiting: false })),
  );

  useEffect(() => {
    const activeIds = new Set(items.map((i) => i.id));
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
    const activeIds = new Set(items.map((i) => i.id));
    const timer = window.setTimeout(() => {
      setEntries((prev) =>
        prev.filter((entry) => !entry.exiting || activeIds.has(entry.item.id)),
      );
    }, 175);
    return () => window.clearTimeout(timer);
  }, [exitingKey, items]);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed top-4 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-1.5 max-w-md w-full px-4">
      {entries.map(({ item, exiting }) => (
        <div
          key={item.id}
          role="status"
          className={`${
            exiting
              ? "pointer-events-none anim-fade-slide-down"
              : "pointer-events-auto anim-fade-slide-up"
          } ep-glass-pill flex items-center justify-between gap-3 px-4 py-2 text-xs rounded-full ${KIND_STYLES[item.kind]}`}
        >
          <span className="truncate">{item.message}</span>
          <button
            type="button"
            onClick={() => dismiss(item.id)}
            aria-label="Dismiss notification"
            className="ep-bar-icon-btn ep-press h-5 w-5 -mr-1 rounded-full inline-flex items-center justify-center text-muted hover:text-primary shrink-0 cursor-pointer"
          >
            <AppCloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
