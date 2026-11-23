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
  | "micUnmuted"
  | "voiceDeafened"
  | "voiceUndeafened"
  | "resyncSnap"
  | "ratingSubmitted"
  | "episodeChanged"
  | "errorTone";

export interface PlaySoundOptions {
  /** Quiets and softens cues automatically when video is actively playing. */
  moviePlaying?: boolean;
  /** Preview toggle feedback even before React re-renders. */
  forcePreview?: boolean;
}

interface CueNote {
  freqHz: number;
  startFreqHz?: number;
  wave?: OscillatorType;
  harmonicFreqHz?: number;
  harmonicRatio?: number;
  detuneCents?: number;
  pan?: number;
  transientHz?: number;
  transientGain?: number;
  delayMs: number;
  durationMs: number;
  gain: number;
}

interface CueRecipe {
  cutoffHz: number;
  ambienceWet?: number;
  notes: readonly CueNote[];
}

const CUE_RECIPES: Record<SoundCue, CueRecipe> = {
  // Warm velvet theater ascending fifth (D4 -> A4) with D3 body & lush stereo shimmer
  roomConnected: {
    cutoffHz: 1320,
    ambienceWet: 0.2,
    notes: [
      {
        startFreqHz: 277.18,
        freqHz: 293.66,
        harmonicFreqHz: 146.83,
        harmonicRatio: 0.34,
        detuneCents: 6,
        pan: -0.14,
        delayMs: 0,
        durationMs: 190,
        gain: 0.056,
      },
      {
        startFreqHz: 415.3,
        freqHz: 440.0,
        harmonicFreqHz: 659.25,
        harmonicRatio: 0.16,
        detuneCents: 7,
        pan: 0.14,
        delayMs: 72,
        durationMs: 265,
        gain: 0.06,
      },
    ],
  },
  // Airy liquid-glass droplet dyad (E4 -> B4 + F#5 glisten)
  peerJoined: {
    cutoffHz: 1450,
    ambienceWet: 0.18,
    notes: [
      {
        startFreqHz: 311.13,
        freqHz: 329.63,
        harmonicFreqHz: 659.25,
        harmonicRatio: 0.16,
        detuneCents: 5,
        pan: -0.12,
        delayMs: 0,
        durationMs: 145,
        gain: 0.054,
      },
      {
        startFreqHz: 466.16,
        freqHz: 493.88,
        harmonicFreqHz: 739.99,
        harmonicRatio: 0.2,
        detuneCents: 7,
        pan: 0.14,
        delayMs: 64,
        durationMs: 235,
        gain: 0.06,
      },
    ],
  },
  // Muted warm descending breath (A4 -> E4)
  peerLeft: {
    cutoffHz: 860,
    ambienceWet: 0.12,
    notes: [
      {
        startFreqHz: 452.0,
        freqHz: 440.0,
        pan: 0.08,
        delayMs: 0,
        durationMs: 125,
        gain: 0.038,
      },
      {
        startFreqHz: 349.23,
        freqHz: 329.63,
        detuneCents: 4,
        pan: -0.08,
        delayMs: 58,
        durationMs: 185,
        gain: 0.036,
      },
    ],
  },
  // Micro crystal tactile tick (F#4 -> A4)
  peerReady: {
    cutoffHz: 1320,
    notes: [
      {
        freqHz: 369.99,
        transientHz: 1150,
        transientGain: 0.016,
        delayMs: 0,
        durationMs: 75,
        gain: 0.04,
      },
      {
        startFreqHz: 415.3,
        freqHz: 440.0,
        harmonicFreqHz: 880.0,
        harmonicRatio: 0.1,
        delayMs: 36,
        durationMs: 120,
        gain: 0.045,
      },
    ],
  },
  // Lush theater-lights-dimming major add9 shimmer (D4 - F#4 - A4 - E5)
  allReady: {
    cutoffHz: 1550,
    ambienceWet: 0.24,
    notes: [
      { freqHz: 293.66, detuneCents: 5, pan: -0.2, delayMs: 0, durationMs: 250, gain: 0.044 },
      { freqHz: 369.99, detuneCents: 6, pan: -0.07, delayMs: 42, durationMs: 250, gain: 0.046 },
      { freqHz: 440.0, detuneCents: 6, pan: 0.07, delayMs: 84, durationMs: 260, gain: 0.048 },
      {
        startFreqHz: 622.25,
        freqHz: 659.25,
        harmonicFreqHz: 1318.5,
        harmonicRatio: 0.12,
        detuneCents: 8,
        pan: 0.2,
        delayMs: 126,
        durationMs: 290,
        gain: 0.044,
      },
    ],
  },
  // Subtle glass tap (G4 -> D5) with crisp micro-click for code copy / OTP verify
  codeCopied: {
    cutoffHz: 1350,
    notes: [
      {
        freqHz: 392.0,
        transientHz: 1400,
        transientGain: 0.018,
        delayMs: 0,
        durationMs: 58,
        gain: 0.036,
      },
      {
        startFreqHz: 554.37,
        freqHz: 587.33,
        harmonicFreqHz: 1174.66,
        harmonicRatio: 0.1,
        delayMs: 28,
        durationMs: 100,
        gain: 0.04,
      },
    ],
  },
  // Delicate liquid-glass droplet pop (A4 + soft E5 shimmer)
  reactionPop: {
    cutoffHz: 1260,
    notes: [
      {
        startFreqHz: 369.99,
        freqHz: 440.0,
        harmonicFreqHz: 659.25,
        harmonicRatio: 0.14,
        delayMs: 0,
        durationMs: 74,
        gain: 0.028,
      },
    ],
  },
  // Whisper-soft crystalline droplet (E4 -> B4) for incoming room chat when panel is closed
  chatMessage: {
    cutoffHz: 1180,
    ambienceWet: 0.15,
    notes: [
      {
        startFreqHz: 311.13,
        freqHz: 329.63,
        harmonicFreqHz: 493.88,
        harmonicRatio: 0.14,
        pan: 0.18,
        delayMs: 0,
        durationMs: 95,
        gain: 0.03,
      },
      {
        startFreqHz: 466.16,
        freqHz: 493.88,
        detuneCents: 5,
        pan: 0.22,
        delayMs: 42,
        durationMs: 140,
        gain: 0.026,
      },
    ],
  },
  // Signature Epilod upward voice chime (E4 -> A4 -> E5) with warm stereo bloom
  voiceJoined: {
    cutoffHz: 1500,
    ambienceWet: 0.2,
    notes: [
      {
        startFreqHz: 311.13,
        freqHz: 329.63,
        transientHz: 950,
        transientGain: 0.014,
        pan: -0.14,
        delayMs: 0,
        durationMs: 100,
        gain: 0.04,
      },
      {
        freqHz: 440.0,
        detuneCents: 6,
        pan: 0.0,
        delayMs: 46,
        durationMs: 125,
        gain: 0.044,
      },
      {
        startFreqHz: 622.25,
        freqHz: 659.25,
        harmonicFreqHz: 987.77,
        harmonicRatio: 0.16,
        detuneCents: 7,
        pan: 0.16,
        delayMs: 94,
        durationMs: 185,
        gain: 0.042,
      },
    ],
  },
  // Soft descending glass chime (C5 -> G4) on leaving voice
  voiceLeft: {
    cutoffHz: 980,
    ambienceWet: 0.14,
    notes: [
      {
        startFreqHz: 554.37,
        freqHz: 523.25,
        pan: 0.1,
        delayMs: 0,
        durationMs: 95,
        gain: 0.036,
      },
      {
        startFreqHz: 415.3,
        freqHz: 392.0,
        detuneCents: 5,
        pan: -0.1,
        delayMs: 48,
        durationMs: 150,
        gain: 0.032,
      },
    ],
  },
  // Gentle whisper chime when a friend joins voice
  peerVoiceJoined: {
    cutoffHz: 1280,
    ambienceWet: 0.14,
    notes: [
      { startFreqHz: 369.99, freqHz: 392.0, pan: -0.12, delayMs: 0, durationMs: 85, gain: 0.028 },
      {
        startFreqHz: 493.88,
        freqHz: 523.25,
        harmonicFreqHz: 783.99,
        harmonicRatio: 0.12,
        pan: 0.12,
        delayMs: 42,
        durationMs: 140,
        gain: 0.03,
      },
    ],
  },
  // Soft low droplet when a friend leaves voice
  peerVoiceLeft: {
    cutoffHz: 860,
    notes: [
      { startFreqHz: 466.16, freqHz: 440.0, delayMs: 0, durationMs: 75, gain: 0.024 },
      { startFreqHz: 349.23, freqHz: 329.63, delayMs: 38, durationMs: 120, gain: 0.022 },
    ],
  },
  // Crisp tactile mic-mute switch (D#4 -> A3 + damped click)
  micMuted: {
    cutoffHz: 920,
    notes: [
      {
        startFreqHz: 311.13,
        freqHz: 293.66,
        transientHz: 880,
        transientGain: 0.018,
        delayMs: 0,
        durationMs: 62,
        gain: 0.032,
      },
      {
        startFreqHz: 246.94,
        freqHz: 220.0,
        delayMs: 30,
        durationMs: 88,
        gain: 0.03,
      },
    ],
  },
  // Crisp tactile mic-unmute switch (B3 -> E4 + bright micro-click)
  micUnmuted: {
    cutoffHz: 1250,
    notes: [
      {
        startFreqHz: 233.08,
        freqHz: 246.94,
        transientHz: 1220,
        transientGain: 0.018,
        delayMs: 0,
        durationMs: 58,
        gain: 0.03,
      },
      {
        startFreqHz: 311.13,
        freqHz: 329.63,
        harmonicFreqHz: 659.25,
        harmonicRatio: 0.1,
        delayMs: 28,
        durationMs: 95,
        gain: 0.034,
      },
    ],
  },
  // Distinct low-pass "ears-closed" deafen signature (E4 -> E3)
  voiceDeafened: {
    cutoffHz: 620,
    notes: [
      {
        startFreqHz: 329.63,
        freqHz: 261.63,
        transientHz: 480,
        transientGain: 0.02,
        delayMs: 0,
        durationMs: 78,
        gain: 0.036,
      },
      {
        startFreqHz: 220.0,
        freqHz: 164.81,
        wave: "triangle",
        delayMs: 38,
        durationMs: 115,
        gain: 0.034,
      },
    ],
  },
  // Bright "ears-open" undeafen bloom (A3 -> E4 -> A4)
  voiceUndeafened: {
    cutoffHz: 1450,
    ambienceWet: 0.12,
    notes: [
      {
        startFreqHz: 207.65,
        freqHz: 220.0,
        transientHz: 1100,
        transientGain: 0.015,
        delayMs: 0,
        durationMs: 65,
        gain: 0.03,
      },
      {
        startFreqHz: 311.13,
        freqHz: 329.63,
        delayMs: 32,
        durationMs: 85,
        gain: 0.034,
      },
      {
        startFreqHz: 415.3,
        freqHz: 440.0,
        harmonicFreqHz: 880.0,
        harmonicRatio: 0.12,
        delayMs: 64,
        durationMs: 130,
        gain: 0.036,
      },
    ],
  },
  // Magnetic sync lock-in snap (G4 -> D5)
  resyncSnap: {
    cutoffHz: 1420,
    notes: [
      {
        startFreqHz: 349.23,
        freqHz: 392.0,
        transientHz: 1450,
        transientGain: 0.02,
        delayMs: 0,
        durationMs: 52,
        gain: 0.036,
      },
      {
        startFreqHz: 523.25,
        freqHz: 587.33,
        harmonicFreqHz: 1174.66,
        harmonicRatio: 0.12,
        delayMs: 26,
        durationMs: 105,
        gain: 0.04,
      },
    ],
  },
  // Warm rewarding shimmer on submitting episode rating (A4 -> E5)
  ratingSubmitted: {
    cutoffHz: 1480,
    ambienceWet: 0.2,
    notes: [
      {
        startFreqHz: 415.3,
        freqHz: 440.0,
        detuneCents: 5,
        pan: -0.1,
        delayMs: 0,
        durationMs: 110,
        gain: 0.036,
      },
      {
        startFreqHz: 622.25,
        freqHz: 659.25,
        harmonicFreqHz: 987.77,
        harmonicRatio: 0.15,
        detuneCents: 7,
        pan: 0.12,
        delayMs: 52,
        durationMs: 195,
        gain: 0.04,
      },
    ],
  },
  // Subtle theater chapter tap when switching episodes (A3 -> D4)
  episodeChanged: {
    cutoffHz: 1120,
    notes: [
      {
        freqHz: 220.0,
        transientHz: 760,
        transientGain: 0.016,
        delayMs: 0,
        durationMs: 60,
        gain: 0.03,
      },
      {
        startFreqHz: 277.18,
        freqHz: 293.66,
        harmonicFreqHz: 587.33,
        harmonicRatio: 0.08,
        delayMs: 30,
        durationMs: 100,
        gain: 0.034,
      },
    ],
  },
  // Soft, non-jarring low double-thud for error notifications
  errorTone: {
    cutoffHz: 560,
    notes: [
      {
        startFreqHz: 207.65,
        freqHz: 196.0,
        wave: "triangle",
        delayMs: 0,
        durationMs: 85,
        gain: 0.034,
      },
      {
        startFreqHz: 164.81,
        freqHz: 146.83,
        wave: "triangle",
        delayMs: 55,
        durationMs: 130,
        gain: 0.036,
      },
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

function createAmbienceBus(ctx: AudioContext, destination: AudioNode, wetAmount: number): AudioNode {
  const dry = ctx.createGain();
  dry.gain.value = 1.0;
  dry.connect(destination);

  if (wetAmount <= 0) return dry;

  const delay = ctx.createDelay(0.25);
  delay.delayTime.value = 0.048;

  const feedback = ctx.createGain();
  feedback.gain.value = 0.22;

  const damp = ctx.createBiquadFilter();
  damp.type = "lowpass";
  damp.frequency.value = 1100;

  const wet = ctx.createGain();
  wet.gain.value = wetAmount;

  dry.connect(delay);
  delay.connect(damp);
  damp.connect(feedback);
  feedback.connect(delay);
  damp.connect(wet);
  wet.connect(destination);

  return dry;
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
  env.gain.exponentialRampToValueAtTime(peak, start + 0.009);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  let target: AudioNode = destination;
  if (note.pan && typeof ctx.createStereoPanner === "function") {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-0.6, Math.min(0.6, note.pan)), start);
    panner.connect(destination);
    target = panner;
  }
  env.connect(target);

  const osc = ctx.createOscillator();
  osc.type = note.wave ?? "sine";
  if (note.startFreqHz && note.startFreqHz > 0) {
    osc.frequency.setValueAtTime(note.startFreqHz, start);
    osc.frequency.exponentialRampToValueAtTime(note.freqHz, start + Math.min(0.06, dur * 0.55));
  } else {
    osc.frequency.setValueAtTime(note.freqHz, start);
  }
  osc.connect(env);
  osc.start(start);
  osc.stop(start + dur + 0.025);

  // Optional detuned stereo/chorus twin for lush warmth
  if (note.detuneCents && note.detuneCents > 0) {
    const twinGain = ctx.createGain();
    twinGain.gain.setValueAtTime(0.3, start);
    twinGain.connect(env);

    const twin = ctx.createOscillator();
    twin.type = note.wave ?? "sine";
    twin.detune.setValueAtTime(note.detuneCents, start);
    if (note.startFreqHz && note.startFreqHz > 0) {
      twin.frequency.setValueAtTime(note.startFreqHz, start);
      twin.frequency.exponentialRampToValueAtTime(note.freqHz, start + Math.min(0.06, dur * 0.55));
    } else {
      twin.frequency.setValueAtTime(note.freqHz, start);
    }
    twin.connect(twinGain);
    twin.start(start);
    twin.stop(start + dur + 0.025);
  }

  // Optional harmonic shimmer overtone
  if (note.harmonicFreqHz && note.harmonicRatio) {
    const overtoneGain = ctx.createGain();
    overtoneGain.gain.setValueAtTime(note.harmonicRatio, start);
    overtoneGain.connect(env);

    const overtone = ctx.createOscillator();
    overtone.type = "triangle";
    overtone.frequency.setValueAtTime(note.harmonicFreqHz, start);
    overtone.connect(overtoneGain);
    overtone.start(start);
    overtone.stop(start + dur + 0.025);
  }

  // Optional tactile micro-transient click/tap
  if (note.transientHz && note.transientGain) {
    const clickEnv = ctx.createGain();
    const clickPeak = Math.max(0.001, note.transientGain * 0.65 * gainScale);
    clickEnv.gain.setValueAtTime(0.0001, start);
    clickEnv.gain.exponentialRampToValueAtTime(clickPeak, start + 0.002);
    clickEnv.gain.exponentialRampToValueAtTime(0.0001, start + 0.015);
    clickEnv.connect(target);

    const clickOsc = ctx.createOscillator();
    clickOsc.type = "triangle";
    clickOsc.frequency.setValueAtTime(note.transientHz, start);
    clickOsc.frequency.exponentialRampToValueAtTime(note.transientHz * 0.45, start + 0.014);
    clickOsc.connect(clickEnv);
    clickOsc.start(start);
    clickOsc.stop(start + 0.02);
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
  const gainScale = moviePlaying ? 0.45 : 0.82;
  const cutoffHz = moviePlaying ? Math.max(460, recipe.cutoffHz - 240) : recipe.cutoffHz;
  const ambienceWet = moviePlaying ? (recipe.ambienceWet ?? 0) * 0.5 : (recipe.ambienceWet ?? 0);

  const fire = () => {
    try {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(cutoffHz, ctx.currentTime);
      filter.Q.setValueAtTime(0.75, ctx.currentTime);
      filter.connect(ctx.destination);

      const bus = createAmbienceBus(ctx, filter, ambienceWet);
      const now = ctx.currentTime + 0.008;
      for (const note of recipe.notes) {
        scheduleNote(ctx, bus, now, note, gainScale);
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
