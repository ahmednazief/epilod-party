import { AlertTriangle, FolderOpen } from "lucide-react";
import { Button } from "./ui/Button";
import { LogoMark } from "./ui/LogoMark";

interface ViewportPlaceholderProps {
  loaded: boolean;
  isDragActive: boolean;
  playerError: string | null;
  onChooseFile: () => void;
  onChooseFolder?: () => void;
  onRetryPlayer?: () => void;
}

export function ViewportPlaceholder({
  loaded,
  isDragActive,
  playerError,
  onChooseFile,
  onChooseFolder,
  onRetryPlayer,
}: ViewportPlaceholderProps) {
  if (loaded && !playerError) return null;

  return (
    <div className="ep-amethyst-canvas absolute inset-0 flex flex-col items-center justify-center p-6 select-none">
      <div className="pointer-events-none absolute inset-0 overflow-hidden z-0" aria-hidden="true">
        <div className="ep-ambient-orb-purple absolute left-[28%] top-[26%] h-64 w-64 rounded-full" />
        <div className="ep-ambient-orb-silver absolute right-[26%] top-[34%] h-64 w-64 rounded-full" />
      </div>
      {playerError ? (
        <div className="ep-glass-sheet anim-fade-slide-up relative z-10 max-w-md w-full rounded-[24px] p-7 text-center flex flex-col items-center gap-3.5">
          <div className="h-11 w-11 rounded-full bg-bad/15 text-bad flex items-center justify-center">
            <AlertTriangle className="h-5 w-5" />
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
          className={`relative z-10 max-w-md w-full rounded-[26px] p-8 text-center flex flex-col items-center gap-4 transition-all duration-300 ${
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
              <FolderOpen className="h-4 w-4" />
              Choose Video File
            </Button>
            {onChooseFolder && (
              <Button variant="secondary" size="md" onClick={onChooseFolder}>
                <FolderOpen className="h-4 w-4" />
                Season Folder
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
