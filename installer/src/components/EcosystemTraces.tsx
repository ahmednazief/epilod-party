import type { TileId } from "../lib/types";

interface EcosystemTracesProps {
  activeTile: TileId | null;
  completedTiles: TileId[];
  isRunning: boolean;
  isComplete: boolean;
}

export function EcosystemTraces({
  activeTile,
  completedTiles,
  isRunning,
  isComplete,
}: EcosystemTracesProps) {
  const isLit = (tile: TileId) =>
    activeTile === tile || completedTiles.includes(tile) || isComplete;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-[740px] w-[900px]"
      viewBox="0 0 900 740"
      fill="none"
      aria-hidden="true"
    >
      {/* Subtle architectural center vertical axis */}
      <line
        x1="450"
        y1="0"
        x2="450"
        y2="740"
        stroke="#181820"
        strokeWidth="1"
        strokeDasharray="4 6"
      />

      {/* Top capsule -> installer window base traces */}
      <path d="M368 168 V192 L396 216 V236" stroke="#22222C" strokeWidth="1.25" />
      <path d="M532 168 V192 L504 216 V236" stroke="#22222C" strokeWidth="1.25" />

      {/* Top capsule active purple flow while installing or finished */}
      <path
        d="M368 168 V192 L396 216 V236"
        stroke="#8B5CF6"
        strokeWidth="1.35"
        className={`transition-opacity duration-500 ${
          isRunning || isComplete ? "opacity-55" : "opacity-0"
        } ${isRunning ? "anim-trace-flow" : ""}`}
      />
      <path
        d="M532 168 V192 L504 216 V236"
        stroke="#8B5CF6"
        strokeWidth="1.35"
        className={`transition-opacity duration-500 ${
          isRunning || isComplete ? "opacity-55" : "opacity-0"
        } ${isRunning ? "anim-trace-flow" : ""}`}
      />

      {/* Left tiles -> installer left */}
      <path d="M154 342 H178 L194 358 H212" stroke="#22222C" strokeWidth="1.25" />
      <path d="M154 470 H178 L194 454 H212" stroke="#22222C" strokeWidth="1.25" />

      <path
        d="M212 358 H194 L178 342 H154"
        stroke="#F47292"
        strokeWidth="1.35"
        className={`transition-opacity duration-300 ${
          isLit("mpv") ? "opacity-65" : "opacity-0"
        } ${activeTile === "mpv" ? "anim-trace-flow" : ""}`}
      />
      <path
        d="M212 454 H194 L178 470 H154"
        stroke="#8B5CF6"
        strokeWidth="1.35"
        className={`transition-opacity duration-300 ${
          isLit("autoSync") ? "opacity-65" : "opacity-0"
        } ${activeTile === "autoSync" ? "anim-trace-flow" : ""}`}
      />

      {/* Right tiles -> installer right */}
      <path d="M746 342 H722 L706 358 H688" stroke="#22222C" strokeWidth="1.25" />
      <path d="M746 470 H722 L706 454 H688" stroke="#22222C" strokeWidth="1.25" />

      <path
        d="M688 358 H706 L722 342 H746"
        stroke="#8B5CF6"
        strokeWidth="1.35"
        className={`transition-opacity duration-300 ${
          isLit("syncplay") ? "opacity-65" : "opacity-0"
        } ${activeTile === "syncplay" ? "anim-trace-flow" : ""}`}
      />
      <path
        d="M688 454 H706 L722 470 H746"
        stroke="#22C55E"
        strokeWidth="1.35"
        className={`transition-opacity duration-300 ${
          isLit("startTls") ? "opacity-60" : "opacity-0"
        } ${activeTile === "startTls" ? "anim-trace-flow" : ""}`}
      />

      {/* Bottom outgoing architectural traces */}
      <path d="M396 584 V642 L368 670 V740" stroke="#1D1D26" strokeWidth="1.25" />
      <path d="M504 584 V642 L532 670 V740" stroke="#1D1D26" strokeWidth="1.25" />
      <path
        d="M396 584 V642 L368 670 V740"
        stroke="#8B5CF6"
        strokeWidth="1.35"
        className={`transition-opacity duration-700 ${
          isComplete ? "opacity-45" : "opacity-0"
        }`}
      />
      <path
        d="M504 584 V642 L532 670 V740"
        stroke="#8B5CF6"
        strokeWidth="1.35"
        className={`transition-opacity duration-700 ${
          isComplete ? "opacity-45" : "opacity-0"
        }`}
      />
    </svg>
  );
}
