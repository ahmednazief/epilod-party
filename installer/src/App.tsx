import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "./components/BrandMark";
import { CustomizePanel } from "./components/CustomizePanel";
import { GlassSwitchTrack } from "./components/GlassSwitch";
import {
  InstallerArrowIcon,
  InstallerCheckIcon,
  InstallerLaunchIcon,
  InstallerSlidersIcon,
} from "./components/InstallerIcons";
import { ProgressView } from "./components/ProgressView";
import { WindowChrome } from "./components/WindowChrome";
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
  preflightInstallDir,
  runInstallation,
  runUninstallation,
  type RunningInstallHandle,
} from "./lib/installerBridge";
import type {
  DestinationInspection,
  ExistingInstallReport,
  InstallMode,
  InstallOptions,
  InstallTelemetry,
  InstallerDefaults,
  PreflightResult,
  RunningProcessDto,
  UninstallSummary,
} from "./lib/types";

export function App() {
  const [showCustomize, setShowCustomize] = useState(false);
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
  const [runMode, setRunMode] = useState<InstallMode>("install");

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
    async (
      installOpts: InstallOptions,
      defaultsInfo: InstallerDefaults | null = defaults,
      modeOverride?: InstallMode,
    ) => {
      setLaunchError(null);
      autoLaunchedRef.current = false;
      setShowCustomize(false);

      const currentMode: InstallMode =
        modeOverride ??
        (defaultsInfo?.launchMode === "update"
          ? "update"
          : defaultsInfo?.launchMode ?? "install");
      setRunMode(currentMode);
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
          headline: isCancelled
            ? currentMode === "update"
              ? "Update cancelled"
              : "Setup cancelled"
            : currentMode === "update"
              ? "Update paused"
              : "Something got in the way",
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
        otherInstallDir: info.otherInstallDir ?? null,
        otherInstallVersion: info.otherInstallVersion ?? null,
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
        const autoMode: InstallMode =
          info.launchMode === "update" || info.existingReport?.disposition === "updateAvailable"
            ? "update"
            : info.launchMode;
        void startInstallWith(hydratedOptions, info, autoMode);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setDefaultsError(msg);
      setTelemetry((prev) => ({
        ...prev,
        phase: "failed",
        headline: "Couldn’t start setup",
        liveStatus: msg,
        error: msg,
      }));
    } finally {
      if (mountedRef.current) {
        setIsInitializing(false);
      }
    }
  }, [startInstallWith, tauriMode]);

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

  // Smooth rAF interpolation for liquid progress track & percentage readout
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

  // Refresh destination & process lock state if an install gets cancelled or fails
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
    }, 650);
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
      otherInstallDir: res.otherInstallDir ?? null,
      otherInstallVersion: res.otherInstallVersion ?? null,
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
    await startInstallWith(
      {
        ...options,
        forceReunpack: existingReport?.disposition === "upToDateVerified",
        allowDowngrade: existingReport?.disposition === "downgradeWarning",
      },
      defaults,
      activeMode,
    );
  };

  const handleStartUninstall = async () => {
    if (isRunning) return;
    setLaunchError(null);
    setUninstallSummary(null);
    setRunMode("uninstall");

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
        headline: "Uninstall paused",
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

  const handleResetToReady = () => {
    setLaunchError(null);
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
  };

  const handleLaunch = async () => {
    setLaunchError(null);
    try {
      await launchInstalledApp(options.installDir);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    }
  };

  const cleanLiveError = (defaultsError ?? launchError ?? telemetry.liveStatus).replace(
    "[LOCKED_PROCESSES] ",
    "",
  );

  const peakRequiredBytes =
    inspection?.peakRequiredBytes ??
    preflightPeakBytes ??
    defaults?.peakRequiredBytes ??
    Math.max(
      (existingReport?.bytesToWrite ?? defaults?.requiredBytes ?? 94_800_000) + 40_000_000,
      40_000_000,
    );
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

  const installCtaLabel = useMemo(() => {
    if (isInitializing && !defaults) return "Preparing…";
    if (existingReport?.disposition === "repairNeeded") return "Repair";
    if (existingReport?.disposition === "updateAvailable") return "Update";
    if (existingReport?.disposition === "upToDateVerified") return "Reinstall";
    if (existingReport?.disposition === "downgradeWarning") return "Reinstall Older";
    return options.autoLaunch ? "Install & Launch" : "Install";
  }, [defaults, existingReport?.disposition, isInitializing, options.autoLaunch]);

  const effectiveMode: InstallMode =
    isRunning || isComplete || isErrorOrCancelled ? runMode : activeMode;

  const otherInstallDir = inspection?.otherInstallDir ?? defaults?.otherInstallDir ?? null;
  const otherInstallVersion =
    inspection?.otherInstallVersion ?? defaults?.otherInstallVersion ?? null;

  const readySubtitle = useMemo(() => {
    if (isInitializing && !defaults) return "Preparing setup…";
    if (existingReport?.disposition === "updateAvailable") {
      return existingReport.installedVersion
        ? `Update available: v${existingReport.installedVersion} → v${defaults?.packageVersion ?? "0.1.0"}.`
        : `Ready to update to v${defaults?.packageVersion ?? "0.1.0"}.`;
    }
    if (existingReport?.disposition === "repairNeeded") {
      return "Ready to verify and repair installation.";
    }
    if (existingReport?.disposition === "downgradeWarning") {
      return `v${existingReport.installedVersion ?? "newer"} is already installed.`;
    }
    if (existingReport?.disposition === "upToDateVerified") {
      return "Epilod Party is up to date and ready.";
    }
    return "Watch together, effortlessly.";
  }, [defaults, existingReport, isInitializing]);

  const topLeftSlot = (() => {
    if (isRunning) {
      const label =
        isUninstallMode || effectiveMode === "uninstall"
          ? "Uninstalling"
          : effectiveMode === "update"
            ? "Updating"
            : effectiveMode === "repair"
              ? "Repairing"
              : "Installing";
      return (
        <span className="ep-status-pill inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-white/70">
          <span className="h-1.5 w-1.5 rounded-full bg-white/45 animate-pulse" />
          <span>{label}</span>
        </span>
      );
    }
    if (isComplete) {
      const label =
        isUninstallMode || effectiveMode === "uninstall"
          ? "Removed"
          : effectiveMode === "update"
            ? "Updated"
            : effectiveMode === "repair"
              ? "Repaired"
              : "Installed";
      return (
        <span className="ep-status-pill inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-white/80">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80 shadow-[0_0_6px_rgba(52,211,153,0.4)]" />
          <span>{label}</span>
        </span>
      );
    }
    if (isErrorOrCancelled) {
      const label =
        telemetry.phase === "cancelled"
          ? effectiveMode === "update"
            ? "Update cancelled"
            : "Cancelled"
          : effectiveMode === "update"
            ? "Update paused"
            : "Paused";
      return (
        <span className="ep-status-pill inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-[#FCA5A5]">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
          <span>{label}</span>
        </span>
      );
    }
    if (isUninstallMode) {
      return (
        <span className="ep-status-pill inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-white/60">
          <span>Uninstall</span>
        </span>
      );
    }
    if (showCustomize) {
      return (
        <button
          type="button"
          onClick={() => setShowCustomize(false)}
          className="ep-glass-pill inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium text-white/80 hover:text-white"
        >
          <InstallerArrowIcon direction="left" size={12} />
          <span>Back</span>
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setShowCustomize(true)}
        className="ep-glass-pill inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium text-white/75 hover:text-white"
      >
        <InstallerSlidersIcon size={11} />
        <span>Customize</span>
      </button>
    );
  })();

  const versionLabel = `v${defaults?.packageVersion ?? defaults?.version ?? "0.1.0"}`;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden">
      <div
        data-tauri-drag-region
        className="ep-installer-window ep-stage-in flex flex-col justify-between w-full h-full"
      >
        <WindowChrome leftSlot={topLeftSlot} />

        <main
          className={`relative z-10 flex flex-1 min-h-0 flex-col items-center px-6 ${
            showCustomize ? "justify-center overflow-y-auto pb-3" : "justify-center pb-4"
          }`}
        >
          {isRunning ? (
            <ProgressView
              mode={effectiveMode}
              isUninstall={isUninstallMode}
              percent={displayPercent}
              onCancel={() => void handleCancelInstall()}
            />
          ) : isComplete ? (
            isUninstallMode ? (
              <div key="uninstall-complete" className="ep-view-enter flex w-full max-w-[320px] flex-col items-center text-center">
                <h1 className="text-[19px] font-semibold tracking-tight text-white">
                  All cleaned up
                </h1>
                <p className="mt-1 text-xs text-white/60">
                  Epilod Party has been removed from this PC.
                </p>
                {uninstallSummary && uninstallSummary.warnings && uninstallSummary.warnings.length > 0 && (
                  <p
                    className="mt-2 max-w-[310px] truncate text-[11px] text-[#FCA5A5]"
                    title={uninstallSummary.warnings.join(" | ")}
                  >
                    {uninstallSummary.warnings[0]}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void closeInstallerWindow()}
                  className="ep-glass-pill mt-5 h-8.5 cursor-pointer rounded-full px-6 text-xs font-medium text-white"
                >
                  Close
                </button>
              </div>
            ) : (
              <div key="install-complete" className="ep-view-enter flex w-full max-w-[320px] flex-col items-center text-center">
                <div className="relative mb-3">
                  <BrandMark size={50} className="ep-icon-rest" />
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[#22C55E] text-[#052E16] shadow-md ring-2 ring-[#0c0d11]"
                  >
                    <InstallerCheckIcon size={11} />
                  </span>
                </div>
                <h1 className="text-[18px] font-semibold tracking-tight text-white">
                  {effectiveMode === "update"
                    ? "Epilod Party updated"
                    : effectiveMode === "repair"
                      ? "Repair complete"
                      : "You’re all set"}
                </h1>
                <p className="mt-1 text-xs text-white/60">
                  {effectiveMode === "update"
                    ? `${versionLabel} is ready for showtime.`
                    : effectiveMode === "repair"
                      ? "Epilod Party is verified and ready."
                      : "Epilod Party is ready for showtime."}
                </p>
                {launchError && (
                  <p className="mt-2 max-w-[310px] truncate text-[11px] text-[#FCA5A5]" title={launchError}>
                    {launchError}
                  </p>
                )}
                <div className="mt-4 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => void closeInstallerWindow()}
                    className="ep-glass-pill h-8.5 cursor-pointer rounded-full px-4 text-xs font-medium text-white/75 hover:text-white"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleLaunch()}
                    className="ep-glass-primary-pill inline-flex h-8.5 cursor-pointer items-center gap-1.5 rounded-full px-5 text-xs font-medium text-white"
                  >
                    <InstallerLaunchIcon size={12} />
                    <span>Launch Epilod Party</span>
                  </button>
                </div>
              </div>
            )
          ) : isErrorOrCancelled ? (
            <div key="error-view" className="ep-view-enter flex w-full max-w-[320px] flex-col items-center text-center">
              <BrandMark size={46} className="ep-icon-rest mb-2.5 opacity-85" />
              <h1 className="text-[17px] font-semibold tracking-tight text-white">
                {telemetry.phase === "cancelled"
                  ? effectiveMode === "update"
                    ? "Update cancelled"
                    : "Setup cancelled"
                  : defaultsError
                    ? "Couldn’t start setup"
                    : isUninstallMode
                      ? "Uninstall paused"
                      : effectiveMode === "update"
                        ? "Update paused"
                        : "Something got in the way"}
              </h1>
              <p
                className={`mt-1 line-clamp-2 text-xs leading-relaxed ${
                  telemetry.phase === "cancelled" ? "text-white/60" : "text-[#FCA5A5]"
                }`}
                title={cleanLiveError}
              >
                {cleanLiveError}
              </p>

              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {hasLockedProcessError && runningProcesses.length > 0 && !isUninstallMode ? (
                  <>
                    <button
                      type="button"
                      onClick={handleResetToReady}
                      className="ep-glass-pill h-8.5 cursor-pointer rounded-full px-4 text-xs font-medium text-white/75 hover:text-white"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={isClosingProcesses}
                      onClick={() => void handleCloseProcesses()}
                      className="ep-glass-primary-pill h-8.5 cursor-pointer rounded-full px-5 text-xs font-medium text-white disabled:opacity-45"
                    >
                      {isClosingProcesses ? "Closing…" : "Close & Retry"}
                    </button>
                  </>
                ) : defaultsError !== null ? (
                  <button
                    type="button"
                    onClick={() => void loadDefaults()}
                    className="ep-glass-primary-pill h-8.5 cursor-pointer rounded-full px-6 text-xs font-medium text-white"
                  >
                    Try Again
                  </button>
                ) : defaults?.launchMode === "update" && existingReport?.existingExeFound ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleLaunch()}
                      className="ep-glass-pill h-8.5 cursor-pointer rounded-full px-3.5 text-xs font-medium text-white/80 hover:text-white"
                    >
                      Relaunch previous version
                    </button>
                    <button
                      type="button"
                      disabled={installBlocked}
                      onClick={() => void handleStartInstall()}
                      className="ep-glass-primary-pill h-8.5 cursor-pointer rounded-full px-4.5 text-xs font-medium text-white disabled:opacity-45"
                    >
                      Retry update
                    </button>
                  </>
                ) : isUninstallMode ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void closeInstallerWindow()}
                      className="ep-glass-pill h-8.5 cursor-pointer rounded-full px-4 text-xs font-medium text-white/75 hover:text-white"
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleStartUninstall()}
                      className="ep-glass-danger-pill h-8.5 cursor-pointer rounded-full px-5 text-xs font-medium text-white"
                    >
                      Retry uninstall
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleResetToReady}
                      className="ep-glass-pill h-8.5 cursor-pointer rounded-full px-4 text-xs font-medium text-white/75 hover:text-white"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={installBlocked}
                      onClick={() => void handleStartInstall()}
                      className="ep-glass-primary-pill h-8.5 cursor-pointer rounded-full px-5 text-xs font-medium text-white disabled:opacity-45"
                    >
                      Try Again
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : isUninstallMode ? (
            <div key="uninstall-ready" className="ep-view-enter flex w-full max-w-[320px] flex-col items-center text-center">
              <BrandMark size={48} className="ep-icon-rest mb-2.5 opacity-85" />
              <h1 className="text-[18px] font-semibold tracking-tight text-white">
                Remove Epilod Party?
              </h1>
              <p className="mt-1 text-xs text-white/60">
                Your personal files stay untouched.
              </p>

              <button
                type="button"
                role="switch"
                aria-checked={removeUserData}
                onClick={() => setRemoveUserData((v) => !v)}
                className="ep-glass-well mt-3 flex w-full cursor-pointer items-center justify-between gap-3 rounded-2xl px-3 py-1.5 text-left text-xs text-white/80 hover:text-white"
              >
                <span className="truncate">Also clear local logs &amp; cache</span>
                <GlassSwitchTrack checked={removeUserData} />
              </button>

              <div className="mt-3.5 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => void closeInstallerWindow()}
                  className="ep-glass-pill h-8.5 cursor-pointer rounded-full px-4 text-xs font-medium text-white/75 hover:text-white"
                >
                  Keep App
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartUninstall()}
                  className="ep-glass-danger-pill h-8.5 cursor-pointer rounded-full px-5 text-xs font-medium text-white"
                >
                  Uninstall
                </button>
              </div>
            </div>
          ) : showCustomize ? (
            <CustomizePanel
              options={options}
              defaultInstallDir={defaults?.defaultInstallDir ?? null}
              tauriMode={tauriMode}
              disabled={isRunning || isComplete}
              pathError={pathError}
              insufficientDiskSpace={insufficientDiskSpace}
              peakRequiredBytes={peakRequiredBytes}
              freeDiskBytes={freeDiskBytes}
              otherInstallDir={otherInstallDir}
              otherInstallVersion={otherInstallVersion}
              ctaLabel={installCtaLabel}
              installBlocked={installBlocked}
              onDirChange={handleDirInputChange}
              onDirBlurOrEnter={() => {
                if (dirDebounceRef.current) {
                  clearTimeout(dirDebounceRef.current);
                }
                if (options.installDir.trim()) {
                  void runDirectoryInspection(options.installDir, false);
                }
              }}
              onResetDir={() => {
                if (!defaults?.defaultInstallDir) return;
                if (dirDebounceRef.current) {
                  clearTimeout(dirDebounceRef.current);
                }
                setOptions((prev) => ({
                  ...prev,
                  installDir: defaults.defaultInstallDir,
                }));
                void runDirectoryInspection(defaults.defaultInstallDir, true);
              }}
              onBrowseDir={() => void handleBrowseFolder()}
              onUpdateOptions={setOptions}
              onSaveAndInstall={() => void handleStartInstall()}
            />
          ) : (
            <div key="install-ready" className="ep-view-enter flex w-full max-w-[320px] flex-col items-center text-center">
              <BrandMark size={50} className="ep-icon-rest mb-2.5" />
              <h1 className="text-[18px] font-semibold tracking-tight text-white">
                Epilod Party
              </h1>
              <p className="mt-1 text-xs text-white/60 font-normal">{readySubtitle}</p>

              {runningProcesses.length > 0 && !defaults?.autoStart ? (
                <div className="ep-glass-well mt-2.5 flex items-center gap-2 rounded-full pl-3 pr-1 py-0.5 text-xs">
                  <span className="truncate text-white/75">Epilod Party is running</span>
                  <button
                    type="button"
                    disabled={isClosingProcesses}
                    onClick={() => void handleCloseProcesses()}
                    className="ep-glass-pill shrink-0 cursor-pointer rounded-full px-2.5 py-0.5 text-[11px] font-medium text-white disabled:opacity-45"
                  >
                    {isClosingProcesses ? "Closing…" : "Close & Continue"}
                  </button>
                </div>
              ) : payloadMissing ? (
                <p className="mt-2 text-xs text-[#FCA5A5]">
                  Installer payload is missing.
                </p>
              ) : pathError ? (
                <button
                  type="button"
                  onClick={() => setShowCustomize(true)}
                  className="mt-2 max-w-[300px] cursor-pointer truncate text-xs text-[#FCA5A5] hover:underline"
                  title={pathError}
                >
                  {pathError}
                </button>
              ) : insufficientDiskSpace && freeDiskBytes !== null ? (
                <p className="mt-2 text-xs text-[#FCA5A5]">
                  Needs {formatBytes(peakRequiredBytes)} free ({formatBytes(freeDiskBytes)} left).
                </p>
              ) : otherInstallDir ? (
                <p
                  className="mt-2 max-w-[300px] truncate text-xs text-white/65"
                  title={otherInstallDir}
                >
                  Replaces existing{otherInstallVersion ? ` v${otherInstallVersion}` : ""} copy on this PC
                </p>
              ) : null}

              <div className="mt-4 flex items-center justify-center">
                <button
                  type="button"
                  disabled={installBlocked}
                  onClick={() => void handleStartInstall()}
                  className="ep-glass-primary-pill inline-flex h-9 cursor-pointer items-center gap-2 rounded-full px-7 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span>{installCtaLabel}</span>
                  <InstallerArrowIcon direction="right" size={13} />
                </button>
              </div>

              <span className="num mt-2.5 text-[11px] text-white/35 font-medium tracking-wide">
                {versionLabel} · Windows
              </span>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
