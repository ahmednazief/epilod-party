import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
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
  notifyPartyChatSeen,
  notifyPartyChatTyping,
  parseChatTokens,
  requestPartyChatImage,
  resetTypingThrottle,
  resolvePeerNameTint,
  sendPartyChatEdit,
  sendPartyChatImage,
  sendPartyChatMessage,
  shouldShowTimeDivider,
  textMentionsUsername,
  togglePartyChatReaction,
} from "../lib/chat";
import { compressImageToWebP, formatBytesCompact } from "../lib/chatImages";
import { captureCleanFrozenFrame, mpvSetVisible, safeMpvCall } from "../lib/mpv";
import { getCachedSeekbarThumbnails, getThumbnailFrameStyle } from "../lib/thumbnails";
import { filterEmojiCatalog } from "../lib/reactions";
import { formatInviteLink, formatRoomCodeClipboardText } from "../lib/inviteLinks";
import { playSoundCue } from "../lib/soundEffects";
import { resolveEffectiveUsername } from "../lib/syncController";
import { useAnimatedPresence, usePresencePayload } from "../lib/useAnimatedPresence";
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
import { ChatVoiceStrip } from "./ChatVoiceStrip";
import { formatRoomCodeDisplay } from "./HomeScreen";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import {
  AppChevronIcon,
  AppCloseIcon,
  AppPlusIcon,
  AppSearchIcon,
  AppVoiceIcon,
} from "./ui/AppIcons";
import { GlassHoverTip } from "./ui/GlassHoverTip";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { WatchPartyIcon } from "./ui/LobbyIcons";
import {
  MenuChatPhotosIcon,
  MenuChatTriggerIcon,
  MenuCornerPeekIcon,
  MenuPhotoRetentionIcon,
} from "./ui/MenuIcons";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import {
  EphemeralTimerRing,
  PartyCopyIcon,
  PartyLinkIcon,
  PlayerCameraSnapIcon,
  PlayerChatIcon,
  PlayerClockIcon,
  PlayerCollapseRightIcon,
  PlayerEditIcon,
  PlayerImageIcon,
  PlayerMoreIcon,
  PlayerPlayIcon,
  PlayerReplyIcon,
  PlayerSendIcon,
  PlayerSmileIcon,
} from "./ui/PlayerIcons";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";

interface ChatSidebarProps {
  docked: boolean;
  exiting: boolean;
  width?: number;
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
  width,
  topChromeOffset,
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
  const seenByPeer = useChatStore((s) => s.seenByPeer);
  const chatOpen = useChatStore((s) => s.chatOpen);
  const revealImageSpoiler = useChatStore((s) => s.revealImageSpoiler);
  const pruneExpiredTyping = useChatStore((s) => s.pruneExpiredTyping);
  const sidebarWidth = useChatStore((s) => s.sidebarWidth);
  const resolvedSidebarWidth = width ?? sidebarWidth;
  const setSidebarWidth = useChatStore((s) => s.setSidebarWidth);

  const username = useAppStore((s) => s.username);
  const localAvatarId = useAppStore((s) => s.avatarId);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const recentEmojis = useAppStore((s) => s.recentEmojis);
  const reactionPresets = useAppStore((s) => s.reactionPresets);
  const pushRecentEmoji = useAppStore((s) => s.pushRecentEmoji);
  const chatPeeksEnabled = useAppStore((s) => s.chatPeeksEnabled);
  const setChatPeeksEnabled = useAppStore((s) => s.setChatPeeksEnabled);
  const chatTriggerPlacement = useAppStore((s) => s.chatTriggerPlacement);
  const setChatTriggerPlacement = useAppStore((s) => s.setChatTriggerPlacement);
  const chatImageMode = useAppStore((s) => s.chatImageMode);
  const setChatImageMode = useAppStore((s) => s.setChatImageMode);
  const chatImageRetention = useAppStore((s) => s.chatImageRetention);
  const setChatImageRetention = useAppStore((s) => s.setChatImageRetention);
  const selectedFilePath = useAppStore((s) => s.selectedFilePath);
  const seekbarThumbnails = useAppStore((s) => s.seekbarThumbnails);
  const roomCode = useAppStore((s) => s.roomCode);
  const literalRoom = useAppStore((s) => s.literalRoom);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const roomControl = useSyncStore((s) => s.roomControl);
  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const voiceJoined = useVoiceStore((s) => s.joined);
  const voiceRoster = useVoiceStore((s) => s.roster);

  const mediaLoaded = usePlayerStore((s) => s.loaded);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);

  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiQuery, setEmojiQuery] = useState("");
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [voiceExpanded, setVoiceExpanded] = useState(false);
  const [roomCodeCopied, setRoomCodeCopied] = useState(false);
  const [roomLinkCopied, setRoomLinkCopied] = useState(false);
  const roomCopyTimerRef = useRef<number | null>(null);
  const roomLinkCopyTimerRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseenBelow, setUnseenBelow] = useState(0);
  const [pulsingMsgId, setPulsingMsgId] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [resizing, setResizing] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [sendRecoil, setSendRecoil] = useState(false);
  const [pendingImage, setPendingImage] = useState<{
    width: number;
    height: number;
    byteLen: number;
    dataB64: string;
    objectUrl: string;
    spoiler: boolean;
  } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragOverImage, setDragOverImage] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{
    objectUrl: string;
    caption?: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const attachMenuPresence = useAnimatedPresence(attachMenuOpen, 160);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
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
  const composerBannerPayload = useMemo(
    () =>
      editTarget
        ? { mode: "edit" as const, msg: editTarget }
        : replyTarget
          ? { mode: "reply" as const, msg: replyTarget }
          : null,
    [editTarget, replyTarget],
  );
  const composerBanner = usePresencePayload(composerBannerPayload, 250);

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

  // Close options & attach popovers on outside click
  useEffect(() => {
    if (!optionsOpen && !attachMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (target instanceof Element && target.closest('[role="listbox"]')) {
        return;
      }
      if (optionsOpen && optionsMenuRef.current && !optionsMenuRef.current.contains(target)) {
        setOptionsOpen(false);
      }
      if (attachMenuOpen && attachMenuRef.current && !attachMenuRef.current.contains(target)) {
        setAttachMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [attachMenuOpen, optionsOpen]);

  useEffect(() => {
    if (!attachMenuOpen) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setAttachMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [attachMenuOpen]);

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

  const clearPendingImage = useCallback((revoke = true) => {
    setPendingImage((prev) => {
      if (prev && revoke) {
        try {
          URL.revokeObjectURL(prev.objectUrl);
        } catch {
          // Ignore revoke errors
        }
      }
      return null;
    });
    setImageError(null);
  }, []);

  useEffect(() => {
    if (!lightboxImage) return;
    if (mediaLoaded) {
      safeMpvCall(mpvSetVisible(false), "chatLightbox:hideMpv");
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setLightboxImage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (
        mediaLoaded &&
        !useAppStore.getState().settingsOpen &&
        !useAppStore.getState().shortcutsOpen
      ) {
        safeMpvCall(mpvSetVisible(true), "chatLightbox:showMpv");
      }
    };
  }, [lightboxImage, mediaLoaded]);

  useEffect(() => {
    return () => {
      clearPendingImage(true);
    };
  }, [clearPendingImage]);

  const stageImageSource = useCallback(
    async (source: Blob | string) => {
      if (imageBusy) return;
      setImageBusy(true);
      setImageError(null);
      try {
        const compressed = await compressImageToWebP(source);
        setPendingImage((prev) => {
          if (prev) {
            try {
              URL.revokeObjectURL(prev.objectUrl);
            } catch {
              // Ignore
            }
          }
          return { ...compressed, spoiler: false };
        });
      } catch (err) {
        setImageError(err instanceof Error ? err.message : "Could not process image.");
      } finally {
        setImageBusy(false);
      }
    },
    [imageBusy],
  );

  const handleSnapVideoFrame = useCallback(async () => {
    if (!mediaLoaded || imageBusy) return;
    setImageBusy(true);
    setImageError(null);
    try {
      const dataUrl = await captureCleanFrozenFrame();
      if (!dataUrl) {
        setImageError("Could not capture current video frame.");
        return;
      }
      const compressed = await compressImageToWebP(dataUrl);
      setPendingImage((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev.objectUrl);
          } catch {
            // Ignore
          }
        }
        return { ...compressed, spoiler: false };
      });
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Could not capture frame.");
    } finally {
      setImageBusy(false);
    }
  }, [imageBusy, mediaLoaded]);

  const handleComposerPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void stageImageSource(file);
            return;
          }
        }
      }
    },
    [stageImageSource],
  );

  const handleAsideDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      setDragOverImage(true);
    }
  }, []);

  const handleAsideDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      setDragOverImage(false);
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) {
        e.preventDefault();
        e.stopPropagation();
        void stageImageSource(file);
      }
    },
    [stageImageSource],
  );

  useEffect(() => {
    if (!chatOpen || !atBottom || messages.length === 0) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const latest = [...messages].reverse().find((m) => m.kind === "message");
    if (latest) {
      notifyPartyChatSeen(latest.id);
    }
  }, [atBottom, chatOpen, messages]);

  const seenPeersByMsgId = useMemo(() => {
    const map: Record<string, string[]> = {};
    const myLower = effectiveUsername.trim().toLowerCase();
    for (const entry of Object.values(seenByPeer)) {
      if (!entry || typeof entry.username !== "string" || !entry.lastMsgId) continue;
      if (entry.username.trim().toLowerCase() === myLower) continue;
      if (!map[entry.lastMsgId]) map[entry.lastMsgId] = [];
      map[entry.lastMsgId].push(entry.username);
    }
    return map;
  }, [effectiveUsername, seenByPeer]);

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

      if (pendingImage && overrideText === undefined) {
        const staged = pendingImage;
        clearPendingImage(false);
        setDraft("");
        setEmojiOpen(false);
        setEmojiQuery("");
        void sendPartyChatImage({
          caption: draft,
          spoiler: staged.spoiler,
          width: staged.width,
          height: staged.height,
          byteLen: staged.byteLen,
          dataB64: staged.dataB64,
          objectUrl: staged.objectUrl,
          replyToId,
        }).catch((err) => {
          setImageError(err instanceof Error ? err.message : "Could not send photo.");
        });
        setSendRecoil(true);
        if (sendRecoilTimerRef.current !== null) {
          window.clearTimeout(sendRecoilTimerRef.current);
        }
        sendRecoilTimerRef.current = window.setTimeout(() => {
          sendRecoilTimerRef.current = null;
          setSendRecoil(false);
        }, 240);
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
      if (attachMenuOpen) {
        e.preventDefault();
        e.stopPropagation();
        setAttachMenuOpen(false);
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

  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
      if (roomCopyTimerRef.current !== null) {
        window.clearTimeout(roomCopyTimerRef.current);
      }
      if (roomLinkCopyTimerRef.current !== null) {
        window.clearTimeout(roomLinkCopyTimerRef.current);
      }
    };
  }, []);

  const handleCopyRoomCode = async () => {
    if (!roomCode) return;
    try {
      const text = formatRoomCodeClipboardText(roomCode, literalRoom);
      await navigator.clipboard.writeText(text);
      setRoomCodeCopied(true);
      const p = usePlayerStore.getState();
      playSoundCue("codeCopied", { moviePlaying: p.loaded && !p.paused });
      if (roomCopyTimerRef.current !== null) window.clearTimeout(roomCopyTimerRef.current);
      roomCopyTimerRef.current = window.setTimeout(() => {
        roomCopyTimerRef.current = null;
        setRoomCodeCopied(false);
      }, 1600);
    } catch {
      // Clipboard restricted
    }
  };

  const handleCopyRoomLink = async () => {
    if (!roomCode) return;
    try {
      const link = formatInviteLink(roomCode, literalRoom, serverEndpoint);
      if (!link) return;
      await navigator.clipboard.writeText(link);
      setRoomLinkCopied(true);
      const p = usePlayerStore.getState();
      playSoundCue("codeCopied", { moviePlaying: p.loaded && !p.paused });
      if (roomLinkCopyTimerRef.current !== null) window.clearTimeout(roomLinkCopyTimerRef.current);
      roomLinkCopyTimerRef.current = window.setTimeout(() => {
        roomLinkCopyTimerRef.current = null;
        setRoomLinkCopied(false);
      }, 1600);
    } catch {
      // Clipboard restricted
    }
  };

  const handleResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizeCleanupRef.current?.();
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
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (resizeCleanupRef.current === cleanup) {
        resizeCleanupRef.current = null;
      }
    };
    const onUp = () => {
      setResizing(false);
      onResizingChange?.(false);
      cleanup();
    };
    resizeCleanupRef.current = cleanup;
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
      for (const emoji of reactionPresets) {
        if (!merged.includes(emoji)) merged.push(emoji);
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
  }, [emojiQuery, recentEmojis, reactionPresets]);

  const trimmedDraftLen = Array.from(draft).length;
  const canSend =
    (draft.trim().length > 0 || Boolean(pendingImage)) &&
    syncStatus.state === "connected";

  const localSprite = useMemo(
    () =>
      seekbarThumbnails && selectedFilePath
        ? getCachedSeekbarThumbnails(selectedFilePath, durationSecs)
        : null,
    [durationSecs, seekbarThumbnails, selectedFilePath],
  );

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
                void navigator.clipboard
                  ?.writeText(tok.href)
                  .then(() => {
                    usePlayerStore.getState().flashFeedback("Link copied");
                  })
                  .catch(() => undefined);
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
      aria-label="Party Lounge"
      data-docked-sidebar={docked ? "true" : undefined}
      data-sidebar-surface="true"
      onDragOver={handleAsideDragOver}
      onDragLeave={() => setDragOverImage(false)}
      onDrop={handleAsideDrop}
      style={{ width: `${resolvedSidebarWidth}px` }}
      className={`ep-chat-sidebar relative h-full flex flex-col shrink-0 select-none ${
        dragOverImage ? "ring-2 ring-inset ring-accent-soft/60" : ""
      } ${
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
        className={`ep-chat-header-zone relative z-30 px-5 pb-2.5 flex items-center justify-between gap-2 shrink-0 transition-[padding-top] duration-200 ease-out ${
          topChromeOffset ? "pt-[48px]" : "pt-3.5"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <WatchPartyIcon bare size={15} className="shrink-0" />
          <h2 className="text-[14px] font-semibold tracking-tight text-white leading-tight truncate">
            Party Lounge
          </h2>
        </div>

        <div ref={optionsMenuRef} className="relative flex items-center gap-1.5 shrink-0">
          {syncStatus.state !== "connected" ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.04] text-[10.5px] font-medium text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn shrink-0" />
              <span>Connecting…</span>
            </span>
          ) : voiceEnabled && voiceJoined && voiceExpanded ? (
            <button
              type="button"
              onClick={() => setVoiceExpanded(false)}
              title="Collapse Voice Lounge"
              aria-label="Collapse Voice Lounge"
              className="ep-press h-6.5 px-2.5 rounded-full bg-white/[0.055] hover:bg-white/[0.10] inline-flex items-center gap-1.5 text-[11px] font-medium text-white/90 cursor-pointer"
            >
              <AppVoiceIcon active size={12} className="text-ok shrink-0" />
              <span className="num">
                {Math.max(
                  1,
                  participants.filter((p) => {
                    const key = p.username.trim().toLowerCase();
                    return (
                      key === effectiveUsername.trim().toLowerCase() ||
                      voiceRoster.some((r) => r.username.trim().toLowerCase() === key)
                    );
                  }).length,
                )}
              </span>
              <AppChevronIcon direction="up" size={10} className="text-muted/80 shrink-0" />
            </button>
          ) : null}

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

          {optionsPresence.mounted && (
            <div
              className={`ep-glass-submenu !bg-[#0c0c14]/[0.97] absolute right-0 top-8.5 z-30 w-58 rounded-2xl p-2.5 space-y-2.5 ${
                optionsPresence.exiting
                  ? "anim-pop-out pointer-events-none"
                  : "anim-pop-in"
              }`}
            >
              {roomCode && (
                <div className="w-full px-2.5 py-2 rounded-xl bg-white/[0.04] flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium text-secondary/80 leading-none whitespace-nowrap">
                      Invite code
                    </div>
                    <div className="text-[12.5px] font-semibold tracking-wider text-white num mt-1 leading-none whitespace-nowrap">
                      {literalRoom ? roomCode : formatRoomCodeDisplay(roomCode)}
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleCopyRoomCode()}
                      aria-label="Copy room code"
                      title={roomCodeCopied ? "Code copied" : "Copy 6-digit code"}
                      className={`ep-press h-7 w-7 rounded-lg inline-flex items-center justify-center cursor-pointer ${
                        roomCodeCopied
                          ? "bg-ok/16 text-ok"
                          : "bg-white/[0.07] text-secondary hover:text-white hover:bg-white/[0.12]"
                      }`}
                    >
                      <PartyCopyIcon copied={roomCodeCopied} size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyRoomLink()}
                      aria-label="Copy invite link"
                      title={roomLinkCopied ? "Link copied" : "Copy invite link"}
                      className={`ep-press h-7 w-7 rounded-lg inline-flex items-center justify-center cursor-pointer ${
                        roomLinkCopied
                          ? "bg-ok/16 text-ok"
                          : "bg-white/[0.07] text-secondary hover:text-white hover:bg-white/[0.12]"
                      }`}
                    >
                      <PartyLinkIcon copied={roomLinkCopied} size={12} />
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <div className="px-1 space-y-1.5">
                  <div className="flex items-center gap-2 text-[11.5px] font-medium text-white/88 leading-none">
                    <MenuChatTriggerIcon size={14} className="shrink-0" />
                    <span>Chat button</span>
                  </div>
                  <SegmentedTabs<"playbar" | "edge">
                    ariaLabel="Chat button placement"
                    size="sm"
                    fullWidth
                    value={chatTriggerPlacement}
                    onChange={setChatTriggerPlacement}
                    items={[
                      { value: "playbar", label: "Play Bar" },
                      { value: "edge", label: "Right Edge" },
                    ]}
                  />
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={chatPeeksEnabled}
                  onClick={() => setChatPeeksEnabled(!chatPeeksEnabled)}
                  className="ep-menu-row ep-press w-full px-1.5 py-1.5 -mx-0.5 rounded-xl flex items-center justify-between gap-2 text-[11.5px] font-medium text-white/88 hover:text-white cursor-pointer"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <MenuCornerPeekIcon size={14} className="shrink-0" />
                    <span>Corner peeks</span>
                  </span>
                  <GlassSwitchTrack checked={chatPeeksEnabled} size="sm" />
                </button>

                <div className="px-1 space-y-1.5">
                  <div className="flex items-center gap-2 text-[11.5px] font-medium text-white/88 leading-none">
                    <MenuChatPhotosIcon size={14} className="shrink-0" />
                    <span>Chat photos</span>
                  </div>
                  <SegmentedTabs<"auto" | "tap" | "off">
                    ariaLabel="Chat photos mode"
                    size="sm"
                    fullWidth
                    value={chatImageMode}
                    onChange={setChatImageMode}
                    items={[
                      { value: "auto", label: "Auto" },
                      { value: "tap", label: "Tap" },
                      { value: "off", label: "Off" },
                    ]}
                  />
                </div>

                {chatImageMode !== "off" && (
                  <div className="px-1 space-y-1.5">
                    <div className="flex items-center gap-2 text-[11.5px] font-medium text-white/88 leading-none">
                      <MenuPhotoRetentionIcon size={14} className="shrink-0" />
                      <span>Keep photos</span>
                    </div>
                    <SegmentedTabs<"30m" | "session">
                      ariaLabel="Chat photo retention"
                      size="sm"
                      fullWidth
                      value={chatImageRetention}
                      onChange={setChatImageRetention}
                      items={[
                        { value: "30m", label: "30m" },
                        { value: "session", label: "Session" },
                      ]}
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setOptionsOpen(false);
                    onClose();
                  }}
                  aria-label="Hide Party Lounge"
                  className="ep-menu-row ep-press w-full px-1.5 py-1.5 -mx-0.5 rounded-xl flex items-center justify-between gap-2 text-[11.5px] font-medium text-white/88 hover:text-white cursor-pointer"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <PlayerCollapseRightIcon size={14} className="shrink-0" />
                    <span>Hide lounge</span>
                  </span>
                  <span className="px-1.5 py-0.5 rounded-md bg-white/[0.06] text-[10px] font-medium text-secondary/80 leading-none">
                    C
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Expandable Voice Lounge Strip */}
      <ChatVoiceStrip expanded={voiceExpanded} onExpandedChange={setVoiceExpanded} />

      {/* Messages Feed */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="ep-menu-scroll ep-chat-feed-mask flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 pt-2.5 pb-4 space-y-1"
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
                      {/* Floating corner action pill (anchored away from sender header) */}
                      <div
                        className={`ep-chat-hover-pill w-max absolute -top-3 z-20 rounded-full p-0.5 flex items-center gap-0.5 opacity-0 scale-95 translate-y-0.5 pointer-events-none group-hover/msg:opacity-100 group-hover/msg:scale-100 group-hover/msg:translate-y-0 group-hover/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-focus-within/msg:scale-100 group-focus-within/msg:translate-y-0 group-focus-within/msg:pointer-events-auto ${
                          msg.isSelf ? "left-1 flex-row-reverse" : "right-1 flex-row"
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
                        <div dir="auto" className="space-y-1.5">
                          {msg.image && (
                            <div className="relative overflow-hidden rounded-xl">
                              {msg.image.status === "ready" && msg.image.objectUrl ? (
                                <div className="relative inline-block max-w-full overflow-hidden rounded-xl bg-black/30">
                                  <img
                                    src={msg.image.objectUrl}
                                    alt={msg.text || "Shared photo"}
                                    onClick={() => {
                                      if (msg.image?.spoiler && !msg.image.revealed) {
                                        revealImageSpoiler(msg.image.id);
                                      } else if (msg.image?.objectUrl) {
                                        setLightboxImage({
                                          objectUrl: msg.image.objectUrl,
                                          caption: msg.text || undefined,
                                        });
                                      }
                                    }}
                                    className={`max-h-56 w-auto max-w-full rounded-xl object-contain cursor-pointer transition-[filter,transform] duration-200 ${
                                      msg.image.spoiler && !msg.image.revealed
                                        ? "blur-xl scale-105 brightness-75"
                                        : ""
                                    }`}
                                  />
                                  {msg.image.spoiler && !msg.image.revealed && (
                                    <button
                                      type="button"
                                      onClick={() => revealImageSpoiler(msg.image!.id)}
                                      className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/30 text-white cursor-pointer"
                                    >
                                      <span className="px-2.5 py-1 rounded-full bg-black/60 border border-white/20 text-[11px] font-semibold tracking-wide">
                                        Spoiler · Tap to reveal
                                      </span>
                                    </button>
                                  )}
                                  {msg.image.expiresAtMs !== null && (
                                    <div
                                      title={`Ephemeral photo · expires in ${Math.max(
                                        1,
                                        Math.ceil((msg.image.expiresAtMs - Date.now()) / 60000),
                                      )}m`}
                                      className="absolute top-1.5 right-1.5 h-6 w-6 rounded-full bg-black/55 border border-white/15 flex items-center justify-center pointer-events-auto"
                                    >
                                      <EphemeralTimerRing
                                        size={16}
                                        receivedAtMs={msg.image.receivedAtMs}
                                        expiresAtMs={msg.image.expiresAtMs}
                                        paused={!chatOpen}
                                      />
                                    </div>
                                  )}
                                </div>
                              ) : msg.image.status === "pending-tap" ? (
                                <button
                                  type="button"
                                  onClick={() => requestPartyChatImage(msg.image!.id, msg.sender)}
                                  className="ep-press px-2.5 py-2 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] border border-white/12 flex items-center gap-2 text-[11.5px] text-white/90 cursor-pointer"
                                >
                                  <PlayerImageIcon size={15} active />
                                  <span>
                                    Photo ({formatBytesCompact(msg.image.byteLen)}) · Tap to load
                                  </span>
                                </button>
                              ) : msg.image.status === "loading" ? (
                                <div className="px-2.5 py-1.5 rounded-xl bg-white/[0.06] inline-flex items-center gap-2 text-[11.5px] text-secondary">
                                  <PlayerImageIcon size={14} />
                                  <span>Loading photo…</span>
                                </div>
                              ) : msg.image.status === "disabled" ? (
                                <div className="px-2.5 py-1.5 rounded-xl bg-white/[0.05] inline-flex items-center gap-1.5 text-[11px] text-muted">
                                  <PlayerImageIcon size={13} />
                                  <span>Sent a photo (disabled in your settings)</span>
                                </div>
                              ) : msg.image.status === "expired" ? (
                                <div className="px-2.5 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.07] inline-flex items-center gap-1.5 text-[11px] text-muted">
                                  <PlayerImageIcon size={13} />
                                  <span>Ephemeral photo expired</span>
                                </div>
                              ) : (
                                <div className="px-2.5 py-1.5 rounded-xl bg-bad/15 inline-flex items-center gap-1.5 text-[11px] text-bad">
                                  <PlayerImageIcon size={13} />
                                  <span>Photo unavailable</span>
                                </div>
                              )}
                            </div>
                          )}

                          {msg.text && (
                            <div>
                              {renderMessageContent(msg)}
                              {msg.editedAtMs && (
                                <span className="ml-1.5 text-[10px] text-white/50 select-none">
                                  edited
                                </span>
                              )}
                            </div>
                          )}

                          {!msg.image &&
                            localSprite &&
                            (() => {
                              const tsTok = parseChatTokens(msg.text).find(
                                (t): t is Extract<ReturnType<typeof parseChatTokens>[number], { type: "timestamp" }> =>
                                  t.type === "timestamp",
                              );
                              if (!tsTok) return null;
                              const frameStyle = getThumbnailFrameStyle(localSprite, tsTok.secs);
                              return (
                                <button
                                  type="button"
                                  onClick={() => onSeekToTimestamp(tsTok.secs)}
                                  title={`Jump to ${tsTok.label}`}
                                  className="ep-press mt-1 group/scene relative overflow-hidden rounded-xl border border-white/15 bg-black/40 flex items-center gap-2 pr-2.5 hover:border-white/30 cursor-pointer"
                                >
                                  <span
                                    aria-hidden="true"
                                    className="block shrink-0"
                                    style={{
                                      ...frameStyle,
                                      transform: "scale(0.56)",
                                      transformOrigin: "top left",
                                      marginRight: `${Math.round(localSprite.frameW * 0.56 - localSprite.frameW)}px`,
                                      marginBottom: `${Math.round(localSprite.frameH * 0.56 - localSprite.frameH)}px`,
                                    }}
                                  />
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-white/90 num">
                                    <PlayerPlayIcon size={10} />
                                    <span>{tsTok.label}</span>
                                  </span>
                                </button>
                              );
                            })()}
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

                      {/* Compact "Seen by" avatars under the latest message each peer read */}
                      {seenPeersByMsgId[msg.id]?.length ? (
                        <div
                          className={`mt-1 flex items-center gap-1 px-0.5 ${
                            msg.isSelf ? "justify-end" : "justify-start"
                          }`}
                        >
                          <GlassHoverTip
                            label={
                              hideParticipants
                                ? `Seen by ${seenPeersByMsgId[msg.id].length}`
                                : `Seen by ${seenPeersByMsgId[msg.id].join(", ")}`
                            }
                          >
                            <span className="inline-flex items-center -space-x-1">
                              {seenPeersByMsgId[msg.id].slice(0, 4).map((peerName) => (
                                <ProfileAvatar
                                  key={peerName}
                                  avatarId={resolvePeerAvatarId(peerName, effectiveUsername)}
                                  size={13}
                                  className="ring-1 ring-[#08080d]"
                                />
                              ))}
                              {seenPeersByMsgId[msg.id].length > 4 && (
                                <span className="pl-1.5 text-[9.5px] text-muted num">
                                  +{seenPeersByMsgId[msg.id].length - 4}
                                </span>
                              )}
                            </span>
                          </GlassHoverTip>
                        </div>
                      ) : null}
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
      <div
        className="ep-collapse shrink-0"
        data-open={emojiOpen ? "true" : "false"}
        aria-hidden={!emojiOpen}
        inert={!emojiOpen}
      >
        <div className="ep-collapse-inner">
          <div className="mx-3 mb-2 p-2.5 rounded-2xl bg-white/[0.05] space-y-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-black/25">
              <AppSearchIcon size={12} className="text-muted shrink-0" />
              <input
                id="chat-emoji-search"
                name="chatEmojiSearch"
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
      <AnimatedCollapse
        open={mentionCandidates.length > 0}
        className="shrink-0"
        innerClassName="px-4 pb-1.5 flex items-center gap-1.5 flex-wrap"
      >
        {mentionCandidates.map((name, i) => (
          <button
            key={name}
            type="button"
            onClick={() => applyMention(name)}
            className={`ep-press px-2.5 py-1 rounded-full text-[11.5px] font-medium cursor-pointer transition-colors duration-150 ${
              i === mentionIdx
                ? "bg-accent/45 text-white"
                : "bg-white/[0.06] text-secondary hover:text-white hover:bg-white/[0.10]"
            }`}
          >
            @{name}
          </button>
        ))}
      </AnimatedCollapse>

      {/* Comfortable, Cushioned Single-Surface Composer + Separate Send Button */}
      <div className="ep-chat-composer-zone px-4 pb-5 pt-2 shrink-0">
        <AnimatedCollapse open={Boolean(composerBannerPayload)} innerClassName="pb-1.5">
          {composerBanner.value && (
            <div className="px-2.5 py-1 rounded-xl bg-white/[0.04] flex items-center justify-between gap-2 text-[11px]">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-[2px] h-3 rounded-full bg-accent-soft shrink-0" />
                <span className="text-accent-soft font-medium shrink-0">
                  {composerBanner.value.mode === "edit"
                    ? "Editing"
                    : `Replying to ${
                        composerBanner.value.msg.isSelf
                          ? "yourself"
                          : hideParticipants
                            ? "Friend"
                            : composerBanner.value.msg.sender
                      }`}
                </span>
                <span dir="auto" className="text-secondary/80 truncate">
                  {composerBanner.value.msg.text}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (composerBanner.value?.mode === "edit") {
                    setEditingMsgId(null);
                    setDraft("");
                  } else {
                    setReplyToId(null);
                  }
                }}
                aria-label={composerBanner.value.mode === "edit" ? "Cancel edit" : "Cancel reply"}
                className="ep-press h-5 w-5 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.08] shrink-0 cursor-pointer"
              >
                <AppCloseIcon size={11} />
              </button>
            </div>
          )}
        </AnimatedCollapse>

        <AnimatedCollapse open={Boolean(pendingImage || imageError)} innerClassName="pb-1.5">
          {imageError && (
            <div className="mb-1 px-2.5 py-1 rounded-xl bg-bad/15 text-[11px] text-bad flex items-center justify-between gap-2">
              <span className="truncate">{imageError}</span>
              <button
                type="button"
                onClick={() => setImageError(null)}
                aria-label="Dismiss image error"
                className="text-bad/80 hover:text-white cursor-pointer shrink-0"
              >
                <AppCloseIcon size={11} />
              </button>
            </div>
          )}
          {pendingImage && (
            <div className="px-2.5 py-1.5 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <img
                  src={pendingImage.objectUrl}
                  alt="Pending upload"
                  className={`h-10 w-14 rounded-lg object-cover bg-black/30 shrink-0 ${
                    pendingImage.spoiler ? "blur-sm" : ""
                  }`}
                />
                <div className="min-w-0 text-[11px]">
                  <div className="text-white/90 font-medium truncate">
                    {pendingImage.width}×{pendingImage.height} · {formatBytesCompact(pendingImage.byteLen)}
                  </div>
                  <div className="text-muted text-[10px]">
                    {chatImageRetention === "30m" ? "Auto-deletes in 30m" : "Stays for this session"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    setPendingImage((prev) => (prev ? { ...prev, spoiler: !prev.spoiler } : null))
                  }
                  className={`ep-press px-2 py-1 rounded-full text-[10.5px] font-medium cursor-pointer ${
                    pendingImage.spoiler
                      ? "bg-accent/40 text-white"
                      : "bg-white/[0.06] text-secondary hover:text-white"
                  }`}
                >
                  Spoiler
                </button>
                <button
                  type="button"
                  onClick={() => clearPendingImage(true)}
                  aria-label="Remove staged photo"
                  className="ep-press h-6 w-6 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/[0.08] cursor-pointer"
                >
                  <AppCloseIcon size={11} />
                </button>
              </div>
            </div>
          )}
        </AnimatedCollapse>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void stageImageSource(file);
          }}
        />

        <div className="flex items-end gap-2">
          <div
            data-expanded={composerExpanded || Boolean(replyTarget) || Boolean(editTarget) || Boolean(pendingImage) ? "true" : "false"}
            className="ep-chat-composer-surface flex-1 min-w-0 flex items-end gap-1 p-1.5"
          >
            <button
              type="button"
              disabled={syncStatus.state !== "connected"}
              onClick={() => setEmojiOpen((v) => !v)}
              aria-label="Insert emoji"
              aria-pressed={emojiOpen}
              title="Emoji"
              className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 disabled:opacity-30 disabled:pointer-events-none cursor-pointer ${
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
              placeholder={
                syncStatus.state !== "connected"
                  ? "Connecting…"
                  : pendingImage
                    ? "Add a caption…"
                    : "Message…"
              }
              onChange={(e) => {
                const val = e.target.value;
                setDraft(val);
                notifyPartyChatTyping(val.trim().length > 0);
              }}
              onPaste={handleComposerPaste}
              onBlur={() => notifyPartyChatTyping(false)}
              onKeyDown={handleComposerKeyDown}
              className="flex-1 min-w-0 bg-transparent resize-none text-[13.5px] leading-[1.45] py-1 px-0.5 text-primary placeholder:text-muted/65 focus:outline-none max-h-[112px] ep-menu-scroll select-text disabled:opacity-50"
            />

            <div className="relative flex items-center gap-0.5 shrink-0" ref={attachMenuRef}>
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
                disabled={syncStatus.state !== "connected"}
                onClick={() => setAttachMenuOpen((v) => !v)}
                aria-label="More message actions"
                aria-expanded={attachMenuOpen}
                title="Attach photo, snap frame, or tag time"
                className={`h-8 w-8 rounded-full flex items-center justify-center focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-soft/60 disabled:opacity-30 disabled:pointer-events-none cursor-pointer ${
                  attachMenuOpen || pendingImage
                    ? "text-accent-soft bg-white/[0.09]"
                    : "text-muted hover:text-white hover:bg-white/[0.06]"
                }`}
              >
                <AppPlusIcon
                  size={15}
                  className={`transition-transform duration-200 ${attachMenuOpen ? "rotate-45" : ""}`}
                />
              </button>

              {attachMenuPresence.mounted && (
                <div
                  role="menu"
                  aria-label="Message attachments"
                  className={`ep-glass-submenu absolute right-0 bottom-10 z-30 w-48 rounded-2xl p-1.5 space-y-0.5 ${
                    attachMenuPresence.exiting
                      ? "anim-pop-out pointer-events-none"
                      : "anim-pop-in"
                  }`}
                >
                  {!editingMsgId && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={syncStatus.state !== "connected" || imageBusy}
                      onClick={() => {
                        setAttachMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      className="ep-menu-row ep-press w-full px-2.5 py-2 rounded-xl flex items-center gap-2.5 text-left text-[12px] text-secondary hover:text-white disabled:opacity-40 cursor-pointer"
                    >
                      <PlayerImageIcon size={15} active={Boolean(pendingImage)} />
                      <span>Send Photo…</span>
                    </button>
                  )}
                  {mediaLoaded && !editingMsgId && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={syncStatus.state !== "connected" || imageBusy}
                      onClick={() => {
                        setAttachMenuOpen(false);
                        void handleSnapVideoFrame();
                      }}
                      className="ep-menu-row ep-press w-full px-2.5 py-2 rounded-xl flex items-center gap-2.5 text-left text-[12px] text-secondary hover:text-white disabled:opacity-40 cursor-pointer"
                    >
                      <PlayerCameraSnapIcon size={15} />
                      <span>Snap Current Frame</span>
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!mediaLoaded}
                    onClick={() => {
                      setAttachMenuOpen(false);
                      const pos = usePlayerStore.getState().positionSecs;
                      insertAtCursor(`${formatMediaTimestamp(pos)} `);
                    }}
                    className="ep-menu-row ep-press w-full px-2.5 py-2 rounded-xl flex items-center gap-2.5 text-left text-[12px] text-secondary hover:text-white disabled:opacity-40 cursor-pointer"
                  >
                    <PlayerClockIcon size={15} />
                    <span>Insert Scene Time</span>
                  </button>
                </div>
              )}
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

  const lightboxPortal =
    lightboxImage && typeof document !== "undefined"
      ? createPortal(
          <div
            role="dialog"
            aria-label="Photo preview"
            onClick={() => setLightboxImage(null)}
            className="fixed inset-0 z-[90] bg-black/82 flex flex-col items-center justify-center p-6 gap-3 anim-pop-in"
          >
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              aria-label="Close photo preview"
              className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/[0.12] hover:bg-white/[0.22] flex items-center justify-center text-white cursor-pointer"
            >
              <AppCloseIcon size={16} />
            </button>
            <img
              src={lightboxImage.objectUrl}
              alt={lightboxImage.caption || "Shared photo"}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[82vh] max-w-[88vw] rounded-2xl object-contain shadow-[0_24px_60px_rgba(0,0,0,0.75)]"
            />
            {lightboxImage.caption && (
              <p className="text-xs text-white/85 max-w-lg text-center">{lightboxImage.caption}</p>
            )}
          </div>,
          document.body,
        )
      : null;

  if (!docked) {
    return (
      <>
        {asideEl}
        {lightboxPortal}
      </>
    );
  }

  return (
    <>
      <div
        data-open={dockExpanded ? "true" : "false"}
        data-resizing={resizing ? "true" : undefined}
        style={{ width: dockExpanded ? `${resolvedSidebarWidth}px` : "0px" }}
        onTransitionEnd={(e) => {
          if (!resizing && e.target === e.currentTarget && e.propertyName === "width") {
            onDockTransitionEnd?.();
          }
        }}
        className={`ep-chat-dock-slot ${exiting ? "pointer-events-none" : ""}`}
      >
        {asideEl}
      </div>
      {lightboxPortal}
    </>
  );
});
