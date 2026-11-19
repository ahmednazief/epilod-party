import { getFileDisplayName } from "./fileDrop";

export interface ResumeEntry {
  positionSecs: number;
  durationSecs: number;
  updatedAt: number;
}

export const RESUME_MIN_SECS = 30;
export const RESUME_COMPLETE_RATIO = 0.95;
export const RESUME_MAX_ENTRIES = 200;

export function buildMediaFileKey(
  fileName: string | null | undefined,
  durationSecs: number,
  fileSizeBytes?: number | null,
): string | null {
  const cleanName = fileName ? getFileDisplayName(fileName).trim().toLowerCase() : "";
  if (!cleanName) {
    return null;
  }
  const dur = Number.isFinite(durationSecs) && durationSecs > 0 ? Math.round(durationSecs) : 0;
  if (dur <= 0) {
    return null;
  }
  if (typeof fileSizeBytes === "number" && Number.isFinite(fileSizeBytes) && fileSizeBytes > 0) {
    return `${cleanName}::${Math.round(fileSizeBytes)}::${dur}`;
  }
  return `${cleanName}::${dur}`;
}

export function shouldSaveResumePosition(positionSecs: number, durationSecs: number): "save" | "clear" | "skip" {
  if (!Number.isFinite(positionSecs) || !Number.isFinite(durationSecs) || durationSecs <= 0) {
    return "skip";
  }
  if (positionSecs > durationSecs * RESUME_COMPLETE_RATIO) {
    return "clear";
  }
  if (positionSecs < RESUME_MIN_SECS) {
    return "skip";
  }
  return "save";
}

export function formatResumeClock(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
