export type ComponentId = "core" | "mpv" | "fonts" | "syncplay";

export type TileId = "mpv" | "autoSync" | "syncplay" | "startTls";

export type StepId = "mpvEngine" | "fontsAndAutosync" | "syncplayAndSystem";

export type StepState = "pending" | "active" | "done" | "error";

export type InstallMode = "install" | "repair" | "update" | "uninstall";

export type InstallDisposition =
  | "freshInstall"
  | "upToDateVerified"
  | "repairNeeded"
  | "updateAvailable"
  | "downgradeWarning";

export type InstallPhase =
  | "ready"
  | "preflight"
  | "verifyingExisting"
  | "unpackingCore"
  | "unpackingMpv"
  | "unpackingFonts"
  | "backingUp"
  | "configuringSyncplay"
  | "integratingWindows"
  | "finalizing"
  | "rollingBack"
  | "removingFiles"
  | "cleaningRegistry"
  | "complete"
  | "cancelled"
  | "failed";

export interface InstallOptions {
  installDir: string;
  createDesktopShortcut: boolean;
  createStartMenuShortcut: boolean;
  registerFileAssociations: boolean;
  autoLaunch: boolean;
  forceReunpack?: boolean;
  waitPid?: number | null;
  forceCloseRunning?: boolean;
  allowDowngrade?: boolean;
}

export interface UninstallOptions {
  installDir: string;
  removeUserData: boolean;
  forceCloseRunning?: boolean;
  silent?: boolean;
}

export interface UninstallSummary {
  installDir: string;
  removedFiles: number;
  removedDirs: number;
  skippedUnrelatedFiles: number;
  keptUnrelatedPaths: string[];
  removedShortcuts: number;
  removedRegistry: boolean;
  removedUserData: boolean;
  scheduledSelfCleanup: boolean;
  closedProcesses: number;
  warnings?: string[];
}

export interface ExistingInstallReport {
  installDir: string;
  resolvedDir: string;
  disposition: InstallDisposition;
  installedVersion: string | null;
  packageVersion: string | null;
  existingExeFound: boolean;
  receiptPresent: boolean;
  verifiedIntactCount: number;
  updateCount: number;
  corruptedCount: number;
  missingCount: number;
  unrelatedFileCount: number;
  unrelatedCountCapped?: boolean;
  reusableBytes: number;
  bytesToWrite: number;
  totalPackageBytes: number;
  missingFiles: string[];
  corruptedFiles: string[];
  modifiedFiles: string[];
  obsoleteFiles: string[];
  shortcutsRecorded: number;
  summaryText: string;
}

export interface RunningProcessDto {
  pid: number;
  name: string;
  executablePath: string;
}

export interface DestinationInspection {
  resolvedDir: string;
  freeDiskBytes: number | null;
  writable: boolean;
  writeError: string | null;
  report: ExistingInstallReport;
  peakRequiredBytes?: number;
  runningProcesses: RunningProcessDto[];
  savedDesktopShortcut: boolean | null;
  savedStartMenuShortcut: boolean | null;
  savedFileAssociations: boolean | null;
}

export interface PreflightResult {
  resolvedDir: string;
  freeDiskBytes: number | null;
  writable: boolean;
  writeError: string | null;
  protectedDir: boolean;
  report: ExistingInstallReport;
  peakRequiredBytes: number;
}

export interface StepProgress {
  id: StepId;
  title: string;
  detail: string;
  rightLabel: string;
  state: StepState;
}

export interface InstallTelemetry {
  phase: InstallPhase;
  overallPercent: number;
  headline: string;
  liveStatus: string;
  activeTile: TileId | null;
  completedTiles: TileId[];
  steps: [StepProgress, StepProgress, StepProgress];
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  currentFile: string | null;
  installDir: string;
  finished: boolean;
  cancelled: boolean;
  error: string | null;
}

export interface InstallerDefaults {
  version: string;
  packageVersion: string;
  launchMode: InstallMode;
  defaultInstallDir: string;
  writable: boolean;
  writeError: string | null;
  freeDiskBytes: number | null;
  requiredBytes: number;
  peakRequiredBytes?: number;
  payloadFiles: number;
  payloadAvailable: boolean;
  existingInstall: boolean;
  existingReport: ExistingInstallReport;
  runningProcesses: RunningProcessDto[];
  waitPid: number | null;
  autoStart: boolean;
  autoRelaunch: boolean;
  removeUserDataDefault: boolean;
  savedDesktopShortcut: boolean | null;
  savedStartMenuShortcut: boolean | null;
  savedFileAssociations: boolean | null;
  readyTelemetry: InstallTelemetry;
}

export type InstallerTab = "location" | "install" | "options";
