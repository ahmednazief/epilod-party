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
        <div className="anim-fade-slide-up max-w-md w-full p-6 bg-chrome border border-bad/35 rounded-xl text-center flex flex-col items-center gap-3.5">
          <AlertTriangle className="h-7 w-7 text-bad" />
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-primary">Couldn&apos;t start playback</h3>
            <p className="text-xs text-secondary leading-relaxed">{playerError}</p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            {onRetryPlayer && (
              <Button variant="primary" size="sm" onClick={onRetryPlayer}>
                Try Again
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onChooseFile}>
              Choose Another Video
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`max-w-md w-full px-8 py-9 border border-dashed rounded-xl text-center flex flex-col items-center gap-4 transition-colors duration-150 ${
            isDragActive
              ? "border-accent bg-chrome"
              : "border-hairline bg-chrome/65"
          }`}
        >
          <div className={isDragActive ? "anim-drop-float" : ""}>
            <LogoMark
              variant="party"
              size={60}
              className={`rounded-2xl transition-transform duration-150 ${
                isDragActive ? "scale-105 opacity-100" : "opacity-95"
              }`}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-[15px] font-medium text-primary">
              {isDragActive ? "Drop to load into watch party" : "Drop a video or subtitle file here"}
            </p>
            <p className="text-xs text-secondary leading-relaxed">
              Plays directly from your device — nothing is uploaded.
            </p>
          </div>
          <Button variant="primary" size="md" onClick={onChooseFile}>
            <FolderOpen className="h-4 w-4" />
            Choose Video
          </Button>
        </div>
      )}
    </div>
  );
}
