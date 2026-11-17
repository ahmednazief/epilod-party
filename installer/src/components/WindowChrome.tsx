import type { ReactNode } from "react";
import { closeInstallerWindow, minimizeInstallerWindow } from "../lib/installerBridge";
import { InstallerCloseIcon, InstallerMinimizeIcon } from "./InstallerIcons";

interface WindowChromeProps {
  leftSlot?: ReactNode;
}

/** Discreet draggable title bar with dark greyish liquid glass controls. */
export function WindowChrome({ leftSlot }: WindowChromeProps) {
  return (
    <header className="relative z-20 flex h-10 shrink-0 items-center justify-between px-3.5 pt-1 select-none">
      <div className="flex items-center min-w-0">{leftSlot}</div>

      <div data-tauri-drag-region className="h-full min-w-4 flex-1 cursor-default" aria-hidden="true" />

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          aria-label="Minimize installer"
          title="Minimize"
          onClick={() => void minimizeInstallerWindow()}
          className="ep-bar-icon-btn inline-flex h-6.5 w-6.5 cursor-pointer items-center justify-center rounded-full text-white/55 hover:text-white"
        >
          <InstallerMinimizeIcon size={12} />
        </button>

        <button
          type="button"
          aria-label="Close installer"
          title="Close"
          onClick={() => void closeInstallerWindow()}
          className="ep-bar-icon-btn inline-flex h-6.5 w-6.5 cursor-pointer items-center justify-center rounded-full text-white/55 hover:bg-red-500/75 hover:text-white"
        >
          <InstallerCloseIcon size={12} />
        </button>
      </div>
    </header>
  );
}
