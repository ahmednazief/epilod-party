import { memo, type CSSProperties } from "react";
import { ProfileAvatar, type AvatarId } from "./ProfileAvatar";

/**
 * Corner badge states. Anything "all good" (ready, connected) intentionally renders nothing:
 * only things that need attention earn a badge.
 */
export type PresenceStatus = "none" | "notReady" | "mismatch" | "muted" | "alert";

interface PresenceAvatarProps {
  avatarId: AvatarId;
  size?: number;
  /** Person is audibly talking right now. Draws the single calm green speaking ring. */
  speaking?: boolean;
  status?: PresenceStatus;
  title?: string;
  /** Applied to the outer wrapper (spacing, margins). */
  className?: string;
  /** Applied to the avatar itself (e.g. keyline rings between overlapped avatars). */
  avatarClassName?: string;
}

/**
 * One avatar, one job per channel:
 *  - Ring  = voice activity only (green, compositor-only fade, no glow, no pulse).
 *  - Badge = a problem only (not ready / wrong file / muted / mic alert).
 * Keeping the two on separate channels means "ready" never competes with "speaking".
 */
export const PresenceAvatar = memo(function PresenceAvatar({
  avatarId,
  size = 24,
  speaking = false,
  status = "none",
  title,
  className = "",
  avatarClassName = "",
}: PresenceAvatarProps) {
  const small = size <= 18;
  const style = {
    width: size,
    height: size,
    "--ep-ring-w": `${small ? 1.5 : 2}px`,
    "--ep-ring-gap": `${small ? 1 : 1.5}px`,
    "--ep-badge": `${Math.max(6, Math.round(size * 0.32))}px`,
  } as CSSProperties;

  return (
    <span
      className={`ep-presence-avatar ${className}`}
      data-speaking={speaking ? "true" : "false"}
      data-flagged={status !== "none" ? "true" : "false"}
      style={style}
    >
      <ProfileAvatar avatarId={avatarId} size={size} title={title} className={avatarClassName} />
      <span aria-hidden="true" className="ep-presence-ring" />
      {status !== "none" && (
        <span aria-hidden="true" className="ep-presence-badge" data-status={status} />
      )}
    </span>
  );
});
