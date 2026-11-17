import { resolveEffectiveUsername } from "./syncController";
import {
  syncSendChat,
  syncSendChatEdit,
  syncSendChatReact,
  syncSendChatTyping,
} from "./syncplay";
import { useAppStore } from "../store/useAppStore";
import { useChatStore, type ChatMessage } from "../store/useChatStore";
import { useSyncStore } from "../store/useSyncStore";

export const MAX_CHAT_MESSAGE_CHARS = 500;
export const MESSAGE_QUICK_REACTIONS = ["❤️", "😂", "🔥", "😱"] as const;
const CHAT_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const GROUP_WINDOW_MS = 2 * 60 * 1000;

let idSeq = 0;

/** Generates a compact 12-char alphanumeric ID matching Rust `sanitize_chat_id` and `~EPT:` headers. */
export function generateChatMessageId(): string {
  idSeq = (idSeq + 1) % 1296;
  const timePart = Date.now().toString(36).slice(-7).padStart(7, "0");
  const seqPart = idSeq.toString(36).padStart(2, "0");
  let randPart = "";
  for (let i = 0; i < 2; i++) {
    randPart += CHAT_ID_ALPHABET[Math.floor(Math.random() * CHAT_ID_ALPHABET.length)];
  }
  return `m${timePart}${seqPart}${randPart}`.slice(0, 12);
}

export function sanitizeChatDraft(raw: string): string | null {
  const normalized = raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  const trimmed = normalized.trim();
  if (!trimmed) return null;
  const chars = Array.from(trimmed);
  if (chars.length <= MAX_CHAT_MESSAGE_CHARS) {
    return trimmed;
  }
  return chars.slice(0, MAX_CHAT_MESSAGE_CHARS).join("").trim() || null;
}

export function sendPartyChatMessage(rawText: string, replyToId?: string | null): boolean {
  const cleanText = sanitizeChatDraft(rawText);
  if (!cleanText) return false;

  const app = useAppStore.getState();
  if (!app.roomCode) return false;
  const sync = useSyncStore.getState();
  const sender = resolveEffectiveUsername(sync.status, app.username);
  const avatarId = app.avatarId;
  const id = generateChatMessageId();
  const cleanReply = replyToId ? replyToId.trim().slice(0, 24) || null : null;

  useChatStore.getState().appendLocalMessage({
    id,
    sender,
    avatarId,
    text: cleanText,
    replyToId: cleanReply,
  });

  if (sync.status.state === "connected") {
    void syncSendChat(id, cleanText, avatarId, cleanReply);
    void syncSendChatTyping(false);
  }
  return true;
}

export function sendPartyChatEdit(targetMsgId: string, rawText: string): boolean {
  const cleanText = sanitizeChatDraft(rawText);
  if (!cleanText) return false;

  const app = useAppStore.getState();
  if (!app.roomCode) return false;
  const sync = useSyncStore.getState();
  const sender = resolveEffectiveUsername(sync.status, app.username);

  const ok = useChatStore.getState().applyMessageEdit(targetMsgId, sender, cleanText, {
    isSelf: true,
  });
  if (!ok) return false;

  if (sync.status.state === "connected") {
    void syncSendChatEdit(targetMsgId, cleanText);
    void syncSendChatTyping(false);
  }
  return true;
}

export function togglePartyChatReaction(targetMsgId: string, emoji: string): boolean {
  const app = useAppStore.getState();
  if (!app.roomCode) return false;
  const sync = useSyncStore.getState();
  const sender = resolveEffectiveUsername(sync.status, app.username);

  const ok = useChatStore.getState().toggleMessageReaction(targetMsgId, sender, emoji);
  if (!ok) return false;

  if (sync.status.state === "connected") {
    void syncSendChatReact(targetMsgId, emoji);
  }
  return true;
}

let lastTypingSentAt = 0;
let lastTypingState = false;

export function notifyPartyChatTyping(isTyping: boolean): void {
  const sync = useSyncStore.getState();
  if (sync.status.state !== "connected") return;
  const now = Date.now();
  if (!isTyping) {
    if (!lastTypingState) return;
    lastTypingState = false;
    lastTypingSentAt = now;
    void syncSendChatTyping(false);
    return;
  }
  if (lastTypingState && now - lastTypingSentAt < 2200) {
    return;
  }
  lastTypingState = true;
  lastTypingSentAt = now;
  void syncSendChatTyping(true);
}

export function resetTypingThrottle(): void {
  lastTypingSentAt = 0;
  lastTypingState = false;
}

export type ChatBubblePosition = "solo" | "first" | "middle" | "last";

export function computeMessageGroupPosition(
  messages: readonly ChatMessage[],
  index: number,
): ChatBubblePosition {
  const cur = messages[index];
  if (!cur || cur.kind === "system") return "solo";
  const prev = index > 0 ? messages[index - 1] : null;
  const next = index + 1 < messages.length ? messages[index + 1] : null;

  const sameAsPrev =
    prev !== null &&
    prev.kind === "message" &&
    prev.isSelf === cur.isSelf &&
    prev.sender.trim().toLowerCase() === cur.sender.trim().toLowerCase() &&
    cur.timestampMs - prev.timestampMs <= GROUP_WINDOW_MS;

  const sameAsNext =
    next !== null &&
    next.kind === "message" &&
    next.isSelf === cur.isSelf &&
    next.sender.trim().toLowerCase() === cur.sender.trim().toLowerCase() &&
    next.timestampMs - cur.timestampMs <= GROUP_WINDOW_MS;

  if (!sameAsPrev && !sameAsNext) return "solo";
  if (!sameAsPrev && sameAsNext) return "first";
  if (sameAsPrev && sameAsNext) return "middle";
  return "last";
}

export function formatChatClock(timestampMs: number): string {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatMediaTimestamp(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const whole = Math.floor(secs);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export type ChatTextToken =
  | { type: "text"; value: string }
  | { type: "timestamp"; label: string; secs: number }
  | { type: "mention"; username: string }
  | { type: "url"; href: string; label: string };

const INLINE_SEGMENT_RE =
  /(https?:\/\/[^\s<>"']+|(?:\b\d{1,2}:[0-5]\d:[0-5]\d\b|\b\d{1,2}:[0-5]\d\b)|(?:^|(?<=\s))@[A-Za-z0-9_.-]{2,24}\b)/g;

export function parseChatTokens(text: string): ChatTextToken[] {
  if (!text) return [];
  const out: ChatTextToken[] = [];
  let lastIdx = 0;
  INLINE_SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_SEGMENT_RE.exec(text)) !== null) {
    if (match.index > lastIdx) {
      out.push({ type: "text", value: text.slice(lastIdx, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const cleaned = raw.replace(/[.,!?;:)]+$/, "");
      const trailing = raw.slice(cleaned.length);
      out.push({ type: "url", href: cleaned, label: cleaned });
      if (trailing) {
        out.push({ type: "text", value: trailing });
      }
    } else if (raw.startsWith("@")) {
      out.push({ type: "mention", username: raw.slice(1) });
    } else {
      const parts = raw.split(":").map((n) => Number.parseInt(n, 10));
      let secs = 0;
      if (parts.length === 2) {
        secs = parts[0] * 60 + parts[1];
      } else if (parts.length === 3) {
        secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
      out.push({ type: "timestamp", label: raw, secs });
    }
    lastIdx = match.index + raw.length;
  }
  if (lastIdx < text.length) {
    out.push({ type: "text", value: text.slice(lastIdx) });
  }
  return out;
}

const PURE_EMOJI_SEGMENT_RE = /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u;

const PEER_NAME_TINTS = [
  "text-[#C4B5FD]", // lavender
  "text-[#7DD3FC]", // sky ice
  "text-[#6EE7B7]", // mint jade
  "text-[#FDBA74]", // warm amber
  "text-[#FDA4AF]", // soft rose
  "text-[#A5B4FC]", // periwinkle
] as const;

export function resolvePeerNameTint(sender: string): string {
  const clean = sender.trim().toLowerCase();
  if (!clean) return PEER_NAME_TINTS[0];
  let hash = 2166136261;
  for (let i = 0; i < clean.length; i++) {
    hash ^= clean.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PEER_NAME_TINTS[Math.abs(hash) % PEER_NAME_TINTS.length];
}

export function isPureEmojiMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/\s+/g, "");
  if (!compact || compact.length > 36) return false;

  const segments: string[] =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(compact),
          (s) => s.segment,
        )
      : Array.from(compact);

  return segments.length >= 1 && segments.length <= 3 && segments.every((seg) => PURE_EMOJI_SEGMENT_RE.test(seg));
}

export function shouldShowTimeDivider(
  messages: readonly ChatMessage[],
  index: number,
  gapMs = 4 * 60_000,
): boolean {
  const cur = messages[index];
  if (!cur || cur.kind === "system") return false;
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i];
    if (prev.kind === "system") continue;
    return cur.timestampMs - prev.timestampMs >= gapMs;
  }
  return true;
}

export function textMentionsUsername(text: string, username: string): boolean {
  const clean = username.trim();
  if (!clean) return false;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${escaped}(\\b|\\s|$)`, "i").test(text);
}
