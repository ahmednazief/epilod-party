import type {
  DestinationInspection,
  ExistingInstallReport,
  InstallDisposition,
  InstallMode,
  InstallOptions,
  InstallPhase,
  InstallTelemetry,
  InstallerDefaults,
  PreflightResult,
  RunningProcessDto,
  StepProgress,
  TileId,
  UninstallOptions,
  UninstallSummary,
} from "./types";

export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type PreviewScenario =
  | "fresh"
  | "verify"
  | "repair"
  | "update"
  | "downgrade"
  | "locked"
  | "uninstall";

export function getPreviewScenario(): PreviewScenario {
  if (typeof window === "undefined") {
    return "fresh";
  }
  const params = new URLSearchParams(window.location.search);
  const mode = (params.get("mode") ?? "").trim().toLowerCase();
  switch (mode) {
    case "verify":
      return "verify";
    case "repair":
      return "repair";
    case "update":
      return "update";
    case "downgrade":
      return "downgrade";
    case "locked":
      return "locked";
    case "uninstall":
      return "uninstall";
    default:
      return "fresh";
  }
}

export function formatBytes(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb) {
    return `${(bytes / gb).toFixed(1)} GB`;
  }
  return `${(bytes / mb).toFixed(1)} MB`;
}

export function formatBytesPair(done: number, total: number): string {
  const mb = 1024 * 1024;
  const kb = 1024;
  if (total >= mb) {
    return `${(done / mb).toFixed(1)} / ${(total / mb).toFixed(1)} MB`;
  }
  if (total >= kb) {
    return `${Math.round(done / kb)} / ${Math.round(total / kb)} KB`;
  }
  return `${done} / ${total} B`;
}

/**
 * Separates the semantic operation phrase ("Unpacking mpv.exe") from the
 * streaming byte counter ("28.4 / 46.8 MB") so crossfade transitions fire on
 * actual operation switches without flickering on every 64 KB byte tick.
 */
export function splitStatusMessage(status: string): {
  actionText: string;
  metricSuffix: string | null;
} {
  const sep = " · ";
  const idx = status.lastIndexOf(sep);
  if (idx === -1) {
    return { actionText: status, metricSuffix: null };
  }
  return {
    actionText: status.slice(0, idx),
    metricSuffix: status.slice(idx + sep.length),
  };
}

export function makeReadyTelemetry(
  installDir: string,
  filesTotal = 8,
  bytesTotal = 94 * 1024 * 1024,
  mode: InstallMode = "install",
): InstallTelemetry {
  if (mode === "uninstall") {
    return {
      phase: "ready",
      overallPercent: 0,
      headline: "Uninstall Epilod Party",
      liveStatus: "Removes only verified Epilod Party files & keeps your own files safe",
      activeTile: null,
      completedTiles: [],
      steps: [
        {
          id: "mpvEngine",
          title: "Verified App Files",
          detail: "Scoped removal · keeps user files",
          rightLabel: `${filesTotal} files`,
          state: "pending",
        },
        {
          id: "fontsAndAutosync",
          title: "Shortcuts & Registry",
          detail: "Desktop, Start Menu & HKCU",
          rightLabel: "Queued",
          state: "pending",
        },
        {
          id: "syncplayAndSystem",
          title: "Finalize Cleanup",
          detail: "Empty folders & self-cleanup",
          rightLabel: "Queued",
          state: "pending",
        },
      ],
      bytesDone: 0,
      bytesTotal,
      filesDone: 0,
      filesTotal,
      currentFile: null,
      installDir,
      finished: false,
      cancelled: false,
      error: null,
    };
  }

  return {
    phase: "ready",
    overallPercent: 0,
    headline:
      mode === "update"
        ? "Ready to update"
        : mode === "repair"
          ? "Repair required"
          : "Ready to install",
    liveStatus:
      mode === "update"
        ? "Existing installation verified — ready to upgrade cleanly"
        : mode === "repair"
          ? "Missing or modified app files detected — ready to repair"
          : "Epilod Party v0.1.0 is ready for Windows setup",
    activeTile: null,
    completedTiles: [],
    steps: [
      {
        id: "mpvEngine",
        title: "mpv Playback Engine",
        detail: "Embedded Win32 HWND player",
        rightLabel: "Queued",
        state: "pending",
      },
      {
        id: "fontsAndAutosync",
        title: "FFmpeg & Arabic Fonts",
        detail: "Inter + Noto Arabic Auto-Sync",
        rightLabel: "Queued",
        state: "pending",
      },
      {
        id: "syncplayAndSystem",
        title: "Syncplay TLS & Shortcuts",
        detail: "STARTTLS & desktop integration",
        rightLabel: "Queued",
        state: "pending",
      },
    ],
    bytesDone: 0,
    bytesTotal,
    filesDone: 0,
    filesTotal,
    currentFile: null,
    installDir,
    finished: false,
    cancelled: false,
    error: null,
  };
}

let previewProcessesCleared = false;

function buildPreviewReport(
  installDir: string,
  scenario: PreviewScenario,
): {
  launchMode: InstallMode;
  report: ExistingInstallReport;
  processes: RunningProcessDto[];
} {
  const totalBytes = 94_800_000;
  let disposition: InstallDisposition = "freshInstall";
  let launchMode: InstallMode = "install";
  let installedVersion: string | null = null;
  let existingExeFound = false;
  let receiptPresent = false;
  let verifiedIntactCount = 0;
  let updateCount = 0;
  let corruptedCount = 0;
  let missingCount = 0;
  let unrelatedFileCount = 0;
  let reusableBytes = 0;
  let bytesToWrite = totalBytes;
  let missingFiles: string[] = [];
  let corruptedFiles: string[] = [];
  let modifiedFiles: string[] = [];
  let summaryText = "Clean destination · Ready for fresh installation";
  let processes: RunningProcessDto[] = [];

  if (scenario === "verify") {
    disposition = "upToDateVerified";
    launchMode = "install";
    installedVersion = "0.1.0";
    existingExeFound = true;
    receiptPresent = true;
    verifiedIntactCount = 8;
    unrelatedFileCount = 2;
    reusableBytes = totalBytes;
    bytesToWrite = 0;
    summaryText = "Epilod Party v0.1.0 verified (8/8 SHA-256 intact)";
  } else if (scenario === "repair") {
    disposition = "repairNeeded";
    launchMode = "repair";
    installedVersion = "0.1.0";
    existingExeFound = true;
    receiptPresent = true;
    verifiedIntactCount = 6;
    corruptedCount = 1;
    missingCount = 1;
    unrelatedFileCount = 1;
    reusableBytes = 42_800_000;
    bytesToWrite = 52_000_000;
    corruptedFiles = ["resources/mpv/mpv.exe"];
    missingFiles = ["resources/fonts/NotoSansArabic-Regular.ttf"];
    summaryText = "Repair recommended · 6 intact, 1 corrupted, 1 missing";
  } else if (scenario === "update") {
    disposition = "updateAvailable";
    launchMode = "update";
    installedVersion = "0.0.9";
    existingExeFound = true;
    receiptPresent = true;
    verifiedIntactCount = 5;
    updateCount = 3;
    unrelatedFileCount = 2;
    reusableBytes = 75_400_000;
    bytesToWrite = 19_400_000;
    modifiedFiles = ["Epilod Party.exe", "resources/licenses/SOURCE_OFFER.txt"];
    summaryText = "Upgrade ready · v0.0.9 -> v0.1.0 (5 unchanged files reused)";
  } else if (scenario === "downgrade") {
    disposition = "downgradeWarning";
    launchMode = "install";
    installedVersion = "0.2.0";
    existingExeFound = true;
    receiptPresent = true;
    verifiedIntactCount = 6;
    corruptedCount = 2;
    reusableBytes = 75_400_000;
    bytesToWrite = 19_400_000;
    summaryText = "Newer Epilod Party v0.2.0 is already installed (this setup is v0.1.0)";
  } else if (scenario === "locked") {
    disposition = "repairNeeded";
    launchMode = "repair";
    installedVersion = "0.1.0";
    existingExeFound = true;
    receiptPresent = true;
    verifiedIntactCount = 7;
    corruptedCount = 1;
    reusableBytes = 80_600_000;
    bytesToWrite = 14_200_000;
    corruptedFiles = ["Epilod Party.exe"];
    summaryText = "Repair ready · Close running Epilod Party instance to replace files";
    if (!previewProcessesCleared) {
      processes = [
        {
          pid: 4812,
          name: "Epilod Party.exe",
          executablePath: `${installDir}\\Epilod Party.exe`,
        },
        {
          pid: 5104,
          name: "mpv.exe",
          executablePath: `${installDir}\\resources\\mpv\\mpv.exe`,
        },
      ];
    }
  } else if (scenario === "uninstall") {
    disposition = "upToDateVerified";
    launchMode = "uninstall";
    installedVersion = "0.1.0";
    existingExeFound = true;
    receiptPresent = true;
    verifiedIntactCount = 8;
    unrelatedFileCount = 2;
    reusableBytes = totalBytes;
    bytesToWrite = 0;
    summaryText = "Epilod Party v0.1.0 ready to uninstall · 2 non-app files preserved";
  }

  return {
    launchMode,
    processes,
    report: {
      installDir,
      resolvedDir: installDir,
      disposition,
      installedVersion,
      packageVersion: "0.1.0",
      existingExeFound,
      receiptPresent,
      verifiedIntactCount,
      updateCount,
      corruptedCount,
      missingCount,
      unrelatedFileCount,
      unrelatedCountCapped: false,
      reusableBytes,
      bytesToWrite,
      totalPackageBytes: totalBytes,
      missingFiles,
      corruptedFiles,
      modifiedFiles,
      obsoleteFiles: [],
      shortcutsRecorded: receiptPresent ? 2 : 0,
      summaryText,
    },
  };
}

function previewPeakBytes(bytesToWrite: number, totalPackageBytes: number, disposition: InstallDisposition): number {
  const planned = disposition === "upToDateVerified" ? Math.max(totalPackageBytes, bytesToWrite) : bytesToWrite;
  return planned + 16 * 1024 * 1024 + 24 * 1024 * 1024;
}

export async function getInstallerDefaults(): Promise<InstallerDefaults> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<InstallerDefaults>("get_installer_defaults");
  }

  const scenario = getPreviewScenario();
  const defaultDir = String.raw`%LocalAppData%\Epilod Party`;
  const totalBytes = 94_800_000;
  const preview = buildPreviewReport(defaultDir, scenario);
  const autoStartPreview =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("autostart") === "1";

  return {
    version: "0.1.0",
    packageVersion: "0.1.0",
    launchMode: preview.launchMode,
    defaultInstallDir: defaultDir,
    writable: true,
    writeError: null,
    freeDiskBytes: 142 * 1024 * 1024 * 1024,
    requiredBytes: totalBytes,
    peakRequiredBytes: previewPeakBytes(
      preview.report.bytesToWrite,
      preview.report.totalPackageBytes,
      preview.report.disposition,
    ),
    payloadFiles: 8,
    payloadAvailable: true,
    existingInstall: preview.report.disposition !== "freshInstall",
    existingReport: preview.report,
    runningProcesses: preview.processes,
    waitPid: null,
    autoStart: autoStartPreview,
    autoRelaunch: false,
    removeUserDataDefault: false,
    savedDesktopShortcut: true,
    savedStartMenuShortcut: true,
    savedFileAssociations: true,
    readyTelemetry: makeReadyTelemetry(defaultDir, 8, totalBytes, preview.launchMode),
  };
}

export async function browseInstallDirectory(currentDir: string): Promise<string | null> {
  if (isTauriEnv()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: currentDir,
      title: "Choose Epilod Party install folder",
    });
    if (typeof selected === "string" && selected.trim()) {
      const normalized = selected.replace(/[\\/]+$/, "");
      return normalized.toLowerCase().endsWith("epilod party")
        ? normalized
        : `${normalized}\\Epilod Party`;
    }
    return null;
  }
  return null;
}

export async function checkInstallDirectory(path: string): Promise<number | null> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<number | null>("check_install_dir", { path });
  }
  return 142 * 1024 * 1024 * 1024;
}

export async function preflightInstallDir(path: string): Promise<PreflightResult> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<PreflightResult>("preflight_install_dir", { path });
  }
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("Install path cannot be empty.");
  }
  const preview = buildPreviewReport(trimmed, getPreviewScenario());
  const normalized = trimmed.replace(/\//g, "\\").toLowerCase();
  const protectedDir =
    normalized.startsWith("c:\\program files") || normalized.startsWith("c:\\windows");
  return {
    resolvedDir: trimmed,
    freeDiskBytes: 142 * 1024 * 1024 * 1024,
    writable: !protectedDir,
    writeError: protectedDir
      ? `Administrator permission is required to write to ${trimmed}. Choose a user folder such as %LocalAppData%\\Epilod Party or run Setup as Administrator.`
      : null,
    protectedDir,
    report: preview.report,
    peakRequiredBytes: previewPeakBytes(
      preview.report.bytesToWrite,
      preview.report.totalPackageBytes,
      preview.report.disposition,
    ),
  };
}

export async function inspectInstallDir(path: string): Promise<DestinationInspection> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DestinationInspection>("inspect_install_dir", { path });
  }
  const preview = buildPreviewReport(path, getPreviewScenario());
  return {
    resolvedDir: path,
    freeDiskBytes: 142 * 1024 * 1024 * 1024,
    writable: true,
    writeError: null,
    report: preview.report,
    peakRequiredBytes: previewPeakBytes(
      preview.report.bytesToWrite,
      preview.report.totalPackageBytes,
      preview.report.disposition,
    ),
    runningProcesses: preview.processes,
    savedDesktopShortcut: true,
    savedStartMenuShortcut: true,
    savedFileAssociations: true,
  };
}

export async function verifyExistingInstall(path: string): Promise<DestinationInspection> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DestinationInspection>("verify_existing_install", { path });
  }
  return inspectInstallDir(path);
}

export async function closeRunningProcesses(installDir: string): Promise<number> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<number>("close_running_epilod_processes", { installDir });
  }
  previewProcessesCleared = true;
  return 2;
}

export async function minimizeInstallerWindow(): Promise<void> {
  if (isTauriEnv()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  }
}

export async function closeInstallerWindow(): Promise<void> {
  if (isTauriEnv()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  }
}

export async function launchInstalledApp(installDir: string): Promise<void> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("launch_installed_app", { installDir });
  }
}

interface SimEntry {
  phase: InstallPhase;
  file: string;
  size: number;
  stepIndex: 0 | 1 | 2;
  activeTile: TileId;
  completedTiles: TileId[];
  headline: string;
  actionLabel: string;
  verifyLabel: string;
}

const SIM_ENTRIES: SimEntry[] = [
  {
    phase: "unpackingCore",
    file: "Epilod Party.exe",
    size: 14_200_000,
    stepIndex: 0,
    activeTile: "mpv",
    completedTiles: [],
    headline: "Installing Epilod Party",
    actionLabel: "Unpacking Epilod Party.exe",
    verifyLabel: "Verified Epilod Party.exe SHA-256",
  },
  {
    phase: "unpackingMpv",
    file: "resources/mpv/mpv.exe",
    size: 46_800_000,
    stepIndex: 0,
    activeTile: "mpv",
    completedTiles: [],
    headline: "Installing Epilod Party",
    actionLabel: "Unpacking mpv.exe engine",
    verifyLabel: "Verified mpv.exe SHA-256",
  },
  {
    phase: "unpackingFonts",
    file: "resources/mpv/ffmpeg.exe",
    size: 28_600_000,
    stepIndex: 1,
    activeTile: "autoSync",
    completedTiles: ["mpv"],
    headline: "Installing Epilod Party",
    actionLabel: "Unpacking ffmpeg.exe",
    verifyLabel: "Verified ffmpeg.exe SHA-256",
  },
  {
    phase: "unpackingFonts",
    file: "resources/fonts/NotoSansArabic-Regular.ttf",
    size: 5_200_000,
    stepIndex: 1,
    activeTile: "autoSync",
    completedTiles: ["mpv"],
    headline: "Installing Epilod Party",
    actionLabel: "Installing Inter & Arabic fonts",
    verifyLabel: "Verified GPL-3.0 license notices",
  },
];

export interface RunningInstallHandle {
  cancel: () => Promise<void>;
}

export async function runInstallation(
  options: InstallOptions,
  onProgress: (telemetry: InstallTelemetry) => void,
): Promise<RunningInstallHandle> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    let receivedTerminal = false;
    const unlisten = await listen<InstallTelemetry>("installer://progress", (event) => {
      if (
        event.payload.phase === "complete" ||
        event.payload.phase === "failed" ||
        event.payload.phase === "cancelled"
      ) {
        receivedTerminal = true;
      }
      onProgress(event.payload);
    });

    void invoke("start_install", { options })
      .catch((err) => {
        if (receivedTerminal) return;
        const msg =
          typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
        const isCancelled = /cancel/i.test(msg);
        onProgress({
          ...makeReadyTelemetry(options.installDir),
          phase: isCancelled ? "cancelled" : "failed",
          headline: isCancelled ? "Installation cancelled" : "Installation interrupted",
          liveStatus: msg,
          cancelled: isCancelled,
          error: isCancelled ? null : msg,
        });
      })
      .finally(() => {
        unlisten();
      });

    return {
      cancel: async () => {
        await invoke("cancel_install");
      },
    };
  }

  // Deterministic preview pipeline (when running in browser / Node tests outside Tauri)
  let cancelled = false;
  const totalBytes = SIM_ENTRIES.reduce((sum, e) => sum + e.size, 0);
  const filesTotal = 8;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const buildSteps = (
    stepIndex: 0 | 1 | 2,
    activeDetail: string,
    activeRight: string,
    allDone = false,
  ): [StepProgress, StepProgress, StepProgress] => [
    {
      id: "mpvEngine",
      title: "mpv Playback Engine",
      detail: allDone || stepIndex > 0 ? "Embedded Win32 HWND player" : activeDetail,
      rightLabel: allDone || stepIndex > 0 ? "Verified" : activeRight,
      state: allDone || stepIndex > 0 ? "done" : "active",
    },
    {
      id: "fontsAndAutosync",
      title: "FFmpeg & Arabic Fonts",
      detail:
        allDone || stepIndex > 1
          ? "Inter + Noto Arabic Auto-Sync"
          : stepIndex === 1
            ? activeDetail
            : "Inter + Noto Arabic Auto-Sync",
      rightLabel:
        allDone || stepIndex > 1 ? "Done" : stepIndex === 1 ? activeRight : "Queued",
      state:
        allDone || stepIndex > 1 ? "done" : stepIndex === 1 ? "active" : "pending",
    },
    {
      id: "syncplayAndSystem",
      title: "Syncplay TLS & Shortcuts",
      detail: allDone
        ? "STARTTLS & shortcuts registered"
        : stepIndex === 2
          ? activeDetail
          : "STARTTLS & desktop integration",
      rightLabel: allDone ? "Ready" : stepIndex === 2 ? activeRight : "Queued",
      state: allDone ? "done" : stepIndex === 2 ? "active" : "pending",
    },
  ];

  void (async () => {
    onProgress({
      phase: "preflight",
      overallPercent: 3,
      headline: "Preparing workspace",
      liveStatus: "Checking folder write access",
      activeTile: null,
      completedTiles: [],
      steps: buildSteps(0, "Checking destination folder", "Checking"),
      bytesDone: 0,
      bytesTotal: totalBytes,
      filesDone: 0,
      filesTotal,
      currentFile: null,
      installDir: options.installDir,
      finished: false,
      cancelled: false,
      error: null,
    });
    await sleep(240);
    if (cancelled) return;

    onProgress({
      phase: "verifyingExisting",
      overallPercent: 5,
      headline: "Verifying existing files",
      liveStatus: "Checking SHA-256 hashes in destination folder",
      activeTile: null,
      completedTiles: [],
      steps: buildSteps(0, "Checking SHA-256 digests", "Verifying"),
      bytesDone: 0,
      bytesTotal: totalBytes,
      filesDone: 0,
      filesTotal,
      currentFile: null,
      installDir: options.installDir,
      finished: false,
      cancelled: false,
      error: null,
    });
    await sleep(240);
    if (cancelled) return;

    onProgress({
      phase: "preflight",
      overallPercent: 6,
      headline: "Preparing workspace",
      liveStatus: "Verifying package manifest (8 assets)",
      activeTile: null,
      completedTiles: [],
      steps: buildSteps(0, "Verifying package manifest", "Ready"),
      bytesDone: 0,
      bytesTotal: totalBytes,
      filesDone: 0,
      filesTotal,
      currentFile: null,
      installDir: options.installDir,
      finished: false,
      cancelled: false,
      error: null,
    });
    await sleep(220);
    if (cancelled) return;

    let cumulativeBytes = 0;
    for (let i = 0; i < SIM_ENTRIES.length; i++) {
      const entry = SIM_ENTRIES[i];
      const chunks = 8;
      for (let c = 1; c <= chunks; c++) {
        if (cancelled) return;
        const fileDone = Math.round((entry.size * c) / chunks);
        const totalDone = cumulativeBytes + fileDone;
        const pct = 6 + (totalDone / totalBytes) * 76;
        const stepRight =
          entry.stepIndex === 0
            ? `${Math.min(i + 1, 4)}/4`
            : formatBytesPair(fileDone, entry.size);

        onProgress({
          phase: entry.phase,
          overallPercent: pct,
          headline: entry.headline,
          liveStatus: `${entry.actionLabel} · ${formatBytesPair(fileDone, entry.size)}`,
          activeTile: entry.activeTile,
          completedTiles: entry.completedTiles,
          steps: buildSteps(entry.stepIndex, entry.actionLabel, stepRight),
          bytesDone: totalDone,
          bytesTotal: totalBytes,
          filesDone: i + 1,
          filesTotal,
          currentFile: entry.file,
          installDir: options.installDir,
          finished: false,
          cancelled: false,
          error: null,
        });
        await sleep(95);
      }

      cumulativeBytes += entry.size;
      if (cancelled) return;

      onProgress({
        phase: entry.phase,
        overallPercent: 6 + (cumulativeBytes / totalBytes) * 76,
        headline: entry.headline,
        liveStatus: entry.verifyLabel,
        activeTile: entry.activeTile,
        completedTiles: entry.completedTiles,
        steps: buildSteps(
          entry.stepIndex,
          entry.verifyLabel,
          entry.stepIndex === 0 ? "Verified" : "Done",
        ),
        bytesDone: cumulativeBytes,
        bytesTotal: totalBytes,
        filesDone: i + 2,
        filesTotal,
        currentFile: entry.file,
        installDir: options.installDir,
        finished: false,
        cancelled: false,
        error: null,
      });
      await sleep(220);
    }

    const postSteps: {
      phase: InstallPhase;
      pct: number;
      headline: string;
      status: string;
      tile: TileId;
      doneTiles: TileId[];
      right: string;
      wait: number;
    }[] = [
      {
        phase: "backingUp",
        pct: 84,
        headline: "Committing verified files",
        status: "Preparing atomic swap & backup guard",
        tile: "syncplay",
        doneTiles: ["mpv", "autoSync"],
        right: "Swapping",
        wait: 220,
      },
      {
        phase: "configuringSyncplay",
        pct: 87,
        headline: "Configuring Syncplay TLS",
        status: "Writing STARTTLS trust profile",
        tile: "syncplay",
        doneTiles: ["mpv", "autoSync"],
        right: "TLS",
        wait: 260,
      },
      ...(options.createStartMenuShortcut
        ? [
            {
              phase: "integratingWindows" as InstallPhase,
              pct: 90,
              headline: "Finalizing desktop integration",
              status: "Creating Start Menu shortcut",
              tile: "syncplay" as TileId,
              doneTiles: ["mpv", "autoSync"] as TileId[],
              right: "Syncing",
              wait: 240,
            },
          ]
        : []),
      ...(options.createDesktopShortcut
        ? [
            {
              phase: "integratingWindows" as InstallPhase,
              pct: 94,
              headline: "Finalizing desktop integration",
              status: "Creating Desktop shortcut",
              tile: "startTls" as TileId,
              doneTiles: ["mpv", "autoSync", "syncplay"] as TileId[],
              right: "Syncing",
              wait: 240,
            },
          ]
        : []),
      {
        phase: "integratingWindows",
        pct: 97,
        headline: "Finalizing desktop integration",
        status: "Registering Windows uninstall",
        tile: "startTls",
        doneTiles: ["mpv", "autoSync", "syncplay"],
        right: "Active",
        wait: 240,
      },
      {
        phase: "finalizing",
        pct: 99,
        headline: "Finalizing setup",
        status: "Recording SHA-256 install manifest",
        tile: "startTls",
        doneTiles: ["mpv", "autoSync", "syncplay"],
        right: "99%",
        wait: 220,
      },
    ];

    for (const post of postSteps) {
      if (cancelled) return;
      onProgress({
        phase: post.phase,
        overallPercent: post.pct,
        headline: post.headline,
        liveStatus: post.status,
        activeTile: post.tile,
        completedTiles: post.doneTiles,
        steps: buildSteps(2, post.status, post.right),
        bytesDone: totalBytes,
        bytesTotal: totalBytes,
        filesDone: filesTotal,
        filesTotal,
        currentFile: null,
        installDir: options.installDir,
        finished: false,
        cancelled: false,
        error: null,
      });
      await sleep(post.wait);
    }

    if (cancelled) return;
    onProgress({
      phase: "complete",
      overallPercent: 100,
      headline: "Epilod Party is ready",
      liveStatus: `Installed ${filesTotal} verified files (${formatBytes(totalBytes)})`,
      activeTile: null,
      completedTiles: ["mpv", "autoSync", "syncplay", "startTls"],
      steps: buildSteps(2, "STARTTLS & shortcuts registered", "Ready", true),
      bytesDone: totalBytes,
      bytesTotal: totalBytes,
      filesDone: filesTotal,
      filesTotal,
      currentFile: null,
      installDir: options.installDir,
      finished: true,
      cancelled: false,
      error: null,
    });
  })();

  return {
    cancel: async () => {
      cancelled = true;
      onProgress({
        ...makeReadyTelemetry(options.installDir, filesTotal, totalBytes),
        phase: "cancelled",
        headline: "Installation cancelled",
        liveStatus: "Installation cancelled cleanly — no files modified.",
        cancelled: true,
      });
    },
  };
}

export async function runUninstallation(
  options: UninstallOptions,
  onProgress: (telemetry: InstallTelemetry) => void,
): Promise<UninstallSummary> {
  if (isTauriEnv()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<InstallTelemetry>("installer://progress", (event) => {
      onProgress(event.payload);
    });
    try {
      return await invoke<UninstallSummary>("start_uninstall", { options });
    } finally {
      unlisten();
    }
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  const filesTotal = 8;
  const makeSteps = (
    s1: StepProgress["state"],
    d1: string,
    r1: string,
    s2: StepProgress["state"],
    d2: string,
    r2: string,
    s3: StepProgress["state"],
    d3: string,
    r3: string,
  ): [StepProgress, StepProgress, StepProgress] => [
    { id: "mpvEngine", title: "Verified App Files", detail: d1, rightLabel: r1, state: s1 },
    { id: "fontsAndAutosync", title: "Shortcuts & Registry", detail: d2, rightLabel: r2, state: s2 },
    { id: "syncplayAndSystem", title: "Finalize Cleanup", detail: d3, rightLabel: r3, state: s3 },
  ];

  onProgress({
    phase: "preflight",
    overallPercent: 10,
    headline: "Uninstalling Epilod Party",
    liveStatus: "Closing active Epilod Party processes",
    activeTile: null,
    completedTiles: [],
    steps: makeSteps(
      "active",
      "Checking running app instances",
      "Checking",
      "pending",
      "Desktop, Start Menu & HKCU",
      "Queued",
      "pending",
      "Empty folders & self-cleanup",
      "Queued",
    ),
    bytesDone: 0,
    bytesTotal: filesTotal,
    filesDone: 0,
    filesTotal,
    currentFile: null,
    installDir: options.installDir,
    finished: false,
    cancelled: false,
    error: null,
  });
  await sleep(220);

  const removedList = [
    "Epilod Party.exe",
    "mpv.exe",
    "ffmpeg.exe",
    "NotoSansArabic-Regular.ttf",
    "GPL-3.0.txt",
    "epilod-uninstall.exe",
  ];
  for (let i = 0; i < removedList.length; i++) {
    onProgress({
      phase: "removingFiles",
      overallPercent: 18 + ((i + 1) / removedList.length) * 50,
      headline: "Removing application files",
      liveStatus: `Removed ${removedList[i]}`,
      activeTile: "mpv",
      completedTiles: [],
      steps: makeSteps(
        "active",
        `Removing ${removedList[i]}`,
        `${i + 1}/${removedList.length}`,
        "pending",
        "Desktop, Start Menu & HKCU",
        "Queued",
        "pending",
        "Empty folders & self-cleanup",
        "Queued",
      ),
      bytesDone: i + 1,
      bytesTotal: filesTotal,
      filesDone: i + 1,
      filesTotal,
      currentFile: removedList[i],
      installDir: options.installDir,
      finished: false,
      cancelled: false,
      error: null,
    });
    await sleep(110);
  }

  onProgress({
    phase: "cleaningRegistry",
    overallPercent: 85,
    headline: "Removing system integration",
    liveStatus: "Removing Start Menu, Desktop links & HKCU registry",
    activeTile: "startTls",
    completedTiles: ["mpv", "autoSync"],
    steps: makeSteps(
      "done",
      "App files removed safely",
      "Clean",
      "active",
      options.removeUserData ? "Cleaning registry & local cache" : "Removing HKCU registry entries",
      "Cleaning",
      "pending",
      "Empty folders & self-cleanup",
      "Queued",
    ),
    bytesDone: filesTotal,
    bytesTotal: filesTotal,
    filesDone: filesTotal,
    filesTotal,
    currentFile: null,
    installDir: options.installDir,
    finished: false,
    cancelled: false,
    error: null,
  });
  await sleep(260);

  onProgress({
    phase: "complete",
    overallPercent: 100,
    headline: "Epilod Party uninstalled",
    liveStatus: "Removed 8 Epilod files · preserved 2 non-app file(s)",
    activeTile: null,
    completedTiles: ["mpv", "autoSync", "syncplay", "startTls"],
    steps: makeSteps(
      "done",
      "App files removed safely",
      "Clean",
      "done",
      "Shortcuts & registry removed",
      "Removed",
      "done",
      "Cleanup scheduled",
      "Done",
    ),
    bytesDone: filesTotal,
    bytesTotal: filesTotal,
    filesDone: filesTotal,
    filesTotal,
    currentFile: null,
    installDir: options.installDir,
    finished: true,
    cancelled: false,
    error: null,
  });

  return {
    installDir: options.installDir,
    removedFiles: 8,
    removedDirs: 3,
    skippedUnrelatedFiles: 2,
    keptUnrelatedPaths: ["my-movie.mkv", "subtitles.srt"],
    removedShortcuts: 2,
    removedRegistry: true,
    removedUserData: options.removeUserData,
    scheduledSelfCleanup: true,
    closedProcesses: 0,
    warnings: [],
  };
}
