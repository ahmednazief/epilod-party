import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppCloseIcon } from "./ui/AppIcons";
import { PlayerRatingStarIcon } from "./ui/PlayerIcons";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import {
  buildRatingKey,
  computeRatingSummary,
  syncSendRatingVote,
} from "../lib/ratings";
import { resolveEffectiveUsername } from "../lib/syncController";
import { playSoundCue } from "../lib/soundEffects";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { useAppStore } from "../store/useAppStore";
import { useIntroStore } from "../store/useIntroStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useRatingStore } from "../store/useRatingStore";
import { useSyncStore } from "../store/useSyncStore";

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export const RatingOverlay = memo(function RatingOverlay({
  popoverOpen = false,
}: {
  popoverOpen?: boolean;
}) {
  const enabled = useAppStore((s) => s.outroRatingEnabled);
  const selectedFileName = useAppStore((s) => s.selectedFileName);
  const localUsernameRaw = useAppStore((s) => s.username);
  const localAvatarId = useAppStore((s) => s.avatarId);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const miniMode = useAppStore((s) => s.miniMode);

  const loaded = usePlayerStore((s) => s.loaded);
  const positionSecs = usePlayerStore((s) => s.positionSecs);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const endedAtEof = usePlayerStore((s) => s.endedAtEof);

  const detectedOutro = useIntroStore((s) => s.outro);
  const syncStatus = useSyncStore((s) => s.status);
  const participantCount = useSyncStore((s) => s.participants.length);

  const open = useRatingStore((s) => s.open);
  const activeKey = useRatingStore((s) => s.activeKey);
  const votesByKey = useRatingStore((s) => s.votesByKey);
  const myScoreByKey = useRatingStore((s) => s.myScoreByKey);
  const openForKey = useRatingStore((s) => s.openForKey);
  const close = useRatingStore((s) => s.close);
  const castLocalVote = useRatingStore((s) => s.castLocalVote);

  const effectiveUsername = useMemo(
    () => resolveEffectiveUsername(syncStatus, localUsernameRaw),
    [localUsernameRaw, syncStatus],
  );

  const currentKey = useMemo(
    () => buildRatingKey(selectedFileName, durationSecs),
    [durationSecs, selectedFileName],
  );

  const inOutroWindow = useMemo(() => {
    if (!enabled || !loaded || !currentKey || durationSecs < 60) return false;
    if (endedAtEof) return true;
    if (detectedOutro && positionSecs >= Math.max(0, detectedOutro.startSecs - 12)) {
      return true;
    }
    return durationSecs - positionSecs <= 35;
  }, [currentKey, detectedOutro, durationSecs, enabled, endedAtEof, loaded, positionSecs]);

  useEffect(() => {
    if (inOutroWindow && currentKey) {
      const displayTitle = (selectedFileName ?? "Current video").replace(/\.[^.]+$/, "");
      openForKey(currentKey, displayTitle);
    }
  }, [currentKey, inOutroWindow, openForKey, selectedFileName]);

  const votes = useMemo(
    () => (activeKey ? votesByKey[activeKey] ?? {} : {}),
    [activeKey, votesByKey],
  );
  const myScore = activeKey ? myScoreByKey[activeKey] ?? null : null;
  const summary = useMemo(() => computeRatingSummary(votes), [votes]);

  useEffect(() => {
    if (!open || !activeKey) return;
    if (currentKey && currentKey !== activeKey) {
      close(false);
      return;
    }
    // If the user seeks back out of the outro before voting, hide without permanently dismissing.
    if (!inOutroWindow && myScore === null) {
      close(false);
    }
  }, [activeKey, close, currentKey, inOutroWindow, myScore, open]);

  const submitScore = (score: number) => {
    if (!activeKey) return;
    castLocalVote(activeKey, effectiveUsername, localAvatarId, score, selectedFileName);
    if (syncStatus.state === "connected") {
      void syncSendRatingVote(activeKey, score, localAvatarId).catch(() => undefined);
    }
  };

  const modalOrMiniBlocked = popoverOpen || settingsOpen || shortcutsOpen || miniMode;

  useEffect(() => {
    if (!open || !activeKey || modalOrMiniBlocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        submitScore(Number(e.key));
      } else if (e.key === "0") {
        submitScore(10);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Sliding iOS 27 liquid-glass droplet state for 1..10
  const trayRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const prevScoreRef = useRef<number | null>(myScore);
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });
  const [morphing, setMorphing] = useState(false);

  // Re-broadcast local vote once when new peers join/reconnect while the rating bar is open.
  const prevPeerCountRef = useRef(participantCount);
  useEffect(() => {
    const prev = prevPeerCountRef.current;
    prevPeerCountRef.current = participantCount;
    if (
      participantCount > prev &&
      open &&
      activeKey &&
      myScore !== null &&
      syncStatus.state === "connected"
    ) {
      void syncSendRatingVote(activeKey, myScore, localAvatarId).catch(() => undefined);
    }
  }, [activeKey, localAvatarId, myScore, open, participantCount, syncStatus.state]);

  const visible = open && Boolean(activeKey) && !modalOrMiniBlocked;
  const presence = useAnimatedPresence(visible, 220);

  useLayoutEffect(() => {
    if (!presence.mounted || myScore === null) {
      setIndicator({ left: 0, width: 0 });
      return;
    }
    const btn = btnRefs.current[myScore];
    if (!btn) {
      setIndicator({ left: 0, width: 0 });
      return;
    }
    setIndicator({ left: btn.offsetLeft, width: btn.offsetWidth });
  }, [myScore, presence.mounted]);

  useEffect(() => {
    if (prevScoreRef.current !== null && myScore !== null && prevScoreRef.current !== myScore) {
      setMorphing(true);
      const timer = window.setTimeout(() => setMorphing(false), 185);
      prevScoreRef.current = myScore;
      return () => window.clearTimeout(timer);
    }
    prevScoreRef.current = myScore;
  }, [myScore]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("ep:glass-layout"));
  }, [presence.mounted, presence.exiting, summary.totalVotes]);

  if (!presence.mounted || !activeKey) return null;

  return (
    <div className="absolute top-14 inset-x-0 z-40 pointer-events-none flex flex-col items-center gap-1.5 px-4">
      <div
        data-glass-region="true"
        className={`pointer-events-auto ep-glass-rating-bar rounded-2xl px-2 py-1.5 flex items-center gap-2 ${
          presence.exiting ? "anim-pop-out" : "anim-pop-in"
        }`}
      >
        {/* Clear room average readout */}
        <div
          className="pl-1 pr-0.5 flex items-center gap-1.5 shrink-0"
          title={
            summary.totalVotes > 0
              ? `Room average: ${summary.average.toFixed(1)}/10 (${summary.totalVotes} vote${
                  summary.totalVotes === 1 ? "" : "s"
                })`
              : "Rate this watch"
          }
        >
          <PlayerRatingStarIcon
            size={16}
            active={summary.totalVotes > 0}
            tone={myScore !== null ? "personal" : "gold"}
            className={
              myScore !== null
                ? "drop-shadow-[0_0_8px_rgba(167,139,250,0.78)]"
                : summary.totalVotes > 0
                  ? "drop-shadow-[0_0_8px_rgba(251,191,36,0.72)]"
                  : ""
            }
          />
          {summary.totalVotes > 0 ? (
            <span className="text-[14px] font-bold num text-white tracking-tight leading-none">
              {summary.average.toFixed(1)}
            </span>
          ) : (
            <span className="text-[11.5px] font-semibold text-white/85">Rate</span>
          )}
        </div>

        <span aria-hidden="true" className="h-4 w-px bg-white/18 shrink-0" />

        {/* Rounded-square glass tiles with morphing liquid-glass droplet */}
        <div
          ref={trayRef}
          className="relative inline-flex items-center gap-1"
        >
          {indicator.width > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 bottom-0 left-0 transition-[transform,width] duration-[420ms] ease-[cubic-bezier(0.22,1.30,0.36,1)]"
              style={{
                width: `${indicator.width}px`,
                transform: `translateX(${indicator.left}px)`,
              }}
            >
              <span
                data-morphing={morphing ? "true" : undefined}
                className="ep-droplet-indicator ep-droplet-core block h-full w-full rounded-[10px]"
              />
            </span>
          )}
          {SCORES.map((n) => {
            const active = myScore === n;
            const isMajority = summary.totalVotes > 1 && summary.majorityScore === n;
            return (
              <button
                key={n}
                ref={(el) => {
                  btnRefs.current[n] = el;
                }}
                type="button"
                onClick={() => {
                  const player = usePlayerStore.getState();
                  playSoundCue("ratingSubmitted", {
                    moviePlaying: player.loaded && !player.paused,
                  });
                  submitScore(n);
                }}
                className={`ep-press relative z-10 w-7 h-7 rounded-[10px] text-[11.5px] num flex items-center justify-center transition-[transform,color,background-color,border-color] duration-200 ease-[var(--spring-fluid)] hover:scale-108 cursor-pointer ${
                  active
                    ? "text-white font-bold border border-transparent"
                    : isMajority
                      ? "ep-glass-rating-tile text-amber-300 font-semibold hover:text-white"
                      : "ep-glass-rating-tile text-white/80 font-medium hover:text-white"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => close(true)}
          aria-label="Close rating"
          className="w-6.5 h-6.5 rounded-[10px] border border-transparent hover:bg-white/15 hover:border-white/25 hover:shadow-[inset_0_1px_0.5px_rgba(255,255,255,0.4)] flex items-center justify-center text-white/60 hover:text-white transition-[background-color,border-color,color,box-shadow] duration-150 cursor-pointer shrink-0"
        >
          <AppCloseIcon size={11} />
        </button>
      </div>

      {/* Bouncing named voter pills */}
      {summary.voters.length > 0 && (
        <div
          className={`pointer-events-auto flex flex-wrap items-center justify-center gap-1 ${
            presence.exiting ? "anim-pop-out" : ""
          }`}
        >
          {summary.voters.map((v) => {
            const resolvedAvatar = resolvePeerAvatarId(v.avatarId ?? "", v.username);
            return (
              <span
                key={`${v.username.toLowerCase()}-${v.score}`}
                className="ep-voter-pop ep-glass-pill inline-flex items-center gap-1 pl-1 pr-2 py-0.5 rounded-full text-[10.5px] text-white/95"
              >
                <ProfileAvatar avatarId={resolvedAvatar} size={13} />
                <span className="max-w-[76px] truncate font-medium">{v.username}</span>
                <span className="font-bold num text-amber-300">{v.score}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
});
