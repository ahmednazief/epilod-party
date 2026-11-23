import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persist";
import { buildEpisodeRatingId, type RatingVoteEntry } from "../lib/ratings";

export interface PersonalEpisodeRating {
  score: number;
  updatedAt: number;
}

const PERSONAL_RATINGS_STORAGE_KEY = "userEpisodeRatings";

function loadPersonalRatings(): Record<string, PersonalEpisodeRating> {
  const raw = loadJson<unknown>(PERSONAL_RATINGS_STORAGE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, PersonalEpisodeRating> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const rec = v as Partial<PersonalEpisodeRating>;
    if (typeof rec.score !== "number" || !Number.isFinite(rec.score)) continue;
    out[k] = {
      score: Math.max(1, Math.min(10, Math.round(rec.score))),
      updatedAt: typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
    };
  }
  return out;
}

interface RatingState {
  activeKey: string | null;
  activeTitle: string | null;
  open: boolean;
  dismissedKeys: Record<string, true>;
  votesByKey: Record<string, Record<string, RatingVoteEntry>>;
  myScoreByKey: Record<string, number>;
  personalByMediaId: Record<string, PersonalEpisodeRating>;

  openForKey: (key: string, title: string) => void;
  close: (dismiss?: boolean) => void;
  castLocalVote: (
    key: string,
    username: string,
    avatarId: string | undefined,
    score: number,
    fileName?: string | null,
  ) => void;
  receivePeerVote: (key: string, username: string, avatarId: string | undefined, score: number) => void;
  replacePersonalRatings: (map: Record<string, PersonalEpisodeRating>) => void;
  mergePersonalRatings: (map: Record<string, PersonalEpisodeRating>) => void;
  resetSession: () => void;
}

function normalizeVoterKey(username: string): string {
  return username.trim().toLowerCase() || "guest";
}

export const useRatingStore = create<RatingState>((set, get) => ({
  activeKey: null,
  activeTitle: null,
  open: false,
  dismissedKeys: {},
  votesByKey: {},
  myScoreByKey: {},
  personalByMediaId: loadPersonalRatings(),

  openForKey: (key, title) => {
    const state = get();
    if (state.dismissedKeys[key]) return;
    if (state.open && state.activeKey === key) return;
    set({ activeKey: key, activeTitle: title, open: true });
  },

  close: (dismiss = true) => {
    const { activeKey, dismissedKeys } = get();
    set({
      open: false,
      dismissedKeys:
        dismiss && activeKey ? { ...dismissedKeys, [activeKey]: true } : dismissedKeys,
    });
  },

  castLocalVote: (key, username, avatarId, score, fileName) => {
    const cleanScore = Math.max(1, Math.min(10, Math.round(score)));
    const voterKey = normalizeVoterKey(username);
    const mediaId = buildEpisodeRatingId(fileName);
    set((s) => {
      const existing = s.votesByKey[key] ?? {};
      let nextPersonal = s.personalByMediaId;
      if (mediaId) {
        nextPersonal = {
          ...s.personalByMediaId,
          [mediaId]: { score: cleanScore, updatedAt: Date.now() },
        };
        saveJson(PERSONAL_RATINGS_STORAGE_KEY, nextPersonal);
      }
      return {
        myScoreByKey: { ...s.myScoreByKey, [key]: cleanScore },
        personalByMediaId: nextPersonal,
        votesByKey: {
          ...s.votesByKey,
          [key]: {
            ...existing,
            [voterKey]: {
              username: username.trim() || "You",
              avatarId,
              score: cleanScore,
              updatedAt: Date.now(),
            },
          },
        },
      };
    });
  },

  receivePeerVote: (key, username, avatarId, score) => {
    const cleanScore = Math.max(1, Math.min(10, Math.round(score)));
    const voterKey = normalizeVoterKey(username);
    set((s) => {
      const existing = s.votesByKey[key] ?? {};
      return {
        votesByKey: {
          ...s.votesByKey,
          [key]: {
            ...existing,
            [voterKey]: {
              username: username.trim() || "Peer",
              avatarId,
              score: cleanScore,
              updatedAt: Date.now(),
            },
          },
        },
      };
    });
  },

  replacePersonalRatings: (map) => {
    saveJson(PERSONAL_RATINGS_STORAGE_KEY, map);
    set({ personalByMediaId: map });
  },

  mergePersonalRatings: (map) => {
    set((s) => {
      const merged = { ...s.personalByMediaId };
      for (const [k, incoming] of Object.entries(map)) {
        const existing = merged[k];
        if (!existing || (incoming.updatedAt || 0) >= (existing.updatedAt || 0)) {
          merged[k] = incoming;
        }
      }
      saveJson(PERSONAL_RATINGS_STORAGE_KEY, merged);
      return { personalByMediaId: merged };
    });
  },

  resetSession: () =>
    set({
      activeKey: null,
      activeTitle: null,
      open: false,
      dismissedKeys: {},
      votesByKey: {},
      myScoreByKey: {},
    }),
}));
