import type { CSSProperties } from "react";
import { isDesktop, safeInvoke } from "./bridge";

export interface ThumbnailSprite {
  dataUrl: string;
  cols: number;
  rows: number;
  frameW: number;
  frameH: number;
  intervalSecs: number;
  frameCount: number;
}

let cachedSpriteKey = "";
let cachedSprite: ThumbnailSprite | null = null;
let pinnedSpriteImage: HTMLImageElement | null = null;
let inFlightKey = "";
let inFlightPromise: Promise<ThumbnailSprite | null> | null = null;

function buildSpriteSessionKey(path: string, durationSecs: number): string {
  return `${path.trim().toLowerCase()}::${Math.max(15, Math.round(durationSecs / 5) * 5)}`;
}

async function decodeAndPinSpriteImage(dataUrl: string): Promise<void> {
  if (typeof Image === "undefined" || !dataUrl) return;
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = dataUrl;
    if (typeof img.decode === "function") {
      await img.decode();
    }
    pinnedSpriteImage = img;
  } catch {
    // Ignore decode errors on non-standard environments.
  }
}

export function getCachedSeekbarThumbnails(
  path: string | null | undefined,
  durationSecs: number,
): ThumbnailSprite | null {
  if (!path || !Number.isFinite(durationSecs) || durationSecs < 15) return null;
  const key = buildSpriteSessionKey(path, durationSecs);
  return cachedSpriteKey === key ? cachedSprite : null;
}

export async function generateSeekbarThumbnails(
  path: string,
  durationSecs: number,
): Promise<ThumbnailSprite | null> {
  if (!isDesktop() || !path || !Number.isFinite(durationSecs) || durationSecs < 15) {
    return null;
  }
  const key = buildSpriteSessionKey(path, durationSecs);
  if (cachedSpriteKey === key && cachedSprite) {
    return cachedSprite;
  }
  if (inFlightKey === key && inFlightPromise) {
    return inFlightPromise;
  }

  inFlightKey = key;
  const promise = (async () => {
    try {
      const sprite = await safeInvoke<ThumbnailSprite | null>("generate_seekbar_thumbnails", {
        path,
        durationSecs,
      });
      if (sprite && sprite.dataUrl) {
        await decodeAndPinSpriteImage(sprite.dataUrl);
        cachedSpriteKey = key;
        cachedSprite = sprite;
      }
      return sprite;
    } finally {
      if (inFlightKey === key) {
        inFlightKey = "";
        inFlightPromise = null;
      }
    }
  })();
  inFlightPromise = promise;
  return promise;
}

export async function cancelSeekbarThumbnails(): Promise<void> {
  inFlightKey = "";
  inFlightPromise = null;
  if (!isDesktop()) return;
  await safeInvoke<void>("cancel_seekbar_thumbnails").catch(() => undefined);
}

export async function clearThumbnailCache(): Promise<number> {
  cachedSpriteKey = "";
  cachedSprite = null;
  if (pinnedSpriteImage) {
    pinnedSpriteImage.src = "";
    pinnedSpriteImage = null;
  }
  if (!isDesktop()) return 0;
  return safeInvoke<number>("clear_thumbnail_cache");
}

export function getThumbnailFrameStyle(
  sprite: ThumbnailSprite,
  timeSecs: number,
): CSSProperties {
  const rawIndex = Math.floor(Math.max(0, timeSecs) / Math.max(1, sprite.intervalSecs));
  const index = Math.max(0, Math.min(sprite.frameCount - 1, rawIndex));
  const col = index % sprite.cols;
  const row = Math.floor(index / sprite.cols);
  return {
    width: sprite.frameW,
    height: sprite.frameH,
    backgroundImage: `url("${sprite.dataUrl}")`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${sprite.cols * sprite.frameW}px ${sprite.rows * sprite.frameH}px`,
    backgroundPosition: `-${col * sprite.frameW}px -${row * sprite.frameH}px`,
  };
}
