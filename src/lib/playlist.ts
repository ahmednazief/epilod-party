import { isDesktop, safeInvoke } from "./bridge";
import { classifyDroppedFile, getFileDisplayName } from "./fileDrop";

export interface EpisodeCode {
  season: number | null;
  episode: number;
}

export interface PlaylistItem {
  path: string;
  fileName: string;
  cleanTitle: string;
  season: number | null;
  episode: number | null;
  episodeBadge: string | null;
  subtitlePath: string | null;
}

export interface MediaScanResult {
  items: PlaylistItem[];
  activeIndex: number;
  folderName: string | null;
  looseSubtitlePath: string | null;
}

function stripExt(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx > 0) return fileName.slice(0, idx);
  return fileName;
}

/**
 * Matches Rust `epilod_core::syncplay::hash_filename` (first 6 bytes of SHA-256 of UTF-8 stem).
 */
export function hashFilenameForMatch(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").trim();
  const stem = stripExt(base);
  const bytes = new TextEncoder().encode(stem);

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const outBytes = new Uint8Array(6);
  const hView = new DataView(new ArrayBuffer(8));
  hView.setUint32(0, h0, false);
  hView.setUint32(4, h1, false);
  const full = new Uint8Array(hView.buffer);
  outBytes.set(full.subarray(0, 6));
  return Array.from(outBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parseEpisodeCode(fileName: string): EpisodeCode | null {
  const stem = stripExt(fileName);

  // 1. S01E02 / s1e2 / S01.E02 / S01_E02 / S01-E02
  const seMatch = stem.match(/(?:^|[^a-z0-9])s(\d{1,2})[\s._-]*e(\d{1,3})(?:$|[^a-z0-9])/i);
  if (seMatch) {
    const season = Number(seMatch[1]);
    const episode = Number(seMatch[2]);
    if (episode > 0) {
      return { season, episode };
    }
  }

  // 2. 1x02 / 01x02 (reject resolutions such as 1920x1080 or 1280x720)
  const xMatch = stem.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?:$|[^a-z0-9])/i);
  if (xMatch) {
    const season = Number(xMatch[1]);
    const episode = Number(xMatch[2]);
    if (season <= 30 && episode > 0 && episode <= 300) {
      return { season, episode };
    }
  }

  const seasonMatch = stem.match(/(?:^|[^a-z0-9])season[\s._-]*(\d{1,2})(?:$|[^a-z0-9])/i);
  const parsedSeason = seasonMatch ? Number(seasonMatch[1]) : null;

  // 3. Episode 02 / Ep 02 / E02
  const epMatch = stem.match(/(?:^|[^a-z0-9])(?:episode|ep|e)[\s._-]*(\d{1,3})(?:$|[^a-z0-9])/i);
  if (epMatch) {
    const episode = Number(epMatch[1]);
    if (episode > 0 && episode <= 400) {
      return { season: parsedSeason, episode };
    }
  }

  // 4. Anime naming: "Title - 02 ..."
  const dashMatch = stem.match(/.+?\s+-\s+(\d{1,3})(?=$|\s|\[|\(|\.|_|v)/i);
  if (dashMatch) {
    const episode = Number(dashMatch[1]);
    if (episode > 0 && episode <= 400) {
      return { season: parsedSeason, episode };
    }
  }

  return null;
}

export function formatEpisodeBadge(code: EpisodeCode): string {
  const ep = String(code.episode).padStart(2, "0");
  if (code.season !== null) {
    return `S${String(code.season).padStart(2, "0")}E${ep}`;
  }
  return `EP ${ep}`;
}

export function cleanEpisodeTitle(fileName: string): string {
  const stem = stripExt(fileName).trim();
  const spaced = stem.includes(" ") ? stem.replaceAll("_", " ") : stem.replaceAll(/[._]/g, " ");
  const stripped = spaced
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || stem;
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function buildClientPlaylistFromPaths(rawPaths: readonly string[]): MediaScanResult {
  const videos: string[] = [];
  const subtitles: string[] = [];

  for (const raw of rawPaths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const kind = classifyDroppedFile(trimmed);
    if (kind === "video" && !videos.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      videos.push(trimmed);
    } else if (
      kind === "subtitle" &&
      !subtitles.some((s) => s.toLowerCase() === trimmed.toLowerCase())
    ) {
      subtitles.push(trimmed);
    }
  }

  const enriched = videos.map((videoPath) => {
    const fileName = getFileDisplayName(videoPath);
    const code = parseEpisodeCode(fileName);
    const videoStem = stripExt(fileName).toLowerCase();

    let pairedSub: string | null = null;
    let bestScore = 0;
    for (const subPath of subtitles) {
      const subName = getFileDisplayName(subPath);
      const subStem = stripExt(subName).toLowerCase();
      let score = 0;
      if (subStem === videoStem) score = 100;
      else if (videoStem && subStem.startsWith(videoStem)) score = 85;
      else if (videoStem && subStem.includes(videoStem)) score = 60;
      else if (code) {
        const subCode = parseEpisodeCode(subName);
        if (
          subCode &&
          subCode.episode === code.episode &&
          (code.season === null || subCode.season === null || code.season === subCode.season)
        ) {
          score = 50;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        pairedSub = subPath;
      }
    }

    return {
      code,
      item: {
        path: videoPath,
        fileName,
        cleanTitle: cleanEpisodeTitle(fileName),
        season: code ? code.season : null,
        episode: code ? code.episode : null,
        episodeBadge: code ? formatEpisodeBadge(code) : null,
        subtitlePath: pairedSub,
      } satisfies PlaylistItem,
    };
  });

  enriched.sort((a, b) => {
    const sa = a.code?.season ?? Number.MAX_SAFE_INTEGER;
    const sb = b.code?.season ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const ea = a.code?.episode ?? Number.MAX_SAFE_INTEGER;
    const eb = b.code?.episode ?? Number.MAX_SAFE_INTEGER;
    if (ea !== eb) return ea - eb;
    return naturalCompare(a.item.fileName, b.item.fileName);
  });

  const items = enriched.map((e) => e.item);
  let looseSubtitlePath: string | null = null;
  if (items.length === 1 && subtitles.length > 0) {
    looseSubtitlePath = items[0].subtitlePath ?? subtitles[0];
    if (!items[0].subtitlePath) {
      items[0].subtitlePath = looseSubtitlePath;
    }
  } else if (items.length === 0 && subtitles.length > 0) {
    looseSubtitlePath = subtitles[0];
  } else if (items.length > 0) {
    looseSubtitlePath = items[0].subtitlePath;
  }

  return {
    items,
    activeIndex: 0,
    folderName: null,
    looseSubtitlePath,
  };
}

export async function scanMediaPaths(paths: readonly string[]): Promise<MediaScanResult> {
  const cleanPaths = paths.map((p) => p.trim()).filter(Boolean);
  if (cleanPaths.length === 0) {
    return {
      items: [],
      activeIndex: 0,
      folderName: null,
      looseSubtitlePath: null,
    };
  }
  if (!isDesktop()) {
    return buildClientPlaylistFromPaths(cleanPaths);
  }
  return safeInvoke<MediaScanResult>("scan_media_paths", { paths: cleanPaths });
}

export function matchPeerEpisodeInPlaylist(
  peerFileName: string | null | undefined,
  items: readonly PlaylistItem[],
): number {
  const raw = peerFileName?.trim();
  if (!raw || items.length === 0) {
    return -1;
  }

  const peerBase = getFileDisplayName(raw).toLowerCase();
  const peerStem = stripExt(peerBase);

  // 1. Exact filename match
  const exactIdx = items.findIndex((it) => it.fileName.toLowerCase() === peerBase);
  if (exactIdx !== -1) return exactIdx;

  // 2. Stem match (e.g. .mkv vs .mp4)
  const stemIdx = items.findIndex((it) => stripExt(it.fileName.toLowerCase()) === peerStem);
  if (stemIdx !== -1) return stemIdx;

  // 3. Privacy-hashed 12-char SHA-256 hex filename match
  if (/^[a-f0-9]{12}$/i.test(peerBase)) {
    const hashIdx = items.findIndex((it) => hashFilenameForMatch(it.fileName) === peerBase);
    if (hashIdx !== -1) return hashIdx;
  }

  // 4. Episode code match (S01E03 == Episode 3 of same season or season-agnostic)
  const peerCode = parseEpisodeCode(raw);
  if (peerCode) {
    const exactSeasonIdx = items.findIndex(
      (it) =>
        it.episode === peerCode.episode &&
        (peerCode.season === null || it.season === null || it.season === peerCode.season),
    );
    if (exactSeasonIdx !== -1) return exactSeasonIdx;
  }

  return -1;
}
