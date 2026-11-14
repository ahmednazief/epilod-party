import type { Participant, SyncStatusPayload } from "./syncplay";

export interface ControllerLockState {
  hasControllers: boolean;
  localIsController: boolean;
  lockedForLocalUser: boolean;
  controllers: string[];
}

export function resolveEffectiveUsername(
  syncStatus: SyncStatusPayload,
  configuredUsername: string,
): string {
  if (syncStatus.state === "connected" && syncStatus.username.trim()) {
    return syncStatus.username;
  }
  return configuredUsername;
}

/**
 * Fix 10: Detects managed Syncplay rooms (`controller` roles) and whether local
 * transport actions are restricted to room controllers.
 */
export function getControllerLockState(
  syncConnected: boolean,
  participants: readonly Participant[],
  localUsername: string,
): ControllerLockState {
  if (!syncConnected || participants.length === 0) {
    return {
      hasControllers: false,
      localIsController: false,
      lockedForLocalUser: false,
      controllers: [],
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
    };
  }

  const normalizedLocal = localUsername.trim().toLowerCase();
  const localIsController = controllers.some(
    (name) => name.trim().toLowerCase() === normalizedLocal,
  );

  return {
    hasControllers: true,
    localIsController,
    lockedForLocalUser: !localIsController,
    controllers,
  };
}

export function formatControllerOverrideNotice(setBy: string): string {
  const actor = setBy.trim();
  return actor
    ? `Room controller (${actor}) updated playback position.`
    : "Playback updated by room controller.";
}
