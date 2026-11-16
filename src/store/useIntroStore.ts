import { create } from "zustand";
import type {
  DetectedIntro,
  IntroDetectionOutcome,
  MpvChapter,
} from "../lib/mpv";

const INTRO_CACHE_STORAGE_KEY = "ep.introCache.v1";
const MANUAL_CACHE_STORAGE_KEY = "ep.manualIntroCache.v1";
const MAX_CACHED_VIDEOS = 64;

export interface ManualIntroBounds {
  startSecs: number;
  endSecs: number | null;
}

interface CachedVideoIntro {
  segments: DetectedIntro[];
  updatedAt: number;
}

type IntroCacheMap = Record<string, CachedVideoIntro>;
type ManualCacheMap = Record<string, ManualIntroBounds>;

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage quota errors
  }
}

export function normalizeIntroVideoKey(videoPath: string | null | undefined): string {
  return (videoPath ?? "").trim().toLowerCase();
}

export function buildIntroSegmentKey(
  videoKey: string | null,
  seg: Pick<DetectedIntro, "kind" | "startSecs" | "skipTargetSecs">
): string {
  return `${videoKey ?? ""}::${seg.kind}::${Math.round(seg.startSecs * 10)}::${Math.round(
    seg.skipTargetSecs * 10
  )}`;
}

export function getEffectiveIntroSegments(
  segments: DetectedIntro[],
  manualIntro: ManualIntroBounds | null
): DetectedIntro[] {
  if (
    manualIntro &&
    manualIntro.endSecs !== null &&
    Number.isFinite(manualIntro.startSecs) &&
    Number.isFinite(manualIntro.endSecs) &&
    manualIntro.endSecs > manualIntro.startSecs + 2
  ) {
    return [
      {
        startSecs: manualIntro.startSecs,
        endSecs: manualIntro.endSecs,
        skipTargetSecs: manualIntro.endSecs,
        kind: "intro",
        source: "manual",
        confidence: "high",
        label: "Skip Intro",
        similarity: null,
        matchedEpisodes: 1,
      },
    ];
  }
  return segments;
}

function loadCachedSegmentsForKey(key: string): DetectedIntro[] {
  if (!key) return [];
  const cache = readJsonStorage<IntroCacheMap>(INTRO_CACHE_STORAGE_KEY, {});
  const entry = cache[key];
  if (!entry || !Array.isArray(entry.segments)) return [];
  return entry.segments.filter(
    (s) =>
      s &&
      typeof s.startSecs === "number" &&
      typeof s.endSecs === "number" &&
      typeof s.skipTargetSecs === "number" &&
      s.endSecs > s.startSecs
  );
}

function saveCachedSegmentsForKey(key: string, segments: DetectedIntro[]): void {
  if (!key || segments.length === 0) return;
  const cache = readJsonStorage<IntroCacheMap>(INTRO_CACHE_STORAGE_KEY, {});
  cache[key] = { segments, updatedAt: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHED_VIDEOS) {
    keys.sort((a, b) => (cache[a]?.updatedAt ?? 0) - (cache[b]?.updatedAt ?? 0));
    for (const stale of keys.slice(0, keys.length - MAX_CACHED_VIDEOS)) {
      delete cache[stale];
    }
  }
  writeJsonStorage(INTRO_CACHE_STORAGE_KEY, cache);
}

function loadManualForKey(key: string): ManualIntroBounds | null {
  if (!key) return null;
  const map = readJsonStorage<ManualCacheMap>(MANUAL_CACHE_STORAGE_KEY, {});
  const entry = map[key];
  if (
    !entry ||
    typeof entry.startSecs !== "number" ||
    typeof entry.endSecs !== "number" ||
    entry.endSecs <= entry.startSecs + 2
  ) {
    return null;
  }
  return entry;
}

function saveManualForKey(key: string, bounds: ManualIntroBounds | null): void {
  if (!key) return;
  const map = readJsonStorage<ManualCacheMap>(MANUAL_CACHE_STORAGE_KEY, {});
  if (!bounds || bounds.endSecs === null || bounds.endSecs <= bounds.startSecs + 2) {
    delete map[key];
  } else {
    map[key] = bounds;
    const keys = Object.keys(map);
    if (keys.length > MAX_CACHED_VIDEOS) {
      for (const stale of keys.slice(0, keys.length - MAX_CACHED_VIDEOS)) {
        delete map[stale];
      }
    }
  }
  writeJsonStorage(MANUAL_CACHE_STORAGE_KEY, map);
}

interface IntroState {
  videoKey: string | null;
  chapters: MpvChapter[];
  detecting: boolean;
  segments: DetectedIntro[];
  manualIntro: ManualIntroBounds | null;
  dismissedKeys: string[];
  autoSkippedKeys: string[];

  resetForVideo: (videoPath?: string | null) => void;
  setChapters: (chapters: MpvChapter[]) => void;
  setDetecting: (detecting: boolean) => void;
  setDetectedOutcome: (videoPath: string | null, outcome: IntroDetectionOutcome) => void;
  markManualStart: (startSecs: number) => void;
  markManualEnd: (endSecs: number) => void;
  setManualIntro: (startSecs: number, endSecs: number) => void;
  clearManualIntro: () => void;
  dismissSegment: (segKey: string) => void;
  markAutoSkipped: (segKey: string) => void;
}

export const useIntroStore = create<IntroState>((set, get) => ({
  videoKey: null,
  chapters: [],
  detecting: false,
  segments: [],
  manualIntro: null,
  dismissedKeys: [],
  autoSkippedKeys: [],

  resetForVideo: (videoPath = null) => {
    const key = normalizeIntroVideoKey(videoPath);
    set({
      videoKey: key || null,
      chapters: [],
      detecting: false,
      segments: loadCachedSegmentsForKey(key),
      manualIntro: loadManualForKey(key),
      dismissedKeys: [],
      autoSkippedKeys: [],
    });
  },

  setChapters: (chapters) => set({ chapters }),

  setDetecting: (detecting) => set({ detecting }),

  setDetectedOutcome: (videoPath, outcome) => {
    const targetKey = normalizeIntroVideoKey(videoPath);
    const segments = Array.isArray(outcome.segments) ? outcome.segments : [];
    if (targetKey && segments.length > 0) {
      saveCachedSegmentsForKey(targetKey, segments);
    }
    const currentKey = get().videoKey ?? "";
    if (targetKey && currentKey && targetKey !== currentKey) {
      return;
    }
    set({ segments, detecting: false });
  },

  markManualStart: (startSecs) => {
    if (!Number.isFinite(startSecs) || startSecs < 0) return;
    const prev = get().manualIntro;
    const clampedEnd =
      prev?.endSecs !== null && prev?.endSecs !== undefined && prev.endSecs > startSecs + 2
        ? prev.endSecs
        : null;
    const next: ManualIntroBounds = { startSecs, endSecs: clampedEnd };
    const key = get().videoKey;
    if (key) saveManualForKey(key, next);
    set({ manualIntro: next, dismissedKeys: [], autoSkippedKeys: [] });
  },

  markManualEnd: (endSecs) => {
    if (!Number.isFinite(endSecs) || endSecs <= 0) return;
    const prev = get().manualIntro;
    const startSecs =
      prev && Number.isFinite(prev.startSecs) && prev.startSecs < endSecs - 2
        ? prev.startSecs
        : Math.max(0, endSecs - 90);
    const next: ManualIntroBounds = { startSecs, endSecs };
    const key = get().videoKey;
    if (key) saveManualForKey(key, next);
    set({ manualIntro: next, dismissedKeys: [], autoSkippedKeys: [] });
  },

  setManualIntro: (startSecs, endSecs) => {
    if (!Number.isFinite(startSecs) || !Number.isFinite(endSecs) || endSecs <= startSecs + 2) {
      return;
    }
    const next: ManualIntroBounds = { startSecs: Math.max(0, startSecs), endSecs };
    const key = get().videoKey;
    if (key) saveManualForKey(key, next);
    set({ manualIntro: next, dismissedKeys: [], autoSkippedKeys: [] });
  },

  clearManualIntro: () => {
    const key = get().videoKey;
    if (key) saveManualForKey(key, null);
    set({ manualIntro: null, dismissedKeys: [], autoSkippedKeys: [] });
  },

  dismissSegment: (segKey) =>
    set((s) =>
      s.dismissedKeys.includes(segKey)
        ? s
        : { dismissedKeys: [...s.dismissedKeys, segKey] }
    ),

  markAutoSkipped: (segKey) =>
    set((s) =>
      s.autoSkippedKeys.includes(segKey)
        ? s
        : { autoSkippedKeys: [...s.autoSkippedKeys, segKey] }
    ),
}));
