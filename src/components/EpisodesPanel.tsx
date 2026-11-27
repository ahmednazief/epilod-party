import {
  AppCloseIcon,
  AppFolderIcon,
  AppPlusIcon,
} from "./ui/AppIcons";
import { ContextMenu, type ContextMenuEntry } from "./ui/ContextMenu";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import {
  PartyViewersIcon,
  PlayerAutoNextIcon,
  PlayerCaptionsIcon,
  PlayerFollowIcon,
  PlayerRatingStarIcon,
  PlayerWatchedCheckIcon,
} from "./ui/PlayerIcons";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildEpisodeBadgeKey,
  deriveShowTitleForRatings,
  fetchShowOfficialRatings,
  getCachedShowRatings,
  type ShowOfficialRatings,
} from "../lib/officialRatings";
import {
  buildEpisodeRatingId,
  buildRatingKey,
  computeConsensusBadge,
  getRatingTier,
  type PartyEpisodeRatingSummary,
} from "../lib/ratings";
import { playSoundCue } from "../lib/soundEffects";
import { useRatingStore } from "../store/useRatingStore";
import {
  formatDisplayMediaTitle,
  formatSeasonFolderTitle,
  matchPeerEpisodeInPlaylist,
} from "../lib/playlist";
import {
  buildEpisodeKey,
  buildSeriesKey,
  extractParentFolderPath,
} from "../lib/seriesProgress";
import { resolveEffectiveUsername } from "../lib/syncController";
import { useAppStore } from "../store/useAppStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useResumeStore } from "../store/useResumeStore";
import { useSeriesProgressStore } from "../store/useSeriesProgressStore";
import { useSyncStore } from "../store/useSyncStore";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";

interface EpisodesPanelProps {
  onSelectEpisode: (index: number) => void;
  onOpenSeasonFolder: () => void;
  onAddEpisodes: () => void;
  onClose?: () => void;
}

export const EpisodesPanel = memo(function EpisodesPanel({
  onSelectEpisode,
  onOpenSeasonFolder,
  onAddEpisodes,
  onClose,
}: EpisodesPanelProps) {
  const items = usePlaylistStore((s) => s.items);
  const currentIndex = usePlaylistStore((s) => s.currentIndex);
  const folderName = usePlaylistStore((s) => s.folderName);
  const autoPlayNext = usePlaylistStore((s) => s.autoPlayNext);
  const followPartyEpisode = usePlaylistStore((s) => s.followPartyEpisode);
  const setAutoPlayNext = usePlaylistStore((s) => s.setAutoPlayNext);
  const setFollowPartyEpisode = usePlaylistStore((s) => s.setFollowPartyEpisode);

  const paused = usePlayerStore((s) => s.paused);
  const loaded = usePlayerStore((s) => s.loaded);
  const liveProgressPct = usePlayerStore((s) =>
    s.loaded && s.durationSecs > 0
      ? Math.min(98, Math.max(4, Math.round((s.positionSecs / s.durationSecs) * 100)))
      : 0,
  );

  const roomCode = useAppStore((s) => s.roomCode);
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const trackWatchedEpisodes = useAppStore((s) => s.trackWatchedEpisodes);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);

  const seriesMap = useSeriesProgressStore((s) => s.series);
  const markWatched = useSeriesProgressStore((s) => s.markWatched);
  const markAllAboveWatched = useSeriesProgressStore((s) => s.markAllAboveWatched);
  const upsertSeries = useSeriesProgressStore((s) => s.upsertSeries);
  const resumeEntries = useResumeStore((s) => s.entries);
  const personalByMediaId = useRatingStore((s) => s.personalByMediaId);
  const partyByMediaId = useRatingStore((s) => s.partyByMediaId);

  const [breakdownPopover, setBreakdownPopover] = useState<{
    x: number;
    y: number;
    title: string;
    summary: PartyEpisodeRatingSummary;
    officialScore: number | null;
    personalScore: number | null;
  } | null>(null);
  const breakdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!breakdownPopover) return;
    const onPointerDown = (e: PointerEvent) => {
      if (breakdownRef.current && !breakdownRef.current.contains(e.target as Node)) {
        setBreakdownPopover(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBreakdownPopover(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [breakdownPopover]);

  const ratingShowTitle = useMemo(
    () => deriveShowTitleForRatings(folderName, items[0]?.fileName),
    [folderName, items],
  );
  const [officialRatings, setOfficialRatings] = useState<ShowOfficialRatings | null>(() =>
    ratingShowTitle ? getCachedShowRatings(ratingShowTitle) : null,
  );

  useEffect(() => {
    if (!ratingShowTitle) {
      setOfficialRatings(null);
      return;
    }
    const cached = getCachedShowRatings(ratingShowTitle);
    if (cached) {
      setOfficialRatings(cached);
      return;
    }
    const ac = new AbortController();
    void fetchShowOfficialRatings(ratingShowTitle, ac.signal).then((res) => {
      if (!ac.signal.aborted && res) {
        setOfficialRatings(res);
      }
    });
    return () => ac.abort();
  }, [ratingShowTitle]);

  const seriesFolderPath = items.length > 0 ? extractParentFolderPath(items[0].path) : "";
  const seriesKey = seriesFolderPath ? buildSeriesKey(seriesFolderPath) : "";
  const watchedSet = new Set(seriesKey && seriesMap[seriesKey] ? seriesMap[seriesKey].watchedKeys : []);

  const [epContextMenu, setEpContextMenu] = useState<{
    x: number;
    y: number;
    index: number;
  } | null>(null);

  const activeItemRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const prevIndexRef = useRef<number>(currentIndex);
  const [indicator, setIndicator] = useState<{ top: number; height: number; visible: boolean }>({
    top: 0,
    height: 0,
    visible: false,
  });
  const [morphing, setMorphing] = useState(false);
  const cleanFolderTitle = formatSeasonFolderTitle(folderName);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const btn = activeItemRef.current;
      if (!btn || currentIndex < 0) {
        setIndicator((prev) => ({ ...prev, visible: false }));
        return;
      }
      setIndicator({
        top: btn.offsetTop,
        height: btn.offsetHeight,
        visible: true,
      });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(track);
    return () => {
      ro?.disconnect();
    };
  }, [currentIndex, items]);

  useEffect(() => {
    if (prevIndexRef.current !== currentIndex && prevIndexRef.current >= 0 && currentIndex >= 0) {
      setMorphing(true);
      const timer = window.setTimeout(() => setMorphing(false), 210);
      prevIndexRef.current = currentIndex;
      return () => window.clearTimeout(timer);
    }
    prevIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIndex]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2.5">
      {/* Minimal Header */}
      <div className="flex items-start justify-between gap-2 shrink-0 px-0.5">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-white truncate">
            {cleanFolderTitle}
          </div>
          <div className="text-[11px] text-secondary num">
            {currentIndex >= 0 && items.length > 0
              ? `Episode ${currentIndex + 1} of ${items.length}`
              : `${items.length} ${items.length === 1 ? "Episode" : "Episodes"}`}
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close episodes list"
            title="Close episodes (Esc)"
            className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer shrink-0"
          >
            <AppCloseIcon size={14} />
          </button>
        )}
      </div>

      {/* Compact Controls */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => setAutoPlayNext(!autoPlayNext)}
          aria-pressed={autoPlayNext}
          data-active={autoPlayNext ? "true" : "false"}
          title="Automatically advance to the next episode when the current one finishes"
          className={`ep-toggle-pill ep-press h-6.5 pl-2 pr-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium cursor-pointer ${
            autoPlayNext ? "text-white" : "text-secondary hover:text-white"
          }`}
        >
          <PlayerAutoNextIcon
            active={autoPlayNext}
            size={16}
            className="shrink-0"
          />
          <span>Auto-Next</span>
        </button>

        {roomCode && (
          <button
            type="button"
            onClick={() => setFollowPartyEpisode(!followPartyEpisode)}
            aria-pressed={followPartyEpisode}
            data-active={followPartyEpisode ? "true" : "false"}
            title="Automatically follow when the Watch Party switches episodes"
            className={`ep-toggle-pill ep-press h-6.5 pl-2 pr-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium cursor-pointer ${
              followPartyEpisode ? "text-white" : "text-secondary hover:text-white"
            }`}
          >
            <PlayerFollowIcon
              active={followPartyEpisode}
              size={16}
              className="shrink-0"
            />
            <span>Follow</span>
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenSeasonFolder}
            title="Change season folder"
            aria-label="Change season folder"
            className="ep-bar-icon-btn h-6.5 w-6.5 rounded-full text-secondary hover:text-white flex items-center justify-center cursor-pointer"
          >
            <AppFolderIcon size={14} />
          </button>
          <button
            type="button"
            onClick={onAddEpisodes}
            title="Add episode files"
            aria-label="Add episode files"
            className="ep-bar-icon-btn h-6.5 w-6.5 rounded-full text-secondary hover:text-white flex items-center justify-center cursor-pointer"
          >
            <AppPlusIcon size={14} />
          </button>
        </div>
      </div>

      {/* Clean Minimal Vertical Episode List */}
      <div className="ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden -mx-2 px-2 pt-0.5 pb-3 pr-2.5">
        <div ref={trackRef} className="relative space-y-1 pb-1">
          {indicator.height > 0 && (
            <span
              aria-hidden="true"
              data-morphing={morphing ? "true" : undefined}
              className={`ep-episode-droplet pointer-events-none absolute inset-x-0 top-0 rounded-[14px] ${
                indicator.visible ? "opacity-100" : "opacity-0"
              }`}
              style={{
                height: `${indicator.height}px`,
                transform: `translateY(${indicator.top}px)${
                  morphing ? " scaleY(1.045) scaleX(0.985)" : ""
                }`,
              }}
            />
          )}
          {items.map((item, idx) => {
            const active = idx === currentIndex;
            const display = formatDisplayMediaTitle(item.fileName);
            const epTitle = display.title || item.cleanTitle;
            const epNum = String(item.episode ?? idx + 1).padStart(2, "0");
            const epKey = buildEpisodeKey(item);
            const isWatched = trackWatchedEpisodes && watchedSet.has(epKey);
            const namePrefix = `${item.fileName.trim().toLowerCase()}::`;
            const resumeMatch = Object.entries(resumeEntries).find(([k]) =>
              k.startsWith(namePrefix),
            )?.[1];
            const savedPct =
              !isWatched && resumeMatch && resumeMatch.durationSecs > 0
                ? Math.min(95, Math.max(4, Math.round((resumeMatch.positionSecs / resumeMatch.durationSecs) * 100)))
                : 0;
            const progressPct = active && liveProgressPct > 0 ? liveProgressPct : savedPct;
            const peersHere = roomCode
              ? participants.filter(
                  (p) => matchPeerEpisodeInPlaylist(p.fileName, [item]) === 0,
                )
              : [];

            return (
              <div
                key={item.path}
                ref={active ? activeItemRef : undefined}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (idx !== currentIndex) {
                    playSoundCue("episodeChanged", { moviePlaying: loaded && !paused });
                  }
                  onSelectEpisode(idx);
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (idx !== currentIndex) {
                      playSoundCue("episodeChanged", { moviePlaying: loaded && !paused });
                    }
                    onSelectEpisode(idx);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setEpContextMenu({ x: e.clientX, y: e.clientY, index: idx });
                }}
                aria-current={active ? "true" : undefined}
                data-droplet={active && indicator.visible ? "true" : undefined}
                title={`${item.cleanTitle}${item.subtitlePath ? " (Paired subtitle ready)" : ""}`}
                className={`group relative z-10 w-full rounded-[14px] px-2.5 py-2 text-left flex items-center gap-3 cursor-pointer ep-menu-row ep-press overflow-hidden ${
                  active
                    ? "ep-episode-active text-white"
                    : isWatched
                      ? "hover:bg-white/[0.055] border border-transparent text-muted opacity-65 hover:opacity-100 hover:text-white"
                      : "hover:bg-white/[0.055] border border-transparent text-secondary hover:text-white"
                }`}
              >
                {/* Crystal episode number jewel or live equalizer */}
                <div
                  className={`w-7 h-7 rounded-[10px] shrink-0 flex items-center justify-center text-[11px] num transition-colors duration-200 ${
                    active
                      ? "ep-episode-index-active font-semibold text-white"
                      : "font-semibold text-white/85 group-hover:text-white group-hover:bg-white/[0.06]"
                  }`}
                >
                  {active && loaded && !paused ? (
                    <span className="flex items-end gap-0.5 h-3" aria-hidden="true">
                      <span className="ep-eq-bar w-0.5 h-3 rounded-full bg-white/90" />
                      <span
                        className="ep-eq-bar w-0.5 h-2 rounded-full bg-white/90"
                        style={{ animationDelay: "180ms" }}
                      />
                      <span
                        className="ep-eq-bar w-0.5 h-2.5 rounded-full bg-white/90"
                        style={{ animationDelay: "340ms" }}
                      />
                    </span>
                  ) : (
                    <span>{epNum}</span>
                  )}
                </div>

                {/* Clean centered episode title + compact subtitle & rating badges */}
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div
                    className={`text-[12.5px] leading-snug truncate ${
                      active ? "text-white font-semibold" : "font-medium text-primary/90 group-hover:text-white"
                    }`}
                  >
                    {epTitle}
                  </div>

                  {(() => {
                    const badgeKey =
                      item.episodeBadge || buildEpisodeBadgeKey(item.season, item.episode);
                    const officialScore =
                      badgeKey && officialRatings?.episodes[badgeKey]
                        ? officialRatings.episodes[badgeKey]
                        : null;
                    const mediaId = buildEpisodeRatingId(item.fileName);
                    const personalScore = mediaId ? personalByMediaId[mediaId]?.score ?? null : null;
                    const partySummary = mediaId ? partyByMediaId[mediaId] ?? null : null;
                    const isSoloSelfVote =
                      Boolean(
                        partySummary &&
                          partySummary.totalVotes === 1 &&
                          partySummary.voters[0]?.username.trim().toLowerCase() ===
                            effectiveUsername.trim().toLowerCase(),
                      );
                    const hasPartyVotes = Boolean(
                      partySummary && partySummary.totalVotes > 0 && !isSoloSelfVote,
                    );
                    const hasAnyUserOrParty = personalScore !== null || hasPartyVotes;

                    const openEpisodeRating = () => {
                      const key =
                        (active && durationSecs >= 30
                          ? buildRatingKey(item.fileName, durationSecs)
                          : null) ??
                        buildRatingKey(item.fileName, 1800) ??
                        mediaId ??
                        item.fileName;
                      useRatingStore.getState().reopenForKey(key, epTitle, item.fileName, {
                        username: effectiveUsername,
                        avatarId,
                      });
                      onClose?.();
                    };

                    if (
                      !item.subtitlePath &&
                      officialScore === null &&
                      !hasAnyUserOrParty &&
                      progressPct <= 0
                    ) {
                      return null;
                    }

                    return (
                      <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-[10px] leading-none">
                        {item.subtitlePath && (
                          <span className="inline-flex items-center gap-1 text-white/50 shrink-0">
                            <PlayerCaptionsIcon size={11} />
                            <span>Sub</span>
                          </span>
                        )}
                        {item.subtitlePath && (officialScore !== null || hasAnyUserOrParty) && (
                          <span aria-hidden="true" className="text-white/25">·</span>
                        )}
                        {hasAnyUserOrParty ? (
                          <span className="inline-flex items-center gap-1.5 shrink-0">
                            <span className="inline-flex items-center rounded-full overflow-hidden border border-white/12 bg-white/[0.04]">
                              <GlassHoverTip
                                label={personalScore !== null ? "Your rating" : "Add your rating"}
                                detail={
                                  personalScore !== null
                                    ? `${personalScore} / 10 · Click to edit`
                                    : "Click to rate this episode"
                                }
                                accent="admin"
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openEpisodeRating();
                                  }}
                                  className={`px-1.5 py-0.5 inline-flex items-center gap-0.5 font-semibold num transition-colors cursor-pointer ${
                                    personalScore !== null
                                      ? "bg-accent/22 hover:bg-accent/34 text-violet-200"
                                      : "hover:bg-white/[0.08] text-white/60 hover:text-white"
                                  }`}
                                >
                                  <PlayerRatingStarIcon
                                    size={9.5}
                                    active={personalScore !== null}
                                    tone="personal"
                                  />
                                  <span>{personalScore !== null ? personalScore : "+"}</span>
                                </button>
                              </GlassHoverTip>
                              {hasPartyVotes && partySummary && (
                                <>
                                  <span aria-hidden="true" className="w-px h-3 bg-white/14" />
                                  <GlassHoverTip
                                    label="Party average"
                                    detail={`${partySummary.average.toFixed(1)} / 10 (${partySummary.totalVotes} ${
                                      partySummary.totalVotes === 1 ? "vote" : "votes"
                                    }) · Click for breakdown`}
                                    accent="host"
                                  >
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const rect = (
                                          e.currentTarget as HTMLElement
                                        ).getBoundingClientRect();
                                        const panelRect = trackRef.current
                                          ?.closest('[data-glass-region="true"]')
                                          ?.getBoundingClientRect();
                                        const popW = 248;
                                        const preferredX =
                                          panelRect && panelRect.left - popW - 10 >= 12
                                            ? panelRect.left - popW - 10
                                            : rect.left;
                                        setBreakdownPopover({
                                          x: preferredX,
                                          y: panelRect ? Math.max(panelRect.top, rect.top - 18) : rect.bottom + 6,
                                          title: epTitle,
                                          summary: partySummary,
                                          officialScore,
                                          personalScore,
                                        });
                                      }}
                                      className="bg-amber-400/14 hover:bg-amber-400/25 px-1.5 py-0.5 inline-flex items-center gap-1 text-amber-200 font-semibold num transition-colors cursor-pointer"
                                    >
                                      <PartyViewersIcon size={9.5} />
                                      <span>{partySummary.average.toFixed(1)}</span>
                                    </button>
                                  </GlassHoverTip>
                                </>
                              )}
                            </span>
                            {officialScore !== null && (
                              <GlassHoverTip
                                label="Official rating"
                                detail={`${officialScore.toFixed(1)} / 10`}
                                accent="host"
                              >
                                <span className="line-through text-white/30 decoration-white/40 num">
                                  {officialScore.toFixed(1)}
                                </span>
                              </GlassHoverTip>
                            )}
                          </span>
                        ) : officialScore !== null ? (
                          <GlassHoverTip
                            label="Official rating"
                            detail={`${officialScore.toFixed(1)} / 10 · Rate at episode end`}
                            accent="host"
                            className="inline-flex items-center shrink-0"
                          >
                            <span className="inline-flex items-center gap-0.5 text-white/55 group-hover:text-white/75 transition-colors num">
                              <PlayerRatingStarIcon size={9.5} active tone="gold" />
                              <span>{officialScore.toFixed(1)}</span>
                            </span>
                          </GlassHoverTip>
                        ) : null}
                        {progressPct > 0 &&
                          (item.subtitlePath || officialScore !== null || hasAnyUserOrParty) && (
                            <span aria-hidden="true" className="text-white/25">·</span>
                          )}
                        {progressPct > 0 && (
                          <span
                            title={`${progressPct}% watched`}
                            className="inline-flex items-center w-8 shrink-0"
                          >
                            <span
                              aria-hidden="true"
                              className="ep-episode-progress-track w-full"
                            >
                              <span
                                className="ep-episode-progress-fill block"
                                style={{ width: `${progressPct}%` }}
                              />
                            </span>
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Balanced right metadata cluster aligned cleanly on the row centerline */}
                <div className="shrink-0 flex items-center gap-1.5">
                  {peersHere.length > 0 && (
                    <span className="flex items-center -space-x-1">
                      {peersHere.slice(0, 3).map((peer) => (
                        <ProfileAvatar
                          key={peer.username}
                          avatarId={resolvePeerAvatarId(
                            peer.username,
                            effectiveUsername,
                            avatarId,
                          )}
                          size={16}
                          className="ring-1 ring-white/25"
                        />
                      ))}
                    </span>
                  )}
                  {item.episodeBadge && (
                    <span
                      className={`num ${
                        active
                          ? "ep-episode-badge-active px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide text-white/95"
                          : "px-1 text-[10.5px] font-medium text-white/45 group-hover:text-white/75"
                      }`}
                    >
                      {item.episodeBadge}
                    </span>
                  )}
                  {trackWatchedEpisodes && seriesKey && (
                    <button
                      type="button"
                      aria-label={isWatched ? "Mark unwatched" : "Mark watched"}
                      title={isWatched ? "Watched (click to unmark)" : "Mark as watched"}
                      onClick={(e) => {
                        e.stopPropagation();
                        upsertSeries({
                          folderPath: seriesFolderPath,
                          folderName: cleanFolderTitle,
                        });
                        markWatched(seriesKey, epKey, !isWatched);
                      }}
                      className={`w-5 h-5 rounded-full flex items-center justify-center transition-opacity cursor-pointer ${
                        isWatched
                          ? "opacity-100"
                          : "text-white/55 hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      }`}
                    >
                      <PlayerWatchedCheckIcon watched={isWatched} size={16} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {epContextMenu && items[epContextMenu.index] && (
        <ContextMenu
          position={{ x: epContextMenu.x, y: epContextMenu.y }}
          entries={((): ContextMenuEntry[] => {
            const targetIdx = epContextMenu.index;
            const targetItem = items[targetIdx];
            const targetKey = buildEpisodeKey(targetItem);
            const targetWatched = watchedSet.has(targetKey);
            const targetMediaId = buildEpisodeRatingId(targetItem.fileName);
            const targetPersonalScore = targetMediaId
              ? personalByMediaId[targetMediaId]?.score ?? null
              : null;
            const targetDisplayTitle =
              formatDisplayMediaTitle(targetItem.fileName).title || targetItem.cleanTitle;
            return [
              {
                id: "rate-episode",
                label: targetPersonalScore !== null ? "Edit Episode Rating…" : "Rate Episode…",
                badge: targetPersonalScore !== null ? `★ ${targetPersonalScore}` : undefined,
                icon: (
                  <PlayerRatingStarIcon
                    size={14}
                    active={targetPersonalScore !== null}
                    tone={targetPersonalScore !== null ? "personal" : "gold"}
                  />
                ),
                onSelect: () => {
                  const key =
                    (targetIdx === currentIndex && durationSecs >= 30
                      ? buildRatingKey(targetItem.fileName, durationSecs)
                      : null) ??
                    buildRatingKey(targetItem.fileName, 1800) ??
                    targetMediaId ??
                    targetItem.fileName;
                  useRatingStore.getState().reopenForKey(key, targetDisplayTitle, targetItem.fileName, {
                    username: effectiveUsername,
                    avatarId,
                  });
                  onClose?.();
                },
              },
              {
                id: "toggle-watched",
                label: targetWatched ? "Mark as unwatched" : "Mark as watched",
                icon: <PlayerWatchedCheckIcon watched={!targetWatched} size={14} />,
                onSelect: () => {
                  const key = upsertSeries({
                    folderPath: seriesFolderPath,
                    folderName: cleanFolderTitle,
                  });
                  if (key) markWatched(key, targetKey, !targetWatched);
                },
              },
              ...(targetIdx > 0
                ? [
                    {
                      id: "mark-above-watched",
                      label: "Mark all above as watched",
                      icon: <PlayerWatchedCheckIcon watched size={14} />,
                      onSelect: () => {
                        const key = upsertSeries({
                          folderPath: seriesFolderPath,
                          folderName: cleanFolderTitle,
                        });
                        if (key) {
                          const aboveKeys = items
                            .slice(0, targetIdx + 1)
                            .map((it) => buildEpisodeKey(it));
                          markAllAboveWatched(key, aboveKeys);
                        }
                      },
                    },
                  ]
                : []),
            ];
          })()}
          onClose={() => setEpContextMenu(null)}
        />
      )}

      {breakdownPopover &&
        typeof document !== "undefined" &&
        createPortal(
          (() => {
            const consensus = computeConsensusBadge(breakdownPopover.summary.voters);
            const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
            const vh = typeof window !== "undefined" ? window.innerHeight : 768;
            const popW = 248;
            const estH = Math.min(300, 110 + breakdownPopover.summary.voters.length * 32);
            const left = Math.max(12, Math.min(vw - popW - 12, breakdownPopover.x));
            const top = Math.max(12, Math.min(vh - estH - 116, breakdownPopover.y));
            return (
              <div
                ref={breakdownRef}
                role="dialog"
                aria-label="Party rating breakdown"
                style={{ left: `${left}px`, top: `${top}px`, width: `${popW}px` }}
                className="ep-glass-submenu anim-pop-in fixed z-[80] rounded-2xl p-3 space-y-2.5 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11.5px] font-semibold text-white truncate">
                      {breakdownPopover.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px]">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-full font-medium ${
                          consensus.tone === "consensus"
                            ? "bg-emerald-400/16 text-emerald-200"
                            : consensus.tone === "split"
                              ? "bg-amber-400/18 text-amber-200"
                              : "bg-white/[0.08] text-secondary"
                        }`}
                      >
                        {consensus.label}
                      </span>
                      <span className="text-amber-300 font-bold num">
                        {breakdownPopover.summary.average.toFixed(1)}/10
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBreakdownPopover(null)}
                    aria-label="Close rating breakdown"
                    className="h-5.5 w-5.5 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.08] shrink-0 cursor-pointer"
                  >
                    <AppCloseIcon size={11} />
                  </button>
                </div>

                <div className="ep-menu-scroll max-h-48 overflow-y-auto space-y-1.5 pr-0.5">
                  {breakdownPopover.summary.voters.map((voter, vIdx) => {
                    const displayName = hideParticipants
                      ? `Member ${vIdx + 1}`
                      : voter.username;
                    const resolvedAvatar = resolvePeerAvatarId(
                      hideParticipants ? `Member ${vIdx + 1}` : voter.username,
                      effectiveUsername,
                      voter.avatarId ?? avatarId,
                    );
                    const tier = getRatingTier(voter.score);
                    const barColor =
                      tier === "masterpiece"
                        ? "bg-amber-300"
                        : tier === "high"
                          ? "bg-amber-400"
                          : tier === "mid"
                            ? "bg-violet-400"
                            : "bg-rose-400";
                    return (
                      <div
                        key={`${voter.username.toLowerCase()}-${vIdx}`}
                        className="flex items-center gap-2 py-0.5"
                      >
                        <ProfileAvatar avatarId={resolvedAvatar} size={18} className="shrink-0" />
                        <span className="text-[11px] font-medium text-white/90 truncate flex-1 min-w-0">
                          {displayName}
                        </span>
                        <span className="w-12 h-1.5 rounded-full bg-white/[0.08] overflow-hidden shrink-0">
                          <span
                            className={`block h-full rounded-full ${barColor}`}
                            style={{ width: `${Math.max(10, voter.score * 10)}%` }}
                          />
                        </span>
                        <span className="w-5 text-right text-[11px] font-bold num text-white shrink-0">
                          {voter.score}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {(breakdownPopover.officialScore !== null ||
                  breakdownPopover.personalScore !== null) && (
                  <div className="pt-1.5 flex items-center justify-between text-[10.5px] text-muted num">
                    {breakdownPopover.personalScore !== null ? (
                      <span>You: ★ {breakdownPopover.personalScore}</span>
                    ) : (
                      <span />
                    )}
                    {breakdownPopover.officialScore !== null && (
                      <span>Official: {breakdownPopover.officialScore.toFixed(1)}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })(),
          document.body,
        )}
    </div>
  );
});
