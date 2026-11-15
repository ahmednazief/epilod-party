import { create } from "zustand";
import type { PlaylistItem } from "../lib/playlist";

function readBoolStorage(key: string, fallback: boolean): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      const val = localStorage.getItem(key);
      if (val === "true") return true;
      if (val === "false") return false;
    }
  } catch {
    // Ignore storage read restrictions
  }
  return fallback;
}

function writeBoolStorage(key: string, value: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value ? "true" : "false");
    }
  } catch {
    // Ignore storage write restrictions
  }
}

interface PlaylistState {
  items: PlaylistItem[];
  currentIndex: number;
  folderName: string | null;
  autoPlayNext: boolean;
  followPartyEpisode: boolean;
  setPlaylist: (items: PlaylistItem[], activeIndex?: number, folderName?: string | null) => void;
  setCurrentIndex: (index: number) => void;
  selectByPath: (path: string) => void;
  setAutoPlayNext: (enabled: boolean) => void;
  setFollowPartyEpisode: (enabled: boolean) => void;
  clearPlaylist: () => void;
}

export const usePlaylistStore = create<PlaylistState>((set) => ({
  items: [],
  currentIndex: -1,
  folderName: null,
  autoPlayNext: readBoolStorage("ep.autoPlayNext", true),
  followPartyEpisode: readBoolStorage("ep.followPartyEpisode", true),

  setPlaylist: (items, activeIndex = 0, folderName = null) =>
    set({
      items,
      currentIndex:
        items.length === 0 ? -1 : Math.max(0, Math.min(items.length - 1, activeIndex)),
      folderName,
    }),

  setCurrentIndex: (index) =>
    set((s) => ({
      currentIndex:
        s.items.length === 0 ? -1 : Math.max(0, Math.min(s.items.length - 1, index)),
    })),

  selectByPath: (path) =>
    set((s) => {
      const idx = s.items.findIndex((it) => it.path.toLowerCase() === path.toLowerCase());
      return idx !== -1 ? { currentIndex: idx } : {};
    }),

  setAutoPlayNext: (autoPlayNext) => {
    writeBoolStorage("ep.autoPlayNext", autoPlayNext);
    set({ autoPlayNext });
  },

  setFollowPartyEpisode: (followPartyEpisode) => {
    writeBoolStorage("ep.followPartyEpisode", followPartyEpisode);
    set({ followPartyEpisode });
  },

  clearPlaylist: () =>
    set({
      items: [],
      currentIndex: -1,
      folderName: null,
    }),
}));
