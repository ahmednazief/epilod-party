import { create } from "zustand";
import { playSoundCue } from "../lib/soundEffects";
import { usePlayerStore } from "./usePlayerStore";

export type NotificationKind = "info" | "success" | "warn" | "error";

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface NotificationItem {
  id: number;
  kind: NotificationKind;
  message: string;
  tag?: string;
  action?: NotificationAction;
}

interface NotificationState {
  items: NotificationItem[];
  push: (
    kind: NotificationKind,
    message: string,
    ttlMs?: number,
    tag?: string,
    action?: NotificationAction,
  ) => number;
  dismiss: (id: number) => void;
  dismissByTag: (tag: string) => void;
  dismissByTagPrefix: (prefix: string) => void;
  clearAll: () => void;
}

let nextId = 1;
let lastErrorToneAtMs = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number): void {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

export const useNotificationStore = create<NotificationState>((set, get) => {
  const dismissMatching = (predicate: (item: NotificationItem) => boolean) => {
    const items = get().items;
    const matchingIds = items.filter(predicate).map((item) => item.id);
    if (matchingIds.length === 0) return;
    for (const id of matchingIds) {
      clearTimer(id);
    }
    const idSet = new Set(matchingIds);
    set((state) => ({
      items: state.items.filter((item) => !idSet.has(item.id)),
    }));
  };

  return {
    items: [],
    push: (kind, message, ttlMs = 5500, tag, action) => {
      const existing = get().items.find(
        (item) => (tag ? item.tag === tag : item.kind === kind && item.message === message),
      );
      const id = existing ? existing.id : nextId++;
      if (existing) {
        clearTimer(id);
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id ? { id, kind, message, tag, action } : item,
          ),
        }));
      } else {
        set((state) => ({
          items: [...state.items.slice(-2), { id, kind, message, tag, action }],
        }));
      }
      if (kind === "error") {
        const nowMs = Date.now();
        if (nowMs - lastErrorToneAtMs >= 1500) {
          lastErrorToneAtMs = nowMs;
          const player = usePlayerStore.getState();
          playSoundCue("errorTone", { moviePlaying: player.loaded && !player.paused });
        }
      }
      if (ttlMs > 0) {
        const handle = setTimeout(() => {
          timers.delete(id);
          set((state) => ({
            items: state.items.filter((item) => item.id !== id),
          }));
        }, ttlMs);
        timers.set(id, handle);
      }
      return id;
    },
    dismiss: (id) => {
      clearTimer(id);
      set((state) => ({
        items: state.items.filter((item) => item.id !== id),
      }));
    },
    dismissByTag: (tag) => dismissMatching((item) => item.tag === tag),
    dismissByTagPrefix: (prefix) => dismissMatching((item) => Boolean(item.tag?.startsWith(prefix))),
    clearAll: () => {
      for (const handle of timers.values()) {
        clearTimeout(handle);
      }
      timers.clear();
      set({ items: [] });
    },
  };
});
