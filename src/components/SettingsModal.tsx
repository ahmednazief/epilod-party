import { ArrowLeft, ChevronRight, Download, Pause, RefreshCw, RotateCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getLogsSnapshot, type LogEntry } from "../lib/logger";
import { setAllowNetworkShares } from "../lib/mpv";
import { DEFAULT_ENDPOINT } from "../lib/syncStatusDisplay";
import { formatBytesCompact, formatTransferSpeed } from "../lib/updater";
import { validateServerEndpointInput } from "../lib/webviewHardening";
import { useAppStore, type SettingsTab } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import { Button } from "./ui/Button";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { TextField } from "./ui/TextField";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onApplyServerConfig?: (endpoint: string, password: string) => void;
}

export function SettingsModal({ open, onClose, onApplyServerConfig }: SettingsModalProps) {
  const tab = useAppStore((s) => s.settingsTab);
  const setTab = useAppStore((s) => s.setSettingsTab);

  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const allowNetworkShares = useAppStore((s) => s.allowNetworkShares);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const hashFilenames = useAppStore((s) => s.hashFilenames);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const autoCheckUpdates = useAppStore((s) => s.autoCheckUpdates);

  const setServerEndpoint = useAppStore((s) => s.setServerEndpoint);
  const setServerPassword = useAppStore((s) => s.setServerPassword);
  const setStoreAllowShares = useAppStore((s) => s.setAllowNetworkShares);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);
  const setHashFilenames = useAppStore((s) => s.setHashFilenames);
  const setReducedMotion = useAppStore((s) => s.setReducedMotion);
  const setLowPowerMode = useAppStore((s) => s.setLowPowerMode);
  const setAutoCheckUpdates = useAppStore((s) => s.setAutoCheckUpdates);
  const pushNote = useNotificationStore((s) => s.push);

  const updateStatus = useUpdaterStore((s) => s.status);
  const updateProgress = useUpdaterStore((s) => s.progress);
  const isCheckingUpdates = useUpdaterStore((s) => s.isChecking);
  const isDownloadingUpdate = useUpdaterStore((s) => s.isDownloading);
  const isUpdatePaused = useUpdaterStore((s) => s.isPaused);
  const isApplyingUpdate = useUpdaterStore((s) => s.isApplying);
  const updateError = useUpdaterStore((s) => s.error);
  const initUpdater = useUpdaterStore((s) => s.init);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const startUpdateDownload = useUpdaterStore((s) => s.startDownload);
  const cancelUpdateDownload = useUpdaterStore((s) => s.cancelDownload);
  const applyAndRestartUpdate = useUpdaterStore((s) => s.applyAndRestart);

  const [endpointDraft, setEndpointDraft] = useState(serverEndpoint);
  const [passwordDraft, setPasswordDraft] = useState(serverPassword);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsPath, setLogsPath] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setEndpointDraft(serverEndpoint);
      setPasswordDraft(serverPassword);
      setEndpointError(null);
      void initUpdater();
    }
  }, [open, serverEndpoint, serverPassword, initUpdater]);

  const loadLogs = async () => {
    setLogsLoading(true);
    try {
      const snap = await getLogsSnapshot(150);
      setLogs(snap.entries);
      setLogsPath(snap.logFilePath ?? null);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    if (open && tab === "logs") {
      void loadLogs();
    }
  }, [open, tab]);

  if (!open) return null;

  const handleSaveServer = () => {
    const check = validateServerEndpointInput(endpointDraft);
    if (!check.ok || !check.endpoint) {
      setEndpointError(check.reason ?? "Invalid server address.");
      return;
    }
    setEndpointError(null);
    setServerEndpoint(check.endpoint);
    setServerPassword(passwordDraft);
    onApplyServerConfig?.(check.endpoint, passwordDraft);
    pushNote("success", `Connected server updated to ${check.endpoint}.`);
    onClose();
  };

  const availableRelease = updateStatus?.availableRelease ?? null;
  const availability = updateStatus?.availability ?? "upToDate";
  const progressFraction = Math.min(1, Math.max(0, (updateProgress?.percent ?? 0) / 100));
  const lastCheckedLabel = updateStatus?.checkedAtUnix
    ? new Date(updateStatus.checkedAtUnix * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className="anim-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-canvas/85 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="anim-modal-in w-full max-w-lg bg-chrome border border-hairline rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-hairline">
          <h2 className="text-sm font-medium text-primary">
            {tab === "logs" ? "Diagnostic Logs" : "Settings"}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close settings">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {tab !== "logs" && (
          <div className="px-5 pt-3.5">
            <SegmentedTabs<SettingsTab>
              ariaLabel="Settings sections"
              value={tab}
              onChange={setTab}
              className="w-full"
              items={[
                { value: "prefs", label: "General" },
                { value: "updates", label: "Updates" },
                { value: "server", label: "Connection" },
              ]}
            />
          </div>
        )}

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {tab === "prefs" && (
            <div className="anim-tab-in space-y-3">
              <label className="flex items-start justify-between gap-3 p-3.5 bg-canvas border border-hairline rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Hide friend names in sidebar</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Useful when streaming or recording your screen.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={hideParticipants}
                  onChange={(e) => setHideParticipants(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>

              <label className="flex items-start justify-between gap-3 p-3.5 bg-canvas border border-hairline rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Private file titles</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Share an anonymous fingerprint with the room instead of your video&apos;s filename.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={hashFilenames}
                  onChange={(e) => setHashFilenames(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>

              <label className="flex items-start justify-between gap-3 p-3.5 bg-canvas border border-hairline rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Allow shared network folders</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Open videos from mapped LAN drives or shared folders on your home network.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={allowNetworkShares}
                  onChange={(e) => {
                    const allow = e.target.checked;
                    setStoreAllowShares(allow);
                    void setAllowNetworkShares(allow);
                  }}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>

              <label className="flex items-start justify-between gap-3 p-3.5 bg-canvas border border-hairline rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Low-power subtitle sync</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Use lower CPU priority during subtitle auto-sync so playback stays smooth.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={lowPowerMode}
                  onChange={(e) => setLowPowerMode(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>

              <label className="flex items-start justify-between gap-3 p-3.5 bg-canvas border border-hairline rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Reduce animations</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Minimize transitions and motion across the interface.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={reducedMotion}
                  onChange={(e) => setReducedMotion(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>

              <div className="pt-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => setTab("logs")}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-secondary transition-colors cursor-pointer"
                >
                  <span>View diagnostic logs</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {tab === "updates" && (
            <div className="anim-tab-in space-y-4">
              <div className="p-4 bg-canvas border border-hairline rounded-xl space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        availability === "downloadedReady"
                          ? "bg-ok"
                          : availability === "updateAvailable"
                            ? "bg-accent"
                            : availability === "unsupportedUpgrade"
                              ? "bg-bad"
                              : "bg-muted"
                      }`}
                    />
                    <span className="text-xs font-medium text-primary">
                      Version {updateStatus?.currentVersion ?? "0.1.0"}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted">
                    {lastCheckedLabel ? `Checked at ${lastCheckedLabel}` : "Official releases"}
                  </span>
                </div>

                <p className="text-xs text-secondary leading-relaxed">
                  {updateStatus?.message ?? "You're up to date with verified releases."}
                </p>

                {availableRelease && (
                  <div className="rounded-[var(--radius-ui)] bg-chrome border border-hairline p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-primary">
                        Epilod Party v{availableRelease.version}
                      </span>
                      <span className="text-[11px] font-mono text-muted">
                        {formatBytesCompact(availableRelease.sizeBytes)}
                      </span>
                    </div>
                    {availableRelease.notes && (
                      <p className="text-[11px] text-secondary leading-relaxed whitespace-pre-line">
                        {availableRelease.notes}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 pt-1 text-[10.5px] font-mono text-muted">
                      <ShieldCheck className="h-3 w-3 text-ok shrink-0" />
                      <span className="truncate">
                        {updateStatus?.signatureVerified
                          ? `Ed25519 Signed · SHA-256: ${availableRelease.sha256.slice(0, 16)}...`
                          : `SHA-256 Verified: ${availableRelease.sha256.slice(0, 16)}...`}
                      </span>
                    </div>
                  </div>
                )}

                {(isDownloadingUpdate || isUpdatePaused || updateProgress?.stage === "verifying") &&
                  updateProgress && (
                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-secondary truncate">{updateProgress.message}</span>
                        <span className="font-mono text-muted shrink-0">
                          {updateProgress.speedBps > 0
                            ? `${formatTransferSpeed(updateProgress.speedBps)} · `
                            : ""}
                          {Math.round(updateProgress.percent)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-chrome border border-hairline">
                        <div
                          className="h-full w-full origin-left bg-accent transition-transform duration-150 ease-out"
                          style={{ transform: `scaleX(${progressFraction})` }}
                        />
                      </div>
                      {updateProgress.totalBytes > 0 && (
                        <div className="flex justify-between text-[10.5px] font-mono text-muted">
                          <span>{formatBytesCompact(updateProgress.downloadedBytes)}</span>
                          <span>{formatBytesCompact(updateProgress.totalBytes)}</span>
                        </div>
                      )}
                    </div>
                  )}

                {updateError && (
                  <p className="text-[11px] text-bad bg-chrome border border-bad/40 rounded-[var(--radius-ui)] px-2.5 py-2">
                    {updateError}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isCheckingUpdates || isDownloadingUpdate || isApplyingUpdate}
                    onClick={() => void checkForUpdates(false)}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${isCheckingUpdates ? "animate-spin" : ""}`}
                    />
                    {isCheckingUpdates ? "Checking..." : "Check for Updates"}
                  </Button>

                  <div className="flex items-center gap-2">
                    {isDownloadingUpdate && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void cancelUpdateDownload()}
                      >
                        <Pause className="h-3.5 w-3.5" />
                        Pause
                      </Button>
                    )}

                    {!isDownloadingUpdate && availability === "updateAvailable" && availableRelease && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void startUpdateDownload()}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {isUpdatePaused ? "Resume Download" : "Download Update"}
                      </Button>
                    )}

                    {availability === "downloadedReady" && availableRelease && (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={isApplyingUpdate}
                        onClick={() => void applyAndRestartUpdate()}
                      >
                        <RotateCw
                          className={`h-3.5 w-3.5 ${isApplyingUpdate ? "animate-spin" : ""}`}
                        />
                        {isApplyingUpdate
                          ? "Launching Updater..."
                          : `Restart & Update to v${availableRelease.version}`}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              <label className="flex items-start justify-between gap-3 p-3.5 bg-canvas border border-hairline rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">
                    Check for updates automatically
                  </p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Look for new releases automatically when the app opens.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={autoCheckUpdates}
                  onChange={(e) => setAutoCheckUpdates(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>
            </div>
          )}

          {tab === "server" && (
            <div className="anim-tab-in space-y-4">
              <TextField
                label="Watch Party Server"
                value={endpointDraft}
                placeholder={DEFAULT_ENDPOINT}
                onChange={(e) => {
                  setEndpointDraft(e.target.value);
                  if (endpointError) setEndpointError(null);
                }}
                error={endpointError}
                hint={`Default server: ${DEFAULT_ENDPOINT}`}
              />

              <TextField
                label="Server or Room Password (Optional)"
                type="password"
                value={passwordDraft}
                maxLength={128}
                placeholder="Used for this session only"
                onChange={(e) => setPasswordDraft(e.target.value)}
                hint="Stored in memory only and cleared when you close the app."
              />

              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEndpointDraft(DEFAULT_ENDPOINT);
                    setEndpointError(null);
                  }}
                >
                  Reset Default
                </Button>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" onClick={handleSaveServer}>
                    Save
                  </Button>
                </div>
              </div>
            </div>
          )}

          {tab === "logs" && (
            <div className="anim-tab-in space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => setTab("prefs")}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to General
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void loadLogs()}>
                  <RefreshCw className={`h-3.5 w-3.5 ${logsLoading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>

              {logsPath && (
                <p className="text-[11px] text-muted truncate">{logsPath}</p>
              )}

              <div className="h-60 overflow-y-auto bg-canvas border border-hairline rounded-xl p-2.5 font-mono text-[11px] space-y-1">
                {logs.length === 0 ? (
                  <p className="text-muted p-2">No diagnostic events recorded in this session yet.</p>
                ) : (
                  logs.map((entry, idx) => (
                    <div key={`${entry.tsMs}-${idx}`} className="flex items-start gap-2 leading-snug">
                      <span
                        className={`uppercase shrink-0 w-10 ${
                          entry.level === "error"
                            ? "text-bad"
                            : entry.level === "warn"
                              ? "text-warn"
                              : "text-muted"
                        }`}
                      >
                        {entry.level}
                      </span>
                      <span className="text-secondary shrink-0">[{entry.target}]</span>
                      <span className="text-primary break-all">{entry.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
