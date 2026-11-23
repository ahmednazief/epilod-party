import { create } from "zustand";
import {
  clearLastCleanFreezeFrame,
  type AspectMode,
  type MpvBackdropFrame,
  type MpvTrack,
} from "../lib/mpv";

export interface FeedbackBadge {
  id: number;
  text: string;
}

export interface SeekCueBadge {
  id: number;
  direction: "back" | "forward";
  deltaSecs: number;
  actor: string | null;
  step: number;
}

interface PlayerState {
  paused: boolean;
  positionSecs: number;
  durationSecs: number;
  volume: number;
  muted: boolean;
  dialogueBoost: boolean;
  speed: number;
  looping: boolean;
  aspectMode: AspectMode;
  loaded: boolean;
  engineSurfaceVisible: boolean;
  frozenFrame: MpvBackdropFrame | null;
  endedAtEof: boolean;
  isFullscreen: boolean;
  playerError: string | null;
  tracks: MpvTrack[];
  detectedSubLangs: Record<number, string>;
  feedback: FeedbackBadge | null;
  seekCue: SeekCueBadge | null;
  setPaused: (paused: boolean) => void;
  setPositionSecs: (pos: number) => void;
  setDurationSecs: (dur: number) => void;
  setVolume: (vol: number) => void;
  setMuted: (muted: boolean) => void;
  setDialogueBoost: (enabled: boolean) => void;
  setSpeed: (speed: number) => void;
  setLooping: (looping: boolean) => void;
  setAspectMode: (aspect: AspectMode) => void;
  setLoaded: (loaded: boolean) => void;
  setEngineSurfaceVisible: (visible: boolean) => void;
  setFrozenFrame: (frame: MpvBackdropFrame | null) => void;
  setEndedAtEof: (ended: boolean) => void;
  setIsFullscreen: (fs: boolean) => void;
  setPlayerError: (err: string | null) => void;
  setTracks: (tracks: MpvTrack[]) => void;
  mergeDetectedSubLangs: (entries: ReadonlyArray<{ trackId: number; lang: string }>) => void;
  flashFeedback: (text: string) => void;
  clearFeedback: () => void;
  flashSeekCue: (payload: { direction: "back" | "forward"; deltaSecs: number; actor?: string | null }) => void;
  clearSeekCue: () => void;
  resetForNewFile: () => void;
  reset: () => void;
}

let feedbackSeq = 1;
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
let seekCueSeq = 1;
let seekCueTimer: ReturnType<typeof setTimeout> | null = null;

function readDialogueBoostStorage(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("ep.dialogueBoost") === "true";
    }
  } catch {
    // Ignore storage read restrictions
  }
  return false;
}

function writeDialogueBoostStorage(enabled: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("ep.dialogueBoost", enabled ? "true" : "false");
    }
  } catch {
    // Ignore storage write restrictions
  }
}

export const usePlayerStore = create<PlayerState>((set) => ({
  paused: true,
  positionSecs: 0,
  durationSecs: 0,
  volume: 100,
  muted: false,
  dialogueBoost: readDialogueBoostStorage(),
  speed: 1.0,
  looping: false,
  aspectMode: "auto",
  loaded: false,
  engineSurfaceVisible: false,
  frozenFrame: null,
  endedAtEof: false,
  isFullscreen: false,
  playerError: null,
  tracks: [],
  detectedSubLangs: {},
  feedback: null,
  seekCue: null,

  setPaused: (paused) =>
    set((state) => ({
      paused,
      endedAtEof: paused ? state.endedAtEof : false,
    })),
  setPositionSecs: (positionSecs) => set({ positionSecs }),
  setDurationSecs: (durationSecs) => set({ durationSecs }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(130, Math.round(volume))) }),
  setMuted: (muted) => set({ muted }),
  setDialogueBoost: (dialogueBoost) => {
    writeDialogueBoostStorage(dialogueBoost);
    set({ dialogueBoost });
  },
  setSpeed: (speed) => set({ speed }),
  setLooping: (looping) => set({ looping }),
  setAspectMode: (aspectMode) => set({ aspectMode }),
  setLoaded: (loaded) => set({ loaded }),
  setEngineSurfaceVisible: (engineSurfaceVisible) => set({ engineSurfaceVisible }),
  setFrozenFrame: (frozenFrame) => set({ frozenFrame }),
  setEndedAtEof: (endedAtEof) => set({ endedAtEof }),
  setIsFullscreen: (isFullscreen) => set({ isFullscreen }),
  setPlayerError: (playerError) => set({ playerError }),
  setTracks: (tracks) => set({ tracks }),
  mergeDetectedSubLangs: (entries) =>
    set((state) => {
      if (entries.length === 0) return state;
      const next = { ...state.detectedSubLangs };
      let changed = false;
      for (const entry of entries) {
        if (entry.lang && next[entry.trackId] !== entry.lang) {
          next[entry.trackId] = entry.lang;
          changed = true;
        }
      }
      return changed ? { detectedSubLangs: next } : state;
    }),

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

  flashSeekCue: ({ direction, deltaSecs, actor = null }) => {
    if (seekCueTimer) {
      clearTimeout(seekCueTimer);
    }
    const id = seekCueSeq++;
    const normalizedActor = actor?.trim() ? actor.trim() : null;
    set((s) => {
      const sameRun =
        s.seekCue &&
        s.seekCue.direction === direction &&
        s.seekCue.actor === normalizedActor;
      const accumulated = sameRun && s.seekCue
        ? s.seekCue.deltaSecs + deltaSecs
        : deltaSecs;
      return {
        seekCue: {
          id,
          direction,
          deltaSecs: accumulated,
          actor: normalizedActor,
          step: sameRun && s.seekCue ? s.seekCue.step + 1 : 1,
        },
      };
    });
    seekCueTimer = setTimeout(() => {
      seekCueTimer = null;
      set((s) => (s.seekCue?.id === id ? { seekCue: null } : {}));
    }, 1250);
  },

  clearSeekCue: () => {
    if (seekCueTimer) {
      clearTimeout(seekCueTimer);
      seekCueTimer = null;
    }
    set({ seekCue: null });
  },

  resetForNewFile: () => {
    clearLastCleanFreezeFrame();
    if (seekCueTimer) {
      clearTimeout(seekCueTimer);
      seekCueTimer = null;
    }
    set({
      paused: true,
      positionSecs: 0,
      durationSecs: 0,
      speed: 1.0,
      looping: false,
      aspectMode: "auto",
      loaded: false,
      engineSurfaceVisible: false,
      frozenFrame: null,
      endedAtEof: false,
      playerError: null,
      tracks: [],
      detectedSubLangs: {},
      seekCue: null,
    });
  },

  reset: () => {
    clearLastCleanFreezeFrame();
    if (seekCueTimer) {
      clearTimeout(seekCueTimer);
      seekCueTimer = null;
    }
    set({
      paused: true,
      positionSecs: 0,
      durationSecs: 0,
      speed: 1.0,
      looping: false,
      aspectMode: "auto",
      loaded: false,
      engineSurfaceVisible: false,
      frozenFrame: null,
      endedAtEof: false,
      isFullscreen: false,
      playerError: null,
      tracks: [],
      detectedSubLangs: {},
      feedback: null,
      seekCue: null,
    });
  },
}));
