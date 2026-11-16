import { memo, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import {
  clearReactions,
  subscribeReactions,
  type ReactionSpawnItem,
} from "../store/useReactionStore";
import {
  AVATAR_PRESETS,
  isValidAvatarId,
  ProfileAvatar,
  resolvePeerAvatarId,
  type AvatarId,
} from "./ui/ProfileAvatar";

interface FloatingReactionsOverlayProps {
  enabled: boolean;
  chromeVisible: boolean;
  localUsername: string;
  dockOpen?: boolean;
}

interface ActiveParticle {
  id: number;
  emoji: string;
  username: string;
  avatarId: AvatarId;
  isSelf: boolean;
  showBadge: boolean;
  bornAt: number;
  durationMs: number;
  startXRatio: number;
  jitterX: number;
  driftX: number;
  risePx: number;
  swayAmp: number;
  swayFreq: number;
  swayPhase: number;
  tiltAmp: number;
  baseScale: number;
  minBottomClearance: number;
}

const MAX_PARTICLES_NORMAL = 240;
const MAX_PARTICLES_LOW_POWER = 90;
const MAX_CACHE_ENTRIES = 96;
const EMOJI_FONT =
  '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", system-ui, sans-serif';
const UI_FONT =
  '"Inter", "Segoe UI Variable Display", system-ui, sans-serif';

function truncateSenderLabel(raw: string): string {
  const clean = raw.trim() || "Viewer";
  return clean.length > 10 ? `${clean.slice(0, 9)}…` : clean;
}

function springPopScale(t: number): number {
  if (t >= 1) return 1;
  // Overshoots slightly around t=0.55 then settles cleanly to 1.0
  const inv = 1 - t;
  return 1 - inv * inv * Math.cos(t * Math.PI * 1.45) * 0.72;
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export const FloatingReactionsOverlay = memo(function FloatingReactionsOverlay({
  enabled,
  chromeVisible,
  localUsername,
  dockOpen = false,
}: FloatingReactionsOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const avatarDomRefs = useRef<Partial<Record<AvatarId, HTMLSpanElement | null>>>({});

  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const localAvatarId = useAppStore((s) => s.avatarId);
  const fullWidthPlayBar = useAppStore((s) => s.fullWidthPlayBar);

  const [requestedAvatars, setRequestedAvatars] = useState<AvatarId[]>([]);
  const requestedSetRef = useRef<Set<AvatarId>>(new Set());

  const avatarBitmapCacheRef = useRef<Map<AvatarId, HTMLCanvasElement>>(new Map());
  const emojiBitmapCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const badgeBitmapCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const configRef = useRef({
    enabled,
    chromeVisible,
    dockOpen,
    hideParticipants,
    reducedMotion,
    lowPowerMode,
    fullWidthPlayBar,
    localUsername,
    localAvatarId,
  });
  configRef.current = {
    enabled,
    chromeVisible,
    dockOpen,
    hideParticipants,
    reducedMotion,
    lowPowerMode,
    fullWidthPlayBar,
    localUsername,
    localAvatarId,
  };

  // Rasterize any newly requested AvatarSvg DOM node into an offscreen bitmap
  useEffect(() => {
    for (const id of requestedAvatars) {
      if (avatarBitmapCacheRef.current.has(id)) continue;
      const host = avatarDomRefs.current[id];
      const svgEl = host?.querySelector("svg");
      if (!svgEl) continue;

      const serialized = new XMLSerializer().serializeToString(svgEl);
      const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
      const img = new Image();
      img.onload = () => {
        const size = 48;
        const off = document.createElement("canvas");
        off.width = size;
        off.height = size;
        const octx = off.getContext("2d");
        if (!octx) return;
        octx.beginPath();
        octx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        octx.closePath();
        octx.clip();
        octx.drawImage(img, 0, 0, size, size);
        avatarBitmapCacheRef.current.set(id, off);
        // Clear any placeholder badge entries for this avatarId so the crisp avatar renders next frame
        for (const key of badgeBitmapCacheRef.current.keys()) {
          if (key.includes(`|${id}|`)) {
            badgeBitmapCacheRef.current.delete(key);
          }
        }
      };
      img.src = dataUri;
    }
  }, [requestedAvatars]);

  useEffect(() => {
    if (!enabled) {
      clearReactions();
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    const particles: ActiveParticle[] = [];
    let rafId = 0;
    let lastFrameAt = 0;

    const getEmojiBitmap = (emoji: string, dpr: number): HTMLCanvasElement => {
      const key = `${emoji}|${dpr}`;
      const cached = emojiBitmapCacheRef.current.get(key);
      if (cached) return cached;

      const logicalBox = 62;
      const px = Math.ceil(logicalBox * dpr);
      const off = document.createElement("canvas");
      off.width = px;
      off.height = px;
      const octx = off.getContext("2d");
      if (octx) {
        octx.scale(dpr, dpr);
        // Subtle ambient glow behind hero emoji so dark scenes keep crisp contrast
        const grad = octx.createRadialGradient(
          logicalBox / 2,
          logicalBox / 2,
          3,
          logicalBox / 2,
          logicalBox / 2,
          logicalBox / 2 - 2,
        );
        grad.addColorStop(0, "rgba(139, 92, 246, 0.22)");
        grad.addColorStop(0.55, "rgba(15, 13, 24, 0.14)");
        grad.addColorStop(1, "rgba(0, 0, 0, 0)");
        octx.fillStyle = grad;
        octx.beginPath();
        octx.arc(logicalBox / 2, logicalBox / 2, logicalBox / 2 - 2, 0, Math.PI * 2);
        octx.fill();

        octx.font = `36px ${EMOJI_FONT}`;
        octx.textAlign = "center";
        octx.textBaseline = "middle";
        octx.shadowColor = "rgba(0, 0, 0, 0.48)";
        octx.shadowBlur = 8;
        octx.shadowOffsetY = 2;
        octx.fillText(emoji, logicalBox / 2, logicalBox / 2 + 2);
      }

      if (emojiBitmapCacheRef.current.size >= MAX_CACHE_ENTRIES) {
        const firstKey = emojiBitmapCacheRef.current.keys().next().value;
        if (firstKey !== undefined) emojiBitmapCacheRef.current.delete(firstKey);
      }
      emojiBitmapCacheRef.current.set(key, off);
      return off;
    };

    const getBadgeBitmap = (
      username: string,
      avatarId: AvatarId,
      isSelf: boolean,
      dpr: number,
    ): HTMLCanvasElement => {
      const label = truncateSenderLabel(username);
      const key = `${label}|${avatarId}|${isSelf ? 1 : 0}|${dpr}`;
      const cached = badgeBitmapCacheRef.current.get(key);
      if (cached) return cached;

      const pillH = 22;
      const avatarSize = 16;
      const padLeft = 3;
      const padRight = 8;
      const gap = 5;
      const shadowPad = 10;

      const measureCanvas = document.createElement("canvas");
      const mctx = measureCanvas.getContext("2d");
      let textW = 34;
      if (mctx) {
        mctx.font = `600 10.5px ${UI_FONT}`;
        textW = Math.ceil(mctx.measureText(label).width);
      }
      const pillW = Math.max(46, Math.min(124, padLeft + avatarSize + gap + textW + padRight));
      const logicalW = pillW + shadowPad * 2;
      const logicalH = pillH + shadowPad * 2;

      const off = document.createElement("canvas");
      off.width = Math.ceil(logicalW * dpr);
      off.height = Math.ceil(logicalH * dpr);
      const octx = off.getContext("2d");
      if (octx) {
        octx.scale(dpr, dpr);
        const px = shadowPad;
        const py = shadowPad;

        // iOS Liquid-Glass Capsule
        octx.save();
        octx.shadowColor = "rgba(0, 0, 0, 0.52)";
        octx.shadowBlur = 12;
        octx.shadowOffsetY = 3;
        drawRoundedRectPath(octx, px, py, pillW, pillH, pillH / 2);
        const bodyGrad = octx.createLinearGradient(px, py, px, py + pillH);
        if (isSelf) {
          bodyGrad.addColorStop(0, "rgba(196, 181, 253, 0.34)");
          bodyGrad.addColorStop(0.45, "rgba(76, 29, 149, 0.44)");
          bodyGrad.addColorStop(1, "rgba(24, 16, 46, 0.62)");
        } else {
          bodyGrad.addColorStop(0, "rgba(255, 255, 255, 0.28)");
          bodyGrad.addColorStop(0.45, "rgba(32, 30, 48, 0.46)");
          bodyGrad.addColorStop(1, "rgba(18, 16, 28, 0.62)");
        }
        octx.fillStyle = bodyGrad;
        octx.fill();
        octx.restore();

        // Subtle hairline rim border
        drawRoundedRectPath(octx, px + 0.5, py + 0.5, pillW - 1, pillH - 1, (pillH - 1) / 2);
        octx.strokeStyle = isSelf
          ? "rgba(237, 233, 254, 0.24)"
          : "rgba(255, 255, 255, 0.14)";
        octx.lineWidth = 1;
        octx.stroke();

        // Top specular glass highlight
        octx.save();
        drawRoundedRectPath(octx, px + 1, py + 1, pillW - 2, pillH / 2, pillH / 2);
        octx.clip();
        const specGrad = octx.createLinearGradient(px, py, px, py + pillH * 0.55);
        specGrad.addColorStop(0, "rgba(255, 255, 255, 0.34)");
        specGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        octx.fillStyle = specGrad;
        octx.fillRect(px + 1, py + 1, pillW - 2, pillH / 2);
        octx.restore();

        // Circular ProfileAvatar or clean initial fallback while SVG loads
        const avX = px + padLeft;
        const avY = py + (pillH - avatarSize) / 2;
        const avBmp = avatarBitmapCacheRef.current.get(avatarId);
        if (avBmp) {
          octx.drawImage(avBmp, avX, avY, avatarSize, avatarSize);
        } else {
          octx.fillStyle = "#5B21B6";
          octx.beginPath();
          octx.arc(avX + avatarSize / 2, avY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
          octx.fill();
          octx.fillStyle = "#EDE9FE";
          octx.font = `700 9px ${UI_FONT}`;
          octx.textAlign = "center";
          octx.textBaseline = "middle";
          octx.fillText(
            label.slice(0, 1).toUpperCase(),
            avX + avatarSize / 2,
            avY + avatarSize / 2 + 0.5,
          );
        }
        octx.strokeStyle = "rgba(255, 255, 255, 0.34)";
        octx.lineWidth = 0.8;
        octx.beginPath();
        octx.arc(avX + avatarSize / 2, avY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        octx.stroke();

        // Sender display name
        octx.font = `600 10.5px ${UI_FONT}`;
        octx.fillStyle = "rgba(248, 250, 252, 0.96)";
        octx.textAlign = "left";
        octx.textBaseline = "middle";
        octx.fillText(label, avX + avatarSize + gap, py + pillH / 2 + 0.5);
      }

      if (badgeBitmapCacheRef.current.size >= MAX_CACHE_ENTRIES) {
        const firstKey = badgeBitmapCacheRef.current.keys().next().value;
        if (firstKey !== undefined) badgeBitmapCacheRef.current.delete(firstKey);
      }
      badgeBitmapCacheRef.current.set(key, off);
      return off;
    };

    const ensureAvatarRequested = (avatarId: AvatarId) => {
      if (!requestedSetRef.current.has(avatarId)) {
        requestedSetRef.current.add(avatarId);
        setRequestedAvatars((prev) => (prev.includes(avatarId) ? prev : [...prev, avatarId]));
      }
    };

    const spawnParticle = (item: ReactionSpawnItem) => {
      const cfg = configRef.current;
      if (!cfg.enabled) return;

      const resolvedAvatar: AvatarId = isValidAvatarId(item.avatarId)
        ? item.avatarId
        : resolvePeerAvatarId(item.username, cfg.localUsername, cfg.localAvatarId);
      ensureAvatarRequested(resolvedAvatar);

      const cap = cfg.lowPowerMode ? MAX_PARTICLES_LOW_POWER : MAX_PARTICLES_NORMAL;
      while (particles.length >= cap) {
        particles.shift();
      }

      const reduced = cfg.reducedMotion;
      const dockRect = document
        .querySelector<HTMLElement>(".ep-glass-reaction-dock")
        ?.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      const hasDock = Boolean(dockRect && dockRect.width > 40 && dockRect.top > 120);
      const anchoredXRatio = hasDock && dockRect
        ? Math.max(
            0.14,
            Math.min(0.88, (dockRect.left + dockRect.width * (0.24 + Math.random() * 0.52)) / vw),
          )
        : 0.78 + Math.random() * 0.14;
      const minBottomClearance = hasDock && dockRect
        ? Math.max(196, Math.round(vh - dockRect.top + 48))
        : cfg.dockOpen
          ? 196
          : 0;

      particles.push({
        id: item.id,
        emoji: item.emoji,
        username: item.username,
        avatarId: resolvedAvatar,
        isSelf: item.isSelf,
        showBadge: item.showBadge,
        bornAt: performance.now(),
        durationMs: reduced ? 1900 + Math.random() * 350 : 2650 + Math.random() * 800,
        startXRatio: anchoredXRatio,
        jitterX: (Math.random() - 0.5) * 44,
        driftX: reduced ? 0 : (Math.random() - 0.55) * 38,
        risePx: reduced ? 56 + Math.random() * 24 : 330 + Math.random() * 170,
        swayAmp: reduced ? 0 : 14 + Math.random() * 20,
        swayFreq: 1.2 + Math.random() * 1.1,
        swayPhase: Math.random() * Math.PI * 2,
        tiltAmp: reduced ? 0 : 0.08 + Math.random() * 0.1,
        baseScale: 0.9 + Math.random() * 0.24,
        minBottomClearance,
      });

      if (!rafId) {
        lastFrameAt = 0;
        rafId = window.requestAnimationFrame(renderFrame);
      }
    };

    const renderFrame = (now: number) => {
      const cfg = configRef.current;
      const canvas = canvasRef.current;
      if (!canvas) {
        rafId = 0;
        return;
      }

      if (cfg.lowPowerMode && lastFrameAt > 0 && now - lastFrameAt < 32) {
        rafId = window.requestAnimationFrame(renderFrame);
        return;
      }
      lastFrameAt = now;

      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const cssW = Math.max(1, canvas.clientWidth || window.innerWidth);
      const cssH = Math.max(1, canvas.clientHeight || window.innerHeight);
      const targetW = Math.round(cssW * dpr);
      const targetH = Math.round(cssH * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafId = 0;
        return;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const bottomBase = cfg.chromeVisible
        ? cfg.fullWidthPlayBar
          ? cssH - 122
          : cssH - 138
        : cssH - 44;

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        const age = now - p.bornAt;
        if (age >= p.durationMs) {
          particles.splice(i, 1);
          continue;
        }

        const t = Math.max(0, Math.min(1, age / p.durationMs));
        const easeOut = 1 - Math.pow(1 - t, 1.55);
        const fadeIn = Math.min(1, age / 95);
        const fadeOut = t > 0.66 ? Math.max(0, 1 - (t - 0.66) / 0.34) : 1;
        const alpha = fadeIn * fadeOut;

        const popT = Math.min(1, age / 240);
        const scale =
          p.baseScale *
          springPopScale(popT) *
          (t > 0.72 ? 1 + ((t - 0.72) / 0.28) * 0.08 : 1);

        const maxSafeX = Math.max(70, cssW - 58);
        const minSafeX = Math.max(58, cssW - 270);
        const laneX = Math.max(minSafeX, Math.min(maxSafeX, cssW * p.startXRatio + p.jitterX));
        const swayX = Math.sin(t * Math.PI * 2 * p.swayFreq + p.swayPhase) * p.swayAmp;
        const x = Math.max(46, Math.min(cssW - 46, laneX + swayX + p.driftX * t));

        const startY = Math.min(bottomBase, cssH - p.minBottomClearance);
        const maxRise = Math.max(80, Math.min(p.risePx, Math.max(80, startY - 78)));
        const y = startY - easeOut * maxRise;
        const tilt = Math.cos(t * Math.PI * 2 * p.swayFreq + p.swayPhase) * p.tiltAmp;

        const emojiBmp = getEmojiBitmap(p.emoji, dpr);
        const emojiW = emojiBmp.width / dpr;
        const emojiH = emojiBmp.height / dpr;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);

        // Draw sender pill first cleanly below the emoji so the hero emoji sits above & on top of it
        if (p.showBadge && !cfg.hideParticipants) {
          const badgeBmp = getBadgeBitmap(p.username, p.avatarId, p.isSelf, dpr);
          const badgeW = badgeBmp.width / dpr;
          const badgeH = badgeBmp.height / dpr;
          const badgeScale = Math.min(1, 0.84 + 0.16 * popT);
          ctx.save();
          ctx.translate(0, Math.round(emojiH * 0.36 * scale + 10));
          ctx.scale(badgeScale, badgeScale);
          ctx.drawImage(badgeBmp, -badgeW / 2, -badgeH / 2, badgeW, badgeH);
          ctx.restore();
        }

        ctx.save();
        ctx.translate(0, -6);
        ctx.rotate(tilt);
        ctx.scale(scale, scale);
        ctx.drawImage(emojiBmp, -emojiW / 2, -emojiH / 2, emojiW, emojiH);
        ctx.restore();

        ctx.restore();
      }

      if (particles.length > 0) {
        rafId = window.requestAnimationFrame(renderFrame);
      } else {
        rafId = 0;
      }
    };

    const unsub = subscribeReactions(spawnParticle, () => {
      particles.length = 0;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    });

    return () => {
      unsub();
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="fixed inset-0 z-[42] pointer-events-none w-full h-full"
      />
      {/* Hidden SVG source cache for crisp 1:1 ProfileAvatar rasterization into canvas bitmaps */}
      <div
        aria-hidden="true"
        className="fixed -left-[9999px] -top-[9999px] w-0 h-0 overflow-hidden opacity-0 pointer-events-none"
      >
        {AVATAR_PRESETS.filter((p) => requestedAvatars.includes(p.id)).map((preset) => (
          <span
            key={preset.id}
            ref={(el) => {
              avatarDomRefs.current[preset.id] = el;
            }}
          >
            <ProfileAvatar avatarId={preset.id} size={48} />
          </span>
        ))}
      </div>
    </>
  );
});
