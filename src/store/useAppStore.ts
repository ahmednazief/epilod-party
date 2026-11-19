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
import { clearPartyChat } from "./useChatStore";
import { useSubtitleStore } from "./useSubtitleStore";
import { useSyncStore } from "./useSyncStore";
import { useVoiceStore } from "./useVoiceStore";

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

export const DEFAULT_PLAY_BAR_OPACITY = 60;

export function clampPlayBarOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PLAY_BAR_OPACITY;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function interpolatePlayBarAlpha(opacity: number, atZero: number, atDefault: number, atSolid: number): string {
  const clamped = clampPlayBarOpacity(opacity);
  const val =
    clamped <= DEFAULT_PLAY_BAR_OPACITY
      ? atZero + (atDefault - atZero) * (clamped / DEFAULT_PLAY_BAR_OPACITY)
      : atDefault + (atSolid - atDefault) * ((clamped - DEFAULT_PLAY_BAR_OPACITY) / (100 - DEFAULT_PLAY_BAR_OPACITY));
  return val.toFixed(3);
}

export function computePlayBarCssVars(opacity: number): Record<string, string> {
  return {
    "--ep-playbar-capsule-bg": interpolatePlayBarAlpha(opacity, 0.04, 0.58, 0.98),
    "--ep-playbar-capsule-top": interpolatePlayBarAlpha(opacity, 0.03, 0.16, 0.24),
    "--ep-playbar-capsule-mid": interpolatePlayBarAlpha(opacity, 0.04, 0.24, 0.36),
    "--ep-playbar-capsule-bot": interpolatePlayBarAlpha(opacity, 0.06, 0.34, 0.52),
    "--ep-playbar-bar-bg": interpolatePlayBarAlpha(opacity, 0.05, 0.64, 0.98),
    "--ep-playbar-bar-top": interpolatePlayBarAlpha(opacity, 0.03, 0.18, 0.26),
    "--ep-playbar-bar-bot": interpolatePlayBarAlpha(opacity, 0.06, 0.38, 0.54),
  };
}

function applyPlayBarOpacityVariables(opacity: number): void {
  if (typeof document === "undefined") return;
  const rootStyle = document.documentElement.style;
  for (const [key, val] of Object.entries(computePlayBarCssVars(opacity))) {
    rootStyle.setProperty(key, val);
  }
}

export type AppScreen = "home" | "room";
export type SettingsTab =
  | "profile"
  | "appearance"
  | "playback"
  | "party"
  | "voice"
  | "updates"
  | "server"
  | "logs";
export type SkipIntroMode = "off" | "manual" | "auto";
export type AutoFetchSubtitleMode = "missing" | "language" | "off";
export type ChatTriggerPlacement = "playbar" | "edge";

interface AppState {
  screen: AppScreen;
  username: string;
  avatarId: AvatarId;
  roomCode: string;
  literalRoom: boolean;
  hostOnlyRoom: boolean;
  creatingRoom: boolean;
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
  autoFetchSubtitles: AutoFetchSubtitleMode;
  preferredSubtitleLangs: string;
  openSubtitlesApiKey: string;
  reactionsEnabled: boolean;
  chatPeeksEnabled: boolean;
  chatTriggerPlacement: ChatTriggerPlacement;
  recentEmojis: string[];
  fullWidthPlayBar: boolean;
  playBarOpacity: number;
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
  setCreatingRoom: (creating: boolean) => void;
  applyRerolledRoomCode: (code: string) => void;
  setServerEndpoint: (endpoint: string) => void;
  setServerPassword: (password: string) => void;
  setAllowNetworkShares: (allow: boolean) => void;
  setHideParticipants: (hide: boolean) => void;
  setHashFilenames: (hash: boolean) => void;
  setReducedMotion: (reduced: boolean) => void;
  setLowPowerMode: (lowPower: boolean) => void;
  setSoundEffectsEnabled: (enabled: boolean) => void;
  setSkipIntroMode: (mode: SkipIntroMode) => void;
  setAutoFetchSubtitles: (mode: AutoFetchSubtitleMode) => void;
  setPreferredSubtitleLangs: (langs: string) => void;
  setOpenSubtitlesApiKey: (apiKey: string) => void;
  setReactionsEnabled: (enabled: boolean) => void;
  setChatPeeksEnabled: (enabled: boolean) => void;
  setChatTriggerPlacement: (placement: ChatTriggerPlacement) => void;
  pushRecentEmoji: (emoji: string) => void;
  setFullWidthPlayBar: (fullWidth: boolean) => void;
  setPlayBarOpacity: (opacity: number) => void;
  setAutoCheckUpdates: (autoCheck: boolean) => void;
  setAutoDownloadUpdates: (autoDownload: boolean) => void;
  openSettings: (tab?: SettingsTab | "prefs") => void;
  setSettingsTab: (tab: SettingsTab | "prefs") => void;
  closeSettings: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  enterRoom: (
    code: string,
    literalRoom?: boolean,
    hostOnlyRoom?: boolean,
    creatingRoom?: boolean,
  ) => void;
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
const initialAutoFetchSubtitles: AutoFetchSubtitleMode = (() => {
  const saved = readStorage("ep.autoFetchSubs", "missing");
  if (saved === "missing" || saved === "language" || saved === "off") return saved;
  return "missing";
})();
const initialPreferredSubtitleLangs = readStorage("ep.preferredSubLangs", "eng") || "eng";
const initialOpenSubtitlesApiKey = readStorage("ep.osApiKey", "");
const initialReactionsEnabled = readStorage("ep.reactionsEnabled", "true") !== "false";
const initialChatPeeksEnabled = readStorage("ep.chatPeeksEnabled", "true") !== "false";
const initialChatTriggerPlacement: ChatTriggerPlacement =
  readStorage("ep.chatTriggerPlacement", "playbar") === "edge" ? "edge" : "playbar";
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
const initialFullWidthPlayBar = readStorage("ep.fullWidthPlayBar", "true") !== "false";
const initialPlayBarOpacity = (() => {
  const raw = readStorage("ep.playBarOpacity", String(DEFAULT_PLAY_BAR_OPACITY));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampPlayBarOpacity(parsed) : DEFAULT_PLAY_BAR_OPACITY;
})();
const initialAutoCheckUpdates = readStorage("ep.autoCheckUpdates", "true") !== "false";
const initialAutoDownloadUpdates = readStorage("ep.autoDownloadUpdates", "true") !== "false";

applyReducedMotionAttribute(initialReducedMotion);
applyPlayBarOpacityVariables(initialPlayBarOpacity);

export const useAppStore = create<AppState>((set) => ({
  screen: "home",
  username: initialUsername,
  avatarId: initialAvatarId,
  roomCode: "",
  literalRoom: false,
  hostOnlyRoom: false,
  creatingRoom: false,
  serverEndpoint: initialServer,
  serverPassword: "",
  allowNetworkShares: initialAllowShares,
  hideParticipants: initialHideParticipants,
  hashFilenames: initialHashFilenames,
  reducedMotion: initialReducedMotion,
  lowPowerMode: initialLowPowerMode,
  soundEffectsEnabled: initialSoundEffectsEnabled,
  skipIntroMode: initialSkipIntroMode,
  autoFetchSubtitles: initialAutoFetchSubtitles,
  preferredSubtitleLangs: initialPreferredSubtitleLangs,
  openSubtitlesApiKey: initialOpenSubtitlesApiKey,
  reactionsEnabled: initialReactionsEnabled,
  chatPeeksEnabled: initialChatPeeksEnabled,
  chatTriggerPlacement: initialChatTriggerPlacement,
  recentEmojis: initialRecentEmojis,
  fullWidthPlayBar: initialFullWidthPlayBar,
  playBarOpacity: initialPlayBarOpacity,
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
    set((s) => {
      const cleaned = sanitizeRoomCodeInput(code, s.literalRoom);
      return {
        roomCode: cleaned,
        creatingRoom: cleaned ? s.creatingRoom : false,
      };
    }),

  setLiteralRoom: (literalRoom) => set({ literalRoom }),

  setHostOnlyRoom: (hostOnlyRoom) => set({ hostOnlyRoom }),

  setCreatingRoom: (creatingRoom) => set({ creatingRoom }),

  applyRerolledRoomCode: (code) =>
    set({
      roomCode: sanitizeRoomCodeInput(code, false),
      creatingRoom: false,
    }),

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

  setAutoFetchSubtitles: (autoFetchSubtitles) => {
    writeStorage("ep.autoFetchSubs", autoFetchSubtitles);
    set({ autoFetchSubtitles });
  },

  setPreferredSubtitleLangs: (langs) => {
    const clean = langs.trim() || "eng";
    writeStorage("ep.preferredSubLangs", clean);
    set({ preferredSubtitleLangs: clean });
  },

  setOpenSubtitlesApiKey: (apiKey) => {
    const clean = apiKey.trim();
    writeStorage("ep.osApiKey", clean);
    set({ openSubtitlesApiKey: clean });
  },

  setReactionsEnabled: (reactionsEnabled) => {
    writeStorage("ep.reactionsEnabled", reactionsEnabled ? "true" : "false");
    set({ reactionsEnabled });
  },

  setChatPeeksEnabled: (chatPeeksEnabled) => {
    writeStorage("ep.chatPeeksEnabled", chatPeeksEnabled ? "true" : "false");
    set({ chatPeeksEnabled });
  },

  setChatTriggerPlacement: (chatTriggerPlacement) => {
    writeStorage("ep.chatTriggerPlacement", chatTriggerPlacement);
    set({ chatTriggerPlacement });
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

  setPlayBarOpacity: (opacity) => {
    const next = clampPlayBarOpacity(opacity);
    writeStorage("ep.playBarOpacity", String(next));
    applyPlayBarOpacityVariables(next);
    set({ playBarOpacity: next });
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

  enterRoom: (code, literalRoom, hostOnlyRoom, creatingRoom) =>
    set((s) => {
      const lit = literalRoom ?? s.literalRoom;
      const cleaned = sanitizeRoomCodeInput(code, lit);
      return {
        screen: "room",
        roomCode: cleaned,
        literalRoom: lit,
        hostOnlyRoom: hostOnlyRoom ?? false,
        creatingRoom: Boolean(creatingRoom && !lit && cleaned),
        settingsOpen: false,
        shortcutsOpen: false,
      };
    }),

  leaveRoom: () => {
    clearReactions();
    clearPartyChat();
    usePlayerStore.getState().reset();
    useIntroStore.getState().resetForVideo(null);
    useSyncStore.getState().reset();
    const noteStore = useNotificationStore.getState();
    noteStore.dismissByTagPrefix(NOT_READY_TAG_PREFIX);
    noteStore.dismissByTagPrefix(PEER_LEFT_TAG_PREFIX);
    noteStore.dismissByTag(LOCAL_DISCONNECT_TAG);
    useSubtitleStore.getState().clearLoadedTrack();
    usePlaylistStore.getState().clearPlaylist();
    useVoiceStore.getState().resetSession();
    set({
      screen: "home",
      roomCode: "",
      hostOnlyRoom: false,
      creatingRoom: false,
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
