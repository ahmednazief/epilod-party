use epilod_core::subtitle_sync::{
    decode_subtitle_bytes_with_hint, parse_subtitles, render_srt, render_vtt, rescale_ass_text,
    rescale_cues, SubtitleEncodingHint,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DEFAULT_STALL_TIMEOUT_SECS: u64 = 90;
pub const DEFAULT_MAX_EXTRACT_SECS: u64 = 600;

const BITMAP_SUB_CODECS: &[&str] = &[
    "hdmv_pgs_subtitle",
    "pgssub",
    "dvd_subtitle",
    "dvdsub",
    "dvb_subtitle",
    "xsub",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSyncResultDto {
    pub offset_secs: f64,
    pub scale: f64,
    pub confidence_z: f64,
    pub correlation: f64,
    pub drift_applied: bool,
    pub synced_subtitle_path: String,
    pub source_subtitle_path: String,
    pub audio_duration_secs: f64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogStatus {
    Continue,
    Stalled,
    MaxExceeded,
}

/// Fix 26: Stall-aware extraction watchdog that resets its stall timer whenever the output file grows,
/// up to an overall upper ceiling (default 600s).
#[derive(Debug, Clone)]
pub struct StallWatchdog {
    started_at: Instant,
    last_progress_at: Instant,
    last_bytes: u64,
    stall_timeout: Duration,
    max_total: Duration,
}

impl StallWatchdog {
    pub fn new(now: Instant, stall_timeout: Duration, max_total: Duration) -> Self {
        Self {
            started_at: now,
            last_progress_at: now,
            last_bytes: 0,
            stall_timeout,
            max_total,
        }
    }

    pub fn poll(&mut self, current_bytes: u64, now: Instant) -> WatchdogStatus {
        if current_bytes > self.last_bytes {
            self.last_bytes = current_bytes;
            self.last_progress_at = now;
        }
        if now.duration_since(self.started_at) >= self.max_total {
            return WatchdogStatus::MaxExceeded;
        }
        if now.duration_since(self.last_progress_at) >= self.stall_timeout {
            return WatchdogStatus::Stalled;
        }
        WatchdogStatus::Continue
    }
}

pub fn is_bitmap_subtitle_codec(codec: Option<&str>) -> bool {
    let Some(c) = codec.map(|s| s.trim().to_ascii_lowercase()) else {
        return false;
    };
    BITMAP_SUB_CODECS.iter().any(|b| *b == c)
}

pub fn infer_sub_extension_from_codec(codec: Option<&str>) -> &'static str {
    let lower = codec.unwrap_or("").trim().to_ascii_lowercase();
    if lower == "ass" || lower == "ssa" {
        "ass"
    } else if lower == "webvtt" || lower == "vtt" {
        "vtt"
    } else {
        "srt"
    }
}

pub fn format_missing_extractor_error(mpv_err: Option<&str>, ffmpeg_available: bool) -> String {
    if !ffmpeg_available {
        let base = "Could not extract audio for auto-sync because mpv extraction failed and ffmpeg.exe is not installed alongside mpv.exe.";
        match mpv_err.map(str::trim).filter(|s| !s.is_empty()) {
            Some(detail) => format!("{base} ({detail})"),
            None => base.to_string(),
        }
    } else {
        match mpv_err.map(str::trim).filter(|s| !s.is_empty()) {
            Some(detail) => format!("Audio extraction failed: {detail}"),
            None => "Audio extraction failed.".to_string(),
        }
    }
}

pub fn write_rescaled_subtitle_file(
    source_path: &Path,
    out_dir: &Path,
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
    encoding_hint: SubtitleEncodingHint,
) -> Result<PathBuf, String> {
    fs::create_dir_all(out_dir)
        .map_err(|e| format!("Failed creating temp subtitle directory: {e}"))?;

    let raw_bytes =
        fs::read(source_path).map_err(|e| format!("Failed reading subtitle file: {e}"))?;
    let decoded =
        decode_subtitle_bytes_with_hint(&raw_bytes, encoding_hint).map_err(|e| e.to_string())?;

    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "srt".to_string());

    let (out_ext, rendered) = match ext.as_str() {
        "vtt" => (
            "vtt",
            render_vtt(&decoded, scale, anchor_ms, offset_ms).map_err(|e| e.to_string())?,
        ),
        "ass" | "ssa" => (
            "ass",
            rescale_ass_text(&decoded, scale, anchor_ms, offset_ms).map_err(|e| e.to_string())?,
        ),
        _ => {
            let mut cues = parse_subtitles(&decoded).map_err(|e| e.to_string())?;
            rescale_cues(&mut cues, scale, anchor_ms, offset_ms).map_err(|e| e.to_string())?;
            ("srt", render_srt(&cues))
        }
    };

    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("subtitle")
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect::<String>();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let out_path = out_dir.join(format!("{stem}.synced.{stamp}.{out_ext}"));
    fs::write(&out_path, rendered.as_bytes())
        .map_err(|e| format!("Failed writing synced subtitle file: {e}"))?;
    Ok(out_path)
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use crate::mpv::process::resolve_mpv_exe;
    use epilod_core::mpv_ipc::{
        autosync_extract_args_ffmpeg, autosync_extract_args_mpv, autosync_extract_sub_args_ffmpeg,
    };
    use epilod_core::subtitle_sync::{
        auto_align_subtitles, fit_two_anchor_transform, AudioEnvelopeBuilder, AutoSyncConfig,
    };
    use epilod_core::validation::{validate_existing_local_file_with_options, LocalPathOptions};
    use std::io::Read;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;
    use tokio::process::Command;

    static AUTOSYNC_JOB_SEQ: AtomicU64 = AtomicU64::new(1);

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const NORMAL_PRIORITY_CLASS: u32 = 0x0000_0020;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

    #[derive(Default)]
    pub struct AutoSyncController {
        cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
    }

    impl AutoSyncController {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn begin(&self) -> Arc<AtomicBool> {
            let next = Arc::new(AtomicBool::new(false));
            if let Ok(mut guard) = self.cancel_flag.lock() {
                if let Some(prev) = guard.replace(Arc::clone(&next)) {
                    prev.store(true, Ordering::SeqCst);
                }
            }
            next
        }

        pub fn cancel(&self) {
            if let Ok(guard) = self.cancel_flag.lock() {
                if let Some(ref flag) = *guard {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }

    fn resolve_ffmpeg_exe(app: &AppHandle) -> Option<PathBuf> {
        if let Ok(mpv_path) = resolve_mpv_exe(app) {
            if let Some(dir) = mpv_path.parent() {
                let candidate = dir.join("ffmpeg.exe");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    fn temp_work_dir() -> PathBuf {
        std::env::temp_dir().join("epilod-autosync")
    }

    /// Best-effort removal of leftover extraction/synced files older than 24h so the temp dir
    /// cannot grow without bound across many sync runs.
    fn prune_stale_work_files(dir: &Path) {
        let cutoff = Duration::from_secs(24 * 60 * 60);
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let old = meta
                .modified()
                .ok()
                .and_then(|m| SystemTime::now().duration_since(m).ok())
                .is_some_and(|age| age > cutoff);
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Continuously drains a child's stderr (keeping only a bounded tail for diagnostics) so a chatty
    /// extractor can never block on a full pipe buffer.
    fn spawn_stderr_drain(
        stderr: Option<tokio::process::ChildStderr>,
    ) -> Option<tokio::task::JoinHandle<Vec<u8>>> {
        use tokio::io::AsyncReadExt;
        const TAIL_CAP: usize = 4096;
        stderr.map(|mut se| {
            tokio::spawn(async move {
                let mut tail: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match se.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            tail.extend_from_slice(&chunk[..n]);
                            if tail.len() > TAIL_CAP {
                                let excess = tail.len() - TAIL_CAP;
                                tail.drain(..excess);
                            }
                        }
                    }
                }
                tail
            })
        })
    }

    async fn run_command_with_watchdog(
        exe: &Path,
        args: &[String],
        watched_output: &Path,
        cancel: &Arc<AtomicBool>,
        low_power: bool,
        stall_timeout: Duration,
    ) -> Result<(), String> {
        let priority = if low_power {
            BELOW_NORMAL_PRIORITY_CLASS
        } else {
            NORMAL_PRIORITY_CLASS
        };
        let mut cmd = Command::new(exe);
        cmd.args(args)
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW | priority)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed starting {}: {e}", exe.display()))?;
        let drain = spawn_stderr_drain(child.stderr.take());

        let mut watchdog = StallWatchdog::new(
            Instant::now(),
            stall_timeout,
            Duration::from_secs(DEFAULT_MAX_EXTRACT_SECS),
        );

        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err("Auto-sync cancelled.".to_string());
            }

            if let Ok(Some(status)) = child.try_wait() {
                if status.success() {
                    return Ok(());
                }
                let err_buf = match drain {
                    Some(handle) => tokio::time::timeout(Duration::from_millis(500), handle)
                        .await
                        .ok()
                        .and_then(|r| r.ok())
                        .unwrap_or_default(),
                    None => Vec::new(),
                };
                let snippet = String::from_utf8_lossy(&err_buf)
                    .lines()
                    .rev()
                    .filter(|l| !l.trim().is_empty())
                    .take(3)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" ");
                return Err(if snippet.trim().is_empty() {
                    format!("Extractor exited with status {status}")
                } else {
                    snippet
                });
            }

            let cur_size = tokio::fs::metadata(watched_output)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            match watchdog.poll(cur_size, Instant::now()) {
                WatchdogStatus::Continue => {}
                WatchdogStatus::Stalled => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err("Audio extraction stalled with no progress.".to_string());
                }
                WatchdogStatus::MaxExceeded => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err("Audio extraction exceeded maximum runtime limit.".to_string());
                }
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn execute_auto_sync(
        app: &AppHandle,
        controller: &AutoSyncController,
        video_path: &str,
        subtitle_path: Option<&str>,
        audio_track_id: Option<u64>,
        embedded_sub_idx: Option<usize>,
        embedded_sub_codec: Option<&str>,
        encoding_hint: SubtitleEncodingHint,
        low_power: bool,
        path_opts: LocalPathOptions,
    ) -> Result<AutoSyncResultDto, String> {
        let start = Instant::now();
        let cancel = controller.begin();
        let job_seq = AUTOSYNC_JOB_SEQ.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();

        let app_clone = app.clone();
        let video_owned = video_path.to_string();
        let sub_owned = subtitle_path.map(|s| s.to_string());
        let (video_pb, work_dir, ffmpeg_exe, mpv_exe, external_sub_pb) =
            tokio::task::spawn_blocking(move || {
                let video_pb = validate_existing_local_file_with_options(&video_owned, path_opts)
                    .map_err(|e| e.to_string())?;
                let work_dir = temp_work_dir();
                fs::create_dir_all(&work_dir)
                    .map_err(|e| format!("Failed creating auto-sync temp directory: {e}"))?;
                prune_stale_work_files(&work_dir);
                let ffmpeg_exe = resolve_ffmpeg_exe(&app_clone);
                let mpv_exe = resolve_mpv_exe(&app_clone)?;
                let ext_sub = match sub_owned {
                    Some(sp) => Some(
                        validate_existing_local_file_with_options(&sp, path_opts)
                            .map_err(|e| e.to_string())?,
                    ),
                    None => None,
                };
                Ok::<_, String>((video_pb, work_dir, ffmpeg_exe, mpv_exe, ext_sub))
            })
            .await
            .map_err(|e| format!("Auto-sync preparation failed: {e}"))??;

        let mut temp_extracted_sub: Option<PathBuf> = None;

        // Resolve external or embedded subtitle source
        let sub_pb = if let Some(sp) = external_sub_pb {
            sp
        } else if let Some(sub_idx) = embedded_sub_idx {
            if is_bitmap_subtitle_codec(embedded_sub_codec) {
                return Err(
                    "Bitmap subtitles (PGS/VobSub) cannot be auto-synced. Load a text subtitle file (.srt, .ass, .vtt).".to_string()
                );
            }
            let Some(ref ff) = ffmpeg_exe else {
                return Err(
                    "Extracting embedded MKV subtitle tracks requires ffmpeg.exe alongside mpv.exe, or load an external subtitle file.".to_string()
                );
            };
            let ext = infer_sub_extension_from_codec(embedded_sub_codec);
            let out_sub = work_dir.join(format!("embedded_{pid}_{job_seq}.{ext}"));
            let args = autosync_extract_sub_args_ffmpeg(
                video_pb.to_string_lossy().as_ref(),
                out_sub.to_string_lossy().as_ref(),
                sub_idx,
            );
            // Subtitle packets can be sparse across a huge remux, so the output file may legitimately
            // not grow for minutes while ffmpeg demuxes; rely on the overall ceiling instead of the
            // short stall timer here.
            if let Err(e) = run_command_with_watchdog(
                ff,
                &args,
                &out_sub,
                &cancel,
                low_power,
                Duration::from_secs(DEFAULT_MAX_EXTRACT_SECS),
            )
            .await
            {
                let _ = fs::remove_file(&out_sub);
                return Err(e);
            }
            temp_extracted_sub = Some(out_sub.clone());
            out_sub
        } else {
            return Err("No subtitle track or file selected for auto-sync.".to_string());
        };

        let pcm_path = work_dir.join(format!("audio_{pid}_{job_seq}.pcm"));
        let _ = tokio::fs::remove_file(&pcm_path).await;

        let mpv_args = autosync_extract_args_mpv(
            video_pb.to_string_lossy().as_ref(),
            pcm_path.to_string_lossy().as_ref(),
            audio_track_id,
        );
        let stall = Duration::from_secs(DEFAULT_STALL_TIMEOUT_SECS);
        let mpv_res =
            run_command_with_watchdog(&mpv_exe, &mpv_args, &pcm_path, &cancel, low_power, stall)
                .await;

        let extracted_ok = mpv_res.is_ok()
            && tokio::fs::metadata(&pcm_path)
                .await
                .map(|m| m.len() > 16_000)
                .unwrap_or(false);

        if !extracted_ok {
            if cancel.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&pcm_path);
                return Err("Auto-sync cancelled.".to_string());
            }
            let _ = fs::remove_file(&pcm_path);
            if let Some(ref ff) = ffmpeg_exe {
                let stream_idx = audio_track_id.map(|id| id.saturating_sub(1) as usize);
                let ff_args = autosync_extract_args_ffmpeg(
                    video_pb.to_string_lossy().as_ref(),
                    pcm_path.to_string_lossy().as_ref(),
                    stream_idx,
                );
                if let Err(e) =
                    run_command_with_watchdog(ff, &ff_args, &pcm_path, &cancel, low_power, stall)
                        .await
                {
                    let _ = fs::remove_file(&pcm_path);
                    return Err(e);
                }
            } else {
                let _ = fs::remove_file(&pcm_path);
                return Err(format_missing_extractor_error(
                    mpv_res.err().as_deref(),
                    false,
                ));
            }
        }

        // Stream PCM, decode/parse subtitles, and run CPU-bound alignment off the async executor
        let cancel_clone = Arc::clone(&cancel);
        let sub_pb_clone = sub_pb.clone();
        let pcm_path_clone = pcm_path.clone();
        let work_dir_clone = work_dir.clone();
        let (outcome, audio_duration_secs, synced_pb) = tokio::task::spawn_blocking(move || {
            let sub_bytes = match fs::read(&sub_pb_clone) {
                Ok(b) => b,
                Err(e) => {
                    let _ = fs::remove_file(&pcm_path_clone);
                    return Err(format!("Failed reading subtitle file: {e}"));
                }
            };
            let decoded = match decode_subtitle_bytes_with_hint(&sub_bytes, encoding_hint) {
                Ok(d) => d,
                Err(e) => {
                    let _ = fs::remove_file(&pcm_path_clone);
                    return Err(e.to_string());
                }
            };
            let cues = match parse_subtitles(&decoded) {
                Ok(c) => c,
                Err(e) => {
                    let _ = fs::remove_file(&pcm_path_clone);
                    return Err(e.to_string());
                }
            };

            let mut pcm_file = match fs::File::open(&pcm_path_clone) {
                Ok(f) => f,
                Err(e) => {
                    let _ = fs::remove_file(&pcm_path_clone);
                    return Err(format!("Failed opening extracted audio PCM: {e}"));
                }
            };
            let mut builder = AudioEnvelopeBuilder::new();
            let mut buf = vec![0u8; 65_536];
            loop {
                if cancel_clone.load(Ordering::SeqCst) {
                    let _ = fs::remove_file(&pcm_path_clone);
                    return Err("Auto-sync cancelled.".to_string());
                }
                let n = match pcm_file.read(&mut buf) {
                    Ok(n) => n,
                    Err(e) => {
                        let _ = fs::remove_file(&pcm_path_clone);
                        return Err(format!("Failed reading extracted PCM: {e}"));
                    }
                };
                if n == 0 {
                    break;
                }
                builder.push_pcm_s16le_bytes(&buf[..n]);
            }
            let _ = fs::remove_file(&pcm_path_clone);

            let envelope = builder.finish().map_err(|e| e.to_string())?;
            let audio_duration_secs = envelope.len() as f64 / 100.0;
            let outcome = auto_align_subtitles(&cues, &envelope, &AutoSyncConfig::default())
                .map_err(|e| e.to_string())?;

            let synced_pb = write_rescaled_subtitle_file(
                &sub_pb_clone,
                &work_dir_clone,
                outcome.scale,
                outcome.anchor_ms,
                outcome.offset_ms,
                encoding_hint,
            )?;
            Ok((outcome, audio_duration_secs, synced_pb))
        })
        .await
        .map_err(|e| format!("Auto-sync worker failed: {e}"))??;

        Ok(AutoSyncResultDto {
            offset_secs: outcome.offset_ms as f64 / 1000.0,
            scale: outcome.scale,
            confidence_z: outcome.confidence_z,
            correlation: outcome.correlation,
            drift_applied: outcome.drift_applied,
            synced_subtitle_path: synced_pb.to_string_lossy().into_owned(),
            source_subtitle_path: temp_extracted_sub
                .as_ref()
                .unwrap_or(&sub_pb)
                .to_string_lossy()
                .into_owned(),
            audio_duration_secs,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    pub fn execute_two_anchor_sync(
        subtitle_path: &str,
        src_a_secs: f64,
        dst_a_secs: f64,
        src_b_secs: f64,
        dst_b_secs: f64,
        encoding_hint: SubtitleEncodingHint,
        path_opts: LocalPathOptions,
    ) -> Result<AutoSyncResultDto, String> {
        let start = Instant::now();
        let sub_pb = validate_existing_local_file_with_options(subtitle_path, path_opts)
            .map_err(|e| e.to_string())?;
        if !src_a_secs.is_finite()
            || !dst_a_secs.is_finite()
            || !src_b_secs.is_finite()
            || !dst_b_secs.is_finite()
            || src_a_secs < 0.0
            || dst_a_secs < 0.0
            || src_b_secs < 0.0
            || dst_b_secs < 0.0
        {
            return Err("Invalid anchor timestamps for two-point calibration.".to_string());
        }
        let src_a_ms = (src_a_secs * 1000.0).round() as u64;
        let dst_a_ms = (dst_a_secs * 1000.0).round() as u64;
        let src_b_ms = (src_b_secs * 1000.0).round() as u64;
        let dst_b_ms = (dst_b_secs * 1000.0).round() as u64;

        let (scale, offset_ms) = fit_two_anchor_transform(src_a_ms, dst_a_ms, src_b_ms, dst_b_ms)
            .map_err(|e| e.to_string())?;

        let synced_pb = write_rescaled_subtitle_file(
            &sub_pb,
            &temp_work_dir(),
            scale,
            src_a_ms,
            offset_ms,
            encoding_hint,
        )?;

        Ok(AutoSyncResultDto {
            offset_secs: offset_ms as f64 / 1000.0,
            scale,
            confidence_z: 10.0,
            correlation: 1.0,
            drift_applied: (scale - 1.0).abs() > 1e-4,
            synced_subtitle_path: synced_pb.to_string_lossy().into_owned(),
            source_subtitle_path: sub_pb.to_string_lossy().into_owned(),
            audio_duration_secs: 0.0,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }
}

#[cfg(windows)]
pub use windows_impl::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bitmap_codec_and_extension_detection() {
        assert!(is_bitmap_subtitle_codec(Some("hdmv_pgs_subtitle")));
        assert!(is_bitmap_subtitle_codec(Some("DVD_SUBTITLE")));
        assert!(!is_bitmap_subtitle_codec(Some("subrip")));
        assert!(!is_bitmap_subtitle_codec(Some("ass")));
        assert_eq!(infer_sub_extension_from_codec(Some("ass")), "ass");
        assert_eq!(infer_sub_extension_from_codec(Some("webvtt")), "vtt");
        assert_eq!(infer_sub_extension_from_codec(Some("subrip")), "srt");
    }

    #[test]
    fn test_stall_watchdog_resets_on_growth_and_caps_total() {
        let t0 = Instant::now();
        let mut wd = StallWatchdog::new(t0, Duration::from_secs(90), Duration::from_secs(600));
        assert_eq!(
            wd.poll(0, t0 + Duration::from_secs(60)),
            WatchdogStatus::Continue
        );
        // Growth at t=80s resets stall window
        assert_eq!(
            wd.poll(4096, t0 + Duration::from_secs(80)),
            WatchdogStatus::Continue
        );
        assert_eq!(
            wd.poll(4096, t0 + Duration::from_secs(150)),
            WatchdogStatus::Continue
        );
        // Stalled after 90s of no growth (80 + 90 = 170)
        assert_eq!(
            wd.poll(4096, t0 + Duration::from_secs(171)),
            WatchdogStatus::Stalled
        );
        // Max ceiling triggers even with growth
        assert_eq!(
            wd.poll(999999, t0 + Duration::from_secs(601)),
            WatchdogStatus::MaxExceeded
        );
    }

    #[test]
    fn test_write_rescaled_vtt_preserves_format_and_cue_settings() {
        let tmp = std::env::temp_dir().join(format!("epilod_vtt_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("sample.vtt");
        let vtt = "WEBVTT\n\nNOTE Header comment\n\n00:00:01.000 --> 00:00:03.000 align:start position:10%\nHello\n";
        fs::write(&src, vtt).unwrap();

        let out = write_rescaled_subtitle_file(
            &src,
            &tmp.join("out"),
            1.0,
            0,
            2000,
            SubtitleEncodingHint::Auto,
        )
        .unwrap();
        assert_eq!(out.extension().and_then(|e| e.to_str()), Some("vtt"));
        let content = fs::read_to_string(&out).unwrap();
        assert!(content.starts_with("WEBVTT"));
        assert!(content.contains("NOTE Header comment"));
        assert!(content.contains("00:00:03.000 --> 00:00:05.000 align:start position:10%"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_missing_extractor_message_mentions_ffmpeg_when_absent() {
        let msg = format_missing_extractor_error(Some("ao-pcm failed"), false);
        assert!(msg.contains("ffmpeg.exe"));
        assert!(msg.contains("ao-pcm failed"));
    }

    /// End-to-end check with the real bundled mpv.exe: synthesize "speech" bursts, extract PCM with the
    /// exact production arguments, build the envelope, align a deliberately shifted subtitle, and
    /// verify the recovered offset. Skipped automatically when mpv.exe is not present.
    #[cfg(windows)]
    #[test]
    fn test_real_mpv_extraction_to_alignment_pipeline() {
        use epilod_core::mpv_ipc::autosync_extract_args_mpv;
        use epilod_core::subtitle_sync::{
            auto_align_subtitles, AudioEnvelopeBuilder, AutoSyncConfig, SubtitleCue,
        };
        use std::io::Read;

        let mpv = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/mpv/mpv.exe");
        if !mpv.is_file() {
            eprintln!("skipping: {} not found", mpv.display());
            return;
        }

        // Tone bursts (windows in seconds): [start, end)
        let bursts: [(f64, f64); 9] = [
            (4.0, 6.5),
            (11.0, 13.0),
            (18.0, 21.0),
            (27.0, 28.5),
            (35.0, 38.0),
            (44.0, 46.0),
            (53.0, 56.5),
            (63.0, 65.0),
            (72.0, 75.0),
        ];
        let dir = std::env::temp_dir().join(format!("epilod_e2e_autosync_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let pcm = dir.join("audio.pcm");

        // Real on-disk media file (48 kHz stereo WAV) so mpv has to demux, resample 48k->16k and
        // downmix just like it does for a movie.
        let src_rate = 48_000usize;
        let total_secs = 90usize;
        let mut samples: Vec<u8> = Vec::with_capacity(src_rate * total_secs * 4);
        for n in 0..src_rate * total_secs {
            let t = n as f64 / src_rate as f64;
            let on = bursts.iter().any(|&(s, e)| t >= s && t < e);
            let v = if on {
                (0.6 * (2.0 * std::f64::consts::PI * 600.0 * t).sin() * 32767.0) as i16
            } else {
                0
            };
            samples.extend_from_slice(&v.to_le_bytes());
            samples.extend_from_slice(&v.to_le_bytes());
        }
        let mut wav: Vec<u8> = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&(src_rate as u32).to_le_bytes());
        wav.extend_from_slice(&((src_rate * 4) as u32).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(&samples);
        let source_path = dir.join("movie_audio.wav");
        fs::write(&source_path, &wav).unwrap();
        let source = source_path.to_string_lossy().into_owned();

        let args = autosync_extract_args_mpv(&source, pcm.to_string_lossy().as_ref(), None);
        let out = std::process::Command::new(&mpv)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .output()
            .expect("failed to run mpv");
        assert!(out.status.success(), "mpv failed: {:?}", out.status);
        // Quiet flags: the extractor must not spam stderr (pipe-fill deadlock guard)
        assert!(
            out.stderr.len() < 2048,
            "mpv stderr too chatty: {} bytes",
            out.stderr.len()
        );

        let mut builder = AudioEnvelopeBuilder::new();
        let mut f = fs::File::open(&pcm).unwrap();
        let mut buf = vec![0u8; 65_536];
        loop {
            let n = f.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            builder.push_pcm_s16le_bytes(&buf[..n]);
        }
        let envelope = builder.finish().expect("envelope");
        for w in bursts.iter().take(3) {
            let b0 = (w.0 * 100.0) as usize;
            let onset = (b0.saturating_sub(30)..b0 + 30).find(|&i| envelope[i] > 0.5);
            let b1 = (w.1 * 100.0) as usize;
            let offend = (b1.saturating_sub(30)..b1 + 30).find(|&i| envelope[i] < 0.5);
            eprintln!(
                "burst {:?}: expected start bin {b0}, onset {:?}; expected end bin {b1}, off {:?}",
                w, onset, offend
            );
        }
        assert!(
            (envelope.len() as i64 - 9_000).abs() < 50,
            "len={}",
            envelope.len()
        );

        // Subtitle runs 3.2s EARLY relative to audio => expected offset is +3200 ms
        let cues: Vec<SubtitleCue> = bursts
            .iter()
            .enumerate()
            .map(|(i, (s, e))| SubtitleCue {
                index: i + 1,
                start_ms: ((s - 3.2) * 1000.0) as u64,
                end_ms: ((e - 3.2) * 1000.0) as u64,
                text: format!("Line {i}"),
            })
            .collect();
        let outcome =
            auto_align_subtitles(&cues, &envelope, &AutoSyncConfig::default()).expect("alignment");
        assert!(
            (outcome.offset_ms - 3_200).abs() <= 30,
            "offset_ms={}",
            outcome.offset_ms
        );
        assert!(!outcome.drift_applied);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Full multi-stream MKV integration test using the real bundled ffmpeg.exe and mpv.exe:
    /// muxes a video, decoy audio track (aid=1), target audio track with burst speech and explosion spike (aid=2),
    /// and embedded ASS subtitle track (0:s:0, shifted -4.7s early and polluted with SDH cues), then runs
    /// subtitle extraction (ffmpeg), audio extraction on track 2 (mpv --aid=2 AND ffmpeg -map 0:a:1),
    /// alignment, and rescaled ASS output verification. Skips cleanly if binaries are absent.
    #[cfg(windows)]
    #[test]
    fn test_real_mkv_container_embedded_sub_and_multi_audio_autosync() {
        use epilod_core::mpv_ipc::{
            autosync_extract_args_ffmpeg, autosync_extract_args_mpv,
            autosync_extract_sub_args_ffmpeg,
        };
        use epilod_core::subtitle_sync::{
            auto_align_subtitles, decode_subtitle_bytes_with_hint, parse_subtitles,
            AudioEnvelopeBuilder, AutoSyncConfig, SubtitleEncodingHint,
        };
        use std::fs;
        use std::path::Path;
        use std::process::{Command, Stdio};

        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mpv = manifest_dir.join("resources/mpv/mpv.exe");
        let ffmpeg = manifest_dir.join("resources/mpv/ffmpeg.exe");
        if !mpv.is_file() || !ffmpeg.is_file() {
            return;
        }

        let dir = std::env::temp_dir().join(format!("epilod_mkv_e2e_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");

        let ass_ts = |ms: u64| -> String {
            let cs_total = (ms + 5) / 10;
            let cs = cs_total % 100;
            let total_secs = cs_total / 100;
            let s = total_secs % 60;
            let m = (total_secs / 60) % 60;
            let h = total_secs / 3600;
            format!("{h}:{m:02}:{s:02}.{cs:02}")
        };

        let write_wav = |path: &Path, sample_rate: u32, samples: &[f32]| {
            let data_len = (samples.len() * 2) as u32;
            let mut bytes = Vec::with_capacity(44 + data_len as usize);
            bytes.extend_from_slice(b"RIFF");
            bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
            bytes.extend_from_slice(b"WAVEfmt ");
            bytes.extend_from_slice(&16u32.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&sample_rate.to_le_bytes());
            bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
            bytes.extend_from_slice(&2u16.to_le_bytes());
            bytes.extend_from_slice(&16u16.to_le_bytes());
            bytes.extend_from_slice(b"data");
            bytes.extend_from_slice(&data_len.to_le_bytes());
            for &s in samples {
                let pcm = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                bytes.extend_from_slice(&pcm.to_le_bytes());
            }
            fs::write(path, bytes).expect("write wav");
        };

        let sample_rate = 48_000usize;
        let duration_secs = 90usize;
        let total_samples = sample_rate * duration_secs;

        let decoy_wav = dir.join("decoy.wav");
        let decoy_samples: Vec<f32> = (0..total_samples)
            .map(|n| {
                let t = n as f32 / sample_rate as f32;
                0.35 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
            })
            .collect();
        write_wav(&decoy_wav, sample_rate as u32, &decoy_samples);

        let speech_bursts: &[(u64, u64)] = &[
            (6_200, 1_400),
            (11_800, 2_300),
            (19_400, 1_100),
            (25_200, 2_600),
            (33_600, 1_700),
            (42_800, 2_400),
            (50_900, 1_200),
            (57_400, 2_700),
            (66_300, 1_500),
            (74_100, 2_200),
        ];
        let mut target_samples = vec![0.0f32; total_samples];
        for &(start_ms, len_ms) in speech_bursts {
            let s_idx = (start_ms as usize * sample_rate) / 1000;
            let e_idx = (((start_ms + len_ms) as usize) * sample_rate) / 1000;
            for (i, sample) in target_samples[s_idx..e_idx].iter_mut().enumerate() {
                let t = i as f32 / sample_rate as f32;
                *sample = 0.25 * (2.0 * std::f32::consts::PI * 600.0 * t).sin();
            }
        }
        // Loud explosion spike between bursts 4 and 5 (40.0s .. 41.0s)
        let exp_s = 40 * sample_rate;
        let exp_e = 41 * sample_rate;
        for (i, sample) in target_samples[exp_s..exp_e].iter_mut().enumerate() {
            let t = i as f32 / sample_rate as f32;
            *sample = 0.45 * (2.0 * std::f32::consts::PI * 400.0 * t).sin()
                + 0.50 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin();
        }
        let target_wav = dir.join("target.wav");
        write_wav(&target_wav, sample_rate as u32, &target_samples);

        let mut ass = String::from(
            "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n\
             [V4+ Styles]\n\
             Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
             Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1\n\
             Style: Sign,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,8,10,10,20,1\n\n\
             [Events]\n\
             Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
             Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,[Music]\n\
             Dialogue: 0,0:00:10.00,0:00:12.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}\n",
        );
        let shift_early_ms = 4_700u64;
        for (i, &(audio_start_ms, len_ms)) in speech_bursts.iter().enumerate() {
            let sub_start = audio_start_ms - shift_early_ms;
            let sub_end = sub_start + len_ms;
            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,,0,0,0,,Spoken line number {}\n",
                ass_ts(sub_start),
                ass_ts(sub_end),
                i + 1
            ));
        }
        let shifted_ass = dir.join("shifted.ass");
        fs::write(&shifted_ass, &ass).expect("write ass");

        let mkv = dir.join("movie.mkv");
        let mux_out = Command::new(&ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-nostats",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=128x72:rate=10:duration=90",
                "-i",
            ])
            .arg(&decoy_wav)
            .arg("-i")
            .arg(&target_wav)
            .arg("-i")
            .arg(&shifted_ass)
            .args([
                "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-c:v", "mpeg4",
                "-c:a", "aac", "-c:s", "ass",
            ])
            .arg(&mkv)
            .stdin(Stdio::null())
            .output()
            .expect("run ffmpeg mux");
        assert!(
            mux_out.status.success(),
            "ffmpeg mux failed: {}",
            String::from_utf8_lossy(&mux_out.stderr)
        );

        let mkv_str = mkv.to_string_lossy().into_owned();
        let extracted_sub = dir.join("extracted_sub.ass");
        let sub_extract_args =
            autosync_extract_sub_args_ffmpeg(&mkv_str, &extracted_sub.to_string_lossy(), 0);
        let sub_out = Command::new(&ffmpeg)
            .args(&sub_extract_args)
            .stdin(Stdio::null())
            .output()
            .expect("extract embedded sub");
        assert!(
            sub_out.status.success(),
            "sub extract failed: {}",
            String::from_utf8_lossy(&sub_out.stderr)
        );

        let sub_bytes = fs::read(&extracted_sub).expect("read extracted sub");
        let decoded_sub = decode_subtitle_bytes_with_hint(&sub_bytes, SubtitleEncodingHint::Auto)
            .expect("decode sub");
        let cues = parse_subtitles(&decoded_sub).expect("parse extracted sub");
        assert_eq!(
            cues.len(),
            11,
            "expected 1 SDH + 10 spoken cues, got {}",
            cues.len()
        );

        let mpv_pcm = dir.join("mpv_track2.pcm");
        let mpv_args = autosync_extract_args_mpv(&mkv_str, &mpv_pcm.to_string_lossy(), Some(2));
        let mpv_out = Command::new(&mpv)
            .args(&mpv_args)
            .stdin(Stdio::null())
            .output()
            .expect("mpv extract track 2");
        assert!(
            mpv_out.status.success(),
            "mpv audio extract failed: {}",
            String::from_utf8_lossy(&mpv_out.stderr)
        );

        let ff_pcm = dir.join("ffmpeg_track2.pcm");
        let ff_args = autosync_extract_args_ffmpeg(&mkv_str, &ff_pcm.to_string_lossy(), Some(1));
        let ff_out = Command::new(&ffmpeg)
            .args(&ff_args)
            .stdin(Stdio::null())
            .output()
            .expect("ffmpeg extract track 2");
        assert!(
            ff_out.status.success(),
            "ffmpeg audio extract failed: {}",
            String::from_utf8_lossy(&ff_out.stderr)
        );

        let mut mpv_outcome_opt = None;
        for (label, pcm_path) in [("mpv", &mpv_pcm), ("ffmpeg", &ff_pcm)] {
            let pcm_bytes = fs::read(pcm_path).expect("read pcm");
            let mut builder = AudioEnvelopeBuilder::new();
            builder.push_pcm_s16le_bytes(&pcm_bytes);
            let envelope = builder.finish().expect("build envelope");
            let outcome = auto_align_subtitles(&cues, &envelope, &AutoSyncConfig::default())
                .unwrap_or_else(|e| panic!("{label} align failed: {e}"));
            assert!(
                (outcome.offset_ms - 4_700).abs() <= 60,
                "{label} offset_ms={} (expected ~4700)",
                outcome.offset_ms
            );
            assert!(!outcome.drift_applied, "{label} unexpectedly applied drift");
            if label == "mpv" {
                mpv_outcome_opt = Some(outcome);
            }
        }

        let mpv_outcome = mpv_outcome_opt.expect("mpv outcome");
        let out_dir = dir.join("out");
        let rescaled_path = write_rescaled_subtitle_file(
            &extracted_sub,
            &out_dir,
            mpv_outcome.scale,
            mpv_outcome.anchor_ms,
            mpv_outcome.offset_ms,
            SubtitleEncodingHint::Auto,
        )
        .expect("write rescaled ass");
        assert!(rescaled_path.is_file());
        let rescaled_text = fs::read_to_string(&rescaled_path).expect("read rescaled ass");
        assert!(rescaled_text.contains("Dialogue:"));
        assert!(
            rescaled_text.contains("{\\p1}") && rescaled_text.contains("0:00:14."),
            "vector drawing cue was not preserved/shifted: {rescaled_text}"
        );
        let rescaled_cues = parse_subtitles(&rescaled_text).expect("parse rescaled ass");
        assert_eq!(rescaled_cues.len(), 11);
        assert!(
            (rescaled_cues[1].start_ms as i64 - speech_bursts[0].0 as i64).abs() <= 70,
            "rescaled spoken cue 1 start_ms={} (expected ~{})",
            rescaled_cues[1].start_ms,
            speech_bursts[0].0
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
