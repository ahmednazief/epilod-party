import { AppAlertIcon, AppFolderIcon } from "./ui/AppIcons";
import { OpenMediaIcon } from "./ui/LobbyIcons";
import { Button } from "./ui/Button";
import { LogoMark } from "./ui/LogoMark";

interface ViewportPlaceholderProps {
  loaded: boolean;
  isDragActive: boolean;
  playerError: string | null;
  clearanceBottom?: "none" | "bar" | "extended";
  onChooseFile: () => void;
  onChooseFolder?: () => void;
  onRetryPlayer?: () => void;
}

export function ViewportPlaceholder({
  loaded,
  isDragActive,
  playerError,
  clearanceBottom = "bar",
  onChooseFile,
  onChooseFolder,
  onRetryPlayer,
}: ViewportPlaceholderProps) {
  if (loaded && !playerError) return null;

  const offsetClass =
    clearanceBottom === "extended"
      ? "-translate-y-24"
      : clearanceBottom === "bar"
        ? "-translate-y-6"
        : "translate-y-0";

  return (
    <div className="ep-amethyst-canvas absolute inset-0 h-full w-full flex flex-col items-center justify-center p-6 select-none">
      <div className="pointer-events-none absolute inset-0 overflow-hidden z-0" aria-hidden="true">
        <div className="ep-ambient-orb-purple absolute left-[28%] top-[26%] h-64 w-64 rounded-full" />
        <div className="ep-ambient-orb-silver absolute right-[26%] top-[34%] h-64 w-64 rounded-full" />
      </div>
      {playerError ? (
        <div
          className={`ep-glass-sheet anim-fade-slide-up relative z-10 max-w-md w-full rounded-[24px] p-7 text-center flex flex-col items-center gap-3.5 transition-transform duration-200 ${offsetClass}`}
        >
          <div className="h-11 w-11 rounded-full bg-bad/15 text-bad flex items-center justify-center">
            <AppAlertIcon variant="warn" size={20} />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-sm font-medium text-white">Playback Engine Issue</h3>
            <p className="text-xs text-secondary leading-relaxed">{playerError}</p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            {onRetryPlayer && (
              <Button variant="primary" size="sm" onClick={onRetryPlayer}>
                Retry Player
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onChooseFile}>
              Choose Another File
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`relative z-10 max-w-md w-full rounded-[26px] p-8 text-center flex flex-col items-center gap-4 transition-[transform,background-color] duration-200 ${offsetClass} ${
            isDragActive ? "ep-glass-sheet scale-[1.02]" : ""
          }`}
        >
          <div className={isDragActive ? "anim-drop-float" : ""}>
            <LogoMark
              variant="party"
              size={56}
              className={`transition-transform duration-200 ${
                isDragActive ? "scale-105 opacity-100" : "opacity-95"
              }`}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-base font-medium tracking-tight text-white">
              {isDragActive ? "Drop video, subtitle, or season folder" : "Drop a movie or season folder"}
            </p>
            <p className="text-xs text-secondary leading-relaxed max-w-xs mx-auto">
              Plays directly from your device — drag an entire season folder or an .srt, .ass, or .vtt file anytime.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" size="md" onClick={onChooseFile}>
              <OpenMediaIcon bare size={16} />
              Choose Video File
            </Button>
            {onChooseFolder && (
              <Button variant="secondary" size="md" onClick={onChooseFolder}>
                <AppFolderIcon size={16} />
                Season Folder
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
