import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createSerialQueue } from "./asyncGuard";
import { isDesktop, safeInvoke } from "./bridge";
import type { SubtitleEncodingHint } from "./mpv";
import type { TimelineSegment, TimelineTransform } from "./sourceAlignment";

export type FileMatchStatus =
  | "matched"
  | "sameLengthDifferentEncode"
  | "durationMismatch"
  | "differentFile"
  | "noFile";

export type SourceRelation =
  | "exact"
  | "differentEncode"
  | "differentCut"
  | "fpsMismatch"
  | "differentMedia"
  | "missing";

export interface Participant {
  username: string;
  room: string;
  position: number;
  fileName?: string | null;
  fileDuration?: number | null;
  isReady: boolean;
  isController: boolean;
  isHost?: boolean;
  isAdmin?: boolean;
  fileMatch: FileMatchStatus;
  sourceRelation?: SourceRelation;
  durationDeltaSecs?: number | null;
  suggestedFpsScale?: number | null;
  suggestedFpsLabel?: string | null;
  buffering?: boolean;
  lagSecs?: number | null;
}

export interface SyncHealthPayload {
  rttMs: number | null;
  jitterMs: number;
  offsetMs: number;
  driftSecs: number;
  seekLeadMs: number;
  endpoint: string;
  seq: number;
  reconnects: number;
}

export interface RoomControlState {
  hostControlActive: boolean;
  localIsHost: boolean;
  localIsAdmin: boolean;
  hostUsername: string | null;
  adminUsernames: string[];
}

export type ControlNoticeKind =
  | "hostEnabled"
  | "hostReleased"
  | "adminGranted"
  | "adminRevoked"
  | "hostAbsentUnlocked"
  | "hostReconnected"
  | "guestBlocked";

export interface ControlNoticePayload {
  kind: ControlNoticeKind;
  actor?: string | null;
}

export interface RoomStatePayload {
  position: number;
  paused: boolean;
}

export type P2pTransportKind = "punching" | "directLan" | "directWan" | "fallbackSyncplay";

export interface P2pPeerStatus {
  username: string;
  transport: P2pTransportKind;
  rttMs?: number | null;
  autoAlignState: string;
  summary?: string | null;
}

export interface P2pStatusPayload {
  natMode: string;
  peers: P2pPeerStatus[];
}

export interface AutoAlignedPayload {
  offsetSecs: number;
  scale: number;
  segmentCount: number;
  confidence: number;
  summary: string;
}

export interface ReactionEventPayload {
  username: string;
  avatarId: string;
  emoji: string;
  count: number;
  via: "p2p" | "p2pRelay" | "syncplay";
}

export interface ChatMessageEventPayload {
  id: string;
  username: string;
  avatarId: string;
  text: string;
  replyToId?: string | null;
  via: "p2p" | "p2pRelay" | "syncplay";
}

export interface ChatEditEventPayload {
  targetMsgId: string;
  username: string;
  text: string;
  via: "p2p" | "p2pRelay" | "syncplay";
}

export interface ChatReactEventPayload {
  targetMsgId: string;
  username: string;
  emoji: string;
  via: "p2p" | "p2pRelay" | "syncplay";
}

export interface ChatTypingEventPayload {
  username: string;
  isTyping: boolean;
}

export interface PeerSeekPayload {
  username: string;
  deltaSecs: number;
  positionSecs: number;
}

export interface SharedSubtitleEventPayload {
  id: string;
  sender: string;
  fileName: string;
  ext: "srt" | "vtt" | "ass" | "ssa" | string;
  lang?: string | null;
  content: string;
  sizeBytes: number;
}

export interface ShareSubtitleResultDto {
  id: string;
  fileName: string;
  sizeBytes: number;
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
  hostOnly?: boolean;
  claimEmpty?: boolean;
}

export async function syncConnect(params: SyncConnectParams): Promise<void> {
  await safeInvoke("sync_connect", {
    endpoint: params.endpoint,
    username: params.username,
    roomCode: params.roomCode,
    literalRoom: params.literalRoom ?? false,
    password: params.password ?? null,
    hostOnly: params.hostOnly ?? false,
    claimEmpty: params.claimEmpty ?? false,
  });
}

export async function syncPrewarm(endpoint: string, roomCode?: string): Promise<void> {
  try {
    await safeInvoke("sync_prewarm", { endpoint, roomCode: roomCode ?? null });
  } catch {
    // Best-effort DNS/TLS/DO warm-up; ignore failures.
  }
}

export async function syncReconnect(): Promise<void> {
  await safeInvoke("sync_reconnect");
}

export async function syncForceResync(): Promise<void> {
  await safeInvoke("sync_force_resync");
}

export async function syncSetRoomAdmin(username: string, grant: boolean): Promise<void> {
  await safeInvoke("sync_set_room_admin", { username, grant });
}

export async function syncDisconnect(): Promise<void> {
  await safeInvoke("sync_disconnect");
}

export async function syncSwitchBackup(params: {
  username: string;
  roomCode: string;
  literalRoom?: boolean;
  password?: string | null;
  hostOnly?: boolean;
  targetEndpoint?: string | null;
}): Promise<void> {
  await safeInvoke("sync_switch_backup", {
    username: params.username,
    roomCode: params.roomCode,
    literalRoom: params.literalRoom ?? false,
    password: params.password ?? null,
    hostOnly: params.hostOnly ?? false,
    targetEndpoint: params.targetEndpoint ?? null,
  });
}

export async function syncSetFile(params: {
  name: string;
  path?: string | null;
  sizeBytes?: number | null;
  durationSecs: number;
  hashIdentity?: boolean;
}): Promise<void> {
  await safeInvoke("sync_set_file", {
    name: params.name,
    path: params.path ?? null,
    sizeBytes: params.sizeBytes ?? null,
    durationSecs: params.durationSecs,
    hashIdentity: params.hashIdentity ?? false,
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

export async function syncSetScrubbing(scrubbing: boolean): Promise<void> {
  await safeInvoke("sync_set_scrubbing", { scrubbing });
}

export async function syncSetTimelineTransform(transform: TimelineTransform): Promise<void> {
  await safeInvoke("sync_set_timeline_transform", {
    offsetSecs: transform.offsetSecs,
    scale: transform.scale,
  });
}

export async function syncNudgeTimelineOffset(deltaSecs: number): Promise<void> {
  await safeInvoke("sync_nudge_timeline_offset", { deltaSecs });
}

export async function syncSetAlignMode(enabled: boolean): Promise<void> {
  await safeInvoke("sync_set_align_mode", { enabled });
}

export async function syncAlignSceneHere(
  localPosSecs?: number | null,
): Promise<TimelineTransform> {
  return safeInvoke<TimelineTransform>("sync_align_scene_here", {
    localPosSecs: localPosSecs ?? null,
  });
}

export async function syncRunP2pAutoAlign(force = true): Promise<void> {
  await safeInvoke("sync_run_p2p_auto_align", { force });
}

export async function syncSendReaction(
  emoji: string,
  avatarId: string,
  count = 1,
): Promise<void> {
  await safeInvoke("sync_send_reaction", { emoji, avatarId, count });
}

export async function syncSendChat(
  id: string,
  text: string,
  avatarId: string,
  replyToId?: string | null,
): Promise<void> {
  await safeInvoke("sync_send_chat", {
    id,
    text,
    avatarId,
    replyToId: replyToId ?? null,
  });
}

export async function syncSendChatTyping(isTyping: boolean): Promise<void> {
  await safeInvoke("sync_send_chat_typing", { isTyping });
}

export async function syncSendChatEdit(targetMsgId: string, text: string): Promise<void> {
  await safeInvoke("sync_send_chat_edit", { targetMsgId, text });
}

export async function syncSendChatReact(targetMsgId: string, emoji: string): Promise<void> {
  await safeInvoke("sync_send_chat_react", { targetMsgId, emoji });
}

export async function syncShareSubtitle(params: {
  path: string;
  encodingHint?: SubtitleEncodingHint;
  displayName?: string | null;
  lang?: string | null;
}): Promise<ShareSubtitleResultDto> {
  return safeInvoke<ShareSubtitleResultDto>("sync_share_subtitle", {
    path: params.path,
    encodingHint: params.encodingHint ?? "auto",
    displayName: params.displayName ?? null,
    lang: params.lang ?? null,
  });
}

export async function applySharedSubtitle(params: {
  id: string;
  fileName: string;
  ext: string;
  content: string;
  fixRtl?: boolean;
}): Promise<string> {
  return safeInvoke<string>("apply_shared_subtitle", {
    id: params.id,
    fileName: params.fileName,
    ext: params.ext,
    content: params.content,
    fixRtl: params.fixRtl ?? true,
  });
}

function noopUnlisten(): UnlistenFn {
  return () => undefined;
}

export async function onSyncStatus(cb: (status: SyncStatusPayload) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<SyncStatusPayload>("sync://status", (e) => cb(e.payload));
}

export async function onSyncRoomRerolled(
  cb: (payload: { roomCode: string }) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ roomCode: string }>("sync://room-rerolled", (e) => cb(e.payload));
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

export async function onSyncPeerNotReady(
  cb: (payload: { username: string; manual: boolean }) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ username: string; manual: boolean }>("sync://peer-not-ready", (e) =>
    cb(e.payload),
  );
}

export async function onSyncPeerLeft(
  cb: (payload: { username: string }) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ username: string }>("sync://peer-left", (e) => cb(e.payload));
}

export async function onSyncTimelineTransform(
  cb: (transform: TimelineTransform) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<TimelineTransform>("sync://timeline-transform", (e) => cb(e.payload));
}

export async function onSyncRoomState(
  cb: (state: RoomStatePayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<RoomStatePayload>("sync://room-state", (e) => cb(e.payload));
}

export async function onSyncTimelineSegments(
  cb: (segments: TimelineSegment[]) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<TimelineSegment[]>("sync://timeline-segments", (e) => cb(e.payload));
}

export async function onSyncP2pStatus(
  cb: (status: P2pStatusPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<P2pStatusPayload>("sync://p2p-status", (e) => cb(e.payload));
}

export async function onSyncAutoAligned(
  cb: (payload: AutoAlignedPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<AutoAlignedPayload>("sync://auto-aligned", (e) => cb(e.payload));
}

export async function onSyncPlayBlocked(
  cb: (payload: { usernames: string[] }) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ usernames: string[] }>("sync://play-blocked", (e) => cb(e.payload));
}

export async function onSyncRoomControl(
  cb: (control: RoomControlState) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<RoomControlState>("sync://room-control", (e) => cb(e.payload));
}

export async function onSyncControlNotice(
  cb: (notice: ControlNoticePayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<ControlNoticePayload>("sync://control-notice", (e) => cb(e.payload));
}

export async function onSyncReaction(
  cb: (reaction: ReactionEventPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<ReactionEventPayload>("sync://reaction", (e) => cb(e.payload));
}

export async function onSyncChat(
  cb: (message: ChatMessageEventPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<ChatMessageEventPayload>("sync://chat", (e) => cb(e.payload));
}

export async function onSyncChatTyping(
  cb: (typing: ChatTypingEventPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<ChatTypingEventPayload>("sync://chat-typing", (e) => cb(e.payload));
}

export async function onSyncChatEdit(
  cb: (edit: ChatEditEventPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<ChatEditEventPayload>("sync://chat-edit", (e) => cb(e.payload));
}

export async function onSyncChatReact(
  cb: (react: ChatReactEventPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<ChatReactEventPayload>("sync://chat-react", (e) => cb(e.payload));
}

export async function onSyncPeerSeek(
  cb: (payload: PeerSeekPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<PeerSeekPayload>("sync://peer-seek", (e) => cb(e.payload));
}

export async function onSyncHealth(
  cb: (payload: SyncHealthPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<SyncHealthPayload>("sync://health", (e) => cb(e.payload));
}

export async function onSyncSubtitleShared(
  cb: (payload: SharedSubtitleEventPayload) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<SharedSubtitleEventPayload>("sync://subtitle-shared", (e) => cb(e.payload));
}
