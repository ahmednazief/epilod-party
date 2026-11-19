import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  computeMessageGroupPosition,
  formatChatClock,
  formatMediaTimestamp,
  isPureEmojiMessage,
  MAX_CHAT_MESSAGE_CHARS,
  MESSAGE_QUICK_REACTIONS,
  notifyPartyChatTyping,
  parseChatTokens,
  resetTypingThrottle,
  resolvePeerNameTint,
  sendPartyChatEdit,
  sendPartyChatMessage,
  shouldShowTimeDivider,
  textMentionsUsername,
  togglePartyChatReaction,
} from "../lib/chat";
import { filterEmojiCatalog, PRESET_REACTIONS } from "../lib/reactions";
import { resolveEffectiveUsername } from "../lib/syncController";
import { useAnimatedPresence, usePresencePayload } from "../lib/useAnimatedPresence";
import {
  getActiveVoiceSpeakerNames,
  isCaptureHealthy,
  isLocalVoiceSpeaking,
  isParticipantSpeaking,
  toggleVoiceSession,
} from "../lib/voiceActions";
import { useAppStore } from "../store/useAppStore";
import {
  MAX_CHAT_SIDEBAR_WIDTH,
  MIN_CHAT_SIDEBAR_WIDTH,
  useChatStore,
  type ChatMessage,
} from "../store/useChatStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSyncStore } from "../store/useSyncStore";
import { useVoiceStore } from "../store/useVoiceStore";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import {
  AppCloseIcon,
  AppSearchIcon,
  AppVoiceTuneIcon,
  AppVoiceWaveIcon,
} from "./ui/AppIcons";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import { VoiceMicDeafenPills } from "./ui/VoiceQuickControls";
import {
  PartyLeaveIcon,
  PlayerChatIcon,
  PlayerClockIcon,
  PlayerCollapseRightIcon,
  PlayerEditIcon,
  PlayerMoreIcon,
  PlayerReplyIcon,
  PlayerSendIcon,
  PlayerSmileIcon,
} from "./ui/PlayerIcons";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";
import { VoiceQuickSettingsTray } from "./ui/VoiceQuickSettingsTray";

interface ChatSidebarProps {
  docked: boolean;
  exiting: boolean;
  topChromeOffset: boolean;
  roomPanelOpen?: boolean;
  onClose: () => void;
  onSeekToTimestamp: (secs: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  onDockTransitionEnd?: () => void;
}

const QUICK_CHIPS = ["Ready? 🍿", "Hold on, brb", "Audio check 🔊"] as const;

function getBubbleRadiusClass(
  isSelf: boolean,
  pos: ReturnType<typeof computeMessageGroupPosition>,
): string {
  if (isSelf) {
    switch (pos) {
      case "solo":
        return "rounded-[18px] rounded-br-[6px]";
      case "first":
        return "rounded-[18px] rounded-br-[6px]";
      case "middle":
        return "rounded-[18px] rounded-r-[7px]";
      case "last":
        return "rounded-[18px] rounded-tr-[6px]";
    }
  }
  switch (pos) {
    case "solo":
      return "rounded-[18px] rounded-bl-[6px]";
    case "first":
      return "rounded-[18px] rounded-bl-[6px]";
    case "middle":
      return "rounded-[18px] rounded-l-[7px]";
    case "last":
      return "rounded-[18px] rounded-tl-[6px]";
  }
}

export const ChatSidebar = memo(function ChatSidebar({
  docked,
  exiting,
  topChromeOffset,
  roomPanelOpen = false,
  onClose,
  onSeekToTimestamp,
  onResizingChange,
  onDockTransitionEnd,
}: ChatSidebarProps) {
  const messages = useChatStore((s) => s.messages);
  const unreadSinceId = useChatStore((s) => s.unreadSinceId);
  const replyToId = useChatStore((s) => s.replyToId);
  const editingMsgId = useChatStore((s) => s.editingMsgId);
  const setReplyToId = useChatStore((s) => s.setReplyToId);
  const setEditingMsgId = useChatStore((s) => s.setEditingMsgId);
  const typingPeers = useChatStore((s) => s.typingPeers);
  const pruneExpiredTyping = useChatStore((s) => s.pruneExpiredTyping);
  const sidebarWidth = useChatStore((s) => s.sidebarWidth);
  const setSidebarWidth = useChatStore((s) => s.setSidebarWidth);

  const username = useAppStore((s) => s.username);
  const localAvatarId = useAppStore((s) => s.avatarId);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const recentEmojis = useAppStore((s) => s.recentEmojis);
  const pushRecentEmoji = useAppStore((s) => s.pushRecentEmoji);
  const chatPeeksEnabled = useAppStore((s) => s.chatPeeksEnabled);
  const setChatPeeksEnabled = useAppStore((s) => s.setChatPeeksEnabled);
  const chatTriggerPlacement = useAppStore((s) => s.chatTriggerPlacement);
  const setChatTriggerPlacement = useAppStore((s) => s.setChatTriggerPlacement);
  const openSettings = useAppStore((s) => s.openSettings);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);

  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const voiceJoined = useVoiceStore((s) => s.joined);
  const voiceJoining = useVoiceStore((s) => s.joining);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const voiceGateOpen = useVoiceStore((s) => s.localGateOpen);
  const voiceStreamStatus = useVoiceStore((s) => s.streamStatus);
  const voiceSpeakingPeers = useVoiceStore((s) => s.speakingPeers);
  const voiceRoster = useVoiceStore((s) => s.roster);
  const voicePeerOverrides = useVoiceStore((s) => s.peerOverrides);

  const mediaLoaded = usePlayerStore((s) => s.loaded);
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);

  const voiceCheckInput = {
    joined: voiceJoined,
    muted: voiceMuted,
    deafened: voiceDeafened,
    localGateOpen: voiceGateOpen,
    streamStatus: voiceStreamStatus,
    speakingPeers: voiceSpeakingPeers,
    roster: voiceRoster,
    peerOverrides: voicePeerOverrides,
  };
  const localVoiceSpeaking = isLocalVoiceSpeaking(voiceCheckInput);
  const voicePeersInCall = voiceRoster.filter((r) => r.inVoice);
  const activeVoiceSpeakers = getActiveVoiceSpeakerNames(effectiveUsername, voiceCheckInput);

  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [voiceAudioOpen, setVoiceAudioOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unseenBelow, setUnseenBelow] = useState(0);
  const [pulsingMsgId, setPulsingMsgId] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [resizing, setResizing] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [sendRecoil, setSendRecoil] = useState(false);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const [dockExpanded, setDockExpanded] = useState(() => !docked || (reducedMotion && !exiting));
  const sendRecoilTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!docked) {
      setDockExpanded(true);
      return;
    }
    if (reducedMotion) {
      setDockExpanded(!exiting);
      return;
    }
    if (exiting) {
      setDockExpanded(false);
      return;
    }
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setDockExpanded(true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [docked, exiting, reducedMotion]);

  const optionsPresence = useAnimatedPresence(optionsOpen, 170);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const voiceAudioRef = useRef<HTMLDivElement | null>(null);
  const voiceAudioPortalRef = useRef<HTMLDivElement | null>(null);
  const [voiceAudioCoords, setVoiceAudioCoords] = useState<{ left: number; top: number } | null>(
    null,
  );
  const voiceAudioPresence = usePresencePayload(
    voiceAudioOpen && voiceAudioCoords ? voiceAudioCoords : null,
    190,
  );

  useEffect(() => {
    window.dispatchEvent(new Event("ep:glass-layout"));
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event("ep:glass-layout"));
    }, 65);
    return () => window.clearTimeout(timer);
  }, [voiceAudioOpen, voiceAudioPresence.mounted]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const msgRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const prevMsgCountRef = useRef(messages.length);
  const pulseTimerRef = useRef<number | null>(null);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;

  const messageById = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of messages) {
      map.set(m.id, m);
    }
    return map;
  }, [messages]);

  const replyTarget = replyToId ? (messageById.get(replyToId) ?? null) : null;
  const editTarget = editingMsgId ? (messageById.get(editingMsgId) ?? null) : null;

  useEffect(() => {
    if (editTarget && editTarget.isSelf) {
      setDraft(editTarget.text);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(editTarget.text.length, editTarget.text.length);
        }
      });
    }
  }, [editTarget]);

  // Position & outside-click handling for quick voice audio portal popover
  useLayoutEffect(() => {
    if (!voiceAudioOpen) {
      setVoiceAudioCoords(null);
      return;
    }
    const update = () => {
      const anchor = voiceAudioRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const width = 244;
      setVoiceAudioCoords({
        left: Math.max(12, Math.min(r.right - width, vw - width - 12)),
        top: Math.max(12, Math.min(r.bottom + 6, vh - 290)),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [voiceAudioOpen]);

  // Close options / quick voice setup popovers on outside click
  useEffect(() => {
    if (!optionsOpen && !voiceAudioOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (target instanceof Element && target.closest('[role="listbox"]')) {
        return;
      }
      if (optionsOpen && optionsMenuRef.current && !optionsMenuRef.current.contains(target)) {
        setOptionsOpen(false);
      }
      if (
        voiceAudioOpen &&
        voiceAudioRef.current &&
        !voiceAudioRef.current.contains(target) &&
        (!voiceAudioPortalRef.current || !voiceAudioPortalRef.current.contains(target))
      ) {
        setVoiceAudioOpen(false);
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && voiceAudioOpen) {
        setVoiceAudioOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [optionsOpen, voiceAudioOpen]);

  const activeTypingNames = useMemo(() => {
    const now = Date.now();
    return Object.entries(typingPeers)
      .filter(([, exp]) => exp > now)
      .map(([name]) => name);
  }, [typingPeers]);

  useEffect(() => {
    if (Object.keys(typingPeers).length === 0) return;
    const timer = window.setInterval(() => {
      pruneExpiredTyping();
    }, 800);
    return () => window.clearInterval(timer);
  }, [typingPeers, pruneExpiredTyping]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      textareaRef.current?.focus({ preventScroll: true });
    }, 75);
    return () => {
      window.clearTimeout(id);
      notifyPartyChatTyping(false);
      resetTypingThrottle();
      if (pulseTimerRef.current !== null) {
        window.clearTimeout(pulseTimerRef.current);
      }
    };
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setAtBottom(true);
    setUnseenBelow(0);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const prev = prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    if (messages.length <= prev) return;

    const latest = messages[messages.length - 1];
    if (latest?.isSelf || atBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom("smooth"));
    } else {
      setUnseenBelow((c) => c + (messages.length - prev));
    }
  }, [messages, scrollToBottom]);

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const nextHeight = Math.min(112, Math.max(24, ta.scrollHeight));
    ta.style.height = `${nextHeight}px`;
    setComposerExpanded(nextHeight > 28 || draft.includes("\n"));
  }, [draft]);

  useEffect(() => {
    return () => {
      if (sendRecoilTimerRef.current !== null) {
        window.clearTimeout(sendRecoilTimerRef.current);
      }
    };
  }, []);

  const mentionQuery = useMemo(() => {
    const m = /(?:^|\s)@([A-Za-z0-9_.-]{0,20})$/.exec(draft);
    return m ? m[1] : null;
  }, [draft]);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null || hideParticipants) return [];
    const q = mentionQuery.toLowerCase();
    return participants
      .filter((p) => p.username.trim().toLowerCase() !== effectiveUsername.trim().toLowerCase())
      .map((p) => p.username)
      .filter((name) => name.toLowerCase().includes(q))
      .slice(0, 5);
  }, [mentionQuery, participants, effectiveUsername, hideParticipants]);

  useEffect(() => {
    setMentionIdx(0);
  }, [mentionQuery]);

  const applyMention = useCallback(
    (name: string) => {
      const next = draft.replace(/(?:^|\s)@[A-Za-z0-9_.-]{0,20}$/, (full) => {
        const leading = full.startsWith(" ") ? " " : "";
        return `${leading}@${name} `;
      });
      setDraft(next);
      requestAnimationFrame(() => {
        textareaRef.current?.focus({ preventScroll: true });
      });
    },
    [draft],
  );

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance <= 32;
    setAtBottom(nearBottom);
    if (nearBottom) {
      setUnseenBelow(0);
    }
  };

  const handleSend = useCallback(
    (overrideText?: string) => {
      if (editingMsgId && overrideText === undefined) {
        const saved = sendPartyChatEdit(editingMsgId, draft);
        if (!saved) return;
        setDraft("");
        setEmojiOpen(false);
        setEmojiQuery("");
        notifyPartyChatTyping(false);
        requestAnimationFrame(() => {
          textareaRef.current?.focus({ preventScroll: true });
        });
        return;
      }

      const textToSend = overrideText ?? draft;
      const sent = sendPartyChatMessage(textToSend, replyToId);
      if (!sent) return;
      if (overrideText === undefined) {
        setDraft("");
      }
      setSendRecoil(true);
      if (sendRecoilTimerRef.current !== null) {
        window.clearTimeout(sendRecoilTimerRef.current);
      }
      sendRecoilTimerRef.current = window.setTimeout(() => {
        sendRecoilTimerRef.current = null;
        setSendRecoil(false);
      }, 240);
      setEmojiOpen(false);
      setEmojiQuery("");
      notifyPartyChatTyping(false);
      requestAnimationFrame(() => {
        textareaRef.current?.focus({ preventScroll: true });
      });
    },
    [draft, editingMsgId, replyToId],
  );

  const insertAtCursor = useCallback(
    (snippet: string, wrapWith?: [string, string]) => {
      const ta = textareaRef.current;
      if (!ta) {
        const next = wrapWith ? `${draft}${wrapWith[0]}${wrapWith[1]}` : `${draft}${snippet}`;
        setDraft(next);
        return;
      }
      const start = ta.selectionStart ?? draft.length;
      const end = ta.selectionEnd ?? draft.length;
      let next: string;
      let nextCaret: number;
      if (wrapWith) {
        const selected = draft.slice(start, end) || "spoiler";
        const inserted = `${wrapWith[0]}${selected}${wrapWith[1]}`;
        next = `${draft.slice(0, start)}${inserted}${draft.slice(end)}`;
        nextCaret =
          draft.slice(start, end).length > 0
            ? start + inserted.length
            : start + wrapWith[0].length;
      } else {
        next = `${draft.slice(0, start)}${snippet}${draft.slice(end)}`;
        nextCaret = start + snippet.length;
      }
      setDraft(next);
      notifyPartyChatTyping(next.trim().length > 0);
      requestAnimationFrame(() => {
        ta.focus({ preventScroll: true });
        if (wrapWith && draft.slice(start, end).length === 0) {
          ta.setSelectionRange(nextCaret, nextCaret + "spoiler".length);
        } else {
          ta.setSelectionRange(nextCaret, nextCaret);
        }
      });
    },
    [draft],
  );

  const handleInsertEmoji = useCallback(
    (emoji: string) => {
      pushRecentEmoji(emoji);
      insertAtCursor(emoji);
    },
    [insertAtCursor, pushRecentEmoji],
  );

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applyMention(mentionCandidates[mentionIdx] ?? mentionCandidates[0]);
        return;
      }
    }

    if (e.key === "ArrowUp" && !draft.trim() && !editingMsgId) {
      const lastSelf = [...messages].reverse().find((m) => m.kind === "message" && m.isSelf);
      if (lastSelf) {
        e.preventDefault();
        setEditingMsgId(lastSelf.id);
        return;
      }
    }

    if (e.key === "Escape") {
      if (voiceAudioOpen) {
        e.preventDefault();
        e.stopPropagation();
        setVoiceAudioOpen(false);
        return;
      }
      if (optionsOpen) {
        e.preventDefault();
        e.stopPropagation();
        setOptionsOpen(false);
        return;
      }
      if (emojiOpen) {
        e.preventDefault();
        e.stopPropagation();
        setEmojiOpen(false);
        return;
      }
      if (editingMsgId) {
        e.preventDefault();
        e.stopPropagation();
        setEditingMsgId(null);
        setDraft("");
        return;
      }
      if (replyToId) {
        e.preventDefault();
        e.stopPropagation();
        setReplyToId(null);
        return;
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const jumpToMessage = (targetId: string) => {
    const el = msgRefs.current[targetId];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setPulsingMsgId(targetId);
    if (pulseTimerRef.current !== null) {
      window.clearTimeout(pulseTimerRef.current);
    }
    pulseTimerRef.current = window.setTimeout(() => {
      setPulsingMsgId((cur) => (cur === targetId ? null : cur));
    }, 950);
  };

  const handleResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    setResizing(true);
    onResizingChange?.(true);

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      setSidebarWidth(
        Math.max(MIN_CHAT_SIDEBAR_WIDTH, Math.min(MAX_CHAT_SIDEBAR_WIDTH, startW + delta)),
      );
    };
    const onUp = () => {
      setResizing(false);
      onResizingChange?.(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const filteredEmojis = useMemo(() => {
    const q = emojiQuery.trim();
    if (!q) {
      const merged: string[] = [];
      for (const e of recentEmojis) {
        if (!merged.includes(e)) merged.push(e);
      }
      for (const p of PRESET_REACTIONS) {
        if (!merged.includes(p.emoji)) merged.push(p.emoji);
      }
      for (const item of filterEmojiCatalog("", "all")) {
        if (!merged.includes(item.emoji)) merged.push(item.emoji);
        if (merged.length >= 24) break;
      }
      return merged;
    }
    return filterEmojiCatalog(q, "all")
      .slice(0, 24)
      .map((item) => item.emoji);
  }, [emojiQuery, recentEmojis]);

  const remotePeerCount = Math.max(0, participants.length - 1);
  const trimmedDraftLen = Array.from(draft).length;
  const canSend = draft.trim().length > 0 && syncStatus.state === "connected";

  const renderMessageContent = (msg: ChatMessage) => {
    const tokens = parseChatTokens(msg.text);
    return tokens.map((tok, i) => {
      switch (tok.type) {
        case "timestamp":
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSeekToTimestamp(tok.secs)}
              title={`Jump to ${tok.label}`}
              className="inline-flex items-center px-1.5 py-0.2 mx-0.5 rounded-md bg-white/[0.14] hover:bg-white/[0.22] text-[12px] font-medium text-white num align-baseline cursor-pointer"
            >
              {tok.label}
            </button>
          );
        case "mention": {
          const isMe = tok.username.toLowerCase() === effectiveUsername.trim().toLowerCase();
          return (
            <span
              key={i}
              className={`font-medium ${
                isMe
                  ? "text-white bg-accent/40 px-1 rounded"
                  : "text-accent-soft"
              }`}
            >
              @{tok.username}
            </span>
          );
        }
        case "url":
          return (
            <button
              key={i}
              type="button"
              title="Click to copy link"
              onClick={() => {
                void navigator.clipboard?.writeText(tok.href).then(() => {
                  usePlayerStore.getState().flashFeedback("Link copied");
                });
              }}
              className="underline decoration-white/40 hover:decoration-white text-accent-soft hover:text-white break-all cursor-pointer text-left"
            >
              {tok.label}
            </button>
          );
        case "text":
        default:
          return <span key={i}>{tok.value}</span>;
      }
    });
  };

  const asideEl = (
    <aside
      aria-label="Party Chat"
      style={{ width: `${sidebarWidth}px` }}
      className={`ep-chat-sidebar relative h-full flex flex-col shrink-0 select-none ${
        docked
          ? `ep-chat-dock-panel ${exiting ? "pointer-events-none" : ""}`
          : `fixed top-0 right-0 bottom-0 z-[42] ${
              exiting ? "ep-chat-sidebar-out pointer-events-none" : "ep-chat-sidebar-in"
            }`
      }`}
    >
      {/* Left drag-to-resize grip */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        onPointerDown={handleResizePointerDown}
        className="absolute top-0 bottom-0 left-0 w-2 z-20 cursor-col-resize group flex justify-start"
      >
        <span
          className={`w-[2px] h-full transition-opacity ${
            resizing
              ? "bg-accent-soft/75 opacity-100"
              : "bg-accent-soft/45 opacity-0 group-hover:opacity-100"
          }`}
        />
      </div>

      {/* Minimal, Clean Header (zero tech jargon, zero separating strokes) */}
      <div
        className={`ep-chat-header-zone px-4 pb-2 flex items-center justify-between gap-2 shrink-0 transition-[padding-top] duration-200 ease-out ${
          topChromeOffset ? "pt-[48px]" : "pt-3.5"
        }`}
      >
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-tight text-white leading-tight">
            Party Chat
          </h2>
          <div className="flex items-center gap-1.5 mt-1 leading-none">
            <span
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                syncStatus.state === "connected" ? "bg-ok" : "bg-warn"
              }`}
            />
            {syncStatus.state === "connected" && !hideParticipants && remotePeerCount > 0 && (
              <div className="flex items-center -space-x-1 shrink-0">
                {participants
                  .filter(
                    (p) =>
                      p.username.trim().toLowerCase() !== effectiveUsername.trim().toLowerCase(),
                  )
                  .slice(0, 3)
                  .map((p) => {
                    const speaking = isParticipantSpeaking(
                      p.username,
                      effectiveUsername,
                      voiceCheckInput,
                    );
                    return (
                      <ProfileAvatar
                        key={p.username}
                        avatarId={resolvePeerAvatarId(p.username, effectiveUsername)}
                        size={15}
                        className={
                          speaking
                            ? "ring-[1.5px] ring-[#38BDF8] ep-speaking-ring"
                            : "ring-1 ring-[#08080d]"
                        }
                      />
                    );
                  })}
              </div>
            )}
            <p className="text-[11px] text-secondary/80 truncate">
              {syncStatus.state !== "connected"
                ? "Connecting…"
                : remotePeerCount === 0
                  ? "Just you"
                  : `${participants.length} watching`}
            </p>
          </div>
        </div>

        <div ref={optionsMenuRef} className="relative flex items-center gap-1 shrink-0">
          {syncStatus.state === "connected" &&
            voiceEnabled &&
            !voiceJoined &&
            voicePeersInCall.length === 0 && (
              <GlassHoverTip label="Join voice" detail="Start room voice">
                <button
                  type="button"
                  disabled={voiceJoining}
                  onClick={() => void toggleVoiceSession({ skipBtCheck: true })}
                  aria-label="Join voice chat"
                  className="ep-bar-icon-btn ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer disabled:opacity-50"
                >
                  <AppVoiceWaveIcon active={false} speaking={false} size={14} />
                </button>
              </GlassHoverTip>
            )}

          <button
            type="button"
            onClick={() => setOptionsOpen((v) => !v)}
            aria-label="Chat preferences"
            aria-expanded={optionsOpen}
            title="Chat options"
            className={`ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center cursor-pointer ${
              optionsOpen ? "text-white bg-white/[0.12]" : "text-muted hover:text-white"
            }`}
          >
            <PlayerMoreIcon size={16} />
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Hide chat panel"
            title="Hide chat (C / Esc)"
            className="ep-bar-icon-btn h-7 w-7 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center text-secondary hover:text-white cursor-pointer"
          >
            <PlayerCollapseRightIcon size={15} />
          </button>

          {optionsPresence.mounted && (
            <div
              className={`ep-glass-submenu absolute right-0 top-8.5 z-30 w-52 rounded-2xl p-2 space-y-2.5 ${
                optionsPresence.exiting
                  ? "anim-pop-out pointer-events-none"
                  : "anim-pop-in"
              }`}
            >
              <div className="px-1.5 pt-0.5 space-y-1.5">
                <div className="text-[10.5px] font-medium text-muted">Chat button</div>
                <div className="grid grid-cols-2 gap-1 p-0.5 rounded-xl bg-white/[0.04]">
                  <button
                    type="button"
                    onClick={() => setChatTriggerPlacement("playbar")}
                    className={`h-7 rounded-lg text-[11px] font-medium cursor-pointer ${
                      chatTriggerPlacement === "playbar"
                        ? "bg-white/[0.14] text-white"
                        : "text-secondary hover:text-white"
                    }`}
                  >
                    Play Bar
                  </button>
                  <button
                    type="button"
                    onClick={() => setChatTriggerPlacement("edge")}
                    className={`h-7 rounded-lg text-[11px] font-medium cursor-pointer ${
                      chatTriggerPlacement === "edge"
                        ? "bg-white/[0.14] text-white"
                        : "text-secondary hover:text-white"
                    }`}
                  >
                    Right Edge
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setChatPeeksEnabled(!chatPeeksEnabled)}
                className="w-full px-2 py-1.5 rounded-xl hover:bg-white/[0.06] flex items-center justify-between gap-2 text-[11.5px] text-secondary hover:text-white cursor-pointer"
              >
                <span>Corner peeks</span>
                <span
                  className={`text-[11px] font-medium ${
                    chatPeeksEnabled ? "text-accent-soft" : "text-muted"
                  }`}
                >
                  {chatPeeksEnabled ? "On" : "Off"}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Compact Social Voice Strip (hidden while Watch Party popover is open) */}
      <AnimatedCollapse
        open={
          !roomPanelOpen &&
          syncStatus.state === "connected" &&
          voiceEnabled &&
          (voiceJoined || voicePeersInCall.length > 0)
        }
        innerClassName="px-4 pb-2"
      >
        <div
          ref={voiceAudioRef}
          className="relative py-1 flex items-center justify-between gap-2"
        >
          {voiceJoined ? (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <AppVoiceWaveIcon
                  active
                  speaking={activeVoiceSpeakers.length > 0}
                  size={13}
                  className="shrink-0"
                />
                <div className="min-w-0">
                  <div
                    className={`text-[11px] font-medium truncate ${
                      activeVoiceSpeakers.length > 0 ? "text-[#38BDF8]" : "text-white/90"
                    }`}
                  >
                    {activeVoiceSpeakers.length > 0
                      ? activeVoiceSpeakers.length === 1
                        ? `${activeVoiceSpeakers[0]} speaking`
                        : `${activeVoiceSpeakers.slice(0, 2).join(", ")} speaking`
                      : `Voice · ${voicePeersInCall.length + 1}`}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <VoiceMicDeafenPills
                  muted={voiceMuted}
                  deafened={voiceDeafened}
                  speaking={localVoiceSpeaking}
                  captureHealthy={isCaptureHealthy(voiceStreamStatus)}
                />

                <GlassHoverTip
                  label="Audio & Devices"
                  detail="Mic, output & ducking"
                >
                  <button
                    type="button"
                    aria-label="Chat voice audio settings"
                    aria-expanded={voiceAudioOpen}
                    onClick={() => setVoiceAudioOpen((o) => !o)}
                    className={`ep-bar-pill ep-press h-7 w-7 rounded-full flex items-center justify-center cursor-pointer ${
                      voiceAudioOpen
                        ? "bg-white/15 text-white border-white/30"
                        : "text-secondary hover:text-white"
                    }`}
                  >
                    <AppVoiceTuneIcon active={voiceAudioOpen} size={14} />
                  </button>
                </GlassHoverTip>

                <GlassHoverTip
                  label="Leave voice"
                  accent="bad"
                >
                  <button
                    type="button"
                    aria-label="Leave voice chat"
                    data-tone="leave"
                    onClick={() => void toggleVoiceSession()}
                    className="ep-bar-pill ep-press h-7 w-7 rounded-full flex items-center justify-center cursor-pointer"
                  >
                    <PartyLeaveIcon size={13} />
                  </button>
                </GlassHoverTip>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex items-center -space-x-1 shrink-0">
                  {voicePeersInCall.slice(0, 3).map((peer) => {
                    const speaking = isParticipantSpeaking(
                      peer.username,
                      effectiveUsername,
                      voiceCheckInput,
                    );
                    return (
                      <ProfileAvatar
                        key={peer.username}
                        avatarId={resolvePeerAvatarId(peer.username, effectiveUsername)}
                        size={17}
                        className={
                          speaking
                            ? "ring-[1.5px] ring-[#38BDF8] ep-speaking-ring"
                            : "ring-1 ring-[#08080d]"
                        }
                      />
                    );
                  })}
                </div>
                <span className="text-[11px] font-medium text-secondary truncate">
                  {voicePeersInCall.length} in voice
                </span>
              </div>
              <button
                type="button"
                disabled={voiceJoining}
                onClick={() => void toggleVoiceSession({ skipBtCheck: true })}
                className="ep-glass-primary-pill ep-press h-6 px-2.5 rounded-full text-[10.5px] font-medium text-white shrink-0 cursor-pointer disabled:opacity-50"
              >
                {voiceJoining ? "Joining…" : "Join"}
              </button>
            </>
          )}

          {voiceAudioPresence.mounted &&
            voiceAudioPresence.value &&
            typeof document !== "undefined" &&
            createPortal(
              <div
                ref={voiceAudioPortalRef}
                data-glass-region="true"
                style={{
                  left: `${voiceAudioPresence.value.left}px`,
                  top: `${voiceAudioPresence.value.top}px`,
                  transformOrigin: "top right",
                }}
                className={`ep-glass-submenu fixed z-[75] w-[244px] rounded-2xl p-2 ${
                  voiceAudioPresence.exiting
                    ? "ep-popover-bloom-out pointer-events-none"
                    : "ep-popover-bloom"
                }`}
              >
                <VoiceQuickSettingsTray
                  open={voiceAudioOpen}
                  onOpenFullSettings={() => {
                    setVoiceAudioOpen(false);
                    openSettings("voice");
                  }}
                />
              </div>,
              document.body,
            )}
        </div>
      </AnimatedCollapse>

      {/* Messages Feed */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="ep-menu-scroll ep-chat-feed-mask flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3.5 pt-4 pb-4 space-y-1"
        >
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8">
              <div className="h-10 w-10 rounded-full bg-white/[0.05] flex items-center justify-center text-accent-soft mb-3">
                <PlayerChatIcon active size={18} />
              </div>
              <p className="text-[13px] font-medium text-white/90">
                Say hello to the party
              </p>
              <p className="text-[11.5px] text-muted mt-1 max-w-[240px] leading-relaxed">
                Drop a message or tag a scene timestamp like{" "}
                <span className="text-secondary num">14:32</span> for everyone to jump to.
              </p>
              {syncStatus.state === "connected" && (
                <div className="flex flex-wrap items-center justify-center gap-1.5 mt-4">
                  {QUICK_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => handleSend(chip)}
                      className="ep-press px-3 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.11] text-[11.5px] text-secondary hover:text-white cursor-pointer"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((msg, idx) => {
              const showUnreadDivider = unreadSinceId === msg.id;

              if (msg.kind === "system") {
                return (
                  <div key={msg.id} className="py-2 text-center">
                    <span className="text-[11px] text-muted/75">{msg.text}</span>
                  </div>
                );
              }

              const showTimeDivider = shouldShowTimeDivider(messages, idx);
              const groupPos = computeMessageGroupPosition(messages, idx);
              const showSenderHeader =
                !msg.isSelf && (groupPos === "solo" || groupPos === "first");
              const spacerTop =
                idx > 0 && (groupPos === "solo" || groupPos === "first")
                  ? "mt-3.5"
                  : "mt-0.5";

              const quotedMsg = msg.replyToId ? messageById.get(msg.replyToId) : null;
              const senderIsHost =
                roomControl.hostUsername?.trim().toLowerCase() ===
                msg.sender.trim().toLowerCase();
              const resolvedAvatar = resolvePeerAvatarId(
                msg.sender,
                effectiveUsername,
                msg.isSelf ? localAvatarId : msg.avatarId || undefined,
              );
              const peerTint = hideParticipants
                ? "text-secondary"
                : resolvePeerNameTint(msg.sender);
              const mentionsMe =
                !msg.isSelf && textMentionsUsername(msg.text, effectiveUsername);
              const isJumboEmoji =
                !quotedMsg && !msg.editedAtMs && isPureEmojiMessage(msg.text);
              const reactionEntries = Object.entries(msg.reactions).filter(
                ([, users]) => users.length > 0,
              );

              return (
                <div key={msg.id}>
                  {showTimeDivider && (
                    <div className="my-2.5 text-center select-none">
                      <span className="px-2 py-0.5 text-[10.5px] font-medium text-muted/75 num">
                        {formatChatClock(msg.timestampMs)}
                      </span>
                    </div>
                  )}

                  {showUnreadDivider && (
                    <div className="my-2.5 text-center">
                      <span className="px-2.5 py-0.5 rounded-full bg-accent/20 text-[10px] font-medium uppercase tracking-wider text-accent-soft">
                        New
                      </span>
                    </div>
                  )}

                  <div
                    ref={(el) => {
                      msgRefs.current[msg.id] = el;
                    }}
                    className={`group/msg flex flex-col ${spacerTop} ${
                      msg.isSelf ? "items-end" : "items-start"
                    }`}
                  >
                    {showSenderHeader && (
                      <div className="flex items-center gap-1.5 mb-1.5 px-0.5">
                        {!hideParticipants && (
                          <ProfileAvatar
                            avatarId={resolvedAvatar}
                            size={18}
                            className="shrink-0"
                          />
                        )}
                        <span className={`text-[11.5px] font-medium max-w-[170px] truncate ${peerTint}`}>
                          {hideParticipants ? "Friend" : msg.sender}
                        </span>
                        {!hideParticipants && senderIsHost && (
                          <span className="text-[10px] font-medium text-accent-soft/85">
                            · Host
                          </span>
                        )}
                        <span className="text-[10px] text-muted/70 num opacity-0 group-hover/msg:opacity-100 transition-opacity">
                          {formatChatClock(msg.timestampMs)}
                        </span>
                      </div>
                    )}

                    {/* Clean whisper reply quote (zero card/box) */}
                    {quotedMsg && (
                      <button
                        type="button"
                        onClick={() => jumpToMessage(quotedMsg.id)}
                        className={`mb-1 flex items-center gap-1.5 max-w-[85%] text-left cursor-pointer opacity-75 hover:opacity-100 transition-opacity ${
                          msg.isSelf
                            ? "pr-2 border-r-2 border-accent-soft/55"
                            : "pl-2 border-l-2 border-accent-soft/55"
                        }`}
                      >
                        <span
                          className={`text-[11px] font-medium shrink-0 ${
                            quotedMsg.isSelf
                              ? "text-accent-soft"
                              : hideParticipants
                                ? "text-secondary"
                                : resolvePeerNameTint(quotedMsg.sender)
                          }`}
                        >
                          {quotedMsg.isSelf
                            ? "You"
                            : hideParticipants
                              ? "Friend"
                              : quotedMsg.sender}
                        </span>
                        <span
                          dir="auto"
                          className="text-[11px] text-secondary/90 truncate min-w-0"
                        >
                          {quotedMsg.text}
                        </span>
                      </button>
                    )}

                    <div
                      className={`relative max-w-[86%] flex flex-col ${
                        msg.isSelf ? "items-end" : "items-start"
                      }`}
                    >
                      {/* Floating corner action pill (zero layout shift on hover) */}
                      <div
                        className={`ep-chat-hover-pill w-max absolute -top-3.5 z-20 rounded-full px-1 py-0.5 flex items-center gap-0.5 opacity-0 scale-95 pointer-events-none group-hover/msg:opacity-100 group-hover/msg:scale-100 group-hover/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-focus-within/msg:scale-100 group-focus-within/msg:pointer-events-auto ${
                          msg.isSelf ? "right-1 flex-row-reverse" : "left-1 flex-row"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setReplyToId(msg.id);
                            textareaRef.current?.focus({ preventScroll: true });
                          }}
                          aria-label="Reply to message"
                          title="Reply"
                          className="h-5.5 w-5.5 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.10] cursor-pointer"
                        >
                          <PlayerReplyIcon size={11} />
                        </button>
                        {msg.isSelf && (
                          <button
                            type="button"
                            onClick={() => setEditingMsgId(msg.id)}
                            aria-label="Edit message"
                            title="Edit"
                            className="h-5.5 w-5.5 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.10] cursor-pointer"
                          >
                            <PlayerEditIcon size={11} />
                          </button>
                        )}
                        <div className="flex items-center">
                          {MESSAGE_QUICK_REACTIONS.slice(0, 3).map((em) => (
                            <button
                              key={em}
                              type="button"
                              onClick={() => togglePartyChatReaction(msg.id, em)}
                              title={`React ${em}`}
                              className="h-5.5 w-5.5 rounded-full flex items-center justify-center text-[11px] hover:bg-white/[0.12] hover:scale-110 transition-transform cursor-pointer"
                            >
                              {em}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div
                        title={`${formatChatClock(msg.timestampMs)} · Double-click to ❤️`}
                        onDoubleClick={(e) => {
                          if ((e.target as HTMLElement).closest("button")) return;
                          togglePartyChatReaction(msg.id, "❤️");
                        }}
                        className={`relative break-words whitespace-pre-wrap select-text ${
                          isJumboEmoji
                            ? `px-1 py-0.5 text-[30px] leading-[1.15] ep-chat-jumbo-in cursor-default ${
                                pulsingMsgId === msg.id ? "ep-chat-target-pulse rounded-xl" : ""
                              }`
                            : `px-3.5 py-2 text-[13px] leading-[1.46] ${getBubbleRadiusClass(
                                msg.isSelf,
                                groupPos,
                              )} ${
                                msg.isSelf
                                  ? "ep-chat-bubble-out ep-chat-msg-in-right text-white"
                                  : "ep-chat-bubble-in ep-chat-msg-in-left text-primary"
                              } ${mentionsMe ? "ring-1 ring-accent-soft/45" : ""} ${
                                pulsingMsgId === msg.id ? "ep-chat-target-pulse" : ""
                              }`
                        }`}
                      >
                        <div dir="auto">
                          {renderMessageContent(msg)}
                          {msg.editedAtMs && (
                            <span className="ml-1.5 text-[10px] text-white/50 select-none">
                              edited
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Tightly tucked corner tapback badges */}
                      {reactionEntries.length > 0 && (
                        <div
                          className={`relative z-10 flex flex-wrap items-center gap-1 px-1 ${
                            isJumboEmoji ? "mt-0.5" : "-mt-2"
                          } ${msg.isSelf ? "justify-end" : ""}`}
                        >
                          {reactionEntries.map(([emoji, users]) => {
                            const iReacted = users.some(
                              (u) =>
                                u.trim().toLowerCase() === effectiveUsername.trim().toLowerCase(),
                            );
                            return (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => togglePartyChatReaction(msg.id, emoji)}
                                title={hideParticipants ? `${users.length}` : users.join(", ")}
                                className={`ep-chat-react-pop inline-flex items-center gap-1 h-[21px] px-1.5 rounded-full text-[11px] cursor-pointer num shadow-[0_2px_8px_rgba(0,0,0,0.45)] ${
                                  iReacted
                                    ? "bg-accent text-white"
                                    : "bg-[#171722] text-secondary hover:text-white hover:bg-[#222232]"
                                }`}
                              >
                                <span className="leading-none">{emoji}</span>
                                <span className="text-[10px] font-medium leading-none">{users.length}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* Live Typing Indicator */}
          {activeTypingNames.length > 0 && (
            <div className="flex items-center gap-2 pt-2.5 anim-pop-in">
              <div className="ep-chat-bubble-in rounded-full px-3 py-1.5 inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1">
                  <span className="ep-chat-typing-dot h-1.5 w-1.5 rounded-full bg-accent-soft" />
                  <span
                    className="ep-chat-typing-dot h-1.5 w-1.5 rounded-full bg-accent-soft"
                    style={{ animationDelay: "160ms" }}
                  />
                  <span
                    className="ep-chat-typing-dot h-1.5 w-1.5 rounded-full bg-accent-soft"
                    style={{ animationDelay: "320ms" }}
                  />
                </span>
                <span className="text-[11px] text-secondary max-w-[180px] truncate">
                  {hideParticipants
                    ? "Someone is typing"
                    : activeTypingNames.length === 1
                      ? `${activeTypingNames[0]} is typing`
                      : `${activeTypingNames.length} friends typing`}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Jump to latest pill when scrolled up */}
        {unseenBelow > 0 && !atBottom && (
          <div className="pointer-events-none absolute bottom-2 inset-x-0 flex justify-center z-10">
            <button
              type="button"
              onClick={() => scrollToBottom("smooth")}
              className="pointer-events-auto ep-glass-pill ep-press anim-pop-in px-3 py-1 rounded-full text-[11px] font-medium text-white cursor-pointer"
            >
              {unseenBelow === 1 ? "New message ↓" : `${unseenBelow} new messages ↓`}
            </button>
          </div>
        )}
      </div>

      {/* Collapsible Inline Emoji Tray */}
      <div className="ep-collapse shrink-0" data-open={emojiOpen ? "true" : "false"}>
        <div className="ep-collapse-inner">
          <div className="mx-3 mb-2 p-2.5 rounded-2xl bg-white/[0.05] space-y-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-black/25">
              <AppSearchIcon size={12} className="text-muted shrink-0" />
              <input
                type="text"
                value={emojiQuery}
                onChange={(e) => setEmojiQuery(e.target.value)}
                placeholder="Search emoji…"
                className="w-full bg-transparent text-[11.5px] text-white placeholder:text-muted focus:outline-none"
              />
              {emojiQuery && (
                <button
                  type="button"
                  onClick={() => setEmojiQuery("")}
                  aria-label="Clear emoji search"
                  className="text-muted hover:text-white cursor-pointer"
                >
                  <AppCloseIcon size={11} />
                </button>
              )}
            </div>
            <div className="grid grid-cols-8 gap-1">
              {filteredEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => handleInsertEmoji(emoji)}
                  className="ep-reaction-tile h-7.5 w-full rounded-lg flex items-center justify-center text-[16px] cursor-pointer"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* @Mention Autocomplete */}
      {mentionCandidates.length > 0 && (
        <div className="px-3 pb-1.5 flex items-center gap-1.5 flex-wrap shrink-0">
          {mentionCandidates.map((name, i) => (
            <button
              key={name}
              type="button"
              onClick={() => applyMention(name)}
              className={`px-2.5 py-1 rounded-full text-[11.5px] font-medium cursor-pointer ${
                i === mentionIdx
                  ? "bg-accent/45 text-white"
                  : "bg-white/[0.06] text-secondary hover:text-white hover:bg-white/[0.10]"
              }`}
            >
              @{name}
            </button>
          ))}
        </div>
      )}

      {/* Comfortable, Cushioned Single-Surface Composer + Separate Send Button */}
      <div className="ep-chat-composer-zone px-3 pb-5 pt-2 shrink-0">
        {(replyTarget || editTarget) && (
          <div className="mb-1.5 px-2.5 py-1 rounded-xl bg-white/[0.04] flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-[2px] h-3 rounded-full bg-accent-soft shrink-0" />
              <span className="text-accent-soft font-medium shrink-0">
                {editTarget
                  ? "Editing"
                  : `Replying to ${
                      replyTarget!.isSelf
                        ? "yourself"
                        : hideParticipants
                          ? "Friend"
                          : replyTarget!.sender
                    }`}
              </span>
              <span dir="auto" className="text-secondary/80 truncate">
                {editTarget ? editTarget.text : replyTarget!.text}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                if (editTarget) {
                  setEditingMsgId(null);
                  setDraft("");
                } else {
                  setReplyToId(null);
                }
              }}
              aria-label={editTarget ? "Cancel edit" : "Cancel reply"}
              className="h-5 w-5 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.08] shrink-0 cursor-pointer"
            >
              <AppCloseIcon size={11} />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <div
            data-expanded={composerExpanded || Boolean(replyTarget) || Boolean(editTarget) ? "true" : "false"}
            className="ep-chat-composer-surface flex-1 min-w-0 flex items-end gap-1 px-2 py-1.5"
          >
            <button
              type="button"
              onClick={() => setEmojiOpen((v) => !v)}
              aria-label="Insert emoji"
              aria-pressed={emojiOpen}
              title="Emoji"
              className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 cursor-pointer ${
                emojiOpen
                  ? "text-accent-soft bg-white/[0.09]"
                  : "text-muted hover:text-white hover:bg-white/[0.06]"
              }`}
            >
              <PlayerSmileIcon size={16} />
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              dir="auto"
              value={draft}
              disabled={syncStatus.state !== "connected"}
              maxLength={MAX_CHAT_MESSAGE_CHARS + 40}
              placeholder={syncStatus.state === "connected" ? "Message…" : "Connecting…"}
              onChange={(e) => {
                const val = e.target.value;
                setDraft(val);
                notifyPartyChatTyping(val.trim().length > 0);
              }}
              onBlur={() => notifyPartyChatTyping(false)}
              onKeyDown={handleComposerKeyDown}
              className="flex-1 min-w-0 bg-transparent resize-none text-[13.5px] leading-[1.45] py-1 px-0.5 text-primary placeholder:text-muted/65 focus:outline-none max-h-[112px] ep-menu-scroll select-text disabled:opacity-50"
            />

            <div className="flex items-center gap-0.5 shrink-0">
              {trimmedDraftLen >= 380 && (
                <span
                  className={`text-[10px] num mr-1 ${
                    trimmedDraftLen > MAX_CHAT_MESSAGE_CHARS ? "text-bad" : "text-muted"
                  }`}
                >
                  {MAX_CHAT_MESSAGE_CHARS - trimmedDraftLen}
                </span>
              )}

              <button
                type="button"
                disabled={!mediaLoaded}
                onClick={() => {
                  const pos = usePlayerStore.getState().positionSecs;
                  insertAtCursor(`${formatMediaTimestamp(pos)} `);
                }}
                aria-label="Tag current video timestamp"
                title={mediaLoaded ? "Tag current scene time" : "Load a video to tag time"}
                className="h-8 w-8 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
              >
                <PlayerClockIcon size={15} />
              </button>
            </div>
          </div>

          <button
            type="button"
            disabled={!canSend || trimmedDraftLen > MAX_CHAT_MESSAGE_CHARS}
            onClick={() => handleSend()}
            data-ready={canSend && trimmedDraftLen <= MAX_CHAT_MESSAGE_CHARS ? "true" : "false"}
            aria-label={editTarget ? "Save edit" : "Send message"}
            title={editTarget ? "Save" : "Send"}
            className={`ep-chat-send-btn h-11 w-11 rounded-full flex items-center justify-center shrink-0 ${
              sendRecoil ? "ep-chat-send-recoil" : ""
            } ${
              canSend && trimmedDraftLen <= MAX_CHAT_MESSAGE_CHARS
                ? "text-white cursor-pointer"
                : "text-muted/55 cursor-default"
            }`}
          >
            <PlayerSendIcon size={18} />
          </button>
        </div>
      </div>
    </aside>
  );

  if (!docked) {
    return asideEl;
  }

  return (
    <div
      data-open={dockExpanded ? "true" : "false"}
      data-resizing={resizing ? "true" : undefined}
      style={{ width: dockExpanded ? `${sidebarWidth}px` : "0px" }}
      onTransitionEnd={(e) => {
        if (!resizing && e.target === e.currentTarget && e.propertyName === "width") {
          onDockTransitionEnd?.();
        }
      }}
      className={`ep-chat-dock-slot ${exiting ? "pointer-events-none" : ""}`}
    >
      {asideEl}
    </div>
  );
});
