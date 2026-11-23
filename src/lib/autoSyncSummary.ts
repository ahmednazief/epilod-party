import type { AutoSyncResult } from "./mpv";

export type AutoSyncStage =
  | "extracting_sub"
  | "extracting_audio"
  | "aligning"
  | "applying"
  | null;

export type AutoSyncFixTone = "accent" | "good" | "warn" | "neutral";

export interface AutoSyncFixBadge {
  label: string;
  tone: AutoSyncFixTone;
}

export interface AutoSyncSummary {
  alreadyInSync: boolean;
  headline: string;
  fixes: AutoSyncFixBadge[];
  segmentDetails: string[];
  confidenceLabel: string;
  elapsedLabel: string;
  toastText: string;
}

export function isAutoSyncStage(value: unknown): value is Exclude<AutoSyncStage, null> {
  return (
    value === "extracting_sub" ||
    value === "extracting_audio" ||
    value === "aligning" ||
    value === "applying"
  );
}

export function formatAutoSyncStage(stage: AutoSyncStage): string {
  switch (stage) {
    case "extracting_sub":
      return "Reading subtitle track…";
    case "extracting_audio":
      return "Extracting audio track…";
    case "aligning":
      return "Matching speech timing…";
    case "applying":
      return "Applying synced timing…";
    default:
      return "Syncing subtitles…";
  }
}

const KNOWN_FPS_RATIOS: ReadonlyArray<{ ratio: number; label: string }> = [
  { ratio: 23.976 / 25.0, label: "25 → 23.976 fps" },
  { ratio: 25.0 / 23.976, label: "23.976 → 25 fps" },
  { ratio: 24.0 / 25.0, label: "25 → 24 fps" },
  { ratio: 25.0 / 24.0, label: "24 → 25 fps" },
  { ratio: 24000 / 1001 / 24.0, label: "24 → 23.976 fps" },
  { ratio: 24.0 / (24000 / 1001), label: "23.976 → 24 fps" },
];

export function formatFramerateDriftLabel(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) {
    return "Speed adjusted";
  }
  for (const candidate of KNOWN_FPS_RATIOS) {
    if (Math.abs(scale - candidate.ratio) <= 0.0006) {
      return candidate.label;
    }
  }
  const pct = (scale - 1) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `Speed ×${scale.toFixed(4)} (${sign}${pct.toFixed(2)}%)`;
}

function formatSignedOffset(secs: number): string {
  const rounded = Math.round(secs * 100) / 100;
  if (Math.abs(rounded) < 0.005) {
    return "+0.00s";
  }
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(2)}s`;
}

function formatTimestampShort(secs: number): string {
  const whole = Math.max(0, Math.floor(secs));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function summarizeAutoSyncOutcome(outcome: AutoSyncResult): AutoSyncSummary {
  const segmentsList = Array.isArray(outcome.segments) ? outcome.segments : [];
  const segmentsCount = Math.max(1, outcome.segmentsApplied ?? (segmentsList.length || 1));
  const alreadyInSync =
    !outcome.driftApplied && segmentsCount <= 1 && Math.abs(outcome.offsetSecs) < 0.05;

  const confidenceLabel =
    outcome.confidenceZ >= 8
      ? "High confidence"
      : outcome.confidenceZ >= 5
        ? "Good match"
        : "Matched";

  const elapsedLabel =
    outcome.elapsedMs >= 1000
      ? `${(outcome.elapsedMs / 1000).toFixed(1)}s`
      : `${Math.max(1, Math.round(outcome.elapsedMs))}ms`;

  const fixes: AutoSyncFixBadge[] = [];
  const segmentDetails: string[] = [];

  if (alreadyInSync) {
    fixes.push({ label: "No shift needed", tone: "good" });
    if (outcome.bitmapInPlace) {
      fixes.push({ label: "Live mpv delay", tone: "neutral" });
    }
    return {
      alreadyInSync: true,
      headline: "Already in sync",
      fixes,
      segmentDetails,
      confidenceLabel,
      elapsedLabel,
      toastText: "Magic Sync: Subtitles are already in sync with speech.",
    };
  }

  if (segmentsCount > 1 && segmentsList.length > 1) {
    const offsets = segmentsList.map((seg) => seg.offsetSecs);
    const minOff = Math.min(...offsets);
    const maxOff = Math.max(...offsets);
    const shiftSpan =
      Math.abs(maxOff - minOff) < 0.05
        ? formatSignedOffset(minOff)
        : `${formatSignedOffset(minOff)} to ${formatSignedOffset(maxOff)}`;
    fixes.push({ label: `Shifts ${shiftSpan}`, tone: "accent" });
    fixes.push({ label: `${segmentsCount} segments`, tone: "warn" });
    for (const seg of segmentsList) {
      segmentDetails.push(
        `${formatTimestampShort(seg.startSecs)} → ${formatSignedOffset(seg.offsetSecs)}`,
      );
    }
  } else if (Math.abs(outcome.offsetSecs) >= 0.05) {
    const direction = outcome.offsetSecs > 0 ? "later" : "earlier";
    fixes.push({
      label: `Shifted ${formatSignedOffset(outcome.offsetSecs)} (${direction})`,
      tone: "accent",
    });
  } else if (segmentsCount > 1) {
    fixes.push({ label: `${segmentsCount} segments`, tone: "warn" });
  }

  if (outcome.driftApplied) {
    fixes.push({
      label: formatFramerateDriftLabel(outcome.scale),
      tone: "good",
    });
  }

  if (outcome.bitmapInPlace) {
    fixes.push({
      label: "Live mpv delay",
      tone: "neutral",
    });
  }

  const headline = outcome.bitmapInPlace
    ? "Image subtitles aligned"
    : segmentsCount > 1
      ? `Matched across ${segmentsCount} segments`
      : "Subtitles matched to speech";

  const toastFixes = fixes
    .filter((f) => f.tone !== "neutral")
    .map((f) => f.label)
    .join(", ");
  const toastText = toastFixes
    ? `Magic Sync: ${toastFixes}.`
    : `${headline}.`;

  return {
    alreadyInSync: false,
    headline,
    fixes,
    segmentDetails,
    confidenceLabel,
    elapsedLabel,
    toastText,
  };
}
