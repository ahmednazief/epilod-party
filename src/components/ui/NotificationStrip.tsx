import { X } from "lucide-react";
import { useNotificationStore, type NotificationKind } from "../../store/useNotificationStore";

const KIND_STYLES: Record<NotificationKind, string> = {
  info: "text-primary",
  success: "text-ok",
  warn: "text-warn",
  error: "text-bad",
};

export function NotificationStrip() {
  const items = useNotificationStore((s) => s.items);
  const dismiss = useNotificationStore((s) => s.dismiss);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed top-4 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-1.5 max-w-md w-full px-4">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={`pointer-events-auto anim-fade-slide-up ep-glass-pill flex items-center justify-between gap-3 px-4 py-2 text-xs rounded-full ${KIND_STYLES[item.kind]}`}
        >
          <span className="truncate">{item.message}</span>
          <button
            type="button"
            onClick={() => dismiss(item.id)}
            aria-label="Dismiss notification"
            className="text-muted hover:text-primary shrink-0 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
