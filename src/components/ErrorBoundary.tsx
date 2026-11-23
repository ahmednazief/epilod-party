import { getCurrentWindow } from "@tauri-apps/api/window";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isDesktop } from "../lib/bridge";
import { applyBackupEnvelope, parseAndValidateBackup } from "../lib/dataBackup";
import { logFrontendEvent } from "../lib/logger";
import { storageListSnapshots, storageReadSnapshot } from "../lib/storageBridge";
import { AppAlertIcon, AppCloseIcon, AppResetIcon, AppSparkleIcon } from "./ui/AppIcons";
import { Button } from "./ui/Button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  errorMessage: string | null;
  errorDetail: string | null;
  copied: boolean;
  restoring: boolean;
  restoreError: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    errorMessage: null,
    errorDetail: null,
    copied: false,
    restoring: false,
    restoreError: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      errorMessage: error?.message || "Unexpected interface error.",
      copied: false,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const detail = `${error?.message || "Unknown render error"}\n${info.componentStack || ""}`.trim();
    this.setState({ errorDetail: detail });
    void logFrontendEvent("error", "ui.error_boundary", detail, "ERR_UI_RENDER");
    if (isDesktop()) {
      try {
        void getCurrentWindow().show().catch(() => undefined);
      } catch {
        // Ignore outside Tauri runtime
      }
    }
  }

  private handleCopyError = (): void => {
    const text = [
      `Epilod Party UI Error (${new Date().toISOString()})`,
      this.state.errorDetail || this.state.errorMessage || "Unknown error",
    ].join("\n\n");
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(() => {
        this.setState({ copied: true });
        window.setTimeout(() => this.setState({ copied: false }), 2000);
      });
    }
  };

  private handleRestoreSnapshot = async (): Promise<void> => {
    this.setState({ restoring: true, restoreError: null });
    try {
      const snapshots = await storageListSnapshots();
      if (snapshots.length === 0) {
        this.setState({
          restoring: false,
          restoreError: "No automatic snapshots available yet.",
        });
        return;
      }
      const raw = await storageReadSnapshot(snapshots[0].fileName);
      const summary = parseAndValidateBackup(raw);
      await applyBackupEnvelope(summary.envelope, "replace");
      window.location.reload();
    } catch (err) {
      this.setState({
        restoring: false,
        restoreError: err instanceof Error ? err.message : String(err),
      });
    }
  };

  private handleCloseWindow = (): void => {
    if (!isDesktop()) return;
    try {
      void getCurrentWindow().close();
    } catch {
      // Ignore outside Tauri runtime
    }
  };

  render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <div className="ep-amethyst-canvas fixed inset-0 z-50 flex items-center justify-center text-primary p-6">
          <div
            data-tauri-drag-region
            className="absolute top-0 inset-x-0 z-20 h-11 flex items-center justify-end px-3"
          >
            <button
              type="button"
              onClick={this.handleCloseWindow}
              aria-label="Close window"
              className="ep-bar-icon-btn ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
            >
              <AppCloseIcon size={15} />
            </button>
          </div>
          <div
            aria-hidden="true"
            className="ep-ambient-orb-purple pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-80 w-96 rounded-full opacity-45"
          />
          <div className="ep-glass-sheet relative z-10 max-w-md w-full rounded-[24px] px-7 py-7 flex flex-col items-center text-center gap-4">
            <div className="ep-glass-tray h-11 w-11 rounded-full flex items-center justify-center text-warn">
              <AppAlertIcon variant="warn" size={20} />
            </div>
            <div className="space-y-1.5 text-center max-w-full">
              <h2 className="text-sm font-semibold tracking-tight text-white">
                Something went wrong in the UI
              </h2>
              <p className="text-xs text-secondary leading-relaxed break-words">
                {this.state.errorMessage}
              </p>
              {this.state.restoreError && (
                <p className="text-[11px] text-warn leading-snug break-words">
                  {this.state.restoreError}
                </p>
              )}
            </div>
            <div className="w-full pt-1 space-y-3">
              <div className="grid grid-cols-2 gap-2.5 w-full">
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => this.setState({ errorMessage: null, restoreError: null })}
                >
                  <AppSparkleIcon size={13} active />
                  <span>Recover View</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => window.location.reload()}
                >
                  <AppResetIcon clockwise size={13} />
                  <span>Reload App</span>
                </Button>
              </div>
              <div className="flex items-center justify-center gap-3 text-[11.5px] text-secondary">
                <button
                  type="button"
                  disabled={this.state.restoring}
                  onClick={() => void this.handleRestoreSnapshot()}
                  className="hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  {this.state.restoring ? "Restoring…" : "Restore Snapshot"}
                </button>
                <span aria-hidden="true" className="text-white/25">·</span>
                <button
                  type="button"
                  onClick={this.handleCopyError}
                  className="hover:text-white transition-colors cursor-pointer"
                >
                  {this.state.copied ? "Copied!" : "Copy Error"}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
