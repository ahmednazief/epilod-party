import { create } from "zustand";
import {
  DEFAULT_AVATAR_ID,
  isValidAvatarId,
  type AvatarId,
} from "../components/ui/ProfileAvatar";
import {
  LOCAL_DISCONNECT_TAG,
  NOT_READY_TAG_PREFIX,
  PEER_LEFT_TAG_PREFIX,
} from "../lib/syncReady";
import { DEFAULT_ENDPOINT } from "../lib/syncStatusDisplay";
import {
  sanitizeCustomServerEndpoint,
  sanitizeRoomCodeInput,
  sanitizeUsername,
} from "../lib/webviewHardening";
import { useNotificationStore } from "./useNotificationStore";
import { useIntroStore } from "./useIntroStore";
import { usePlayerStore } from "./usePlayerStore";
import { usePlaylistStore } from "./usePlaylistStore";
import { clearReactions } from "./useReactionStore";
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
export type SettingsTab =
  | "profile"
  | "appearance"
  | "playback"
  | "party"
  | "updates"
  | "server"
  | "logs";
export type SkipIntroMode = "off" | "manual" | "auto";

interface AppState {
  screen: AppScreen;
  username: string;
  avatarId: AvatarId;
  roomCode: string;
  literalRoom: boolean;
  hostOnlyRoom: boolean;
  serverEndpoint: string;
  // Fix 05: kept strictly in RAM for the current session (never persisted to localStorage)
  serverPassword: string;
  allowNetworkShares: boolean;
  hideParticipants: boolean;
  hashFilenames: boolean;
  reducedMotion: boolean;
  lowPowerMode: boolean;
  soundEffectsEnabled: boolean;
  skipIntroMode: SkipIntroMode;
  reactionsEnabled: boolean;
  recentEmojis: string[];
  fullWidthPlayBar: boolean;
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  shortcutsOpen: boolean;
  selectedFilePath: string | null;
  selectedFileName: string | null;
  setUsername: (name: string) => void;
  setAvatarId: (avatarId: AvatarId) => void;
  setRoomCode: (code: string) => void;
  setLiteralRoom: (literal: boolean) => void;
  setHostOnlyRoom: (hostOnly: boolean) => void;
  setServerEndpoint: (endpoint: string) => void;
  setServerPassword: (password: string) => void;
  setAllowNetworkShares: (allow: boolean) => void;
  setHideParticipants: (hide: boolean) => void;
  setHashFilenames: (hash: boolean) => void;
  setReducedMotion: (reduced: boolean) => void;
  setLowPowerMode: (lowPower: boolean) => void;
  setSoundEffectsEnabled: (enabled: boolean) => void;
  setSkipIntroMode: (mode: SkipIntroMode) => void;
  setReactionsEnabled: (enabled: boolean) => void;
  pushRecentEmoji: (emoji: string) => void;
  setFullWidthPlayBar: (fullWidth: boolean) => void;
  setAutoCheckUpdates: (autoCheck: boolean) => void;
  setAutoDownloadUpdates: (autoDownload: boolean) => void;
  openSettings: (tab?: SettingsTab | "prefs") => void;
  setSettingsTab: (tab: SettingsTab | "prefs") => void;
  closeSettings: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  enterRoom: (code: string, literalRoom?: boolean, hostOnlyRoom?: boolean) => void;
  leaveRoom: () => void;
  setSelectedFile: (path: string | null, name: string | null) => void;
}

const initialUsername = sanitizeUsername(readStorage("ep.username", "")) || "Viewer";
const rawAvatarId = readStorage("ep.avatarId", DEFAULT_AVATAR_ID);
const initialAvatarId: AvatarId = isValidAvatarId(rawAvatarId) ? rawAvatarId : DEFAULT_AVATAR_ID;
const initialServer = sanitizeCustomServerEndpoint(readStorage("ep.server", DEFAULT_ENDPOINT)) || DEFAULT_ENDPOINT;
const initialHideParticipants = readStorage("ep.hideViewers", "false") === "true";
const initialHashFilenames = readStorage("ep.hashFilenames", "false") === "true";
const initialReducedMotion = readStorage("ep.reducedMotion", "false") === "true";
const initialLowPowerMode = readStorage("ep.lowPowerMode", "false") === "true";
const initialAllowShares = readStorage("ep.allowNetworkShares", "false") === "true";
function readInitialSkipIntroMode(): SkipIntroMode {
  const saved = readStorage("ep.skipIntroMode", "");
  if (saved === "off" || saved === "manual" || saved === "auto") {
    return saved;
  }
  if (readStorage("ep.smartIntro", "true") === "false") {
    return "off";
  }
  if (readStorage("ep.autoSkipIntro", "false") === "true") {
    return "auto";
  }
  return "manual";
}

const initialSoundEffectsEnabled = readStorage("ep.soundEffects", "true") !== "false";
const initialSkipIntroMode = readInitialSkipIntroMode();
const initialReactionsEnabled = readStorage("ep.reactionsEnabled", "true") !== "false";
const initialRecentEmojis: string[] = (() => {
  try {
    const parsed = JSON.parse(readStorage("ep.recentEmojis", "[]"));
    if (Array.isArray(parsed)) {
      return parsed
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 24)
        .slice(0, 12);
    }
  } catch {
    // Ignore malformed stored recent emojis
  }
  return [];
})();
const initialFullWidthPlayBar = readStorage("ep.fullWidthPlayBar", "false") === "true";
const initialAutoCheckUpdates = readStorage("ep.autoCheckUpdates", "true") !== "false";
const initialAutoDownloadUpdates = readStorage("ep.autoDownloadUpdates", "true") !== "false";

applyReducedMotionAttribute(initialReducedMotion);

export const useAppStore = create<AppState>((set) => ({
  screen: "home",
  username: initialUsername,
  avatarId: initialAvatarId,
  roomCode: "",
  literalRoom: false,
  hostOnlyRoom: false,
  serverEndpoint: initialServer,
  serverPassword: "",
  allowNetworkShares: initialAllowShares,
  hideParticipants: initialHideParticipants,
  hashFilenames: initialHashFilenames,
  reducedMotion: initialReducedMotion,
  lowPowerMode: initialLowPowerMode,
  soundEffectsEnabled: initialSoundEffectsEnabled,
  skipIntroMode: initialSkipIntroMode,
  reactionsEnabled: initialReactionsEnabled,
  recentEmojis: initialRecentEmojis,
  fullWidthPlayBar: initialFullWidthPlayBar,
  autoCheckUpdates: initialAutoCheckUpdates,
  autoDownloadUpdates: initialAutoDownloadUpdates,
  settingsOpen: false,
  settingsTab: "server",
  shortcutsOpen: false,
  selectedFilePath: null,
  selectedFileName: null,

  setUsername: (name) => {
    const clean = sanitizeUsername(name);
    writeStorage("ep.username", clean);
    set({ username: clean });
  },

  setAvatarId: (avatarId) => {
    writeStorage("ep.avatarId", avatarId);
    set({ avatarId });
  },

  setRoomCode: (code) =>
    set((s) => ({
      roomCode: sanitizeRoomCodeInput(code, s.literalRoom),
    })),

  setLiteralRoom: (literalRoom) => set({ literalRoom }),

  setHostOnlyRoom: (hostOnlyRoom) => set({ hostOnlyRoom }),

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

  setHashFilenames: (hashFilenames) => {
    writeStorage("ep.hashFilenames", hashFilenames ? "true" : "false");
    set({ hashFilenames });
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

  setSoundEffectsEnabled: (soundEffectsEnabled) => {
    writeStorage("ep.soundEffects", soundEffectsEnabled ? "true" : "false");
    set({ soundEffectsEnabled });
  },
  setSkipIntroMode: (skipIntroMode) => {
    writeStorage("ep.skipIntroMode", skipIntroMode);
    set({ skipIntroMode });
  },

  setReactionsEnabled: (reactionsEnabled) => {
    writeStorage("ep.reactionsEnabled", reactionsEnabled ? "true" : "false");
    set({ reactionsEnabled });
  },

  pushRecentEmoji: (emoji) =>
    set((s) => {
      const clean = emoji.trim();
      if (!clean || clean.length > 24) return s;
      const next = [clean, ...s.recentEmojis.filter((e) => e !== clean)].slice(0, 12);
      writeStorage("ep.recentEmojis", JSON.stringify(next));
      return { recentEmojis: next };
    }),

  setFullWidthPlayBar: (fullWidthPlayBar) => {
    writeStorage("ep.fullWidthPlayBar", fullWidthPlayBar ? "true" : "false");
    set({ fullWidthPlayBar });
  },

  setAutoCheckUpdates: (autoCheckUpdates) => {
    writeStorage("ep.autoCheckUpdates", autoCheckUpdates ? "true" : "false");
    set({ autoCheckUpdates });
  },

  setAutoDownloadUpdates: (autoDownloadUpdates) => {
    writeStorage("ep.autoDownloadUpdates", autoDownloadUpdates ? "true" : "false");
    if (autoDownloadUpdates) {
      writeStorage("ep.autoCheckUpdates", "true");
      set({ autoDownloadUpdates: true, autoCheckUpdates: true });
    } else {
      set({ autoDownloadUpdates: false });
    }
  },

  openSettings: (tab) =>
    set({
      settingsOpen: true,
      shortcutsOpen: false,
      settingsTab:
        tab === "prefs"
          ? "profile"
          : typeof tab === "string"
            ? tab
            : "server",
    }),
  setSettingsTab: (tab) => set({ settingsTab: tab === "prefs" ? "profile" : tab }),
  closeSettings: () => set({ settingsOpen: false }),
  openShortcuts: () => set({ shortcutsOpen: true, settingsOpen: false }),
  closeShortcuts: () => set({ shortcutsOpen: false }),

  enterRoom: (code, literalRoom, hostOnlyRoom) =>
    set((s) => {
      const lit = literalRoom ?? s.literalRoom;
      return {
        screen: "room",
        roomCode: sanitizeRoomCodeInput(code, lit),
        literalRoom: lit,
        hostOnlyRoom: hostOnlyRoom ?? false,
        settingsOpen: false,
        shortcutsOpen: false,
      };
    }),

  leaveRoom: () => {
    clearReactions();
    usePlayerStore.getState().reset();
    useIntroStore.getState().resetForVideo(null);
    useSyncStore.getState().reset();
    const noteStore = useNotificationStore.getState();
    noteStore.dismissByTagPrefix(NOT_READY_TAG_PREFIX);
    noteStore.dismissByTagPrefix(PEER_LEFT_TAG_PREFIX);
    noteStore.dismissByTag(LOCAL_DISCONNECT_TAG);
    useSubtitleStore.getState().clearLoadedTrack();
    usePlaylistStore.getState().clearPlaylist();
    set({
      screen: "home",
      roomCode: "",
      hostOnlyRoom: false,
      selectedFilePath: null,
      selectedFileName: null,
      settingsOpen: false,
      shortcutsOpen: false,
    });
  },

  setSelectedFile: (path, name) => {
    usePlayerStore.getState().resetForNewFile();
    useIntroStore.getState().resetForVideo(path);
    useSyncStore.getState().setLocalReady(false);
    useSyncStore.getState().resetTimelineAlignment();
    useSubtitleStore.getState().clearLoadedTrack();
    set({
      selectedFilePath: path,
      selectedFileName: name,
    });
  },
}));
