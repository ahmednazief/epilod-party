import { create } from "zustand";
import {
  voiceLeave,
  voiceSetConfig,
  voiceSetDeafen,
  voiceSetMute,
  voiceSetPeerVolume,
  type VoiceCalibrationPayload,
  type VoiceConfigDto,
  type VoiceDeviceListDto,
  type VoiceDuckingMode,
  type VoiceHotkeyScope,
  type VoiceInputMode,
  type VoiceNoiseMode,
  type VoicePeerRosterDto,
  type VoiceStatusPayload,
} from "../lib/voice";

export interface PeerVoiceOverride {
  volume: number; // 0..2.0
  muted: boolean;
}

export interface MicCueBadge {
  id: number;
  muted: boolean;
  step: number;
}

let micCueSeq = 0;
let micCueTimer: ReturnType<typeof setTimeout> | null = null;

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

function readNum(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number(readStorage(key, String(fallback)));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function hasStorageKey(key: string): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(key) !== null;
    }
  } catch {
    // Ignore storage read restrictions
  }
  return false;
}

function readPeerOverrides(): Record<string, PeerVoiceOverride> {
  try {
    const raw = readStorage("ep.voice.peerVolumes", "{}");
    const parsed = JSON.parse(raw) as Record<string, Partial<PeerVoiceOverride>>;
    const out: Record<string, PeerVoiceOverride> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (!v || typeof v !== "object") continue;
      out[k.toLowerCase()] = {
        volume: clampPeerVolume(typeof v.volume === "number" ? v.volume : 1.0),
        muted: Boolean(v.muted),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function clampPeerVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1.0;
  return Math.max(0.0, Math.min(2.0, Math.round(volume * 100) / 100));
}

export function clampMasterVolume(volume: number): number {
  return clampPeerVolume(volume);
}

export function clampSensitivityDb(db: number): number {
  if (!Number.isFinite(db)) return -42;
  return Math.max(-75, Math.min(0, Math.round(db)));
}

export function computeEffectiveMpvVolume(userVolume: number, duckFactor: number): number {
  const safeUser = Number.isFinite(userVolume) ? Math.max(0, Math.min(130, userVolume)) : 100;
  const safeDuck = Number.isFinite(duckFactor) ? Math.max(0, Math.min(1, duckFactor)) : 1;
  return Math.max(0, Math.min(130, safeUser * safeDuck));
}

const initialInputMode = ((): VoiceInputMode => {
  const raw = readStorage("ep.voice.inputMode", "vad");
  return raw === "ptt" ? "ptt" : "vad";
})();

const initialNoiseMode = ((): VoiceNoiseMode => {
  const raw = readStorage("ep.voice.noiseMode", "balanced");
  return raw === "off" || raw === "strong" ? raw : "balanced";
})();

const initialDuckingMode = ((): VoiceDuckingMode => {
  const raw = readStorage("ep.voice.duckingMode", "subtle");
  return raw === "off" || raw === "strong" ? raw : "subtle";
})();

const initialHotkeyScope = ((): VoiceHotkeyScope => {
  const raw = readStorage("ep.voice.hotkeyScope", "global");
  return raw === "focused" ? "focused" : "global";
})();

interface VoiceState {
  // Persisted audio config
  voiceEnabled: boolean;
  inputDevice: string;
  outputDevice: string;
  inputMode: VoiceInputMode;
  pttVk: number;
  pttMod: number;
  muteVk: number;
  muteMod: number;
  deafenVk: number;
  deafenMod: number;
  hotkeyScope: VoiceHotkeyScope;
  sensitivityDb: number;
  autoSensitivity: boolean;
  noiseMode: VoiceNoiseMode;
  compressionEnabled: boolean;
  duckingMode: VoiceDuckingMode;
  cinemaTightGate: boolean;
  spatialPan: boolean;
  echoGuardEnabled: boolean;
  aecEnabled: boolean;
  allowRelayForOthers: boolean;
  allowRelayedVoice: boolean;
  masterVolume: number;
  peerOverrides: Record<string, PeerVoiceOverride>;

  // Live session state
  joined: boolean;
  joining: boolean;
  muted: boolean;
  deafened: boolean;
  preDeafenMuted: boolean;
  pttActive: boolean;
  micTestActive: boolean;
  calibration: VoiceCalibrationPayload | null;
  streamStatus: string;
  streamError: string | null;
  speakerLeakDetected: boolean;
  bluetoothHfpDropped: boolean;
  lowBandwidthWarning: boolean;
  windowsCommAecActive: boolean;
  aecBackend: string;
  localLevelDb: number;
  localSpeechProb: number;
  localGateOpen: boolean;
  speakingPeers: string[];
  roster: VoicePeerRosterDto[];
  devices: VoiceDeviceListDto | null;
  micCue: MicCueBadge | null;

  // Actions
  setJoined: (joined: boolean) => void;
  setJoining: (joining: boolean) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  applyLocalState: (muted: boolean, deafened: boolean, pttActive?: boolean) => void;
  flashMicCue: (muted: boolean) => void;
  clearMicCue: () => void;
  setMicTestActive: (active: boolean) => void;
  setCalibration: (cal: VoiceCalibrationPayload | null) => void;
  applyStatusPayload: (status: VoiceStatusPayload) => void;
  setLocalLevel: (db: number, speechProb: number, gateOpen: boolean) => void;
  setSpeakingPeers: (speakers: string[]) => void;
  setRoster: (roster: VoicePeerRosterDto[]) => void;
  setDevices: (devices: VoiceDeviceListDto | null) => void;
  updateConfig: (patch: Partial<VoiceConfigDto>) => void;
  setPeerVolume: (username: string, volume: number, muted: boolean) => void;
  toConfigDto: () => VoiceConfigDto;
  syncAllPeerVolumesToBackend: () => void;
  resetSession: () => void;
}

function buildConfigDto(s: VoiceState): VoiceConfigDto {
  return {
    voiceEnabled: s.voiceEnabled,
    inputDevice: s.inputDevice,
    outputDevice: s.outputDevice,
    inputMode: s.inputMode,
    pttVk: s.pttVk,
    pttMod: s.pttMod,
    muteVk: s.muteVk,
    muteMod: s.muteMod,
    deafenVk: s.deafenVk,
    deafenMod: s.deafenMod,
    hotkeyScope: s.hotkeyScope,
    sensitivityDb: s.sensitivityDb,
    autoSensitivity: s.autoSensitivity,
    noiseMode: s.noiseMode,
    compressionEnabled: s.compressionEnabled,
    duckingMode: s.duckingMode,
    cinemaTightGate: s.cinemaTightGate,
    spatialPan: s.spatialPan,
    echoGuardEnabled: s.echoGuardEnabled,
    aecEnabled: s.aecEnabled,
    allowRelayForOthers: s.allowRelayForOthers,
    allowRelayedVoice: s.allowRelayedVoice,
    masterVolume: s.masterVolume,
  };
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  voiceEnabled: readStorage("ep.voice.enabled", "true") !== "false",
  inputDevice: readStorage("ep.voice.inputDevice", "default"),
  outputDevice: readStorage("ep.voice.outputDevice", "default"),
  inputMode: initialInputMode,
  pttVk: readNum("ep.voice.pttVk", 0x77, 0, 255),
  pttMod: readNum("ep.voice.pttMod", 0, 0, 7),
  muteVk: hasStorageKey("ep.voice.muteVk") ? readNum("ep.voice.muteVk", 0, 0, 255) : 0x4d,
  muteMod: hasStorageKey("ep.voice.muteMod") ? readNum("ep.voice.muteMod", 0, 0, 7) : 5,
  deafenVk: hasStorageKey("ep.voice.deafenVk") ? readNum("ep.voice.deafenVk", 0, 0, 255) : 0x44,
  deafenMod: hasStorageKey("ep.voice.deafenMod") ? readNum("ep.voice.deafenMod", 0, 0, 7) : 5,
  hotkeyScope: initialHotkeyScope,
  sensitivityDb: clampSensitivityDb(readNum("ep.voice.sensitivityDb", -42, -75, 0)),
  autoSensitivity: readStorage("ep.voice.autoSensitivity", "true") !== "false",
  noiseMode: initialNoiseMode,
  compressionEnabled: readStorage("ep.voice.compression", "true") !== "false",
  duckingMode: initialDuckingMode,
  cinemaTightGate: readStorage("ep.voice.cinemaTightGate", "true") !== "false",
  spatialPan: readStorage("ep.voice.spatialPan", "false") === "true",
  echoGuardEnabled: readStorage("ep.voice.echoGuard", "true") !== "false",
  aecEnabled: readStorage("ep.voice.aecEnabled", "false") === "true",
  allowRelayForOthers: readStorage("ep.voice.allowRelayForOthers", "true") !== "false",
  allowRelayedVoice: readStorage("ep.voice.allowRelayedVoice", "true") !== "false",
  masterVolume: clampMasterVolume(readNum("ep.voice.masterVolume", 1.0, 0.0, 2.0)),
  peerOverrides: readPeerOverrides(),

  joined: false,
  joining: false,
  muted: false,
  deafened: false,
  preDeafenMuted: false,
  pttActive: false,
  micTestActive: false,
  calibration: null,
  streamStatus: "idle",
  streamError: null,
  speakerLeakDetected: false,
  bluetoothHfpDropped: false,
  lowBandwidthWarning: false,
  windowsCommAecActive: false,
  aecBackend: "none",
  localLevelDb: -90,
  localSpeechProb: 0,
  localGateOpen: false,
  speakingPeers: [],
  roster: [],
  devices: null,
  micCue: null,

  setJoined: (joined) => set({ joined, joining: false }),
  setJoining: (joining) => set({ joining }),
  setMuted: (muted) => {
    set((s) => {
      const clearingDeafen = !muted && s.deafened;
      return {
        muted,
        deafened: clearingDeafen ? false : s.deafened,
        preDeafenMuted: clearingDeafen ? false : s.preDeafenMuted,
      };
    });
    void voiceSetMute(muted).catch(() => undefined);
  },
  setDeafened: (deafened) => {
    set((s) => {
      if (deafened === s.deafened) return s;
      if (deafened) {
        return {
          deafened: true,
          preDeafenMuted: s.muted,
          muted: true,
        };
      }
      return {
        deafened: false,
        muted: s.preDeafenMuted,
      };
    });
    void voiceSetDeafen(deafened).catch(() => undefined);
  },
  applyLocalState: (muted, deafened, pttActive) =>
    set((s) => ({
      muted,
      deafened,
      pttActive: typeof pttActive === "boolean" ? pttActive : s.pttActive,
      preDeafenMuted: !deafened ? muted : s.preDeafenMuted,
    })),
  flashMicCue: (muted) => {
    micCueSeq += 1;
    const seq = micCueSeq;
    if (micCueTimer) {
      clearTimeout(micCueTimer);
      micCueTimer = null;
    }
    set((s) => ({
      micCue: {
        id: seq,
        muted,
        step: s.micCue ? s.micCue.step + 1 : 1,
      },
    }));
    micCueTimer = setTimeout(() => {
      micCueTimer = null;
      set((s) => (s.micCue?.id === seq ? { micCue: null } : s));
    }, 1250);
  },
  clearMicCue: () => {
    if (micCueTimer) {
      clearTimeout(micCueTimer);
      micCueTimer = null;
    }
    set({ micCue: null });
  },
  setMicTestActive: (micTestActive) => set({ micTestActive }),
  setCalibration: (calibration) => set({ calibration }),
  applyStatusPayload: (status) =>
    set({
      streamStatus: status.streamStatus,
      streamError: status.streamError,
      speakerLeakDetected: status.speakerLeakDetected,
      bluetoothHfpDropped: status.bluetoothHfpDropped,
      lowBandwidthWarning: status.lowBandwidthWarning,
      windowsCommAecActive: status.windowsCommAecActive,
      aecBackend: status.aecBackend,
    }),
  setLocalLevel: (localLevelDb, localSpeechProb, localGateOpen) =>
    set({ localLevelDb, localSpeechProb, localGateOpen }),
  setSpeakingPeers: (speakingPeers) => set({ speakingPeers }),
  setRoster: (roster) => set({ roster }),
  setDevices: (devices) => set({ devices }),

  updateConfig: (patch) => {
    const wasEnabled = get().voiceEnabled;
    set((s) => {
      const next: VoiceState = { ...s, ...patch };
      if (patch.sensitivityDb !== undefined) {
        next.sensitivityDb = clampSensitivityDb(patch.sensitivityDb);
      }
      if (patch.masterVolume !== undefined) {
        next.masterVolume = clampMasterVolume(patch.masterVolume);
      }
      writeStorage("ep.voice.enabled", next.voiceEnabled ? "true" : "false");
      writeStorage("ep.voice.inputDevice", next.inputDevice);
      writeStorage("ep.voice.outputDevice", next.outputDevice);
      writeStorage("ep.voice.inputMode", next.inputMode);
      writeStorage("ep.voice.pttVk", String(next.pttVk));
      writeStorage("ep.voice.pttMod", String(next.pttMod));
      writeStorage("ep.voice.muteVk", String(next.muteVk));
      writeStorage("ep.voice.muteMod", String(next.muteMod));
      writeStorage("ep.voice.deafenVk", String(next.deafenVk));
      writeStorage("ep.voice.deafenMod", String(next.deafenMod));
      writeStorage("ep.voice.hotkeyScope", next.hotkeyScope);
      writeStorage("ep.voice.sensitivityDb", String(next.sensitivityDb));
      writeStorage("ep.voice.autoSensitivity", next.autoSensitivity ? "true" : "false");
      writeStorage("ep.voice.noiseMode", next.noiseMode);
      writeStorage("ep.voice.compression", next.compressionEnabled ? "true" : "false");
      writeStorage("ep.voice.duckingMode", next.duckingMode);
      writeStorage("ep.voice.cinemaTightGate", next.cinemaTightGate ? "true" : "false");
      writeStorage("ep.voice.spatialPan", next.spatialPan ? "true" : "false");
      writeStorage("ep.voice.echoGuard", next.echoGuardEnabled ? "true" : "false");
      writeStorage("ep.voice.aecEnabled", next.aecEnabled ? "true" : "false");
      writeStorage("ep.voice.allowRelayForOthers", next.allowRelayForOthers ? "true" : "false");
      writeStorage("ep.voice.allowRelayedVoice", next.allowRelayedVoice ? "true" : "false");
      writeStorage("ep.voice.masterVolume", String(next.masterVolume));
      return next;
    });
    if (wasEnabled && patch.voiceEnabled === false) {
      if (get().joined) {
        void voiceLeave().catch(() => undefined);
      }
      get().resetSession();
    }
    void voiceSetConfig(buildConfigDto(get())).catch(() => undefined);
  },

  setPeerVolume: (username, volume, muted) => {
    const key = username.trim().toLowerCase();
    if (!key) return;
    const cleanVol = clampPeerVolume(volume);
    set((s) => {
      const next = {
        ...s.peerOverrides,
        [key]: { volume: cleanVol, muted },
      };
      writeStorage("ep.voice.peerVolumes", JSON.stringify(next));
      return { peerOverrides: next };
    });
    void voiceSetPeerVolume(username, cleanVol, muted).catch(() => undefined);
  },

  toConfigDto: () => buildConfigDto(get()),

  syncAllPeerVolumesToBackend: () => {
    const overrides = get().peerOverrides;
    for (const [user, ov] of Object.entries(overrides)) {
      void voiceSetPeerVolume(user, ov.volume, ov.muted).catch(() => undefined);
    }
  },

  resetSession: () =>
    set({
      joined: false,
      joining: false,
      muted: false,
      deafened: false,
      preDeafenMuted: false,
      pttActive: false,
      localGateOpen: false,
      speakingPeers: [],
      roster: [],
      micCue: null,
      calibration: null,
    }),
}));
