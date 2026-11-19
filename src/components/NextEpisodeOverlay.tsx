import { memo, useEffect, useMemo, useRef, useState } from "react";
import { findActiveIntroAt, resolveActiveOutroPrompt } from "../lib/introActions";
import { usePresencePayload } from "../lib/useAnimatedPresence";
import { useAppStore } from "../store/useAppStore";
import {
  buildIntroSegmentKey,
  getEffectiveIntroSegments,
  useIntroStore,
} from "../store/useIntroStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { AppCloseIcon } from "./ui/AppIcons";
import { PlayerSkipEpisodeIcon } from "./ui/PlayerIcons";

const AUTO_NEXT_OUTRO_DELAY_MS = 4500;

interface NextEpisodeOverlayProps {
  chromeVisible: boolean;
  popoverOpen: boolean;
  lockedForLocalUser: boolean;
  onNextEpisode: () => void;
}

interface ActiveOutroPayload {
  outroKey: string;
  nextLabel: string;
  nextBadge: string | null;
  isDetectedOutro: boolean;
}

export const NextEpisodeOverlay = memo(function NextEpisodeOverlay({
  chromeVisible,
  popoverOpen,
  lockedForLocalUser,
  onNextEpisode,
}: NextEpisodeOverlayProps) {
  const loaded = usePlayerStore((s) => s.loaded);
  const paused = usePlayerStore((s) => s.paused);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const posHalfSec = usePlayerStore((s) => Math.floor(s.positionSecs * 2) / 2);

  const skipIntroMode = useAppStore((s) => s.skipIntroMode);
  const outroNextMode = useAppStore((s) => s.outroNextMode);
  const fullWidthPlayBar = useAppStore((s) => s.fullWidthPlayBar);

  const items = usePlaylistStore((s) => s.items);
  const currentIndex = usePlaylistStore((s) => s.currentIndex);
  const nextEpisode =
    currentIndex >= 0 && currentIndex < items.length - 1 ? items[currentIndex + 1] : null;

  const videoKey = useIntroStore((s) => s.videoKey);
  const segments = useIntroStore((s) => s.segments);
  const manualIntro = useIntroStore((s) => s.manualIntro);
  const detectedOutro = useIntroStore((s) => s.outro);
  const dismissedKeys = useIntroStore((s) => s.dismissedKeys);
  const dismissedOutroKeys = useIntroStore((s) => s.dismissedOutroKeys);
  const autoAdvancedOutroKeys = useIntroStore((s) => s.autoAdvancedOutroKeys);
  const dismissOutro = useIntroStore((s) => s.dismissOutro);
  const markOutroAutoAdvanced = useIntroStore((s) => s.markOutroAutoAdvanced);

  const effectiveIntros = useMemo(
    () => getEffectiveIntroSegments(segments, manualIntro),
    [segments, manualIntro],
  );

  const introActive = useMemo(() => {
    if (!loaded || skipIntroMode === "off" || lockedForLocalUser || popoverOpen) {
      return false;
    }
    const found = findActiveIntroAt(posHalfSec, effectiveIntros);
    if (!found) return false;
    return !dismissedKeys.includes(buildIntroSegmentKey(videoKey, found));
  }, [
    loaded,
    skipIntroMode,
    lockedForLocalUser,
    popoverOpen,
    posHalfSec,
    effectiveIntros,
    dismissedKeys,
    videoKey,
  ]);

  const activePayload = useMemo<ActiveOutroPayload | null>(() => {
    if (!nextEpisode) return null;
    const prompt = resolveActiveOutroPrompt({
      loaded,
      hasNextEpisode: true,
      outroNextMode,
      lockedForLocalUser,
      popoverOpen,
      positionSecs: posHalfSec,
      durationSecs,
      videoKey,
      detectedOutro,
      introActive,
      dismissedOutroKeys,
    });
    if (!prompt) return null;
    return {
      outroKey: prompt.outroKey,
      nextLabel: nextEpisode.cleanTitle || nextEpisode.fileName,
      nextBadge: nextEpisode.episodeBadge ?? null,
      isDetectedOutro: prompt.isDetectedOutro,
    };
  }, [
    nextEpisode,
    loaded,
    outroNextMode,
    lockedForLocalUser,
    popoverOpen,
    posHalfSec,
    durationSecs,
    videoKey,
    detectedOutro,
    introActive,
    dismissedOutroKeys,
  ]);

  const presence = usePresencePayload(activePayload, 170);
  const current = presence.value;
  const currentRef = useRef(current);
  currentRef.current = current;
  const onNextRef = useRef(onNextEpisode);
  onNextRef.current = onNextEpisode;
  const currentKey = current?.outroKey ?? "";

  const shouldAutoAdvance =
    Boolean(activePayload) &&
    !presence.exiting &&
    outroNextMode === "auto" &&
    !paused &&
    Boolean(currentKey) &&
    !autoAdvancedOutroKeys.includes(currentKey);

  const [autoProgress, setAutoProgress] = useState(0);

  useEffect(() => {
    if (!shouldAutoAdvance || !currentKey) {
      setAutoProgress(0);
      return;
    }
    const startMs = performance.now();
    let fired = false;
    const timer = window.setInterval(() => {
      const elapsed = performance.now() - startMs;
      const ratio = Math.min(1, elapsed / AUTO_NEXT_OUTRO_DELAY_MS);
      setAutoProgress(ratio);
      if (ratio >= 1 && !fired) {
        fired = true;
        window.clearInterval(timer);
        const target = currentRef.current;
        if (!target) return;
        markOutroAutoAdvanced(target.outroKey);
        onNextRef.current();
      }
    }, 50);
    return () => {
      window.clearInterval(timer);
    };
  }, [shouldAutoAdvance, currentKey, markOutroAutoAdvanced]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dispatchLayout = () => window.dispatchEvent(new CustomEvent("ep:glass-layout"));
    dispatchLayout();
    const settled = window.setTimeout(dispatchLayout, 320);
    return () => window.clearTimeout(settled);
  }, [presence.mounted, presence.exiting, chromeVisible, fullWidthPlayBar]);

  if (!presence.mounted || !current) return null;

  const remainingSecs = Math.max(
    1,
    Math.ceil((AUTO_NEXT_OUTRO_DELAY_MS * (1 - autoProgress)) / 1000),
  );
  const titleText = current.isDetectedOutro
    ? `Detected ending · Up next: ${current.nextLabel}`
    : `Up next: ${current.nextLabel}`;

  const handleGoNext = () => {
    markOutroAutoAdvanced(current.outroKey);
    onNextEpisode();
  };

  const handleDismiss = () => {
    dismissOutro(current.outroKey);
  };

  return (
    <div
      style={
        chromeVisible
          ? {
              bottom: `var(--ep-playbar-clearance, ${fullWidthPlayBar ? "124px" : "140px"})`,
            }
          : undefined
      }
      className={`absolute inset-x-0 z-40 pointer-events-none flex justify-center transition-[bottom] duration-300 ease-out ${
        fullWidthPlayBar ? "px-4 sm:px-6" : "px-4"
      } ${
        chromeVisible
          ? fullWidthPlayBar
            ? "bottom-[122px] sm:bottom-[124px]"
            : "bottom-[138px] sm:bottom-[140px]"
          : "bottom-7 sm:bottom-8"
      }`}
    >
      <div className={`w-full flex justify-end ${fullWidthPlayBar ? "" : "max-w-[1140px]"}`}>
        <div
          className={`inline-flex items-center gap-1.5 ${
            presence.exiting ? "pointer-events-none anim-pop-out" : "pointer-events-auto anim-pop-in"
          }`}
        >
          <button
            type="button"
            data-glass-region="true"
            onClick={handleGoNext}
            title={titleText}
            aria-label={`Next Episode: ${current.nextLabel}`}
            className="ep-glass-liquid-pill relative overflow-hidden h-9.5 px-4 rounded-full inline-flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white/95 hover:text-white cursor-pointer select-none"
          >
            {shouldAutoAdvance && (
              <span
                aria-hidden="true"
                className="ep-intro-countdown-fill absolute inset-y-0 left-0 pointer-events-none origin-left"
                style={{ width: `${Math.round(autoProgress * 100)}%` }}
              />
            )}
            <span className="relative z-[1] flex items-center gap-2">
              <PlayerSkipEpisodeIcon direction="next" size={15} />
              <span>Next Episode</span>
              {current.nextBadge && (
                <span className="text-[11px] font-medium text-white/75 num">
                  {current.nextBadge}
                </span>
              )}
              {shouldAutoAdvance && (
                <span className="text-[11px] font-medium text-accent-soft num">
                  {remainingSecs}s
                </span>
              )}
            </span>
          </button>

          <button
            type="button"
            data-glass-region="true"
            onClick={handleDismiss}
            aria-label="Stay on current episode"
            title="Dismiss Next Episode prompt"
            className="ep-glass-liquid-pill h-9.5 w-9.5 rounded-full inline-flex items-center justify-center text-white/75 hover:text-white cursor-pointer select-none shrink-0"
          >
            <AppCloseIcon size={13} />
          </button>
        </div>
      </div>
    </div>
  );
});
