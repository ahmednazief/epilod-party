import { X } from "lucide-react";
import {
  PLAYER_SHORTCUTS,
  SHORTCUT_CATEGORIES,
} from "../lib/shortcuts";
import { Button } from "./ui/Button";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  if (!open) return null;

  return (
    <div
      className="anim-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-canvas/85 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="anim-modal-in w-full max-w-lg bg-chrome border border-hairline rounded-[var(--radius-ui)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
          <h2 className="text-sm font-medium text-primary">Keyboard Shortcuts</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close shortcuts">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 max-h-[70vh] overflow-y-auto space-y-5">
          {SHORTCUT_CATEGORIES.map((category) => {
            const rows = PLAYER_SHORTCUTS.filter((s) => s.category === category);
            return (
              <div key={category} className="space-y-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">
                  {category}
                </h3>
                <div className="divide-y divide-hairline border border-hairline rounded-[var(--radius-ui)] bg-canvas">
                  {rows.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                    >
                      <span className="text-secondary">{row.label}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {row.keys.map((key) => (
                          <kbd
                            key={key}
                            className="px-1.5 py-0.5 text-[11px] font-medium bg-raised text-primary border border-hairline rounded-[4px]"
                          >
                            {key}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
