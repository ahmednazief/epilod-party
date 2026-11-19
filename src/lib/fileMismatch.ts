import { getFileDisplayName } from "./fileDrop";
import {
  formatDisplayMediaTitle,
  formatEpisodeBadge,
  matchPeerEpisodeInPlaylist,
  parseEpisodeCode,
  type PlaylistItem,
} from "./playlist";
import { formatSignedOffset } from "./sourceAlignment";
import type { Participant, SourceRelation } from "./syncplay";

export type PartyFileMismatchKind =
  | "notOpenOnPc"
  | "differentFile"
  | "durationMismatch"
  | "fpsMismatch";

export interface MatchedPlaylistTarget {
  index: number;
  label: string;
  title: string;
}

export interface PartyFileMismatch {
  kind: PartyFileMismatchKind;
  signature: string;
  title: string;
  message: string;
  deltaBadge: string | null;
  localChip: string | null;
  localChipTitle: string | null;
  peerChip: string | null;
  peerChipOwner: string | null;
  peerChipTitle: string | null;
  mismatchedUsernames: string[];
  matchedPlaylistItem: MatchedPlaylistTarget | null;
  sourceRelation: SourceRelation | null;
  suggestedFpsScale: number | null;
  suggestedFpsLabel: string | null;
  autoFixable: boolean;
  confidence: "high" | "low";
}

const KNOWN_FPS_VALUES = [23.976, 24, 25, 29.97] as const;

export function isKnownFpsRatio(scale: number | null | undefined): boolean {
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
    return false;
  }
  if (Math.abs(scale - 1) < 0.001) {
    return false;
  }
  for (const a of KNOWN_FPS_VALUES) {
    for (const b of KNOWN_FPS_VALUES) {
      if (a === b) continue;
      const ratio = a / b;
      if (Math.abs(scale - ratio) / ratio < 0.001) {
        return true;
      }
    }
  }
  return false;
}

export interface PartyFileMismatchInput {
  syncConnected: boolean;
  participants: readonly Participant[];
  localUsername: string;
  localLoaded: boolean;
  localFileName: string | null;
  localLoading?: boolean;
  hasPlayerError?: boolean;
  aligned?: boolean;
  scaleCalibrated?: boolean;
  playlistItems?: readonly PlaylistItem[];
  currentPlaylistIndex?: number;
}

export interface ReadableMediaName {
  label: string;
  isPrivate: boolean;
  badge: string | null;
}

export interface ParticipantMatchBadge {
  text: string;
  className: string;
  isMismatch: boolean;
}

export function isHashedFileName(rawName: string | null | undefined): boolean {
  const clean = rawName?.trim();
  if (!clean) return false;
  const base = getFileDisplayName(clean);
  return /^[a-f0-9]{12}$/i.test(base);
}

export function formatReadableMediaName(rawName: string | null | undefined): ReadableMediaName {
  const clean = rawName?.trim();
  if (!clean) {
    return { label: "", isPrivate: false, badge: null };
  }
  const baseName = getFileDisplayName(clean);
  if (isHashedFileName(baseName)) {
    return { label: "Private video", isPrivate: true, badge: null };
  }
  const code = parseEpisodeCode(baseName);
  const badge = code ? formatEpisodeBadge(code) : null;
  const disp = formatDisplayMediaTitle(baseName);

  let label: string;
  if (disp.subtitle && badge && disp.title) {
    label = `${disp.subtitle} · ${badge} — ${disp.title}`;
  } else if (disp.subtitle && disp.title) {
    label = `${disp.subtitle} — ${disp.title}`;
  } else if (disp.title && badge && !disp.title.toLowerCase().includes(badge.toLowerCase())) {
    label = `${disp.title} · ${badge}`;
  } else {
    label = disp.title || baseName;
  }

  return { label, isPrivate: false, badge };
}

export function formatDurationDelta(deltaSecs: number): string {
  const abs = Math.max(1, Math.round(Math.abs(deltaSecs)));
  if (abs < 60) {
    return `${abs}s`;
  }
  if (abs < 3600) {
    const mins = Math.floor(abs / 60);
    const secs = abs % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(abs / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatNameList(usernames: readonly string[]): string {
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const raw of usernames) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(trimmed);
  }
  if (clean.length === 0) return "A friend";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  if (clean.length === 3) return `${clean[0]}, ${clean[1]}, and ${clean[2]}`;
  const remaining = clean.length - 2;
  return `${clean[0]}, ${clean[1]}, and ${remaining} ${remaining === 1 ? "other" : "others"}`;
}

function findPlaylistMatch(
  peerFileName: string | null | undefined,
  playlistItems: readonly PlaylistItem[] | undefined,
  localFileName: string | null,
  currentPlaylistIndex?: number,
): MatchedPlaylistTarget | null {
  if (!peerFileName || !playlistItems || playlistItems.length === 0) {
    return null;
  }
  const idx = matchPeerEpisodeInPlaylist(peerFileName, playlistItems);
  if (idx < 0 || idx >= playlistItems.length) {
    return null;
  }
  if (typeof currentPlaylistIndex === "number" && idx === currentPlaylistIndex) {
    return null;
  }
  const target = playlistItems[idx];
  const localBase = localFileName ? getFileDisplayName(localFileName).toLowerCase() : null;
  if (localBase && target.fileName.toLowerCase() === localBase) {
    return null;
  }
  return {
    index: idx,
    label: target.episodeBadge || target.cleanTitle,
    title: target.cleanTitle,
  };
}

function isPeerUnresolvedMismatch(
  peer: Participant,
  aligned: boolean,
  scaleCalibrated: boolean,
): boolean {
  if (peer.fileMatch === "differentFile") {
    return true;
  }
  if (peer.fileMatch !== "durationMismatch") {
    return false;
  }
  if (peer.sourceRelation === "fpsMismatch") {
    return !scaleCalibrated;
  }
  if (peer.sourceRelation === "differentCut") {
    return !aligned;
  }
  return true;
}

function pickPrimaryMismatchPeer(peers: readonly Participant[]): Participant {
  return (
    peers.find((p) => p.isController && p.fileMatch === "differentFile") ??
    peers.find((p) => p.isController) ??
    peers.find((p) => p.fileMatch === "differentFile") ??
    peers[0]
  );
}

/**
 * Classifies whether Watch Party peers have a video open that is not open on the local PC,
 * or whether the local PC has a different video / cut / frame rate open than peers.
 */
export function analyzePartyFileMismatch(
  input: PartyFileMismatchInput,
): PartyFileMismatch | null {
  if (!input.syncConnected || input.participants.length === 0) {
    return null;
  }

  const localHasFile =
    input.localLoaded && !input.hasPlayerError && Boolean(input.localFileName?.trim());

  // Suppress false "not open on your PC" warnings while a local file is actively loading.
  if (
    !localHasFile &&
    input.localLoading &&
    Boolean(input.localFileName?.trim()) &&
    !input.hasPlayerError
  ) {
    return null;
  }

  const localKey = input.localUsername.trim().toLowerCase();
  const remotePeersWithFile = input.participants.filter(
    (p) => p.username.trim().toLowerCase() !== localKey && Boolean(p.fileName?.trim()),
  );
  if (remotePeersWithFile.length === 0) {
    return null;
  }

  if (!localHasFile) {
    const primary = remotePeersWithFile.find((p) => p.isController) ?? remotePeersWithFile[0];
    const primaryInfo = formatReadableMediaName(primary.fileName);
    const peerNames = remotePeersWithFile.map((p) => p.username);
    const namesLabel = formatNameList(peerNames);
    const allShareSameTitle =
      !primaryInfo.isPrivate &&
      remotePeersWithFile.every(
        (p) =>
          formatReadableMediaName(p.fileName).label.toLowerCase() ===
          primaryInfo.label.toLowerCase(),
      );

    let message: string;
    if (remotePeersWithFile.length === 1) {
      message = primaryInfo.isPrivate
        ? `${primary.username} has a video open that isn't open on your PC.`
        : `${primary.username} opened “${primaryInfo.label}”, which isn't open on your PC.`;
    } else if (allShareSameTitle) {
      message = `${namesLabel} have “${primaryInfo.label}” open, which isn't open on your PC.`;
    } else {
      message = `${namesLabel} have videos open that aren't open on your PC.`;
    }

    const peerSig = remotePeersWithFile
      .map((p) => `${p.username.trim().toLowerCase()}:${(p.fileName ?? "").trim().toLowerCase()}`)
      .sort()
      .join(",");

    return {
      kind: "notOpenOnPc",
      signature: `notOpen|${peerSig}`,
      title: "Video not open on your PC",
      message,
      deltaBadge: null,
      localChip: null,
      localChipTitle: null,
      peerChip: null,
      peerChipOwner: null,
      peerChipTitle: null,
      mismatchedUsernames: peerNames,
      matchedPlaylistItem: findPlaylistMatch(primary.fileName, input.playlistItems, null),
      sourceRelation: primary.sourceRelation ?? null,
      suggestedFpsScale: null,
      suggestedFpsLabel: null,
      autoFixable: false,
      confidence: "low",
    };
  }

  const aligned = Boolean(input.aligned);
  const scaleCalibrated = Boolean(input.scaleCalibrated);
  const mismatched = remotePeersWithFile.filter((p) =>
    isPeerUnresolvedMismatch(p, aligned, scaleCalibrated),
  );
  if (mismatched.length === 0) {
    return null;
  }

  const primary = pickPrimaryMismatchPeer(mismatched);
  const localInfo = formatReadableMediaName(input.localFileName);
  const primaryInfo = formatReadableMediaName(primary.fileName);
  const mismatchedNames = mismatched.map((p) => p.username);

  const isDifferentMedia =
    primary.fileMatch === "differentFile" || primary.sourceRelation === "differentMedia";

  let kind: PartyFileMismatchKind;
  let title: string;
  let message: string;
  let deltaBadge: string | null = null;

  if (isDifferentMedia) {
    kind = "differentFile";
    title = "Different video open";
    if (mismatched.length === 1) {
      message = primaryInfo.isPrivate
        ? `You have “${localInfo.label}” open on your PC, which doesn't match ${primary.username}'s video.`
        : `You have “${localInfo.label}” open on your PC, while ${primary.username} opened “${primaryInfo.label}”.`;
    } else {
      message = `${formatNameList(mismatchedNames)} opened a different video than your “${localInfo.label}”.`;
    }
  } else {
    const rawDelta = primary.durationDeltaSecs;
    const hasDelta =
      typeof rawDelta === "number" && Number.isFinite(rawDelta) && Math.abs(rawDelta) >= 1;
    const deltaText = hasDelta ? formatDurationDelta(rawDelta) : null;
    if (hasDelta) {
      deltaBadge = `${rawDelta >= 0 ? "+" : "−"}${formatDurationDelta(rawDelta)}`;
    }

    if (primary.sourceRelation === "fpsMismatch") {
      kind = "fpsMismatch";
      title = "Different frame rate or speed";
      const fpsHint = primary.suggestedFpsLabel ? ` (${primary.suggestedFpsLabel})` : "";
      message = deltaText
        ? `Your “${localInfo.label}” differs by ${deltaText} from ${primary.username}'s copy${fpsHint} — playback may drift.`
        : `Your “${localInfo.label}” uses a different frame rate${fpsHint} than ${primary.username}'s copy.`;
    } else {
      kind = "durationMismatch";
      title = "Different cut or video length";
      message = deltaText
        ? `Your “${localInfo.label}” differs by ${deltaText} from ${primary.username}'s copy — scenes may not line up.`
        : `Your “${localInfo.label}” has a different length than ${primary.username}'s copy.`;
    }
  }

  const peerSig = mismatched
    .map(
      (p) =>
        `${p.username.trim().toLowerCase()}:${(p.fileName ?? "").trim().toLowerCase()}:${p.fileMatch}:${p.sourceRelation ?? ""}`,
    )
    .sort()
    .join(",");

  const localBase = input.localFileName ? getFileDisplayName(input.localFileName) : null;

  const suggestedFpsScale =
    kind === "fpsMismatch" && typeof primary.suggestedFpsScale === "number"
      ? primary.suggestedFpsScale
      : null;
  const highConfidenceFps = kind === "fpsMismatch" && isKnownFpsRatio(suggestedFpsScale);

  return {
    kind,
    signature: `${kind}|${(localBase ?? "").toLowerCase()}|${peerSig}`,
    title,
    message,
    deltaBadge,
    localChip: localInfo.label || localBase,
    localChipTitle: localBase,
    peerChip: primaryInfo.isPrivate ? "Private video" : primaryInfo.label,
    peerChipOwner: primary.username,
    peerChipTitle: primaryInfo.isPrivate
      ? "Title hidden by privacy setting"
      : primary.fileName
        ? getFileDisplayName(primary.fileName)
        : null,
    mismatchedUsernames: mismatchedNames,
    matchedPlaylistItem: findPlaylistMatch(
      primary.fileName,
      input.playlistItems,
      input.localFileName,
      input.currentPlaylistIndex,
    ),
    sourceRelation: primary.sourceRelation ?? null,
    suggestedFpsScale,
    suggestedFpsLabel: kind === "fpsMismatch" ? (primary.suggestedFpsLabel ?? null) : null,
    autoFixable: highConfidenceFps,
    confidence: highConfidenceFps ? "high" : "low",
  };
}

export function formatParticipantMatchBadge(
  participant: Participant,
  options: {
    localHasFile: boolean;
    isSelf: boolean;
    aligned?: boolean;
    scaleCalibrated?: boolean;
  },
): ParticipantMatchBadge {
  const peerHasFile = Boolean(participant.fileName?.trim());
  const aligned = Boolean(options.aligned);
  const scaleCalibrated = Boolean(options.scaleCalibrated);

  if (options.isSelf) {
    if (!options.localHasFile) {
      return { text: "No video open", className: "text-muted", isMismatch: false };
    }
    return { text: "Video loaded", className: "text-secondary", isMismatch: false };
  }

  if (!peerHasFile) {
    return { text: "Picking a video…", className: "text-muted", isMismatch: false };
  }

  if (!options.localHasFile) {
    return { text: "Not open on your PC", className: "text-warn", isMismatch: true };
  }

  switch (participant.fileMatch) {
    case "matched":
      return { text: "Same video", className: "text-secondary", isMismatch: false };
    case "sameLengthDifferentEncode":
      if (aligned) {
        return { text: "Aligned", className: "text-ok", isMismatch: false };
      }
      return { text: "Different format", className: "text-secondary", isMismatch: false };
    case "durationMismatch":
      if (participant.sourceRelation === "fpsMismatch") {
        if (scaleCalibrated) {
          return { text: "FPS matched", className: "text-ok", isMismatch: false };
        }
        return {
          text: participant.suggestedFpsLabel || "FPS differs",
          className: "text-warn",
          isMismatch: true,
        };
      }
      if (participant.sourceRelation === "differentCut") {
        if (aligned) {
          return { text: "Aligned", className: "text-ok", isMismatch: false };
        }
        const delta = participant.durationDeltaSecs;
        const deltaStr =
          typeof delta === "number" && Number.isFinite(delta)
            ? ` (${formatSignedOffset(delta)})`
            : "";
        return { text: `Source differs${deltaStr}`, className: "text-warn", isMismatch: true };
      }
      if (participant.sourceRelation === "differentMedia") {
        return { text: "Different video", className: "text-bad", isMismatch: true };
      }
      return { text: "Length differs", className: "text-bad", isMismatch: true };
    case "differentFile":
      return { text: "Different video", className: "text-warn", isMismatch: true };
    default:
      return { text: "Checking video…", className: "text-muted", isMismatch: false };
  }
}
