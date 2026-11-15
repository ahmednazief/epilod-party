export const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "ts",
  "m2ts",
  "avi",
  "webm",
  "flv",
  "wmv",
  "ogv",
  "3gp",
  "mov",
  "m4v",
  "mpg",
  "mpeg",
  "vob",
]);

export const SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa", "vtt", "sub", "idx"]);

export type DroppedFileKind = "video" | "subtitle" | "unsupported";

export interface SplitDroppedFilesResult {
  videoPath: string | null;
  subtitlePath: string | null;
  extraVideoCount: number;
  extraSubtitleCount: number;
  unsupportedFiles: string[];
  directorySuspected: boolean;
}

export function getFileDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

export function getFileExtension(path: string): string {
  const name = getFileDisplayName(path);
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) {
    return "";
  }
  return name.slice(idx + 1).toLowerCase();
}

export function classifyDroppedFile(path: string): DroppedFileKind {
  const ext = getFileExtension(path);
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (SUBTITLE_EXTENSIONS.has(ext)) {
    return "subtitle";
  }
  return "unsupported";
}

/**
 * Fix 19: Categorizes dropped paths and captures extra/unsupported/directory drops
 * so the UI can explain ignored files cleanly instead of silently discarding them.
 */
export function splitDroppedFiles(paths: readonly string[]): SplitDroppedFilesResult {
  let videoPath: string | null = null;
  let subtitlePath: string | null = null;
  let extraVideoCount = 0;
  let extraSubtitleCount = 0;
  const unsupportedFiles: string[] = [];
  let directorySuspected = false;

  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const ext = getFileExtension(trimmed);
    if (!ext) {
      directorySuspected = true;
      unsupportedFiles.push(getFileDisplayName(trimmed));
      continue;
    }
    const kind = classifyDroppedFile(trimmed);
    if (kind === "video") {
      if (!videoPath) {
        videoPath = trimmed;
      } else {
        extraVideoCount += 1;
      }
    } else if (kind === "subtitle") {
      if (!subtitlePath) {
        subtitlePath = trimmed;
      } else {
        extraSubtitleCount += 1;
      }
    } else {
      unsupportedFiles.push(getFileDisplayName(trimmed));
    }
  }

  return {
    videoPath,
    subtitlePath,
    extraVideoCount,
    extraSubtitleCount,
    unsupportedFiles,
    directorySuspected,
  };
}
