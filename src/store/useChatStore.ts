import { create } from "zustand";

export type ChatTransportVia = "local" | "p2p" | "p2pRelay" | "syncplay" | "system";

export interface ChatMessage {
  id: string;
  kind: "message" | "system";
  sender: string;
  avatarId: string;
  text: string;
  replyToId: string | null;
  isSelf: boolean;
  timestampMs: number;
  editedAtMs: number | null;
  reactions: Record<string, string[]>;
  via: ChatTransportVia;
}

export interface ChatPeekItem {
  id: string;
  sender: string;
  avatarId: string;
  text: string;
  isMention: boolean;
  createdAtMs: number;
  expiresAtMs: number;
}

const MAX_CHAT_MESSAGES = 300;
const MAX_CHAT_PEEKS = 3;
const CHAT_PEEK_TTL_MS = 5200;
const TYPING_TTL_MS = 4200;
export const MIN_CHAT_SIDEBAR_WIDTH = 320;
export const MAX_CHAT_SIDEBAR_WIDTH = 560;
export const DEFAULT_CHAT_SIDEBAR_WIDTH = 440;

function readStoredSidebarWidth(): number {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = Number(localStorage.getItem("ep.chatWidth.v2"));
      if (Number.isFinite(raw)) {
        return Math.max(MIN_CHAT_SIDEBAR_WIDTH, Math.min(MAX_CHAT_SIDEBAR_WIDTH, Math.round(raw)));
      }
    }
  } catch {
    // Ignore storage read restrictions
  }
  return DEFAULT_CHAT_SIDEBAR_WIDTH;
}

function writeStoredSidebarWidth(width: number): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("ep.chatWidth.v2", String(width));
    }
  } catch {
    // Ignore storage write restrictions
  }
}

interface ChatState {
  messages: ChatMessage[];
  unreadCount: number;
  unreadSinceId: string | null;
  chatOpen: boolean;
  replyToId: string | null;
  editingMsgId: string | null;
  typingPeers: Record<string, number>;
  peeks: ChatPeekItem[];
  sidebarWidth: number;
  setChatOpen: (open: boolean) => void;
  setReplyToId: (id: string | null) => void;
  setEditingMsgId: (id: string | null) => void;
  setSidebarWidth: (width: number) => void;
  appendLocalMessage: (msg: {
    id: string;
    sender: string;
    avatarId: string;
    text: string;
    replyToId?: string | null;
    timestampMs?: number;
  }) => void;
  receiveRemoteMessage: (
    msg: {
      id: string;
      sender: string;
      avatarId: string;
      text: string;
      replyToId?: string | null;
      via: "p2p" | "p2pRelay" | "syncplay";
      timestampMs?: number;
    },
    options?: { allowPeek?: boolean; localUsername?: string },
  ) => boolean;
  applyMessageEdit: (
    msgId: string,
    actorUsername: string,
    newText: string,
    options?: { isSelf?: boolean; editedAtMs?: number },
  ) => boolean;
  toggleMessageReaction: (msgId: string, actorUsername: string, emoji: string) => boolean;
  setPeerTyping: (username: string, isTyping: boolean, nowMs?: number) => void;
  pruneExpiredTyping: (nowMs?: number) => void;
  dismissPeek: (id: string) => void;
  pruneExpiredPeeks: (nowMs?: number) => void;
  clearChat: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  unreadCount: 0,
  unreadSinceId: null,
  chatOpen: false,
  replyToId: null,
  editingMsgId: null,
  typingPeers: {},
  peeks: [],
  sidebarWidth: readStoredSidebarWidth(),

  setChatOpen: (open) =>
    set((s) => ({
      chatOpen: open,
      unreadCount: open ? 0 : s.unreadCount,
      unreadSinceId: open ? s.unreadSinceId : null,
      peeks: open ? [] : s.peeks,
    })),

  setReplyToId: (replyToId) =>
    set((s) => ({
      replyToId,
      editingMsgId: replyToId ? null : s.editingMsgId,
    })),

  setEditingMsgId: (editingMsgId) =>
    set((s) => ({
      editingMsgId,
      replyToId: editingMsgId ? null : s.replyToId,
    })),

  setSidebarWidth: (width) => {
    const clamped = Math.max(
      MIN_CHAT_SIDEBAR_WIDTH,
      Math.min(MAX_CHAT_SIDEBAR_WIDTH, Math.round(width)),
    );
    writeStoredSidebarWidth(clamped);
    set({ sidebarWidth: clamped });
  },

  appendLocalMessage: (msg) =>
    set((s) => {
      if (s.messages.some((m) => m.id === msg.id && m.isSelf)) {
        return s;
      }
      const nextMsg: ChatMessage = {
        id: msg.id,
        kind: "message",
        sender: msg.sender,
        avatarId: msg.avatarId,
        text: msg.text,
        replyToId: msg.replyToId ?? null,
        isSelf: true,
        timestampMs: msg.timestampMs ?? Date.now(),
        editedAtMs: null,
        reactions: {},
        via: "local",
      };
      return {
        messages: [...s.messages, nextMsg].slice(-MAX_CHAT_MESSAGES),
        replyToId: null,
        editingMsgId: null,
        unreadSinceId: null,
      };
    }),

  receiveRemoteMessage: (msg, options) => {
    const state = get();
    const senderLower = msg.sender.trim().toLowerCase();
    if (
      state.messages.some(
        (m) => m.kind === "message" && m.id === msg.id && m.sender.trim().toLowerCase() === senderLower,
      )
    ) {
      return false;
    }

    const nowMs = msg.timestampMs ?? Date.now();
    const nextMsg: ChatMessage = {
      id: msg.id,
      kind: "message",
      sender: msg.sender,
      avatarId: msg.avatarId,
      text: msg.text,
      replyToId: msg.replyToId ?? null,
      isSelf: false,
      timestampMs: nowMs,
      editedAtMs: null,
      reactions: {},
      via: msg.via,
    };

    const nextTyping = { ...state.typingPeers };
    for (const key of Object.keys(nextTyping)) {
      if (key.trim().toLowerCase() === senderLower) {
        delete nextTyping[key];
      }
    }

    const localName = options?.localUsername?.trim().toLowerCase();
    const isMention = Boolean(
      localName &&
        new RegExp(`(^|\\s)@${localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|\\s|$)`, "i").test(
          msg.text,
        ),
    );

    const shouldPeek = !state.chatOpen && ((options?.allowPeek ?? true) || isMention);
    const nextPeeks = shouldPeek
      ? [
          ...state.peeks.filter((p) => p.expiresAtMs > nowMs && p.id !== msg.id),
          {
            id: msg.id,
            sender: msg.sender,
            avatarId: msg.avatarId,
            text: msg.text,
            isMention,
            createdAtMs: nowMs,
            expiresAtMs: nowMs + CHAT_PEEK_TTL_MS,
          },
        ].slice(-MAX_CHAT_PEEKS)
      : state.peeks;

    const nextUnreadSince = state.chatOpen ? null : state.unreadSinceId ?? msg.id;

    set({
      messages: [...state.messages, nextMsg].slice(-MAX_CHAT_MESSAGES),
      unreadCount: state.chatOpen ? 0 : state.unreadCount + 1,
      unreadSinceId: nextUnreadSince,
      typingPeers: nextTyping,
      peeks: nextPeeks,
    });
    return true;
  },

  applyMessageEdit: (msgId, actorUsername, newText, options) => {
    const state = get();
    const actorLower = actorUsername.trim().toLowerCase();
    let updated = false;
    const editedAt = options?.editedAtMs ?? Date.now();

    const nextMessages = state.messages.map((m) => {
      if (m.kind !== "message" || m.id !== msgId) return m;
      const matchesOwner = options?.isSelf
        ? m.isSelf
        : !m.isSelf && m.sender.trim().toLowerCase() === actorLower;
      if (!matchesOwner) return m;
      updated = true;
      return {
        ...m,
        text: newText,
        editedAtMs: editedAt,
      };
    });

    if (!updated) return false;
    set((s) => ({
      messages: nextMessages,
      editingMsgId: options?.isSelf && s.editingMsgId === msgId ? null : s.editingMsgId,
    }));
    return true;
  },

  toggleMessageReaction: (msgId, actorUsername, emoji) => {
    const state = get();
    const actorClean = actorUsername.trim();
    const actorLower = actorClean.toLowerCase();
    if (!actorClean || !emoji) return false;

    let changed = false;
    const nextMessages = state.messages.map((m) => {
      if (m.kind !== "message" || m.id !== msgId) return m;
      changed = true;
      const currentList = m.reactions[emoji] ?? [];
      const exists = currentList.some((u) => u.trim().toLowerCase() === actorLower);
      const nextList = exists
        ? currentList.filter((u) => u.trim().toLowerCase() !== actorLower)
        : [...currentList, actorClean];
      const nextReactions = { ...m.reactions };
      if (nextList.length === 0) {
        delete nextReactions[emoji];
      } else {
        nextReactions[emoji] = nextList;
      }
      return {
        ...m,
        reactions: nextReactions,
      };
    });

    if (changed) {
      set({ messages: nextMessages });
    }
    return changed;
  },

  setPeerTyping: (username, isTyping, nowMs = Date.now()) =>
    set((s) => {
      const clean = username.trim();
      if (!clean) return s;
      const next = { ...s.typingPeers };
      for (const k of Object.keys(next)) {
        if (k.toLowerCase() === clean.toLowerCase() || next[k] <= nowMs) {
          delete next[k];
        }
      }
      if (isTyping) {
        next[clean] = nowMs + TYPING_TTL_MS;
      }
      return { typingPeers: next };
    }),

  pruneExpiredTyping: (nowMs = Date.now()) =>
    set((s) => {
      const keys = Object.keys(s.typingPeers);
      if (keys.length === 0) return s;
      let changed = false;
      const next: Record<string, number> = {};
      for (const k of keys) {
        if (s.typingPeers[k] > nowMs) {
          next[k] = s.typingPeers[k];
        } else {
          changed = true;
        }
      }
      return changed ? { typingPeers: next } : s;
    }),

  dismissPeek: (id) =>
    set((s) => ({
      peeks: s.peeks.filter((p) => p.id !== id),
    })),

  pruneExpiredPeeks: (nowMs = Date.now()) =>
    set((s) => {
      if (s.peeks.length === 0) return s;
      const filtered = s.peeks.filter((p) => p.expiresAtMs > nowMs);
      return filtered.length === s.peeks.length ? s : { peeks: filtered };
    }),

  clearChat: () =>
    set({
      messages: [],
      unreadCount: 0,
      unreadSinceId: null,
      chatOpen: false,
      replyToId: null,
      editingMsgId: null,
      typingPeers: {},
      peeks: [],
    }),
}));

export function clearPartyChat(): void {
  useChatStore.getState().clearChat();
}
