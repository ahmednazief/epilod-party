import { memo, useEffect, useMemo, useRef, useState } from "react";
import { executeSkipIntro, findActiveIntroAt } from "../lib/introActions";
import type { DetectedIntro } from "../lib/mpv";
import { resolveEffectiveUsername } from "../lib/syncController";
import { syncSendIntroSkipVote } from "../lib/syncplay";
import { usePresencePayload } from "../lib/useAnimatedPresence";
import { useAppStore } from "../store/useAppStore";
import {
  buildIntroSegmentKey,
  buildIntroVoteKey,
  getEffectiveIntroSegments,
  useIntroStore,
} from "../store/useIntroStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { PlayerSkipIntroIcon } from "./ui/PlayerIcons";

const AUTO_SKIP_DELAY_MS = 1600;

interface SkipIntroOverlayProps {
  popoverOpen: boolean;
  lockedForLocalUser: boolean;
}

interface ActiveIntroPayload {
  segment: DetectedIntro;
  segKey: string;
}

export const SkipIntroOverlay = memo(function SkipIntroOverlay({
  popoverOpen,
  lockedForLocalUser,
}: SkipIntroOverlayProps) {
  const loaded = usePlayerStore((s) => s.loaded);
  const paused = usePlayerStore((s) => s.paused);
  const posHalfSec = usePlayerStore((s) => Math.floor(s.positionSecs * 2) / 2);

  const skipIntroMode = useAppStore((s) => s.skipIntroMode);
  const fullWidthPlayBar = useAppStore((s) => s.fullWidthPlayBar);
  const roomCode = useAppStore((s) => s.roomCode);
  const username = useAppStore((s) => s.username);
  const syncStatus = useSyncStore((s) => s.status);
  const participantCount = useSyncStore((s) => s.participants.length);
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);
  const introEnabled = skipIntroMode !== "off";
  const autoSkipIntro = skipIntroMode === "auto";

  const videoKey = useIntroStore((s) => s.videoKey);
  const segments = useIntroStore((s) => s.segments);
  const manualIntro = useIntroStore((s) => s.manualIntro);
  const dismissedKeys = useIntroStore((s) => s.dismissedKeys);
  const autoSkippedKeys = useIntroStore((s) => s.autoSkippedKeys);
  const skipVotesBySegKey = useIntroStore((s) => s.skipVotesBySegKey);
  const recordSkipVote = useIntroStore((s) => s.recordSkipVote);
  const markAutoSkipped = useIntroStore((s) => s.markAutoSkipped);

  const effectiveSegments = useMemo(
    () => getEffectiveIntroSegments(segments, manualIntro),
    [segments, manualIntro],
  );

  const canVoteOnly = lockedForLocalUser && Boolean(roomCode) && syncStatus.state === "connected";

  const activeSegIndex = useMemo(() => {
    if (!loaded || !introEnabled || (lockedForLocalUser && !canVoteOnly) || popoverOpen) {
      return -1;
    }
    const found = findActiveIntroAt(posHalfSec, effectiveSegments);
    return found ? effectiveSegments.indexOf(found) : -1;
  }, [
    loaded,
    introEnabled,
    lockedForLocalUser,
    canVoteOnly,
    popoverOpen,
    posHalfSec,
    effectiveSegments,
  ]);

  const activePayload = useMemo<ActiveIntroPayload | null>(() => {
    if (activeSegIndex < 0) return null;
    const segment = effectiveSegments[activeSegIndex];
    if (!segment) return null;
    const segKey = buildIntroSegmentKey(videoKey, segment);
    if (dismissedKeys.includes(segKey)) return null;
    return { segment, segKey };
  }, [activeSegIndex, effectiveSegments, videoKey, dismissedKeys]);

  const presence = usePresencePayload(activePayload, 170);
  const current = presence.value;
  const currentRef = useRef(current);
  currentRef.current = current;
  const currentKey = current?.segKey ?? "";

  const shouldAutoSkip =
    Boolean(activePayload) &&
    !presence.exiting &&
    autoSkipIntro &&
    !canVoteOnly &&
    !paused &&
    Boolean(currentKey) &&
    !autoSkippedKeys.includes(currentKey);

  const [autoProgress, setAutoProgress] = useState(0);

  useEffect(() => {
    if (!shouldAutoSkip || !currentKey) {
      setAutoProgress(0);
      return;
    }
    const startMs = performance.now();
    let fired = false;
    const timer = window.setInterval(() => {
      const elapsed = performance.now() - startMs;
      const ratio = Math.min(1, elapsed / AUTO_SKIP_DELAY_MS);
      setAutoProgress(ratio);
      if (ratio >= 1 && !fired) {
        fired = true;
        window.clearInterval(timer);
        const target = currentRef.current;
        if (!target) return;
        markAutoSkipped(target.segKey);
        void executeSkipIntro(target.segment);
      }
    }, 45);
    return () => {
      window.clearInterval(timer);
    };
  }, [shouldAutoSkip, currentKey, markAutoSkipped]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dispatchLayout = () => window.dispatchEvent(new CustomEvent("ep:glass-layout"));
    dispatchLayout();
    const settled = window.setTimeout(dispatchLayout, 320);
    return () => window.clearTimeout(settled);
  }, [presence.mounted, presence.exiting, fullWidthPlayBar]);

  if (!presence.mounted || !current) return null;

  const { segment } = current;
  const voteKey = buildIntroVoteKey(segment);
  const voters = skipVotesBySegKey[voteKey] ?? [];
  const iVoted = voters.some(
    (u) => u.trim().toLowerCase() === effectiveUsername.trim().toLowerCase(),
  );
  const spanSecs = Math.max(1, Math.round(segment.skipTargetSecs - segment.startSecs));
  const titleText = canVoteOnly
    ? iVoted
      ? `Voted to skip (${voters.length}/${Math.max(1, participantCount)}) · Waiting for host`
      : "Vote to ask the host to skip"
    : segment.source === "audioMatch" && segment.matchedEpisodes >= 2
      ? `Matched opening across ${segment.matchedEpisodes} episodes (${spanSecs}s) · Press I to skip`
      : `Detected opening (${spanSecs}s) · Press I to skip`;

  const handleManualSkip = () => {
    if (canVoteOnly) {
      if (!iVoted) {
        recordSkipVote(voteKey, effectiveUsername);
        void syncSendIntroSkipVote(voteKey).catch(() => undefined);
      }
      return;
    }
    void executeSkipIntro(segment);
  };

  const pillLabel = canVoteOnly
    ? iVoted
      ? `Voted to Skip (${voters.length}/${Math.max(1, participantCount)})`
      : voters.length > 0
        ? `Vote to Skip (${voters.length}/${Math.max(1, participantCount)})`
        : "Vote to Skip"
    : voters.length > 0
      ? `${segment.label} · ${voters.length} asked`
      : segment.label;

  return (
    <div
      style={{
        bottom: `var(--ep-playbar-clearance, ${fullWidthPlayBar ? "124px" : "140px"})`,
      }}
      className={`absolute inset-x-0 z-40 pointer-events-none flex justify-center ${
        fullWidthPlayBar ? "px-4 sm:px-6" : "px-4"
      }`}
    >
      <div className={`w-full flex justify-end ${fullWidthPlayBar ? "" : "max-w-[1140px]"}`}>
        <button
          type="button"
          data-glass-region="true"
          onClick={handleManualSkip}
          title={titleText}
          aria-label={`${segment.label} (shortcut I)`}
          className={`ep-glass-liquid-pill relative overflow-hidden h-9.5 px-4 rounded-full inline-flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white/95 hover:text-white cursor-pointer select-none ${
            presence.exiting ? "pointer-events-none anim-pop-out" : "pointer-events-auto anim-pop-in"
          }`}
        >
          {shouldAutoSkip && (
            <span
              aria-hidden="true"
              className="ep-intro-countdown-fill absolute inset-y-0 left-0 pointer-events-none origin-left"
              style={{ width: `${Math.round(autoProgress * 100)}%` }}
            />
          )}
          <span className="relative z-[1] flex items-center gap-2">
            <PlayerSkipIntroIcon size={15} />
            <span>{pillLabel}</span>
          </span>
        </button>
      </div>
    </div>
  );
});
