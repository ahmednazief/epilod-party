import { create } from "zustand";
import { loadJson, saveJson, trimLruMap } from "../lib/persist";
import {
  RESUME_MAX_ENTRIES,
  shouldSaveResumePosition,
  type ResumeEntry,
} from "../lib/resume";

const STORAGE_KEY = "resumePositions";

interface ResumeState {
  entries: Record<string, ResumeEntry>;
  savePosition: (fileKey: string, positionSecs: number, durationSecs: number) => void;
  getPosition: (fileKey: string) => ResumeEntry | null;
  removePosition: (fileKey: string) => void;
  clearAll: () => void;
}

export const useResumeStore = create<ResumeState>((set, get) => ({
  entries: loadJson<Record<string, ResumeEntry>>(STORAGE_KEY, {}),

  savePosition: (fileKey, positionSecs, durationSecs) => {
    if (!fileKey) return;
    const action = shouldSaveResumePosition(positionSecs, durationSecs);
    if (action === "skip") return;
    if (action === "clear") {
      if (get().entries[fileKey]) {
        get().removePosition(fileKey);
      }
      return;
    }
    const next = trimLruMap(
      {
        ...get().entries,
        [fileKey]: {
          positionSecs: Math.floor(positionSecs),
          durationSecs: Math.round(durationSecs),
          updatedAt: Date.now(),
        },
      },
      RESUME_MAX_ENTRIES,
    );
    saveJson(STORAGE_KEY, next);
    set({ entries: next });
  },

  getPosition: (fileKey) => {
    if (!fileKey) return null;
    return get().entries[fileKey] ?? null;
  },

  removePosition: (fileKey) => {
    if (!fileKey || !get().entries[fileKey]) return;
    const next = { ...get().entries };
    delete next[fileKey];
    saveJson(STORAGE_KEY, next);
    set({ entries: next });
  },

  clearAll: () => {
    saveJson(STORAGE_KEY, {});
    set({ entries: {} });
  },
}));
