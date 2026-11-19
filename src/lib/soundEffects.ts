import { resolveEffectiveUsername } from "./syncController";
import type { Participant, SyncStatusPayload } from "./syncplay";
import { useAppStore } from "../store/useAppStore";

export type SoundCue =
  | "roomConnected"
  | "peerJoined"
  | "peerLeft"
  | "peerReady"
  | "allReady"
  | "codeCopied"
  | "reactionPop"
  | "chatMessage"
  | "voiceJoined"
  | "voiceLeft"
  | "peerVoiceJoined"
  | "peerVoiceLeft"
  | "micMuted"
  | "micUnmuted";

export interface PlaySoundOptions {
  /** Quiets and softens cues automatically when video is actively playing. */
  moviePlaying?: boolean;
  /** Preview toggle feedback even before React re-renders. */
  forcePreview?: boolean;
}

interface CueNote {
  freqHz: number;
  harmonicFreqHz?: number;
  harmonicRatio?: number;
  delayMs: number;
  durationMs: number;
  gain: number;
}

interface CueRecipe {
  cutoffHz: number;
  notes: readonly CueNote[];
}

const CUE_RECIPES: Record<SoundCue, CueRecipe> = {
  // Warm low-velvet ascending fifth (D4 -> A4) with faint D3 body
  roomConnected: {
    cutoffHz: 1100,
    notes: [
      {
        freqHz: 293.66,
        harmonicFreqHz: 146.83,
        harmonicRatio: 0.35,
        delayMs: 0,
        durationMs: 170,
        gain: 0.052,
      },
      {
        freqHz: 440.0,
        harmonicFreqHz: 659.25,
        harmonicRatio: 0.14,
        delayMs: 70,
        durationMs: 240,
        gain: 0.056,
      },
    ],
  },
  // Airy liquid-glass droplet dyad (E4 -> B4 + subtle F#5 glisten)
  peerJoined: {
    cutoffHz: 1250,
    notes: [
      {
        freqHz: 329.63,
        harmonicFreqHz: 659.25,
        harmonicRatio: 0.16,
        delayMs: 0,
        durationMs: 135,
        gain: 0.052,
      },
      {
        freqHz: 493.88,
        harmonicFreqHz: 739.99,
        harmonicRatio: 0.18,
        delayMs: 65,
        durationMs: 220,
        gain: 0.058,
      },
    ],
  },
  // Muted warm descending breath (A4 -> E4)
  peerLeft: {
    cutoffHz: 820,
    notes: [
      {
        freqHz: 440.0,
        delayMs: 0,
        durationMs: 120,
        gain: 0.036,
      },
      {
        freqHz: 329.63,
        delayMs: 60,
        durationMs: 175,
        gain: 0.034,
      },
    ],
  },
  // Micro crystal tactile tick (F#4 -> A4)
  peerReady: {
    cutoffHz: 1200,
    notes: [
      { freqHz: 369.99, delayMs: 0, durationMs: 75, gain: 0.038 },
      { freqHz: 440.0, delayMs: 38, durationMs: 115, gain: 0.042 },
    ],
  },
  // Lush theater-lights-dimming major add9 shimmer (D4 - F#4 - A4 - E5)
  allReady: {
    cutoffHz: 1350,
    notes: [
      { freqHz: 293.66, delayMs: 0, durationMs: 240, gain: 0.042 },
      { freqHz: 369.99, delayMs: 42, durationMs: 240, gain: 0.044 },
      { freqHz: 440.0, delayMs: 84, durationMs: 250, gain: 0.046 },
      { freqHz: 659.25, delayMs: 126, durationMs: 260, gain: 0.042 },
    ],
  },
  // Subtle glass tap (G4 -> D5) for code copy / OTP verify
  codeCopied: {
    cutoffHz: 1150,
    notes: [
      { freqHz: 392.0, delayMs: 0, durationMs: 55, gain: 0.032 },
      { freqHz: 587.33, delayMs: 28, durationMs: 95, gain: 0.036 },
    ],
  },
  // Delicate liquid-glass droplet pop (A4 + soft E5 shimmer) for live reactions
  reactionPop: {
    cutoffHz: 1180,
    notes: [
      {
        freqHz: 440.0,
        harmonicFreqHz: 659.25,
        harmonicRatio: 0.12,
        delayMs: 0,
        durationMs: 70,
        gain: 0.026,
      },
    ],
  },
  // Whisper-soft crystalline droplet (E4 -> B4) for incoming room chat when panel is closed
  chatMessage: {
    cutoffHz: 1050,
    notes: [
      {
        freqHz: 329.63,
        harmonicFreqHz: 493.88,
        harmonicRatio: 0.14,
        delayMs: 0,
        durationMs: 95,
        gain: 0.028,
      },
      {
        freqHz: 493.88,
        delayMs: 42,
        durationMs: 130,
        gain: 0.022,
      },
    ],
  },
  // Crisp upward glass chime (E4 -> A4 -> E5) on joining room voice
  voiceJoined: {
    cutoffHz: 1300,
    notes: [
      { freqHz: 329.63, delayMs: 0, durationMs: 95, gain: 0.036 },
      { freqHz: 440.0, delayMs: 45, durationMs: 120, gain: 0.04 },
      { freqHz: 659.25, delayMs: 95, durationMs: 170, gain: 0.036 },
    ],
  },
  // Soft descending glass chime (E5 -> A4) on leaving voice
  voiceLeft: {
    cutoffHz: 950,
    notes: [
      { freqHz: 523.25, delayMs: 0, durationMs: 90, gain: 0.032 },
      { freqHz: 392.0, delayMs: 48, durationMs: 140, gain: 0.028 },
    ],
  },
  // Gentle whisper chime when a friend joins voice
  peerVoiceJoined: {
    cutoffHz: 1150,
    notes: [
      { freqHz: 392.0, delayMs: 0, durationMs: 85, gain: 0.026 },
      { freqHz: 523.25, delayMs: 42, durationMs: 135, gain: 0.028 },
    ],
  },
  // Soft low droplet when a friend leaves voice
  peerVoiceLeft: {
    cutoffHz: 850,
    notes: [
      { freqHz: 440.0, delayMs: 0, durationMs: 75, gain: 0.022 },
      { freqHz: 329.63, delayMs: 38, durationMs: 115, gain: 0.02 },
    ],
  },
  // Subtle muted low tap (D4 -> A3)
  micMuted: {
    cutoffHz: 800,
    notes: [
      { freqHz: 293.66, delayMs: 0, durationMs: 65, gain: 0.028 },
      { freqHz: 220.0, delayMs: 32, durationMs: 90, gain: 0.026 },
    ],
  },
  // Subtle crisp unmute tap (A3 -> D4)
  micUnmuted: {
    cutoffHz: 1050,
    notes: [
      { freqHz: 246.94, delayMs: 0, durationMs: 60, gain: 0.026 },
      { freqHz: 329.63, delayMs: 30, durationMs: 95, gain: 0.03 },
    ],
  },
};

const PEER_REJOIN_FLAP_MS = 4000;
const CUE_COOLDOWN_MS = 900;

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

function scheduleNote(
  ctx: AudioContext,
  destination: AudioNode,
  baseTime: number,
  note: CueNote,
  gainScale: number,
): void {
  const start = baseTime + note.delayMs / 1000;
  const dur = Math.max(0.05, note.durationMs / 1000);
  const peak = Math.max(0.002, note.gain * gainScale);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  env.connect(destination);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(note.freqHz, start);
  osc.connect(env);
  osc.start(start);
  osc.stop(start + dur + 0.02);

  if (note.harmonicFreqHz && note.harmonicRatio) {
    const overtoneGain = ctx.createGain();
    overtoneGain.gain.setValueAtTime(note.harmonicRatio, start);
    overtoneGain.connect(env);

    const overtone = ctx.createOscillator();
    overtone.type = "triangle";
    overtone.frequency.setValueAtTime(note.harmonicFreqHz, start);
    overtone.connect(overtoneGain);
    overtone.start(start);
    overtone.stop(start + dur + 0.02);
  }
}

export function playSoundCue(cue: SoundCue, options: PlaySoundOptions = {}): void {
  if (!options.forcePreview && !useAppStore.getState().soundEffectsEnabled) {
    return;
  }

  const ctx = getAudioContext();
  if (!ctx) return;

  const recipe = CUE_RECIPES[cue];
  const moviePlaying = Boolean(options.moviePlaying);
  const gainScale = moviePlaying ? 0.55 : 1.0;
  const cutoffHz = moviePlaying ? Math.max(480, recipe.cutoffHz - 200) : recipe.cutoffHz;

  const fire = () => {
    try {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(cutoffHz, ctx.currentTime);
      filter.Q.setValueAtTime(0.7, ctx.currentTime);
      filter.connect(ctx.destination);

      const now = ctx.currentTime + 0.008;
      for (const note of recipe.notes) {
        scheduleNote(ctx, filter, now, note, gainScale);
      }
    } catch {
      // Ignore Web Audio graph failures on suspended/restricted environments
    }
  };

  if (ctx.state === "suspended") {
    void ctx.resume().then(fire).catch(() => undefined);
  } else {
    fire();
  }
}

export interface PlayReactionSoundOptions {
  moviePlaying?: boolean;
  repeat?: boolean;
}

const REACTION_PENTATONIC_HZ = [
  369.99, // F#4
  440.0, // A4
  493.88, // B4
  587.33, // D5
  659.25, // E5
] as const;

const PRESET_REACTION_BASE_HZ: Record<string, number> = {
  "❤️": 440.0, // Warm A4
  "😂": 587.33, // Playful D5
  "😮": 493.88, // Bright B4
  "😱": 369.99, // Tense F#4 drop
  "😢": 329.63, // Mellow E4
  "🔥": 659.25, // Crisp E5 spark
  "👏": 523.25, // Lively pop
};

let lastReactionTapAtMs = 0;
let lastReactionRepeatAtMs = 0;

function pickReactionBaseHz(emoji: string): number {
  const mapped = PRESET_REACTION_BASE_HZ[emoji];
  if (mapped) return mapped;
  let hash = 0;
  for (let i = 0; i < emoji.length; i += 1) {
    hash = (hash * 31 + emoji.charCodeAt(i)) | 0;
  }
  return REACTION_PENTATONIC_HZ[Math.abs(hash) % REACTION_PENTATONIC_HZ.length];
}

/**
 * Synthesizes a subtle Liquid-Glass droplet pop when clicking/tapping a reaction,
 * automatically ducking during active playback and throttling hold-stream repeats.
 */
export function playReactionSoundCue(
  emoji: string,
  options: PlayReactionSoundOptions = {},
): void {
  if (!useAppStore.getState().soundEffectsEnabled) {
    return;
  }

  const nowMs = Date.now();
  if (options.repeat) {
    if (nowMs - lastReactionRepeatAtMs < 145) return;
    lastReactionRepeatAtMs = nowMs;
  } else {
    if (nowMs - lastReactionTapAtMs < 28) return;
    lastReactionTapAtMs = nowMs;
    lastReactionRepeatAtMs = nowMs;
  }

  const ctx = getAudioContext();
  if (!ctx) return;

  const moviePlaying = Boolean(options.moviePlaying);
  const gainScale = (moviePlaying ? 0.55 : 1.0) * (options.repeat ? 0.42 : 1.0);
  const cutoffHz = moviePlaying ? 860 : 1150;
  const baseHz = pickReactionBaseHz(emoji);
  const organicJitter = 0.975 + Math.random() * 0.05;
  const repeatLift = options.repeat ? 1.06 : 1.0;
  const startHz = baseHz * 0.84 * organicJitter * repeatLift;
  const endHz = baseHz * 1.18 * organicJitter * repeatLift;

  const fire = () => {
    try {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(cutoffHz, ctx.currentTime);
      filter.Q.setValueAtTime(1.1, ctx.currentTime);
      filter.connect(ctx.destination);

      const start = ctx.currentTime + 0.004;
      const peak = Math.max(0.002, 0.026 * gainScale);
      const dur = options.repeat ? 0.055 : 0.072;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(peak, start + 0.007);
      env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      env.connect(filter);

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(startHz, start);
      osc.frequency.exponentialRampToValueAtTime(endHz, start + dur * 0.72);
      osc.connect(env);
      osc.start(start);
      osc.stop(start + dur + 0.015);

      // Whisper-quiet crystal shimmer harmonic on primary clicks
      if (!options.repeat) {
        const overtoneGain = ctx.createGain();
        overtoneGain.gain.setValueAtTime(0.11, start);
        overtoneGain.connect(env);

        const overtone = ctx.createOscillator();
        overtone.type = "triangle";
        overtone.frequency.setValueAtTime(endHz * 1.5, start);
        overtone.connect(overtoneGain);
        overtone.start(start);
        overtone.stop(start + dur * 0.65);
      }
    } catch {
      // Ignore Web Audio graph failures on suspended/restricted environments
    }
  };

  if (ctx.state === "suspended") {
    void ctx.resume().then(fire).catch(() => undefined);
  } else {
    fire();
  }
}

interface TrackedPeer {
  isReady: boolean;
}

function normalizePeerKey(name: string): string {
  return name.trim().toLowerCase();
}

export class RoomSoundTracker {
  private wasConnected = false;
  private initialRosterSeeded = false;
  private wasAllReady = false;
  private knownPeers = new Map<string, TrackedPeer>();
  private recentLeftAtMs = new Map<string, number>();
  private lastCueAtMs = new Map<SoundCue, number>();

  reset(): void {
    this.wasConnected = false;
    this.initialRosterSeeded = false;
    this.wasAllReady = false;
    this.knownPeers.clear();
    this.recentLeftAtMs.clear();
  }

  private allowCue(cue: SoundCue, nowMs: number): boolean {
    const prev = this.lastCueAtMs.get(cue);
    if (prev !== undefined && nowMs - prev < CUE_COOLDOWN_MS) {
      return false;
    }
    this.lastCueAtMs.set(cue, nowMs);
    return true;
  }

  update(
    status: SyncStatusPayload,
    participants: readonly Participant[],
    localUsername: string,
    nowMs = Date.now(),
  ): SoundCue[] {
    const cues: SoundCue[] = [];
    const connected = status.state === "connected";

    if (!connected) {
      if (this.wasConnected) {
        this.reset();
      }
      return cues;
    }

    if (!this.wasConnected) {
      this.wasConnected = true;
      this.initialRosterSeeded = false;
      this.wasAllReady = false;
      this.knownPeers.clear();
      this.recentLeftAtMs.clear();
      if (this.allowCue("roomConnected", nowMs)) {
        cues.push("roomConnected");
      }
    }

    const selfKey = normalizePeerKey(resolveEffectiveUsername(status, localUsername));
    const currentPeers = new Map<string, TrackedPeer>();
    for (const peer of participants) {
      const key = normalizePeerKey(peer.username);
      if (!key || key === selfKey) continue;
      currentPeers.set(key, { isReady: peer.isReady });
    }

    const allReadyNow = participants.length >= 2 && participants.every((p) => p.isReady);

    if (!this.initialRosterSeeded) {
      // Wait for either non-empty participants or explicit roster seed once connected
      if (participants.length > 0) {
        this.initialRosterSeeded = true;
        this.knownPeers = currentPeers;
        this.wasAllReady = allReadyNow;
      }
      return cues;
    }

    // Expire old reconnect flap markers
    for (const [key, leftAt] of this.recentLeftAtMs) {
      if (nowMs - leftAt >= PEER_REJOIN_FLAP_MS) {
        this.recentLeftAtMs.delete(key);
      }
    }

    let joinedDetected = false;
    let leftDetected = false;
    let peerBecameReady = false;

    for (const [key, peer] of currentPeers) {
      const prev = this.knownPeers.get(key);
      if (!prev) {
        const leftAt = this.recentLeftAtMs.get(key);
        if (leftAt === undefined || nowMs - leftAt >= PEER_REJOIN_FLAP_MS) {
          joinedDetected = true;
        }
        this.recentLeftAtMs.delete(key);
      } else if (!prev.isReady && peer.isReady) {
        peerBecameReady = true;
      }
    }

    for (const key of this.knownPeers.keys()) {
      if (!currentPeers.has(key)) {
        this.recentLeftAtMs.set(key, nowMs);
        leftDetected = true;
      }
    }

    this.knownPeers = currentPeers;
    const becameAllReady = allReadyNow && !this.wasAllReady;
    this.wasAllReady = allReadyNow;

    if (joinedDetected && this.allowCue("peerJoined", nowMs)) {
      cues.push("peerJoined");
    }
    if (leftDetected && this.allowCue("peerLeft", nowMs)) {
      cues.push("peerLeft");
    }
    if (becameAllReady) {
      if (this.allowCue("allReady", nowMs)) {
        cues.push("allReady");
      }
    } else if (peerBecameReady && this.allowCue("peerReady", nowMs)) {
      cues.push("peerReady");
    }

    return cues;
  }
}
