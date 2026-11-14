import { create } from "zustand";

export type NotificationKind = "info" | "success" | "warn" | "error";

export interface NotificationItem {
  id: number;
  kind: NotificationKind;
  message: string;
}

interface NotificationState {
  items: NotificationItem[];
  push: (kind: NotificationKind, message: string, ttlMs?: number) => number;
  dismiss: (id: number) => void;
  clearAll: () => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  push: (kind, message, ttlMs = 5500) => {
    const id = nextId++;
    set((state) => ({
      items: [...state.items.slice(-2), { id, kind, message }],
    }));
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
    const handle = timers.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.delete(id);
    }
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    }));
  },
  clearAll: () => {
    for (const handle of timers.values()) {
      clearTimeout(handle);
    }
    timers.clear();
    set({ items: [] });
  },
}));
