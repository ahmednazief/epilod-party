import { AppHeadphonesIcon, AppMicIcon } from "./AppIcons";
import { GlassHoverTip } from "./GlassHoverTip";
import { toggleVoiceDeafen, toggleVoiceMute } from "../../lib/voiceActions";

interface VoiceMicDeafenPillsProps {
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  captureHealthy?: boolean;
  size?: "sm" | "md";
}

/**
 * Individual circular liquid-glass Mic and Deafen pills shared across
 * the top-right bar, Watch Party popover, and Party Chat voice strip.
 */
export function VoiceMicDeafenPills({
  muted,
  deafened,
  speaking,
  captureHealthy = true,
  size = "md",
}: VoiceMicDeafenPillsProps) {
  const pillDim = size === "sm" ? "h-6.5 w-6.5" : "h-7 w-7";
  const iconSize = size === "sm" ? 13 : 14;

  const micTone = !captureHealthy
    ? "warn"
    : muted
      ? "bad"
      : speaking
        ? "speaking"
        : undefined;

  return (
    <>
      <GlassHoverTip
        label={
          !captureHealthy
            ? "Mic alert"
            : muted
              ? "Unmute mic"
              : speaking
                ? "Speaking"
                : "Mute mic"
        }
        detail={
          !captureHealthy
            ? "Open Voice & Audio to inspect device"
            : speaking
              ? "Click to mute"
              : undefined
        }
        accent={
          !captureHealthy
            ? "warn"
            : muted
              ? "bad"
              : speaking
                ? "speaking"
                : "default"
        }
      >
        <button
          type="button"
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          data-tone={micTone}
          onClick={() => toggleVoiceMute()}
          className={`ep-bar-pill ep-press relative ${pillDim} rounded-full flex items-center justify-center shrink-0 cursor-pointer text-white`}
        >
          <AppMicIcon muted={muted} speaking={speaking} size={iconSize} />
          {!captureHealthy && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-warn ring-2 ring-canvas/85"
            />
          )}
        </button>
      </GlassHoverTip>

      <GlassHoverTip
        label={deafened ? "Undeafen" : "Deafen"}
        detail={deafened ? "Restore mic & voice" : "Mute mic & voice"}
        accent={deafened ? "bad" : "default"}
      >
        <button
          type="button"
          aria-label={deafened ? "Undeafen" : "Deafen"}
          aria-pressed={deafened}
          data-tone={deafened ? "bad" : undefined}
          onClick={() => toggleVoiceDeafen()}
          className={`ep-bar-pill ep-press ${pillDim} rounded-full flex items-center justify-center shrink-0 cursor-pointer ${
            deafened ? "text-bad" : "text-secondary hover:text-white"
          }`}
        >
          <AppHeadphonesIcon deafened={deafened} size={iconSize} />
        </button>
      </GlassHoverTip>
    </>
  );
}
