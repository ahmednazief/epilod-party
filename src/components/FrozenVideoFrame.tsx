import { useLayoutEffect, useRef } from "react";
import type { MpvBackdropFrame } from "../lib/mpv";

interface FrozenVideoFrameProps {
  frame: MpvBackdropFrame | null;
}

/** Displays the last captured video frame while the Win32 child HWND is hidden by modals or native dialogs. */
export function FrozenVideoFrame({ frame }: FrozenVideoFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (frame.bitmap) {
      ctx.drawImage(frame.bitmap, 0, 0, frame.width, frame.height);
    } else if (frame.rgba) {
      const pixels = new Uint8ClampedArray(frame.rgba);
      const img = new ImageData(pixels, frame.width, frame.height);
      ctx.putImageData(img, 0, 0);
    }
  }, [frame]);

  if (!frame) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 z-0 w-full h-full object-contain bg-canvas pointer-events-none"
    />
  );
}
