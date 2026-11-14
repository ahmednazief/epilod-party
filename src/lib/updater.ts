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

function getPreviewFallbackStatus(): AppUpdateStatus {
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const mode = (params?.get("updatePreview") ?? "").trim().toLowerCase();

  if (mode === "available" || mode === "ready") {
    const release: ReleaseManifest = {
      version: "0.2.0",
      releasedAt: "2026-11-15T12:00:00Z",
      notes: "Improved embedded mpv sync stability and incremental SHA-256 updater.",
      downloadUrl:
        "https://github.com/ahmednazief/epilod-party/releases/download/v0.2.0/Epilod.Party.Setup.exe",
      sha256: "a".repeat(64),
      sizeBytes: 96_400_000,
      minSupportedVersion: "0.1.0",
      fileName: "Epilod Party Setup.exe",
    };
    return {
      currentVersion: "0.1.0",
      availability: mode === "ready" ? "downloadedReady" : "updateAvailable",
      availableRelease: release,
      downloadedInstallerPath:
        mode === "ready"
          ? String.raw`%LocalAppData%\EpilodParty\updates\Epilod Party Setup-0.2.0.exe`
          : null,
      cacheDir: String.raw`%LocalAppData%\EpilodParty\updates`,
      checkedAtUnix: Math.floor(Date.now() / 1000),
      signatureVerified: false,
      message:
        mode === "ready"
          ? "Epilod Party v0.2.0 downloaded and verified — ready to install"
          : "Update available: Epilod Party v0.2.0",
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
    return getPreviewFallbackStatus();
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
