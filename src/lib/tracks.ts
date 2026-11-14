import type { MpvTrack } from "./mpv";

export interface TrackOption {
  value: string;
  label: string;
  track: MpvTrack | null;
}

export function formatTrackLabel(track: MpvTrack): string {
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

export function formatTrackAnnouncement(track: MpvTrack | null, kind: "audio" | "sub"): string {
  if (!track) {
    return kind === "sub" ? "Subtitles off" : "Audio track auto";
  }
  return `${kind === "sub" ? "Sub" : "Audio"}: ${formatTrackLabel(track)}`;
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
    if (chosen && !chosen.external) {
      hooks.clearExternalTrackState?.();
    }
  }
}

export function isBitmapSubtitleTrack(track: MpvTrack | undefined | null): boolean {
  if (!track || !track.codec) return false;
  const c = track.codec.trim().toLowerCase();
  return (
    c === "hdmv_pgs_subtitle" ||
    c === "pgssub" ||
    c === "dvd_subtitle" ||
    c === "dvdsub" ||
    c === "dvb_subtitle" ||
    c === "xsub"
  );
}
