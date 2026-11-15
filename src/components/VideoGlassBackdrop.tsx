import { useEffect, useRef, type RefObject } from "react";
import { mpvBackdropFrame, type MpvBackdropFrame } from "../lib/mpv";

interface VideoGlassBackdropProps {
  active: boolean;
  visible: boolean;
  playing: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  layoutKey: string;
}

const CAPTURE_INTERVAL_MS = 75;
const LAYOUT_TRACK_MS = 300;

interface ActiveBounds {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

function sampleBilinear(
  rgba: Uint8ClampedArray,
  fw: number,
  fh: number,
  u: number,
  v: number,
): [number, number, number] {
  const fx = Math.max(0, Math.min(fw - 1.001, u * (fw - 1)));
  const fy = Math.max(0, Math.min(fh - 1.001, v * (fh - 1)));
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = Math.min(fw - 1, x0 + 1);
  const y1 = Math.min(fh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const itx = 1 - tx;
  const ity = 1 - ty;

  const i00 = (y0 * fw + x0) * 4;
  const i10 = (y0 * fw + x1) * 4;
  const i01 = (y1 * fw + x0) * 4;
  const i11 = (y1 * fw + x1) * 4;

  const w00 = itx * ity;
  const w10 = tx * ity;
  const w01 = itx * ty;
  const w11 = tx * ty;

  return [
    rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11,
    rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11,
    rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11,
  ];
}

/**
 * Finds the active non-letterboxed movie picture region inside a captured frame
 * so glass surfaces keep rich ambient film light instead of turning solid black
 * when a 16:9 or 21:9 film plays in a compact or differently proportioned window.
 */
function detectActiveFrameBounds(rgba: Uint8ClampedArray, fw: number, fh: number): ActiveBounds {
  const stepX = Math.max(1, Math.floor(fw / 24));
  const stepY = Math.max(1, Math.floor(fh / 18));
  const rowHasPicture = (y: number): boolean => {
    for (let x = 0; x < fw; x += stepX) {
      const i = (y * fw + x) * 4;
      if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 28) return true;
    }
    return false;
  };
  const colHasPicture = (x: number, yStart: number, yEnd: number): boolean => {
    for (let y = yStart; y <= yEnd; y += stepY) {
      const i = (y * fw + x) * 4;
      if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 28) return true;
    }
    return false;
  };

  let top = 0;
  let bottom = fh - 1;
  while (top < Math.floor(fh * 0.35) && !rowHasPicture(top)) top++;
  while (bottom > Math.ceil(fh * 0.65) && !rowHasPicture(bottom)) bottom--;
  if (bottom <= top + 4) {
    return { minU: 0.02, maxU: 0.98, minV: 0.02, maxV: 0.98 };
  }

  let left = 0;
  let right = fw - 1;
  while (left < Math.floor(fw * 0.3) && !colHasPicture(left, top, bottom)) left++;
  while (right > Math.ceil(fw * 0.7) && !colHasPicture(right, top, bottom)) right--;
  if (right <= left + 4) {
    left = 0;
    right = fw - 1;
  }

  return {
    minU: Math.min(0.42, (left + 1) / fw),
    maxU: Math.max(0.58, (right - 1) / fw),
    minV: Math.min(0.42, (top + 1) / fh),
    maxV: Math.max(0.58, (bottom - 1) / fh),
  };
}

/**
 * Mirrors downsampled live frames from the native hardware mpv HWND exclusively
 * inside `[data-glass-region]` rounded rects, applying creamy iOS-style frosted
 * blur + subtle convex bezel lens refraction while keeping playback razor-sharp.
 */
export function VideoGlassBackdrop({
  active,
  visible,
  playing,
  viewportRef,
  layoutKey,
}: VideoGlassBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const regionScratchRef = useRef<HTMLCanvasElement | null>(null);
  const latestFrameRef = useRef<MpvBackdropFrame | null>(null);

  const paintRegionsRef = useRef<() => void>(() => {});

  paintRegionsRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const w = Math.max(1, Math.round(window.innerWidth));
    const h = Math.max(1, Math.round(window.innerHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const frame = latestFrameRef.current;
    if (!active || !visible || !frame) {
      return;
    }

    const regions = document.querySelectorAll<HTMLElement>("[data-glass-region]");
    if (regions.length === 0) return;

    const vpRect = viewportRef.current?.getBoundingClientRect();
    const dx = vpRect ? vpRect.left : 0;
    const dy = vpRect ? vpRect.top : 0;
    const dw = vpRect && vpRect.width > 0 ? vpRect.width : w;
    const dh = vpRect && vpRect.height > 0 ? vpRect.height : h;

    const activeBox = detectActiveFrameBounds(frame.rgba, frame.width, frame.height);

    let scratch = regionScratchRef.current;
    if (!scratch) {
      scratch = document.createElement("canvas");
      regionScratchRef.current = scratch;
    }
    const scratchCtx = scratch.getContext("2d");
    if (!scratchCtx) return;

    regions.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (Number.parseFloat(style.opacity) <= 0.02) return;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;

      const parsedRadius = Number.parseFloat(style.borderTopLeftRadius);
      const radius = Number.isFinite(parsedRadius)
        ? Math.max(0, Math.min(parsedRadius, r.width / 2, r.height / 2))
        : 0;

      // Render region optics at compact density; pre-blur with edge bleed eliminates dark halos.
      const rw = Math.max(20, Math.min(280, Math.round(r.width * 0.42)));
      const rh = Math.max(14, Math.min(200, Math.round(r.height * 0.42)));
      if (scratch.width !== rw || scratch.height !== rh) {
        scratch.width = rw;
        scratch.height = rh;
      }

      const img = scratchCtx.createImageData(rw, rh);
      const out = img.data;

      const halfW = r.width * 0.5;
      const halfH = r.height * 0.5;
      const bx = Math.max(0, halfW - radius);
      const by = Math.max(0, halfH - radius);
      const bezelThickness = Math.max(8, Math.min(20, Math.min(r.width, r.height) * 0.34));
      const refractStrength = Math.min(18, bezelThickness * 0.95);

      for (let py = 0; py < rh; py++) {
        const ly = ((py + 0.5) / rh) * r.height;
        const relY = ly - halfH;
        const absY = Math.abs(relY);
        const qy = absY - by;

        for (let px = 0; px < rw; px++) {
          const lx = ((px + 0.5) / rw) * r.width;
          const relX = lx - halfW;
          const absX = Math.abs(relX);
          const qx = absX - bx;

          const ox = qx > 0 ? qx : 0;
          const oy = qy > 0 ? qy : 0;
          const sdf = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0);
          const distInside = sdf < 0 ? -sdf : 0;

          let shiftX = 0;
          let shiftY = 0;
          if (distInside < bezelThickness) {
            const t = 1 - distInside / bezelThickness;
            const curve = t * t * (3 - 2 * t);
            let nx = 0;
            let ny = 0;
            if (qx > 0 && qy > 0) {
              const norm = Math.hypot(ox, oy) || 1;
              nx = (relX >= 0 ? -1 : 1) * (ox / norm);
              ny = (relY >= 0 ? -1 : 1) * (oy / norm);
            } else if (qx > qy) {
              nx = relX >= 0 ? -1 : 1;
            } else {
              ny = relY >= 0 ? -1 : 1;
            }
            const mag = curve * refractStrength;
            shiftX = nx * mag;
            shiftY = ny * mag;
          }

          const sx = r.left + lx + shiftX;
          const sy = r.top + ly + shiftY;
          const rawU = (sx - dx) / dw;
          const rawV = (sy - dy) / dh;
          const u = Math.max(activeBox.minU, Math.min(activeBox.maxU, rawU));
          const v = Math.max(activeBox.minV, Math.min(activeBox.maxV, rawV));

          const [rr, gg, bb] = sampleBilinear(frame.rgba, frame.width, frame.height, u, v);
          const idx = (py * rw + px) * 4;
          out[idx] = rr;
          out[idx + 1] = gg;
          out[idx + 2] = bb;
          out[idx + 3] = 255;
        }
      }

      scratchCtx.putImageData(img, 0, 0);

      // Light overscan pre-blur preserves meniscus edge refraction without dark edge halos.
      const bleed = 12;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(r.left, r.top, r.width, r.height, radius);
      ctx.clip();
      ctx.globalAlpha = 0.92;
      ctx.filter = "blur(6px)";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        scratch,
        0,
        0,
        rw,
        rh,
        r.left - bleed,
        r.top - bleed,
        r.width + bleed * 2,
        r.height + bleed * 2,
      );
      ctx.restore();
    });
  };

  useEffect(() => {
    if (!active || !visible) {
      latestFrameRef.current = null;
      paintRegionsRef.current();
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const pullOnce = async () => {
      if (cancelled || document.hidden) return;
      try {
        const frame = await mpvBackdropFrame(240, 135);
        if (!cancelled && frame) {
          latestFrameRef.current = frame;
          paintRegionsRef.current();
        }
      } catch {
        // Ignore transient capture misses during load/close transitions.
      }
    };

    const scheduleLoop = () => {
      if (cancelled || !playing) return;
      timerId = window.setTimeout(async () => {
        await pullOnce();
        scheduleLoop();
      }, CAPTURE_INTERVAL_MS);
    };

    void pullOnce().then(() => {
      if (cancelled) return;
      if (playing) {
        scheduleLoop();
      } else {
        timerId = window.setTimeout(() => {
          void pullOnce();
        }, 70);
      }
    });

    const handleVisibility = () => {
      if (!document.hidden && !cancelled) {
        void pullOnce();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active, visible, playing]);

  useEffect(() => {
    if (!active || !visible) {
      paintRegionsRef.current();
      return;
    }

    let rafId = 0;
    const start = performance.now();
    const tick = (now: number) => {
      paintRegionsRef.current();
      if (now - start < LAYOUT_TRACK_MS) {
        rafId = window.requestAnimationFrame(tick);
      }
    };
    rafId = window.requestAnimationFrame(tick);

    const onResize = () => paintRegionsRef.current();
    window.addEventListener("resize", onResize);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
    };
  }, [active, visible, layoutKey]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 z-10 pointer-events-none w-full h-full"
    />
  );
}
