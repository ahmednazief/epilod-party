import { create } from "zustand";
import type { AutoSyncResult, MpvTrack, SubStyleParams, SubtitleEncodingHint } from "../lib/mpv";

function readBoldStorage(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("ep.subBold") === "true";
    }
  } catch {
    // Ignore storage read restrictions
  }
  return false;
}

function writeBoldStorage(enabled: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("ep.subBold", enabled ? "true" : "false");
    }
  } catch {
    // Ignore storage write restrictions
  }
}

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

export const PREFERRED_SUBTITLE_LANG_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "eng", label: "English" },
  { value: "ara", label: "Arabic" },
  { value: "ara,eng", label: "Arabic, fallback English" },
  { value: "eng,ara", label: "English, fallback Arabic" },
  { value: "fre", label: "French" },
  { value: "spa", label: "Spanish" },
  { value: "ger", label: "German" },
  { value: "tur", label: "Turkish" },
  { value: "pob", label: "Portuguese (Brazil)" },
  { value: "por", label: "Portuguese" },
  { value: "ita", label: "Italian" },
  { value: "rus", label: "Russian" },
  { value: "jpn", label: "Japanese" },
  { value: "kor", label: "Korean" },
  { value: "per", label: "Persian" },
];

export const SUBTITLE_SEARCH_LANGUAGES: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "all", label: "All Languages" },
  ...PREFERRED_SUBTITLE_LANG_OPTIONS,
];

const LANG_EQUIV: Record<string, string[]> = {
  eng: ["en", "eng", "english"],
  ara: ["ar", "ara", "arb", "arabic"],
  fre: ["fr", "fre", "fra", "french"],
  spa: ["es", "spa", "spanish"],
  ger: ["de", "ger", "deu", "german"],
  tur: ["tr", "tur", "turkish"],
  por: ["pt", "por", "portuguese"],
  pob: ["pt", "pob", "pt-br", "portuguese"],
  ita: ["it", "ita", "italian"],
  rus: ["ru", "rus", "russian"],
  jpn: ["ja", "jpn", "japanese"],
  kor: ["ko", "kor", "korean"],
  chi: ["zh", "chi", "zho", "zhs", "zht", "chinese"],
  per: ["fa", "per", "fas", "persian", "farsi"],
};

export function hasMatchingSubtitleTrack(
  tracks: readonly MpvTrack[],
  preferredLangsCsv: string,
  detectedLangs?: Record<number, string>,
): boolean {
  const subs = tracks.filter((t) => t.type === "sub");
  if (subs.length === 0) return false;
  const targets = preferredLangsCsv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== "all");
  if (targets.length === 0) return subs.length > 0;

  return subs.some((t) => {
    const tagged = (t.lang ?? "").trim().toLowerCase();
    const detected = (detectedLangs?.[t.id] ?? "").trim().toLowerCase();
    const raw = tagged && tagged !== "und" && tagged !== "unknown" ? tagged : detected;
    const title = (t.title ?? "").trim().toLowerCase();
    return targets.some((target) => {
      const aliases = LANG_EQUIV[target] ?? [target];
      return aliases.includes(raw) || aliases.some((a) => a.length >= 3 && title.includes(a));
    });
  });
}

export function deriveCleanSearchQuery(filenameOrPath: string | null | undefined): string {
  if (!filenameOrPath) return "";
  const base = filenameOrPath.split(/[/\\]/).pop() ?? filenameOrPath;
  const stem = base.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|mpg|mpeg)$/i, "");
  const stripped = stem
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?!\d{4}\))[^)]*\)/g, " ")
    .replace(/[._|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const epMatch = /\b(S\d{1,2}E\d{1,3}|\d{1,2}x\d{1,3})\b/i.exec(stripped);
  if (epMatch && epMatch.index > 0) {
    return `${stripped.slice(0, epMatch.index).trim()} ${epMatch[1].toUpperCase()}`.trim();
  }
  const noiseMatch = /\b(2160p|1080p|720p|480p|4k|uhd|bluray|bdrip|brrip|web-dl|webdl|webrip|hdrip|dvdrip|hdtv|x264|x265|h264|h265|hevc|10bit|hdr|yify|yts|rarbg)\b/i.exec(
    stripped,
  );
  if (noiseMatch && noiseMatch.index > 1) {
    return stripped.slice(0, noiseMatch.index).trim();
  }
  return stripped.replace(/[()]/g, "").trim();
}

export type AutoFetchStatus = "idle" | "searching" | "loaded" | "none" | "error";

function roundToCentisecond(value: number): number {
  return Math.round(value * 100) / 100;
}

interface SubtitleState {
  loadedFilePath: string | null;
  originalFilePath: string | null;
  font: string;
  bold: boolean;
  fontSize: number;
  color: string;
  borderSize: number;
  pos: number;
  visible: boolean;
  overrideAssStyle: boolean;
  encodingHint: SubtitleEncodingHint;
  delaySecs: number;
  sessionGen: number;
  autoSyncBusy: boolean;
  autoSyncOutcome: AutoSyncResult | null;
  autoSyncError: string | null;
  autoFetchStatus: AutoFetchStatus;
  autoFetchMessage: string | null;
  setFont: (font: string) => void;
  setBold: (bold: boolean) => void;
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
  setAutoFetchState: (status: AutoFetchStatus, message?: string | null) => void;
  resetDefaults: () => void;
}

export function buildSubStyleParams(
  s: Pick<
    SubtitleState,
    "font" | "bold" | "fontSize" | "color" | "borderSize" | "pos" | "visible" | "overrideAssStyle"
  >,
  overrides?: Partial<Pick<SubStyleParams, "visible" | "overrideAss" | "bold">>,
): SubStyleParams {
  return {
    font: s.font,
    bold: overrides?.bold ?? s.bold,
    fontSize: s.fontSize,
    color: s.color,
    borderSize: s.borderSize,
    pos: s.pos,
    visible: overrides?.visible ?? s.visible,
    overrideAss: overrides?.overrideAss ?? s.overrideAssStyle,
  };
}

export const useSubtitleStore = create<SubtitleState>((set, get) => ({
  loadedFilePath: null,
  originalFilePath: null,
  font: "Noto Sans Arabic",
  bold: readBoldStorage(),
  fontSize: 44,
  color: "#FFFFFF",
  borderSize: 2.5,
  pos: 95,
  visible: true,
  overrideAssStyle: false,
  encodingHint: "auto",
  delaySecs: 0,
  sessionGen: 0,
  autoSyncBusy: false,
  autoSyncOutcome: null,
  autoSyncError: null,
  autoFetchStatus: "idle",
  autoFetchMessage: null,

  setFont: (font) => set({ font }),
  setBold: (bold) => {
    writeBoldStorage(bold);
    set({ bold });
  },
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
    set((s) => ({
      loadedFilePath: null,
      originalFilePath: null,
      delaySecs: 0,
      sessionGen: s.sessionGen + 1,
      autoSyncBusy: false,
      autoSyncOutcome: null,
      autoSyncError: null,
      autoFetchStatus: "idle",
      autoFetchMessage: null,
    })),

  setAutoSyncBusy: (autoSyncBusy) => set({ autoSyncBusy }),
  setAutoSyncResult: (autoSyncOutcome) =>
    set({
      autoSyncOutcome,
      autoSyncBusy: false,
      autoSyncError: null,
    }),
  setAutoSyncError: (autoSyncError) => set({ autoSyncError, autoSyncBusy: false }),
  setAutoFetchState: (autoFetchStatus, autoFetchMessage = null) =>
    set({ autoFetchStatus, autoFetchMessage }),

  resetDefaults: () => {
    writeBoldStorage(false);
    set({
      font: "Noto Sans Arabic",
      bold: false,
      fontSize: 44,
      color: "#FFFFFF",
      borderSize: 2.5,
      pos: 95,
      visible: true,
      overrideAssStyle: false,
      encodingHint: "auto",
      delaySecs: 0,
    });
  },
}));
