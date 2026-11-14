import { splitStatusMessage } from "../lib/installerBridge";

interface SmoothStatusTextProps {
  headline: string;
  liveStatus: string;
  isError?: boolean;
}

export function SmoothStatusText({
  headline,
  liveStatus,
  isError = false,
}: SmoothStatusTextProps) {
  const { actionText, metricSuffix } = splitStatusMessage(liveStatus);

  return (
    <div className="min-w-0 flex-1">
      <div
        key={headline}
        className="anim-text-swap text-[15px] font-medium tracking-[-0.015em] text-[#F4F4F6] truncate"
      >
        {headline}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] leading-snug min-h-[17px] overflow-hidden">
        <span
          key={actionText}
          className={`anim-text-swap truncate ${
            isError ? "text-[#F87171]" : "text-[#848498]"
          }`}
        >
          {actionText}
        </span>
        {metricSuffix && (
          <span className="mono shrink-0 text-[#A78BFA]">
            &middot; {metricSuffix}
          </span>
        )}
      </div>
    </div>
  );
}
