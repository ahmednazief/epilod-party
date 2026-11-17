import { Component, type ErrorInfo, type ReactNode } from "react";
import { logFrontendEvent } from "../lib/logger";
import { AppAlertIcon, AppResetIcon, AppSparkleIcon } from "./ui/AppIcons";
import { Button } from "./ui/Button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  errorMessage: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { errorMessage: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { errorMessage: error?.message || "Unexpected interface error." };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const detail = `${error?.message || "Unknown render error"} ${info.componentStack || ""}`.trim();
    void logFrontendEvent("error", "ui.error_boundary", detail, "ERR_UI_RENDER");
  }

  render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <div className="ep-amethyst-canvas fixed inset-0 z-50 flex items-center justify-center text-primary p-6">
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
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <Button
                variant="primary"
                size="sm"
                onClick={() => this.setState({ errorMessage: null })}
              >
                <AppSparkleIcon size={13} active />
                <span>Recover View</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.location.reload()}
              >
                <AppResetIcon clockwise size={13} />
                <span>Reload App</span>
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
