import { isDesktop, safeInvoke } from "./bridge";
import { loadJson, saveJson } from "./persist";

export type StorageDomain = "settings" | "progress" | "ratings" | "prefs" | "rooms";
export type CacheClearTarget = "thumbs" | "subtitles" | "all";

export interface BackupSnapshotInfo {
  fileName: string;
  reason: string;
  createdAtSecs: number;
  sizeBytes: number;
}

export interface StorageStats {
  userdataBytes: number;
  thumbsBytes: number;
  thumbsFiles: number;
  subtitlesBytes: number;
  subtitlesFiles: number;
  otherCacheBytes: number;
  userdataPath: string;
  thumbCacheCapMb: number;
  snapshots: BackupSnapshotInfo[];
}

const BROWSER_SNAPSHOTS_KEY = "browserSnapshots";

interface BrowserSnapshotRecord extends BackupSnapshotInfo {
  payloadJson: string;
}

function loadBrowserSnapshots(): BrowserSnapshotRecord[] {
  const raw = loadJson<unknown>(BROWSER_SNAPSHOTS_KEY, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const unique: BrowserSnapshotRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as BrowserSnapshotRecord;
    if (typeof rec.fileName !== "string" || seen.has(rec.fileName)) continue;
    seen.add(rec.fileName);
    unique.push(rec);
    if (unique.length >= 3) break;
  }
  if (unique.length !== raw.length) {
    saveBrowserSnapshots(unique);
  }
  return unique;
}

function saveBrowserSnapshots(items: BrowserSnapshotRecord[]): void {
  saveJson(BROWSER_SNAPSHOTS_KEY, items.slice(0, 3));
}

function estimateLocalStorageBytes(): number {
  if (typeof localStorage === "undefined") return 0;
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("ep.") || k.startsWith("epilod.v1.")) {
        const v = localStorage.getItem(k) ?? "";
        total += (k.length + v.length) * 2;
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export async function storageReadAllDomains(): Promise<Partial<Record<StorageDomain, string>>> {
  if (!isDesktop()) return {};
  return safeInvoke<Partial<Record<StorageDomain, string>>>("storage_read_all_domains");
}

export async function storageWriteDomain(domain: StorageDomain, jsonStr: string): Promise<void> {
  if (!isDesktop()) return;
  await safeInvoke("storage_write_domain", { domain, jsonStr });
}

export async function storageGetStats(fallbackCapMb = 24): Promise<StorageStats> {
  if (!isDesktop()) {
    const snaps = loadBrowserSnapshots().map(({ payloadJson: _ignored, ...info }) => info);
    return {
      userdataBytes: estimateLocalStorageBytes(),
      thumbsBytes: 0,
      thumbsFiles: 0,
      subtitlesBytes: 0,
      subtitlesFiles: 0,
      otherCacheBytes: 0,
      userdataPath: "%APPDATA%\\Epilod Party\\userdata",
      thumbCacheCapMb: fallbackCapMb,
      snapshots: snaps,
    };
  }
  return safeInvoke<StorageStats>("storage_get_stats");
}

export async function storageClearCache(target: CacheClearTarget): Promise<number> {
  if (!isDesktop()) return 0;
  return safeInvoke<number>("storage_clear_cache", { target });
}

export async function storageSetThumbCapMb(mb: number): Promise<number> {
  if (!isDesktop()) return mb;
  return safeInvoke<number>("storage_set_thumb_cap_mb", { mb: Math.round(mb) });
}

export async function storageExportBackup(path: string, payloadJson: string): Promise<number> {
  if (!isDesktop()) {
    return payloadJson.length;
  }
  return safeInvoke<number>("storage_export_backup", { path, payloadJson });
}

export async function storageImportBackup(path: string): Promise<string> {
  return safeInvoke<string>("storage_import_backup", { path });
}

export async function storageCreateSnapshot(
  reason: string,
  payloadJson: string,
): Promise<BackupSnapshotInfo> {
  if (!isDesktop()) {
    const existing = loadBrowserSnapshots();
    const nowSecs = Math.floor(Date.now() / 1000);
    const maxTs = existing.reduce((max, s) => Math.max(max, s.createdAtSecs || 0), 0);
    const ts = nowSecs <= maxTs ? maxTs + 1 : nowSecs;
    const cleanReason = reason.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "manual";
    const fileName = `epilod-backup-${ts}-${cleanReason}.epilodbackup`;
    const entry: BrowserSnapshotRecord = {
      fileName,
      reason: cleanReason,
      createdAtSecs: ts,
      sizeBytes: payloadJson.length,
      payloadJson,
    };
    const next = [entry, ...existing.filter((s) => s.fileName !== fileName)].slice(0, 3);
    saveBrowserSnapshots(next);
    const { payloadJson: _ignored, ...info } = entry;
    return info;
  }
  return safeInvoke<BackupSnapshotInfo>("storage_create_snapshot", { reason, payloadJson });
}

export async function storageListSnapshots(): Promise<BackupSnapshotInfo[]> {
  if (!isDesktop()) {
    return loadBrowserSnapshots().map(({ payloadJson: _ignored, ...info }) => info);
  }
  return safeInvoke<BackupSnapshotInfo[]>("storage_list_snapshots");
}

export async function storageReadSnapshot(fileName: string): Promise<string> {
  if (!isDesktop()) {
    const match = loadBrowserSnapshots().find((s) => s.fileName === fileName);
    if (!match) throw new Error("Snapshot not found.");
    return match.payloadJson;
  }
  return safeInvoke<string>("storage_read_snapshot", { fileName });
}

export async function storageOpenUserdataFolder(): Promise<string> {
  return safeInvoke<string>("storage_open_userdata_folder");
}
