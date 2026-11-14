import { create } from "zustand";
import type { Participant, SyncStatusPayload } from "../lib/syncplay";

interface SyncState {
  status: SyncStatusPayload;
  participants: Participant[];
  localReady: boolean;
  lastError: string | null;
  serverOverrideNotice: string | null;
  setStatus: (status: SyncStatusPayload) => void;
  setParticipants: (participants: Participant[]) => void;
  setLocalReady: (ready: boolean) => void;
  setLastError: (err: string | null) => void;
  setServerOverrideNotice: (notice: string | null) => void;
  reset: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: { state: "disconnected" },
  participants: [],
  // Fix 08: never claim Ready before media is loaded
  localReady: false,
  lastError: null,
  serverOverrideNotice: null,

  setStatus: (status) => set({ status }),
  setParticipants: (participants) => set({ participants }),
  setLocalReady: (localReady) => set({ localReady }),
  setLastError: (lastError) => set({ lastError }),
  setServerOverrideNotice: (serverOverrideNotice) => set({ serverOverrideNotice }),

  reset: () =>
    set({
      status: { state: "disconnected" },
      participants: [],
      localReady: false,
      lastError: null,
      serverOverrideNotice: null,
    }),
}));
