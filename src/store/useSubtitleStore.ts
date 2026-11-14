import { create } from "zustand";
import type { AutoSyncResult, SubtitleEncodingHint } from "../lib/mpv";

export const SUBTITLE_FONTS = [
  "Noto Sans Arabic",
  "Inter",
  "Segoe UI",
  "Arial",
  "Tahoma",
] as const;

export const SUBTITLE_COLORS = [
  { label: "White", hex: "#FFFFFF" },
  { label: "Warm Gold", hex: "#FDE047" },
  { label: "Cyan", hex: "#67E8F9" },
  { label: "Mint", hex: "#86EFAC" },
] as const;

export const SUBTITLE_ENCODING_OPTIONS: ReadonlyArray<{
  value: SubtitleEncodingHint;
  label: string;
}> = [
  { value: "auto", label: "Auto-detect" },
  { value: "utf8", label: "UTF-8" },
  { value: "windows1256", label: "Arabic (Windows-1256)" },
  { value: "windows1252", label: "Western (Windows-1252)" },
  { value: "windows1251", label: "Cyrillic (Windows-1251)" },
];

function roundToCentisecond(value: number): number {
  return Math.round(value * 100) / 100;
}

interface SubtitleState {
  loadedFilePath: string | null;
  originalFilePath: string | null;
  font: string;
  fontSize: number;
  color: string;
  borderSize: number;
  pos: number;
  visible: boolean;
  overrideAssStyle: boolean;
  encodingHint: SubtitleEncodingHint;
  delaySecs: number;
  autoSyncBusy: boolean;
  autoSyncOutcome: AutoSyncResult | null;
  autoSyncError: string | null;
  setFont: (font: string) => void;
  setFontSize: (fontSize: number) => void;
  setColor: (color: string) => void;
  setBorderSize: (borderSize: number) => void;
  setPos: (pos: number) => void;
  setVisible: (visible: boolean) => void;
  setOverrideAssStyle: (overrideAssStyle: boolean) => void;
  setEncodingHint: (hint: SubtitleEncodingHint) => void;
  setDelaySecs: (delaySecs: number) => void;
  nudgeDelay: (deltaSecs: number) => number;
  setLoadedTrack: (loadedFilePath: string, originalFilePath?: string) => void;
  clearLoadedTrack: () => void;
  setAutoSyncBusy: (busy: boolean) => void;
  setAutoSyncResult: (result: AutoSyncResult | null) => void;
  setAutoSyncError: (err: string | null) => void;
  resetDefaults: () => void;
}

export const useSubtitleStore = create<SubtitleState>((set, get) => ({
  loadedFilePath: null,
  originalFilePath: null,
  font: "Noto Sans Arabic",
  fontSize: 44,
  color: "#FFFFFF",
  borderSize: 2.5,
  pos: 95,
  visible: true,
  overrideAssStyle: false,
  encodingHint: "auto",
  delaySecs: 0,
  autoSyncBusy: false,
  autoSyncOutcome: null,
  autoSyncError: null,

  setFont: (font) => set({ font }),
  setFontSize: (fontSize) => set({ fontSize: Math.max(16, Math.min(96, Math.round(fontSize))) }),
  setColor: (color) => set({ color }),
  setBorderSize: (borderSize) => set({ borderSize: Math.max(0, Math.min(8, Math.round(borderSize * 2) / 2)) }),
  setPos: (pos) => set({ pos: Math.max(5, Math.min(100, Math.round(pos))) }),
  setVisible: (visible) => set({ visible }),
  setOverrideAssStyle: (overrideAssStyle) => set({ overrideAssStyle }),
  setEncodingHint: (encodingHint) => set({ encodingHint }),

  setDelaySecs: (delaySecs) =>
    set({
      delaySecs: Math.max(-600, Math.min(600, roundToCentisecond(delaySecs))),
    }),

  nudgeDelay: (deltaSecs) => {
    const next = Math.max(-600, Math.min(600, roundToCentisecond(get().delaySecs + deltaSecs)));
    set({ delaySecs: next });
    return next;
  },

  setLoadedTrack: (loadedFilePath, originalFilePath) =>
    set((s) => ({
      loadedFilePath,
      originalFilePath: originalFilePath ?? s.originalFilePath ?? loadedFilePath,
      visible: true,
      autoSyncError: null,
    })),

  clearLoadedTrack: () =>
    set({
      loadedFilePath: null,
      originalFilePath: null,
      delaySecs: 0,
      autoSyncOutcome: null,
      autoSyncError: null,
    }),

  setAutoSyncBusy: (autoSyncBusy) => set({ autoSyncBusy }),
  setAutoSyncResult: (autoSyncOutcome) =>
    set({
      autoSyncOutcome,
      autoSyncBusy: false,
      autoSyncError: null,
    }),
  setAutoSyncError: (autoSyncError) => set({ autoSyncError, autoSyncBusy: false }),

  resetDefaults: () =>
    set({
      font: "Noto Sans Arabic",
      fontSize: 44,
      color: "#FFFFFF",
      borderSize: 2.5,
      pos: 95,
      visible: true,
      overrideAssStyle: false,
      encodingHint: "auto",
      delaySecs: 0,
    }),
}));
