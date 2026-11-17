import { useEffect, useState } from "react";
import type { InstallMode } from "../lib/types";
import { BrandMark } from "./BrandMark";

const INSTALL_PHRASES = [
  "Unfolding the magic…",
  "Setting up everything…",
  "Warming up the theater…",
  "Polishing the glass…",
  "Tuning audio & sync…",
  "Almost showtime…",
];

const UPDATE_PHRASES = [
  "Refreshing the magic…",
  "Setting up the update…",
  "Polishing the latest bits…",
  "Tuning audio & sync…",
  "Almost back to showtime…",
];

const REPAIR_PHRASES = [
  "Checking your files…",
  "Restoring missing pieces…",
  "Polishing the glass…",
  "Almost showtime…",
];

const UNINSTALL_PHRASES = [
  "Packing things away…",
  "Tidying up your space…",
  "Almost done…",
];

function getPhrasePool(mode: InstallMode, isUninstall: boolean): string[] {
  if (isUninstall || mode === "uninstall") return UNINSTALL_PHRASES;
  if (mode === "update") return UPDATE_PHRASES;
  if (mode === "repair") return REPAIR_PHRASES;
  return INSTALL_PHRASES;
}

function getOperationFooterLabel(mode: InstallMode, isUninstall: boolean): string {
  if (isUninstall || mode === "uninstall") return "Removing Epilod Party";
  if (mode === "update") return "Updating Epilod Party";
  if (mode === "repair") return "Repairing Epilod Party";
  return "Installing Epilod Party";
}

interface ProgressViewProps {
  mode: InstallMode;
  isUninstall: boolean;
  percent: number;
  onCancel: () => void;
}

/** Focused progress screen with rotating status titles and dark greyish liquid glass progress bar. */
export function ProgressView({
  mode,
  isUninstall,
  percent,
  onCancel,
}: ProgressViewProps) {
  const pool = getPhrasePool(mode, isUninstall);
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    setStepIdx(0);
    const interval = window.setInterval(() => {
      setStepIdx((prev) => {
        const lastIdx = pool.length - 1;
        if (prev >= lastIdx) return lastIdx;
        // Loop middle phrases calmly if still running, reserving the final phrase for near-completion
        if (prev >= lastIdx - 1) return Math.min(1, lastIdx - 1);
        return prev + 1;
      });
    }, 1750);

    return () => window.clearInterval(interval);
  }, [pool]);

  const pctRounded = Math.max(0, Math.min(100, Math.round(percent)));
  const progressFraction = Math.min(1, Math.max(0, percent / 100));
  const activePhrase = pctRounded >= 88 ? pool[pool.length - 1] : pool[stepIdx] ?? pool[0];

  return (
    <div className="ep-view-enter flex w-full max-w-[320px] flex-col items-center text-center">
      <BrandMark size={50} className="ep-icon-rest mb-3.5" />

      <div className="flex h-6 items-center justify-center">
        <div
          key={activePhrase}
          className="ep-phrase-swap text-[15px] font-medium tracking-tight text-white"
        >
          {activePhrase}
        </div>
      </div>

      <div className="mt-3.5 w-full space-y-2">
        <div className="ep-scrubber-track h-1.5 w-full overflow-hidden rounded-full">
          <div
            className="ep-scrubber-fill h-full rounded-full transition-[width,opacity] duration-150 ease-out"
            style={{
              width: `${progressFraction * 100}%`,
              opacity: progressFraction > 0.002 ? 1 : 0,
            }}
          />
        </div>

        <div className="flex items-center justify-between text-[11.5px]">
          <span className="text-white/45">{getOperationFooterLabel(mode, isUninstall)}</span>
          <span className="num font-medium text-white/70">{pctRounded}%</span>
        </div>
      </div>

      {!isUninstall && (
        <button
          type="button"
          onClick={onCancel}
          className="ep-glass-pill mt-4 h-7.5 cursor-pointer rounded-full px-4 text-xs font-medium text-white/65 hover:text-white"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
