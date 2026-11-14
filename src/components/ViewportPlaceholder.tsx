import { AlertTriangle, FolderOpen } from "lucide-react";
import { Button } from "./ui/Button";
import { LogoMark } from "./ui/LogoMark";

interface ViewportPlaceholderProps {
  loaded: boolean;
  isDragActive: boolean;
  playerError: string | null;
  onChooseFile: () => void;
  onRetryPlayer?: () => void;
}

export function ViewportPlaceholder({
  loaded,
  isDragActive,
  playerError,
  onChooseFile,
  onRetryPlayer,
}: ViewportPlaceholderProps) {
  if (loaded && !playerError) return null;

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-canvas select-none">
      {playerError ? (
        <div className="anim-fade-slide-up max-w-md w-full p-5 bg-chrome border border-bad/40 rounded-[var(--radius-ui)] text-center flex flex-col items-center gap-3">
          <AlertTriangle className="h-7 w-7 text-bad" />
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-primary">Playback Engine Issue</h3>
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
          className={`max-w-md w-full p-6 border border-dashed rounded-[var(--radius-ui)] text-center flex flex-col items-center gap-3 transition-colors duration-150 ${
            isDragActive
              ? "border-accent bg-chrome"
              : "border-hairline bg-chrome/60"
          }`}
        >
          <div className={isDragActive ? "anim-drop-float" : ""}>
            <LogoMark
              variant="party"
              size={52}
              className={`transition-transform duration-150 ${
                isDragActive ? "scale-105 opacity-100" : "opacity-95"
              }`}
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-primary">
              {isDragActive ? "Drop your video or subtitle file" : "Drop a video file here"}
            </p>
            <p className="text-xs text-secondary">
              Plays locally via mpv — nothing is uploaded. Drag an .srt / .ass / .vtt file too if needed.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={onChooseFile}>
            <FolderOpen className="h-3.5 w-3.5" />
            Choose Video File
          </Button>
        </div>
      )}
    </div>
  );
}
