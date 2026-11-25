import { AppHeadphonesIcon, AppMicIcon } from "./AppIcons";
import { GlassHoverTip } from "./GlassHoverTip";
import { toggleVoiceDeafen, toggleVoiceMute } from "../../lib/voiceActions";

interface VoiceMicDeafenPillsProps {
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  captureHealthy?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "pill" | "flat" | "bare";
  /** Hide the deafen pill where space is tight (e.g. play bar). */
  showDeafen?: boolean;
}

/**
 * Individual Mic and Deafen buttons shared across the play bar,
 * Watch Party popover, and Party Lounge voice dock.
 */
export function VoiceMicDeafenPills({
  muted,
  deafened,
  speaking,
  captureHealthy = true,
  size = "md",
  variant = "pill",
  showDeafen = true,
}: VoiceMicDeafenPillsProps) {
  const isFlat = variant === "flat";
  const isBare = variant === "bare";
  const pillDim = isFlat
    ? size === "sm"
      ? "h-7 w-7"
      : "h-8 w-8"
    : size === "sm"
      ? "h-6.5 w-6.5"
      : size === "lg"
        ? "h-7.5 w-7.5"
        : "h-7 w-7";
  const iconSize = isFlat
    ? size === "sm"
      ? 14
      : 16
    : size === "sm"
      ? 13
      : size === "lg"
        ? 15
        : 14;

  const micTone = !captureHealthy
    ? "warn"
    : muted
      ? "bad"
      : speaking
        ? "speaking"
        : undefined;

  const flatMicClasses = !captureHealthy
    ? "text-warn bg-warn/12 hover:bg-warn/20"
    : muted
      ? "text-bad bg-bad/12 hover:bg-bad/20"
      : "text-secondary hover:text-white hover:bg-white/[0.08]";

  const bareMicClasses = !captureHealthy
    ? "text-warn"
    : muted
      ? "text-bad"
      : speaking
        ? "text-ok"
        : "text-white/85 hover:text-white";

  const flatDeafenClasses = deafened
    ? "text-bad bg-bad/12 hover:bg-bad/20"
    : "text-secondary hover:text-white hover:bg-white/[0.08]";

  const bareDeafenClasses = deafened
    ? "text-bad"
    : "text-white/85 hover:text-white";

  return (
    <>
      <GlassHoverTip
        label={
          !captureHealthy
            ? "Mic alert"
            : muted
              ? "Unmute mic"
              : "Mute mic"
        }
        detail={!captureHealthy ? "Open Voice & Audio to inspect device" : "Shortcut: M"}
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
          data-tone={isFlat || isBare ? undefined : micTone}
          onClick={() => toggleVoiceMute()}
          className={
            isFlat
              ? `ep-press relative ${pillDim} rounded-lg flex items-center justify-center shrink-0 cursor-pointer ${flatMicClasses}`
              : isBare
                ? `ep-bar-icon-btn ep-press relative ${pillDim} rounded-full flex items-center justify-center shrink-0 cursor-pointer ${bareMicClasses}`
                : `ep-bar-pill ep-press relative ${pillDim} rounded-full flex items-center justify-center shrink-0 cursor-pointer text-white`
          }
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

      {showDeafen && (
        <GlassHoverTip
          label={deafened ? "Undeafen" : "Deafen"}
          detail={deafened ? "Restore mic & voice" : "Mute mic & voice"}
          accent={deafened ? "bad" : "default"}
        >
          <button
            type="button"
            aria-label={deafened ? "Undeafen" : "Deafen"}
            aria-pressed={deafened}
            data-tone={isFlat || isBare ? undefined : deafened ? "bad" : undefined}
            onClick={() => toggleVoiceDeafen()}
            className={
              isFlat
                ? `ep-press ${pillDim} rounded-lg flex items-center justify-center shrink-0 cursor-pointer ${flatDeafenClasses}`
                : isBare
                  ? `ep-bar-icon-btn ep-press ${pillDim} rounded-full flex items-center justify-center shrink-0 cursor-pointer ${bareDeafenClasses}`
                  : `ep-bar-pill ep-press ${pillDim} rounded-full flex items-center justify-center shrink-0 cursor-pointer ${
                      deafened ? "text-bad" : "text-secondary hover:text-white"
                    }`
            }
          >
            <AppHeadphonesIcon deafened={deafened} size={iconSize} />
          </button>
        </GlassHoverTip>
      )}
    </>
  );
}
