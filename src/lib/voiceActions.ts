import { formatUserError } from "./errors";
import { playSoundCue } from "./soundEffects";
import {
  voiceJoin,
  voiceLeave,
  voiceListDevices,
  voiceSetConfig,
  type VoicePeerRosterDto,
} from "./voice";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useVoiceStore, type PeerVoiceOverride } from "../store/useVoiceStore";

export const VOICE_HEALTH_NOTE_TAG = "voice-health-alert";
export const VOICE_PEER_BLOCKED_NOTE_TAG = "voice-peer-blocked";

function isMovieActivelyPlaying(): boolean {
  const p = usePlayerStore.getState();
  return p.loaded && !p.paused;
}

export interface JoinVoiceOptions {
  listenOnly?: boolean;
  skipBtCheck?: boolean;
}

export type JoinVoiceOutcome = "joined" | "needsBtConfirm" | "failed" | "ignored";
export type ToggleVoiceOutcome = JoinVoiceOutcome | "left";

export interface VoiceSpeakingCheckInput {
  joined: boolean;
  muted: boolean;
  deafened: boolean;
  localGateOpen: boolean;
  streamStatus: string;
  speakingPeers: readonly string[];
  roster: readonly VoicePeerRosterDto[];
  peerOverrides: Record<string, PeerVoiceOverride>;
}

/** Returns true when the local mic capture pipeline is not blocked or stalled. */
export function isCaptureHealthy(streamStatus: string): boolean {
  return (
    streamStatus !== "micBusy" &&
    streamStatus !== "reconnecting" &&
    streamStatus !== "permissionDenied"
  );
}

/**
 * Returns true when the local user's mic gate is actively transmitting healthy speech.
 */
export function isLocalVoiceSpeaking(
  v: Pick<
    VoiceSpeakingCheckInput,
    "joined" | "muted" | "deafened" | "localGateOpen" | "streamStatus"
  >,
): boolean {
  return v.joined && !v.muted && !v.deafened && v.localGateOpen && isCaptureHealthy(v.streamStatus);
}

/**
 * Returns true when a participant (self or remote peer) is actively speaking and not locally muted.
 */
export function isParticipantSpeaking(
  username: string,
  effectiveUsername: string,
  v: VoiceSpeakingCheckInput,
): boolean {
  const key = username.trim().toLowerCase();
  if (!key) return false;
  if (key === effectiveUsername.trim().toLowerCase()) {
    return isLocalVoiceSpeaking(v);
  }
  const entry = v.roster.find((r) => r.username.trim().toLowerCase() === key);
  if (!entry?.inVoice || entry.muted || entry.deafened) return false;
  if (v.peerOverrides[key]?.muted) return false;
  return v.speakingPeers.some((s) => s.trim().toLowerCase() === key);
}

/** Returns display names for actively speaking, unmuted participants (self first when speaking). */
export function getActiveVoiceSpeakerNames(
  effectiveUsername: string,
  v: VoiceSpeakingCheckInput,
): string[] {
  const selfKey = effectiveUsername.trim().toLowerCase();
  const names: string[] = [];
  if (isLocalVoiceSpeaking(v) && effectiveUsername.trim()) {
    names.push(effectiveUsername.trim());
  }
  for (const peerName of v.speakingPeers) {
    const key = peerName.trim().toLowerCase();
    if (!key || key === selfKey) continue;
    if (v.peerOverrides[key]?.muted) continue;
    names.push(peerName);
  }
  return names;
}

/**
 * Joins room voice chat cleanly with device pre-check, Bluetooth safeguard,
 * and atomic startMuted handoff to the Rust audio backend.
 */
export async function joinVoiceSession(options: JoinVoiceOptions = {}): Promise<JoinVoiceOutcome> {
  const store = useVoiceStore.getState();
  if (!store.voiceEnabled || store.joining || store.joined) {
    return "ignored";
  }

  const listenOnly = Boolean(options.listenOnly);
  let latestDevices = store.devices;
  if (!latestDevices) {
    latestDevices = await voiceListDevices(store.inputDevice, store.outputDevice).catch(() => null);
    if (latestDevices) {
      useVoiceStore.getState().setDevices(latestDevices);
    }
  }

  if (!listenOnly && !options.skipBtCheck && latestDevices?.activeInputIsBluetooth) {
    return "needsBtConfirm";
  }

  useVoiceStore.getState().setJoining(true);
  try {
    const stateNow = useVoiceStore.getState();
    await voiceSetConfig(stateNow.toConfigDto());
    stateNow.syncAllPeerVolumesToBackend();
    await voiceJoin(listenOnly);
    if (listenOnly) {
      useVoiceStore.setState({ muted: true, deafened: false, preDeafenMuted: true });
    }
    useVoiceStore.getState().setJoined(true);
    playSoundCue("voiceJoined", { moviePlaying: isMovieActivelyPlaying() });
    return "joined";
  } catch (err) {
    useVoiceStore.getState().setJoining(false);
    useNotificationStore
      .getState()
      .push("error", formatUserError(err, "Could not start voice chat."));
    return "failed";
  }
}

/** Leaves the active room voice call and restores player/toast state cleanly. */
export async function leaveVoiceSession(): Promise<void> {
  const store = useVoiceStore.getState();
  if (!store.joined && !store.joining) return;
  await voiceLeave().catch(() => undefined);
  useVoiceStore.getState().setJoined(false);
  useVoiceStore.setState({ pttActive: false });
  useNotificationStore.getState().dismissByTag(VOICE_HEALTH_NOTE_TAG);
  useNotificationStore.getState().dismissByTag(VOICE_PEER_BLOCKED_NOTE_TAG);
  playSoundCue("voiceLeft", { moviePlaying: isMovieActivelyPlaying() });
}

/**
 * Convenience toggle that leaves if currently joined, or joins via `joinVoiceSession`.
 */
export async function toggleVoiceSession(
  options: JoinVoiceOptions = {},
): Promise<ToggleVoiceOutcome> {
  if (useVoiceStore.getState().joined) {
    await leaveVoiceSession();
    return "left";
  }
  return joinVoiceSession(options);
}

/** Toggles local mic mute and plays a playback-ducked audio cue. */
export function toggleVoiceMute(): boolean {
  const store = useVoiceStore.getState();
  const next = !store.muted;
  store.setMuted(next);
  store.flashMicCue(next);
  playSoundCue(next ? "micMuted" : "micUnmuted", { moviePlaying: isMovieActivelyPlaying() });
  return next;
}

/** Toggles deafen while preserving prior mic mute state on undeafen. */
export function toggleVoiceDeafen(): boolean {
  const store = useVoiceStore.getState();
  const next = !store.deafened;
  store.setDeafened(next);
  playSoundCue(next ? "micMuted" : "micUnmuted", { moviePlaying: isMovieActivelyPlaying() });
  return next;
}

export interface VoiceRosterDiff {
  joinedUsers: string[];
  leftUsers: string[];
  nextMap: Record<string, boolean>;
}

/**
 * Computes remote peer join/leave transitions against the prior voice roster map.
 * Seeded baseline returns empty transitions so initial room snapshots never chime.
 */
export function diffVoiceRosterPeers(
  prevMap: Record<string, boolean> | null,
  roster: VoicePeerRosterDto[],
  selfUsername: string,
): VoiceRosterDiff {
  const selfKey = selfUsername.trim().toLowerCase();
  const nextMap: Record<string, boolean> = {};
  const joinedUsers: string[] = [];
  const leftUsers: string[] = [];

  for (const peer of roster) {
    const key = peer.username.trim().toLowerCase();
    if (!key || key === selfKey) continue;
    nextMap[key] = Boolean(peer.inVoice);
    if (prevMap) {
      const wasIn = Boolean(prevMap[key]);
      if (!wasIn && peer.inVoice) {
        joinedUsers.push(peer.username);
      } else if (wasIn && !peer.inVoice) {
        leftUsers.push(peer.username);
      }
    }
  }

  if (prevMap) {
    for (const [key, wasIn] of Object.entries(prevMap)) {
      if (wasIn && !(key in nextMap)) {
        leftUsers.push(key);
      }
    }
  }

  return { joinedUsers, leftUsers, nextMap };
}
