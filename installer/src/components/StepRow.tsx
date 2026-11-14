import type { StepProgress } from "../lib/types";

interface StepRowProps {
  step: StepProgress;
}

export function StepRow({ step }: StepRowProps) {
  return (
    <div className="flex items-center gap-3.5">
      {/* Status Circle — zero outline stroke around circles */}
      <div className="flex h-6 w-6 shrink-0 items-center justify-center">
        {step.state === "done" && (
          <div className="anim-check-pop flex h-6 w-6 items-center justify-center rounded-full bg-[#22C55E] text-[#0B160E]">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" className="anim-check-stroke" />
            </svg>
          </div>
        )}

        {step.state === "active" && (
          <div className="relative flex h-6 w-6 items-center justify-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              className="anim-spin"
            >
              <circle cx="12" cy="12" r="9.5" stroke="#2D283E" strokeWidth="2.5" />
              <path
                d="M12 2.5 A9.5 9.5 0 0 1 21.5 12"
                stroke="#8B5CF6"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
            <span className="absolute h-1.5 w-1.5 rounded-full bg-[#A78BFA]" />
          </div>
        )}

        {step.state === "pending" && (
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#22222C]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#525263]" />
          </div>
        )}

        {step.state === "error" && (
          <div className="anim-check-pop flex h-6 w-6 items-center justify-center rounded-full bg-[#F87171] text-[#1A0B0B]">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </div>
        )}
      </div>

      {/* Labels */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium leading-tight text-[#EDEDF2]">
          {step.title}
        </div>
        <div
          key={step.detail}
          className="anim-text-swap mt-0.5 truncate text-[11.5px] text-[#7C7C90]"
        >
          {step.detail}
        </div>
      </div>

      {/* Right Status Readout */}
      <div
        className={`mono shrink-0 text-[11.5px] transition-colors duration-200 ${
          step.state === "active"
            ? "text-[#A78BFA]"
            : step.state === "done"
              ? "text-[#8B8BA0]"
              : step.state === "error"
                ? "text-[#F87171]"
                : "text-[#585869]"
        }`}
      >
        {step.rightLabel}
      </div>
    </div>
  );
}
