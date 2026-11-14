import { create } from "zustand";
import { DEFAULT_ENDPOINT } from "../lib/syncStatusDisplay";
import {
  sanitizeCustomServerEndpoint,
  sanitizeRoomCodeInput,
  sanitizeUsername,
} from "../lib/webviewHardening";
import { usePlayerStore } from "./usePlayerStore";
import { useSubtitleStore } from "./useSubtitleStore";
import { useSyncStore } from "./useSyncStore";

function readStorage(key: string, fallback: string): string {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(key) ?? fallback;
    }
  } catch {
    // Ignore storage read restrictions
  }
  return fallback;
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage write restrictions
  }
}

function applyReducedMotionAttribute(enabled: boolean): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.reducedMotion = enabled ? "true" : "false";
  }
}

export type AppScreen = "home" | "room";

interface AppState {
  screen: AppScreen;
  username: string;
  roomCode: string;
  literalRoom: boolean;
  serverEndpoint: string;
  // Fix 05: kept strictly in RAM for the current session (never persisted to localStorage)
  serverPassword: string;
  allowNetworkShares: boolean;
  hideParticipants: boolean;
  reducedMotion: boolean;
  lowPowerMode: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  selectedFilePath: string | null;
  selectedFileName: string | null;
  setUsername: (name: string) => void;
  setRoomCode: (code: string) => void;
  setLiteralRoom: (literal: boolean) => void;
  setServerEndpoint: (endpoint: string) => void;
  setServerPassword: (password: string) => void;
  setAllowNetworkShares: (allow: boolean) => void;
  setHideParticipants: (hide: boolean) => void;
  setReducedMotion: (reduced: boolean) => void;
  setLowPowerMode: (lowPower: boolean) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  enterRoom: (code: string, literalRoom?: boolean) => void;
  leaveRoom: () => void;
  setSelectedFile: (path: string | null, name: string | null) => void;
}

const initialUsername = sanitizeUsername(readStorage("ep.username", "")) || "Viewer";
const initialServer = sanitizeCustomServerEndpoint(readStorage("ep.server", DEFAULT_ENDPOINT)) || DEFAULT_ENDPOINT;
const initialHideParticipants = readStorage("ep.hideViewers", "false") === "true";
const initialReducedMotion = readStorage("ep.reducedMotion", "false") === "true";
const initialLowPowerMode = readStorage("ep.lowPowerMode", "false") === "true";
const initialAllowShares = readStorage("ep.allowNetworkShares", "false") === "true";

applyReducedMotionAttribute(initialReducedMotion);

export const useAppStore = create<AppState>((set) => ({
  screen: "home",
  username: initialUsername,
  roomCode: "",
  literalRoom: false,
  serverEndpoint: initialServer,
  serverPassword: "",
  allowNetworkShares: initialAllowShares,
  hideParticipants: initialHideParticipants,
  reducedMotion: initialReducedMotion,
  lowPowerMode: initialLowPowerMode,
  settingsOpen: false,
  shortcutsOpen: false,
  selectedFilePath: null,
  selectedFileName: null,

  setUsername: (name) => {
    const clean = sanitizeUsername(name);
    writeStorage("ep.username", clean);
    set({ username: clean });
  },

  setRoomCode: (code) =>
    set((s) => ({
      roomCode: sanitizeRoomCodeInput(code, s.literalRoom),
    })),

  setLiteralRoom: (literalRoom) => set({ literalRoom }),

  setServerEndpoint: (endpoint) => {
    const clean = sanitizeCustomServerEndpoint(endpoint) || DEFAULT_ENDPOINT;
    writeStorage("ep.server", clean);
    set({ serverEndpoint: clean });
  },

  setServerPassword: (serverPassword) => set({ serverPassword }),

  setAllowNetworkShares: (allowNetworkShares) => {
    writeStorage("ep.allowNetworkShares", allowNetworkShares ? "true" : "false");
    set({ allowNetworkShares });
  },

  setHideParticipants: (hideParticipants) => {
    writeStorage("ep.hideViewers", hideParticipants ? "true" : "false");
    set({ hideParticipants });
  },

  setReducedMotion: (reducedMotion) => {
    writeStorage("ep.reducedMotion", reducedMotion ? "true" : "false");
    applyReducedMotionAttribute(reducedMotion);
    set({ reducedMotion });
  },

  setLowPowerMode: (lowPowerMode) => {
    writeStorage("ep.lowPowerMode", lowPowerMode ? "true" : "false");
    set({ lowPowerMode });
  },

  openSettings: () => set({ settingsOpen: true, shortcutsOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  openShortcuts: () => set({ shortcutsOpen: true, settingsOpen: false }),
  closeShortcuts: () => set({ shortcutsOpen: false }),

  enterRoom: (code, literalRoom) =>
    set((s) => {
      const lit = literalRoom ?? s.literalRoom;
      return {
        screen: "room",
        roomCode: sanitizeRoomCodeInput(code, lit),
        literalRoom: lit,
        settingsOpen: false,
        shortcutsOpen: false,
      };
    }),

  leaveRoom: () => {
    usePlayerStore.getState().reset();
    useSyncStore.getState().reset();
    useSubtitleStore.getState().clearLoadedTrack();
    set({
      screen: "home",
      roomCode: "",
      selectedFilePath: null,
      selectedFileName: null,
      settingsOpen: false,
      shortcutsOpen: false,
    });
  },

  setSelectedFile: (path, name) => {
    usePlayerStore.getState().resetForNewFile();
    useSubtitleStore.getState().clearLoadedTrack();
    set({
      selectedFilePath: path,
      selectedFileName: name,
    });
  },
}));
