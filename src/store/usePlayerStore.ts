import { create } from "zustand";
import type { AspectMode, MpvTrack } from "../lib/mpv";

export interface FeedbackBadge {
  id: number;
  text: string;
}

interface PlayerState {
  paused: boolean;
  positionSecs: number;
  durationSecs: number;
  volume: number;
  muted: boolean;
  speed: number;
  looping: boolean;
  aspectMode: AspectMode;
  loaded: boolean;
  endedAtEof: boolean;
  isFullscreen: boolean;
  playerError: string | null;
  tracks: MpvTrack[];
  feedback: FeedbackBadge | null;
  setPaused: (paused: boolean) => void;
  setPositionSecs: (pos: number) => void;
  setDurationSecs: (dur: number) => void;
  setVolume: (vol: number) => void;
  setMuted: (muted: boolean) => void;
  setSpeed: (speed: number) => void;
  setLooping: (looping: boolean) => void;
  setAspectMode: (aspect: AspectMode) => void;
  setLoaded: (loaded: boolean) => void;
  setEndedAtEof: (ended: boolean) => void;
  setIsFullscreen: (fs: boolean) => void;
  setPlayerError: (err: string | null) => void;
  setTracks: (tracks: MpvTrack[]) => void;
  flashFeedback: (text: string) => void;
  clearFeedback: () => void;
  resetForNewFile: () => void;
  reset: () => void;
}

let feedbackSeq = 1;
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

export const usePlayerStore = create<PlayerState>((set) => ({
  paused: true,
  positionSecs: 0,
  durationSecs: 0,
  volume: 100,
  muted: false,
  speed: 1.0,
  looping: false,
  aspectMode: "auto",
  loaded: false,
  endedAtEof: false,
  isFullscreen: false,
  playerError: null,
  tracks: [],
  feedback: null,

  setPaused: (paused) =>
    set((state) => ({
      paused,
      endedAtEof: paused ? state.endedAtEof : false,
    })),
  setPositionSecs: (positionSecs) => set({ positionSecs }),
  setDurationSecs: (durationSecs) => set({ durationSecs }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(130, Math.round(volume))) }),
  setMuted: (muted) => set({ muted }),
  setSpeed: (speed) => set({ speed }),
  setLooping: (looping) => set({ looping }),
  setAspectMode: (aspectMode) => set({ aspectMode }),
  setLoaded: (loaded) => set({ loaded }),
  setEndedAtEof: (endedAtEof) => set({ endedAtEof }),
  setIsFullscreen: (isFullscreen) => set({ isFullscreen }),
  setPlayerError: (playerError) => set({ playerError }),
  setTracks: (tracks) => set({ tracks }),

  flashFeedback: (text) => {
    if (feedbackTimer) {
      clearTimeout(feedbackTimer);
    }
    const id = feedbackSeq++;
    set({ feedback: { id, text } });
    feedbackTimer = setTimeout(() => {
      feedbackTimer = null;
      set((s) => (s.feedback?.id === id ? { feedback: null } : {}));
    }, 1500);
  },

  clearFeedback: () => {
    if (feedbackTimer) {
      clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
    set({ feedback: null });
  },

  resetForNewFile: () =>
    set({
      positionSecs: 0,
      durationSecs: 0,
      speed: 1.0,
      looping: false,
      aspectMode: "auto",
      endedAtEof: false,
      playerError: null,
      tracks: [],
    }),

  reset: () =>
    set({
      paused: true,
      positionSecs: 0,
      durationSecs: 0,
      speed: 1.0,
      looping: false,
      aspectMode: "auto",
      loaded: false,
      endedAtEof: false,
      isFullscreen: false,
      playerError: null,
      tracks: [],
      feedback: null,
    }),
}));
