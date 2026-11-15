import {
  AppCheckIcon,
  AppCloseIcon,
  AppFolderIcon,
  AppPlusIcon,
  AppSparkleIcon,
} from "./ui/AppIcons";
import { PlayerCaptionsIcon } from "./ui/PlayerIcons";
import { memo, useEffect, useRef } from "react";
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
  const cleanFolderTitle = formatSeasonFolderTitle(folderName);

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
      <div className="flex items-center gap-1.5 shrink-0 pb-1.5 border-b border-white/[0.07]">
        <button
          type="button"
          onClick={() => setAutoPlayNext(!autoPlayNext)}
          title="Automatically advance to the next episode when the current one finishes"
          className={`ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1 text-[11px] font-medium cursor-pointer ${
            autoPlayNext
              ? "ep-glass-pill-active text-white"
              : "bg-white/[0.06] text-secondary hover:text-white hover:bg-white/[0.11]"
          }`}
        >
          {autoPlayNext && <AppCheckIcon size={12} className="text-ok" />}
          <span>Auto-Next</span>
        </button>

        {roomCode && (
          <button
            type="button"
            onClick={() => setFollowPartyEpisode(!followPartyEpisode)}
            title="Automatically follow when the Watch Party switches episodes"
            className={`ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1 text-[11px] font-medium cursor-pointer ${
              followPartyEpisode
                ? "ep-glass-pill-active text-white"
                : "bg-white/[0.06] text-secondary hover:text-white hover:bg-white/[0.11]"
            }`}
          >
            <AppSparkleIcon size={12} className="text-accent-soft" />
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
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-1">
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
              title={`${item.cleanTitle}${item.subtitlePath ? " (Paired subtitle ready)" : ""}`}
              className={`group relative w-full rounded-xl px-2.5 py-2 text-left flex items-center gap-2.5 cursor-pointer ep-menu-row ep-press ${
                active
                  ? "ep-episode-active text-white"
                  : "hover:bg-white/[0.06] border border-transparent text-secondary hover:text-white"
              }`}
            >
              {/* Episode number or subtle active equalizer */}
              <div
                className={`w-6 shrink-0 flex items-center justify-center text-[11px] font-semibold num ${
                  active ? "text-accent-soft" : "text-muted group-hover:text-secondary"
                }`}
              >
                {active && loaded && !paused ? (
                  <span className="flex items-end gap-0.5 h-3" aria-hidden="true">
                    <span className="ep-eq-bar w-0.5 h-3 rounded-full bg-accent-soft" />
                    <span
                      className="ep-eq-bar w-0.5 h-2 rounded-full bg-accent-soft"
                      style={{ animationDelay: "180ms" }}
                    />
                    <span
                      className="ep-eq-bar w-0.5 h-2.5 rounded-full bg-accent-soft"
                      style={{ animationDelay: "340ms" }}
                    />
                  </span>
                ) : (
                  <span>{epNum}</span>
                )}
              </div>

              {/* Clean episode title + understated meta */}
              <div className="min-w-0 flex-1">
                <div
                  className={`text-xs leading-snug truncate ${
                    active ? "text-white font-semibold" : "font-medium text-primary/90 group-hover:text-white"
                  }`}
                >
                  {epTitle}
                </div>

                {(active || item.subtitlePath || peersHere.length > 0) && (
                  <div className="flex items-center gap-2 mt-0.5">
                    {active && (
                      <span className="text-[10px] font-medium text-accent-soft">
                        Now Playing
                      </span>
                    )}
                    {item.subtitlePath && (
                      <span
                        title="Paired external subtitle detected"
                        className="inline-flex items-center gap-0.5 text-[10px] text-muted"
                      >
                        <PlayerCaptionsIcon size={12} />
                        <span>Sub</span>
                      </span>
                    )}
                    {peersHere.length > 0 && (
                      <span className="flex items-center -space-x-1 ml-auto">
                        {peersHere.slice(0, 3).map((peer) => (
                          <ProfileAvatar
                            key={peer.username}
                            avatarId={resolvePeerAvatarId(
                              peer.username,
                              effectiveUsername,
                              avatarId,
                            )}
                            size={15}
                            className="ring-1 ring-canvas/90"
                          />
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {item.episodeBadge && (
                <span className="shrink-0 text-[10.5px] font-medium text-white/55 num">
                  {item.episodeBadge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});
