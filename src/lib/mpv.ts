import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createSerialQueue } from "./asyncGuard";
import { isDesktop, safeInvoke } from "./bridge";
import { nextClientSeekSeq } from "./seekCoalesce";

export const enqueueMpvLifecycle = createSerialQueue();

export interface MpvSurfaceState {
  running: boolean;
  hasMedia: boolean;
  uiVisible: boolean;
  surfaceVisible: boolean;
}

type RuntimeLostListener = (message: string) => void;
const runtimeLostListeners = new Set<RuntimeLostListener>();

export function subscribeMpvRuntimeLost(listener: RuntimeLostListener): () => void {
  runtimeLostListeners.add(listener);
  return () => {
    runtimeLostListeners.delete(listener);
  };
}

export function isMpvNotRunningError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return msg.includes("video player is not running") || msg.includes("command queue is unavailable");
}

export function safeMpvCall(promise: Promise<unknown>, _context?: string): Promise<void> {
  return promise.then(
    () => undefined,
    (err) => {
      if (isMpvNotRunningError(err)) {
        const msg =
          err instanceof Error ? err.message : String(err ?? "Video player is not running.");
        for (const listener of runtimeLostListeners) {
          listener(msg);
        }
      }
    },
  );
}

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
  default?: boolean;
  forced?: boolean;
  "ff-index"?: number;
  "demux-index"?: number;
  selected?: boolean;
}

export type RawMpvTrack = Omit<MpvTrack, "type"> & {
  type?: MpvTrack["type"];
  kind?: MpvTrack["type"];
};

export function normalizeMpvTrack(raw: RawMpvTrack): MpvTrack {
  const normalizedType =
    typeof raw.type === "string" && raw.type
      ? raw.type
      : typeof raw.kind === "string"
        ? raw.kind
        : "";
  return {
    id: raw.id,
    type: normalizedType,
    title: raw.title ?? null,
    lang: raw.lang ?? null,
    codec: raw.codec ?? null,
    external: Boolean(raw.external),
    default: Boolean(raw.default),
    forced: Boolean(raw.forced),
    ...(raw["ff-index"] !== undefined ? { "ff-index": raw["ff-index"] } : {}),
    ...(raw["demux-index"] !== undefined ? { "demux-index": raw["demux-index"] } : {}),
    selected: Boolean(raw.selected),
  };
}

export function normalizeMpvTracks(rawTracks: readonly RawMpvTrack[]): MpvTrack[] {
  return Array.isArray(rawTracks) ? rawTracks.map(normalizeMpvTrack) : [];
}

export type AspectMode = "auto" | "16:9" | "4:3" | "21:9" | "fill";
export type SubtitleEncodingHint = "auto" | "utf8" | "windows1256" | "windows1252" | "windows1251";

export interface AutoSyncResult {
  offsetSecs: number;
  scale: number;
  confidenceZ: number;
  correlation: number;
  driftApplied: boolean;
  segmentsApplied?: number;
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

export async function mpvGetSurfaceState(): Promise<MpvSurfaceState> {
  if (!isDesktop()) {
    return {
      running: true,
      hasMedia: true,
      uiVisible: true,
      surfaceVisible: true,
    };
  }
  return safeInvoke<MpvSurfaceState>("mpv_get_surface_state");
}

export interface MpvBackdropFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

let lastCapturedBackdropFrame: MpvBackdropFrame | null = null;

export function getLastCapturedBackdropFrame(): MpvBackdropFrame | null {
  return lastCapturedBackdropFrame;
}

export function clearLastCapturedBackdropFrame(): void {
  lastCapturedBackdropFrame = null;
}

export async function mpvBackdropFrame(
  maxWidth = 240,
  maxHeight = 135,
): Promise<MpvBackdropFrame | null> {
  const raw = await safeInvoke<ArrayBuffer | Uint8Array | number[]>("mpv_backdrop_frame", {
    maxWidth,
    maxHeight,
  });
  const bytes =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw instanceof Uint8Array
        ? raw
        : Array.isArray(raw)
          ? Uint8Array.from(raw)
          : null;
  if (!bytes || bytes.byteLength < 8) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(0, true);
  const height = view.getUint16(2, true);
  const expected = 4 + width * height * 4;
  if (width <= 0 || height <= 0 || bytes.byteLength < expected) {
    return null;
  }
  const frame: MpvBackdropFrame = {
    width,
    height,
    rgba: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 4, width * height * 4),
  };
  lastCapturedBackdropFrame = frame;
  return frame;
}

export async function captureFrozenBackdropFrame(): Promise<MpvBackdropFrame | null> {
  if (!isDesktop()) return lastCapturedBackdropFrame;
  try {
    const snap = await mpvBackdropFrame(480, 270);
    if (snap) return snap;
  } catch {
    // Fall back to latest cached frame if capture fails.
  }
  return lastCapturedBackdropFrame;
}

export async function withHiddenMpvForDialog<T>(
  mpvActive: boolean,
  options: {
    onFreezeFrame?: (frame: MpvBackdropFrame) => void;
    shouldRestoreVisible: () => boolean;
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (mpvActive) {
    if (options.onFreezeFrame) {
      if (lastCapturedBackdropFrame) {
        options.onFreezeFrame(lastCapturedBackdropFrame);
      }
      const snap = await captureFrozenBackdropFrame();
      if (snap) {
        options.onFreezeFrame(snap);
      }
    }
    try {
      await mpvSetVisible(false);
    } catch {
      // Engine may not be alive if runtime exited.
    }
  }
  try {
    return await fn();
  } finally {
    if (mpvActive) {
      safeMpvCall(mpvSetVisible(options.shouldRestoreVisible()), "mpvSetVisible");
    }
  }
}

export async function mpvLoad(path: string): Promise<void> {
  lastCapturedBackdropFrame = null;
  await safeInvoke("mpv_load", { path });
}

export async function mpvSetPause(paused: boolean): Promise<void> {
  await safeInvoke("mpv_set_pause", { paused });
}

export interface MpvSeekOptions {
  preview?: boolean;
  clientSeekSeq?: number;
}

export async function mpvSeek(seconds: number, options?: MpvSeekOptions): Promise<void> {
  const clientSeekSeq = options?.clientSeekSeq ?? nextClientSeekSeq();
  await safeInvoke("mpv_seek", {
    seconds,
    preview: options?.preview ?? false,
    clientSeekSeq,
  });
}

export async function mpvStop(): Promise<void> {
  lastCapturedBackdropFrame = null;
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

export async function mpvRemoveSubtitle(sid: number): Promise<void> {
  await safeInvoke("mpv_remove_subtitle", { sid });
}

export interface SubStyleParams {
  font: string;
  bold?: boolean;
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
  embeddedSubFfIdx?: number | null;
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
    embeddedSubFfIdx: params.embeddedSubFfIdx ?? null,
    embeddedSubCodec: params.embeddedSubCodec ?? null,
    encodingHint: params.encodingHint ?? "auto",
    lowPower: params.lowPower ?? false,
  });
}

export interface SubtitleTwoAnchorParams {
  subtitlePath?: string | null;
  videoPath?: string | null;
  embeddedSubIdx?: number | null;
  embeddedSubFfIdx?: number | null;
  embeddedSubCodec?: string | null;
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
    subtitlePath: params.subtitlePath ?? null,
    videoPath: params.videoPath ?? null,
    embeddedSubIdx: params.embeddedSubIdx ?? null,
    embeddedSubFfIdx: params.embeddedSubFfIdx ?? null,
    embeddedSubCodec: params.embeddedSubCodec ?? null,
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

export async function windowDragFromMaximized(): Promise<void> {
  if (!isDesktop()) {
    return;
  }
  await safeInvoke("window_drag_from_maximized");
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

export async function onMpvTime(
  cb: (position: number, clientSeekSeq?: number) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ position: number; clientSeekSeq?: number }>("mpv://time", (e) =>
    cb(e.payload.position, e.payload.clientSeekSeq),
  );
}

export async function onMpvSeekSettled(cb: () => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen("mpv://seek-settled", () => cb());
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
  return listen<RawMpvTrack[]>("mpv://tracks", (e) => cb(normalizeMpvTracks(e.payload)));
}

export async function onMpvError(cb: (message: string) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ message: string }>("mpv://error", (e) => cb(e.payload.message));
}

export async function onMpvSurfaceState(cb: (state: MpvSurfaceState) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<MpvSurfaceState>("mpv://surface-state", (e) => cb(e.payload));
}

export async function onMpvCommandWarning(cb: (message: string) => void): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<{ message: string }>("mpv://command-warning", (e) => cb(e.payload.message));
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

export interface MpvChapter {
  title: string | null;
  time: number;
}

export type IntroSegmentKind = "intro" | "recap";
export type IntroSource =
  | "chapter"
  | "audioMatch"
  | "subtitleCue"
  | "chapterStructure"
  | "manual";
export type IntroConfidence = "high" | "medium";

export interface DetectedIntro {
  startSecs: number;
  endSecs: number;
  skipTargetSecs: number;
  kind: IntroSegmentKind;
  source: IntroSource;
  confidence: IntroConfidence;
  label: string;
  similarity: number | null;
  matchedEpisodes: number;
}

export interface IntroDetectionOutcome {
  segments: DetectedIntro[];
  primaryIntro: DetectedIntro | null;
}

export interface DetectVideoIntroParams {
  videoPath: string;
  durationSecs: number;
  chapters: MpvChapter[];
  siblingPaths: string[];
  subtitlePath?: string | null;
  embeddedSubIdx?: number | null;
  embeddedSubCodec?: string | null;
  audioStreamIdx?: number | null;
  lowPower?: boolean;
}

export async function detectVideoIntro(
  params: DetectVideoIntroParams
): Promise<IntroDetectionOutcome> {
  if (!isDesktop()) {
    return { segments: [], primaryIntro: null };
  }
  return safeInvoke<IntroDetectionOutcome>("detect_video_intro", {
    videoPath: params.videoPath,
    durationSecs: params.durationSecs,
    chapters: params.chapters,
    siblingPaths: params.siblingPaths,
    subtitlePath: params.subtitlePath ?? null,
    embeddedSubIdx: params.embeddedSubIdx ?? null,
    embeddedSubCodec: params.embeddedSubCodec ?? null,
    audioStreamIdx: params.audioStreamIdx ?? null,
    lowPower: params.lowPower ?? false,
  });
}

export async function introCancelDetect(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await safeInvoke<void>("intro_cancel_detect");
  } catch {
    // non-fatal cancellation failure
  }
}

export async function onMpvChapters(
  cb: (chapters: MpvChapter[]) => void
): Promise<UnlistenFn> {
  if (!isDesktop()) return noopUnlisten();
  return listen<MpvChapter[]>("mpv://chapters", (e) => {
    const raw = Array.isArray(e.payload) ? e.payload : [];
    cb(
      raw.filter(
        (c): c is MpvChapter =>
          typeof c === "object" &&
          c !== null &&
          typeof c.time === "number" &&
          Number.isFinite(c.time) &&
          c.time >= 0
      )
    );
  });
}
