import { Fragment, useEffect } from "react";
import { AppCloseIcon } from "./ui/AppIcons";
import { PLAYER_SHORTCUTS, SHORTCUT_CATEGORIES } from "../lib/shortcuts";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";

const MODIFIER_KEYS = new Set(["Shift", "Ctrl", "Control", "Alt", "Meta", "Cmd"]);

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  const { mounted, exiting } = useAnimatedPresence(open, 200);

  useEffect(() => {
    if (!open || exiting) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, exiting, onClose]);

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
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
        } relative z-10 w-full max-w-3xl rounded-[26px] overflow-hidden`}
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

        <div className="ep-menu-scroll px-6 pb-5 pt-1 max-h-[76vh] overflow-y-auto overflow-x-hidden grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
          {[
            SHORTCUT_CATEGORIES.filter((c) => c === "Playback"),
            SHORTCUT_CATEGORIES.filter((c) => c !== "Playback"),
          ].map((colCategories, colIdx) => (
            <div key={colIdx} className="space-y-4">
              {colCategories.map((category) => {
                const rows = PLAYER_SHORTCUTS.filter((s) => s.category === category);
                return (
                  <div key={category} className="space-y-1">
                    <h3 className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted">
                      {category}
                    </h3>
                    <div className="space-y-0.5">
                      {rows.map((row) => (
                        <div
                          key={row.label}
                          className="flex items-center justify-between gap-2.5 px-2 py-1.5 text-xs rounded-xl hover:bg-white/[0.04] transition-colors"
                        >
                          <span className="text-secondary leading-snug">{row.label}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            {row.keys.map((key, idx) => {
                              const isCombo = MODIFIER_KEYS.has(row.keys[0]);
                              return (
                                <Fragment key={key}>
                                  {idx > 0 && (
                                    <span className="text-[10px] text-white/50 select-none px-0.5">
                                      {isCombo ? "+" : "/"}
                                    </span>
                                  )}
                                  <kbd className="ep-glass-tray px-2 py-0.5 text-[11px] font-medium text-white rounded-md">
                                    {key}
                                  </kbd>
                                </Fragment>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
