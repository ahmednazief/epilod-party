import type { MpvBackdropFrame } from "./mpv";

export const CHAT_IMAGE_MAX_DIM = 1280;
export const CHAT_IMAGE_MAX_BYTES = 185 * 1024;
export const CHAT_IMAGE_TTL_MS = 30 * 60 * 1000;

export interface CompressedChatImage {
  width: number;
  height: number;
  byteLen: number;
  dataB64: string;
  objectUrl: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToObjectUrl(
  dataB64: string,
  mime = "image/webp",
): { objectUrl: string; byteLen: number } {
  const binary = atob(dataB64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mime });
  return { objectUrl: URL.createObjectURL(blob), byteLen: len };
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = Math.round(bytes / 1024);
  return `${kb} KB`;
}

export async function compressImageToWebP(
  source: Blob | string | MpvBackdropFrame,
  maxDim = CHAT_IMAGE_MAX_DIM,
  maxBytes = CHAT_IMAGE_MAX_BYTES,
): Promise<CompressedChatImage> {
  let bitmap: ImageBitmap;
  let shouldCloseBitmap = false;
  if (typeof source === "object" && !(source instanceof Blob)) {
    if (source.bitmap) {
      bitmap = source.bitmap;
    } else if (source.rgba) {
      const imgData = new ImageData(
        new Uint8ClampedArray(source.rgba),
        source.width,
        source.height,
      );
      bitmap = await createImageBitmap(imgData);
      shouldCloseBitmap = true;
    } else {
      throw new Error("Empty video frame.");
    }
  } else {
    let inputBlob: Blob;
    if (typeof source === "string") {
      const res = await fetch(source);
      inputBlob = await res.blob();
    } else {
      inputBlob = source;
    }
    bitmap = await createImageBitmap(inputBlob);
    shouldCloseBitmap = true;
  }

  try {
    const origW = Math.max(1, bitmap.width);
    const origH = Math.max(1, bitmap.height);
    let scale = Math.min(1, maxDim / Math.max(origW, origH));

    const qualities = [0.78, 0.66, 0.54, 0.42];
    for (let attempt = 0; attempt < qualities.length; attempt += 1) {
      const targetW = Math.max(1, Math.round(origW * scale));
      const targetH = Math.max(1, Math.round(origH * scale));
      const quality = qualities[attempt];

      let outBlob: Blob | null = null;
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(targetW, targetH);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable.");
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        outBlob = await canvas.convertToBlob({ type: "image/webp", quality });
      } else {
        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable.");
        ctx.drawImage(bitmap, 0, 0, targetW, targetH);
        outBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/webp", quality),
        );
      }

      if (!outBlob) throw new Error("Failed to encode WebP image.");
      if (outBlob.size <= maxBytes || attempt === qualities.length - 1) {
        if (outBlob.size > 198 * 1024) {
          throw new Error("Image is too complex to fit within the 200 KB P2P limit.");
        }
        const buf = await outBlob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        return {
          width: targetW,
          height: targetH,
          byteLen: bytes.length,
          dataB64: bytesToBase64(bytes),
          objectUrl: URL.createObjectURL(outBlob),
        };
      }
      // Step down dimensions slightly if still over budget
      scale *= 0.82;
    }
    throw new Error("Unable to compress image.");
  } finally {
    if (shouldCloseBitmap) {
      bitmap.close();
    }
  }
}
