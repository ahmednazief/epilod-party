import { memo, useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { useChatStore, type ChatPeekItem } from "../store/useChatStore";
import { AppCloseIcon } from "./ui/AppIcons";
import { ProfileAvatar, resolvePeerAvatarId } from "./ui/ProfileAvatar";

interface FloatingChatPeeksProps {
  chromeVisible: boolean;
  popoverOpen: boolean;
  localUsername: string;
  onOpenChat: () => void;
}

interface AnimatedPeekEntry {
  item: ChatPeekItem;
  exiting: boolean;
}

export const FloatingChatPeeks = memo(function FloatingChatPeeks({
  chromeVisible,
  popoverOpen,
  localUsername,
  onOpenChat,
}: FloatingChatPeeksProps) {
  const peeks = useChatStore((s) => s.peeks);
  const chatOpen = useChatStore((s) => s.chatOpen);
  const dismissPeek = useChatStore((s) => s.dismissPeek);
  const pruneExpiredPeeks = useChatStore((s) => s.pruneExpiredPeeks);

  const roomCode = useAppStore((s) => s.roomCode);
  const chatPeeksEnabled = useAppStore((s) => s.chatPeeksEnabled);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const fullWidthPlayBar = useAppStore((s) => s.fullWidthPlayBar);

  const [rendered, setRendered] = useState<AnimatedPeekEntry[]>([]);

  useEffect(() => {
    if (peeks.length === 0) return;
    const timer = window.setInterval(() => {
      pruneExpiredPeeks();
    }, 300);
    return () => window.clearInterval(timer);
  }, [peeks.length, pruneExpiredPeeks]);

  // Keep exiting items mounted briefly for smooth liquid fade/slide out
  useEffect(() => {
    const activeIds = new Set(peeks.map((p) => p.id));
    setRendered((prev) => {
      const next: AnimatedPeekEntry[] = [];
      for (const entry of prev) {
        if (activeIds.has(entry.item.id)) {
          const fresh = peeks.find((p) => p.id === entry.item.id)!;
          next.push({ item: fresh, exiting: false });
        } else if (!entry.exiting) {
          next.push({ item: entry.item, exiting: true });
        } else {
          next.push(entry);
        }
      }
      for (const p of peeks) {
        if (!prev.some((e) => e.item.id === p.id)) {
          next.push({ item: p, exiting: false });
        }
      }
      return next.slice(-4);
    });
  }, [peeks]);

  useEffect(() => {
    const hasExiting = rendered.some((e) => e.exiting);
    if (!hasExiting) return;
    const timer = window.setTimeout(() => {
      setRendered((prev) => prev.filter((e) => !e.exiting));
    }, 210);
    return () => window.clearTimeout(timer);
  }, [rendered]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dispatchLayout = () => window.dispatchEvent(new CustomEvent("ep:glass-layout"));
    dispatchLayout();
    const settled = window.setTimeout(dispatchLayout, 280);
    return () => window.clearTimeout(settled);
  }, [rendered.length, chromeVisible, fullWidthPlayBar, chatOpen, popoverOpen]);

  const hidden = !roomCode || chatOpen || popoverOpen;
  if (hidden || rendered.length === 0) {
    return null;
  }

  const visibleEntries = rendered.filter((e) => chatPeeksEnabled || e.item.isMention);
  if (visibleEntries.length === 0) {
    return null;
  }

  return (
    <div
      style={
        chromeVisible
          ? { bottom: "var(--ep-playbar-clearance, 126px)" }
          : undefined
      }
      className={`pointer-events-none absolute left-4 sm:left-6 z-[38] flex flex-col items-start gap-2 max-w-[320px] transition-[bottom] duration-300 ${
        chromeVisible ? "" : "bottom-5"
      }`}
      aria-live="polite"
    >
      {visibleEntries.map(({ item, exiting }) => {
        const avatarId = resolvePeerAvatarId(
          item.sender,
          localUsername,
          item.avatarId || undefined,
        );

        return (
          <div
            key={item.id}
            data-glass-region="true"
            className={`group relative pointer-events-auto ep-glass-peek-bubble rounded-[20px] rounded-bl-[7px] max-w-full ${
              exiting ? "ep-peek-bubble-out pointer-events-none" : "ep-peek-bubble-in"
            } ${item.isMention ? "ring-1 ring-accent-soft/45" : ""}`}
          >
            <button
              type="button"
              onClick={() => {
                dismissPeek(item.id);
                onOpenChat();
              }}
              title="Open Party Chat"
              className="w-full text-left pl-2.5 pr-7 py-2 flex items-start gap-2.5 cursor-pointer"
            >
              {!hideParticipants && (
                <ProfileAvatar
                  avatarId={avatarId}
                  size={24}
                  className="ring-1 ring-white/25 shrink-0 mt-0.5"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-white/95 truncate leading-tight">
                    {hideParticipants ? "Friend" : item.sender}
                  </span>
                  {item.isMention && (
                    <span className="text-[9.5px] font-medium px-1.5 py-0.2 rounded-full bg-accent/65 text-white leading-tight">
                      @you
                    </span>
                  )}
                </div>
                <div
                  dir="auto"
                  className="text-[12.5px] text-white/90 leading-[1.38] line-clamp-2 break-words mt-0.5"
                >
                  {item.text}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                dismissPeek(item.id);
              }}
              aria-label="Dismiss message peek"
              className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full flex items-center justify-center text-white/55 hover:text-white hover:bg-white/[0.12] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
            >
              <AppCloseIcon size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
});
