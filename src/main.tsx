import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logFrontendEvent } from "./lib/logger";
import "./styles/globals.css";

if (typeof window !== "undefined") {
  window.addEventListener("error", (ev) => {
    void logFrontendEvent(
      "error",
      "window.error",
      ev.message || "Unhandled window error",
      "ERR_WINDOW",
    );
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason =
      ev.reason instanceof Error ? ev.reason.message : String(ev.reason ?? "Unhandled rejection");
    void logFrontendEvent("error", "window.rejection", reason, "ERR_UNHANDLED_REJECTION");
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
