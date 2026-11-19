import { create } from "zustand";
import {
  sanitizeTimelineTransform,
  type SceneAnchor,
  type TimelineSegment,
  type TimelineTransform,
} from "../lib/sourceAlignment";
import { EMPTY_ROOM_CONTROL } from "../lib/syncController";
import type {
  P2pStatusPayload,
  Participant,
  RoomControlState,
  SyncStatusPayload,
} from "../lib/syncplay";

interface SyncState {
  status: SyncStatusPayload;
  participants: Participant[];
  roomControl: RoomControlState;
  localReady: boolean;
  lastError: string | null;
  serverOverrideNotice: string | null;
  dismissedMismatchSig: string | null;
  undoneMismatchSigs: string[];
  autoFixedMismatchSigs: string[];
  timelineOffsetSecs: number;
  timelineScale: number;
  timelineSegments: TimelineSegment[];
  p2pStatus: P2pStatusPayload | null;
  alignMode: boolean;
  alignAnchor1: SceneAnchor | null;
  liveRoomPositionSecs: number;
  liveRoomPaused: boolean;
  setStatus: (status: SyncStatusPayload) => void;
  setParticipants: (participants: Participant[]) => void;
  setRoomControl: (roomControl: RoomControlState) => void;
  setLocalReady: (ready: boolean) => void;
  setLastError: (err: string | null) => void;
  setServerOverrideNotice: (notice: string | null) => void;
  setDismissedMismatchSig: (sig: string | null) => void;
  markMismatchSigUndone: (sig: string) => void;
  markMismatchSigAutoFixed: (sig: string) => void;
  setTimelineTransform: (tx: Partial<TimelineTransform>) => void;
  setTimelineSegments: (segments: TimelineSegment[]) => void;
  setP2pStatus: (p2p: P2pStatusPayload | null) => void;
  setAlignMode: (enabled: boolean) => void;
  setAlignAnchor1: (anchor: SceneAnchor | null) => void;
  setLiveRoomState: (position: number, paused: boolean) => void;
  resetTimelineAlignment: () => void;
  reset: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: { state: "disconnected" },
  participants: [],
  roomControl: { ...EMPTY_ROOM_CONTROL, adminUsernames: [] },
  // Fix 08: never claim Ready before media is loaded
  localReady: false,
  lastError: null,
  serverOverrideNotice: null,
  dismissedMismatchSig: null,
  undoneMismatchSigs: [],
  autoFixedMismatchSigs: [],
  timelineOffsetSecs: 0,
  timelineScale: 1.0,
  timelineSegments: [],
  p2pStatus: null,
  alignMode: false,
  alignAnchor1: null,
  liveRoomPositionSecs: 0,
  liveRoomPaused: true,

  setStatus: (status) => set({ status }),
  setParticipants: (participants) => set({ participants }),
  setRoomControl: (roomControl) => set({ roomControl }),
  setLocalReady: (localReady) => set({ localReady }),
  setLastError: (lastError) => set({ lastError }),
  setServerOverrideNotice: (serverOverrideNotice) => set({ serverOverrideNotice }),
  setDismissedMismatchSig: (dismissedMismatchSig) => set({ dismissedMismatchSig }),
  markMismatchSigUndone: (sig) =>
    set((s) => ({
      undoneMismatchSigs: s.undoneMismatchSigs.includes(sig)
        ? s.undoneMismatchSigs
        : [...s.undoneMismatchSigs, sig],
    })),
  markMismatchSigAutoFixed: (sig) =>
    set((s) => ({
      autoFixedMismatchSigs: s.autoFixedMismatchSigs.includes(sig)
        ? s.autoFixedMismatchSigs
        : [...s.autoFixedMismatchSigs, sig],
    })),
  setTimelineTransform: (tx) =>
    set((s) => {
      const clean = sanitizeTimelineTransform({
        offsetSecs: tx.offsetSecs ?? s.timelineOffsetSecs,
        scale: tx.scale ?? s.timelineScale,
      });
      return {
        timelineOffsetSecs: clean.offsetSecs,
        timelineScale: clean.scale,
      };
    }),
  setTimelineSegments: (timelineSegments) => set({ timelineSegments }),
  setP2pStatus: (p2pStatus) => set({ p2pStatus }),
  setAlignMode: (alignMode) => set({ alignMode }),
  setAlignAnchor1: (alignAnchor1) => set({ alignAnchor1 }),
  setLiveRoomState: (liveRoomPositionSecs, liveRoomPaused) =>
    set({
      liveRoomPositionSecs:
        Number.isFinite(liveRoomPositionSecs) && liveRoomPositionSecs >= 0
          ? liveRoomPositionSecs
          : 0,
      liveRoomPaused,
    }),
  resetTimelineAlignment: () =>
    set({
      timelineOffsetSecs: 0,
      timelineScale: 1.0,
      timelineSegments: [],
      alignMode: false,
      alignAnchor1: null,
    }),

  reset: () =>
    set({
      status: { state: "disconnected" },
      participants: [],
      roomControl: { ...EMPTY_ROOM_CONTROL, adminUsernames: [] },
      localReady: false,
      lastError: null,
      serverOverrideNotice: null,
      dismissedMismatchSig: null,
      undoneMismatchSigs: [],
      autoFixedMismatchSigs: [],
      timelineOffsetSecs: 0,
      timelineScale: 1.0,
      timelineSegments: [],
      p2pStatus: null,
      alignMode: false,
      alignAnchor1: null,
      liveRoomPositionSecs: 0,
      liveRoomPaused: true,
    }),
}));
