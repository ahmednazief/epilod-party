import { Captions, Check, FolderOpen, ListVideo, Plus, Sparkles } from "lucide-react";
import { memo } from "react";
import { matchPeerEpisodeInPlaylist } from "../lib/playlist";
import { resolveEffectiveUsername } from "../lib/syncController";
import { useAppStore } from "../store/useAppStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useSyncStore } from "../store/useSyncStore";
import { Button } from "./ui/Button";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";

interface EpisodesPanelProps {
  onSelectEpisode: (index: number) => void;
  onOpenSeasonFolder: () => void;
  onAddEpisodes: () => void;
}

export const EpisodesPanel = memo(function EpisodesPanel({
  onSelectEpisode,
  onOpenSeasonFolder,
  onAddEpisodes,
}: EpisodesPanelProps) {
  const items = usePlaylistStore((s) => s.items);
  const currentIndex = usePlaylistStore((s) => s.currentIndex);
  const folderName = usePlaylistStore((s) => s.folderName);
  const autoPlayNext = usePlaylistStore((s) => s.autoPlayNext);
  const followPartyEpisode = usePlaylistStore((s) => s.followPartyEpisode);
  const setAutoPlayNext = usePlaylistStore((s) => s.setAutoPlayNext);
  const setFollowPartyEpisode = usePlaylistStore((s) => s.setFollowPartyEpisode);

  const roomCode = useAppStore((s) => s.roomCode);
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);

  return (
    <div className="anim-tab-in space-y-2 pt-0.5">
      {/* Header strip: Season name + folder/file actions + auto-next / follow-party toggles */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ListVideo className="h-3.5 w-3.5 text-accent-soft shrink-0" />
          <span className="text-xs font-medium text-white truncate max-w-[260px]">
            {folderName || "Season & Episode Queue"}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-[10.5px] font-medium text-secondary num shrink-0">
            {items.length} {items.length === 1 ? "Episode" : "Episodes"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setAutoPlayNext(!autoPlayNext)}
            title="Automatically advance to the next episode when the current one finishes"
            className={`ep-press h-7 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium cursor-pointer transition-colors ${
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
              className={`ep-press h-7 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium cursor-pointer transition-colors ${
                followPartyEpisode
                  ? "ep-glass-pill-active text-white"
                  : "bg-white/[0.06] text-secondary hover:text-white hover:bg-white/[0.12]"
              }`}
            >
              <Sparkles className="h-3 w-3 text-accent-soft" />
              <span>Follow Party</span>
            </button>
          )}

          <Button variant="secondary" size="sm" onClick={onOpenSeasonFolder}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Season Folder</span>
          </Button>

          <Button variant="secondary" size="sm" onClick={onAddEpisodes}>
            <Plus className="h-3.5 w-3.5" />
            <span>Files</span>
          </Button>
        </div>
      </div>

      {/* Episode Grid */}
      {items.length === 0 ? (
        <div className="ep-glass-well rounded-2xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-secondary leading-relaxed">
            Drag and drop a full Season folder anywhere onto the window, or browse to queue every episode automatically.
          </p>
          <Button variant="primary" size="sm" onClick={onOpenSeasonFolder}>
            <FolderOpen className="h-3.5 w-3.5" />
            <span>Open Season Folder</span>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-36 overflow-y-auto pr-0.5">
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
                type="button"
                onClick={() => onSelectEpisode(idx)}
                title={`${item.cleanTitle}${item.subtitlePath ? " (Paired subtitle ready)" : ""}`}
                className={`ep-press rounded-2xl px-3 py-2 text-left flex flex-col justify-between gap-1.5 min-w-0 cursor-pointer transition-all ${
                  active
                    ? "ep-glass-pill-active ring-1 ring-accent/70 text-white"
                    : "ep-glass-well text-secondary hover:text-white hover:bg-white/[0.09]"
                }`}
              >
                <div className="flex items-center justify-between gap-1.5 min-w-0">
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-semibold shrink-0 ${
                      active
                        ? "bg-white/20 text-white"
                        : "bg-accent/20 text-accent-soft"
                    }`}
                  >
                    {item.episodeBadge || `#${idx + 1}`}
                  </span>

                  <div className="flex items-center gap-1 shrink-0">
                    {item.subtitlePath && (
                      <span
                        title="Paired external subtitle detected"
                        className="inline-flex items-center text-accent-soft"
                      >
                        <Captions className="h-3 w-3" />
                      </span>
                    )}
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
                            className="ring-1 ring-canvas/90"
                          />
                        ))}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-[11.5px] font-medium truncate text-white/95">
                  {item.cleanTitle}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
