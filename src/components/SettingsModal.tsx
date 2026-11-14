import { RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getLogsSnapshot, type LogEntry } from "../lib/logger";
import { setAllowNetworkShares } from "../lib/mpv";
import { DEFAULT_ENDPOINT } from "../lib/syncStatusDisplay";
import { validateServerEndpointInput } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { Button } from "./ui/Button";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { TextField } from "./ui/TextField";

type SettingsTab = "server" | "prefs" | "logs";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onApplyServerConfig?: (endpoint: string, password: string) => void;
}

export function SettingsModal({ open, onClose, onApplyServerConfig }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("server");

  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const allowNetworkShares = useAppStore((s) => s.allowNetworkShares);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);

  const setServerEndpoint = useAppStore((s) => s.setServerEndpoint);
  const setServerPassword = useAppStore((s) => s.setServerPassword);
  const setStoreAllowShares = useAppStore((s) => s.setAllowNetworkShares);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);
  const setReducedMotion = useAppStore((s) => s.setReducedMotion);
  const setLowPowerMode = useAppStore((s) => s.setLowPowerMode);
  const pushNote = useNotificationStore((s) => s.push);

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
    }
  }, [open, serverEndpoint, serverPassword]);

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
    pushNote("success", `Server updated to ${check.endpoint}.`);
    onClose();
  };

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
      <div className="anim-modal-in w-full max-w-lg bg-chrome border border-hairline rounded-[var(--radius-ui)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
          <h2 className="text-sm font-medium text-primary">Settings</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close settings">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-4 pt-3">
          <SegmentedTabs
            ariaLabel="Settings sections"
            value={tab}
            onChange={setTab}
            className="w-full"
            items={[
              { value: "server", label: "Server" },
              { value: "prefs", label: "Preferences" },
              { value: "logs", label: "Diagnostics" },
            ]}
          />
        </div>

        <div className="p-4 max-h-[68vh] overflow-y-auto">
          {tab === "server" && (
            <div className="anim-tab-in space-y-4">
              <TextField
                label="Syncplay Server Endpoint"
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
                hint="Never written to disk or localStorage."
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
                    Save Server
                  </Button>
                </div>
              </div>
            </div>
          )}

          {tab === "prefs" && (
            <div className="anim-tab-in space-y-4">
              <label className="flex items-start justify-between gap-3 p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Allow Network Shares (UNC / SMB)</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Enable loading videos or subtitles from mapped LAN paths (\\server\share\...).
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

              <label className="flex items-start justify-between gap-3 p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Privacy Mode (Hide Participants)</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Collapse viewer names in the Room panel for cleaner screen recordings.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={hideParticipants}
                  onChange={(e) => setHideParticipants(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>

              <label className="flex items-start justify-between gap-3 p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Reduced Motion</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Minimize transitions and animations throughout the interface.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={reducedMotion}
                  onChange={(e) => setReducedMotion(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>

              <label className="flex items-start justify-between gap-3 p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] cursor-pointer">
                <div>
                  <p className="text-xs font-medium text-primary">Low-Power Auto-Sync Extraction</p>
                  <p className="text-[11px] text-secondary mt-0.5">
                    Run audio extraction at Below-Normal CPU priority during long MKV subtitle syncs.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={lowPowerMode}
                  onChange={(e) => setLowPowerMode(e.target.checked)}
                  className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
                />
              </label>
            </div>
          )}

          {tab === "logs" && (
            <div className="anim-tab-in space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted truncate">
                  {logsPath || "In-memory session ring buffer (latest 150 entries)"}
                </p>
                <Button variant="secondary" size="sm" onClick={() => void loadLogs()}>
                  <RefreshCw className={`h-3.5 w-3.5 ${logsLoading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>

              <div className="h-60 overflow-y-auto bg-canvas border border-hairline rounded-[var(--radius-ui)] p-2 font-mono text-[11px] space-y-1">
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
