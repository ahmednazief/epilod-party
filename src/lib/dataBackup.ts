import { useAppStore } from "../store/useAppStore";
import { useRatingStore, type PersonalEpisodeRating } from "../store/useRatingStore";
import { useRecentRoomsStore, type RecentRoomEntry } from "../store/useRecentRoomsStore";
import { useResumeStore } from "../store/useResumeStore";
import { useSeriesProgressStore } from "../store/useSeriesProgressStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useVoiceStore } from "../store/useVoiceStore";
import type { ResumeEntry } from "./resume";
import type { SeriesProgressEntry } from "./seriesProgress";
import {
  storageCreateSnapshot,
  storageReadAllDomains,
  storageSetThumbCapMb,
  storageWriteDomain,
  type StorageDomain,
} from "./storageBridge";

export const BACKUP_FORMAT = "epilod-backup" as const;
export const BACKUP_SCHEMA_VERSION = 1 as const;

const WEEKLY_SNAPSHOT_KEY = "ep.lastAutoSnapshotAt";
const WEEKLY_SNAPSHOT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keys explicitly included in the settings domain (Tier 2).
 * Excluded on purpose: ep.osApiKey, ep.osApiKey.dpapi, serverPassword,
 * ep.introCache.v1, ep.manualIntroCache.v1, epilod.v1.officialRatings.
 */
const SETTINGS_STORAGE_KEYS = [
  "ep.username",
  "ep.avatarId",
  "ep.server",
  "ep.hideViewers",
  "ep.hashFilenames",
  "ep.autoFixFileMismatch",
  "ep.rememberPlaybackPosition",
  "ep.trackWatchedEpisodes",
  "ep.fixArabicPunctuation",
  "ep.alwaysOnTop",
  "ep.globalShortcutsEnabled",
  "ep.osdEnabled",
  "ep.startWhenAllReady",
  "ep.reducedMotion",
  "ep.lowPowerMode",
  "ep.allowNetworkShares",
  "ep.customLibraryFolders",
  "ep.skipIntroMode",
  "ep.outroNextMode",
  "ep.soundEffects",
  "ep.autoFetchSubs",
  "ep.preferredSubLangs",
  "ep.reactionsEnabled",
  "ep.chatPeeksEnabled",
  "ep.chatTriggerPlacement",
  "ep.recentEmojis",
  "ep.reactionPresets",
  "ep.fullWidthPlayBar",
  "ep.playBarOpacity",
  "ep.autoCheckUpdates",
  "ep.autoDownloadUpdates",
  "ep.seekbarThumbnails",
  "ep.thumbCacheCapMb",
  "ep.outroRatingEnabled",
  "ep.chatWidth.v2",
  "ep.dialogueBoost",
  "ep.subBold",
  "ep.subSize",
  "ep.subPos",
  "ep.subColor",
  "ep.subFont",
  "ep.subShadow",
  "ep.subOutline",
  "ep.subBgOpacity",
  "ep.autoPlayNext",
  "ep.followPartyEpisode",
  "ep.voiceEnabled",
  "ep.voiceMode",
  "ep.voiceHotkey",
  "ep.voiceInputDevice",
  "ep.voiceOutputDevice",
  "ep.voiceInputGain",
  "ep.voiceOutputGain",
  "ep.voiceNoiseMode",
  "ep.voiceVadSensitivity",
  "ep.voiceDuckingMode",
  "ep.voiceSelfMonitor",
] as const;

export interface BackupDataPayload {
  settings: Record<string, string>;
  progress: {
    series: Record<string, SeriesProgressEntry>;
    resume: Record<string, ResumeEntry>;
  };
  ratings: Record<string, PersonalEpisodeRating>;
  prefs: {
    subtitlePrefs: Record<string, unknown>;
    seriesTrackPrefs: Record<string, unknown>;
    sourceAlignments: Record<string, unknown>;
  };
  rooms: RecentRoomEntry[];
}

export interface EpilodBackupEnvelope {
  format: typeof BACKUP_FORMAT;
  schema: number;
  appVersion: string;
  createdAt: number;
  checksum: string;
  data: BackupDataPayload;
}

export interface BackupPreviewSummary {
  envelope: EpilodBackupEnvelope;
  seriesCount: number;
  ratingsCount: number;
  resumeCount: number;
  roomsCount: number;
  settingsCount: number;
}

function safeReadLocalJson<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && parsed !== undefined ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteLocalJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota/storage errors
  }
}

function stripResumeFilePaths(
  entries: Record<string, ResumeEntry>,
): Record<string, ResumeEntry> {
  const compact: Record<string, ResumeEntry> = {};
  for (const [k, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue;
    compact[k] = {
      positionSecs: entry.positionSecs,
      durationSecs: entry.durationSecs,
      updatedAt: entry.updatedAt,
      ...(entry.fileName ? { fileName: entry.fileName } : {}),
      ...(entry.linkedRoomId ? { linkedRoomId: entry.linkedRoomId } : {}),
    };
  }
  return compact;
}

function sanitizeRoomsForBackup(rooms: RecentRoomEntry[]): RecentRoomEntry[] {
  return rooms.map((r) => {
    const { encryptedPassword: _stripSecret, ...safe } = r;
    return safe;
  });
}

export function computeBackupChecksum(data: BackupDataPayload): string {
  const raw = JSON.stringify(data);
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function collectBackupData(): BackupDataPayload {
  const settings: Record<string, string> = {};
  if (typeof localStorage !== "undefined") {
    for (const key of SETTINGS_STORAGE_KEYS) {
      const val = localStorage.getItem(key);
      if (val !== null) settings[key] = val;
    }
  }

  const series = useSeriesProgressStore.getState().series;
  const resume = stripResumeFilePaths(useResumeStore.getState().entries);
  const ratings = useRatingStore.getState().personalByMediaId;
  const rooms = sanitizeRoomsForBackup(useRecentRoomsStore.getState().rooms);

  return {
    settings,
    progress: { series, resume },
    ratings,
    prefs: {
      subtitlePrefs: safeReadLocalJson<Record<string, unknown>>("epilod.v1.subtitlePrefs", {}),
      seriesTrackPrefs: safeReadLocalJson<Record<string, unknown>>("epilod.v1.seriesTrackPrefs", {}),
      sourceAlignments: safeReadLocalJson<Record<string, unknown>>("ep.sourceAlignments.v1", {}),
    },
    rooms,
  };
}

export function buildBackupEnvelopeJson(appVersion = "0.1.5"): string {
  const data = collectBackupData();
  const envelope: EpilodBackupEnvelope = {
    format: BACKUP_FORMAT,
    schema: BACKUP_SCHEMA_VERSION,
    appVersion,
    createdAt: Date.now(),
    checksum: computeBackupChecksum(data),
    data,
  };
  return JSON.stringify(envelope);
}

export function parseAndValidateBackup(rawJson: string): BackupPreviewSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("This file is not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid backup structure.");
  }
  const env = parsed as Partial<EpilodBackupEnvelope>;
  if (env.format !== BACKUP_FORMAT || typeof env.schema !== "number" || !env.data) {
    throw new Error("This is not a valid Epilod Party backup file.");
  }
  if (env.schema > BACKUP_SCHEMA_VERSION) {
    throw new Error(`Backup schema v${env.schema} is newer than this version of Epilod Party.`);
  }

  const expected = computeBackupChecksum(env.data);
  if (env.checksum && env.checksum !== expected) {
    throw new Error("Backup checksum mismatch — the file may be corrupted or edited.");
  }

  const data = env.data;
  const seriesCount = data.progress?.series ? Object.keys(data.progress.series).length : 0;
  const ratingsCount = data.ratings ? Object.keys(data.ratings).length : 0;
  const resumeCount = data.progress?.resume ? Object.keys(data.progress.resume).length : 0;
  const roomsCount = Array.isArray(data.rooms) ? data.rooms.length : 0;
  const settingsCount = data.settings ? Object.keys(data.settings).length : 0;

  return {
    envelope: env as EpilodBackupEnvelope,
    seriesCount,
    ratingsCount,
    resumeCount,
    roomsCount,
    settingsCount,
  };
}

function mergeTimestampedMaps<T extends { updatedAt?: number }>(
  current: Record<string, T>,
  incoming: Record<string, T>,
): Record<string, T> {
  const out = { ...current };
  for (const [k, item] of Object.entries(incoming)) {
    if (!item || typeof item !== "object") continue;
    const prev = out[k];
    if (!prev || (item.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
      out[k] = item;
    }
  }
  return out;
}

function mergeSeriesMaps(
  current: Record<string, SeriesProgressEntry>,
  incoming: Record<string, SeriesProgressEntry>,
): Record<string, SeriesProgressEntry> {
  const out = { ...current };
  for (const [k, item] of Object.entries(incoming)) {
    if (!item || typeof item !== "object") continue;
    const prev = out[k];
    if (!prev) {
      out[k] = item;
      continue;
    }
    const unionKeys = Array.from(new Set([...(prev.watchedKeys ?? []), ...(item.watchedKeys ?? [])]));
    const newerIsIncoming = (item.updatedAt ?? 0) >= (prev.updatedAt ?? 0);
    out[k] = {
      ...prev,
      ...(newerIsIncoming ? item : {}),
      watchedKeys: unionKeys,
      updatedAt: Math.max(prev.updatedAt ?? 0, item.updatedAt ?? 0),
    };
  }
  return out;
}

function mergeRoomLists(current: RecentRoomEntry[], incoming: RecentRoomEntry[]): RecentRoomEntry[] {
  const byId = new Map<string, RecentRoomEntry>();
  for (const room of current) {
    byId.set(room.id, room);
  }
  for (const room of incoming) {
    const prev = byId.get(room.id);
    if (!prev) {
      byId.set(room.id, room);
      continue;
    }
    byId.set(room.id, {
      ...prev,
      ...room,
      pinned: prev.pinned || room.pinned,
      encryptedPassword: prev.encryptedPassword,
      lastJoinedAt: Math.max(prev.lastJoinedAt ?? 0, room.lastJoinedAt ?? 0),
    });
  }
  return Array.from(byId.values());
}

function applySettingsToLocalAndStore(settings: Record<string, string>, mode: "merge" | "replace"): void {
  if (typeof localStorage === "undefined") return;

  if (mode === "replace") {
    for (const key of SETTINGS_STORAGE_KEYS) {
      if (!(key in settings)) {
        localStorage.removeItem(key);
      }
    }
  }

  for (const [key, val] of Object.entries(settings)) {
    if (SETTINGS_STORAGE_KEYS.includes(key as (typeof SETTINGS_STORAGE_KEYS)[number]) && typeof val === "string") {
      localStorage.setItem(key, val);
    }
  }

  // Hydrate key live settings into Zustand without requiring a hard reload
  const app = useAppStore.getState();
  if (typeof settings["ep.username"] === "string") app.setUsername(settings["ep.username"]);
  if (typeof settings["ep.avatarId"] === "string") {
    app.setAvatarId(settings["ep.avatarId"] as Parameters<typeof app.setAvatarId>[0]);
  }
  if (typeof settings["ep.server"] === "string") app.setServerEndpoint(settings["ep.server"]);
  if (typeof settings["ep.reducedMotion"] === "string") {
    app.setReducedMotion(settings["ep.reducedMotion"] === "true");
  }
  if (typeof settings["ep.lowPowerMode"] === "string") {
    app.setLowPowerMode(settings["ep.lowPowerMode"] === "true");
  }
  if (typeof settings["ep.soundEffects"] === "string") {
    app.setSoundEffectsEnabled(settings["ep.soundEffects"] !== "false");
  }
  if (typeof settings["ep.fullWidthPlayBar"] === "string") {
    app.setFullWidthPlayBar(settings["ep.fullWidthPlayBar"] !== "false");
  }
  if (typeof settings["ep.playBarOpacity"] === "string") {
    app.setPlayBarOpacity(Number(settings["ep.playBarOpacity"]));
  }
  if (typeof settings["ep.seekbarThumbnails"] === "string") {
    app.setSeekbarThumbnails(settings["ep.seekbarThumbnails"] !== "false");
  }
  if (typeof settings["ep.thumbCacheCapMb"] === "string") {
    const cap = Number(settings["ep.thumbCacheCapMb"]);
    if (Number.isFinite(cap) && cap > 0) {
      app.setThumbCacheCapMb?.(cap);
    }
  }
  if (typeof settings["ep.outroRatingEnabled"] === "string") {
    app.setOutroRatingEnabled(settings["ep.outroRatingEnabled"] !== "false");
  }
  if (typeof settings["ep.trackWatchedEpisodes"] === "string") {
    app.setTrackWatchedEpisodes(settings["ep.trackWatchedEpisodes"] !== "false");
  }
  if (typeof settings["ep.rememberPlaybackPosition"] === "string") {
    app.setRememberPlaybackPosition(settings["ep.rememberPlaybackPosition"] !== "false");
  }
  // Touch voice/subtitle stores cleanly if hydrated from disk
  void useSubtitleStore.getState();
  void useVoiceStore.getState();
}

export async function applyBackupEnvelope(
  envelope: EpilodBackupEnvelope,
  mode: "merge" | "replace" = "merge",
): Promise<void> {
  const { data } = envelope;

  applySettingsToLocalAndStore(data.settings ?? {}, mode);

  const ratingStore = useRatingStore.getState();
  if (data.ratings && typeof data.ratings === "object") {
    if (mode === "replace") {
      ratingStore.replacePersonalRatings(data.ratings);
    } else {
      ratingStore.mergePersonalRatings(data.ratings);
    }
  }

  const progressStore = useSeriesProgressStore.getState();
  if (data.progress?.series && typeof data.progress.series === "object") {
    const nextSeries =
      mode === "replace"
        ? data.progress.series
        : mergeSeriesMaps(progressStore.series, data.progress.series);
    progressStore.hydrateSeriesMap(nextSeries);
  }

  const resumeStore = useResumeStore.getState();
  if (data.progress?.resume && typeof data.progress.resume === "object") {
    const nextResume =
      mode === "replace"
        ? data.progress.resume
        : mergeTimestampedMaps(resumeStore.entries, data.progress.resume);
    resumeStore.hydrateEntries(nextResume);
  }

  const roomsStore = useRecentRoomsStore.getState();
  if (Array.isArray(data.rooms)) {
    const nextRooms =
      mode === "replace" ? data.rooms : mergeRoomLists(roomsStore.rooms, data.rooms);
    roomsStore.hydrateRooms(nextRooms);
  }

  if (data.prefs) {
    const subPrefs =
      mode === "replace"
        ? data.prefs.subtitlePrefs ?? {}
        : mergeTimestampedMaps(
            safeReadLocalJson("epilod.v1.subtitlePrefs", {}),
            (data.prefs.subtitlePrefs ?? {}) as Record<string, { updatedAt?: number }>,
          );
    safeWriteLocalJson("epilod.v1.subtitlePrefs", subPrefs);

    const trackPrefs =
      mode === "replace"
        ? data.prefs.seriesTrackPrefs ?? {}
        : mergeTimestampedMaps(
            safeReadLocalJson("epilod.v1.seriesTrackPrefs", {}),
            (data.prefs.seriesTrackPrefs ?? {}) as Record<string, { updatedAt?: number }>,
          );
    safeWriteLocalJson("epilod.v1.seriesTrackPrefs", trackPrefs);

    const alignments =
      mode === "replace"
        ? data.prefs.sourceAlignments ?? {}
        : mergeTimestampedMaps(
            safeReadLocalJson("ep.sourceAlignments.v1", {}),
            (data.prefs.sourceAlignments ?? {}) as Record<string, { updatedAt?: number }>,
          );
    safeWriteLocalJson("ep.sourceAlignments.v1", alignments);
  }

  await syncAllUserdataDomainsNow();
}

let syncTimer: number | null = null;

export async function syncAllUserdataDomainsNow(): Promise<void> {
  const payload = collectBackupData();
  const domains: Record<StorageDomain, unknown> = {
    settings: payload.settings,
    progress: payload.progress,
    ratings: payload.ratings,
    prefs: payload.prefs,
    rooms: payload.rooms,
  };
  await Promise.all(
    (Object.entries(domains) as Array<[StorageDomain, unknown]>).map(([domain, val]) =>
      storageWriteDomain(domain, JSON.stringify(val)).catch(() => undefined),
    ),
  );
}

export function scheduleUserdataSync(): void {
  if (typeof window === "undefined") return;
  if (syncTimer !== null) {
    window.clearTimeout(syncTimer);
  }
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void syncAllUserdataDomainsNow();
  }, 1200);
}

function hasAnyLocalUserdata(): boolean {
  if (Object.keys(useRatingStore.getState().personalByMediaId).length > 0) return true;
  if (Object.keys(useSeriesProgressStore.getState().series).length > 0) return true;
  if (Object.keys(useResumeStore.getState().entries).length > 0) return true;
  if (useRecentRoomsStore.getState().rooms.length > 0) return true;
  if (typeof localStorage !== "undefined" && localStorage.getItem("ep.username")) return true;
  return false;
}

let bootstrapPromise: Promise<void> | null = null;

export function bootstrapUserdataStorage(appVersion = "0.1.5"): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    try {
      const capMb = useAppStore.getState().thumbCacheCapMb ?? 24;
      void storageSetThumbCapMb(capMb).catch(() => undefined);

      const diskDomains = await storageReadAllDomains();
      const hasDiskData = Object.values(diskDomains).some((v) => typeof v === "string" && v.length > 2);

      if (!hasAnyLocalUserdata() && hasDiskData) {
        // Auto-recover from %APPDATA%\Epilod Party\userdata after WebView reset or clean reinstall
        const parsedPayload: BackupDataPayload = {
          settings: diskDomains.settings ? (JSON.parse(diskDomains.settings) as Record<string, string>) : {},
          progress: diskDomains.progress
            ? (JSON.parse(diskDomains.progress) as BackupDataPayload["progress"])
            : { series: {}, resume: {} },
          ratings: diskDomains.ratings
            ? (JSON.parse(diskDomains.ratings) as Record<string, PersonalEpisodeRating>)
            : {},
          prefs: diskDomains.prefs
            ? (JSON.parse(diskDomains.prefs) as BackupDataPayload["prefs"])
            : { subtitlePrefs: {}, seriesTrackPrefs: {}, sourceAlignments: {} },
          rooms: diskDomains.rooms ? (JSON.parse(diskDomains.rooms) as RecentRoomEntry[]) : [],
        };
        await applyBackupEnvelope(
          {
            format: BACKUP_FORMAT,
            schema: BACKUP_SCHEMA_VERSION,
            appVersion,
            createdAt: Date.now(),
            checksum: computeBackupChecksum(parsedPayload),
            data: parsedPayload,
          },
          "merge",
        );
      } else {
        await syncAllUserdataDomainsNow();
      }

      // Check weekly auto-snapshot schedule (mark timestamp before awaiting to avoid double triggers)
      if (typeof localStorage !== "undefined") {
        const lastAtRaw = localStorage.getItem(WEEKLY_SNAPSHOT_KEY);
        const lastAt = Number(lastAtRaw ?? "0");
        if (!Number.isFinite(lastAt) || Date.now() - lastAt >= WEEKLY_SNAPSHOT_INTERVAL_MS) {
          localStorage.setItem(WEEKLY_SNAPSHOT_KEY, String(Date.now()));
          const json = buildBackupEnvelopeJson(appVersion);
          await storageCreateSnapshot("weekly", json).catch(() => {
            if (lastAtRaw !== null) {
              localStorage.setItem(WEEKLY_SNAPSHOT_KEY, lastAtRaw);
            } else {
              localStorage.removeItem(WEEKLY_SNAPSHOT_KEY);
            }
          });
        }
      }
    } catch {
      // Non-fatal bootstrap guard
    }
  })();
  return bootstrapPromise;
}
