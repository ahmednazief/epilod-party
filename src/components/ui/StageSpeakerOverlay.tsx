import { memo, useEffect, useRef, useState } from "react";
import { AppHeadphonesIcon, AppMicIcon, AppVoiceWaveIcon } from "./AppIcons";
import { PresenceAvatar } from "./PresenceAvatar";
import { resolvePeerAvatarId, type AvatarId } from "./ProfileAvatar";

interface StageSpeakerOverlayProps {
  enabled: boolean;
  speakers: readonly string[];
  localUsername: string;
  localAvatarId: AvatarId;
  peerAvatars?: Record<string, AvatarId>;
  localSpeaking?: boolean;
  localMuted?: boolean;
  localDeafened?: boolean;
  localCaptureHealthy?: boolean;
}

interface AnimatedSpeaker {
  name: string;
  key: string;
  exiting: boolean;
}

const HOLD_MS = 0;
const EXIT_MS = 120;

/**
 * Passive top-left speaker pills shown when panels are hidden (fullscreen or idle chrome),
 * using a short trailing hold and spring pop-out so brief pauses between words do not flicker.
 */
export const StageSpeakerOverlay = memo(function StageSpeakerOverlay({
  enabled,
  speakers,
  localUsername,
  localAvatarId,
  peerAvatars,
  localSpeaking = false,
  localMuted = false,
  localDeafened = false,
  localCaptureHealthy = true,
}: StageSpeakerOverlayProps) {
  const [rendered, setRendered] = useState<AnimatedSpeaker[]>([]);
  const holdTimersRef = useRef<Record<string, number>>({});
  const exitTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    return () => {
      for (const id of Object.values(holdTimersRef.current)) window.clearTimeout(id);
      for (const id of Object.values(exitTimersRef.current)) window.clearTimeout(id);
      holdTimersRef.current = {};
      exitTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    const activeList = enabled ? speakers.slice(0, 4) : [];
    const activeKeys = new Set(activeList.map((n) => n.trim().toLowerCase()));

    // Cancel pending hold/exit timers for anyone who resumed speaking
    for (const key of activeKeys) {
      if (holdTimersRef.current[key] !== undefined) {
        window.clearTimeout(holdTimersRef.current[key]);
        delete holdTimersRef.current[key];
      }
      if (exitTimersRef.current[key] !== undefined) {
        window.clearTimeout(exitTimersRef.current[key]);
        delete exitTimersRef.current[key];
      }
    }

    setRendered((prev) => {
      const next: AnimatedSpeaker[] = [];
      for (const entry of prev) {
        if (activeKeys.has(entry.key)) {
          next.push({ ...entry, exiting: false });
        } else {
          next.push(entry);
        }
      }
      for (const name of activeList) {
        const key = name.trim().toLowerCase();
        if (key && !next.some((e) => e.key === key)) {
          next.push({ name, key, exiting: false });
        }
      }
      return next.slice(0, 4);
    });

    // Schedule trailing hold -> exit -> remove for speakers no longer active
    setRendered((current) => {
      for (const entry of current) {
        if (!activeKeys.has(entry.key) && !entry.exiting && holdTimersRef.current[entry.key] === undefined) {
          const delay = enabled ? HOLD_MS : 0;
          holdTimersRef.current[entry.key] = window.setTimeout(() => {
            delete holdTimersRef.current[entry.key];
            setRendered((list) =>
              list.map((item) =>
                item.key === entry.key ? { ...item, exiting: true } : item,
              ),
            );
            exitTimersRef.current[entry.key] = window.setTimeout(() => {
              delete exitTimersRef.current[entry.key];
              setRendered((list) => list.filter((item) => item.key !== entry.key));
            }, EXIT_MS);
          }, delay);
        }
      }
      return current;
    });
  }, [enabled, speakers]);

  const showSelfChip =
    enabled && (!localCaptureHealthy || localDeafened || localMuted || localSpeaking);

  if (rendered.length === 0 && !showSelfChip) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute top-4 left-4 z-[38] flex flex-wrap items-center gap-1.5"
    >
      {showSelfChip && (
        <div
          className={`ep-bar-pill pl-1 pr-2.5 py-1 rounded-full inline-flex items-center gap-1.5 text-xs font-medium anim-pop-in ${
            !localCaptureHealthy
              ? "text-warn"
              : localDeafened || localMuted
                ? "text-bad/95 opacity-85"
                : "text-white"
          }`}
        >
          <PresenceAvatar
            avatarId={localAvatarId}
            size={18}
            speaking={localSpeaking && !localMuted && !localDeafened && localCaptureHealthy}
            status={
              !localCaptureHealthy
                ? "alert"
                : localDeafened || localMuted
                  ? "muted"
                  : "none"
            }
          />
          {localDeafened ? (
            <AppHeadphonesIcon deafened size={12} className="shrink-0 text-bad" />
          ) : (
            <AppMicIcon
              muted={localMuted}
              speaking={localSpeaking && !localMuted}
              size={12}
              className={`shrink-0 ${
                !localCaptureHealthy
                  ? "text-warn"
                  : localMuted
                    ? "text-bad"
                    : "text-white/90"
              }`}
            />
          )}
          <span className="truncate max-w-[100px]">
            {!localCaptureHealthy
              ? "Mic Alert"
              : localDeafened
                ? "Deafened"
                : localMuted
                  ? "Muted"
                  : "You"}
          </span>
        </div>
      )}
      {rendered.map((speaker) => (
        <div
          key={speaker.key}
          className={`${
            speaker.exiting ? "anim-pop-out" : "anim-pop-in"
          } ep-bar-pill pl-1 pr-2.5 py-1 rounded-full inline-flex items-center gap-2 text-xs font-medium text-white`}
        >
          <PresenceAvatar
            avatarId={resolvePeerAvatarId(speaker.name, localUsername, localAvatarId, peerAvatars)}
            size={18}
            speaking={!speaker.exiting}
          />
          <AppVoiceWaveIcon active speaking={!speaker.exiting} size={12} className="shrink-0" />
          <span className="truncate max-w-[120px]">{speaker.name}</span>
        </div>
      ))}
    </div>
  );
});
