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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;
    use tokio::process::Command;

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

    async fn run_command_with_watchdog(
        exe: &Path,
        args: &[String],
        watched_output: &Path,
        cancel: &Arc<AtomicBool>,
        low_power: bool,
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
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed starting {}: {e}", exe.display()))?;
        let stderr_pipe = child.stderr.take();

        let mut watchdog = StallWatchdog::new(
            Instant::now(),
            Duration::from_secs(DEFAULT_STALL_TIMEOUT_SECS),
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
                let mut err_buf = Vec::new();
                if let Some(mut se) = stderr_pipe {
                    use tokio::io::AsyncReadExt;
                    let _ = tokio::time::timeout(
                        Duration::from_millis(200),
                        se.read_to_end(&mut err_buf),
                    )
                    .await;
                }
                let snippet = String::from_utf8_lossy(&err_buf)
                    .lines()
                    .rev()
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

            let cur_size = fs::metadata(watched_output).map(|m| m.len()).unwrap_or(0);
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

        let video_pb = validate_existing_local_file_with_options(video_path, path_opts)
            .map_err(|e| e.to_string())?;
        let work_dir = temp_work_dir();
        fs::create_dir_all(&work_dir)
            .map_err(|e| format!("Failed creating auto-sync temp directory: {e}"))?;

        let ffmpeg_exe = resolve_ffmpeg_exe(app);
        let mut temp_extracted_sub: Option<PathBuf> = None;

        // Resolve external or embedded subtitle source
        let sub_pb = if let Some(sp) = subtitle_path {
            validate_existing_local_file_with_options(sp, path_opts).map_err(|e| e.to_string())?
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
            let out_sub = work_dir.join(format!("embedded_{}.{ext}", std::process::id()));
            let args = autosync_extract_sub_args_ffmpeg(
                video_pb.to_string_lossy().as_ref(),
                out_sub.to_string_lossy().as_ref(),
                sub_idx,
            );
            run_command_with_watchdog(ff, &args, &out_sub, &cancel, low_power).await?;
            temp_extracted_sub = Some(out_sub.clone());
            out_sub
        } else {
            return Err("No subtitle track or file selected for auto-sync.".to_string());
        };

        let pcm_path = work_dir.join(format!("audio_{}.pcm", std::process::id()));
        let _ = fs::remove_file(&pcm_path);

        let mpv_exe = resolve_mpv_exe(app)?;
        let mpv_args = autosync_extract_args_mpv(
            video_pb.to_string_lossy().as_ref(),
            pcm_path.to_string_lossy().as_ref(),
            audio_track_id,
        );
        let mpv_res =
            run_command_with_watchdog(&mpv_exe, &mpv_args, &pcm_path, &cancel, low_power).await;

        let extracted_ok = mpv_res.is_ok()
            && fs::metadata(&pcm_path)
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
                run_command_with_watchdog(ff, &ff_args, &pcm_path, &cancel, low_power).await?;
            } else {
                return Err(format_missing_extractor_error(
                    mpv_res.err().as_deref(),
                    false,
                ));
            }
        }

        // Stream PCM into envelope builder
        let sub_bytes =
            fs::read(&sub_pb).map_err(|e| format!("Failed reading subtitle file: {e}"))?;
        let decoded = decode_subtitle_bytes_with_hint(&sub_bytes, encoding_hint)
            .map_err(|e| e.to_string())?;
        let cues = parse_subtitles(&decoded).map_err(|e| e.to_string())?;

        let mut pcm_file = fs::File::open(&pcm_path)
            .map_err(|e| format!("Failed opening extracted audio PCM: {e}"))?;
        let mut builder = AudioEnvelopeBuilder::new();
        let mut buf = vec![0u8; 65_536];
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&pcm_path);
                return Err("Auto-sync cancelled.".to_string());
            }
            let n = pcm_file
                .read(&mut buf)
                .map_err(|e| format!("Failed reading extracted PCM: {e}"))?;
            if n == 0 {
                break;
            }
            builder.push_pcm_s16le_bytes(&buf[..n]);
        }
        let _ = fs::remove_file(&pcm_path);

        let envelope = builder.finish().map_err(|e| e.to_string())?;
        let audio_duration_secs = envelope.len() as f64 / 100.0;
        let outcome = auto_align_subtitles(&cues, &envelope, &AutoSyncConfig::default())
            .map_err(|e| e.to_string())?;

        let synced_pb = write_rescaled_subtitle_file(
            &sub_pb,
            &work_dir,
            outcome.scale,
            outcome.anchor_ms,
            outcome.offset_ms,
            encoding_hint,
        )?;

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
}
