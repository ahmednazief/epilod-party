import type { ReactNode } from "react";
import { closeInstallerWindow, minimizeInstallerWindow } from "../lib/installerBridge";
import { InstallerCloseIcon, InstallerMinimizeIcon } from "./InstallerIcons";

interface WindowChromeProps {
  leftSlot?: ReactNode;
}

/** Discreet draggable title bar matching the main app's crystal icon buttons. */
export function WindowChrome({ leftSlot }: WindowChromeProps) {
  return (
    <header className="relative z-20 flex h-11 shrink-0 items-center justify-between px-4 pt-1 select-none">
      <div className="flex items-center">{leftSlot}</div>

      <div data-tauri-drag-region className="h-full min-w-6 flex-1" aria-hidden="true" />

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Minimize installer"
          title="Minimize"
          onClick={() => void minimizeInstallerWindow()}
          className="ep-bar-icon-btn inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-white/65 hover:text-white focus-visible:outline-2 focus-visible:outline-[#8B5CF6]"
        >
          <InstallerMinimizeIcon size={13} />
        </button>

        <button
          type="button"
          aria-label="Close installer"
          title="Close"
          onClick={() => void closeInstallerWindow()}
          className="ep-bar-icon-btn inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-white/65 hover:bg-red-500/75 hover:text-white focus-visible:outline-2 focus-visible:outline-[#8B5CF6]"
        >
          <InstallerCloseIcon size={13} />
        </button>
      </div>
    </header>
  );
}
