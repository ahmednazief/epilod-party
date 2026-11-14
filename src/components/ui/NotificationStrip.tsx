import { X } from "lucide-react";
import { useNotificationStore, type NotificationKind } from "../../store/useNotificationStore";

const KIND_STYLES: Record<NotificationKind, string> = {
  info: "border-hairline bg-chrome text-primary",
  success: "border-ok/40 bg-chrome text-ok",
  warn: "border-warn/40 bg-chrome text-warn",
  error: "border-bad/40 bg-chrome text-bad",
};

export function NotificationStrip() {
  const items = useNotificationStore((s) => s.items);
  const dismiss = useNotificationStore((s) => s.dismiss);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 bg-canvas border-b border-hairline">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={`anim-fade-slide-up flex items-center justify-between gap-3 px-3 py-1.5 text-xs border rounded-[var(--radius-ui)] ${KIND_STYLES[item.kind]}`}
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
