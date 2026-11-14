import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createSerialQueue } from "./asyncGuard";
import { isDesktop, safeInvoke } from "./bridge";

export type FileMatchStatus =
  | "matched"
  | "sameLengthDifferentEncode"
  | "durationMismatch"
  | "differentFile"
  | "noFile";

export interface Participant {
  username: string;
  room: string;
  position: number;
  fileName?: string | null;
  fileDuration?: number | null;
  isReady: boolean;
  isController: boolean;
  fileMatch: FileMatchStatus;
}

export type SyncStatusPayload =
  | { state: "disconnected" }
  | { state: "connecting"; endpoint: string; attempt: number }
  | { state: "connected"; endpoint: string; tls: boolean; username: string }
  | {
      state: "reconnecting";
      endpoint: string;
      attempt: number;
      retryInSecs: number;
      suggestBackup: boolean;
    }
  | {
      state: "error";
      endpoint: string;
      message: string;
      suggestBackup: boolean;
      circuitOpen: boolean;
    };

export const enqueueSyncLifecycle = createSerialQueue();

export interface SyncConnectParams {
  endpoint: string;
  username: string;
  roomCode: string;
  literalRoom?: boolean;
  password?: string | null;
}

export async function syncConnect(params: SyncConnectParams): Promise<void> {
  await safeInvoke("sync_connect", {
    endpoint: params.endpoint,
    username: params.username,
    roomCode: params.roomCode,
    literalRoom: params.literalRoom ?? false,
    password: params.password ?? null,
  });
}

export async function syncReconnect(): Promise<void> {
  await safeInvoke("sync_reconnect");
}

export async function syncDisconnect(): Promise<void> {
  await safeInvoke("sync_disconnect");
}

export async function syncSwitchBackup(params: {
  username: string;
  roomCode: string;
  literalRoom?: boolean;
  password?: string | null;
}): Promise<void> {
  await safeInvoke("sync_switch_backup", {
    username: params.username,
    roomCode: params.roomCode,
    literalRoom: params.literalRoom ?? false,
    password: params.password ?? null,
  });
}

export async function syncSetFile(params: {
  name: string;
  path?: string | null;
  sizeBytes?: number | null;
  durationSecs: number;
}): Promise<void> {
  await safeInvoke("sync_set_file", {
    name: params.name,
    path: params.path ?? null,
    sizeBytes: params.sizeBytes ?? null,
    durationSecs: params.durationSecs,
  });
}

export async function syncSetReady(isReady: boolean, manual = true): Promise<void> {
  await safeInvoke("sync_set_ready", { isReady, manual });
}

export async function syncUserPlay(position: number): Promise<void> {
  await safeInvoke("sync_user_play", { position });
}

export async function syncUserPause(position: number): Promise<void> {
  await safeInvoke("sync_user_pause", { position });
}

export async function syncUserSeek(position: number): Promise<void> {
  await safeInvoke("sync_user_seek", { position });
}

function noopUnlisten(): UnlistenFn {
  return () => undefined;
}

export async function onSyncStatus(cb: (status: SyncStatusPayload) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<SyncStatusPayload>("sync://status", (e) => cb(e.payload));
}

export async function onSyncParticipants(cb: (list: Participant[]) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<Participant[]>("sync://participants", (e) => cb(e.payload));
}

export async function onSyncError(cb: (message: string) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ message: string }>("sync://error", (e) => cb(e.payload.message));
}

export async function onSyncServerOverride(cb: (setBy: string) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ setBy: string }>("sync://server-override", (e) => cb(e.payload.setBy));
}
