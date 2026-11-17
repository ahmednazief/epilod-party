import { listen } from "@tauri-apps/api/event";
import { isDesktop, safeInvoke } from "./bridge";

export type UpdateAvailability =
  | "upToDate"
  | "updateAvailable"
  | "downloadedReady"
  | "unsupportedUpgrade";

export interface ReleaseManifest {
  version: string;
  releasedAt: string;
  notes: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  minSupportedVersion?: string | null;
  fileName?: string | null;
  signature?: string | null;
}

export interface AppUpdateStatus {
  currentVersion: string;
  availability: UpdateAvailability;
  availableRelease: ReleaseManifest | null;
  downloadedInstallerPath: string | null;
  cacheDir: string;
  checkedAtUnix: number | null;
  signatureVerified?: boolean;
  message: string;
}

export interface UpdateProgressEvent {
  stage: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  message: string;
}

export interface ReleaseNoteSegment {
  text: string;
  bold: boolean;
}

export interface ReleaseNoteItem {
  title?: string;
  body: string;
  segments: ReleaseNoteSegment[];
}

export function splitInlineBold(text: string): ReleaseNoteSegment[] {
  const clean = text.trim();
  if (!clean) return [];
  const out: ReleaseNoteSegment[] = [];
  const pattern = /\*\*([^*]+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    if (match.index > lastIndex) {
      out.push({ text: clean.slice(lastIndex, match.index), bold: false });
    }
    const inner = match[1].trim();
    if (inner) {
      out.push({ text: inner, bold: true });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < clean.length) {
    out.push({ text: clean.slice(lastIndex), bold: false });
  }
  return out.length > 0 ? out : [{ text: clean, bold: false }];
}

/**
 * Normalizes markdown bullets, legacy semicolon-separated strings, and inline bold markers
 * into concise UI-ready release note items so raw markdown symbols never show in Settings.
 */
export function parseReleaseNotes(rawNotes?: string | null): ReleaseNoteItem[] {
  const normalized = (rawNotes ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  let rawLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s+/.test(line));

  if (rawLines.length === 1 && rawLines[0].includes("; ")) {
    rawLines = rawLines[0]
      .split(/;\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  const items: ReleaseNoteItem[] = [];
  for (const rawLine of rawLines) {
    const stripped = rawLine
      .replace(/^(?:[-*•]+|\d+[.)])\s+/, "")
      .trim();
    if (!stripped) continue;

    const boldLeadMatch = /^\*\*([^*]+?)\*\*(?:\s*[:\-—–]\s*|\s+)(.+)$/.exec(stripped);
    if (boldLeadMatch) {
      const title = boldLeadMatch[1].replace(/[:\-—–\s]+$/, "").trim();
      const body = boldLeadMatch[2].trim();
      items.push({
        title,
        body,
        segments: splitInlineBold(body),
      });
      continue;
    }

    const boldOnlyMatch = /^\*\*([^*]+?)\*\*$/.exec(stripped);
    if (boldOnlyMatch) {
      const title = boldOnlyMatch[1].trim();
      items.push({ title, body: "", segments: [] });
      continue;
    }

    const plainColonMatch = /^([^:]{2,40}):\s+(.+)$/.exec(stripped);
    if (plainColonMatch && !plainColonMatch[1].includes("**")) {
      const title = plainColonMatch[1].trim();
      const body = plainColonMatch[2].trim();
      items.push({
        title,
        body,
        segments: splitInlineBold(body),
      });
      continue;
    }

    items.push({
      body: stripped,
      segments: splitInlineBold(stripped),
    });
  }

  return items;
}

export function formatBytesCompact(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

export function formatTransferSpeed(bps: number): string {
  if (!bps || bps <= 0) return "";
  if (bps >= 1024 * 1024) {
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.round(bps / 1024)} KB/s`;
}

export function getUpdatePreviewMode(): "available" | "downloading" | "ready" | null {
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const mode = (params?.get("updatePreview") ?? "").trim().toLowerCase();
  if (mode === "available" || mode === "downloading" || mode === "ready") {
    return mode;
  }
  return null;
}

export function getPreviewDownloadingProgress(): UpdateProgressEvent {
  return {
    stage: "downloading",
    downloadedBytes: 61_696_000,
    totalBytes: 96_400_000,
    percent: 64,
    speedBps: 5_872_025,
    message: "Downloading update (58.8 / 91.9 MB)",
  };
}

function getPreviewRelease(): ReleaseManifest {
  return {
    version: "0.2.0",
    releasedAt: "2026-11-15T12:00:00Z",
    notes: [
      "- **Smoother Skipping**: Jumping through a video lands cleanly without glitches.",
      "- **Clearer Seek Bubble**: Skipping shows a liquid-glass bubble that pops in and fades out smoothly.",
      "- **Seamless Updates**: Automatic background downloads verify safely and stay ready to restart.",
    ].join("\n"),
    downloadUrl:
      "https://github.com/ahmednazief/epilod-party/releases/download/v0.2.0/Epilod.Party.Setup.exe",
    sha256: "a".repeat(64),
    sizeBytes: 96_400_000,
    minSupportedVersion: "0.1.0",
    fileName: "Epilod Party Setup.exe",
  };
}

function getPreviewFallbackStatus(
  forcedAvailability?: "available" | "ready",
  releaseOverride?: ReleaseManifest | null,
): AppUpdateStatus {
  const mode = forcedAvailability ?? getUpdatePreviewMode();

  if (mode === "available" || mode === "downloading" || mode === "ready") {
    const release = releaseOverride ?? getPreviewRelease();
    const isReady = mode === "ready";
    return {
      currentVersion: "0.1.0",
      availability: isReady ? "downloadedReady" : "updateAvailable",
      availableRelease: release,
      downloadedInstallerPath: isReady
        ? String.raw`%LocalAppData%\EpilodParty\updates\Epilod Party Setup-${release.version}.exe`
        : null,
      cacheDir: String.raw`%LocalAppData%\EpilodParty\updates`,
      checkedAtUnix: Math.floor(Date.now() / 1000),
      signatureVerified: false,
      message: isReady
        ? `Epilod Party v${release.version} downloaded and verified — ready to install`
        : `Update available: Epilod Party v${release.version}`,
    };
  }

  return {
    currentVersion: "0.1.0",
    availability: "upToDate",
    availableRelease: null,
    downloadedInstallerPath: null,
    cacheDir: String.raw`%LocalAppData%\EpilodParty\updates`,
    checkedAtUnix: null,
    signatureVerified: false,
    message: "Epilod Party v0.1.0 is up to date",
  };
}

export async function getUpdateStatus(): Promise<AppUpdateStatus> {
  if (!isDesktop()) {
    return getPreviewFallbackStatus();
  }
  return safeInvoke<AppUpdateStatus>("update_get_status");
}

export async function checkForUpdates(): Promise<AppUpdateStatus> {
  if (!isDesktop()) {
    return getPreviewFallbackStatus();
  }
  return safeInvoke<AppUpdateStatus>("update_check");
}

export async function downloadUpdate(
  manifest?: ReleaseManifest | null,
): Promise<AppUpdateStatus> {
  if (!isDesktop()) {
    return getPreviewFallbackStatus("ready", manifest);
  }
  return safeInvoke<AppUpdateStatus>("update_download", {
    manifest: manifest ?? null,
  });
}

export async function cancelUpdateDownload(): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke<void>("update_cancel_download");
}

export async function applyAndRestartUpdate(): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke<void>("update_apply_and_restart");
}

export async function onUpdateProgress(
  handler: (event: UpdateProgressEvent) => void,
): Promise<() => void> {
  if (!isDesktop()) {
    return () => {};
  }
  return listen<UpdateProgressEvent>("updater://progress", (e) => {
    handler(e.payload);
  });
}
