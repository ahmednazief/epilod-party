import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop, safeInvoke } from "./bridge";

export type VoiceInputMode = "vad" | "ptt";
export type VoiceNoiseMode = "off" | "balanced" | "strong";
export type VoiceDuckingMode = "off" | "subtle" | "strong";
export type VoiceHotkeyScope = "global" | "focused";
export type VoiceEngineMode = "aura" | "classic";

export const VOICE_MOD_CTRL = 1;
export const VOICE_MOD_ALT = 2;
export const VOICE_MOD_SHIFT = 4;

export interface VoiceConfigDto {
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
  engineMode: VoiceEngineMode;
  useWindowsCommAec: boolean;
  allowRelayForOthers: boolean;
  allowRelayedVoice: boolean;
  masterVolume: number;
}

export interface VoiceDeviceDto {
  id: string;
  label: string;
  isDefaultComm: boolean;
  isDefaultConsole: boolean;
  isBluetooth: boolean;
  sampleRate: number;
  channels: number;
}

export interface VoiceDeviceListDto {
  inputs: VoiceDeviceDto[];
  outputs: VoiceDeviceDto[];
  defaultCommInput: string | null;
  defaultCommOutput: string | null;
  activeInputIsBluetooth: boolean;
  activeOutputIsBluetooth: boolean;
  bluetoothSplitNotice: string | null;
  permissionDenied: boolean;
}

export interface VoicePeerRosterDto {
  username: string;
  voiceId: number;
  epoch: number;
  inVoice: boolean;
  muted: boolean;
  deafened: boolean;
  transport:
    | "directIpv6"
    | "directLan"
    | "directWan"
    | "relayed"
    | "unavailable"
    | "blocked"
    | string;
  relayVia: string | null;
  rttMs: number | null;
  lossPct: number;
  jitterMs: number;
  bitrateKbps: number;
  qualityBars: number;
  healthReason: string | null;
  healthFix: string | null;
}

export interface VoiceDiagnosticsDto {
  voiceEnabled: boolean;
  inVoice: boolean;
  micMonitor: boolean;
  micTestLoopback: boolean;
  activeInputName: string | null;
  activeOutputName: string | null;
  activeInputIsBluetooth: boolean;
  activeOutputIsBluetooth: boolean;
  bluetoothHfpDropped: boolean;
  windowsCommAecActive: boolean;
  aecBackend: string;
  captureBackend: string;
  speakerLeakDetected: boolean;
  lowBandwidthWarning: boolean;
  natMode: string;
  estUploadKbps: number;
  relayCapacityStreams: number;
  activeRelayStreams: number;
  streamStatus: "idle" | "live" | "reconnecting" | "micBusy" | "permissionDenied" | "error" | string;
  bitrateKbps: number;
  txTargetCount: number;
  avgLossPct: number;
  avgJitterMs: number;
  duckFactor: number;
  permissionDenied: boolean;
  streamError: string | null;
  peers: VoicePeerRosterDto[];
  txFifoDroppedFrames: number;
  dspOverrunFrames: number;
  dspAvgFrameUs: number;
  dspMaxFrameUs: number;
  gateTransitions: number;
  rxJitterUnderruns: number;
  rxRateLimitedDrops: number;
}

export interface DiagnosticCaptureResultDto {
  rawPath: string;
  processedPath: string;
  durationSec: number;
  sampleRate: number;
}

export interface VoiceLevelPayload {
  db: number;
  speechProb: number;
  gateOpen: boolean;
}

export interface VoiceLocalStatePayload {
  muted: boolean;
  deafened: boolean;
  pttActive?: boolean;
  source?: "hotkey" | "ptt" | "command" | string;
}

export interface VoiceStatusPayload {
  streamStatus: string;
  streamError: string | null;
  speakerLeakDetected: boolean;
  bluetoothHfpDropped: boolean;
  lowBandwidthWarning: boolean;
  windowsCommAecActive: boolean;
  aecBackend: string;
}

export interface VoiceCalibrationPayload {
  phase: "quiet" | "speak" | "done" | "error";
  progress: number;
  noiseFloorDb?: number;
  speechPeakDb?: number;
  recommendedDb?: number;
}

export async function voiceListDevices(
  selectedInput = "default",
  selectedOutput = "default",
): Promise<VoiceDeviceListDto> {
  if (!isDesktop()) {
    return {
      inputs: [],
      outputs: [],
      defaultCommInput: null,
      defaultCommOutput: null,
      activeInputIsBluetooth: false,
      activeOutputIsBluetooth: false,
      bluetoothSplitNotice: null,
      permissionDenied: false,
    };
  }
  return safeInvoke<VoiceDeviceListDto>("voice_list_devices", {
    selectedInput,
    selectedOutput,
  });
}

export async function voiceSetConfig(config: VoiceConfigDto): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_set_config", { config });
}

export async function voiceSetMoviePlaying(playing: boolean): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_set_movie_playing", { playing });
}

export async function voiceJoin(startMuted?: boolean): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_join", startMuted === undefined ? undefined : { startMuted });
}

export async function voiceLeave(): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_leave");
}

export async function voiceSetMute(muted: boolean): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_set_mute", { muted });
}

export async function voiceSetDeafen(deafened: boolean): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_set_deafen", { deafened });
}

export async function voiceSetPeerVolume(
  username: string,
  volume: number,
  muted: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_set_peer_volume", { username, volume, muted });
}

let activeMicMonitorSurfaces = 0;

/** Registers an active UI surface (Settings or Quick Audio tray) holding mic monitor open. */
export function acquireMicMonitorSurface(): number {
  activeMicMonitorSurfaces += 1;
  return activeMicMonitorSurfaces;
}

/** Releases a UI surface's mic monitor claim and returns remaining active surface count. */
export function releaseMicMonitorSurface(): number {
  activeMicMonitorSurfaces = Math.max(0, activeMicMonitorSurfaces - 1);
  return activeMicMonitorSurfaces;
}

/** Returns how many UI surfaces are currently holding mic monitoring active. */
export function getActiveMicMonitorSurfaces(): number {
  return activeMicMonitorSurfaces;
}

export async function voiceStartMicMonitor(loopback: boolean): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_start_mic_monitor", { loopback });
}

export async function voiceStopMicMonitor(): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_stop_mic_monitor");
}

export async function voiceGetDiagnostics(): Promise<VoiceDiagnosticsDto | null> {
  if (!isDesktop()) return null;
  return safeInvoke<VoiceDiagnosticsDto>("voice_get_diagnostics");
}

export async function voiceStartCalibration(): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_start_calibration");
}

export async function voiceGetReport(): Promise<string> {
  if (!isDesktop()) {
    return JSON.stringify({ reportKind: "epilod-party-voice-health-v1", runtime: "preview" }, null, 2);
  }
  return safeInvoke<string>("voice_get_report");
}

export async function voiceStartDiagnosticCapture(maxSeconds = 60): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("voice_start_diagnostic_capture", { maxSeconds });
}

export async function voiceStopDiagnosticCapture(): Promise<DiagnosticCaptureResultDto | null> {
  if (!isDesktop()) return null;
  return safeInvoke<DiagnosticCaptureResultDto>("voice_stop_diagnostic_capture");
}

export function onVoiceRoster(cb: (roster: VoicePeerRosterDto[]) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen<VoicePeerRosterDto[]>("voice://roster", (e) => cb(e.payload));
}

export function onVoiceSpeaking(cb: (speakers: string[]) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen<string[]>("voice://speaking", (e) => cb(e.payload));
}

export function onVoiceLevel(cb: (level: VoiceLevelPayload) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen<VoiceLevelPayload>("voice://level", (e) => cb(e.payload));
}

export function onVoiceLocalState(
  cb: (state: VoiceLocalStatePayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen<VoiceLocalStatePayload>("voice://local-state", (e) => cb(e.payload));
}

export function onVoiceStatus(cb: (status: VoiceStatusPayload) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen<VoiceStatusPayload>("voice://status", (e) => cb(e.payload));
}

export function onVoiceCalibration(
  cb: (cal: VoiceCalibrationPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen<VoiceCalibrationPayload>("voice://calibration", (e) => cb(e.payload));
}

export function onVoiceDevicesChanged(cb: () => void): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen("voice://devices-changed", () => cb());
}

export function onVoiceDiagnosticCaptureFinished(
  cb: (result: DiagnosticCaptureResultDto) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return Promise.resolve(() => {});
  return listen<DiagnosticCaptureResultDto>("voice://diagnostic-capture-finished", (e) =>
    cb(e.payload),
  );
}

export function formatVkLabel(vk: number): string {
  if (!vk || vk <= 0) return "Unbound";
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x70 && vk <= 0x7b) return `F${vk - 0x6f}`;
  switch (vk) {
    case 0x05:
      return "Mouse 4";
    case 0x06:
      return "Mouse 5";
    case 0x10:
      return "Shift";
    case 0x11:
      return "Ctrl";
    case 0x12:
      return "Alt";
    case 0x14:
      return "CapsLock";
    case 0x20:
      return "Space";
    case 0xc0:
      return "`";
    default:
      return `Key 0x${vk.toString(16).toUpperCase()}`;
  }
}

export function formatVoiceHotkey(vk: number, mod = 0): string {
  if (!vk || vk <= 0) return "Unbound";
  const parts: string[] = [];
  if (mod & VOICE_MOD_CTRL) parts.push("Ctrl");
  if (mod & VOICE_MOD_ALT) parts.push("Alt");
  if (mod & VOICE_MOD_SHIFT) parts.push("Shift");
  parts.push(formatVkLabel(vk));
  return parts.join("+");
}

export function domEventModifiersMask(e: {
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): number {
  let mask = 0;
  if (e.ctrlKey) mask |= VOICE_MOD_CTRL;
  if (e.altKey) mask |= VOICE_MOD_ALT;
  if (e.shiftKey) mask |= VOICE_MOD_SHIFT;
  return mask;
}

const APP_SINGLE_KEY_CONFLICTS: Record<number, string> = {
  0x20: "Space (Play / Pause)",
  0x4b: "K (Play / Pause)",
  0x4a: "J (Seek -10s)",
  0x4c: "L (Seek +10s)",
  0x4d: "M (Mute video)",
  0x49: "I (Skip intro)",
  0x56: "V (Toggle subtitles)",
  0x53: "S (Cycle subtitles)",
  0x5a: "Z (Subtitle timing -0.1s)",
  0x58: "X (Subtitle timing +0.1s)",
  0x46: "F (Fullscreen)",
  0x52: "R (Toggle ready)",
  0x43: "C (Toggle chat)",
  0x45: "E (Reactions bar)",
};

export interface HotkeyValidationResult {
  valid: boolean;
  reason: string | null;
  warning: string | null;
}

export function validateVoiceHotkey(
  vk: number,
  mod = 0,
  hotkeyScope: VoiceHotkeyScope = "global",
): HotkeyValidationResult {
  if (!vk || vk <= 0) {
    return { valid: true, reason: null, warning: null };
  }
  const isPlainLetter = vk >= 0x41 && vk <= 0x5a;
  const isPlainDigit = vk >= 0x30 && vk <= 0x39;
  const isPlainSpace = vk === 0x20;
  if (mod === 0 && (isPlainLetter || isPlainDigit || isPlainSpace)) {
    return {
      valid: false,
      reason:
        "Plain letters, numbers, and Space need a modifier (Ctrl/Alt/Shift) so typing elsewhere won't toggle voice. Use an F-key, Mouse 4/5, or a modifier combo.",
      warning: null,
    };
  }
  if (mod === 0 && hotkeyScope === "focused" && APP_SINGLE_KEY_CONFLICTS[vk]) {
    return {
      valid: true,
      reason: null,
      warning: `Conflicts with player shortcut ${APP_SINGLE_KEY_CONFLICTS[vk]}.`,
    };
  }
  if (mod === VOICE_MOD_CTRL && vk === 0x4f) {
    return {
      valid: true,
      reason: null,
      warning: "Ctrl+O conflicts with Open File.",
    };
  }
  return { valid: true, reason: null, warning: null };
}

export function domEventToWindowsVk(e: {
  code?: string;
  key?: string;
  keyCode?: number;
}): number | null {
  if (typeof e.keyCode === "number" && e.keyCode > 0 && e.keyCode < 255) {
    return e.keyCode;
  }
  const c = e.code ?? "";
  if (c.startsWith("Key") && c.length === 4) {
    return c.charCodeAt(3);
  }
  if (c.startsWith("Digit") && c.length === 6) {
    return c.charCodeAt(5);
  }
  if (c === "Space") return 0x20;
  if (c === "Backquote") return 0xc0;
  return null;
}
