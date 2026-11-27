import { create } from "zustand";

export type ChatTransportVia = "local" | "p2p" | "p2pRelay" | "syncplay" | "system";

export type ChatImageStatus =
  | "pending-tap"
  | "loading"
  | "ready"
  | "expired"
  | "disabled"
  | "failed";

export interface ChatImageAttachment {
  id: string;
  width: number;
  height: number;
  byteLen: number;
  spoiler: boolean;
  revealed: boolean;
  status: ChatImageStatus;
  objectUrl: string | null;
  receivedAtMs: number;
  expiresAtMs: number | null;
}

export interface PeerSeenEntry {
  username: string;
  lastMsgId: string;
  seenAtMs: number;
}

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
  image?: ChatImageAttachment;
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
const MAX_ACTIVE_IMAGES_30M = 20;
const MAX_ACTIVE_IMAGES_SESSION = 60;
export const CHAT_IMAGE_30M_MS = 30 * 60 * 1000;
export const MIN_CHAT_SIDEBAR_WIDTH = 320;
export const MAX_CHAT_SIDEBAR_WIDTH = 560;
export const DEFAULT_CHAT_SIDEBAR_WIDTH = 440;

function safeRevokeObjectUrl(url: string | null | undefined): void {
  if (!url) return;
  try {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(url);
    }
  } catch {
    // Ignore revoke errors
  }
}

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
  seenByPeer: Record<string, PeerSeenEntry>;
  pendingImageData: Record<string, string>;
  peeks: ChatPeekItem[];
  sidebarWidth: number;
  setChatOpen: (open: boolean) => void;
  setReplyToId: (id: string | null) => void;
  setEditingMsgId: (id: string | null) => void;
  setSidebarWidth: (width: number) => void;
  recordPeerSeen: (username: string, lastMsgId: string, nowMs?: number) => void;
  appendLocalImageMessage: (msg: {
    id: string;
    sender: string;
    avatarId: string;
    caption: string;
    width: number;
    height: number;
    byteLen: number;
    spoiler: boolean;
    objectUrl: string;
    retention: "30m" | "session";
    replyToId?: string | null;
    timestampMs?: number;
  }) => void;
  receiveRemoteImageMeta: (
    msg: {
      id: string;
      sender: string;
      avatarId: string;
      caption?: string | null;
      spoiler: boolean;
      width: number;
      height: number;
      byteLen: number;
      replyToId?: string | null;
      via: "p2p" | "p2pRelay";
      timestampMs?: number;
    },
    options: {
      mode: "auto" | "tap" | "off";
      retention: "30m" | "session";
      allowPeek?: boolean;
      localUsername?: string;
    },
  ) => boolean;
  receiveRemoteImageData: (
    id: string,
    objectUrl: string,
    retention: "30m" | "session",
    nowMs?: number,
  ) => void;
  markImageLoading: (id: string) => void;
  markImageFailed: (id: string) => void;
  revealImageSpoiler: (id: string) => void;
  syncImageRetention: (retention: "30m" | "session") => void;
  pruneExpiredImages: (retention: "30m" | "session", nowMs?: number) => void;
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
  seenByPeer: {},
  pendingImageData: {},
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

  recordPeerSeen: (username, lastMsgId, nowMs = Date.now()) =>
    set((s) => {
      const cleanName = username.trim();
      const cleanId = lastMsgId.trim();
      if (!cleanName || !cleanId) return s;
      const key = cleanName.toLowerCase();
      const existing = s.seenByPeer[key];
      if (existing && existing.lastMsgId === cleanId) return s;
      return {
        seenByPeer: {
          ...s.seenByPeer,
          [key]: { username: cleanName, lastMsgId: cleanId, seenAtMs: nowMs },
        },
      };
    }),

  appendLocalImageMessage: (msg) =>
    set((s) => {
      if (s.messages.some((m) => m.id === msg.id && m.isSelf)) {
        return s;
      }
      const nowMs = msg.timestampMs ?? Date.now();
      const nextMsg: ChatMessage = {
        id: msg.id,
        kind: "message",
        sender: msg.sender,
        avatarId: msg.avatarId,
        text: msg.caption,
        replyToId: msg.replyToId ?? null,
        isSelf: true,
        timestampMs: nowMs,
        editedAtMs: null,
        reactions: {},
        via: "local",
        image: {
          id: msg.id,
          width: msg.width,
          height: msg.height,
          byteLen: msg.byteLen,
          spoiler: msg.spoiler,
          revealed: true, // sender already knows what they sent
          status: "ready",
          objectUrl: msg.objectUrl,
          receivedAtMs: nowMs,
          expiresAtMs: msg.retention === "30m" ? nowMs + CHAT_IMAGE_30M_MS : null,
        },
      };
      return {
        messages: [...s.messages, nextMsg].slice(-MAX_CHAT_MESSAGES),
        replyToId: null,
        editingMsgId: null,
        unreadSinceId: null,
      };
    }),

  receiveRemoteImageMeta: (msg, options) => {
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
    const bufferedUrl = state.pendingImageData[msg.id] ?? null;
    const nextPending = { ...state.pendingImageData };
    if (bufferedUrl) delete nextPending[msg.id];

    const initialStatus: ChatImageStatus =
      options.mode === "off"
        ? "disabled"
        : bufferedUrl
          ? "ready"
          : options.mode === "tap"
            ? "pending-tap"
            : "loading";

    if (options.mode === "off" && bufferedUrl) {
      safeRevokeObjectUrl(bufferedUrl);
    }

    const activeUrl = options.mode === "off" ? null : bufferedUrl;
    const nextMsg: ChatMessage = {
      id: msg.id,
      kind: "message",
      sender: msg.sender,
      avatarId: msg.avatarId,
      text: msg.caption ?? "",
      replyToId: msg.replyToId ?? null,
      isSelf: false,
      timestampMs: nowMs,
      editedAtMs: null,
      reactions: {},
      via: msg.via,
      image: {
        id: msg.id,
        width: msg.width,
        height: msg.height,
        byteLen: msg.byteLen,
        spoiler: msg.spoiler,
        revealed: !msg.spoiler,
        status: initialStatus,
        objectUrl: activeUrl,
        receivedAtMs: nowMs,
        expiresAtMs:
          activeUrl && options.retention === "30m" ? nowMs + CHAT_IMAGE_30M_MS : null,
      },
    };

    const shouldPeek = !state.chatOpen && (options.allowPeek ?? true);
    const peekText = msg.caption?.trim() ? `📷 ${msg.caption.trim()}` : "📷 Sent a photo";
    const nextPeeks = shouldPeek
      ? [
          ...state.peeks.filter((p) => p.expiresAtMs > nowMs && p.id !== msg.id),
          {
            id: msg.id,
            sender: msg.sender,
            avatarId: msg.avatarId,
            text: peekText,
            isMention: false,
            createdAtMs: nowMs,
            expiresAtMs: nowMs + CHAT_PEEK_TTL_MS,
          },
        ].slice(-MAX_CHAT_PEEKS)
      : state.peeks;

    set({
      messages: [...state.messages, nextMsg].slice(-MAX_CHAT_MESSAGES),
      pendingImageData: nextPending,
      unreadCount: state.chatOpen ? 0 : state.unreadCount + 1,
      unreadSinceId: state.chatOpen ? null : state.unreadSinceId ?? msg.id,
      peeks: nextPeeks,
    });
    return true;
  },

  receiveRemoteImageData: (id, objectUrl, retention, nowMs = Date.now()) =>
    set((s) => {
      const idx = s.messages.findIndex((m) => m.image?.id === id);
      if (idx === -1) {
        // Meta hasn't arrived yet (race): buffer briefly, capped at 8 entries
        const nextPending = { ...s.pendingImageData };
        const prev = nextPending[id];
        if (prev && prev !== objectUrl) safeRevokeObjectUrl(prev);
        nextPending[id] = objectUrl;
        const keys = Object.keys(nextPending);
        while (keys.length > 8) {
          const oldestKey = keys.shift();
          if (oldestKey) {
            safeRevokeObjectUrl(nextPending[oldestKey]);
            delete nextPending[oldestKey];
          }
        }
        return { pendingImageData: nextPending };
      }
      const target = s.messages[idx];
      if (!target.image || target.image.status === "disabled") {
        safeRevokeObjectUrl(objectUrl);
        return s;
      }
      if (target.image.objectUrl && target.image.objectUrl !== objectUrl) {
        safeRevokeObjectUrl(target.image.objectUrl);
      }
      const nextMessages = [...s.messages];
      nextMessages[idx] = {
        ...target,
        image: {
          ...target.image,
          status: "ready",
          objectUrl,
          receivedAtMs: nowMs,
          expiresAtMs: retention === "30m" ? nowMs + CHAT_IMAGE_30M_MS : null,
        },
      };
      return { messages: nextMessages };
    }),

  markImageLoading: (id) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.image?.id === id ? { ...m, image: { ...m.image, status: "loading" } } : m,
      ),
    })),

  markImageFailed: (id) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.image?.id !== id) return m;
        safeRevokeObjectUrl(m.image.objectUrl);
        return {
          ...m,
          image: { ...m.image, status: "failed", objectUrl: null },
        };
      }),
    })),

  revealImageSpoiler: (id) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.image?.id === id ? { ...m, image: { ...m.image, revealed: true } } : m,
      ),
    })),

  syncImageRetention: (retention) =>
    set((s) => ({
      messages: s.messages.map((m) => {
        if (!m.image || m.image.status !== "ready") return m;
        return {
          ...m,
          image: {
            ...m.image,
            expiresAtMs:
              retention === "30m" ? m.image.receivedAtMs + CHAT_IMAGE_30M_MS : null,
          },
        };
      }),
    })),

  pruneExpiredImages: (retention, nowMs = Date.now()) =>
    set((s) => {
      const maxActive =
        retention === "30m" ? MAX_ACTIVE_IMAGES_30M : MAX_ACTIVE_IMAGES_SESSION;
      const activeIndices: number[] = [];
      let changed = false;

      const nextMessages = s.messages.map((m, idx) => {
        if (!m.image || m.image.status !== "ready") return m;
        if (
          retention === "30m" &&
          m.image.expiresAtMs !== null &&
          m.image.expiresAtMs <= nowMs
        ) {
          changed = true;
          safeRevokeObjectUrl(m.image.objectUrl);
          return {
            ...m,
            image: { ...m.image, status: "expired" as const, objectUrl: null },
          };
        }
        activeIndices.push(idx);
        return m;
      });

      if (activeIndices.length > maxActive) {
        const excess = activeIndices.length - maxActive;
        for (let i = 0; i < excess; i += 1) {
          const msgIdx = activeIndices[i];
          const target = nextMessages[msgIdx];
          if (target?.image) {
            changed = true;
            safeRevokeObjectUrl(target.image.objectUrl);
            nextMessages[msgIdx] = {
              ...target,
              image: { ...target.image, status: "expired", objectUrl: null },
            };
          }
        }
      }

      return changed ? { messages: nextMessages } : s;
    }),

  clearChat: () =>
    set((s) => {
      for (const m of s.messages) {
        safeRevokeObjectUrl(m.image?.objectUrl);
      }
      for (const url of Object.values(s.pendingImageData)) {
        safeRevokeObjectUrl(url);
      }
      return {
        messages: [],
        unreadCount: 0,
        unreadSinceId: null,
        chatOpen: false,
        replyToId: null,
        editingMsgId: null,
        typingPeers: {},
        seenByPeer: {},
        pendingImageData: {},
        peeks: [],
      };
    }),
}));

export function clearPartyChat(): void {
  useChatStore.getState().clearChat();
}
