import { create } from "zustand";
import { loadJson, saveJson } from "../lib/persist";
import {
  buildEpisodeRatingId,
  computeRatingSummary,
  type PartyEpisodeRatingSummary,
  type RatingVoteEntry,
} from "../lib/ratings";

export interface PersonalEpisodeRating {
  score: number;
  updatedAt: number;
}

const PERSONAL_RATINGS_STORAGE_KEY = "userEpisodeRatings";
const PARTY_RATINGS_STORAGE_KEY = "partyEpisodeRatings";
const MAX_STORED_PARTY_RATINGS = 250;

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

function loadPartyRatings(): Record<string, PartyEpisodeRatingSummary> {
  const raw = loadJson<unknown>(PARTY_RATINGS_STORAGE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, PartyEpisodeRatingSummary> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const rec = v as Partial<PartyEpisodeRatingSummary>;
    if (!Array.isArray(rec.voters) || rec.voters.length === 0) continue;
    const voters: RatingVoteEntry[] = [];
    for (const entry of rec.voters.slice(0, 16)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Partial<RatingVoteEntry>;
      if (typeof e.username !== "string" || typeof e.score !== "number" || !Number.isFinite(e.score)) {
        continue;
      }
      voters.push({
        username: e.username.trim() || "Peer",
        avatarId: typeof e.avatarId === "string" ? e.avatarId : undefined,
        score: Math.max(1, Math.min(10, Math.round(e.score))),
        updatedAt: typeof e.updatedAt === "number" && Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
      });
    }
    if (voters.length === 0) continue;
    const summary = computeRatingSummary(
      Object.fromEntries(voters.map((v) => [v.username.trim().toLowerCase() || "guest", v])),
    );
    out[k] = {
      average: summary.average,
      totalVotes: summary.totalVotes,
      voters: summary.voters,
      updatedAt: typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
    };
  }
  return out;
}

function trimPartyRatings(
  map: Record<string, PartyEpisodeRatingSummary>,
): Record<string, PartyEpisodeRatingSummary> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_STORED_PARTY_RATINGS) return map;
  entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_STORED_PARTY_RATINGS));
}

interface RatingState {
  activeKey: string | null;
  activeTitle: string | null;
  activeFileName: string | null;
  open: boolean;
  manualOpen: boolean;
  dismissedKeys: Record<string, true>;
  votesByKey: Record<string, Record<string, RatingVoteEntry>>;
  myScoreByKey: Record<string, number>;
  mediaIdByKey: Record<string, string>;
  personalByMediaId: Record<string, PersonalEpisodeRating>;
  partyByMediaId: Record<string, PartyEpisodeRatingSummary>;

  openForKey: (key: string, title: string, fileName?: string | null) => void;
  reopenForKey: (
    key: string,
    title: string,
    fileName?: string | null,
    localIdentity?: { username: string; avatarId?: string },
  ) => void;
  close: (dismiss?: boolean) => void;
  castLocalVote: (
    key: string,
    username: string,
    avatarId: string | undefined,
    score: number,
    fileName?: string | null,
  ) => void;
  receivePeerVote: (
    key: string,
    username: string,
    avatarId: string | undefined,
    score: number,
    fileName?: string | null,
  ) => void;
  replacePersonalRatings: (map: Record<string, PersonalEpisodeRating>) => void;
  mergePersonalRatings: (map: Record<string, PersonalEpisodeRating>) => void;
  replacePartyRatings: (map: Record<string, PartyEpisodeRatingSummary>) => void;
  mergePartyRatings: (map: Record<string, PartyEpisodeRatingSummary>) => void;
  resetSession: () => void;
}

function normalizeVoterKey(username: string): string {
  return username.trim().toLowerCase() || "guest";
}

export const useRatingStore = create<RatingState>((set, get) => ({
  activeKey: null,
  activeTitle: null,
  activeFileName: null,
  open: false,
  manualOpen: false,
  dismissedKeys: {},
  votesByKey: {},
  myScoreByKey: {},
  mediaIdByKey: {},
  personalByMediaId: loadPersonalRatings(),
  partyByMediaId: loadPartyRatings(),

  openForKey: (key, title, fileName) => {
    const state = get();
    if (state.dismissedKeys[key]) return;
    if (state.open && state.activeKey === key) return;
    const mediaId = buildEpisodeRatingId(fileName);
    set((s) => ({
      activeKey: key,
      activeTitle: title,
      activeFileName: fileName ?? s.activeFileName,
      open: true,
      manualOpen: false,
      mediaIdByKey: mediaId ? { ...s.mediaIdByKey, [key]: mediaId } : s.mediaIdByKey,
    }));
  },

  reopenForKey: (key, title, fileName, localIdentity) => {
    const state = get();
    const mediaId = buildEpisodeRatingId(fileName) ?? state.mediaIdByKey[key] ?? null;
    const savedPersonal = mediaId ? state.personalByMediaId[mediaId] : undefined;
    const savedParty = mediaId ? state.partyByMediaId[mediaId] : undefined;

    const existingVotes = state.votesByKey[key] ?? {};
    let nextVotes = existingVotes;
    if (Object.keys(existingVotes).length === 0 && savedParty?.voters?.length) {
      nextVotes = Object.fromEntries(
        savedParty.voters.map((v) => [normalizeVoterKey(v.username), v]),
      );
    }

    let nextMyScore = state.myScoreByKey[key];
    if (nextMyScore == null && savedPersonal) {
      nextMyScore = savedPersonal.score;
      if (localIdentity?.username) {
        const voterKey = normalizeVoterKey(localIdentity.username);
        if (!nextVotes[voterKey]) {
          nextVotes = {
            ...nextVotes,
            [voterKey]: {
              username: localIdentity.username.trim() || "You",
              avatarId: localIdentity.avatarId,
              score: savedPersonal.score,
              updatedAt: savedPersonal.updatedAt || Date.now(),
            },
          };
        }
      }
    }

    const nextDismissed = { ...state.dismissedKeys };
    delete nextDismissed[key];

    set((s) => ({
      activeKey: key,
      activeTitle: title,
      activeFileName: fileName ?? null,
      open: true,
      manualOpen: true,
      dismissedKeys: nextDismissed,
      mediaIdByKey: mediaId ? { ...s.mediaIdByKey, [key]: mediaId } : s.mediaIdByKey,
      myScoreByKey:
        nextMyScore != null ? { ...s.myScoreByKey, [key]: nextMyScore } : s.myScoreByKey,
      votesByKey:
        Object.keys(nextVotes).length > 0
          ? { ...s.votesByKey, [key]: nextVotes }
          : s.votesByKey,
    }));
  },

  close: (dismiss = true) => {
    const { activeKey, dismissedKeys } = get();
    set({
      open: false,
      manualOpen: false,
      dismissedKeys:
        dismiss && activeKey ? { ...dismissedKeys, [activeKey]: true } : dismissedKeys,
    });
  },

  castLocalVote: (key, username, avatarId, score, fileName) => {
    const cleanScore = Math.max(1, Math.min(10, Math.round(score)));
    const voterKey = normalizeVoterKey(username);
    const now = Date.now();
    set((s) => {
      const mediaId = buildEpisodeRatingId(fileName) ?? s.mediaIdByKey[key] ?? null;
      const existing = s.votesByKey[key] ?? {};
      const updatedVotes: Record<string, RatingVoteEntry> = {
        ...existing,
        [voterKey]: {
          username: username.trim() || "You",
          avatarId,
          score: cleanScore,
          updatedAt: now,
        },
      };
      let nextPersonal = s.personalByMediaId;
      let nextParty = s.partyByMediaId;
      if (mediaId) {
        nextPersonal = {
          ...s.personalByMediaId,
          [mediaId]: { score: cleanScore, updatedAt: now },
        };
        saveJson(PERSONAL_RATINGS_STORAGE_KEY, nextPersonal);

        const summary = computeRatingSummary(updatedVotes);
        if (summary.totalVotes > 0) {
          nextParty = trimPartyRatings({
            ...s.partyByMediaId,
            [mediaId]: {
              average: summary.average,
              totalVotes: summary.totalVotes,
              voters: summary.voters.slice(0, 16),
              updatedAt: now,
            },
          });
          saveJson(PARTY_RATINGS_STORAGE_KEY, nextParty);
        }
      }
      return {
        myScoreByKey: { ...s.myScoreByKey, [key]: cleanScore },
        mediaIdByKey: mediaId ? { ...s.mediaIdByKey, [key]: mediaId } : s.mediaIdByKey,
        personalByMediaId: nextPersonal,
        partyByMediaId: nextParty,
        votesByKey: {
          ...s.votesByKey,
          [key]: updatedVotes,
        },
      };
    });
  },

  receivePeerVote: (key, username, avatarId, score, fileName) => {
    const cleanScore = Math.max(1, Math.min(10, Math.round(score)));
    const voterKey = normalizeVoterKey(username);
    const now = Date.now();
    set((s) => {
      const mediaId = buildEpisodeRatingId(fileName) ?? s.mediaIdByKey[key] ?? null;
      const existing = s.votesByKey[key] ?? {};
      const updatedVotes: Record<string, RatingVoteEntry> = {
        ...existing,
        [voterKey]: {
          username: username.trim() || "Peer",
          avatarId,
          score: cleanScore,
          updatedAt: now,
        },
      };
      let nextParty = s.partyByMediaId;
      if (mediaId) {
        const summary = computeRatingSummary(updatedVotes);
        if (summary.totalVotes > 0) {
          nextParty = trimPartyRatings({
            ...s.partyByMediaId,
            [mediaId]: {
              average: summary.average,
              totalVotes: summary.totalVotes,
              voters: summary.voters.slice(0, 16),
              updatedAt: now,
            },
          });
          saveJson(PARTY_RATINGS_STORAGE_KEY, nextParty);
        }
      }
      return {
        mediaIdByKey: mediaId ? { ...s.mediaIdByKey, [key]: mediaId } : s.mediaIdByKey,
        partyByMediaId: nextParty,
        votesByKey: {
          ...s.votesByKey,
          [key]: updatedVotes,
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

  replacePartyRatings: (map) => {
    const trimmed = trimPartyRatings(map);
    saveJson(PARTY_RATINGS_STORAGE_KEY, trimmed);
    set({ partyByMediaId: trimmed });
  },

  mergePartyRatings: (map) => {
    set((s) => {
      const merged = { ...s.partyByMediaId };
      for (const [k, incoming] of Object.entries(map)) {
        const existing = merged[k];
        if (!existing || (incoming.updatedAt || 0) >= (existing.updatedAt || 0)) {
          merged[k] = incoming;
        }
      }
      const trimmed = trimPartyRatings(merged);
      saveJson(PARTY_RATINGS_STORAGE_KEY, trimmed);
      return { partyByMediaId: trimmed };
    });
  },

  resetSession: () =>
    set({
      activeKey: null,
      activeTitle: null,
      activeFileName: null,
      open: false,
      manualOpen: false,
      dismissedKeys: {},
      votesByKey: {},
      myScoreByKey: {},
      mediaIdByKey: {},
    }),
}));
