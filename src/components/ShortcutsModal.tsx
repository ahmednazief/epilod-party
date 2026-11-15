import { X } from "lucide-react";
import { PLAYER_SHORTCUTS, SHORTCUT_CATEGORIES } from "../lib/shortcuts";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  if (!open) return null;

  return (
    <div
      className="ep-modal-backdrop anim-backdrop-in fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ep-glass-sheet anim-modal-in w-full max-w-lg rounded-[26px] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-sm font-semibold tracking-tight text-white">
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="ep-hairline-divider mx-6" />

        <div className="px-6 py-4 max-h-[70vh] overflow-y-auto space-y-5">
          {SHORTCUT_CATEGORIES.map((category) => {
            const rows = PLAYER_SHORTCUTS.filter((s) => s.category === category);
            return (
              <div key={category} className="space-y-1.5">
                <h3 className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted">
                  {category}
                </h3>
                <div className="space-y-0.5">
                  {rows.map((row) => (
                    <div
                      key={row.label}
                      className="ep-menu-row flex items-center justify-between gap-3 px-2.5 py-2 text-xs"
                    >
                      <span className="text-secondary">{row.label}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {row.keys.map((key) => (
                          <kbd
                            key={key}
                            className="ep-glass-input px-2 py-0.5 text-[11px] font-medium text-white rounded-md"
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
