import { useEffect, useRef, type RefObject } from "react";
import {
  getLastCapturedBackdropFrame,
  mpvBackdropFrame,
  type MpvBackdropFrame,
} from "../lib/mpv";
import { useAppStore } from "../store/useAppStore";

interface VideoGlassBackdropProps {
  active: boolean;
  visible: boolean;
  playing: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  layoutKey: string;
  pausedRefreshKey?: string;
}

const CAPTURE_INTERVAL_MS = 55;
const LAYOUT_TRACK_MS = 460;
const CAPTURE_W = 360;
const CAPTURE_H = 202;

interface RegionPlacement {
  z: number;
  alpha: number;
}

function computeRegionPlacement(el: HTMLElement): RegionPlacement {
  let z = 0;
  let alpha = 1;
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.documentElement) {
    const s = window.getComputedStyle(cur);
    if (s.display === "none" || s.visibility === "hidden") {
      return { z, alpha: 0 };
    }
    const parsedOpacity = Number.parseFloat(s.opacity);
    if (Number.isFinite(parsedOpacity)) {
      alpha *= Math.min(1, Math.max(0, parsedOpacity));
      if (alpha <= 0.01) {
        return { z, alpha: 0 };
      }
    }
    const zStr = s.zIndex;
    if (zStr && zStr !== "auto") {
      const parsed = Number.parseInt(zStr, 10);
      if (Number.isFinite(parsed)) {
        z += parsed;
      }
    }
    cur = cur.parentElement;
  }
  return { z, alpha };
}

interface ActiveBounds {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  meanLuma: number;
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
 * and estimates average scene luminance so glass surfaces keep rich ambient film
 * light and steady contrast without washing out or turning solid black.
 */
function detectActiveFrameBounds(rgba: Uint8ClampedArray, fw: number, fh: number): ActiveBounds {
  const stepX = Math.max(1, Math.floor(fw / 40));
  const stepY = Math.max(1, Math.floor(fh / 30));
  const rowHasPicture = (y: number): boolean => {
    for (let x = 0; x < fw; x += stepX) {
      const i = (y * fw + x) * 4;
      if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 14) return true;
    }
    return false;
  };
  const colHasPicture = (x: number, yStart: number, yEnd: number): boolean => {
    for (let y = yStart; y <= yEnd; y += stepY) {
      const i = (y * fw + x) * 4;
      if (rgba[i] + rgba[i + 1] + rgba[i + 2] > 14) return true;
    }
    return false;
  };

  let top = 0;
  while (top < fh - 1 && !rowHasPicture(top)) top++;
  let bottom = fh - 1;
  while (bottom > top && !rowHasPicture(bottom)) bottom--;

  let left = 0;
  while (left < fw - 1 && !colHasPicture(left, top, bottom)) left++;
  let right = fw - 1;
  while (right > left && !colHasPicture(right, top, bottom)) right--;

  let lumaSum = 0;
  let lumaCount = 0;
  for (let y = top; y <= bottom; y += stepY * 2) {
    for (let x = left; x <= right; x += stepX * 2) {
      const i = (y * fw + x) * 4;
      lumaSum += (rgba[i] * 0.2126 + rgba[i + 1] * 0.7152 + rgba[i + 2] * 0.0722) / 255;
      lumaCount++;
    }
  }
  const meanLuma = lumaCount > 0 ? Math.min(1, Math.max(0, lumaSum / lumaCount)) : 0.22;

  if (right - left < fw * 0.25 || bottom - top < fh * 0.25) {
    return { minU: 0, maxU: 1, minV: 0, maxV: 1, meanLuma };
  }

  return {
    minU: Math.min(0.22, (left + 1) / fw),
    maxU: Math.max(0.78, (right - 1) / fw),
    minV: Math.min(0.22, (top + 1) / fh),
    maxV: Math.max(0.78, (bottom - 1) / fh),
    meanLuma,
  };
}

const VERT_SHADER_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
uniform vec2 u_canvasSize;
uniform vec4 u_rect;
out vec2 v_localPx;
out vec2 v_screenPx;

void main() {
  v_localPx = a_pos * u_rect.zw;
  v_screenPx = u_rect.xy + v_localPx;
  vec2 ndc = (v_screenPx / u_canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

const FRAG_SHADER_SRC = `#version 300 es
precision highp float;

in vec2 v_localPx;
in vec2 v_screenPx;

uniform sampler2D u_texCurr;
uniform sampler2D u_texPrev;
uniform float u_frameBlend;
uniform vec4 u_rect;
uniform vec4 u_radii;
uniform vec4 u_viewport;
uniform vec4 u_activeBox;
uniform vec2 u_mouse;
uniform float u_alpha;
uniform float u_isSheet;
uniform float u_isPlaybar;
uniform float u_playbarOpacity;
uniform float u_sceneLuma;

out vec4 outColor;

vec2 foldActiveUv(vec2 rawUv) {
  float minU = u_activeBox.x;
  float maxU = u_activeBox.y;
  float minV = u_activeBox.z;
  float maxV = u_activeBox.w;
  float u = rawUv.x < minU
    ? min(maxU, minU + min(0.06, minU - rawUv.x))
    : (rawUv.x > maxU ? max(minU, maxU - min(0.06, rawUv.x - maxU)) : rawUv.x);
  float v = rawUv.y < minV
    ? min(maxV, minV + min(0.06, minV - rawUv.y))
    : (rawUv.y > maxV ? max(minV, maxV - min(0.06, rawUv.y - maxV)) : rawUv.y);
  return clamp(vec2(u, v), vec2(0.001), vec2(0.999));
}

vec3 sampleVideo(vec2 screenPx) {
  vec2 rawUv = (screenPx - u_viewport.xy) / max(u_viewport.zw, vec2(1.0));
  vec2 uv = foldActiveUv(rawUv);
  vec3 c1 = texture(u_texCurr, uv).rgb;
  if (u_frameBlend >= 0.999) {
    return c1;
  }
  vec3 c0 = texture(u_texPrev, uv).rgb;
  return mix(c0, c1, u_frameBlend);
}

// 13-tap golden-angle Vogel disk blur in screen-pixel space
vec3 sampleBlurredVideo(vec2 centerPx, float radiusPx, vec2 chromaShiftPx) {
  const vec2 OFFSETS[12] = vec2[12](
    vec2(0.288, 0.000),
    vec2(-0.300, 0.275),
    vec2(0.052, -0.497),
    vec2(0.415, 0.402),
    vec2(-0.625, -0.078),
    vec2(0.391, -0.576),
    vec2(0.118, 0.742),
    vec2(-0.631, 0.491),
    vec2(0.818, -0.205),
    vec2(-0.295, -0.840),
    vec2(-0.562, -0.748),
    vec2(0.752, 0.592)
  );

  vec3 acc = sampleVideo(centerPx) * 1.45;
  float wSum = 1.45;

  for (int i = 0; i < 12; i++) {
    float ringW = 1.0 - float(i) * 0.045;
    vec2 off = OFFSETS[i] * radiusPx;
    if (dot(chromaShiftPx, chromaShiftPx) > 0.04 && i < 6) {
      float r = sampleVideo(centerPx + off + chromaShiftPx).r;
      float g = sampleVideo(centerPx + off).g;
      float b = sampleVideo(centerPx + off - chromaShiftPx).b;
      acc += vec3(r, g, b) * ringW;
    } else {
      acc += sampleVideo(centerPx + off) * ringW;
    }
    wSum += ringW;
  }
  return acc / wSum;
}

void main() {
  vec2 halfSize = u_rect.zw * 0.5;
  vec2 rel = v_localPx - halfSize;
  float cornerRad = rel.x > 0.0
    ? (rel.y > 0.0 ? u_radii.z : u_radii.y)
    : (rel.y > 0.0 ? u_radii.w : u_radii.x);
  float rad = min(cornerRad, min(halfSize.x, halfSize.y));
  vec2 box = max(vec2(0.0), halfSize - vec2(rad));
  vec2 q = abs(rel) - box;
  vec2 outside = max(q, vec2(0.0));
  float sdf = length(outside) + min(max(q.x, q.y), 0.0) - rad;

  // Hardware-adaptive anti-aliased outer boundary (smooth across 1x..2.5x DPI)
  float aa = max(0.75, fwidth(sdf) * 0.95);
  float edgeMask = 1.0 - smoothstep(-aa, aa, sdf);
  if (edgeMask <= 0.002) {
    discard;
  }

  float distInside = max(0.0, -sdf);
  float minDim = min(u_rect.z, u_rect.w);

  // Sculptural curved bezel profile confined to the rounded rim (no inner square contour)
  float p = clamp(u_playbarOpacity, 0.0, 1.0);
  float solidDampen = clamp((p - 0.6) / 0.4, 0.0, 1.0);
  float bezelThickness = u_isPlaybar > 0.5
    ? clamp(minDim * 0.14, 7.0, 11.0)
    : (u_isSheet > 0.5
        ? clamp(minDim * 0.042, 6.5, 10.5)
        : clamp(minDim * 0.18, 5.0, 10.0));
  float bezelRad = rad < 0.5
    ? 0.0
    : min(min(halfSize.x, halfSize.y), max(rad, bezelThickness * 2.2));
  vec2 bezelBox = max(vec2(0.0), halfSize - vec2(bezelRad));
  vec2 bezelQ = abs(rel) - bezelBox;
  vec2 bezelOutside = max(bezelQ, vec2(0.0));
  float bezelSdf = length(bezelOutside) + min(max(bezelQ.x, bezelQ.y), 0.0) - bezelRad;
  float bezelDist = max(0.0, -bezelSdf);

  // C1-continuous outward unit normal across straight edges and rounded corners
  vec2 grad = length(bezelOutside) > 1e-4
    ? normalize(bezelOutside)
    : (bezelQ.x > bezelQ.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 sgn = vec2(rel.x >= 0.0 ? 1.0 : -1.0, rel.y >= 0.0 ? 1.0 : -1.0);
  vec2 normal = grad * sgn;

  // C2-continuous quintic falloff (zero 1st & 2nd derivative at inner bezel boundary)
  float bezelT = clamp(1.0 - bezelDist / bezelThickness, 0.0, 1.0);
  float lensCurve = bezelT * bezelT * bezelT * (10.0 - 15.0 * bezelT + 6.0 * bezelT * bezelT);
  float rimPower = bezelT * bezelT * bezelT;

  // Convex bezel refraction bends background inward along -normal + gentle dome magnification
  // (Menus tuned to 90% strength; play bar balanced at ~72%)
  float surfaceScale = u_isPlaybar > 0.5
    ? (0.72 * (1.0 - solidDampen * 0.65))
    : (u_isSheet > 0.5 ? 0.90 : 1.0);
  float refractStrength = min(16.0, bezelThickness * 1.25) * surfaceScale;
  vec2 bezelShift = -normal * (lensCurve * refractStrength);
  float domeFactor = u_isPlaybar > 0.5
    ? (0.006 * (1.0 - solidDampen * 0.7))
    : (u_isSheet > 0.5 ? 0.0108 : 0.018);
  vec2 domeShift = -rel * domeFactor;
  vec2 sampleCenterPx = v_screenPx + bezelShift + domeShift;

  // Prismatic RGB chromatic dispersion confined to the outer curved glass rim
  float chromaScale = u_isPlaybar > 0.5
    ? (0.68 * (1.0 - solidDampen * 0.65))
    : (u_isSheet > 0.5 ? 0.90 : 1.0);
  vec2 chromaShiftPx = normal * (rimPower * clamp(bezelThickness * 0.22, 1.2, 3.2) * chromaScale);

  // Smooth C2 dual-zone blur: menus use a slightly deeper 18px frosted interior (90% glass intensity)
  float interiorBlur = u_isPlaybar > 0.5 ? 17.5 : (u_isSheet > 0.5 ? 18.0 : 11.0);
  float rimBlur = u_isPlaybar > 0.5 ? 3.8 : (u_isSheet > 0.5 ? 4.0 : 2.2);
  float blurRadiusPx = mix(interiorBlur, rimBlur, lensCurve);

  vec3 glassRgb = sampleBlurredVideo(sampleCenterPx, blurRadiusPx, chromaShiftPx);

  // Vibrant midtone saturation + soft-knee highlight compression
  float luma = dot(glassRgb, vec3(0.2126, 0.7152, 0.0722));
  float satBoost = u_isPlaybar > 0.5 ? 1.26 : (u_isSheet > 0.5 ? 1.28 : 1.34);
  vec3 vibrant = clamp(mix(vec3(luma), glassRgb, satBoost), 0.0, 1.0);
  vec3 toneMapped = vibrant / (1.0 + max(0.0, luma - 0.26) * 1.10);

  // Uniform dark-crystal interior with a 2px transparent refractive glass rim at the outer edge
  vec3 obsidianTint = vec3(0.039, 0.042, 0.062);
  float defaultPlaybarScrim = mix(0.48, 0.58, u_sceneLuma);
  float playbarScrim = p < 0.6
    ? mix(0.12, defaultPlaybarScrim, p / 0.6)
    : mix(defaultPlaybarScrim, 0.93, (p - 0.6) / 0.4);
  float baseScrim = u_isPlaybar > 0.5
    ? playbarScrim
    : (u_isSheet > 0.5
        ? mix(0.60, 0.70, u_sceneLuma)
        : mix(0.32, 0.44, u_sceneLuma));
  float rimTranslucency = exp(-distInside * 0.95) * (u_isPlaybar > 0.5 ? (0.85 * (1.0 - solidDampen * 0.6)) : (u_isSheet > 0.5 ? 0.90 : 1.0));
  float effectiveScrim = baseScrim * (1.0 - rimTranslucency * 0.42);
  vec3 bodyColor = mix(toneMapped, obsidianTint, effectiveScrim);

  // 3D Fresnel refractive glass rim stroke + cursor-reactive rim light seated right at the AA edge (no dark outer border)
  float rimEnvelope = smoothstep(-aa * 0.45, max(0.65, aa * 0.85), distInside);
  float outerRim = exp(-distInside * 1.15) * rimEnvelope;
  float crispEdge = exp(-pow(max(0.0, distInside - 0.35) / 0.85, 2.0)) * rimEnvelope;
  float keyLight = max(0.0, dot(normal, normalize(vec2(-0.58, -0.81))));
  float bounceLight = max(0.0, dot(normal, normalize(vec2(0.55, 0.83))));

  vec2 toMouse = v_screenPx - u_mouse;
  float mouseDist = length(toMouse);
  vec2 mouseDir = toMouse / max(mouseDist, 1.0);
  float mouseRim = exp(-mouseDist / 240.0) * max(0.0, dot(normal, -mouseDir));

  float rimScale = u_isPlaybar > 0.5
    ? (0.78 * (1.0 - solidDampen * 0.55))
    : (u_isSheet > 0.5 ? 0.90 : 1.0);
  float specStrength =
    (outerRim * (0.06 + 0.30 * pow(keyLight, 1.55) + 0.14 * pow(bounceLight, 1.95) + 0.24 * mouseRim) +
     crispEdge * (0.10 + 0.18 * keyLight + 0.08 * bounceLight)) * rimScale;

  // Scene-adaptive refractive glass stroke: blends boosted film color with directional crystal specular
  vec3 rimFilmColor = clamp(vibrant * 1.42 + vec3(0.16), 0.0, 1.0);
  vec3 specBase = mix(vec3(0.96, 0.97, 1.0), vec3(0.84, 0.78, 1.0), bounceLight * 0.45);
  vec3 specColor = mix(rimFilmColor, specBase, 0.46);
  vec3 finalRgb = clamp(bodyColor + specColor * specStrength, 0.0, 1.0);

  float playbarAlpha = p < 0.6
    ? mix(0.38, 0.92, p / 0.6)
    : mix(0.92, 0.98, (p - 0.6) / 0.4);
  float targetAlpha = u_isPlaybar > 0.5 ? playbarAlpha : 0.94;
  float finalAlpha = clamp(targetAlpha * u_alpha * edgeMask, 0.0, 1.0);
  outColor = vec4(finalRgb * finalAlpha, finalAlpha);
}
`;

interface WebGlGlassContext {
  gl: WebGL2RenderingContext;
  shaderSrc: string;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  texCurr: WebGLTexture;
  texPrev: WebGLTexture;
  uCanvasSize: WebGLUniformLocation | null;
  uRect: WebGLUniformLocation | null;
  uRadii: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uActiveBox: WebGLUniformLocation | null;
  uMouse: WebGLUniformLocation | null;
  uAlpha: WebGLUniformLocation | null;
  uIsSheet: WebGLUniformLocation | null;
  uIsPlaybar: WebGLUniformLocation | null;
  uPlaybarOpacity: WebGLUniformLocation | null;
  uSceneLuma: WebGLUniformLocation | null;
  uFrameBlend: WebGLUniformLocation | null;
  uTexCurr: WebGLUniformLocation | null;
  uTexPrev: WebGLUniformLocation | null;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createVideoTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function initWebGlGlass(canvas: HTMLCanvasElement): WebGlGlassContext | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
  } catch {
    return null;
  }
  if (!gl) return null;

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SHADER_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SHADER_SRC);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) return null;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const texCurr = createVideoTexture(gl);
  const texPrev = createVideoTexture(gl);
  if (!texCurr || !texPrev) {
    if (texCurr) gl.deleteTexture(texCurr);
    if (texPrev) gl.deleteTexture(texPrev);
    gl.deleteBuffer(vbo);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    return null;
  }

  return {
    gl,
    shaderSrc: FRAG_SHADER_SRC,
    program,
    vao,
    vbo,
    texCurr,
    texPrev,
    uCanvasSize: gl.getUniformLocation(program, "u_canvasSize"),
    uRect: gl.getUniformLocation(program, "u_rect"),
    uRadii: gl.getUniformLocation(program, "u_radii"),
    uViewport: gl.getUniformLocation(program, "u_viewport"),
    uActiveBox: gl.getUniformLocation(program, "u_activeBox"),
    uMouse: gl.getUniformLocation(program, "u_mouse"),
    uAlpha: gl.getUniformLocation(program, "u_alpha"),
    uIsSheet: gl.getUniformLocation(program, "u_isSheet"),
    uIsPlaybar: gl.getUniformLocation(program, "u_isPlaybar"),
    uPlaybarOpacity: gl.getUniformLocation(program, "u_playbarOpacity"),
    uSceneLuma: gl.getUniformLocation(program, "u_sceneLuma"),
    uFrameBlend: gl.getUniformLocation(program, "u_frameBlend"),
    uTexCurr: gl.getUniformLocation(program, "u_texCurr"),
    uTexPrev: gl.getUniformLocation(program, "u_texPrev"),
  };
}

function destroyWebGlGlass(wgl: WebGlGlassContext | null): void {
  if (!wgl) return;
  try {
    const { gl } = wgl;
    gl.deleteTexture(wgl.texCurr);
    gl.deleteTexture(wgl.texPrev);
    gl.deleteBuffer(wgl.vbo);
    gl.deleteVertexArray(wgl.vao);
    gl.deleteProgram(wgl.program);
  } catch {
    // Ignore GL cleanup errors if context was already torn down.
  }
}

/**
 * Real-time WebGL2 Cinema Liquid Glass backdrop renderer.
 * Samples live video frames behind `[data-glass-region]` surfaces with dual-zone
 * frosted interior blur, Snell's-law convex bezel refraction, prismatic RGB
 * chromatic dispersion, cursor-reactive Fresnel rim highlights, and temporally
 * smoothed luminance contrast (with an automatic 2D Canvas fallback).
 */
export function VideoGlassBackdrop({
  active,
  visible,
  playing,
  viewportRef,
  layoutKey,
  pausedRefreshKey = "",
}: VideoGlassBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglRef = useRef<WebGlGlassContext | null>(null);
  const webglCheckedRef = useRef(false);
  const regionScratchRef = useRef<HTMLCanvasElement | null>(null);
  const latestFrameRef = useRef<MpvBackdropFrame | null>(null);
  const activeBoxRef = useRef<ActiveBounds>({
    minU: 0,
    maxU: 1,
    minV: 0,
    maxV: 1,
    meanLuma: 0.22,
  });
  const smoothedLumaRef = useRef(0.22);
  const prevMeanLumaRef = useRef(0.22);
  const sceneCutRef = useRef(true);
  const hasPrevTexRef = useRef(false);
  const mousePosRef = useRef<{ x: number; y: number }>({ x: -9999, y: -9999 });
  const playBarOpacity = useAppStore((s) => s.playBarOpacity);
  const playBarOpacityRef = useRef(playBarOpacity);
  playBarOpacityRef.current = playBarOpacity;

  const ensureWebGlContext = (canvas: HTMLCanvasElement): WebGlGlassContext | null => {
    const needsReinit =
      !webglCheckedRef.current ||
      (webglRef.current !== null &&
        (webglRef.current.shaderSrc !== FRAG_SHADER_SRC ||
          webglRef.current.gl.canvas !== canvas));
    if (needsReinit) {
      if (webglRef.current) {
        destroyWebGlGlass(webglRef.current);
        webglRef.current = null;
        hasPrevTexRef.current = false;
      }
      webglCheckedRef.current = true;
      webglRef.current = initWebGlGlass(canvas);
    }
    return webglRef.current;
  };

  const uploadFrameToWebGl = (frame: MpvBackdropFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wgl = ensureWebGlContext(canvas);
    const rgba = frame.rgba;
    if (!wgl || !rgba || frame.width <= 0 || frame.height <= 0) return;

    const nextLuma = activeBoxRef.current.meanLuma;
    sceneCutRef.current =
      !hasPrevTexRef.current || Math.abs(nextLuma - prevMeanLumaRef.current) > 0.18;
    prevMeanLumaRef.current = nextLuma;

    const { gl } = wgl;
    if (hasPrevTexRef.current) {
      const tmp = wgl.texPrev;
      wgl.texPrev = wgl.texCurr;
      wgl.texCurr = tmp;
    }
    gl.bindTexture(gl.TEXTURE_2D, wgl.texCurr);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      frame.width,
      frame.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    );
    if (!hasPrevTexRef.current) {
      gl.bindTexture(gl.TEXTURE_2D, wgl.texPrev);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        frame.width,
        frame.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        rgba,
      );
      hasPrevTexRef.current = true;
    }
  };

  const paintRegionsRef = useRef<() => void>(() => {});

  paintRegionsRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const wglReady = ensureWebGlContext(canvas);
    if (wglReady && !hasPrevTexRef.current && latestFrameRef.current) {
      uploadFrameToWebGl(latestFrameRef.current);
    }

    const w = Math.max(1, Math.round(window.innerWidth));
    const h = Math.max(1, Math.round(window.innerHeight));
    const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    const frame = latestFrameRef.current;
    const frameRgba = frame?.rgba;
    const wgl = webglRef.current;

    if (!active || !visible || !frame || !frameRgba) {
      if (typeof document !== "undefined") {
        delete document.documentElement.dataset.webglGlass;
      }
      if (wgl) {
        wgl.gl.viewport(0, 0, pw, ph);
        wgl.gl.clearColor(0, 0, 0, 0);
        wgl.gl.clear(wgl.gl.COLOR_BUFFER_BIT);
      } else {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, h);
        }
      }
      return;
    }

    const regions = Array.from(document.querySelectorAll<HTMLElement>("[data-glass-region]")).filter(
      (el) => !el.closest(".ep-scrubber"),
    );
    if (regions.length === 0) {
      if (typeof document !== "undefined") {
        delete document.documentElement.dataset.webglGlass;
      }
      if (wgl) {
        wgl.gl.viewport(0, 0, pw, ph);
        wgl.gl.clearColor(0, 0, 0, 0);
        wgl.gl.clear(wgl.gl.COLOR_BUFFER_BIT);
      }
      return;
    }

    const sortedRegions = regions
      .map((el, index) => {
        const placement = computeRegionPlacement(el);
        return { el, index, z: placement.z, alpha: placement.alpha };
      })
      .filter((item) => item.alpha > 0.01)
      .sort((a, b) => (a.z !== b.z ? a.z - b.z : a.index - b.index));

    const vpRect = viewportRef.current?.getBoundingClientRect();
    const dx = vpRect ? vpRect.left : 0;
    const dy = vpRect ? vpRect.top : 0;
    const dw = vpRect && vpRect.width > 0 ? vpRect.width : w;
    const dh = vpRect && vpRect.height > 0 ? vpRect.height : h;

    const activeBox = activeBoxRef.current;
    smoothedLumaRef.current += (activeBox.meanLuma - smoothedLumaRef.current) * 0.14;

    if (wgl && hasPrevTexRef.current) {
      if (typeof document !== "undefined") {
        document.documentElement.dataset.webglGlass = "active";
      }
      const { gl } = wgl;
      gl.viewport(0, 0, pw, ph);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(wgl.program);
      gl.bindVertexArray(wgl.vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, wgl.texCurr);
      gl.uniform1i(wgl.uTexCurr, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, wgl.texPrev);
      gl.uniform1i(wgl.uTexPrev, 1);

      const frameBlend = !playing || sceneCutRef.current ? 1.0 : 0.78;

      gl.uniform2f(wgl.uCanvasSize, w, h);
      gl.uniform4f(wgl.uViewport, dx, dy, dw, dh);
      gl.uniform4f(wgl.uActiveBox, activeBox.minU, activeBox.maxU, activeBox.minV, activeBox.maxV);
      gl.uniform2f(wgl.uMouse, mousePosRef.current.x, mousePosRef.current.y);
      gl.uniform1f(wgl.uSceneLuma, smoothedLumaRef.current);
      gl.uniform1f(wgl.uFrameBlend, frameBlend);
      gl.uniform1f(
        wgl.uPlaybarOpacity,
        Math.min(1, Math.max(0, playBarOpacityRef.current / 100)),
      );

      sortedRegions.forEach(({ el, alpha: regionAlpha }) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const style = window.getComputedStyle(el);
        const maxRad = Math.min(r.width / 2, r.height / 2);
        const clampRad = (raw: string) => {
          const v = Number.parseFloat(raw);
          return Number.isFinite(v) ? Math.max(0, Math.min(v, maxRad)) : 0;
        };
        const radTl = clampRad(style.borderTopLeftRadius);
        const radTr = clampRad(style.borderTopRightRadius);
        const radBr = clampRad(style.borderBottomRightRadius);
        const radBl = clampRad(style.borderBottomLeftRadius);
        const isPlaybar =
          el.dataset.capsuleBar === "true" || el.classList.contains("ep-glass-bottom-bar")
            ? 1.0
            : 0.0;
        const isSheet =
          isPlaybar < 0.5 &&
          (el.classList.contains("ep-glass-sheet") ||
            el.classList.contains("ep-context-menu") ||
            el.classList.contains("ep-glass-reaction-sheet") ||
            (r.width >= 220 && r.height >= 120))
            ? 1.0
            : 0.0;

        gl.uniform4f(wgl.uRect, r.left, r.top, r.width, r.height);
        gl.uniform4f(wgl.uRadii, radTl, radTr, radBr, radBl);
        gl.uniform1f(wgl.uAlpha, regionAlpha);
        gl.uniform1f(wgl.uIsSheet, isSheet);
        gl.uniform1f(wgl.uIsPlaybar, isPlaybar);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      });

      gl.bindVertexArray(null);
      return;
    }

    // 2D Canvas fallback when WebGL2 is unavailable
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let scratch = regionScratchRef.current;
    if (!scratch) {
      scratch = document.createElement("canvas");
      regionScratchRef.current = scratch;
    }
    const scratchCtx = scratch.getContext("2d");
    if (!scratchCtx) return;

    sortedRegions.forEach(({ el, alpha: regionAlpha }) => {
      const style = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;

      const parsedRadius = Number.parseFloat(style.borderTopLeftRadius);
      const radius = Number.isFinite(parsedRadius)
        ? Math.max(0, Math.min(parsedRadius, r.width / 2, r.height / 2))
        : 0;

      const rw = Math.max(48, Math.min(360, Math.round(r.width * 0.85)));
      const rh = Math.max(36, Math.min(260, Math.round(r.height * 0.85)));
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
      const refractStrength = Math.min(18, bezelThickness * 0.9, Math.min(r.width, r.height) * 0.28);

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
          const u =
            rawU < activeBox.minU
              ? Math.min(activeBox.maxU, activeBox.minU + Math.min(0.06, activeBox.minU - rawU))
              : rawU > activeBox.maxU
                ? Math.max(activeBox.minU, activeBox.maxU - Math.min(0.06, rawU - activeBox.maxU))
                : rawU;
          const v =
            rawV < activeBox.minV
              ? Math.min(activeBox.maxV, activeBox.minV + Math.min(0.06, activeBox.minV - rawV))
              : rawV > activeBox.maxV
                ? Math.max(activeBox.minV, activeBox.maxV - Math.min(0.06, rawV - activeBox.maxV))
                : rawV;

          const [rr, gg, bb] = sampleBilinear(frameRgba, frame.width, frame.height, u, v);
          const idx = (py * rw + px) * 4;
          out[idx] = rr;
          out[idx + 1] = gg;
          out[idx + 2] = bb;
          out[idx + 3] = 255;
        }
      }

      scratchCtx.putImageData(img, 0, 0);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(r.left, r.top, r.width, r.height, radius);
      ctx.clip();
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = regionAlpha;
      ctx.fillStyle = "#000";
      ctx.fillRect(r.left - 1, r.top - 1, r.width + 2, r.height + 2);
      ctx.restore();

      const bleed = 4;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(r.left, r.top, r.width, r.height, radius);
      ctx.clip();
      ctx.globalAlpha = 0.92 * regionAlpha;
      ctx.filter = "blur(1.5px)";
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

  const captureInFlightRef = useRef(false);
  const captureQueuedRef = useRef(false);
  const isPausedCaptureActiveRef = useRef(false);
  const lastPausedKeyRef = useRef<string | number | undefined>(pausedRefreshKey);
  const requestPausedCaptureRef = useRef<(forceSettledPass?: boolean) => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const onContextLost = (e: Event) => {
      e.preventDefault();
      webglRef.current = null;
      hasPrevTexRef.current = false;
      if (typeof document !== "undefined") {
        delete document.documentElement.dataset.webglGlass;
      }
    };
    const onContextRestored = () => {
      webglCheckedRef.current = false;
      hasPrevTexRef.current = false;
      if (latestFrameRef.current) {
        uploadFrameToWebGl(latestFrameRef.current);
      }
      paintRegionsRef.current();
    };
    if (canvas) {
      canvas.addEventListener("webglcontextlost", onContextLost);
      canvas.addEventListener("webglcontextrestored", onContextRestored);
    }
    return () => {
      if (canvas) {
        canvas.removeEventListener("webglcontextlost", onContextLost);
        canvas.removeEventListener("webglcontextrestored", onContextRestored);
      }
      destroyWebGlGlass(webglRef.current);
      webglRef.current = null;
      webglCheckedRef.current = false;
      hasPrevTexRef.current = false;
      if (typeof document !== "undefined") {
        delete document.documentElement.dataset.webglGlass;
      }
    };
  }, []);

  useEffect(() => {
    let pointerRaf = 0;
    let wasNearGlass = false;
    const isNearAnyGlassRegion = (x: number, y: number): boolean => {
      const pad = 260;
      const els = document.querySelectorAll<HTMLElement>("[data-glass-region]");
      for (const el of els) {
        if (el.closest(".ep-scrubber")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (
          x >= r.left - pad &&
          x <= r.right + pad &&
          y >= r.top - pad &&
          y <= r.bottom + pad
        ) {
          return true;
        }
      }
      return false;
    };
    const onPointerMove = (e: PointerEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
      if (!active || !visible || !latestFrameRef.current || pointerRaf) return;
      const nearNow = isNearAnyGlassRegion(e.clientX, e.clientY);
      if (!nearNow && !wasNearGlass) return;
      wasNearGlass = nearNow;
      pointerRaf = window.requestAnimationFrame(() => {
        pointerRaf = 0;
        paintRegionsRef.current();
      });
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      if (pointerRaf) window.cancelAnimationFrame(pointerRaf);
      window.removeEventListener("pointermove", onPointerMove);
      if (typeof document !== "undefined") {
        delete document.documentElement.dataset.webglGlass;
      }
    };
  }, [active, visible]);

  useEffect(() => {
    if (active && visible && latestFrameRef.current) {
      paintRegionsRef.current();
    }
  }, [active, visible, playBarOpacity]);

  useEffect(() => {
    isPausedCaptureActiveRef.current = active && visible && !playing;
    captureQueuedRef.current = false;

    if (!active || !visible) {
      requestPausedCaptureRef.current = () => undefined;
      if (!active) {
        latestFrameRef.current = null;
        hasPrevTexRef.current = false;
      }
      paintRegionsRef.current();
      return;
    }

    if (!latestFrameRef.current) {
      const cached = getLastCapturedBackdropFrame();
      if (cached && cached.rgba) {
        latestFrameRef.current = cached;
        activeBoxRef.current = detectActiveFrameBounds(cached.rgba, cached.width, cached.height);
        uploadFrameToWebGl(cached);
        paintRegionsRef.current();
      }
    }

    let cancelled = false;
    let loopTimer: number | null = null;
    let retryTimer: number | null = null;
    let settleTimer: number | null = null;
    const PAUSED_RETRY_DELAYS = [110, 260, 480];

    const pullOnce = async (): Promise<boolean> => {
      if (cancelled || document.hidden) return false;
      if (!document.querySelector("[data-glass-region]")) return false;
      if (captureInFlightRef.current) {
        captureQueuedRef.current = true;
        return false;
      }
      captureInFlightRef.current = true;
      try {
        const frame = await mpvBackdropFrame(CAPTURE_W, CAPTURE_H);
        if (!cancelled && frame && frame.rgba) {
          latestFrameRef.current = frame;
          activeBoxRef.current = detectActiveFrameBounds(frame.rgba, frame.width, frame.height);
          uploadFrameToWebGl(frame);
          paintRegionsRef.current();
          return true;
        }
        return false;
      } catch {
        return false;
      } finally {
        captureInFlightRef.current = false;
        if (!cancelled && captureQueuedRef.current) {
          captureQueuedRef.current = false;
          void pullOnce();
        }
      }
    };

    const schedulePausedRetries = (attempt = 0) => {
      if (cancelled || playing || attempt >= PAUSED_RETRY_DELAYS.length) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(async () => {
        retryTimer = null;
        if (cancelled || playing) return;
        const ok = await pullOnce();
        if (!ok && !cancelled && !playing) {
          schedulePausedRetries(attempt + 1);
        }
      }, PAUSED_RETRY_DELAYS[attempt]);
    };

    const requestPausedCapture = (forceSettledPass = false) => {
      if (cancelled || playing) return;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
      void pullOnce().then((ok) => {
        if (cancelled || playing) return;
        if (!ok) {
          schedulePausedRetries(0);
        } else if (forceSettledPass) {
          settleTimer = window.setTimeout(() => {
            settleTimer = null;
            if (!cancelled && !playing) {
              void pullOnce();
            }
          }, 220);
        }
      });
    };

    requestPausedCaptureRef.current = requestPausedCapture;

    const scheduleLoop = () => {
      if (cancelled || !playing) return;
      loopTimer = window.setTimeout(async () => {
        await pullOnce();
        scheduleLoop();
      }, CAPTURE_INTERVAL_MS);
    };

    void pullOnce().then((ok) => {
      if (cancelled) return;
      if (playing) {
        scheduleLoop();
      } else {
        if (!ok) {
          schedulePausedRetries(0);
        } else {
          settleTimer = window.setTimeout(() => {
            settleTimer = null;
            if (!cancelled && !playing) {
              void pullOnce();
            }
          }, 95);
        }
      }
    });

    const handleVisibility = () => {
      if (!document.hidden && !cancelled) {
        if (playing) {
          void pullOnce();
        } else {
          requestPausedCapture(true);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      requestPausedCaptureRef.current = () => undefined;
      if (loopTimer !== null) window.clearTimeout(loopTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active, visible, playing]);

  useEffect(() => {
    if (lastPausedKeyRef.current === pausedRefreshKey) return;
    lastPausedKeyRef.current = pausedRefreshKey;
    if (!active || !visible || playing) return;
    const timerId = window.setTimeout(() => {
      if (!document.hidden) {
        requestPausedCaptureRef.current(false);
      }
    }, 55);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [active, visible, playing, pausedRefreshKey]);

  useEffect(() => {
    if (!active || !visible) {
      paintRegionsRef.current();
      return;
    }

    let rafId = 0;
    let trackUntil = performance.now() + LAYOUT_TRACK_MS;

    const tick = (now: number) => {
      paintRegionsRef.current();
      if (now < trackUntil) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    };

    const triggerTrack = () => {
      trackUntil = Math.max(trackUntil, performance.now() + LAYOUT_TRACK_MS);
      if (!rafId) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const resizeObs =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(triggerTrack) : null;
    const syncObservedRegions = () => {
      if (!resizeObs) return;
      resizeObs.disconnect();
      document.querySelectorAll<HTMLElement>("[data-glass-region]").forEach((el) => {
        resizeObs.observe(el);
      });
    };

    const nodeHasGlassRegion = (node: Node): boolean => {
      if (!(node instanceof HTMLElement)) return false;
      return (
        node.hasAttribute("data-glass-region") ||
        node.querySelector("[data-glass-region]") !== null
      );
    };

    const mutationObs =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            let needsResync = false;
            let needsRepaint = false;
            for (const rec of records) {
              if (rec.type === "attributes") {
                if (rec.attributeName === "data-glass-region") {
                  needsResync = true;
                  needsRepaint = true;
                } else if (nodeHasGlassRegion(rec.target)) {
                  needsRepaint = true;
                }
              } else {
                for (const node of rec.addedNodes) {
                  if (nodeHasGlassRegion(node)) {
                    needsResync = true;
                    needsRepaint = true;
                  }
                }
                for (const node of rec.removedNodes) {
                  if (nodeHasGlassRegion(node)) {
                    needsResync = true;
                    needsRepaint = true;
                  }
                }
              }
            }
            if (needsResync) syncObservedRegions();
            if (needsRepaint) triggerTrack();
          })
        : null;

    syncObservedRegions();
    mutationObs?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-glass-region",
        "data-open",
        "data-active",
        "data-morphing",
        "aria-checked",
        "aria-selected",
        "aria-expanded",
        "style",
      ],
    });

    triggerTrack();

    let resizeCaptureTimer: number | null = null;
    const onResize = () => {
      triggerTrack();
      if (!isPausedCaptureActiveRef.current) return;
      if (resizeCaptureTimer !== null) window.clearTimeout(resizeCaptureTimer);
      resizeCaptureTimer = window.setTimeout(() => {
        resizeCaptureTimer = null;
        if (isPausedCaptureActiveRef.current) {
          requestPausedCaptureRef.current(true);
        }
      }, 110);
    };
    const onVisibility = () => {
      if (document.hidden) return;
      triggerTrack();
      if (isPausedCaptureActiveRef.current) {
        requestPausedCaptureRef.current(true);
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", triggerTrack, { capture: true, passive: true });
    window.addEventListener("ep:glass-layout", triggerTrack);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObs?.disconnect();
      mutationObs?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", triggerTrack, true);
      window.removeEventListener("ep:glass-layout", triggerTrack);
      document.removeEventListener("visibilitychange", onVisibility);
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
