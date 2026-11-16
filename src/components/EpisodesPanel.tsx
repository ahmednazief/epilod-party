import {
  AppCloseIcon,
  AppFolderIcon,
  AppPlusIcon,
} from "./ui/AppIcons";
import {
  PlayerAutoNextIcon,
  PlayerCaptionsIcon,
  PlayerFollowIcon,
} from "./ui/PlayerIcons";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  formatDisplayMediaTitle,
  formatSeasonFolderTitle,
  matchPeerEpisodeInPlaylist,
} from "../lib/playlist";
import { resolveEffectiveUsername } from "../lib/syncController";
import { useAppStore } from "../store/useAppStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
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

  const roomCode = useAppStore((s) => s.roomCode);
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);

  const activeItemRef = useRef<HTMLButtonElement | null>(null);
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
      <div className="ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-1">
        <div ref={trackRef} className="relative space-y-1 pb-0.5">
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
            const peersHere = roomCode
              ? participants.filter(
                  (p) => matchPeerEpisodeInPlaylist(p.fileName, [item]) === 0,
                )
              : [];

            return (
              <button
                key={item.path}
                ref={active ? activeItemRef : undefined}
                type="button"
                onClick={() => onSelectEpisode(idx)}
                aria-current={active ? "true" : undefined}
                data-droplet={active && indicator.visible ? "true" : undefined}
                title={`${item.cleanTitle}${item.subtitlePath ? " (Paired subtitle ready)" : ""}`}
                className={`group relative z-10 w-full rounded-[14px] px-2.5 py-2 text-left flex items-center gap-2.5 cursor-pointer ep-menu-row ep-press ${
                  active
                    ? "ep-episode-active text-white"
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

                {/* Clean centered episode title + compact subtitle badge when present */}
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-[12.5px] leading-snug truncate ${
                      active ? "text-white font-semibold" : "font-medium text-primary/90 group-hover:text-white"
                    }`}
                  >
                    {epTitle}
                  </div>

                  {item.subtitlePath && (
                    <div className="flex items-center gap-1 mt-0.5 text-[10px] text-white/55">
                      <PlayerCaptionsIcon size={11} />
                      <span>Sub</span>
                    </div>
                  )}
                </div>

                {/* Balanced right metadata cluster aligned cleanly on the row centerline */}
                {(peersHere.length > 0 || item.episodeBadge) && (
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
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
