import {
  ChevronDown,
  Download,
  Pause,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getLogsSnapshot, type LogEntry } from "../lib/logger";
import { setAllowNetworkShares } from "../lib/mpv";
import { DEFAULT_ENDPOINT } from "../lib/syncStatusDisplay";
import { playSoundCue } from "../lib/soundEffects";
import { formatBytesCompact, formatTransferSpeed } from "../lib/updater";
import { validateServerEndpointInput } from "../lib/webviewHardening";
import { useAppStore, type SettingsTab } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import { Button } from "./ui/Button";
import { AvatarPicker, ProfileAvatar } from "./ui/ProfileAvatar";
import { TextField } from "./ui/TextField";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onApplyServerConfig?: (endpoint: string, password: string) => void;
}

const PRIMARY_NAV: ReadonlyArray<{ value: SettingsTab; label: string }> = [
  { value: "prefs", label: "Comfort & Privacy" },
  { value: "updates", label: "Updates" },
];

const ADVANCED_NAV: ReadonlyArray<{ value: SettingsTab; label: string }> = [
  { value: "server", label: "Connection & Server" },
  { value: "logs", label: "Diagnostics" },
];

function ComfortSwitchRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="ep-menu-row ep-press w-full px-3 py-3 flex items-center justify-between gap-4 text-left cursor-pointer"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-white">{title}</div>
        <div className="text-xs text-secondary leading-relaxed mt-0.5">{description}</div>
      </div>
      <span
        className={`ep-switch-track w-10 h-6 rounded-full p-0.5 flex items-center transition-colors shrink-0 ${
          checked ? "bg-accent justify-end" : "bg-white/18 justify-start"
        }`}
      >
        <span className="ep-switch-thumb h-5 w-5 rounded-full bg-white shadow" />
      </span>
    </button>
  );
}

export function SettingsModal({ open, onClose, onApplyServerConfig }: SettingsModalProps) {
  const tab = useAppStore((s) => s.settingsTab);
  const setTab = useAppStore((s) => s.setSettingsTab);

  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const allowNetworkShares = useAppStore((s) => s.allowNetworkShares);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const hashFilenames = useAppStore((s) => s.hashFilenames);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const soundEffectsEnabled = useAppStore((s) => s.soundEffectsEnabled);
  const autoCheckUpdates = useAppStore((s) => s.autoCheckUpdates);
  const autoDownloadUpdates = useAppStore((s) => s.autoDownloadUpdates);

  const setUsername = useAppStore((s) => s.setUsername);
  const setAvatarId = useAppStore((s) => s.setAvatarId);
  const setServerEndpoint = useAppStore((s) => s.setServerEndpoint);
  const setServerPassword = useAppStore((s) => s.setServerPassword);
  const setStoreAllowShares = useAppStore((s) => s.setAllowNetworkShares);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);
  const setHashFilenames = useAppStore((s) => s.setHashFilenames);
  const setReducedMotion = useAppStore((s) => s.setReducedMotion);
  const setLowPowerMode = useAppStore((s) => s.setLowPowerMode);
  const setSoundEffectsEnabled = useAppStore((s) => s.setSoundEffectsEnabled);
  const setAutoCheckUpdates = useAppStore((s) => s.setAutoCheckUpdates);
  const setAutoDownloadUpdates = useAppStore((s) => s.setAutoDownloadUpdates);
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsPath, setLogsPath] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setEndpointDraft(serverEndpoint);
      setPasswordDraft(serverPassword);
      setEndpointError(null);
      if (tab === "server" || tab === "logs") {
        setAdvancedOpen(true);
      }
      void initUpdater();
    }
  }, [open, serverEndpoint, serverPassword, initUpdater, tab]);

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
    pushNote("success", `Connection updated to ${check.endpoint}.`);
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
      className="ep-modal-backdrop anim-backdrop-in fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Preferences"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ep-glass-sheet anim-modal-in w-full max-w-[660px] h-[480px] max-h-[85vh] rounded-[26px] overflow-hidden grid grid-cols-12">
        {/* Left Navigation Rail (subtle airy tint separation) */}
        <aside className="col-span-4 bg-white/[0.03] p-3.5 flex flex-col justify-between min-h-0">
          <div className="space-y-4">
            <div className="px-2.5 pt-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-tight text-white">Preferences</h2>
            </div>

            <nav className="space-y-1" aria-label="Preference sections">
              {PRIMARY_NAV.map((item) => {
                const active = tab === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    data-active={active}
                    onClick={() => setTab(item.value)}
                    className={`ep-menu-row ep-press w-full px-3 py-2 flex items-center gap-2.5 text-left text-xs cursor-pointer ${
                      active ? "text-white font-medium" : "text-secondary hover:text-white"
                    }`}
                  >
                    {item.value === "prefs" ? (
                      <Sparkles className="h-3.5 w-3.5 text-accent-soft shrink-0" />
                    ) : (
                      <Download className="h-3.5 w-3.5 text-accent-soft shrink-0" />
                    )}
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Tucked-away Discord-style Advanced section */}
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              className="ep-press w-full px-2.5 py-1.5 flex items-center justify-between text-[11px] font-medium text-muted hover:text-secondary cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                <Wrench className="h-3 w-3" />
                Advanced
              </span>
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-200 ${
                  advancedOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {advancedOpen && (
              <div className="anim-fade-slide-up space-y-1">
                {ADVANCED_NAV.map((item) => {
                  const active = tab === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      data-active={active}
                      onClick={() => setTab(item.value)}
                      className={`ep-menu-row ep-press w-full px-3 py-1.5 flex items-center gap-2 text-left text-xs cursor-pointer ${
                        active ? "text-white font-medium" : "text-muted hover:text-white"
                      }`}
                    >
                      {item.value === "server" ? (
                        <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Terminal className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* Right Content Pane — Zero boxed cards per row and zero partial lines */}
        <div className="col-span-8 flex flex-col min-h-0">
          <div className="px-6 pt-4 pb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">
              {tab === "prefs" && "Comfort & Privacy"}
              {tab === "updates" && "App Updates"}
              {tab === "server" && "Connection & Shared Folders"}
              {tab === "logs" && "Session Diagnostics"}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-3">
            {tab === "prefs" && (
              <div className="anim-tab-in space-y-4">
                <div className="ep-menu-row rounded-2xl p-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <ProfileAvatar
                      avatarId={avatarId}
                      size={44}
                      className="ring-2 ring-accent/55 shadow-[0_6px_18px_rgba(124,58,237,0.3)]"
                    />
                    <div className="flex-1 min-w-0">
                      <TextField
                        label="Display Name"
                        value={username}
                        maxLength={32}
                        placeholder="Viewer"
                        onChange={(e) => setUsername(e.target.value)}
                      />
                    </div>
                  </div>

                  <AvatarPicker
                    value={avatarId}
                    onChange={setAvatarId}
                    compact
                  />
                </div>

                <div className="space-y-0.5">
                  <ComfortSwitchRow
                    title="Streamer Mode (Hide Profile Icons)"
                    description="Hide friend names and profile avatars while streaming or sharing your screen."
                    checked={hideParticipants}
                    onChange={setHideParticipants}
                  />

                  <ComfortSwitchRow
                    title="Private File Titles"
                    description="Keep your local movie filename private from party servers."
                    checked={hashFilenames}
                    onChange={setHashFilenames}
                  />

                  <ComfortSwitchRow
                    title="Calm Motion"
                    description="Replace bouncy spring transitions with gentle fades."
                    checked={reducedMotion}
                    onChange={setReducedMotion}
                  />

                  <ComfortSwitchRow
                    title="Quiet Background Sync"
                    description="Keep subtitle alignment gentle on fans and battery during long movies."
                    checked={lowPowerMode}
                    onChange={setLowPowerMode}
                  />

                  <ComfortSwitchRow
                    title="Subtle Party Sound Cues"
                    description="Play soft acoustic glass tones when friends join, leave, or ready up (automatically quieter during playback)."
                    checked={soundEffectsEnabled}
                    onChange={(enabled) => {
                      setSoundEffectsEnabled(enabled);
                      if (enabled) {
                        playSoundCue("peerJoined", { forcePreview: true });
                      }
                    }}
                  />
                </div>
              </div>
            )}

            {tab === "updates" && (
              <div className="anim-tab-in space-y-5">
                <div className="space-y-2.5">
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
                      <span className="text-xs font-medium text-white">
                        Installed: v{updateStatus?.currentVersion ?? "0.1.0"}
                      </span>
                    </div>
                    <span className="text-[11px] text-muted">
                      {lastCheckedLabel ? `Checked at ${lastCheckedLabel}` : "Official GitHub Releases"}
                    </span>
                  </div>

                  <p className="text-xs text-secondary leading-relaxed">
                    {updateStatus?.message ?? "Check GitHub Releases for verified updates."}
                  </p>

                  {availableRelease && (
                    <div className="rounded-2xl bg-white/5 p-3.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-white">
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
                      <div className="ep-glass-well rounded-2xl p-3.5 space-y-2">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="text-secondary truncate">{updateProgress.message}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            {updateProgress.speedBps > 0 && (
                              <span className="font-mono text-muted">
                                {formatTransferSpeed(updateProgress.speedBps)}
                              </span>
                            )}
                            <span className="ep-update-pct-badge num font-mono text-xs font-semibold text-accent-soft px-2.5 py-0.5 rounded-full">
                              {Math.round(updateProgress.percent)}%
                            </span>
                          </div>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/12">
                          <div
                            className="ep-scrubber-fill h-full w-full origin-left transition-transform duration-150 ease-out"
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
                    <p className="text-[11px] text-bad bg-bad/10 rounded-xl px-3 py-2">
                      {updateError}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
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

                <div className="pt-1 space-y-0.5">
                  <ComfortSwitchRow
                    title="Automatic updates"
                    description="Automatically download and verify new updates in the background so they are ready to install in one click."
                    checked={autoDownloadUpdates}
                    onChange={setAutoDownloadUpdates}
                  />
                  <ComfortSwitchRow
                    title="Check for updates automatically"
                    description="Quietly check GitHub Releases on launch and periodically while the app is open."
                    checked={autoCheckUpdates}
                    onChange={setAutoCheckUpdates}
                  />
                </div>
              </div>
            )}

            {tab === "server" && (
              <div className="anim-tab-in space-y-4">
                <TextField
                  label="Syncplay Server Address"
                  value={endpointDraft}
                  placeholder={DEFAULT_ENDPOINT}
                  onChange={(e) => {
                    setEndpointDraft(e.target.value);
                    if (endpointError) setEndpointError(null);
                  }}
                  error={endpointError}
                  hint="Default: syncplay.pl:8999 (backup: syncplay.pl:8998)"
                />

                <TextField
                  label="Server / Room Password (Optional)"
                  type="password"
                  value={passwordDraft}
                  maxLength={128}
                  placeholder="Kept in memory for this session only"
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  hint="Never saved to disk."
                />

                <div className="flex items-center justify-between pt-1">
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
                  <Button variant="primary" size="sm" onClick={handleSaveServer}>
                    Save Connection
                  </Button>
                </div>

                <div className="pt-1">
                  <ComfortSwitchRow
                    title="Allow Shared LAN Folders (UNC / SMB)"
                    description="Permit opening movies from mapped network paths on your home Wi-Fi."
                    checked={allowNetworkShares}
                    onChange={(allow) => {
                      setStoreAllowShares(allow);
                      void setAllowNetworkShares(allow);
                    }}
                  />
                </div>
              </div>
            )}

            {tab === "logs" && (
              <div className="anim-tab-in space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted truncate">
                    {logsPath || "In-memory session log (latest 150 events)"}
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => void loadLogs()}>
                    <RefreshCw className={`h-3.5 w-3.5 ${logsLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                </div>

                <div className="ep-glass-input h-64 overflow-y-auto rounded-2xl p-3 font-mono text-[11px] space-y-1">
                  {logs.length === 0 ? (
                    <p className="text-muted p-2">No diagnostic events recorded yet.</p>
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
    </div>
  );
}
