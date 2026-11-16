import type {
  ControlNoticePayload,
  Participant,
  RoomControlState,
  SyncStatusPayload,
} from "./syncplay";

export interface ControllerLockState {
  hasControllers: boolean;
  localIsController: boolean;
  lockedForLocalUser: boolean;
  controllers: string[];
  hostControlActive: boolean;
  localIsHost: boolean;
  localIsAdmin: boolean;
  hostUsername: string | null;
  adminUsernames: string[];
}

export const EMPTY_ROOM_CONTROL: RoomControlState = {
  hostControlActive: false,
  localIsHost: false,
  localIsAdmin: false,
  hostUsername: null,
  adminUsernames: [],
};

export function resolveEffectiveUsername(
  syncStatus: SyncStatusPayload,
  configuredUsername: string,
): string {
  if (syncStatus.state === "connected" && syncStatus.username.trim()) {
    return syncStatus.username;
  }
  return configuredUsername;
}

function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a?.trim().toLowerCase() ?? "";
  const right = b?.trim().toLowerCase() ?? "";
  return Boolean(left && right && left === right);
}

/**
 * Resolves room controller lock status across both Syncplay server controller flags
 * and Epilod's host-only + admin room authority.
 */
export function getControllerLockState(
  syncConnected: boolean,
  participants: readonly Participant[],
  localUsername: string,
  roomControl?: RoomControlState | null,
): ControllerLockState {
  if (!syncConnected) {
    return {
      hasControllers: false,
      localIsController: false,
      lockedForLocalUser: false,
      controllers: [],
      hostControlActive: Boolean(roomControl?.hostControlActive),
      localIsHost: Boolean(roomControl?.localIsHost),
      localIsAdmin: Boolean(roomControl?.localIsAdmin),
      hostUsername: roomControl?.hostUsername ?? null,
      adminUsernames: roomControl?.adminUsernames ? [...roomControl.adminUsernames] : [],
    };
  }

  const normalizedLocal = localUsername.trim().toLowerCase();
  const hostActive = Boolean(roomControl?.hostControlActive);

  if (hostActive && roomControl) {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const pushUnique = (name: string | null | undefined) => {
      const clean = name?.trim();
      if (!clean) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      ordered.push(clean);
    };

    pushUnique(roomControl.hostUsername);
    for (const admin of roomControl.adminUsernames) {
      pushUnique(admin);
    }
    for (const p of participants) {
      if (p.isController) pushUnique(p.username);
    }

    const localIsHost =
      roomControl.localIsHost ||
      (Boolean(roomControl.hostUsername) && sameUser(roomControl.hostUsername, localUsername));
    const localIsAdmin =
      !localIsHost &&
      (roomControl.localIsAdmin ||
        roomControl.adminUsernames.some((a) => a.trim().toLowerCase() === normalizedLocal));
    const localIsController =
      localIsHost ||
      localIsAdmin ||
      participants.some(
        (p) => p.isController && p.username.trim().toLowerCase() === normalizedLocal,
      );

    return {
      hasControllers: ordered.length > 0 || hostActive,
      localIsController,
      lockedForLocalUser: !localIsController,
      controllers: ordered,
      hostControlActive: true,
      localIsHost,
      localIsAdmin,
      hostUsername: roomControl.hostUsername,
      adminUsernames: [...roomControl.adminUsernames],
    };
  }

  if (participants.length === 0) {
    return {
      hasControllers: false,
      localIsController: false,
      lockedForLocalUser: false,
      controllers: [],
      hostControlActive: false,
      localIsHost: false,
      localIsAdmin: false,
      hostUsername: null,
      adminUsernames: [],
    };
  }

  const controllers = participants
    .filter((p) => p.isController)
    .map((p) => p.username);

  if (controllers.length === 0) {
    return {
      hasControllers: false,
      localIsController: false,
      lockedForLocalUser: false,
      controllers: [],
      hostControlActive: false,
      localIsHost: false,
      localIsAdmin: false,
      hostUsername: null,
      adminUsernames: [],
    };
  }

  const localIsController = controllers.some(
    (name) => name.trim().toLowerCase() === normalizedLocal,
  );
  const hostEntry = participants.find((p) => p.isHost) ?? participants.find((p) => p.isController);

  return {
    hasControllers: true,
    localIsController,
    lockedForLocalUser: !localIsController,
    controllers,
    hostControlActive: false,
    localIsHost: Boolean(hostEntry && sameUser(hostEntry.username, localUsername)),
    localIsAdmin: participants.some(
      (p) => Boolean(p.isAdmin) && p.username.trim().toLowerCase() === normalizedLocal,
    ),
    hostUsername: hostEntry?.username ?? null,
    adminUsernames: participants.filter((p) => Boolean(p.isAdmin)).map((p) => p.username),
  };
}

export function formatControllerLockReason(lock: ControllerLockState): string {
  const host = lock.hostUsername?.trim();
  return host
    ? `Only ${host} (and admins) can control playback.`
    : "Playback is restricted to the room host.";
}

export function formatControlNoticeMessage(
  notice: ControlNoticePayload,
): { level: "info" | "warn" | "success"; text: string; feedback?: string } | null {
  const actor = notice.actor?.trim() || "The host";
  switch (notice.kind) {
    case "hostEnabled":
      return {
        level: "info",
        text: `Host-only playback control enabled by ${actor}.`,
      };
    case "hostReleased":
      return {
        level: "info",
        text: `${actor} opened playback control to everyone.`,
        feedback: "Controls unlocked",
      };
    case "adminGranted":
      return {
        level: "success",
        text: `${actor} gave you admin control — you can play, pause, and seek.`,
        feedback: "Admin control granted",
      };
    case "adminRevoked":
      return {
        level: "warn",
        text: `${actor} removed your admin control.`,
        feedback: "Admin removed",
      };
    case "hostAbsentUnlocked":
      return {
        level: "info",
        text: "Room host left — playback controls unlocked.",
        feedback: "Controls unlocked",
      };
    case "guestBlocked":
      return {
        level: "warn",
        text: `Blocked playback change from ${actor} (host-only room).`,
      };
  }
}

export function formatControllerOverrideNotice(setBy: string): string {
  const actor = setBy.trim();
  return actor
    ? `Room controller (${actor}) updated playback position.`
    : "Playback updated by room controller.";
}
