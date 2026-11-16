export interface TimelineTransform {
  offsetSecs: number;
  scale: number;
}

export interface TimelineSegment {
  roomStartSecs: number;
  offsetSecs: number;
  scale: number;
  holdRoomUntilSecs?: number | null;
}

export interface FpsPreset {
  id: "normal" | "pal_to_ntsc" | "ntsc_to_pal" | "film_to_ntsc";
  label: string;
  shortLabel: string;
  scale: number;
}

const NTSC_FILM = 24000 / 1001;

export const FPS_PRESETS: readonly FpsPreset[] = [
  { id: "normal", label: "1×", shortLabel: "Normal (1×)", scale: 1.0 },
  {
    id: "pal_to_ntsc",
    label: "25→23.976",
    shortLabel: "25 → 23.976 fps",
    scale: NTSC_FILM / 25,
  },
  {
    id: "ntsc_to_pal",
    label: "23.976→25",
    shortLabel: "23.976 → 25 fps",
    scale: 25 / NTSC_FILM,
  },
  {
    id: "film_to_ntsc",
    label: "24→23.976",
    shortLabel: "24 → 23.976 fps",
    scale: NTSC_FILM / 24,
  },
];

export function sanitizeTimelineTransform(tx: Partial<TimelineTransform>): TimelineTransform {
  const offset =
    typeof tx.offsetSecs === "number" && Number.isFinite(tx.offsetSecs)
      ? Math.max(-3600, Math.min(3600, tx.offsetSecs))
      : 0;
  const scale =
    typeof tx.scale === "number" && Number.isFinite(tx.scale) && tx.scale > 0
      ? Math.max(0.5, Math.min(2.0, tx.scale))
      : 1.0;
  return { offsetSecs: offset, scale };
}

export function isIdentityTransform(tx: TimelineTransform): boolean {
  return Math.abs(tx.offsetSecs) < 0.01 && Math.abs(tx.scale - 1.0) < 0.0001;
}

export function localToRoomSecs(
  localSecs: number,
  offsetSecs = 0,
  scale = 1,
  segments?: readonly TimelineSegment[],
): number {
  if (!Number.isFinite(localSecs) || localSecs < 0) return 0;
  if (segments && segments.length > 1) {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.holdRoomUntilSecs !== undefined && seg.holdRoomUntilSecs !== null) continue;
      const segScale = Number.isFinite(seg.scale) && seg.scale > 0 ? seg.scale : 1;
      const mapped = (localSecs - seg.offsetSecs) / segScale;
      const nextStart = segments[i + 1]?.roomStartSecs ?? Number.POSITIVE_INFINITY;
      if (mapped >= seg.roomStartSecs - 0.75 && mapped <= nextStart + 0.75) {
        return Math.max(0, mapped);
      }
    }
  }
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safeOffset = Number.isFinite(offsetSecs) ? offsetSecs : 0;
  return Math.max(0, (localSecs - safeOffset) / safeScale);
}

export function roomToLocalSecs(
  roomSecs: number,
  offsetSecs = 0,
  scale = 1,
): number {
  if (!Number.isFinite(roomSecs) || roomSecs < 0) return 0;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safeOffset = Number.isFinite(offsetSecs) ? offsetSecs : 0;
  return Math.max(0, roomSecs * safeScale + safeOffset);
}

export function findMatchingFpsPreset(scale: number): FpsPreset | null {
  if (!Number.isFinite(scale)) return null;
  for (const preset of FPS_PRESETS) {
    if (Math.abs(scale - preset.scale) <= 0.0002) {
      return preset;
    }
  }
  return null;
}

export function formatSignedOffset(secs: number): string {
  if (!Number.isFinite(secs) || Math.abs(secs) < 0.05) {
    return "0.0s";
  }
  const sign = secs >= 0 ? "+" : "−";
  const abs = Math.abs(secs);
  if (abs >= 60) {
    const mins = Math.floor(abs / 60);
    const rem = abs - mins * 60;
    return `${sign}${mins}m ${rem.toFixed(1)}s`;
  }
  return `${sign}${abs.toFixed(1)}s`;
}

export interface SceneAnchor {
  roomSecs: number;
  localSecs: number;
}

export function fitTwoPointAlignment(
  a: SceneAnchor,
  b: SceneAnchor,
): (TimelineTransform & { snappedLabel: string }) | null {
  if (
    ![a.roomSecs, a.localSecs, b.roomSecs, b.localSecs].every(
      (v) => Number.isFinite(v) && v >= 0,
    )
  ) {
    return null;
  }
  const [p1, p2] = a.roomSecs <= b.roomSecs ? [a, b] : [b, a];
  const dr = p2.roomSecs - p1.roomSecs;
  const dl = p2.localSecs - p1.localSecs;
  if (dr < 30 || dl <= 0) {
    return null;
  }
  const rawScale = dl / dr;
  if (rawScale < 0.9 || rawScale > 1.12) {
    return null;
  }

  const candidates: Array<{ scale: number; tol: number; label: string }> = [
    { scale: 1.0, tol: 0.0012, label: "Normal (1×)" },
    { scale: NTSC_FILM / 25, tol: 0.002, label: "25 → 23.976 fps" },
    { scale: 25 / NTSC_FILM, tol: 0.002, label: "23.976 → 25 fps" },
    { scale: 24 / 25, tol: 0.002, label: "25 → 24 fps" },
    { scale: 25 / 24, tol: 0.002, label: "24 → 25 fps" },
    { scale: NTSC_FILM / 24, tol: 0.0004, label: "24 → 23.976 fps" },
    { scale: 24 / NTSC_FILM, tol: 0.0004, label: "23.976 → 24 fps" },
  ];

  let snappedScale = 1.0;
  let snappedLabel = "Normal (1×)";
  let bestDist = Number.POSITIVE_INFINITY;
  for (const cand of candidates) {
    const dist = Math.abs(rawScale - cand.scale);
    if (dist <= cand.tol && dist < bestDist) {
      bestDist = dist;
      snappedScale = cand.scale;
      snappedLabel = cand.label;
    }
  }

  const offsetSecs =
    (p1.localSecs - snappedScale * p1.roomSecs + (p2.localSecs - snappedScale * p2.roomSecs)) * 0.5;
  const clean = sanitizeTimelineTransform({ offsetSecs, scale: snappedScale });
  return {
    ...clean,
    snappedLabel,
  };
}

const ALIGNMENT_STORAGE_KEY = "ep.sourceAlignments.v1";
const MAX_SAVED_ALIGNMENTS = 64;

interface SavedAlignmentEntry {
  offsetSecs: number;
  scale: number;
  updatedAt: number;
}

export function buildAlignmentPairKey(
  localFileName: string | null | undefined,
  localDurationSecs: number,
  peerFileName: string | null | undefined,
  peerDurationSecs: number | null | undefined,
): string | null {
  const localClean = localFileName?.trim().toLowerCase();
  const peerClean = peerFileName?.trim().toLowerCase();
  if (!localClean || !peerClean) return null;
  const ld = Number.isFinite(localDurationSecs) && localDurationSecs > 0 ? Math.round(localDurationSecs) : 0;
  const pd =
    typeof peerDurationSecs === "number" && Number.isFinite(peerDurationSecs) && peerDurationSecs > 0
      ? Math.round(peerDurationSecs)
      : 0;
  if (ld <= 0 || pd <= 0) return null;
  return `${localClean}|${ld}::${peerClean}|${pd}`;
}

function readAlignmentMap(): Record<string, SavedAlignmentEntry> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(ALIGNMENT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, SavedAlignmentEntry>;
  } catch {
    return {};
  }
}

function writeAlignmentMap(map: Record<string, SavedAlignmentEntry>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ALIGNMENT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write restrictions
  }
}

export function loadSavedSourceAlignment(pairKey: string | null): TimelineTransform | null {
  if (!pairKey) return null;
  const map = readAlignmentMap();
  const entry = map[pairKey];
  if (!entry) return null;
  const clean = sanitizeTimelineTransform(entry);
  if (isIdentityTransform(clean)) return null;
  return clean;
}

export function saveSourceAlignment(pairKey: string | null, tx: TimelineTransform): void {
  if (!pairKey) return;
  const clean = sanitizeTimelineTransform(tx);
  const map = readAlignmentMap();
  if (isIdentityTransform(clean)) {
    if (pairKey in map) {
      delete map[pairKey];
      writeAlignmentMap(map);
    }
    return;
  }
  map[pairKey] = {
    offsetSecs: clean.offsetSecs,
    scale: clean.scale,
    updatedAt: Date.now(),
  };
  const keys = Object.keys(map);
  if (keys.length > MAX_SAVED_ALIGNMENTS) {
    keys.sort((a, b) => (map[a]?.updatedAt ?? 0) - (map[b]?.updatedAt ?? 0));
    for (const oldKey of keys.slice(0, keys.length - MAX_SAVED_ALIGNMENTS)) {
      delete map[oldKey];
    }
  }
  writeAlignmentMap(map);
}
