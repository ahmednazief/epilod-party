import { formatBytes } from "../lib/installerBridge";
import type { InstallOptions } from "../lib/types";
import { GlassSwitchTrack } from "./GlassSwitch";
import { InstallerFolderIcon, InstallerResetIcon } from "./InstallerIcons";

interface CustomizePanelProps {
  options: InstallOptions;
  defaultInstallDir: string | null;
  tauriMode: boolean;
  disabled: boolean;
  pathError: string | null;
  insufficientDiskSpace: boolean;
  peakRequiredBytes: number;
  freeDiskBytes: number | null;
  otherInstallDir?: string | null;
  otherInstallVersion?: string | null;
  ctaLabel: string;
  installBlocked: boolean;
  onDirChange: (value: string) => void;
  onDirBlurOrEnter: () => void;
  onResetDir: () => void;
  onBrowseDir: () => void;
  onUpdateOptions: (updater: (prev: InstallOptions) => InstallOptions) => void;
  onSaveAndInstall: () => void;
}

/** Compact frosted sheet for changing install folder and desktop/launch toggles. */
export function CustomizePanel({
  options,
  defaultInstallDir,
  tauriMode,
  disabled,
  pathError,
  insufficientDiskSpace,
  peakRequiredBytes,
  freeDiskBytes,
  otherInstallDir,
  otherInstallVersion,
  ctaLabel,
  installBlocked,
  onDirChange,
  onDirBlurOrEnter,
  onResetDir,
  onBrowseDir,
  onUpdateOptions,
  onSaveAndInstall,
}: CustomizePanelProps) {
  const showReset =
    Boolean(defaultInstallDir) && options.installDir !== defaultInstallDir && !disabled;

  const toggles: Array<{
    key: "createDesktopShortcut" | "createStartMenuShortcut" | "registerFileAssociations" | "autoLaunch";
    label: string;
  }> = [
    { key: "createDesktopShortcut", label: "Desktop shortcut" },
    { key: "createStartMenuShortcut", label: "Start Menu shortcut" },
    { key: "registerFileAssociations", label: 'Windows "Open with" menu' },
    { key: "autoLaunch", label: "Open when finished" },
  ];

  const folderWarning =
    pathError ??
    (insufficientDiskSpace && freeDiskBytes !== null
      ? `Needs ${formatBytes(peakRequiredBytes)} free (${formatBytes(freeDiskBytes)} available).`
      : null);

  return (
    <div className="ep-view-enter w-full max-w-[376px] space-y-2">
      <div className="ep-glass-well rounded-2xl px-3.5 py-2 space-y-1">
        <div className="flex items-center justify-between gap-2 text-xs">
          <label htmlFor="ep-install-dir" className="text-white/55">
            Install folder
          </label>
          <div className="flex items-center gap-2.5">
            {showReset && (
              <button
                type="button"
                onClick={onResetDir}
                className="inline-flex items-center gap-1 text-xs font-medium text-white/60 hover:text-white cursor-pointer"
              >
                <InstallerResetIcon size={11} />
                <span>Reset</span>
              </button>
            )}
            {tauriMode && (
              <button
                type="button"
                disabled={disabled}
                onClick={onBrowseDir}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#C4B5FD] hover:text-white disabled:opacity-45 cursor-pointer"
              >
                <InstallerFolderIcon size={11} />
                <span>Browse</span>
              </button>
            )}
          </div>
        </div>

        <input
          id="ep-install-dir"
          type="text"
          value={options.installDir}
          disabled={disabled}
          onChange={(e) => onDirChange(e.target.value)}
          onBlur={onDirBlurOrEnter}
          onKeyDown={(e) => {
            if (e.key === "Enter") onDirBlurOrEnter();
          }}
          className="ep-glass-input h-7.5 w-full rounded-xl px-2.5 text-xs text-white/90 focus:outline-none disabled:opacity-50"
        />

        {folderWarning ? (
          <p className="truncate text-[11px] text-[#FCA5A5]" title={folderWarning}>
            {folderWarning}
          </p>
        ) : otherInstallDir ? (
          <p className="truncate text-[11px] text-[#C4B5FD]" title={otherInstallDir}>
            Replaces existing{otherInstallVersion ? ` v${otherInstallVersion}` : ""} copy on this PC
          </p>
        ) : null}
      </div>

      <div className="ep-glass-well divide-y divide-white/[0.06] rounded-2xl px-3.5 py-0.5">
        {toggles.map((item) => (
          <button
            key={item.key}
            type="button"
            role="switch"
            aria-checked={options[item.key]}
            disabled={disabled}
            onClick={() =>
              onUpdateOptions((prev) => ({
                ...prev,
                [item.key]: !prev[item.key],
              }))
            }
            className="flex w-full cursor-pointer items-center justify-between py-1 text-left text-xs text-white/85 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span>{item.label}</span>
            <GlassSwitchTrack checked={options[item.key]} />
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={installBlocked || disabled}
        onClick={onSaveAndInstall}
        className="ep-glass-primary-pill h-8.5 w-full cursor-pointer rounded-full text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
      >
        {ctaLabel}
      </button>
    </div>
  );
}
