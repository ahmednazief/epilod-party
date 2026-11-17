import type { MpvTrack, SubtitleLangProbeTrack } from "./mpv";

export interface TrackOption {
  value: string;
  label: string;
  track: MpvTrack | null;
}

export interface SubtitleTrackDisplay {
  label: string;
  metaTags: string[];
}

/**
 * Format a subtitle track's human-facing primary label and badge tags uniformly across
 * the subtitle panel, right-click menu, and OSD feedback.
 * Falls back to FFmpeg-detected language for untagged text tracks and `"Closed Captions"`
 * for untagged EIA-608/CEA-708 streams.
 */
const INTERNAL_TEMP_SUB_RE = /^(?:decoded|embedded|autosync|epilod_synced|synced)_\d+_/i;

export function formatSubtitleTrackDisplay(
  track: MpvTrack,
  options?: { detectedLang?: string | null; externalFileName?: string | null },
): SubtitleTrackDisplay {
  const rawTitle = track.title?.trim() || null;
  const cleanTitle =
    rawTitle && !(track.external && INTERNAL_TEMP_SUB_RE.test(rawTitle)) ? rawTitle : null;
  const tagLang = normalizeSubtitleLang(track.lang);
  const detectedLangCode =
    !tagLang && !track.external && options?.detectedLang
      ? normalizeSubtitleLang(options.detectedLang)
      : null;
  const displayLang = tagLang
    ? track.lang!.trim().toUpperCase()
    : detectedLangCode
      ? detectedLangCode.toUpperCase()
      : null;

  const label =
    cleanTitle ||
    (track.external
      ? options?.externalFileName || "External Subtitles"
      : displayLang
        ? `${displayLang} Subtitles`
        : isClosedCaptionTrack(track)
          ? "Closed Captions"
          : `Subtitle ${track.id}`);

  const metaTags: string[] = [];
  if (cleanTitle && displayLang) {
    metaTags.push(displayLang);
  }
  if (track.external) {
    metaTags.push("External");
  } else {
    if (detectedLangCode) {
      metaTags.push("Detected");
    }
    if (track.codec?.trim()) {
      metaTags.push(track.codec.trim().toUpperCase());
    }
  }
  return { label, metaTags };
}

export function formatTrackLabel(track: MpvTrack, detectedLang?: string | null): string {
  if (track.type === "sub") {
    const { label, metaTags } = formatSubtitleTrackDisplay(track, { detectedLang });
    return metaTags.length > 0 ? `${label} · ${metaTags.join(" · ")}` : label;
  }
  const parts: string[] = [];
  if (track.title && track.title.trim()) {
    parts.push(track.title.trim());
  }
  if (track.lang && track.lang.trim()) {
    parts.push(track.lang.trim().toUpperCase());
  }
  if (parts.length === 0) {
    parts.push(`Track ${track.id}`);
  }
  if (track.external) {
    parts.push("External");
  } else if (track.codec && track.codec.trim()) {
    parts.push(track.codec.trim().toUpperCase());
  }
  return parts.join(" · ");
}

export function formatTrackAnnouncement(
  track: MpvTrack | null,
  kind: "audio" | "sub",
  detectedLang?: string | null,
): string {
  if (!track) {
    return kind === "sub" ? "Subtitles off" : "Audio track auto";
  }
  return `${kind === "sub" ? "Sub" : "Audio"}: ${formatTrackLabel(track, detectedLang)}`;
}

export function formatDelaySigned(delaySecs: number): string {
  const rounded = Math.round(delaySecs * 100) / 100;
  if (Math.abs(rounded) < 0.005) {
    return "+0.00s";
  }
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(2)}s`;
}

export function formatDelayLabel(delaySecs: number): string {
  const formatted = formatDelaySigned(delaySecs);
  return formatted === "+0.00s" ? "0.00s" : formatted;
}

export function formatTimingStatus(params: {
  delaySecs: number;
  hasTrack: boolean;
  isAutoSynced?: boolean;
}): string {
  if (!params.hasTrack) {
    return "No subtitle selected";
  }
  if (params.isAutoSynced) {
    return `Auto-synced (${formatDelaySigned(params.delaySecs)})`;
  }
  return `Delay ${formatDelaySigned(params.delaySecs)}`;
}

export function buildAudioTrackOptions(tracks: readonly MpvTrack[]): TrackOption[] {
  const audioTracks = tracks.filter((t) => t.type === "audio");
  return [
    { value: "none", label: "Off / None", track: null },
    ...audioTracks.map((t) => ({
      value: String(t.id),
      label: formatTrackLabel(t),
      track: t,
    })),
  ];
}

export function buildSubTrackOptions(tracks: readonly MpvTrack[]): TrackOption[] {
  const subTracks = tracks.filter((t) => t.type === "sub");
  return [
    { value: "none", label: "Off / None", track: null },
    ...subTracks.map((t) => ({
      value: String(t.id),
      label: formatTrackLabel(t),
      track: t,
    })),
  ];
}

export interface TrackSelectionHooks {
  mpvSetAudioTrack: (aid: number | null) => Promise<void>;
  mpvSetSubTrack: (sid: number | null) => Promise<void>;
  mpvSetSubDelay: (delaySecs: number) => Promise<void>;
  setDelaySecs: (delaySecs: number) => void;
  setSubtitleVisible?: (visible: boolean) => void;
  clearExternalTrackState?: () => void;
}

export async function selectAudioTrack(
  aid: number | null,
  hooks: Pick<TrackSelectionHooks, "mpvSetAudioTrack">,
): Promise<void> {
  await hooks.mpvSetAudioTrack(aid);
}

/**
 * Fix 24: Switching subtitle tracks cleanly resets stale sub-delay (and clears
 * external subtitle association when switching to an embedded track or Off).
 */
export async function selectSubTrack(
  sid: number | null,
  tracks: readonly MpvTrack[],
  hooks: Pick<
    TrackSelectionHooks,
    "mpvSetSubTrack" | "mpvSetSubDelay" | "setDelaySecs" | "setSubtitleVisible" | "clearExternalTrackState"
  >,
): Promise<void> {
  await hooks.mpvSetSubTrack(sid);
  await hooks.mpvSetSubDelay(0);
  hooks.setDelaySecs(0);
  if (sid === null) {
    hooks.setSubtitleVisible?.(false);
    hooks.clearExternalTrackState?.();
  } else {
    hooks.setSubtitleVisible?.(true);
    const chosen = tracks.find((t) => t.type === "sub" && t.id === sid);
    if (!chosen || !chosen.external) {
      hooks.clearExternalTrackState?.();
    }
  }
}

const SUB_LANG_ALIASES: Readonly<Record<string, string>> = {
  en: "eng",
  eng: "eng",
  english: "eng",
  ar: "ara",
  ara: "ara",
  arb: "ara",
  arabic: "ara",
  fr: "fra",
  fra: "fra",
  fre: "fra",
  french: "fra",
  es: "spa",
  spa: "spa",
  spanish: "spa",
  de: "deu",
  deu: "deu",
  ger: "deu",
  german: "deu",
  ja: "jpn",
  jpn: "jpn",
  japanese: "jpn",
  ko: "kor",
  kor: "kor",
  korean: "kor",
  zh: "zho",
  zho: "zho",
  chi: "zho",
  cmn: "zho",
  chinese: "zho",
  pt: "por",
  por: "por",
  pob: "por",
  portuguese: "por",
  it: "ita",
  ita: "ita",
  italian: "ita",
  ru: "rus",
  rus: "rus",
  russian: "rus",
  tr: "tur",
  tur: "tur",
  turkish: "tur",
  nl: "nld",
  nld: "nld",
  dut: "nld",
  dutch: "nld",
  pl: "pol",
  pol: "pol",
  polish: "pol",
  hi: "hin",
  hin: "hin",
  hindi: "hin",
  id: "ind",
  ind: "ind",
  indonesian: "ind",
  ms: "msa",
  msa: "msa",
  may: "msa",
  malay: "msa",
  vi: "vie",
  vie: "vie",
  vietnamese: "vie",
  th: "tha",
  tha: "tha",
  thai: "tha",
  fa: "fas",
  fas: "fas",
  per: "fas",
  persian: "fas",
  farsi: "fas",
  he: "heb",
  heb: "heb",
  iw: "heb",
  hebrew: "heb",
  el: "ell",
  ell: "ell",
  gre: "ell",
  greek: "ell",
  sv: "swe",
  swe: "swe",
  swedish: "swe",
  no: "nor",
  nor: "nor",
  nob: "nor",
  nno: "nor",
  norwegian: "nor",
  da: "dan",
  dan: "dan",
  danish: "dan",
  fi: "fin",
  fin: "fin",
  finnish: "fin",
  cs: "ces",
  ces: "ces",
  cze: "ces",
  czech: "ces",
  hu: "hun",
  hun: "hun",
  hungarian: "hun",
  ro: "ron",
  ron: "ron",
  rum: "ron",
  romanian: "ron",
  uk: "ukr",
  ukr: "ukr",
  ukrainian: "ukr",
  bg: "bul",
  bul: "bul",
  bulgarian: "bul",
  hr: "hrv",
  hrv: "hrv",
  croatian: "hrv",
  sr: "srp",
  srp: "srp",
  serbian: "srp",
  sk: "slk",
  slk: "slk",
  slo: "slk",
  slovak: "slk",
  sl: "slv",
  slv: "slv",
  slovenian: "slv",
  ca: "cat",
  cat: "cat",
  catalan: "cat",
  bn: "ben",
  ben: "ben",
  bengali: "ben",
  ur: "urd",
  urd: "urd",
  urdu: "urd",
  ta: "tam",
  tam: "tam",
  tamil: "tam",
  te: "tel",
  tel: "tel",
  telugu: "tel",
  tl: "fil",
  tgl: "fil",
  fil: "fil",
  tagalog: "fil",
  filipino: "fil",
};

const UNDETERMINED_LANGS = new Set(["und", "undetermined", "unknown", "none", "zxx", "mul"]);

const SUB_LANG_FULL_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SUB_LANG_ALIASES).filter(([k]) => k.length > 3),
);

/**
 * Normalize a subtitle language tag (ISO 639-1, 639-2/B, 639-2/T, BCP-47 with region,
 * or full English name) into a canonical lowercase key, or `null` when undetermined.
 */
export function normalizeSubtitleLang(lang?: string | null): string | null {
  if (!lang) return null;
  const cleaned = lang.trim().toLowerCase();
  if (!cleaned || UNDETERMINED_LANGS.has(cleaned)) return null;
  if (SUB_LANG_ALIASES[cleaned]) return SUB_LANG_ALIASES[cleaned];
  const base = cleaned.split(/[-_]/)[0];
  if (!base || UNDETERMINED_LANGS.has(base)) return null;
  return SUB_LANG_ALIASES[base] ?? base;
}

/** Return true when two subtitle language tags resolve to the same known language. */
export function languagesMatch(a?: string | null, b?: string | null): boolean {
  const na = normalizeSubtitleLang(a);
  const nb = normalizeSubtitleLang(b);
  return na !== null && nb !== null && na === nb;
}

function resolveTrackEffectiveLang(
  track: MpvTrack | null | undefined,
  detectedLang?: string | null,
): string | null {
  if (!track) return null;
  const fromTag = normalizeSubtitleLang(track.lang);
  if (fromTag) return fromTag;
  const title = track.title?.trim().toLowerCase();
  if (title) {
    for (const token of title.split(/[^a-z]+/)) {
      if (token && SUB_LANG_FULL_NAMES[token]) {
        return SUB_LANG_FULL_NAMES[token];
      }
    }
  }
  return normalizeSubtitleLang(detectedLang);
}

function getValidFfIndex(track: MpvTrack | null | undefined): number | null {
  if (!track) return null;
  const raw = track["ff-index"];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function getContainerEmbeddedSubs(tracks: readonly MpvTrack[]): MpvTrack[] {
  return tracks.filter(
    (t) =>
      t.type === "sub" &&
      !t.external &&
      !(isClosedCaptionTrack(t) && getValidFfIndex(t) === null),
  );
}

/**
 * Build the list of untagged embedded text subtitle tracks that need background cue-based
 * language detection (`SUBRIP`, `ASS`, `WEBVTT`, etc.). Skips image tracks and CC bitstreams.
 */
export function buildUntaggedSubtitleProbeList(
  tracks: readonly MpvTrack[],
): SubtitleLangProbeTrack[] {
  const containerSubs = getContainerEmbeddedSubs(tracks);
  const probes: SubtitleLangProbeTrack[] = [];
  for (let subStreamIdx = 0; subStreamIdx < containerSubs.length; subStreamIdx++) {
    const t = containerSubs[subStreamIdx];
    if (isBitmapSubtitleTrack(t) || isClosedCaptionTrack(t)) continue;
    if (resolveTrackEffectiveLang(t) !== null) continue;
    probes.push({
      trackId: t.id,
      ffIndex: getValidFfIndex(t),
      subStreamIdx,
      codec: t.codec ?? null,
    });
  }
  return probes;
}

export interface EmbeddedSyncTargetResolution {
  selectedSub: MpvTrack | null;
  subIsBitmap: boolean;
  fallbackEmbeddedSub: MpvTrack | null;
  syncTargetEmbedded: MpvTrack | null;
  isClosedCaption: boolean;
  ffIndex: number | null;
  embeddedSubIdx: number | null;
  crossLangBlocked: boolean;
}

/**
 * Resolve which embedded subtitle track should be extracted for Magic Sync.
 * Never falls back from an image subtitle (PGS/DVD) to a different language's text track.
 */
export function resolveEmbeddedSyncTarget(
  tracks: readonly MpvTrack[],
  detectedSubLangs?: Readonly<Record<number, string>>,
): EmbeddedSyncTargetResolution {
  const selectedSub = tracks.find((t) => t.type === "sub" && t.selected) ?? null;
  const subIsBitmap = isBitmapSubtitleTrack(selectedSub);

  if (!selectedSub || selectedSub.external) {
    return {
      selectedSub,
      subIsBitmap,
      fallbackEmbeddedSub: null,
      syncTargetEmbedded: null,
      isClosedCaption: false,
      ffIndex: null,
      embeddedSubIdx: null,
      crossLangBlocked: false,
    };
  }

  let fallbackEmbeddedSub: MpvTrack | null = null;
  let crossLangBlocked = false;

  if (subIsBitmap) {
    const embeddedTextSubs = tracks.filter(
      (t) => t.type === "sub" && !t.external && !isBitmapSubtitleTrack(t),
    );
    const trackLang = (t: MpvTrack) => resolveTrackEffectiveLang(t, detectedSubLangs?.[t.id]);
    const selLang = trackLang(selectedSub);
    if (selLang) {
      fallbackEmbeddedSub =
        embeddedTextSubs.find((t) => !isClosedCaptionTrack(t) && trackLang(t) === selLang) ??
        embeddedTextSubs.find((t) => trackLang(t) === selLang) ??
        null;
    } else {
      const selTitle = selectedSub.title?.trim().toLowerCase();
      fallbackEmbeddedSub =
        (selTitle
          ? embeddedTextSubs.find((t) => t.title?.trim().toLowerCase() === selTitle)
          : undefined) ??
        (embeddedTextSubs.length === 1 && !trackLang(embeddedTextSubs[0])
          ? embeddedTextSubs[0]
          : null);
    }
    // When no matching-language text track exists, Magic Sync falls through to align the bitmap
    // subtitle stream directly via packet timestamps + in-place mpv delay instead of cross-language
    // fallback.
    crossLangBlocked = false;
  }

  const syncTargetEmbedded = !subIsBitmap ? selectedSub : fallbackEmbeddedSub ?? selectedSub;
  const isClosedCaption = isClosedCaptionTrack(syncTargetEmbedded);

  let ffIndex: number | null = null;
  let embeddedSubIdx: number | null = null;
  if (syncTargetEmbedded) {
    ffIndex = isClosedCaption ? null : getValidFfIndex(syncTargetEmbedded);
    if (isClosedCaption) {
      embeddedSubIdx = 0;
    } else {
      const containerSubs = getContainerEmbeddedSubs(tracks);
      const idx = containerSubs.findIndex((t) => t.id === syncTargetEmbedded.id);
      embeddedSubIdx = idx >= 0 ? idx : null;
    }
  }

  return {
    selectedSub,
    subIsBitmap,
    fallbackEmbeddedSub,
    syncTargetEmbedded,
    isClosedCaption,
    ffIndex,
    embeddedSubIdx,
    crossLangBlocked,
  };
}

const BITMAP_SUB_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "pgssub",
  "dvd_subtitle",
  "dvdsub",
  "dvb_subtitle",
  "xsub",
]);

const CLOSED_CAPTION_CODECS = new Set(["eia_608", "cea_608", "cea_708", "cc_dec"]);

function trackHasCodec(track: MpvTrack | undefined | null, codecs: ReadonlySet<string>): boolean {
  if (!track || !track.codec) return false;
  return codecs.has(track.codec.trim().toLowerCase());
}

export function isBitmapSubtitleTrack(track: MpvTrack | undefined | null): boolean {
  return trackHasCodec(track, BITMAP_SUB_CODECS);
}

/**
 * Bitstream closed captions (CEA-608/708) live inside the video stream rather
 * than a separate container subtitle stream (`0:s:N`), so extraction uses
 * FFmpeg's `lavfi` `[out0+subcc]` output pad instead.
 */
export function isClosedCaptionTrack(track: MpvTrack | undefined | null): boolean {
  return trackHasCodec(track, CLOSED_CAPTION_CODECS);
}

/**
 * Parse a manual sync timestamp in plain seconds (`"872"`, `"12.5"`), `mm:ss` (`"14:32"`),
 * or `hh:mm:ss` (`"1:05:10.5"`) into non-negative seconds.
 */
export function parseFlexibleTimestampSecs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes(":")) {
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  }
  const parts = trimmed.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    const valid = i === parts.length - 1 ? /^\d+(\.\d+)?$/.test(p) : /^\d+$/.test(p);
    if (!valid) return null;
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (nums.length === 2) {
    const [m, s] = nums;
    return s < 60 ? m * 60 + s : null;
  }
  const [h, m, s] = nums;
  return m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
}

export function formatCompactClockSecs(secs: number): string {
  const safe = Number.isFinite(secs) && secs > 0 ? secs : 0;
  const tenths = Math.round(safe * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const sStr = frac > 0 ? `${String(s).padStart(2, "0")}.${frac}` : String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sStr}` : `${m}:${sStr}`;
}
