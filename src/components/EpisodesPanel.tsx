import { Captions, Check, FolderOpen, ListVideo, Plus, Sparkles, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { matchPeerEpisodeInPlaylist } from "../lib/playlist";
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

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIndex]);

  return (
    <div className="flex flex-col h-full min-h-0 gap-2.5">
      {/* Drawer Header */}
      <div className="flex items-start justify-between gap-2 shrink-0">
        <div className="min-w-0 flex items-center gap-2">
          <div className="h-8 w-8 rounded-xl bg-accent/20 border border-accent-soft/30 flex items-center justify-center shrink-0">
            <ListVideo className="h-4 w-4 text-accent-soft" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white truncate">
              {folderName || "Season Queue"}
            </div>
            <div className="text-[10.5px] text-secondary num">
              {currentIndex >= 0 && items.length > 0
                ? `Episode ${currentIndex + 1} of ${items.length}`
                : `${items.length} ${items.length === 1 ? "Episode" : "Episodes"}`}
            </div>
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close episodes list"
            title="Close episodes (Esc)"
            className="ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Quick Actions & Toggles */}
      <div className="flex flex-wrap items-center gap-1.5 shrink-0 pb-1 border-b border-white/[0.08]">
        <button
          type="button"
          onClick={() => setAutoPlayNext(!autoPlayNext)}
          title="Automatically advance to the next episode when the current one finishes"
          className={`ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium cursor-pointer transition-colors ${
            autoPlayNext
              ? "ep-glass-pill-active text-white"
              : "bg-white/[0.06] text-secondary hover:text-white hover:bg-white/[0.12]"
          }`}
        >
          {autoPlayNext && <Check className="h-3 w-3 text-ok" />}
          <span>Auto-Next</span>
        </button>

        {roomCode && (
          <button
            type="button"
            onClick={() => setFollowPartyEpisode(!followPartyEpisode)}
            title="Automatically follow when the Watch Party switches episodes"
            className={`ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium cursor-pointer transition-colors ${
              followPartyEpisode
                ? "ep-glass-pill-active text-white"
                : "bg-white/[0.06] text-secondary hover:text-white hover:bg-white/[0.12]"
            }`}
          >
            <Sparkles className="h-3 w-3 text-accent-soft" />
            <span>Follow</span>
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenSeasonFolder}
            title="Change season folder"
            aria-label="Change season folder"
            className="ep-press h-6.5 w-6.5 rounded-full bg-white/[0.06] hover:bg-white/[0.14] text-secondary hover:text-white flex items-center justify-center cursor-pointer"
          >
            <FolderOpen className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onAddEpisodes}
            title="Add episode files"
            aria-label="Add episode files"
            className="ep-press h-6.5 w-6.5 rounded-full bg-white/[0.06] hover:bg-white/[0.14] text-secondary hover:text-white flex items-center justify-center cursor-pointer"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Vertical Episode List */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-1.5">
        {items.map((item, idx) => {
          const active = idx === currentIndex;
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
              className={`ep-press group relative w-full rounded-2xl px-3 py-2.5 text-left flex items-center gap-2.5 cursor-pointer transition-all ${
                active
                  ? "ep-episode-active border border-accent-soft/65 text-white"
                  : "bg-white/[0.04] hover:bg-white/[0.10] border border-white/[0.06] hover:border-white/[0.14] text-secondary hover:text-white"
              }`}
            >
              {/* Luminous vertical spine on active episode */}
              {active && (
                <span
                  aria-hidden="true"
                  className="w-1 self-stretch rounded-full bg-accent-soft shadow-[0_0_12px_rgba(167,139,250,0.9)] shrink-0"
                />
              )}

              {/* Episode number / Now-playing badge */}
              <div
                className={`h-9 min-w-[44px] px-2 rounded-xl flex items-center justify-center gap-1 shrink-0 font-mono text-[11px] font-semibold ${
                  active
                    ? "bg-accent text-white shadow-[0_0_14px_rgba(124,58,237,0.65)]"
                    : "bg-white/[0.07] text-accent-soft group-hover:bg-white/[0.12]"
                }`}
              >
                {active && loaded && !paused ? (
                  <span className="flex items-end gap-0.5 h-3 mr-0.5" aria-hidden="true">
                    <span className="ep-eq-bar w-0.5 h-3 rounded-full bg-white" />
                    <span
                      className="ep-eq-bar w-0.5 h-2 rounded-full bg-white"
                      style={{ animationDelay: "180ms" }}
                    />
                    <span
                      className="ep-eq-bar w-0.5 h-2.5 rounded-full bg-white"
                      style={{ animationDelay: "340ms" }}
                    />
                  </span>
                ) : null}
                <span>{item.episodeBadge || `#${idx + 1}`}</span>
              </div>

              {/* Clean title + status tags */}
              <div className="min-w-0 flex-1 space-y-0.5">
                <div
                  className={`text-xs font-medium leading-snug line-clamp-2 ${
                    active ? "text-white font-semibold" : "text-primary/90 group-hover:text-white"
                  }`}
                >
                  {item.cleanTitle}
                </div>

                {(active || item.subtitlePath || peersHere.length > 0) && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    {active && (
                      <span className="px-1.5 py-0.2 rounded-full bg-white/18 text-[9.5px] font-semibold tracking-wide uppercase text-white">
                        Now Playing
                      </span>
                    )}
                    {item.subtitlePath && (
                      <span
                        title="Paired external subtitle detected"
                        className={`inline-flex items-center gap-0.5 text-[10px] ${
                          active ? "text-accent-soft" : "text-muted"
                        }`}
                      >
                        <Captions className="h-3 w-3" />
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
                            size={16}
                            className="ring-1 ring-canvas/90"
                          />
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});
