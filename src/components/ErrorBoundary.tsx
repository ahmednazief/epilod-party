import { Component, type ErrorInfo, type ReactNode } from "react";
import { logFrontendEvent } from "../lib/logger";
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
        <div className="ep-amethyst-canvas relative h-full w-full flex items-center justify-center text-primary p-6">
          <div className="ep-glass-sheet max-w-md w-full rounded-[24px] p-6 space-y-3.5">
            <h2 className="text-sm font-semibold text-white">Something went wrong in the UI</h2>
            <p className="text-xs text-secondary leading-relaxed break-words">{this.state.errorMessage}</p>
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="primary"
                size="sm"
                onClick={() => this.setState({ errorMessage: null })}
              >
                Recover View
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.location.reload()}
              >
                Reload App
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
