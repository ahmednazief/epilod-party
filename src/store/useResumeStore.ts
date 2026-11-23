import { create } from "zustand";
import { loadJson, saveJson, trimLruMap } from "../lib/persist";
import {
  RESUME_MAX_ENTRIES,
  shouldSaveResumePosition,
  type ResumeEntry,
} from "../lib/resume";

const STORAGE_KEY = "resumePositions";

interface ResumeSaveMeta {
  filePath?: string | null;
  fileName?: string | null;
  linkedRoomId?: string | null;
}

interface ResumeState {
  entries: Record<string, ResumeEntry>;
  savePosition: (
    fileKey: string,
    positionSecs: number,
    durationSecs: number,
    meta?: ResumeSaveMeta,
  ) => void;
  getPosition: (fileKey: string) => ResumeEntry | null;
  removePosition: (fileKey: string) => void;
  hydrateEntries: (entries: Record<string, ResumeEntry>) => void;
  clearAll: () => void;
}

export const useResumeStore = create<ResumeState>((set, get) => ({
  entries: loadJson<Record<string, ResumeEntry>>(STORAGE_KEY, {}),

  savePosition: (fileKey, positionSecs, durationSecs, meta) => {
    if (!fileKey) return;
    const action = shouldSaveResumePosition(positionSecs, durationSecs);
    if (action === "skip") return;
    if (action === "clear") {
      if (get().entries[fileKey]) {
        get().removePosition(fileKey);
      }
      return;
    }
    const existing = get().entries[fileKey];
    const cleanPath = meta?.filePath?.trim() || existing?.filePath;
    const cleanName = meta?.fileName?.trim() || existing?.fileName;
    const cleanRoomId = meta?.linkedRoomId?.trim() || existing?.linkedRoomId;
    const entry: ResumeEntry = {
      positionSecs: Math.floor(positionSecs),
      durationSecs: Math.round(durationSecs),
      updatedAt: Date.now(),
      ...(cleanPath ? { filePath: cleanPath } : {}),
      ...(cleanName ? { fileName: cleanName } : {}),
      ...(cleanRoomId ? { linkedRoomId: cleanRoomId } : {}),
    };
    const next = trimLruMap(
      {
        ...get().entries,
        [fileKey]: entry,
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

  hydrateEntries: (entries) => {
    const clean = trimLruMap(entries, RESUME_MAX_ENTRIES);
    saveJson(STORAGE_KEY, clean);
    set({ entries: clean });
  },

  clearAll: () => {
    saveJson(STORAGE_KEY, {});
    set({ entries: {} });
  },
}));
