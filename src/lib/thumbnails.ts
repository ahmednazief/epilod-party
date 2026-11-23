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

export async function generateSeekbarThumbnails(
  path: string,
  durationSecs: number,
): Promise<ThumbnailSprite | null> {
  if (!isDesktop() || !path || !Number.isFinite(durationSecs) || durationSecs < 15) {
    return null;
  }
  return safeInvoke<ThumbnailSprite | null>("generate_seekbar_thumbnails", {
    path,
    durationSecs,
  });
}

export async function cancelSeekbarThumbnails(): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke<void>("cancel_seekbar_thumbnails").catch(() => undefined);
}

export async function clearThumbnailCache(): Promise<number> {
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
