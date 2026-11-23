use epilod_core::cloud_sync::sha256_hex;
use epilod_core::validation::{validate_existing_local_file_with_options, LocalPathOptions};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

pub const THUMB_FRAME_W: u32 = 160;
pub const THUMB_FRAME_H: u32 = 90;
pub const THUMB_GRID_COLS: u32 = 10;
pub const THUMB_MAX_FRAMES: u32 = 100;
pub const THUMB_CACHE_MAX_BYTES: u64 = 24 * 1024 * 1024;
pub const THUMB_CACHE_MIN_MB: u64 = 8;
pub const THUMB_CACHE_MAX_MB: u64 = 250;
/// Sprites not opened for this long are deleted at startup (previews rebuild on demand).
pub const THUMB_CACHE_MAX_IDLE_SECS: u64 = 21 * 86_400;
const THUMB_JPEG_QUALITY: &str = "10";

static THUMB_CACHE_CAP_BYTES: AtomicU64 = AtomicU64::new(THUMB_CACHE_MAX_BYTES);

pub fn get_thumb_cache_cap_bytes() -> u64 {
    THUMB_CACHE_CAP_BYTES.load(Ordering::Relaxed)
}

pub fn set_thumb_cache_cap_mb(mb: u64) -> u64 {
    let clamped_mb = mb.clamp(THUMB_CACHE_MIN_MB, THUMB_CACHE_MAX_MB);
    let bytes = clamped_mb * 1024 * 1024;
    THUMB_CACHE_CAP_BYTES.store(bytes, Ordering::Relaxed);
    if let Some(dir) = thumbnail_cache_dir() {
        prune_thumbnail_cache(&dir, bytes);
    }
    bytes
}
const THUMB_FFMPEG_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpritePlan {
    pub interval_secs: u32,
    pub frame_count: u32,
    pub cols: u32,
    pub rows: u32,
    pub frame_w: u32,
    pub frame_h: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailSpriteDto {
    pub data_url: String,
    pub cols: u32,
    pub rows: u32,
    pub frame_w: u32,
    pub frame_h: u32,
    pub interval_secs: u32,
    pub frame_count: u32,
}

/// Computes a bounded 10xN sprite grid plan for a video's duration.
/// Returns `None` for invalid or very short (<15s) media.
pub fn compute_sprite_plan(duration_secs: f64) -> Option<SpritePlan> {
    if !duration_secs.is_finite() || duration_secs < 15.0 {
        return None;
    }
    let interval_secs = ((duration_secs / THUMB_MAX_FRAMES as f64).ceil() as u32).max(5);
    let est_frames = ((duration_secs / interval_secs as f64).floor() as u32)
        .saturating_add(1)
        .clamp(1, THUMB_MAX_FRAMES);
    let cols = est_frames.min(THUMB_GRID_COLS);
    let rows = est_frames.div_ceil(cols);
    Some(SpritePlan {
        interval_secs,
        frame_count: est_frames,
        cols,
        rows,
        frame_w: THUMB_FRAME_W,
        frame_h: THUMB_FRAME_H,
    })
}

pub fn thumbnail_cache_key(path: &str, size: u64, mtime_secs: u64) -> String {
    let norm = path.replace('\\', "/").to_ascii_lowercase();
    sha256_hex(&format!("thumb-v1:{norm}:{size}:{mtime_secs}"))
}

pub fn thumbnail_cache_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("EpilodParty").join("cache").join("thumbs"))
}

pub fn encode_base64_std(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 {
            chunk[1] as usize
        } else {
            0
        };
        let b2 = if chunk.len() > 2 {
            chunk[2] as usize
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) & 0x3F] as char);
        out.push(TABLE[(triple >> 12) & 0x3F] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) & 0x3F] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple & 0x3F] as char
        } else {
            '='
        });
    }
    out
}

/// Evicts oldest `.jpg` sprites until total directory size is <= `max_bytes`.
/// Returns total bytes removed.
pub fn prune_thumbnail_cache(dir: &Path, max_bytes: u64) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(".tmp.jpg"))
        {
            if let Ok(m) = entry.metadata() {
                if std::fs::remove_file(&p).is_ok() {
                    // Track removed orphan temp bytes if needed; excluded from live cache total
                    let _ = m.len();
                }
            }
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let len = meta.len();
        let mt = meta.modified().unwrap_or(UNIX_EPOCH);
        total = total.saturating_add(len);
        files.push((p, len, mt));
    }
    if total <= max_bytes {
        return 0;
    }
    files.sort_by_key(|(_, _, mt)| *mt);
    let mut freed = 0u64;
    for (p, len, _) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
            freed = freed.saturating_add(len);
        }
    }
    freed
}

pub fn clear_all_thumbnail_cache(dir: &Path) -> u64 {
    prune_thumbnail_cache(dir, 0)
}

/// Deletes sprites whose last use (mtime, refreshed on every cache hit) is older than `max_idle`.
/// Returns total bytes removed.
pub fn prune_thumbnail_cache_by_age(dir: &Path, max_idle: Duration) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut freed = 0u64;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let idle = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .unwrap_or_default();
        if idle > max_idle && std::fs::remove_file(&p).is_ok() {
            freed = freed.saturating_add(meta.len());
        }
    }
    freed
}

/// Marks a sprite as just-used so size pruning evicts least-recently-used files first.
fn touch_cache_file(path: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

#[derive(Default)]
pub struct ThumbnailController {
    generation: AtomicU64,
}

impl ThumbnailController {
    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn generate(
        &self,
        app: &AppHandle,
        raw_path: &str,
        duration_secs: f64,
        opts: LocalPathOptions,
    ) -> Result<Option<ThumbnailSpriteDto>, String> {
        let Some(plan) = compute_sprite_plan(duration_secs) else {
            return Ok(None);
        };
        let validated_buf = validate_existing_local_file_with_options(raw_path, opts)
            .map_err(|e| format!("Thumbnail path rejected: {e}"))?;
        let validated = validated_buf.to_string_lossy().into_owned();
        let meta = std::fs::metadata(&validated)
            .map_err(|e| format!("Failed reading video metadata: {e}"))?;
        let size = meta.len();
        let mtime_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let gen_id = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let cache_dir =
            thumbnail_cache_dir().unwrap_or_else(|| std::env::temp_dir().join("EpilodPartyThumbs"));
        let _ = std::fs::create_dir_all(&cache_dir);
        let key = thumbnail_cache_key(&validated, size, mtime_secs);
        let sprite_path = cache_dir.join(format!("{key}.jpg"));

        // Serve from cache immediately when present and non-empty.
        if let Ok(bytes) = std::fs::read(&sprite_path) {
            if !bytes.is_empty() {
                touch_cache_file(&sprite_path);
                return Ok(Some(ThumbnailSpriteDto {
                    data_url: format!("data:image/jpeg;base64,{}", encode_base64_std(&bytes)),
                    cols: plan.cols,
                    rows: plan.rows,
                    frame_w: plan.frame_w,
                    frame_h: plan.frame_h,
                    interval_secs: plan.interval_secs,
                    frame_count: plan.frame_count,
                }));
            }
        }

        let Some(ffmpeg_exe) = crate::mpv::process::resolve_ffmpeg_exe(app) else {
            return Ok(None);
        };

        let tmp_path = cache_dir.join(format!("{key}.{gen_id}.tmp.jpg"));
        let vf = format!(
            "fps=1/{},scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:black,tile={}x{}",
            plan.interval_secs,
            plan.frame_w,
            plan.frame_h,
            plan.frame_w,
            plan.frame_h,
            plan.cols,
            plan.rows
        );

        let mut cmd = Command::new(&ffmpeg_exe);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-skip_frame",
            "nokey",
            "-i",
            &validated,
            "-an",
            "-sn",
            "-dn",
            "-vf",
            &vf,
            "-frames:v",
            "1",
            "-q:v",
            THUMB_JPEG_QUALITY,
        ])
        .arg(&tmp_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => return Ok(None),
        };
        if let Some(pid) = child.id() {
            crate::job_object::assign_pid_to_kill_job(pid);
        }

        // Poll cancellation while waiting up to THUMB_FFMPEG_TIMEOUT.
        let started = tokio::time::Instant::now();
        loop {
            if self.generation.load(Ordering::SeqCst) != gen_id {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&tmp_path);
                return Ok(None);
            }
            if started.elapsed() >= THUMB_FFMPEG_TIMEOUT {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&tmp_path);
                return Ok(None);
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        let _ = std::fs::remove_file(&tmp_path);
                        return Ok(None);
                    }
                    break;
                }
                Ok(None) => tokio::time::sleep(Duration::from_millis(120)).await,
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = std::fs::remove_file(&tmp_path);
                    return Ok(None);
                }
            }
        }

        if self.generation.load(Ordering::SeqCst) != gen_id {
            let _ = std::fs::remove_file(&tmp_path);
            return Ok(None);
        }

        let bytes = match std::fs::read(&tmp_path) {
            Ok(b) if !b.is_empty() => b,
            _ => {
                let _ = std::fs::remove_file(&tmp_path);
                return Ok(None);
            }
        };
        let _ = std::fs::rename(&tmp_path, &sprite_path);
        prune_thumbnail_cache(&cache_dir, get_thumb_cache_cap_bytes());

        Ok(Some(ThumbnailSpriteDto {
            data_url: format!("data:image/jpeg;base64,{}", encode_base64_std(&bytes)),
            cols: plan.cols,
            rows: plan.rows,
            frame_w: plan.frame_w,
            frame_h: plan.frame_h,
            interval_secs: plan.interval_secs,
            frame_count: plan.frame_count,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprite_plan_rejects_short_or_invalid_durations() {
        assert!(compute_sprite_plan(0.0).is_none());
        assert!(compute_sprite_plan(-5.0).is_none());
        assert!(compute_sprite_plan(f64::NAN).is_none());
        assert!(compute_sprite_plan(10.0).is_none());
    }

    #[test]
    fn sprite_plan_bounds_grid_for_long_movies() {
        let short = compute_sprite_plan(120.0).unwrap();
        assert_eq!(short.interval_secs, 5);
        assert_eq!(short.cols, 10);
        assert!(short.frame_count <= THUMB_MAX_FRAMES);

        let two_hours = compute_sprite_plan(7200.0).unwrap();
        assert_eq!(two_hours.interval_secs, 72);
        assert_eq!(two_hours.cols, 10);
        assert!(two_hours.rows <= 10);
        assert!(two_hours.frame_count <= THUMB_MAX_FRAMES);
    }

    #[test]
    fn cache_key_normalizes_case_and_slashes() {
        let a = thumbnail_cache_key(r"D:\Movies\Test.mkv", 1024, 500);
        let b = thumbnail_cache_key("d:/movies/test.mkv", 1024, 500);
        let c = thumbnail_cache_key("d:/movies/test.mkv", 2048, 500);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn base64_std_matches_known_vectors() {
        assert_eq!(encode_base64_std(b""), "");
        assert_eq!(encode_base64_std(b"f"), "Zg==");
        assert_eq!(encode_base64_std(b"fo"), "Zm8=");
        assert_eq!(encode_base64_std(b"foo"), "Zm9v");
        assert_eq!(encode_base64_std(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn prune_by_age_removes_only_idle_sprites() {
        let dir = std::env::temp_dir().join(format!("epilod_thumb_age_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.jpg"), vec![1u8; 500]).unwrap();
        std::fs::write(dir.join("new.jpg"), vec![2u8; 500]).unwrap();
        let old = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.join("old.jpg"))
            .unwrap();
        old.set_modified(SystemTime::now() - Duration::from_secs(30 * 86_400))
            .unwrap();
        drop(old);
        let freed = prune_thumbnail_cache_by_age(&dir, Duration::from_secs(21 * 86_400));
        assert_eq!(freed, 500);
        assert!(!dir.join("old.jpg").exists());
        assert!(dir.join("new.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_cache_respects_max_bytes() {
        let dir = std::env::temp_dir().join(format!("epilod_thumb_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.jpg"), vec![1u8; 600]).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("b.jpg"), vec![2u8; 600]).unwrap();
        let freed = prune_thumbnail_cache(&dir, 700);
        assert_eq!(freed, 600);
        assert!(!dir.join("a.jpg").exists());
        assert!(dir.join("b.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
