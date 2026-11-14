import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop, safeInvoke } from "./bridge";

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MpvTrack {
  id: number;
  type: "audio" | "sub" | "video" | string;
  title?: string | null;
  lang?: string | null;
  codec?: string | null;
  external?: boolean;
  "ff-index"?: number;
  "demux-index"?: number;
  selected?: boolean;
}

export type AspectMode = "auto" | "16:9" | "4:3" | "21:9" | "fill";
export type SubtitleEncodingHint = "auto" | "utf8" | "windows1256" | "windows1252" | "windows1251";

export interface AutoSyncResult {
  offsetSecs: number;
  scale: number;
  confidenceZ: number;
  correlation: number;
  driftApplied: boolean;
  syncedSubtitlePath: string;
  sourceSubtitlePath: string;
  audioDurationSecs: number;
  elapsedMs: number;
}

export async function mpvStart(rect: PhysicalRect): Promise<void> {
  await safeInvoke("mpv_start", { ...rect });
}

export async function mpvResize(rect: PhysicalRect, force = false): Promise<void> {
  await safeInvoke("mpv_resize", { ...rect, force });
}

export async function mpvSetVisible(visible: boolean): Promise<void> {
  await safeInvoke("mpv_set_visible", { visible });
}

export async function mpvLoad(path: string): Promise<void> {
  await safeInvoke("mpv_load", { path });
}

export async function mpvSetPause(paused: boolean): Promise<void> {
  await safeInvoke("mpv_set_pause", { paused });
}

export async function mpvSeek(seconds: number): Promise<void> {
  await safeInvoke("mpv_seek", { seconds });
}

export async function mpvStop(): Promise<void> {
  await safeInvoke("mpv_stop");
}

export async function mpvSetVolume(volume: number): Promise<void> {
  await safeInvoke("mpv_set_volume", { volume });
}

export async function mpvSetMute(muted: boolean): Promise<void> {
  await safeInvoke("mpv_set_mute", { muted });
}

export async function mpvSetSpeed(speed: number): Promise<void> {
  await safeInvoke("mpv_set_speed", { speed });
}

export async function mpvSetLoop(looping: boolean): Promise<void> {
  await safeInvoke("mpv_set_loop", { looping });
}

export async function mpvSetAspectMode(aspect: AspectMode): Promise<void> {
  await safeInvoke("mpv_set_aspect_mode", { aspect });
}

export async function mpvAddSubtitle(
  path: string,
  encodingHint: SubtitleEncodingHint = "auto",
): Promise<void> {
  await safeInvoke("mpv_add_subtitle", { path, encodingHint });
}

export interface SubStyleParams {
  font: string;
  fontSize: number;
  color: string;
  borderSize: number;
  pos: number;
  visible: boolean;
  overrideAss: boolean;
}

export async function mpvSetSubStyle(params: SubStyleParams): Promise<void> {
  await safeInvoke("mpv_set_sub_style", { ...params });
}

export async function mpvSetSubDelay(delaySecs: number): Promise<void> {
  await safeInvoke("mpv_set_sub_delay", { delaySecs });
}

export async function mpvSetAudioTrack(aid: number | null): Promise<void> {
  await safeInvoke("mpv_set_audio_track", { aid });
}

export async function mpvSetSubTrack(sid: number | null): Promise<void> {
  await safeInvoke("mpv_set_sub_track", { sid });
}

export interface SubtitleAutoSyncParams {
  videoPath: string;
  subtitlePath?: string | null;
  audioTrackId?: number | null;
  embeddedSubIdx?: number | null;
  embeddedSubCodec?: string | null;
  encodingHint?: SubtitleEncodingHint;
  lowPower?: boolean;
}

export async function subtitleAutoSync(params: SubtitleAutoSyncParams): Promise<AutoSyncResult> {
  return safeInvoke<AutoSyncResult>("subtitle_auto_sync", {
    videoPath: params.videoPath,
    subtitlePath: params.subtitlePath ?? null,
    audioTrackId: params.audioTrackId ?? null,
    embeddedSubIdx: params.embeddedSubIdx ?? null,
    embeddedSubCodec: params.embeddedSubCodec ?? null,
    encodingHint: params.encodingHint ?? "auto",
    lowPower: params.lowPower ?? false,
  });
}

export interface SubtitleTwoAnchorParams {
  subtitlePath: string;
  srcASecs: number;
  dstASecs: number;
  srcBSecs: number;
  dstBSecs: number;
  encodingHint?: SubtitleEncodingHint;
}

export async function subtitleTwoAnchorSync(
  params: SubtitleTwoAnchorParams,
): Promise<AutoSyncResult> {
  return safeInvoke<AutoSyncResult>("subtitle_two_anchor_sync", {
    subtitlePath: params.subtitlePath,
    srcASecs: params.srcASecs,
    dstASecs: params.dstASecs,
    srcBSecs: params.srcBSecs,
    dstBSecs: params.dstBSecs,
    encodingHint: params.encodingHint ?? "auto",
  });
}

export async function subtitleCancelAutoSync(): Promise<void> {
  await safeInvoke("subtitle_cancel_auto_sync");
}

export async function windowSetFullscreen(fullscreen: boolean): Promise<void> {
  await safeInvoke("window_set_fullscreen", { fullscreen });
}

export async function windowIsFullscreen(): Promise<boolean> {
  if (!isDesktop()) {
    return false;
  }
  return safeInvoke<boolean>("window_is_fullscreen");
}

export async function setAllowNetworkShares(allow: boolean): Promise<void> {
  if (!isDesktop()) {
    return;
  }
  await safeInvoke("set_allow_network_shares", { allow });
}

function noopUnlisten(): UnlistenFn {
  return () => undefined;
}

export async function onMpvTime(cb: (position: number) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ position: number }>("mpv://time", (e) => cb(e.payload.position));
}

export async function onMpvDuration(cb: (duration: number) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ duration: number }>("mpv://duration", (e) => cb(e.payload.duration));
}

export async function onMpvPaused(cb: (paused: boolean) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ paused: boolean }>("mpv://paused", (e) => cb(e.payload.paused));
}

export async function onMpvFileLoaded(cb: () => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen("mpv://file-loaded", () => cb());
}

export async function onMpvEnded(
  cb: (payload: { reason: string; error?: string | null }) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ reason: string; error?: string | null }>("mpv://ended", (e) => cb(e.payload));
}

export async function onMpvTracks(cb: (tracks: MpvTrack[]) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<MpvTrack[]>("mpv://tracks", (e) => cb(e.payload));
}

export async function onMpvError(cb: (message: string) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ message: string }>("mpv://error", (e) => cb(e.payload.message));
}

export async function onMpvSurfaceClick(cb: () => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen("mpv://surface-click", () => cb());
}

export async function onMpvSurfaceDblClick(cb: () => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen("mpv://surface-dblclick", () => cb());
}

export async function onWindowFullscreen(cb: (fullscreen: boolean) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ fullscreen: boolean }>("window://fullscreen", (e) => cb(e.payload.fullscreen));
}

export async function onWindowRestored(cb: () => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen("window://restored", () => cb());
}
