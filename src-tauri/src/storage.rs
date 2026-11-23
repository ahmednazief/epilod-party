use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DOMAIN_BYTES: usize = 4 * 1024 * 1024;
const MAX_BACKUP_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_AUTO_SNAPSHOTS: usize = 3;

const VALID_DOMAINS: [&str; 5] = ["settings", "progress", "ratings", "prefs", "rooms"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshotInfo {
    pub file_name: String,
    pub reason: String,
    pub created_at_secs: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatsDto {
    pub userdata_bytes: u64,
    pub thumbs_bytes: u64,
    pub thumbs_files: u64,
    pub subtitles_bytes: u64,
    pub subtitles_files: u64,
    pub other_cache_bytes: u64,
    pub userdata_path: String,
    pub thumb_cache_cap_mb: u64,
    pub snapshots: Vec<BackupSnapshotInfo>,
}

pub fn userdata_root_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|p| PathBuf::from(p).join("Epilod Party").join("userdata"))
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(|p| PathBuf::from(p).join("EpilodParty").join("userdata"))
        })
}

pub fn local_epilod_root_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("EpilodParty"))
}

pub fn backups_dir_in(root: &Path) -> PathBuf {
    root.join("backups")
}

pub fn resolve_domain_path(root: &Path, domain: &str) -> Result<PathBuf, String> {
    match domain {
        "settings" => Ok(root.join("settings.json")),
        "progress" => Ok(root.join("library").join("progress.json")),
        "ratings" => Ok(root.join("library").join("ratings.json")),
        "prefs" => Ok(root.join("library").join("prefs.json")),
        "rooms" => Ok(root.join("rooms.json")),
        _ => Err(format!("Unsupported storage domain: {domain}")),
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Target path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed creating directory {}: {e}", parent.display()))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid target filename".to_string())?;
    let tmp_path = parent.join(format!("{file_name}.{}.tmp", std::process::id()));

    fs::write(&tmp_path, bytes).map_err(|e| format!("Failed writing temp file: {e}"))?;
    if let Err(err) = fs::rename(&tmp_path, path) {
        // Fallback when destination exists on Windows FS edge cases
        let _ = fs::remove_file(path);
        fs::rename(&tmp_path, path).map_err(|e2| {
            let _ = fs::remove_file(&tmp_path);
            format!("Failed finalizing atomic write ({err}; retry: {e2})")
        })?;
    }
    Ok(())
}

pub fn write_userdata_domain_in(root: &Path, domain: &str, json_str: &str) -> Result<(), String> {
    if json_str.len() > MAX_DOMAIN_BYTES {
        return Err(format!("Domain '{domain}' exceeds max size limit"));
    }
    let path = resolve_domain_path(root, domain)?;
    write_atomic(&path, json_str.as_bytes())
}

pub fn read_userdata_domain_in(root: &Path, domain: &str) -> Result<Option<String>, String> {
    let path = resolve_domain_path(root, domain)?;
    if !path.is_file() {
        return Ok(None);
    }
    let meta =
        fs::metadata(&path).map_err(|e| format!("Failed inspecting {}: {e}", path.display()))?;
    if meta.len() > MAX_DOMAIN_BYTES as u64 {
        return Err(format!("Domain '{domain}' file exceeds max size"));
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed reading {}: {e}", path.display()))?;
    Ok(Some(content))
}

pub fn read_all_userdata_domains_in(root: &Path) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for domain in VALID_DOMAINS {
        if let Some(content) = read_userdata_domain_in(root, domain)? {
            out.insert(domain.to_string(), content);
        }
    }
    Ok(out)
}

fn dir_size_and_files(dir: &Path) -> (u64, u64) {
    if !dir.is_dir() {
        return (0, 0);
    }
    let mut bytes = 0u64;
    let mut files = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let (sub_b, sub_f) = dir_size_and_files(&path);
            bytes = bytes.saturating_add(sub_b);
            files = files.saturating_add(sub_f);
        } else if path.is_file() {
            if let Ok(meta) = entry.metadata() {
                bytes = bytes.saturating_add(meta.len());
                files = files.saturating_add(1);
            }
        }
    }
    (bytes, files)
}

fn clear_dir_contents(dir: &Path) -> u64 {
    if !dir.is_dir() {
        return 0;
    }
    let mut freed = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let (b, _) = dir_size_and_files(&p);
            if fs::remove_dir_all(&p).is_ok() {
                freed = freed.saturating_add(b);
            }
        } else if p.is_file() {
            let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if fs::remove_file(&p).is_ok() {
                freed = freed.saturating_add(len);
            }
        }
    }
    freed
}

fn sanitize_reason(reason: &str) -> String {
    let clean: String = reason
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = clean.trim_matches('-');
    if trimmed.is_empty() {
        "manual".to_string()
    } else {
        trimmed.chars().take(24).collect()
    }
}

fn parse_snapshot_filename(name: &str) -> Option<(u64, String)> {
    let stem = name
        .strip_prefix("epilod-backup-")?
        .strip_suffix(".epilodbackup")?;
    let (ts_part, reason_part) = stem.split_once('-')?;
    let ts = ts_part.parse::<u64>().ok()?;
    Some((ts, reason_part.to_string()))
}

pub fn list_auto_snapshots_in(root: &Path) -> Vec<BackupSnapshotInfo> {
    let dir = backups_dir_in(root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let Some(name) = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let Some((parsed_ts, reason)) = parse_snapshot_filename(&name) else {
            continue;
        };
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let created_at_secs = parsed_ts;
        out.push(BackupSnapshotInfo {
            file_name: name,
            reason,
            created_at_secs,
            size_bytes,
        });
    }
    out.sort_by(|a, b| {
        b.created_at_secs
            .cmp(&a.created_at_secs)
            .then_with(|| b.file_name.cmp(&a.file_name))
    });
    out
}

pub fn create_auto_snapshot_in(
    root: &Path,
    reason: &str,
    payload_json: &str,
) -> Result<BackupSnapshotInfo, String> {
    if payload_json.len() > MAX_BACKUP_BYTES {
        return Err("Backup payload exceeds max allowed size".to_string());
    }
    let dir = backups_dir_in(root);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed creating backups folder: {e}"))?;

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let clean_reason = sanitize_reason(reason);
    let existing = list_auto_snapshots_in(root);
    let max_existing_ts = existing.first().map(|s| s.created_at_secs).unwrap_or(0);
    let target_ts = if now_secs <= max_existing_ts {
        max_existing_ts + 1
    } else {
        now_secs
    };
    let candidate_name = format!("epilod-backup-{target_ts}-{clean_reason}.epilodbackup");
    let target = dir.join(&candidate_name);

    write_atomic(&target, payload_json.as_bytes())?;
    let size_bytes = payload_json.len() as u64;

    let all = list_auto_snapshots_in(root);
    for stale in all.into_iter().skip(MAX_AUTO_SNAPSHOTS) {
        let _ = fs::remove_file(dir.join(&stale.file_name));
    }

    Ok(BackupSnapshotInfo {
        file_name: candidate_name,
        reason: clean_reason,
        created_at_secs: target_ts,
        size_bytes,
    })
}

pub fn read_auto_snapshot_in(root: &Path, file_name: &str) -> Result<String, String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || !file_name.ends_with(".epilodbackup")
    {
        return Err("Invalid snapshot filename".to_string());
    }
    let path = backups_dir_in(root).join(file_name);
    if !path.is_file() {
        return Err("Snapshot file not found".to_string());
    }
    let meta = fs::metadata(&path).map_err(|e| format!("Failed inspecting snapshot: {e}"))?;
    if meta.len() > MAX_BACKUP_BYTES as u64 {
        return Err("Snapshot file exceeds max backup size".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed reading snapshot: {e}"))
}

pub fn compute_storage_stats_with_dirs(
    userdata_root: Option<&Path>,
    thumbs_dir: Option<&Path>,
    subs_dir: Option<&Path>,
    local_root: Option<&Path>,
    thumb_cache_cap_mb: u64,
) -> StorageStatsDto {
    let (userdata_bytes, _) = userdata_root.map(dir_size_and_files).unwrap_or((0, 0));
    let (thumbs_bytes, thumbs_files) = thumbs_dir.map(dir_size_and_files).unwrap_or((0, 0));
    let (subtitles_bytes, subtitles_files) = subs_dir.map(dir_size_and_files).unwrap_or((0, 0));

    let mut other_cache_bytes = 0u64;
    if let Some(local) = local_root {
        other_cache_bytes = other_cache_bytes
            .saturating_add(dir_size_and_files(&local.join("cache").join("subs")).0)
            .saturating_add(dir_size_and_files(&local.join("updates")).0)
            .saturating_add(dir_size_and_files(&local.join("logs")).0);
    }

    let snapshots = userdata_root
        .map(list_auto_snapshots_in)
        .unwrap_or_default();

    StorageStatsDto {
        userdata_bytes,
        thumbs_bytes,
        thumbs_files,
        subtitles_bytes,
        subtitles_files,
        other_cache_bytes,
        userdata_path: userdata_root
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        thumb_cache_cap_mb,
        snapshots,
    }
}

pub fn clear_storage_cache_with_dirs(
    target: &str,
    thumbs_dir: Option<&Path>,
    subs_dir: Option<&Path>,
    local_root: Option<&Path>,
) -> Result<u64, String> {
    let mut freed = 0u64;
    match target {
        "thumbs" => {
            if let Some(dir) = thumbs_dir {
                freed = freed.saturating_add(crate::thumbnails::clear_all_thumbnail_cache(dir));
            }
        }
        "subtitles" => {
            if let Some(dir) = subs_dir {
                freed = freed.saturating_add(clear_dir_contents(dir));
            }
            if let Some(local) = local_root {
                freed = freed.saturating_add(clear_dir_contents(&local.join("cache").join("subs")));
            }
        }
        "all" => {
            if let Some(dir) = thumbs_dir {
                freed = freed.saturating_add(crate::thumbnails::clear_all_thumbnail_cache(dir));
            }
            if let Some(dir) = subs_dir {
                freed = freed.saturating_add(clear_dir_contents(dir));
            }
            if let Some(local) = local_root {
                freed = freed.saturating_add(clear_dir_contents(&local.join("cache").join("subs")));
                freed = freed.saturating_add(clear_dir_contents(&local.join("updates")));
            }
        }
        _ => return Err(format!("Unsupported cache target: {target}")),
    }
    Ok(freed)
}

pub fn export_backup_file(path: &str, payload_json: &str) -> Result<u64, String> {
    if payload_json.len() > MAX_BACKUP_BYTES {
        return Err("Backup payload exceeds max size limit".to_string());
    }
    let clean = path.trim();
    if clean.is_empty() {
        return Err("Backup export path is empty".to_string());
    }
    write_atomic(Path::new(clean), payload_json.as_bytes())?;
    Ok(payload_json.len() as u64)
}

pub fn import_backup_file(path: &str) -> Result<String, String> {
    let clean = path.trim();
    if clean.is_empty() {
        return Err("Backup import path is empty".to_string());
    }
    let p = Path::new(clean);
    if !p.is_file() {
        return Err("Selected backup file does not exist".to_string());
    }
    let meta = fs::metadata(p).map_err(|e| format!("Failed inspecting backup file: {e}"))?;
    if meta.len() > MAX_BACKUP_BYTES as u64 {
        return Err("Backup file exceeds max 10 MB size limit".to_string());
    }
    fs::read_to_string(p).map_err(|e| format!("Failed reading backup file: {e}"))
}

pub fn open_userdata_folder() -> Result<String, String> {
    let root =
        userdata_root_dir().ok_or_else(|| "User data folder path unavailable".to_string())?;
    fs::create_dir_all(&root).map_err(|e| format!("Failed creating user data folder: {e}"))?;
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(&root)
            .spawn()
            .map_err(|e| format!("Failed opening Explorer: {e}"))?;
    }
    Ok(root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "epilod_storage_test_{tag}_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn domain_write_and_read_roundtrip() {
        let root = temp_test_dir("roundtrip");
        write_userdata_domain_in(&root, "ratings", r#"{"ep1":{"score":9}}"#).unwrap();
        write_userdata_domain_in(&root, "settings", r#"{"username":"Noor"}"#).unwrap();
        let all = read_all_userdata_domains_in(&root).unwrap();
        assert_eq!(
            all.get("ratings").map(String::as_str),
            Some(r#"{"ep1":{"score":9}}"#)
        );
        assert_eq!(
            all.get("settings").map(String::as_str),
            Some(r#"{"username":"Noor"}"#)
        );
        assert!(root.join("library").join("ratings.json").is_file());
        assert!(root.join("settings.json").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_invalid_domain_traversal() {
        let root = temp_test_dir("traversal");
        assert!(resolve_domain_path(&root, "../evil").is_err());
        assert!(resolve_domain_path(&root, "unknown").is_err());
        assert!(read_auto_snapshot_in(&root, "../secret.epilodbackup").is_err());
        assert!(read_auto_snapshot_in(&root, "bad.json").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn auto_snapshots_prune_to_last_three() {
        let root = temp_test_dir("snaps");
        for idx in 0..5 {
            create_auto_snapshot_in(&root, "weekly", &format!(r#"{{"i":{idx}}}"#)).unwrap();
        }
        let snaps = list_auto_snapshots_in(&root);
        assert_eq!(snaps.len(), MAX_AUTO_SNAPSHOTS);
        let latest = read_auto_snapshot_in(&root, &snaps[0].file_name).unwrap();
        assert!(latest.contains(r#""i":4"#));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn storage_stats_and_cache_clear() {
        let root = temp_test_dir("stats");
        let userdata = root.join("userdata");
        let thumbs = root.join("thumbs");
        let subs = root.join("subs");
        let local = root.join("local");
        fs::create_dir_all(&thumbs).unwrap();
        fs::create_dir_all(&subs).unwrap();
        fs::create_dir_all(local.join("updates")).unwrap();

        write_userdata_domain_in(&userdata, "progress", r#"{"s":1}"#).unwrap();
        fs::write(thumbs.join("a.jpg"), vec![1u8; 400]).unwrap();
        fs::write(subs.join("a.srt"), vec![2u8; 200]).unwrap();
        fs::write(local.join("updates").join("tmp.bin"), vec![3u8; 100]).unwrap();

        let stats = compute_storage_stats_with_dirs(
            Some(&userdata),
            Some(&thumbs),
            Some(&subs),
            Some(&local),
            24,
        );
        assert_eq!(stats.thumbs_bytes, 400);
        assert_eq!(stats.thumbs_files, 1);
        assert_eq!(stats.subtitles_bytes, 200);
        assert_eq!(stats.other_cache_bytes, 100);
        assert!(stats.userdata_bytes > 0);

        let freed =
            clear_storage_cache_with_dirs("thumbs", Some(&thumbs), Some(&subs), Some(&local))
                .unwrap();
        assert_eq!(freed, 400);
        assert!(!thumbs.join("a.jpg").exists());
        assert!(subs.join("a.srt").exists());
        assert!(userdata.join("library").join("progress.json").is_file());

        let _ = fs::remove_dir_all(&root);
    }
}
