import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logFrontendEvent } from "./lib/logger";
import "./styles/globals.css";

if (typeof window !== "undefined") {
  const rootEl = document.documentElement;
  rootEl.dataset.focusMode = "pointer";
  window.addEventListener(
    "pointerdown",
    () => {
      rootEl.dataset.focusMode = "pointer";
    },
    true,
  );
  window.addEventListener(
    "mousedown",
    () => {
      rootEl.dataset.focusMode = "pointer";
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (ev) => {
      if (
        ev.key === "Tab" ||
        ev.key === "ArrowUp" ||
        ev.key === "ArrowDown" ||
        ev.key === "ArrowLeft" ||
        ev.key === "ArrowRight"
      ) {
        rootEl.dataset.focusMode = "keyboard";
      }
    },
    true,
  );
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
