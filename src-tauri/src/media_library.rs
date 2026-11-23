#![cfg(windows)]

use epilod_core::matching::{
    score_prepared_local_candidate_parts, LocalMatchCandidate, LocalMatchConfidence,
    PreparedLocalCandidate, PreparedPeerQuery,
};
use epilod_core::p2p::{decode_base64_url, encode_base64_url};
use epilod_core::playlist::is_video_path;
use epilod_core::validation::{
    strip_unsafe_unicode, validate_local_path_syntax_with_options, LocalPathOptions,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Arc, Mutex};
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
const INDEX_TTL: Duration = Duration::from_secs(180);
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
    "games",
    "steamlibrary",
    "epic games",
];

#[derive(Debug, Clone)]
struct IndexedMediaEntry {
    path: String,
    path_lower: String,
    file_name: String,
    parent_folder: Option<String>,
    size_bytes: u64,
    mtime_ms: u64,
    is_cloud_placeholder: bool,
    in_saved_series: bool,
    prepared: PreparedLocalCandidate,
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
    root_mtimes: Vec<(String, u64)>,
    entries: Arc<Vec<IndexedMediaEntry>>,
}

#[derive(Default)]
pub struct MediaLibraryState {
    index: Mutex<IndexSnapshot>,
    default_index: Mutex<IndexSnapshot>,
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

fn build_tier1_roots(req: &FindLocalMatchesRequest, opts: LocalPathOptions) -> Vec<SearchRoot> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for raw in &req.saved_series_folders {
        push_root(&mut roots, &mut seen, Path::new(raw.trim()), 3, true, opts);
    }
    for raw in &req.recent_folders {
        push_root(&mut roots, &mut seen, Path::new(raw.trim()), 2, false, opts);
    }
    roots
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

fn compute_roots_sig(roots: &[SearchRoot]) -> String {
    roots
        .iter()
        .map(|r| {
            format!(
                "{}@{}",
                r.path.to_string_lossy().to_ascii_lowercase(),
                r.max_depth
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn snapshot_root_mtimes(roots: &[SearchRoot]) -> Vec<(String, u64)> {
    roots
        .iter()
        .map(|r| {
            let mtime = fs::metadata(&r.path)
                .and_then(|m| m.modified())
                .map(system_time_to_ms)
                .unwrap_or(0);
            (r.path.to_string_lossy().to_ascii_lowercase(), mtime)
        })
        .collect()
}

fn roots_mtimes_match(roots: &[SearchRoot], stored: &[(String, u64)]) -> bool {
    if roots.len() != stored.len() {
        return false;
    }
    for (root, (stored_path, stored_mtime)) in roots.iter().zip(stored.iter()) {
        if !root
            .path
            .to_string_lossy()
            .eq_ignore_ascii_case(stored_path)
        {
            return false;
        }
        let cur = fs::metadata(&root.path)
            .and_then(|m| m.modified())
            .map(system_time_to_ms)
            .unwrap_or(0);
        if cur != *stored_mtime {
            return false;
        }
    }
    true
}

fn system_time_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn should_skip_dir_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower.starts_with('.') || SKIP_DIR_NAMES.contains(&lower.as_str())
}

fn should_skip_dir_attrs(name: &str, attrs: u32) -> bool {
    if (attrs & (FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 {
        return true;
    }
    let lower = name.trim().to_ascii_lowercase();
    (attrs & FILE_ATTRIBUTE_HIDDEN) != 0 && lower != "appdata"
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

                // Use free WIN32_FIND_DATA file_type before incurring an extra metadata syscall.
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if ft.is_dir() {
                    if depth < root.max_depth {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if should_skip_dir_name(&name) {
                            continue;
                        }
                        if let Ok(meta) = entry.metadata() {
                            if !should_skip_dir_attrs(&name, meta.file_attributes()) {
                                queue.push_back((entry.path(), depth + 1));
                            }
                        }
                    }
                    continue;
                }

                if !ft.is_file() {
                    continue;
                }
                let path = entry.path();
                if !is_video_path(&path) {
                    continue;
                }

                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let attrs = meta.file_attributes();
                let path_str = path.to_string_lossy().to_string();
                let path_lower = path_str.to_ascii_lowercase();
                if !seen_files.insert(path_lower.clone()) {
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
                let prepared = PreparedLocalCandidate::new(
                    &file_name,
                    parent_folder.as_deref(),
                    grandparent_folder.as_deref(),
                );
                let mtime_ms = meta.modified().map(system_time_to_ms).unwrap_or(0);
                out.push(IndexedMediaEntry {
                    path: path_str,
                    path_lower,
                    file_name,
                    parent_folder,
                    size_bytes: meta.len(),
                    mtime_ms,
                    is_cloud_placeholder: is_cloud_placeholder_attrs(attrs),
                    in_saved_series: root.in_saved_series,
                    prepared,
                });
            }
        }
    }

    out
}

fn parse_mp4_mvhd_duration(file: &mut File, data_start: u64, data_end: u64) -> Option<f64> {
    let mut pos = data_start;
    let mut hdr = [0u8; 8];
    let mut ext = [0u8; 8];
    for _ in 0..64 {
        if pos + 8 > data_end {
            break;
        }
        file.seek(SeekFrom::Start(pos)).ok()?;
        file.read_exact(&mut hdr).ok()?;
        let size32 = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
        let tag = [hdr[4], hdr[5], hdr[6], hdr[7]];
        let (box_size, header_len) = if size32 == 1 {
            if pos + 16 > data_end {
                break;
            }
            file.read_exact(&mut ext).ok()?;
            (u64::from_be_bytes(ext), 16u64)
        } else if size32 == 0 {
            (data_end.saturating_sub(pos), 8u64)
        } else {
            (size32 as u64, 8u64)
        };
        if box_size < header_len || pos.saturating_add(box_size) > data_end {
            break;
        }
        if tag == *b"mvhd" {
            let payload_len = (box_size - header_len).min(36) as usize;
            if payload_len < 20 {
                return None;
            }
            let mut buf = [0u8; 36];
            file.read_exact(&mut buf[..payload_len]).ok()?;
            let version = buf[0];
            let (timescale, duration) = if version == 0 && payload_len >= 20 {
                let ts = u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]);
                let dur = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
                if dur == u32::MAX {
                    return None;
                }
                (ts, dur as u64)
            } else if version == 1 && payload_len >= 32 {
                let ts = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
                let dur = u64::from_be_bytes([
                    buf[24], buf[25], buf[26], buf[27], buf[28], buf[29], buf[30], buf[31],
                ]);
                if dur == u64::MAX {
                    return None;
                }
                (ts, dur)
            } else {
                return None;
            };
            if timescale > 0 && duration > 0 {
                let secs = duration as f64 / timescale as f64;
                if secs.is_finite() && secs > 1.0 && secs < 604_800.0 {
                    return Some(secs);
                }
            }
            return None;
        }
        pos = pos.saturating_add(box_size);
    }
    None
}

fn probe_mp4_duration(path: &Path) -> Option<f64> {
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut pos = 0u64;
    let mut hdr = [0u8; 8];
    let mut ext = [0u8; 8];
    for idx in 0..64 {
        if pos + 8 > file_len {
            break;
        }
        file.seek(SeekFrom::Start(pos)).ok()?;
        file.read_exact(&mut hdr).ok()?;
        let size32 = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
        let tag = [hdr[4], hdr[5], hdr[6], hdr[7]];
        if idx == 0
            && !matches!(
                &tag,
                b"ftyp" | b"free" | b"skip" | b"wide" | b"mdat" | b"moov"
            )
        {
            return None;
        }
        let (box_size, header_len) = if size32 == 1 {
            if pos + 16 > file_len {
                break;
            }
            file.read_exact(&mut ext).ok()?;
            (u64::from_be_bytes(ext), 16u64)
        } else if size32 == 0 {
            (file_len.saturating_sub(pos), 8u64)
        } else {
            (size32 as u64, 8u64)
        };
        if box_size < header_len || pos.saturating_add(box_size) > file_len {
            break;
        }
        if tag == *b"moov" {
            return parse_mp4_mvhd_duration(&mut file, pos + header_len, pos + box_size);
        }
        pos = pos.saturating_add(box_size);
    }
    None
}

fn read_ebml_id<R: Read>(r: &mut R) -> Option<(u32, usize)> {
    let mut b0 = [0u8; 1];
    r.read_exact(&mut b0).ok()?;
    if b0[0] == 0 {
        return None;
    }
    let len = (b0[0].leading_zeros() as usize) + 1;
    if len > 4 {
        return None;
    }
    let mut id = b0[0] as u32;
    for _ in 1..len {
        let mut b = [0u8; 1];
        r.read_exact(&mut b).ok()?;
        id = (id << 8) | (b[0] as u32);
    }
    Some((id, len))
}

fn read_ebml_size<R: Read>(r: &mut R) -> Option<(Option<u64>, usize)> {
    let mut b0 = [0u8; 1];
    r.read_exact(&mut b0).ok()?;
    if b0[0] == 0 {
        return None;
    }
    let lz = b0[0].leading_zeros() as usize;
    let len = lz + 1;
    if len > 8 {
        return None;
    }
    let mask = if lz >= 7 { 0 } else { (1u8 << (7 - lz)) - 1 };
    let mut val = (b0[0] & mask) as u64;
    for _ in 1..len {
        let mut b = [0u8; 1];
        r.read_exact(&mut b).ok()?;
        val = (val << 8) | (b[0] as u64);
    }
    let all_ones = (1u64 << (7 * len)) - 1;
    if val == all_ones {
        Some((None, len))
    } else {
        Some((Some(val), len))
    }
}

fn parse_mkv_info_duration(buf: &[u8]) -> Option<f64> {
    let mut cursor = std::io::Cursor::new(buf);
    let mut timestamp_scale: u64 = 1_000_000;
    let mut duration_ticks: Option<f64> = None;

    while (cursor.position() as usize) < buf.len() {
        let (id, _) = read_ebml_id(&mut cursor)?;
        let (Some(sz), _) = read_ebml_size(&mut cursor)? else {
            break;
        };
        let pos = cursor.position() as usize;
        let end = pos.saturating_add(sz as usize);
        if end > buf.len() {
            break;
        }
        let slice = &buf[pos..end];
        if id == 0x2AD7B1 && (1..=8).contains(&slice.len()) {
            let mut val = 0u64;
            for &b in slice {
                val = (val << 8) | (b as u64);
            }
            if val > 0 {
                timestamp_scale = val;
            }
        } else if id == 0x4489 {
            if slice.len() == 4 {
                duration_ticks =
                    Some(f32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]) as f64);
            } else if slice.len() == 8 {
                duration_ticks = Some(f64::from_be_bytes([
                    slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
                ]));
            }
        }
        cursor.set_position(end as u64);
    }

    let ticks = duration_ticks?;
    let secs = (ticks * (timestamp_scale as f64)) / 1_000_000_000.0;
    (secs.is_finite() && secs > 1.0 && secs < 604_800.0).then_some(secs)
}

fn probe_mkv_duration(path: &Path) -> Option<f64> {
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();

    let (first_id, _) = read_ebml_id(&mut file)?;
    if first_id != 0x1A45DFA3 {
        return None;
    }
    let (Some(ebml_sz), _) = read_ebml_size(&mut file)? else {
        return None;
    };
    let mut pos = file.stream_position().ok()?.saturating_add(ebml_sz);

    let mut seg_start = None;
    let mut seg_end = file_len;
    for _ in 0..16 {
        if pos >= file_len {
            break;
        }
        file.seek(SeekFrom::Start(pos)).ok()?;
        let (id, id_len) = read_ebml_id(&mut file)?;
        let (sz_opt, sz_len) = read_ebml_size(&mut file)?;
        let data_start = pos + (id_len as u64) + (sz_len as u64);
        if id == 0x18538067 {
            seg_start = Some(data_start);
            if let Some(sz) = sz_opt {
                seg_end = data_start.saturating_add(sz).min(file_len);
            }
            break;
        }
        let sz = sz_opt?;
        pos = data_start.saturating_add(sz);
    }

    let mut child_pos = seg_start?;
    for _ in 0..64 {
        if child_pos >= seg_end {
            break;
        }
        file.seek(SeekFrom::Start(child_pos)).ok()?;
        let (id, id_len) = read_ebml_id(&mut file)?;
        let (Some(sz), sz_len) = read_ebml_size(&mut file)? else {
            break;
        };
        let data_start = child_pos + (id_len as u64) + (sz_len as u64);
        let next_pos = data_start.saturating_add(sz);
        if next_pos > seg_end {
            break;
        }
        if id == 0x1549A966 {
            let cap = (sz as usize).min(64 * 1024);
            let mut buf = vec![0u8; cap];
            file.read_exact(&mut buf).ok()?;
            return parse_mkv_info_duration(&buf);
        }
        if id == 0x1F43B675 {
            break;
        }
        child_pos = next_pos;
    }
    None
}

/// Fast pure-Rust Seek-based duration parser for common MKV/WebM and MP4/M4V/MOV containers.
/// Never invoke on cloud placeholders (calling `File::open` would trigger a Windows download).
pub fn probe_duration_fast_header(path: &Path) -> Option<f64> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())?;
    match ext.as_str() {
        "mp4" | "m4v" | "mov" => probe_mp4_duration(path),
        "mkv" | "webm" => probe_mkv_duration(path),
        _ => None,
    }
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

fn make_duration_key(entry: &IndexedMediaEntry) -> DurationCacheKey {
    DurationCacheKey {
        path_lower: entry.path_lower.clone(),
        size_bytes: entry.size_bytes,
        mtime_ms: entry.mtime_ms,
    }
}

fn is_strict_high_confidence_match(m: &LocalMatchCandidate, peer_name: &str) -> bool {
    if m.confidence != LocalMatchConfidence::High {
        return false;
    }
    m.duration_delta_secs
        .is_some_and(|delta| delta.abs() <= 2.5)
        || m.file_name.eq_ignore_ascii_case(peer_name)
}

fn score_entries_with_cache(
    entries: &[IndexedMediaEntry],
    peer: &PreparedPeerQuery,
    durations: &HashMap<DurationCacheKey, Option<f64>>,
    allow_unprobed_with_peer_dur: bool,
) -> Vec<(usize, LocalMatchCandidate)> {
    let mut out = Vec::new();
    for (idx, entry) in entries.iter().enumerate() {
        let key = make_duration_key(entry);
        let cached_dur = durations.get(&key).copied().flatten();
        let allow_unprobed =
            allow_unprobed_with_peer_dur && cached_dur.is_none() && !entry.is_cloud_placeholder;
        if let Some(m) = score_prepared_local_candidate_parts(
            peer,
            &entry.prepared,
            &entry.path,
            &entry.file_name,
            entry.parent_folder.as_deref(),
            entry.size_bytes,
            cached_dur,
            entry.is_cloud_placeholder,
            entry.in_saved_series,
            allow_unprobed,
        ) {
            out.push((idx, m));
        }
    }
    out
}

impl MediaLibraryState {
    pub async fn prewarm_default_roots(&self, opts: LocalPathOptions) {
        let already_warm = self
            .default_index
            .lock()
            .ok()
            .is_some_and(|g| g.built_at.is_some());
        if already_warm {
            return;
        }
        let empty_req = FindLocalMatchesRequest {
            peer_file_name: String::new(),
            peer_duration_secs: None,
            saved_series_folders: Vec::new(),
            recent_folders: Vec::new(),
            custom_library_folders: Vec::new(),
            force_refresh: false,
        };
        let roots = build_search_roots(&empty_req, opts);
        if roots.is_empty() {
            return;
        }
        let roots_sig = compute_roots_sig(&roots);
        let roots_for_crawl = roots.clone();
        let (crawled, root_mtimes) = tokio::task::spawn_blocking(move || {
            let mtimes = snapshot_root_mtimes(&roots_for_crawl);
            let entries = crawl_media_roots(&roots_for_crawl);
            (entries, mtimes)
        })
        .await
        .unwrap_or_default();

        if let Ok(mut guard) = self.default_index.lock() {
            if guard.built_at.is_none() {
                guard.built_at = Some(Instant::now());
                guard.roots_sig = roots_sig;
                guard.root_mtimes = root_mtimes;
                guard.entries = Arc::new(crawled);
            }
        }
    }

    async fn match_against_entries(
        &self,
        app: &AppHandle,
        entries: &[IndexedMediaEntry],
        peer: &PreparedPeerQuery,
        peer_name: &str,
    ) -> Vec<LocalMatchCandidate> {
        if entries.is_empty() {
            return Vec::new();
        }

        let mut initial_scored = {
            let guard = self.durations.lock();
            match guard {
                Ok(g) => score_entries_with_cache(entries, peer, &g, peer.peer_dur.is_some()),
                Err(_) => Vec::new(),
            }
        };

        initial_scored.sort_by(|a, b| {
            b.1.score
                .partial_cmp(&a.1.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let top_already_confirmed = initial_scored
            .first()
            .is_some_and(|(_, m)| is_strict_high_confidence_match(m, peer_name));

        // Probe duration only for top N non-cloud candidates whose duration is not yet cached.
        if peer.peer_dur.is_some() && !initial_scored.is_empty() && !top_already_confirmed {
            let top_entry_idx = initial_scored[0].0;
            let to_probe: Vec<(usize, DurationCacheKey, PathBuf)> = {
                let guard = self.durations.lock();
                match guard {
                    Ok(g) => initial_scored
                        .iter()
                        .take(PROBE_TOP_N)
                        .filter_map(|(entry_idx, _)| {
                            let entry = &entries[*entry_idx];
                            if entry.is_cloud_placeholder {
                                return None;
                            }
                            let key = make_duration_key(entry);
                            if g.contains_key(&key) {
                                return None;
                            }
                            Some((*entry_idx, key, PathBuf::from(&entry.path)))
                        })
                        .collect(),
                    Err(_) => Vec::new(),
                }
            };

            if !to_probe.is_empty() {
                let fast_paths: Vec<PathBuf> = to_probe.iter().map(|(_, _, p)| p.clone()).collect();
                let fast_results = tokio::task::spawn_blocking(move || {
                    let mut results: Vec<Option<f64>> = Vec::with_capacity(fast_paths.len());
                    for p in &fast_paths {
                        results.push(probe_duration_fast_header(p));
                    }
                    results
                })
                .await
                .unwrap_or_else(|_| vec![None; to_probe.len()]);

                let mut resolved: Vec<(DurationCacheKey, Option<f64>)> = Vec::new();
                let mut need_ffmpeg: Vec<(DurationCacheKey, PathBuf)> = Vec::new();
                let mut top_confirmed = false;

                for ((entry_idx, key, path), fast_dur) in to_probe.into_iter().zip(fast_results) {
                    if let Some(dur) = fast_dur {
                        resolved.push((key, Some(dur)));
                        if entry_idx == top_entry_idx {
                            let entry = &entries[entry_idx];
                            if let Some(scored) = score_prepared_local_candidate_parts(
                                peer,
                                &entry.prepared,
                                &entry.path,
                                &entry.file_name,
                                entry.parent_folder.as_deref(),
                                entry.size_bytes,
                                Some(dur),
                                entry.is_cloud_placeholder,
                                entry.in_saved_series,
                                false,
                            ) {
                                if is_strict_high_confidence_match(&scored, peer_name) {
                                    top_confirmed = true;
                                }
                            }
                        }
                    } else if !top_confirmed {
                        need_ffmpeg.push((key, path));
                    }
                }

                if !top_confirmed && !need_ffmpeg.is_empty() {
                    if let Some(ffmpeg_exe) = crate::mpv::process::resolve_ffmpeg_exe(app) {
                        let mut join_set = tokio::task::JoinSet::new();
                        for (key, path) in need_ffmpeg {
                            let exe = ffmpeg_exe.clone();
                            join_set.spawn(async move {
                                let dur = probe_duration_with_ffmpeg(&exe, &path).await;
                                (key, dur)
                            });
                        }
                        while let Some(res) = join_set.join_next().await {
                            if let Ok((key, dur)) = res {
                                resolved.push((key, dur));
                            }
                        }
                    }
                }

                if !resolved.is_empty() {
                    if let Ok(mut guard) = self.durations.lock() {
                        if guard.len().saturating_add(resolved.len()) >= DURATION_CACHE_MAX {
                            guard.clear();
                        }
                        for (key, dur) in resolved {
                            guard.insert(key, dur);
                        }
                    }
                }
            }
        }

        let mut final_matches: Vec<LocalMatchCandidate> = {
            let guard = self.durations.lock();
            match guard {
                Ok(g) => initial_scored
                    .into_iter()
                    .filter_map(|(idx, _)| {
                        let entry = &entries[idx];
                        let key = make_duration_key(entry);
                        let dur = g.get(&key).copied().flatten();
                        score_prepared_local_candidate_parts(
                            peer,
                            &entry.prepared,
                            &entry.path,
                            &entry.file_name,
                            entry.parent_folder.as_deref(),
                            entry.size_bytes,
                            dur,
                            entry.is_cloud_placeholder,
                            entry.in_saved_series,
                            false,
                        )
                    })
                    .collect(),
                Err(_) => Vec::new(),
            }
        };

        final_matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.file_name.cmp(&b.file_name))
        });

        // Verify top candidates still exist on disk (off the async executor) so stale index entries never leak through.
        if final_matches.is_empty() {
            return Vec::new();
        }
        tokio::task::spawn_blocking(move || {
            let mut verified = Vec::with_capacity(5);
            for cand in final_matches {
                if fs::metadata(&cand.path).is_ok_and(|md| md.is_file()) {
                    verified.push(cand);
                    if verified.len() >= 5 {
                        break;
                    }
                }
            }
            verified
        })
        .await
        .unwrap_or_default()
    }

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
        let Some(peer_query) = PreparedPeerQuery::new(peer_name, req.peer_duration_secs) else {
            return Vec::new();
        };

        let all_roots = build_search_roots(&req, opts);
        if all_roots.is_empty() {
            return Vec::new();
        }
        let all_roots_sig = compute_roots_sig(&all_roots);

        let index_candidate = if !req.force_refresh {
            self.index.lock().ok().and_then(|guard| {
                if guard.roots_sig == all_roots_sig
                    && guard.built_at.is_some_and(|t| t.elapsed() < INDEX_TTL)
                {
                    Some((guard.root_mtimes.clone(), Arc::clone(&guard.entries)))
                } else {
                    None
                }
            })
        } else {
            if let Ok(mut guard) = self.default_index.lock() {
                guard.built_at = None;
            }
            None
        };

        let cached_entries = if let Some((stored_mtimes, entries)) = index_candidate {
            let roots_for_check = all_roots.clone();
            let valid = tokio::task::spawn_blocking(move || {
                roots_mtimes_match(&roots_for_check, &stored_mtimes)
            })
            .await
            .unwrap_or(false);
            valid.then_some(entries)
        } else {
            None
        };

        if let Some(entries) = cached_entries {
            return self
                .match_against_entries(app, &entries, &peer_query, peer_name)
                .await;
        }

        // Cold / invalidated index: check Tier 1 (saved series + recent folders) first for instant match.
        let tier1_roots = if !req.force_refresh {
            build_tier1_roots(&req, opts)
        } else {
            Vec::new()
        };

        let mut tier1_entries: Vec<IndexedMediaEntry> = Vec::new();
        if !tier1_roots.is_empty() && tier1_roots.len() < all_roots.len() {
            let t1_for_crawl = tier1_roots.clone();
            tier1_entries = tokio::task::spawn_blocking(move || crawl_media_roots(&t1_for_crawl))
                .await
                .unwrap_or_default();
            if !tier1_entries.is_empty() {
                let tier1_matches = self
                    .match_against_entries(app, &tier1_entries, &peer_query, peer_name)
                    .await;
                if tier1_matches
                    .first()
                    .is_some_and(|m| is_strict_high_confidence_match(m, peer_name))
                {
                    return tier1_matches;
                }
            }
        }

        // Crawl remaining Tier 2 roots (or full roots when force_refresh) without duplicating Tier 1 or pre-warmed default roots.
        let tier1_keys: HashSet<String> = tier1_roots
            .iter()
            .map(|r| {
                format!(
                    "{}@{}",
                    r.path.to_string_lossy().to_ascii_lowercase(),
                    r.max_depth
                )
            })
            .collect();
        let tier2_roots: Vec<SearchRoot> = if tier1_keys.is_empty() {
            all_roots.clone()
        } else {
            all_roots
                .iter()
                .filter(|r| {
                    let k = format!(
                        "{}@{}",
                        r.path.to_string_lossy().to_ascii_lowercase(),
                        r.max_depth
                    );
                    !tier1_keys.contains(&k)
                })
                .cloned()
                .collect()
        };

        let default_candidate = if !req.force_refresh {
            self.default_index.lock().ok().and_then(|guard| {
                if guard.built_at.is_some_and(|t| t.elapsed() < INDEX_TTL) {
                    Some((guard.root_mtimes.clone(), Arc::clone(&guard.entries)))
                } else {
                    None
                }
            })
        } else {
            None
        };

        let all_for_mtimes = all_roots.clone();
        let (tier2_entries, root_mtimes, reused_default) = tokio::task::spawn_blocking(move || {
            let mtimes = snapshot_root_mtimes(&all_for_mtimes);
            let mut valid_default: Option<Arc<Vec<IndexedMediaEntry>>> = None;
            let roots_to_crawl = if let Some((def_mtimes, def_entries)) = default_candidate {
                let def_check_roots: Vec<SearchRoot> = def_mtimes
                    .iter()
                    .map(|(p, _)| SearchRoot {
                        path: PathBuf::from(p),
                        max_depth: 4,
                        in_saved_series: false,
                    })
                    .collect();
                if !def_check_roots.is_empty() && roots_mtimes_match(&def_check_roots, &def_mtimes)
                {
                    let default_paths: HashSet<String> = def_mtimes
                        .iter()
                        .map(|(p, _)| p.trim_end_matches(['\\', '/']).to_string())
                        .collect();
                    valid_default = Some(def_entries);
                    tier2_roots
                        .into_iter()
                        .filter(|r| {
                            let key = r
                                .path
                                .to_string_lossy()
                                .trim_end_matches(['\\', '/'])
                                .to_ascii_lowercase();
                            !(!r.in_saved_series
                                && r.max_depth == 4
                                && default_paths.contains(key.as_str()))
                        })
                        .collect()
                } else {
                    tier2_roots
                }
            } else {
                tier2_roots
            };

            let entries = if roots_to_crawl.is_empty() {
                Vec::new()
            } else {
                crawl_media_roots(&roots_to_crawl)
            };
            (entries, mtimes, valid_default)
        })
        .await
        .unwrap_or_default();

        let shared_entries = if tier1_entries.is_empty() && tier2_entries.is_empty() {
            reused_default.unwrap_or_else(|| Arc::new(Vec::new()))
        } else {
            let mut combined = tier1_entries;
            let mut seen: HashSet<String> = combined.iter().map(|e| e.path_lower.clone()).collect();
            for entry in tier2_entries {
                if seen.insert(entry.path_lower.clone()) {
                    combined.push(entry);
                }
            }
            if let Some(def_entries) = reused_default {
                for entry in def_entries.iter() {
                    if seen.insert(entry.path_lower.clone()) {
                        combined.push(entry.clone());
                    }
                }
            }
            Arc::new(combined)
        };

        if let Ok(mut guard) = self.index.lock() {
            guard.built_at = Some(Instant::now());
            guard.roots_sig = all_roots_sig;
            guard.root_mtimes = root_mtimes;
            guard.entries = Arc::clone(&shared_entries);
        }

        self.match_against_entries(app, &shared_entries, &peer_query, peer_name)
            .await
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
        assert_eq!(entries[0].prepared.local_id.title, "show");
        assert!(entries[0].in_saved_series);

        let _ = fs::remove_dir_all(&tmp);
    }

    fn make_mp4_box(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let total_len = (8 + payload.len()) as u32;
        let mut out = Vec::with_capacity(total_len as usize);
        out.extend_from_slice(&total_len.to_be_bytes());
        out.extend_from_slice(tag);
        out.extend_from_slice(payload);
        out
    }

    fn make_ebml_vint_size(val: u64) -> Vec<u8> {
        if val < 0x7F {
            vec![0x80 | (val as u8)]
        } else {
            let mut out = (val | 0x4000).to_be_bytes()[6..8].to_vec();
            if val >= 0x3FFF {
                out = (val | 0x0020_0000).to_be_bytes()[5..8].to_vec();
            }
            out
        }
    }

    fn make_ebml_elem(id: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(id.len() + 4 + payload.len());
        out.extend_from_slice(id);
        out.extend_from_slice(&make_ebml_vint_size(payload.len() as u64));
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn fast_header_probe_parses_mp4_v0_v1_and_fragmented() {
        let tmp =
            std::env::temp_dir().join(format!("epilod_mp4_probe_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // 1) MP4 v0 with moov at start (timescale=1000, duration=1445000 -> 1445.0s)
        let mut mvhd_v0 = vec![0u8; 24];
        mvhd_v0[0] = 0;
        mvhd_v0[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd_v0[16..20].copy_from_slice(&1_445_000u32.to_be_bytes());
        let moov_v0 = make_mp4_box(b"moov", &make_mp4_box(b"mvhd", &mvhd_v0));
        let mut bytes_v0 = make_mp4_box(b"ftyp", b"isom\x00\x00\x02\x00");
        bytes_v0.extend_from_slice(&moov_v0);
        let p_v0 = tmp.join("faststart.mp4");
        fs::write(&p_v0, bytes_v0).unwrap();
        let d0 = probe_duration_fast_header(&p_v0).expect("mp4 v0 duration");
        assert!((d0 - 1445.0).abs() < 1e-6);

        // 2) MP4 v1 with moov AFTER mdat (timescale=600, duration=3600000 -> 6000.0s)
        let mut mvhd_v1 = vec![0u8; 36];
        mvhd_v1[0] = 1;
        mvhd_v1[20..24].copy_from_slice(&600u32.to_be_bytes());
        mvhd_v1[24..32].copy_from_slice(&3_600_000u64.to_be_bytes());
        let moov_v1 = make_mp4_box(b"moov", &make_mp4_box(b"mvhd", &mvhd_v1));
        let mut bytes_v1 = make_mp4_box(b"ftyp", b"isom\x00\x00\x02\x00");
        bytes_v1.extend_from_slice(&make_mp4_box(b"mdat", &[0u8; 256]));
        bytes_v1.extend_from_slice(&moov_v1);
        let p_v1 = tmp.join("moov_end.m4v");
        fs::write(&p_v1, bytes_v1).unwrap();
        let d1 = probe_duration_fast_header(&p_v1).expect("mp4 v1 duration");
        assert!((d1 - 6000.0).abs() < 1e-6);

        // 3) Fragmented MP4 (duration == 0) returns None so ffmpeg fallback runs
        let mut mvhd_frag = vec![0u8; 24];
        mvhd_frag[12..16].copy_from_slice(&1000u32.to_be_bytes());
        let moov_frag = make_mp4_box(b"moov", &make_mp4_box(b"mvhd", &mvhd_frag));
        let mut bytes_frag = make_mp4_box(b"ftyp", b"isom\x00\x00\x02\x00");
        bytes_frag.extend_from_slice(&moov_frag);
        let p_frag = tmp.join("frag.mp4");
        fs::write(&p_frag, bytes_frag).unwrap();
        assert!(probe_duration_fast_header(&p_frag).is_none());

        // 4) Unknown-duration sentinel (u32::MAX in v0, u64::MAX in v1) returns None
        let mut mvhd_unk_v0 = vec![0u8; 24];
        mvhd_unk_v0[0] = 0;
        mvhd_unk_v0[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd_unk_v0[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        let mut bytes_unk_v0 = make_mp4_box(b"ftyp", b"isom\x00\x00\x02\x00");
        bytes_unk_v0
            .extend_from_slice(&make_mp4_box(b"moov", &make_mp4_box(b"mvhd", &mvhd_unk_v0)));
        let p_unk_v0 = tmp.join("unk_v0.mp4");
        fs::write(&p_unk_v0, bytes_unk_v0).unwrap();
        assert!(probe_duration_fast_header(&p_unk_v0).is_none());

        let mut mvhd_unk_v1 = vec![0u8; 36];
        mvhd_unk_v1[0] = 1;
        mvhd_unk_v1[20..24].copy_from_slice(&1000u32.to_be_bytes());
        mvhd_unk_v1[24..32].copy_from_slice(&u64::MAX.to_be_bytes());
        let mut bytes_unk_v1 = make_mp4_box(b"ftyp", b"isom\x00\x00\x02\x00");
        bytes_unk_v1
            .extend_from_slice(&make_mp4_box(b"moov", &make_mp4_box(b"mvhd", &mvhd_unk_v1)));
        let p_unk_v1 = tmp.join("unk_v1.mp4");
        fs::write(&p_unk_v1, bytes_unk_v1).unwrap();
        assert!(probe_duration_fast_header(&p_unk_v1).is_none());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn fast_header_probe_parses_mkv_info_after_void_and_attachments() {
        let tmp =
            std::env::temp_dir().join(format!("epilod_mkv_probe_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let ebml_hdr = make_ebml_elem(&[0x1A, 0x45, 0xDF, 0xA3], &[0x42, 0x86, 0x81, 0x01]);
        let void_elem = make_ebml_elem(&[0xEC], &[0u8; 512]);
        let ts_scale = make_ebml_elem(&[0x2A, 0xD7, 0xB1], &1_000_000u32.to_be_bytes()[1..4]); // 0x0F4240 (1ms)
        let dur_ticks: f64 = 1_380_500.0; // 1380.5 seconds
        let dur_elem = make_ebml_elem(&[0x44, 0x89], &dur_ticks.to_be_bytes());
        let mut info_payload = ts_scale;
        info_payload.extend_from_slice(&dur_elem);
        let info_elem = make_ebml_elem(&[0x15, 0x49, 0xA9, 0x66], &info_payload);

        let mut seg_payload = void_elem;
        seg_payload.extend_from_slice(&info_elem);
        let seg_elem = make_ebml_elem(&[0x18, 0x53, 0x80, 0x67], &seg_payload);

        let mut mkv_bytes = ebml_hdr;
        mkv_bytes.extend_from_slice(&seg_elem);
        let p_mkv = tmp.join("episode.mkv");
        fs::write(&p_mkv, mkv_bytes).unwrap();

        let dur = probe_duration_fast_header(&p_mkv).expect("mkv duration");
        assert!((dur - 1380.5).abs() < 1e-6);

        let _ = fs::remove_dir_all(&tmp);
    }
}
