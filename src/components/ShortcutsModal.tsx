import { AppCloseIcon } from "./ui/AppIcons";
import { PLAYER_SHORTCUTS, SHORTCUT_CATEGORIES } from "../lib/shortcuts";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  const { mounted, exiting } = useAnimatedPresence(open, 200);
  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard Shortcuts"
    >
      {/* Sibling backdrop scrim keeps .ep-glass-sheet outside parent backdrop-filter root. */}
      <div
        aria-hidden="true"
        onClick={() => {
          if (!exiting) onClose();
        }}
        className={`ep-modal-backdrop ${
          exiting ? "anim-backdrop-out pointer-events-none" : "anim-backdrop-in"
        } fixed inset-0`}
      />
      <div
        className={`ep-glass-sheet ${
          exiting ? "anim-modal-out" : "anim-modal-in"
        } relative z-10 w-full max-w-lg rounded-[26px] overflow-hidden`}
      >
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="text-sm font-semibold tracking-tight text-white">
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="ep-bar-icon-btn ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
          >
            <AppCloseIcon size={16} />
          </button>
        </div>

        <div className="ep-menu-scroll px-6 py-3 my-1 max-h-[70vh] overflow-y-auto overflow-x-hidden space-y-4">
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
                      className="flex items-center justify-between gap-3 px-2.5 py-2 text-xs rounded-xl hover:bg-white/[0.04] transition-colors"
                    >
                      <span className="text-secondary">{row.label}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {row.keys.map((key) => (
                          <kbd
                            key={key}
                            className="ep-glass-tray px-2 py-0.5 text-[11px] font-medium text-white rounded-md"
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
