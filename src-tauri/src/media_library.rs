#![cfg(windows)]

use epilod_core::matching::{
    score_local_candidate, score_local_candidate_with_options, LocalCandidateInput,
    LocalMatchCandidate,
};
use epilod_core::p2p::{decode_base64_url, encode_base64_url};
use epilod_core::playlist::is_video_path;
use epilod_core::validation::{
    strip_unsafe_unicode, validate_local_path_syntax_with_options, LocalPathOptions,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Downloads, FOLDERID_Videos, SHGetKnownFolderPath,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x0000_0002;
const FILE_ATTRIBUTE_SYSTEM: u32 = 0x0000_0004;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

const MAX_CRAWL_ENTRIES: usize = 15_000;
const MAX_CRAWL_MS: u64 = 1_500;
const INDEX_TTL: Duration = Duration::from_secs(20);
const DURATION_CACHE_MAX: usize = 1_024;
const PROBE_TOP_N: usize = 5;
const FFMPEG_PROBE_TIMEOUT: Duration = Duration::from_millis(900);

const SKIP_DIR_NAMES: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "$recycle.bin",
    "system volume information",
    "node_modules",
    ".git",
    "target",
    "recovery",
];

#[derive(Debug, Clone)]
struct IndexedMediaEntry {
    path: String,
    file_name: String,
    parent_folder: Option<String>,
    grandparent_folder: Option<String>,
    size_bytes: u64,
    mtime_ms: u64,
    is_cloud_placeholder: bool,
    in_saved_series: bool,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct DurationCacheKey {
    path_lower: String,
    size_bytes: u64,
    mtime_ms: u64,
}

#[derive(Default)]
struct IndexSnapshot {
    built_at: Option<Instant>,
    roots_sig: String,
    entries: Vec<IndexedMediaEntry>,
}

#[derive(Default)]
pub struct MediaLibraryState {
    index: Mutex<IndexSnapshot>,
    durations: Mutex<HashMap<DurationCacheKey, Option<f64>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindLocalMatchesRequest {
    pub peer_file_name: String,
    pub peer_duration_secs: Option<f64>,
    #[serde(default)]
    pub saved_series_folders: Vec<String>,
    #[serde(default)]
    pub recent_folders: Vec<String>,
    #[serde(default)]
    pub custom_library_folders: Vec<String>,
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone)]
struct SearchRoot {
    path: PathBuf,
    max_depth: usize,
    in_saved_series: bool,
}

pub fn is_cloud_placeholder_attrs(attrs: u32) -> bool {
    (attrs
        & (FILE_ATTRIBUTE_OFFLINE
            | FILE_ATTRIBUTE_RECALL_ON_OPEN
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS))
        != 0
}

fn known_folder_path(folder_id: &windows_sys::core::GUID) -> Option<PathBuf> {
    unsafe {
        let mut raw: *mut u16 = ptr::null_mut();
        let hr = SHGetKnownFolderPath(folder_id, 0, ptr::null_mut(), &mut raw);
        if hr != 0 || raw.is_null() {
            return None;
        }
        let mut len = 0usize;
        while *raw.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(raw, len);
        let path_str = String::from_utf16_lossy(slice);
        CoTaskMemFree(raw as *const _);
        let pb = PathBuf::from(path_str);
        pb.is_dir().then_some(pb)
    }
}

fn default_user_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for id in [&FOLDERID_Videos, &FOLDERID_Downloads, &FOLDERID_Desktop] {
        if let Some(p) = known_folder_path(id) {
            roots.push(p);
        }
    }
    if roots.is_empty() {
        if let Some(profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
            for sub in ["Videos", "Downloads", "Desktop"] {
                let p = profile.join(sub);
                if p.is_dir() {
                    roots.push(p);
                }
            }
        }
    }
    roots
}

fn is_forbidden_root(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.len() <= 3 && lower.ends_with(":\\") {
        // Never crawl an entire drive root (e.g. C:\) automatically.
        return true;
    }
    for comp in path.components() {
        let s = comp.as_os_str().to_string_lossy().to_ascii_lowercase();
        if matches!(
            s.as_str(),
            "windows" | "program files" | "program files (x86)" | "appdata" | "$recycle.bin"
        ) {
            return true;
        }
    }
    false
}

fn push_root(
    roots: &mut Vec<SearchRoot>,
    seen: &mut HashSet<String>,
    raw_path: &Path,
    max_depth: usize,
    in_saved_series: bool,
    opts: LocalPathOptions,
) {
    let raw_str = raw_path.to_string_lossy();
    if validate_local_path_syntax_with_options(&raw_str, opts).is_err() {
        return;
    }
    if !raw_path.is_dir() || is_forbidden_root(raw_path) {
        return;
    }
    let key = raw_str
        .trim()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase();
    if let Some(idx) = roots.iter().position(|r| {
        r.path
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .eq_ignore_ascii_case(&key)
    }) {
        roots[idx].max_depth = roots[idx].max_depth.max(max_depth);
        roots[idx].in_saved_series = roots[idx].in_saved_series || in_saved_series;
        return;
    }
    if seen.insert(key) {
        roots.push(SearchRoot {
            path: raw_path.to_path_buf(),
            max_depth,
            in_saved_series,
        });
    }
}

fn build_search_roots(req: &FindLocalMatchesRequest, opts: LocalPathOptions) -> Vec<SearchRoot> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    for raw in &req.saved_series_folders {
        push_root(&mut roots, &mut seen, Path::new(raw.trim()), 3, true, opts);
    }
    for raw in &req.recent_folders {
        push_root(&mut roots, &mut seen, Path::new(raw.trim()), 2, false, opts);
    }
    for raw in &req.custom_library_folders {
        push_root(&mut roots, &mut seen, Path::new(raw.trim()), 4, false, opts);
    }
    for p in default_user_roots() {
        push_root(&mut roots, &mut seen, &p, 4, false, opts);
    }
    roots
}

fn system_time_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn should_skip_dir(name: &str, attrs: u32) -> bool {
    if (attrs & (FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 {
        return true;
    }
    let lower = name.trim().to_ascii_lowercase();
    if lower.starts_with('.') || ((attrs & FILE_ATTRIBUTE_HIDDEN) != 0 && lower != "appdata") {
        return true;
    }
    SKIP_DIR_NAMES.contains(&lower.as_str())
}

fn extract_parent_labels(path: &Path) -> (Option<String>, Option<String>) {
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let grandparent = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    (parent, grandparent)
}

fn crawl_media_roots(roots: &[SearchRoot]) -> Vec<IndexedMediaEntry> {
    let started = Instant::now();
    let mut visited_dirs: HashSet<String> = HashSet::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    let mut inspected_entries = 0usize;

    for root in roots {
        if started.elapsed().as_millis() >= MAX_CRAWL_MS as u128
            || inspected_entries >= MAX_CRAWL_ENTRIES
        {
            break;
        }
        let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
        queue.push_back((root.path.clone(), 0));

        while let Some((dir, depth)) = queue.pop_front() {
            if started.elapsed().as_millis() >= MAX_CRAWL_MS as u128
                || inspected_entries >= MAX_CRAWL_ENTRIES
            {
                break;
            }
            let dir_key = if depth == 0 {
                dir.canonicalize()
                    .unwrap_or_else(|_| dir.clone())
                    .to_string_lossy()
                    .to_ascii_lowercase()
            } else {
                dir.to_string_lossy().to_ascii_lowercase()
            };
            if !visited_dirs.insert(dir_key) {
                continue;
            }

            let Ok(read_dir) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in read_dir.flatten() {
                inspected_entries += 1;
                if inspected_entries >= MAX_CRAWL_ENTRIES
                    || started.elapsed().as_millis() >= MAX_CRAWL_MS as u128
                {
                    break;
                }
                let path = entry.path();
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let attrs = meta.file_attributes();

                if meta.is_dir() {
                    if depth < root.max_depth {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if !should_skip_dir(&name, attrs) {
                            queue.push_back((path, depth + 1));
                        }
                    }
                    continue;
                }

                if !meta.is_file() || !is_video_path(&path) {
                    continue;
                }
                let path_str = path.to_string_lossy().to_string();
                let path_lower = path_str.to_ascii_lowercase();
                if !seen_files.insert(path_lower) {
                    continue;
                }
                let file_name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if file_name.is_empty() {
                    continue;
                }
                let (parent_folder, grandparent_folder) = extract_parent_labels(&path);
                let mtime_ms = meta.modified().map(system_time_to_ms).unwrap_or(0);
                out.push(IndexedMediaEntry {
                    path: path_str,
                    file_name,
                    parent_folder,
                    grandparent_folder,
                    size_bytes: meta.len(),
                    mtime_ms,
                    is_cloud_placeholder: is_cloud_placeholder_attrs(attrs),
                    in_saved_series: root.in_saved_series,
                });
            }
        }
    }

    out
}

pub fn parse_ffmpeg_duration_secs(stderr: &str) -> Option<f64> {
    let marker = "Duration:";
    let idx = stderr.find(marker)?;
    let rest = stderr[idx + marker.len()..].trim_start();
    let end = rest.find([',', ' ', '\r', '\n']).unwrap_or(rest.len());
    let token = rest[..end].trim();
    if token.eq_ignore_ascii_case("N/A") {
        return None;
    }
    let mut parts = token.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let total = h * 3600.0 + m * 60.0 + s;
    (total.is_finite() && total > 0.0).then_some(total)
}

async fn probe_duration_with_ffmpeg(ffmpeg_exe: &Path, file_path: &Path) -> Option<f64> {
    let mut cmd = tokio::process::Command::new(ffmpeg_exe);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i")
        .arg(file_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);

    let output = tokio::time::timeout(FFMPEG_PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_ffmpeg_duration_secs(&stderr)
}

impl MediaLibraryState {
    pub async fn find_matches(
        &self,
        app: &AppHandle,
        req: FindLocalMatchesRequest,
        opts: LocalPathOptions,
    ) -> Vec<LocalMatchCandidate> {
        let clean_peer_name = strip_unsafe_unicode(&req.peer_file_name);
        let peer_name = clean_peer_name.trim();
        if peer_name.is_empty() || peer_name.chars().count() > 260 {
            return Vec::new();
        }

        let roots = build_search_roots(&req, opts);
        if roots.is_empty() {
            return Vec::new();
        }
        let roots_sig = roots
            .iter()
            .map(|r| {
                format!(
                    "{}@{}",
                    r.path.to_string_lossy().to_ascii_lowercase(),
                    r.max_depth
                )
            })
            .collect::<Vec<_>>()
            .join("|");

        let cached_entries = if !req.force_refresh {
            self.index.lock().ok().and_then(|guard| {
                if guard.roots_sig == roots_sig
                    && guard.built_at.is_some_and(|t| t.elapsed() < INDEX_TTL)
                {
                    Some(guard.entries.clone())
                } else {
                    None
                }
            })
        } else {
            None
        };

        let entries = match cached_entries {
            Some(existing) => existing,
            None => {
                let roots_for_crawl = roots.clone();
                let crawled =
                    tokio::task::spawn_blocking(move || crawl_media_roots(&roots_for_crawl))
                        .await
                        .unwrap_or_default();
                if let Ok(mut guard) = self.index.lock() {
                    guard.built_at = Some(Instant::now());
                    guard.roots_sig = roots_sig;
                    guard.entries = crawled.clone();
                }
                crawled
            }
        };

        if entries.is_empty() {
            return Vec::new();
        }

        let peer_dur = req.peer_duration_secs.filter(|d| d.is_finite() && *d > 1.0);
        let mut initial_scored: Vec<(usize, LocalMatchCandidate)> = Vec::new();
        for (idx, entry) in entries.iter().enumerate() {
            let key = DurationCacheKey {
                path_lower: entry.path.to_ascii_lowercase(),
                size_bytes: entry.size_bytes,
                mtime_ms: entry.mtime_ms,
            };
            let cached_dur = self
                .durations
                .lock()
                .ok()
                .and_then(|g| g.get(&key).copied().flatten());

            let cand_input = LocalCandidateInput {
                path: entry.path.clone(),
                file_name: entry.file_name.clone(),
                parent_folder: entry.parent_folder.clone(),
                grandparent_folder: entry.grandparent_folder.clone(),
                size_bytes: entry.size_bytes,
                duration_secs: cached_dur,
                is_cloud_placeholder: entry.is_cloud_placeholder,
                in_saved_series: entry.in_saved_series,
            };

            let allow_unprobed =
                cached_dur.is_none() && !entry.is_cloud_placeholder && peer_dur.is_some();
            if let Some(m) =
                score_local_candidate_with_options(peer_name, peer_dur, &cand_input, allow_unprobed)
            {
                initial_scored.push((idx, m));
            }
        }

        initial_scored.sort_by(|a, b| {
            b.1.score
                .partial_cmp(&a.1.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Probe duration only for top N non-cloud candidates whose duration is not yet cached.
        if peer_dur.is_some() && !initial_scored.is_empty() {
            if let Some(ffmpeg_exe) = crate::mpv::process::resolve_ffmpeg_exe(app) {
                let mut probed = 0usize;
                for (entry_idx, _) in initial_scored.iter().take(PROBE_TOP_N) {
                    if probed >= PROBE_TOP_N {
                        break;
                    }
                    let entry = &entries[*entry_idx];
                    if entry.is_cloud_placeholder {
                        continue;
                    }
                    let key = DurationCacheKey {
                        path_lower: entry.path.to_ascii_lowercase(),
                        size_bytes: entry.size_bytes,
                        mtime_ms: entry.mtime_ms,
                    };
                    let already_known = self
                        .durations
                        .lock()
                        .ok()
                        .is_some_and(|g| g.contains_key(&key));
                    if already_known {
                        continue;
                    }
                    probed += 1;
                    let dur = probe_duration_with_ffmpeg(&ffmpeg_exe, Path::new(&entry.path)).await;
                    if let Ok(mut guard) = self.durations.lock() {
                        if guard.len() >= DURATION_CACHE_MAX {
                            guard.clear();
                        }
                        guard.insert(key, dur);
                    }
                }
            }
        }

        let mut final_matches: Vec<LocalMatchCandidate> = initial_scored
            .into_iter()
            .filter_map(|(idx, _)| {
                let entry = &entries[idx];
                let key = DurationCacheKey {
                    path_lower: entry.path.to_ascii_lowercase(),
                    size_bytes: entry.size_bytes,
                    mtime_ms: entry.mtime_ms,
                };
                let dur = self
                    .durations
                    .lock()
                    .ok()
                    .and_then(|g| g.get(&key).copied().flatten());
                let cand_input = LocalCandidateInput {
                    path: entry.path.clone(),
                    file_name: entry.file_name.clone(),
                    parent_folder: entry.parent_folder.clone(),
                    grandparent_folder: entry.grandparent_folder.clone(),
                    size_bytes: entry.size_bytes,
                    duration_secs: dur,
                    is_cloud_placeholder: entry.is_cloud_placeholder,
                    in_saved_series: entry.in_saved_series,
                };
                score_local_candidate(peer_name, peer_dur, &cand_input)
            })
            .collect();

        final_matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.file_name.cmp(&b.file_name))
        });
        final_matches.truncate(5);
        final_matches
    }
}

pub fn check_local_files_exist(paths: &[String], opts: LocalPathOptions) -> Vec<bool> {
    paths
        .iter()
        .map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() || validate_local_path_syntax_with_options(trimmed, opts).is_err()
            {
                return false;
            }
            Path::new(trimmed).is_file()
        })
        .collect()
}

pub fn dpapi_protect_secret(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    let bytes = plaintext.as_bytes();
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            ptr::null(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err("Could not encrypt local room password with Windows DPAPI.".to_string());
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let encoded = encode_base64_url(slice);
    unsafe {
        LocalFree(out_blob.pbData as *mut _);
    }
    Ok(encoded)
}

pub fn dpapi_unprotect_secret(encoded: &str) -> Result<String, String> {
    if encoded.is_empty() {
        return Ok(String::new());
    }
    let bytes = decode_base64_url(encoded)
        .ok_or_else(|| "Invalid encrypted secret encoding.".to_string())?;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            ptr::null_mut(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err("Could not decrypt local room password with Windows DPAPI.".to_string());
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let text = String::from_utf8(slice.to_vec())
        .map_err(|_| "Decrypted password was not valid UTF-8.".to_string());
    unsafe {
        LocalFree(out_blob.pbData as *mut _);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_duration_line() {
        let stderr = "  Duration: 01:42:15.50, start: 0.000000, bitrate: 4200 kb/s\n";
        let d = parse_ffmpeg_duration_secs(stderr).unwrap();
        assert!((d - 6135.5).abs() < 1e-6);
        assert!(parse_ffmpeg_duration_secs("Duration: N/A, bitrate: N/A").is_none());
    }

    #[test]
    fn cloud_placeholder_flags_are_detected() {
        assert!(!is_cloud_placeholder_attrs(0x20)); // ARCHIVE
        assert!(is_cloud_placeholder_attrs(FILE_ATTRIBUTE_OFFLINE));
        assert!(is_cloud_placeholder_attrs(
            FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
        ));
        assert!(is_cloud_placeholder_attrs(FILE_ATTRIBUTE_RECALL_ON_OPEN));
    }

    #[test]
    fn dpapi_roundtrip_protects_and_restores_password() {
        let secret = "My-Squad-Pass-2026!";
        let protected = dpapi_protect_secret(secret).expect("dpapi protect");
        assert_ne!(protected, secret);
        let restored = dpapi_unprotect_secret(&protected).expect("dpapi unprotect");
        assert_eq!(restored, secret);
    }

    #[test]
    fn crawl_media_roots_respects_depth_and_filters_videos() {
        let tmp = std::env::temp_dir().join(format!("epilod_crawl_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let nested = tmp.join("Show").join("Season 1");
        let hidden = tmp.join(".hidden");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&hidden).unwrap();
        fs::write(nested.join("01.mkv"), b"video").unwrap();
        fs::write(nested.join("notes.txt"), b"text").unwrap();
        fs::write(hidden.join("secret.mkv"), b"ignored").unwrap();

        let roots = vec![SearchRoot {
            path: tmp.clone(),
            max_depth: 3,
            in_saved_series: true,
        }];
        let entries = crawl_media_roots(&roots);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_name, "01.mkv");
        assert_eq!(entries[0].parent_folder.as_deref(), Some("Season 1"));
        assert_eq!(entries[0].grandparent_folder.as_deref(), Some("Show"));
        assert!(entries[0].in_saved_series);

        let _ = fs::remove_dir_all(&tmp);
    }
}
