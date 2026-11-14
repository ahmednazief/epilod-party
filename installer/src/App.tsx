import {
  AlertTriangle,
  Captions,
  Folder,
  Layers,
  Lock,
  Minus,
  PlaySquare,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "./components/BrandMark";
import { EcosystemTraces } from "./components/EcosystemTraces";
import { ModuleTile } from "./components/ModuleTile";
import { SmoothStatusText } from "./components/SmoothStatusText";
import { StepRow } from "./components/StepRow";
import { ToggleOption } from "./components/ToggleOption";
import {
  browseInstallDirectory,
  closeInstallerWindow,
  closeRunningProcesses,
  formatBytes,
  getInstallerDefaults,
  inspectInstallDir,
  isTauriEnv,
  launchInstalledApp,
  makeReadyTelemetry,
  minimizeInstallerWindow,
  preflightInstallDir,
  runInstallation,
  runUninstallation,
  verifyExistingInstall,
  type RunningInstallHandle,
} from "./lib/installerBridge";
import type {
  DestinationInspection,
  ExistingInstallReport,
  InstallMode,
  InstallOptions,
  InstallTelemetry,
  InstallerDefaults,
  InstallerTab,
  PreflightResult,
  RunningProcessDto,
  TileId,
  UninstallSummary,
} from "./lib/types";

const RAIL_TABS: { id: InstallerTab; label: string }[] = [
  { id: "location", label: "Install location" },
  { id: "install", label: "Setup progress" },
  { id: "options", label: "Install options" },
];

function getRunningPhaseLabel(phase: InstallTelemetry["phase"], isUninstall: boolean): string {
  if (isUninstall) {
    switch (phase) {
      case "preflight":
        return "Closing active processes...";
      case "removingFiles":
        return "Removing verified app files...";
      case "cleaningRegistry":
        return "Cleaning shortcuts & registry...";
      default:
        return "Uninstalling Epilod Party...";
    }
  }
  switch (phase) {
    case "preflight":
      return "Preparing workspace...";
    case "verifyingExisting":
      return "Verifying existing SHA-256 files...";
    case "backingUp":
      return "Creating rollback snapshot...";
    case "rollingBack":
      return "Rolling back safely...";
    case "configuringSyncplay":
    case "integratingWindows":
    case "finalizing":
      return "Finalizing setup...";
    default:
      return "Installing components...";
  }
}

export function App() {
  const [activeTab, setActiveTab] = useState<InstallerTab>("install");
  const [defaults, setDefaults] = useState<InstallerDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [inspection, setInspection] = useState<DestinationInspection | null>(null);
  const [preflightPeakBytes, setPreflightPeakBytes] = useState<number | null>(null);
  const [options, setOptions] = useState<InstallOptions>({
    installDir: String.raw`%LocalAppData%\Epilod Party`,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    registerFileAssociations: true,
    autoLaunch: false,
  });
  const [removeUserData, setRemoveUserData] = useState(false);
  const [uninstallSummary, setUninstallSummary] = useState<UninstallSummary | null>(null);
  const [freeDiskBytes, setFreeDiskBytes] = useState<number | null>(null);
  const [telemetry, setTelemetry] = useState<InstallTelemetry>(() =>
    makeReadyTelemetry(String.raw`%LocalAppData%\Epilod Party`),
  );
  const [displayPercent, setDisplayPercent] = useState(0);
  const [pathError, setPathError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isClosingProcesses, setIsClosingProcesses] = useState(false);

  const installHandleRef = useRef<RunningInstallHandle | null>(null);
  const targetPercentRef = useRef(0);
  const displayPercentRef = useRef(0);
  const autoLaunchedRef = useRef(false);
  const autoStartedRef = useRef(false);
  const dirInspectSeqRef = useRef(0);
  const dirDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const tauriMode = useMemo(() => isTauriEnv(), []);

  const isUninstallMode = defaults?.launchMode === "uninstall";

  useEffect(() => {
    document.body.dataset.tauri = String(tauriMode);
  }, [tauriMode]);

  const startInstallWith = useCallback(
    async (installOpts: InstallOptions, defaultsInfo: InstallerDefaults | null = defaults) => {
      setLaunchError(null);
      autoLaunchedRef.current = false;
      setActiveTab("install");

      const currentMode: InstallMode =
        defaultsInfo?.launchMode === "update"
          ? "update"
          : defaultsInfo?.launchMode ?? "install";
      const base = makeReadyTelemetry(
        installOpts.installDir,
        defaultsInfo?.payloadFiles ?? 8,
        defaultsInfo?.requiredBytes ?? 94_800_000,
        currentMode,
      );
      setTelemetry(base);
      displayPercentRef.current = 0;
      setDisplayPercent(0);

      try {
        const handle = await runInstallation(installOpts, (update) => {
          setTelemetry(update);
        });
        installHandleRef.current = handle;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isCancelled = /cancel/i.test(msg);
        setLaunchError(isCancelled ? null : msg);
        setTelemetry((prev) => ({
          ...prev,
          phase: isCancelled ? "cancelled" : "failed",
          headline: isCancelled ? "Installation cancelled" : "Installation interrupted",
          liveStatus: msg,
          cancelled: isCancelled,
          error: isCancelled ? null : msg,
        }));
      }
    },
    [defaults],
  );

  const loadDefaults = useCallback(async () => {
    setIsInitializing(true);
    setDefaultsError(null);
    setLaunchError(null);
    try {
      const info = await getInstallerDefaults();
      if (!mountedRef.current) return;

      setDefaults(info);
      setFreeDiskBytes(info.freeDiskBytes);
      setRemoveUserData(info.removeUserDataDefault);
      setPreflightPeakBytes(info.peakRequiredBytes ?? null);

      const isWritable = info.writable ?? true;
      const initialWriteError = isWritable
        ? null
        : info.writeError ?? "Destination folder is not writable.";
      setPathError(initialWriteError);

      const hydratedOptions: InstallOptions = {
        installDir: info.defaultInstallDir,
        createDesktopShortcut: info.savedDesktopShortcut ?? true,
        createStartMenuShortcut: info.savedStartMenuShortcut ?? true,
        registerFileAssociations: info.savedFileAssociations ?? true,
        autoLaunch: info.autoRelaunch,
        waitPid: info.waitPid,
        forceCloseRunning: info.launchMode === "update",
      };
      setOptions(hydratedOptions);
      setTelemetry(info.readyTelemetry);
      setInspection({
        resolvedDir: info.defaultInstallDir,
        freeDiskBytes: info.freeDiskBytes,
        writable: isWritable,
        writeError: initialWriteError,
        report: info.existingReport,
        peakRequiredBytes: info.peakRequiredBytes,
        runningProcesses: info.runningProcesses,
        savedDesktopShortcut: info.savedDesktopShortcut,
        savedStartMenuShortcut: info.savedStartMenuShortcut,
        savedFileAssociations: info.savedFileAssociations,
      });

      const peakNeeded = info.peakRequiredBytes ?? info.requiredBytes + 40_000_000;
      const hasEnoughDisk = info.freeDiskBytes === null || info.freeDiskBytes >= peakNeeded;
      const hasPayload = !tauriMode || info.payloadAvailable;
      if (
        info.autoStart &&
        info.launchMode !== "uninstall" &&
        isWritable &&
        hasEnoughDisk &&
        hasPayload &&
        !autoStartedRef.current
      ) {
        autoStartedRef.current = true;
        void startInstallWith(hydratedOptions, info);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setDefaultsError(msg);
      setTelemetry((prev) => ({
        ...prev,
        phase: "failed",
        headline: "Setup initialization failed",
        liveStatus: msg,
        error: msg,
      }));
    } finally {
      if (mountedRef.current) {
        setIsInitializing(false);
      }
    }
  }, [startInstallWith]);

  useEffect(() => {
    mountedRef.current = true;
    void loadDefaults();

    return () => {
      mountedRef.current = false;
      if (dirDebounceRef.current) {
        clearTimeout(dirDebounceRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Smooth rAF interpolation for progress bar & tabular readout
  useEffect(() => {
    targetPercentRef.current = telemetry.overallPercent;
    if (telemetry.overallPercent === 0 && telemetry.phase === "ready") {
      displayPercentRef.current = 0;
      setDisplayPercent(0);
      return;
    }

    let rafId = 0;
    const tick = () => {
      const target = targetPercentRef.current;
      const curr = displayPercentRef.current;
      const diff = target - curr;
      if (Math.abs(diff) < 0.2) {
        displayPercentRef.current = target;
        setDisplayPercent(target);
        return;
      }
      const next = curr + diff * 0.22;
      displayPercentRef.current = next;
      setDisplayPercent(next);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [telemetry.overallPercent, telemetry.phase]);

  // Refresh destination verification & running-process state after a cancelled or failed install
  useEffect(() => {
    if (isUninstallMode || defaultsError !== null) return;
    if (telemetry.phase === "failed" || telemetry.phase === "cancelled") {
      void runDirectoryInspection(options.installDir, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUninstallMode, telemetry.phase]);

  // Optional auto-launch after clean completion
  useEffect(() => {
    if (
      isUninstallMode ||
      !telemetry.finished ||
      !options.autoLaunch ||
      autoLaunchedRef.current
    ) {
      return;
    }
    autoLaunchedRef.current = true;
    const timer = setTimeout(() => {
      void handleLaunch();
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUninstallMode, telemetry.finished, options.autoLaunch]);

  const isRunning =
    telemetry.phase !== "ready" &&
    telemetry.phase !== "complete" &&
    telemetry.phase !== "failed" &&
    telemetry.phase !== "cancelled";

  const isComplete = telemetry.finished && telemetry.phase === "complete";
  const isErrorOrCancelled =
    telemetry.phase === "failed" || telemetry.phase === "cancelled";

  const existingReport: ExistingInstallReport | null =
    inspection?.report ?? defaults?.existingReport ?? null;
  const runningProcesses: RunningProcessDto[] =
    inspection?.runningProcesses ?? defaults?.runningProcesses ?? [];

  const activeMode: InstallMode = useMemo(() => {
    if (defaults?.launchMode === "uninstall") return "uninstall";
    switch (existingReport?.disposition) {
      case "repairNeeded":
        return "repair";
      case "updateAvailable":
        return "update";
      default:
        return defaults?.launchMode ?? "install";
    }
  }, [defaults?.launchMode, existingReport?.disposition]);

  const hasLockedProcessError =
    Boolean(telemetry.error?.includes("[LOCKED_PROCESSES]")) ||
    runningProcesses.length > 0;

  const activeTabIndex = RAIL_TABS.findIndex((t) => t.id === activeTab);

  const getTileStatus = (tile: TileId): "idle" | "active" | "done" => {
    if (isComplete || telemetry.completedTiles.includes(tile)) return "done";
    if (telemetry.activeTile === tile) return "active";
    return "idle";
  };

  const applyInspectionResult = (res: DestinationInspection, updateDirInput = false) => {
    setInspection(res);
    setFreeDiskBytes(res.freeDiskBytes);
    setPreflightPeakBytes(res.peakRequiredBytes ?? null);
    setPathError(res.writable ? null : res.writeError ?? "Destination folder is not writable.");
    if (updateDirInput) {
      setOptions((prev) => ({
        ...prev,
        installDir: res.resolvedDir,
        createDesktopShortcut: res.savedDesktopShortcut ?? prev.createDesktopShortcut,
        createStartMenuShortcut: res.savedStartMenuShortcut ?? prev.createStartMenuShortcut,
        registerFileAssociations: res.savedFileAssociations ?? prev.registerFileAssociations,
      }));
    }
  };

  const applyPreflightResult = (res: PreflightResult) => {
    setFreeDiskBytes(res.freeDiskBytes);
    setPreflightPeakBytes(res.peakRequiredBytes);
    setPathError(res.writable ? null : res.writeError ?? "Destination folder is not writable.");
    setInspection((prev) => ({
      resolvedDir: res.resolvedDir,
      freeDiskBytes: res.freeDiskBytes,
      writable: res.writable,
      writeError: res.writeError,
      report: res.report,
      peakRequiredBytes: res.peakRequiredBytes,
      runningProcesses: prev?.runningProcesses ?? defaults?.runningProcesses ?? [],
      savedDesktopShortcut: prev?.savedDesktopShortcut ?? defaults?.savedDesktopShortcut ?? null,
      savedStartMenuShortcut:
        prev?.savedStartMenuShortcut ?? defaults?.savedStartMenuShortcut ?? null,
      savedFileAssociations: prev?.savedFileAssociations ?? defaults?.savedFileAssociations ?? null,
    }));
  };

  const runDirectoryPreflight = async (rawPath: string) => {
    const seq = ++dirInspectSeqRef.current;
    try {
      const res = await preflightInstallDir(rawPath);
      if (seq !== dirInspectSeqRef.current) return;
      applyPreflightResult(res);
    } catch (err) {
      if (seq !== dirInspectSeqRef.current) return;
      setPathError(err instanceof Error ? err.message : String(err));
    }
  };

  const runDirectoryInspection = async (rawPath: string, updateDirInput = false) => {
    const seq = ++dirInspectSeqRef.current;
    setIsVerifying(true);
    try {
      const res = await inspectInstallDir(rawPath);
      if (seq !== dirInspectSeqRef.current) return;
      applyInspectionResult(res, updateDirInput);
    } catch (err) {
      if (seq !== dirInspectSeqRef.current) return;
      setPathError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === dirInspectSeqRef.current) {
        setIsVerifying(false);
      }
    }
  };

  const handleVerifyNow = async () => {
    if (isRunning || isVerifying) return;
    setIsVerifying(true);
    setLaunchError(null);
    const seq = ++dirInspectSeqRef.current;
    try {
      const res = await verifyExistingInstall(options.installDir);
      if (seq !== dirInspectSeqRef.current) return;
      applyInspectionResult(res, false);
    } catch (err) {
      if (seq !== dirInspectSeqRef.current) return;
      setPathError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === dirInspectSeqRef.current) {
        setIsVerifying(false);
      }
    }
  };

  const handleCloseProcesses = async () => {
    if (isClosingProcesses || isRunning) return;
    setIsClosingProcesses(true);
    setLaunchError(null);
    try {
      await closeRunningProcesses(options.installDir);
      const res = await inspectInstallDir(options.installDir);
      applyInspectionResult(res, false);
      setTelemetry(
        makeReadyTelemetry(
          options.installDir,
          defaults?.payloadFiles ?? 8,
          defaults?.requiredBytes ?? 94_800_000,
          activeMode,
        ),
      );
      displayPercentRef.current = 0;
      setDisplayPercent(0);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsClosingProcesses(false);
    }
  };

  const handleStartInstall = async () => {
    if (isRunning || installBlocked) return;
    await startInstallWith({
      ...options,
      forceReunpack: existingReport?.disposition === "upToDateVerified",
      allowDowngrade: existingReport?.disposition === "downgradeWarning",
    });
  };

  const handleStartUninstall = async () => {
    if (isRunning) return;
    setLaunchError(null);
    setUninstallSummary(null);

    const base = makeReadyTelemetry(
      options.installDir,
      defaults?.payloadFiles ?? 8,
      defaults?.requiredBytes ?? 94_800_000,
      "uninstall",
    );
    setTelemetry(base);
    displayPercentRef.current = 0;
    setDisplayPercent(0);

    try {
      const summary = await runUninstallation(
        {
          installDir: options.installDir,
          removeUserData,
          forceCloseRunning: true,
        },
        (update) => {
          setTelemetry(update);
        },
      );
      setUninstallSummary(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLaunchError(msg);
      setTelemetry((prev) => ({
        ...prev,
        phase: "failed",
        headline: "Uninstall interrupted",
        liveStatus: msg,
        error: msg,
      }));
    }
  };

  const handleCancelInstall = async () => {
    try {
      await installHandleRef.current?.cancel();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleBrowseFolder = async () => {
    if (isRunning || isComplete) return;
    setPathError(null);
    if (dirDebounceRef.current) {
      clearTimeout(dirDebounceRef.current);
    }
    try {
      const chosen = await browseInstallDirectory(options.installDir);
      if (!chosen) return;
      setOptions((prev) => ({ ...prev, installDir: chosen }));
      setTelemetry((prev) => ({ ...prev, installDir: chosen }));
      await runDirectoryInspection(chosen, true);
    } catch (err) {
      setPathError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDirInputChange = (value: string) => {
    setOptions((prev) => ({ ...prev, installDir: value }));
    setTelemetry((prev) => ({ ...prev, installDir: value }));
    setPathError(null);
    if (dirDebounceRef.current) {
      clearTimeout(dirDebounceRef.current);
    }
    dirDebounceRef.current = setTimeout(() => {
      void runDirectoryPreflight(value);
    }, 220);
  };

  const handleLaunch = async () => {
    setLaunchError(null);
    try {
      await launchInstalledApp(options.installDir);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    }
  };

  const headerSubtitle = useMemo(() => {
    if (defaultsError) return "Initialization Error";
    if (isUninstallMode) {
      if (isComplete) return "Removed · Clean Uninstall";
      if (isRunning) return telemetry.headline;
      return "Uninstall · Scoped Removal";
    }
    if (isComplete) return "Installed · Ready to Watch";
    if (isRunning) return telemetry.headline;
    if (existingReport?.disposition === "repairNeeded") {
      return "Watch Together · Repair Ready";
    }
    if (existingReport?.disposition === "updateAvailable") {
      return "Watch Together · Update Ready";
    }
    if (existingReport?.disposition === "upToDateVerified") {
      return "Watch Together · Verified";
    }
    if (existingReport?.disposition === "downgradeWarning") {
      return "Watch Together · Newer Version Installed";
    }
    return "Watch Together · Windows";
  }, [defaultsError, existingReport?.disposition, isComplete, isRunning, isUninstallMode, telemetry.headline]);

  const installCtaLabel = useMemo(() => {
    if (isInitializing && !defaults) {
      return "Inspecting destination...";
    }
    if (existingReport?.disposition === "repairNeeded") {
      return "Repair Epilod Party";
    }
    if (existingReport?.disposition === "updateAvailable") {
      return "Update Epilod Party";
    }
    if (existingReport?.disposition === "upToDateVerified") {
      return "Reinstall / Verify Epilod Party";
    }
    if (existingReport?.disposition === "downgradeWarning") {
      return `Reinstall older v${defaults?.packageVersion ?? "0.1.0"}`;
    }
    return options.autoLaunch ? "Install & Launch" : "Install Epilod Party";
  }, [defaults, existingReport?.disposition, isInitializing, options.autoLaunch]);

  const cleanLiveError = (defaultsError ?? launchError ?? telemetry.liveStatus).replace(
    "[LOCKED_PROCESSES] ",
    "",
  );

  const peakRequiredBytes =
    inspection?.peakRequiredBytes ??
    preflightPeakBytes ??
    defaults?.peakRequiredBytes ??
    Math.max((existingReport?.bytesToWrite ?? defaults?.requiredBytes ?? 94_800_000) + 40_000_000, 40_000_000);
  const insufficientDiskSpace =
    !isUninstallMode && freeDiskBytes !== null && freeDiskBytes < peakRequiredBytes;

  const payloadMissing = tauriMode && defaults !== null && !defaults.payloadAvailable;
  const installBlocked =
    isInitializing ||
    defaultsError !== null ||
    isVerifying ||
    Boolean(pathError) ||
    insufficientDiskSpace ||
    payloadMissing ||
    (runningProcesses.length > 0 && !defaults?.autoStart);

  const pctRounded = Math.round(displayPercent);
  const progressFraction = Math.min(1, Math.max(0, displayPercent / 100));

  return (
    <div className="flex h-full w-full items-center justify-center">
      {/* Main Architectural Stage — 900x740 matching approved design */}
      <div
        data-tauri-drag-region
        className="anim-stage-in relative h-[740px] w-[900px] overflow-hidden rounded-[36px] bg-[#101015] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055),0_28px_72px_rgba(0,0,0,0.65)]"
      >
        {/* Discreet Window Chrome Controls */}
        <div className="absolute right-7 top-6 z-20 flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Minimize installer"
            onClick={() => void minimizeInstallerWindow()}
            className="flex h-7 w-7 items-center justify-center rounded-full text-[#6B6B7E] transition-colors duration-150 hover:bg-[#1B1B24] hover:text-[#E4E4EE] cursor-pointer"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close installer"
            onClick={() => void closeInstallerWindow()}
            className="flex h-7 w-7 items-center justify-center rounded-full text-[#6B6B7E] transition-colors duration-150 hover:bg-[#2A1922] hover:text-[#F47292] cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Architectural Hairline Traces */}
        <EcosystemTraces
          activeTile={telemetry.activeTile}
          completedTiles={telemetry.completedTiles}
          isRunning={isRunning}
          isComplete={isComplete}
        />

        {/* Top Brand Capsule */}
        <div
          data-tauri-drag-region
          className="absolute left-[255px] top-[96px] z-10 flex h-[72px] w-[390px] items-center gap-3.5 rounded-full bg-[#17171E] pl-3.5 pr-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_32px_rgba(0,0,0,0.42)]"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center">
            <BrandMark size={44} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15.5px] font-medium tracking-[-0.015em] text-[#F4F4F6]">
              Epilod Party
            </div>
            <div
              key={headerSubtitle}
              className="anim-text-swap mt-0.5 truncate text-[12px] text-[#7C7C8E]"
            >
              {headerSubtitle}
            </div>
          </div>
          <div className="mono text-[12px] text-[#A78BFA]">
            v{defaults?.packageVersion ?? defaults?.version ?? "0.1.0"}
          </div>
        </div>

        {/* Four Flanking Component Tiles */}
        <ModuleTile
          label="mpv"
          accent="rose"
          status={getTileStatus("mpv")}
          positionClass="left-[78px] top-[304px]"
          icon={<PlaySquare className="h-6 w-6 stroke-[1.75]" />}
        />

        <ModuleTile
          label="Auto-Sync"
          accent="purple"
          status={getTileStatus("autoSync")}
          positionClass="left-[78px] top-[432px]"
          icon={<Captions className="h-6 w-6 stroke-[1.75]" />}
        />

        <ModuleTile
          label="Syncplay"
          accent="purple"
          status={getTileStatus("syncplay")}
          positionClass="left-[746px] top-[304px]"
          icon={<Users className="h-6 w-6 stroke-[1.75]" />}
        />

        <ModuleTile
          label="STARTTLS"
          accent="neutral"
          status={getTileStatus("startTls")}
          positionClass="left-[746px] top-[432px]"
          icon={<Lock className="h-6 w-6 stroke-[1.75]" />}
        />

        {/* Central Layered Installer / Uninstaller Window */}
        <div className="absolute left-[212px] top-[236px] z-10 flex h-[348px] w-[476px] gap-2 rounded-[24px] bg-[#14141A] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_28px_64px_rgba(0,0,0,0.62)]">
          {/* Left 3-Tab Sidebar Rail (Install / Update / Repair Modes) */}
          {!isUninstallMode && (
            <nav
              aria-label="Installer sections"
              className="relative flex w-14 flex-col items-center justify-center"
            >
              <div className="relative flex flex-col items-center gap-3">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 top-0 h-[44px] w-10 rounded-[14px] bg-[#221D33] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
                  style={{
                    transform: `translateY(${activeTabIndex * 56}px)`,
                  }}
                />

                <button
                  type="button"
                  aria-label="Install location"
                  title="Install location"
                  onClick={() => setActiveTab("location")}
                  className={`relative z-10 flex h-[44px] w-10 items-center justify-center rounded-[14px] transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#8B5CF6] ${
                    activeTab === "location"
                      ? "text-[#C4B5FD]"
                      : "text-[#5E5E70] hover:text-[#A1A1B5]"
                  }`}
                >
                  <Folder className="h-[18px] w-[18px] stroke-[1.75]" />
                </button>

                <button
                  type="button"
                  aria-label="Setup progress"
                  title="Setup progress"
                  onClick={() => setActiveTab("install")}
                  className={`relative z-10 flex h-[44px] w-10 items-center justify-center rounded-[14px] transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#8B5CF6] ${
                    activeTab === "install"
                      ? "text-[#C4B5FD]"
                      : "text-[#5E5E70] hover:text-[#A1A1B5]"
                  }`}
                >
                  <Layers className="h-[18px] w-[18px] stroke-[1.75]" />
                </button>

                <button
                  type="button"
                  aria-label="Install options"
                  title="Install options"
                  onClick={() => setActiveTab("options")}
                  className={`relative z-10 flex h-[44px] w-10 items-center justify-center rounded-[14px] transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#8B5CF6] ${
                    activeTab === "options"
                      ? "text-[#C4B5FD]"
                      : "text-[#5E5E70] hover:text-[#A1A1B5]"
                  }`}
                >
                  <SlidersHorizontal className="h-[18px] w-[18px] stroke-[1.75]" />
                </button>
              </div>
            </nav>
          )}

          {/* Elevated Main Panel */}
          <div className="flex min-w-0 flex-1 flex-col justify-between rounded-[18px] bg-[#1B1B22] px-6 pb-5 pt-[20px] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            {isUninstallMode ? (
              <div
                key="tab-uninstall"
                className="anim-tab-enter flex h-full flex-col justify-between"
              >
                {/* Header & Progress Track */}
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <SmoothStatusText
                      headline={telemetry.headline}
                      liveStatus={
                        uninstallSummary
                          ? `Removed ${uninstallSummary.removedFiles} files · Cleared ${uninstallSummary.removedShortcuts} shortcuts · Preserved ${uninstallSummary.skippedUnrelatedFiles} non-app file(s)`
                          : cleanLiveError
                      }
                      isError={Boolean(launchError) || isErrorOrCancelled}
                    />
                    <div
                      className={`mono shrink-0 pt-0.5 text-[12px] transition-colors duration-300 ${
                        isComplete
                          ? "text-[#4ADE80]"
                          : isErrorOrCancelled
                            ? "text-[#F87171]"
                            : "text-[#A78BFA]"
                      }`}
                    >
                      {pctRounded}%
                    </div>
                  </div>

                  <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#282834]">
                    <div
                      className={`h-full w-full origin-left rounded-full transition-colors duration-300 ${
                        isComplete
                          ? "bg-[#22C55E]"
                          : isErrorOrCancelled
                            ? "bg-[#F87171]"
                            : "bg-[#E11D48]"
                      }`}
                      style={{
                        transform: `scaleX(${progressFraction})`,
                      }}
                    />
                  </div>
                </div>

                {/* Middle: Ready Options vs Running/Completed Steps */}
                {telemetry.phase === "ready" ? (
                  <div className="flex flex-col gap-3 py-1">
                    <div className="rounded-[12px] bg-[#14141A] px-3.5 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-[#A1A1B5]">
                          Target installation folder
                        </span>
                        {existingReport && existingReport.unrelatedFileCount > 0 && (
                          <span className="text-[10.5px] font-medium text-[#A78BFA]">
                            {existingReport.unrelatedFileCount}
                            {existingReport.unrelatedCountCapped ? "+" : ""} user file(s) preserved
                          </span>
                        )}
                      </div>
                      <div className="mono mt-1 truncate text-[11.5px] text-[#EDEDF2]">
                        {options.installDir}
                      </div>
                    </div>

                    <ToggleOption
                      label="Also remove local logs & update cache"
                      description="Clear %LocalAppData%\EpilodParty diagnostic logs and cached updates"
                      checked={removeUserData}
                      disabled={isRunning}
                      onChange={setRemoveUserData}
                    />

                    {runningProcesses.length > 0 && (
                      <div className="flex items-center gap-2 rounded-[10px] bg-[#221D33] px-3 py-1.5 text-[11px] text-[#F47292]">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">
                          Active ({runningProcesses.map((p) => p.name).join(", ")}) will close automatically
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-4 py-1">
                    {telemetry.steps.map((step) => (
                      <StepRow key={step.id} step={step} />
                    ))}
                    {uninstallSummary?.warnings && uninstallSummary.warnings.length > 0 && (
                      <div
                        className="flex items-center gap-2 rounded-[10px] bg-[#221D33] px-3 py-1.5 text-[11px] text-[#F47292]"
                        title={uninstallSummary.warnings.join(" | ")}
                      >
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{uninstallSummary.warnings[0]}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Uninstall Footer Actions */}
                <div className="flex flex-col gap-2.5">
                  <div className="h-px bg-white/[0.06]" />
                  {telemetry.phase === "ready" && (
                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => void closeInstallerWindow()}
                        className="flex h-10 px-4 items-center justify-center rounded-[12px] bg-[#24242E] text-[12.5px] font-medium text-[#A1A1B5] transition-colors duration-150 hover:bg-[#2C2C38] hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleStartUninstall()}
                        className="flex h-10 flex-1 items-center justify-center gap-2 rounded-[12px] bg-[#E11D48] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#F43F5E] active:scale-[0.985] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F47292]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Uninstall Epilod Party
                      </button>
                    </div>
                  )}

                  {isRunning && (
                    <div className="flex h-10 w-full items-center justify-center gap-2 rounded-[12px] bg-[#221D33] text-[12.5px] font-medium text-[#C4B5FD]">
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-[#F47292] animate-pulse"
                      />
                      <span>{getRunningPhaseLabel(telemetry.phase, true)}</span>
                    </div>
                  )}

                  {isComplete && (
                    <div className="flex items-center gap-2.5">
                      {!tauriMode && (
                        <button
                          type="button"
                          aria-label="Replay uninstall preview"
                          title="Replay uninstall preview"
                          onClick={() => void handleStartUninstall()}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#24242E] text-[#A1A1B5] transition-colors duration-150 hover:bg-[#2E2E3B] hover:text-white cursor-pointer"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void closeInstallerWindow()}
                        className="flex h-10 flex-1 items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] cursor-pointer"
                      >
                        Finish
                      </button>
                    </div>
                  )}

                  {isErrorOrCancelled && (
                    <button
                      type="button"
                      onClick={() => void handleStartUninstall()}
                      className="flex h-10 w-full items-center justify-center rounded-[12px] bg-[#E11D48] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#F43F5E] active:scale-[0.985] cursor-pointer"
                    >
                      Retry uninstall
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {activeTab === "install" && (
                  <div
                    key="tab-install"
                    className="anim-tab-enter flex h-full flex-col justify-between"
                  >
                    {/* Header & GPU Progress Track */}
                    <div className="flex flex-col gap-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <SmoothStatusText
                          headline={telemetry.headline}
                          liveStatus={cleanLiveError}
                          isError={Boolean(launchError) || isErrorOrCancelled}
                        />
                        <div
                          className={`mono shrink-0 text-[12px] pt-0.5 transition-colors duration-300 ${
                            isComplete
                              ? "text-[#4ADE80]"
                              : isErrorOrCancelled
                                ? "text-[#F87171]"
                                : "text-[#A78BFA]"
                          }`}
                        >
                          {pctRounded}%
                        </div>
                      </div>

                      <div className="h-[3px] w-full overflow-hidden rounded-full bg-[#282834]">
                        <div
                          className={`h-full w-full origin-left rounded-full transition-colors duration-300 ${
                            isComplete
                              ? "bg-[#22C55E]"
                              : isErrorOrCancelled
                                ? "bg-[#F87171]"
                                : "bg-[#8B5CF6]"
                          }`}
                          style={{
                            transform: `scaleX(${progressFraction})`,
                          }}
                        />
                      </div>

                      {/* Pre-install SHA-256 verification status pill */}
                      {telemetry.phase === "ready" && existingReport && (
                        <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px]">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {existingReport.disposition === "repairNeeded" ||
                            existingReport.disposition === "downgradeWarning" ? (
                              <AlertTriangle className="h-3 w-3 shrink-0 text-[#F47292]" />
                            ) : (
                              <ShieldCheck className="h-3 w-3 shrink-0 text-[#A78BFA]" />
                            )}
                            <span
                              className={`truncate ${
                                existingReport.disposition === "downgradeWarning"
                                  ? "text-[#F47292]"
                                  : "text-[#9292A6]"
                              }`}
                            >
                              {isVerifying
                                ? "Verifying existing files via SHA-256..."
                                : existingReport.summaryText}
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={isRunning || isVerifying}
                            onClick={() => void handleVerifyNow()}
                            className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-[#A78BFA] hover:text-[#C4B5FD] disabled:opacity-45 cursor-pointer"
                          >
                            <RefreshCw
                              className={`h-2.5 w-2.5 ${isVerifying ? "animate-spin" : ""}`}
                            />
                            Re-verify
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Borderless 3-Step Checklist */}
                    <div className="flex flex-col gap-3.5 py-0.5">
                      {telemetry.steps.map((step) => (
                        <StepRow key={step.id} step={step} />
                      ))}
                    </div>

                    {/* Footer: Running process lock prompt / Path + Primary Purple Action */}
                    <div className="flex flex-col gap-2.5">
                      <div className="h-px bg-white/[0.06]" />

                      {hasLockedProcessError && !isRunning && !isComplete && (
                        <div className="flex items-center justify-between gap-2 rounded-[10px] bg-[#221D33] px-3 py-1.5 text-[11px]">
                          <span className="truncate text-[#F47292]">
                            {runningProcesses.length > 0
                              ? `Running: ${runningProcesses.map((p) => p.name).join(", ")}`
                              : "App files in use by a running process"}
                          </span>
                          <button
                            type="button"
                            disabled={isClosingProcesses}
                            onClick={() => void handleCloseProcesses()}
                            className="shrink-0 rounded-[7px] bg-[#7C3AED] px-2.5 py-1 text-[10.5px] font-medium text-white hover:bg-[#8B5CF6] disabled:opacity-50 cursor-pointer"
                          >
                            {isClosingProcesses ? "Closing..." : "Close & Retry"}
                          </button>
                        </div>
                      )}

                      {payloadMissing && (
                        <div className="truncate text-[11px] text-[#F87171]">
                          Missing installer payload (epilod-payload.epkg). Run build-installer.ps1.
                        </div>
                      )}

                      {pathError && (
                        <div className="truncate text-[11px] text-[#F87171]" title={pathError}>
                          {pathError}
                        </div>
                      )}

                      {insufficientDiskSpace && freeDiskBytes !== null && (
                        <div className="truncate text-[11px] text-[#F87171]">
                          Not enough free disk space ({formatBytes(peakRequiredBytes)} required, {formatBytes(freeDiskBytes)} available).
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-3 text-[11px] text-[#6B6B7D]">
                        <span className="mono truncate">{options.installDir}</span>
                        <span className="shrink-0">
                          {isRunning
                            ? `${telemetry.filesDone}/${telemetry.filesTotal} files`
                            : existingReport && existingReport.unrelatedFileCount > 0
                              ? `${existingReport.unrelatedFileCount}${existingReport.unrelatedCountCapped ? "+" : ""} non-app file(s) kept`
                              : "x64 · Current User"}
                        </span>
                      </div>

                      {!isRunning && !isComplete && !isErrorOrCancelled && (
                        <button
                          type="button"
                          disabled={installBlocked}
                          onClick={() => void handleStartInstall()}
                          className="flex h-10 w-full items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78BFA]"
                        >
                          {installCtaLabel}
                        </button>
                      )}

                      {isRunning && (
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => void handleCancelInstall()}
                            className="flex h-10 px-4 items-center justify-center rounded-[12px] bg-[#24242E] text-[12.5px] font-medium text-[#A1A1B5] transition-colors duration-150 hover:bg-[#2C2C38] hover:text-white cursor-pointer"
                          >
                            Cancel
                          </button>
                          <div className="flex h-10 flex-1 items-center justify-center gap-2 rounded-[12px] bg-[#221D33] text-[12.5px] font-medium text-[#C4B5FD]">
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 rounded-full bg-[#A78BFA] animate-pulse"
                            />
                            <span>{getRunningPhaseLabel(telemetry.phase, false)}</span>
                          </div>
                        </div>
                      )}

                      {isComplete && (
                        <div className="flex items-center gap-2.5">
                          {!tauriMode && (
                            <button
                              type="button"
                              aria-label="Replay preview"
                              title="Replay installation preview"
                              onClick={() => void handleStartInstall()}
                              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#24242E] text-[#A1A1B5] transition-colors duration-150 hover:bg-[#2E2E3B] hover:text-white cursor-pointer"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleLaunch()}
                            className="flex h-10 flex-1 items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A78BFA]"
                          >
                            Launch Epilod Party
                          </button>
                        </div>
                      )}

                      {isErrorOrCancelled && (
                        defaultsError !== null ? (
                          <button
                            type="button"
                            onClick={() => void loadDefaults()}
                            className="flex h-10 w-full items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] cursor-pointer"
                          >
                            Retry initialization
                          </button>
                        ) : defaults?.launchMode === "update" && existingReport?.existingExeFound ? (
                          <div className="flex items-center gap-2.5">
                            <button
                              type="button"
                              onClick={() => void handleLaunch()}
                              className="flex h-10 px-3.5 items-center justify-center rounded-[12px] bg-[#24242E] text-[12px] font-medium text-[#D4D4DF] transition-colors duration-150 hover:bg-[#2E2E3B] hover:text-white cursor-pointer"
                            >
                              Relaunch previous version
                            </button>
                            <button
                              type="button"
                              disabled={installBlocked}
                              onClick={() => void handleStartInstall()}
                              className="flex h-10 flex-1 items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] disabled:opacity-45 cursor-pointer"
                            >
                              Retry update
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={installBlocked}
                            onClick={() => void handleStartInstall()}
                            className="flex h-10 w-full items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium tracking-[-0.01em] text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] disabled:opacity-45 cursor-pointer"
                          >
                            Retry installation
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "location" && (
                  <div
                    key="tab-location"
                    className="anim-tab-enter flex h-full flex-col justify-between"
                  >
                    <div className="flex flex-col gap-3">
                      <div>
                        <div className="text-[15px] font-medium tracking-[-0.015em] text-[#F4F4F6]">
                          Destination folder
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-[#848498]">
                          Per-user setup requires no administrator elevation
                        </div>
                      </div>
                      <div className="h-px bg-white/[0.06]" />
                    </div>

                    <div className="flex flex-col gap-2.5">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <label htmlFor="ep-install-dir" className="text-[11.5px] text-[#848498]">
                            Install directory
                          </label>
                          {defaults?.defaultInstallDir &&
                            options.installDir !== defaults.defaultInstallDir &&
                            !isRunning &&
                            !isComplete && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (dirDebounceRef.current) {
                                    clearTimeout(dirDebounceRef.current);
                                  }
                                  setOptions((prev) => ({
                                    ...prev,
                                    installDir: defaults.defaultInstallDir,
                                  }));
                                  void runDirectoryInspection(defaults.defaultInstallDir, true);
                                }}
                                className="text-[11px] font-medium text-[#A78BFA] hover:text-[#C4B5FD] cursor-pointer"
                              >
                                Reset default
                              </button>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            id="ep-install-dir"
                            type="text"
                            value={options.installDir}
                            disabled={isRunning || isComplete}
                            onChange={(e) => handleDirInputChange(e.target.value)}
                            onBlur={() => {
                              if (dirDebounceRef.current) {
                                clearTimeout(dirDebounceRef.current);
                              }
                              if (options.installDir.trim()) {
                                void runDirectoryInspection(options.installDir, false);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                if (dirDebounceRef.current) {
                                  clearTimeout(dirDebounceRef.current);
                                }
                                if (options.installDir.trim()) {
                                  void runDirectoryInspection(options.installDir, false);
                                }
                              }
                            }}
                            className="mono h-9 min-w-0 flex-1 rounded-[10px] bg-[#14141A] px-3 text-[12px] text-[#F4F4F6] outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6] disabled:opacity-50"
                          />
                          {tauriMode && (
                            <button
                              type="button"
                              disabled={isRunning || isComplete}
                              onClick={() => void handleBrowseFolder()}
                              className="h-9 shrink-0 rounded-[10px] bg-[#24242E] px-3 text-[12px] font-medium text-[#D4D4DF] transition-colors duration-150 hover:bg-[#2D2D3A] disabled:opacity-45 cursor-pointer"
                            >
                              Browse
                            </button>
                          )}
                        </div>
                      </div>

                      {pathError && (
                        <div className="anim-text-swap text-[11px] text-[#F87171]">
                          {pathError}
                        </div>
                      )}

                      {insufficientDiskSpace && freeDiskBytes !== null && (
                        <div className="anim-text-swap text-[11px] text-[#F87171]">
                          Not enough free space ({formatBytes(peakRequiredBytes)} needed, {formatBytes(freeDiskBytes)} available).
                        </div>
                      )}

                      {existingReport && (
                        <div className="flex items-center justify-between gap-2 rounded-[10px] bg-[#14141A] px-3 py-2 text-[11px]">
                          <span className="truncate text-[#A1A1B5]">
                            {isVerifying ? "Checking folder & SHA-256..." : existingReport.summaryText}
                          </span>
                          <button
                            type="button"
                            disabled={isRunning || isVerifying}
                            onClick={() => void handleVerifyNow()}
                            className="shrink-0 font-medium text-[#A78BFA] hover:text-[#C4B5FD] disabled:opacity-45 cursor-pointer"
                          >
                            Verify
                          </button>
                        </div>
                      )}

                      <div className="flex items-center justify-between pt-0.5 text-[11.5px] text-[#7C7C90]">
                        <span>Space required</span>
                        <span className="mono text-[#D4D4DF]">
                          {formatBytes(peakRequiredBytes)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[11.5px] text-[#7C7C90]">
                        <span>Available disk space</span>
                        <span
                          className={`mono ${
                            insufficientDiskSpace ? "text-[#F87171]" : "text-[#4ADE80]"
                          }`}
                        >
                          {freeDiskBytes !== null ? formatBytes(freeDiskBytes) : "Verified"}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2.5">
                      <div className="h-px bg-white/[0.06]" />
                      <button
                        type="button"
                        onClick={() => setActiveTab("install")}
                        className="flex h-10 w-full items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] cursor-pointer"
                      >
                        Back to setup
                      </button>
                    </div>
                  </div>
                )}

                {activeTab === "options" && (
                  <div
                    key="tab-options"
                    className="anim-tab-enter flex h-full flex-col justify-between"
                  >
                    <div className="flex flex-col gap-2.5">
                      <div>
                        <div className="text-[15px] font-medium tracking-[-0.015em] text-[#F4F4F6]">
                          Installation options
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-[#848498]">
                          Shortcuts, Open With &amp; launch preferences
                        </div>
                      </div>
                      <div className="h-px bg-white/[0.06]" />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <ToggleOption
                        label="Desktop shortcut"
                        description="Add Epilod Party icon to your desktop"
                        checked={options.createDesktopShortcut}
                        disabled={isRunning || isComplete}
                        onChange={(v) =>
                          setOptions((prev) => ({ ...prev, createDesktopShortcut: v }))
                        }
                      />
                      <ToggleOption
                        label="Start Menu entry"
                        description="Pin inside Windows Start Menu search"
                        checked={options.createStartMenuShortcut}
                        disabled={isRunning || isComplete}
                        onChange={(v) =>
                          setOptions((prev) => ({ ...prev, createStartMenuShortcut: v }))
                        }
                      />
                      <ToggleOption
                        label='Windows "Open with" menu'
                        description="Offer Epilod Party for video & subtitle files"
                        checked={options.registerFileAssociations}
                        disabled={isRunning || isComplete}
                        onChange={(v) =>
                          setOptions((prev) => ({ ...prev, registerFileAssociations: v }))
                        }
                      />
                      <ToggleOption
                        label="Auto-launch when finished"
                        description="Open Epilod Party automatically after verify"
                        checked={options.autoLaunch}
                        disabled={isRunning || isComplete}
                        onChange={(v) =>
                          setOptions((prev) => ({ ...prev, autoLaunch: v }))
                        }
                      />
                    </div>

                    <div className="flex flex-col gap-2.5">
                      <div className="h-px bg-white/[0.06]" />
                      <button
                        type="button"
                        onClick={() => setActiveTab("install")}
                        className="flex h-10 w-full items-center justify-center rounded-[12px] bg-[#7C3AED] text-[13px] font-medium text-white transition-[background-color,transform] duration-150 hover:bg-[#8B5CF6] active:scale-[0.985] cursor-pointer"
                      >
                        Save &amp; continue
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
