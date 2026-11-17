use epilod_core::subtitle_sync::{
    decode_subtitle_bytes_with_hint, detect_subtitle_language, parse_subtitles, render_srt,
    render_vtt_with_transform, rescale_ass_text_with_transform, rescale_cues_with_transform,
    AutoSyncOutcome, SubtitleCue, SubtitleEncodingHint, SubtitleTimingTransform,
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

const CLOSED_CAPTION_CODECS: &[&str] = &["eia_608", "cea_608", "cea_708", "cc_dec"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleLangProbeTrackDto {
    pub track_id: u64,
    pub ff_index: Option<u64>,
    pub sub_stream_idx: Option<usize>,
    pub codec: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedSubtitleLangDto {
    pub track_id: u64,
    pub lang: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSyncResultDto {
    pub offset_secs: f64,
    pub scale: f64,
    pub confidence_z: f64,
    pub correlation: f64,
    pub drift_applied: bool,
    pub segments_applied: usize,
    #[serde(default)]
    pub bitmap_in_place: bool,
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

fn codec_in_list(codec: Option<&str>, list: &[&str]) -> bool {
    let Some(c) = codec.map(|s| s.trim().to_ascii_lowercase()) else {
        return false;
    };
    list.iter().any(|b| *b == c)
}

pub fn is_bitmap_subtitle_codec(codec: Option<&str>) -> bool {
    codec_in_list(codec, BITMAP_SUB_CODECS)
}

pub fn is_closed_caption_codec(codec: Option<&str>) -> bool {
    codec_in_list(codec, CLOSED_CAPTION_CODECS)
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
    write_rescaled_subtitle_file_with_transform(
        source_path,
        out_dir,
        &SubtitleTimingTransform::Linear {
            scale,
            anchor_ms,
            offset_ms,
        },
        encoding_hint,
    )
}

pub fn write_rescaled_subtitle_file_with_transform(
    source_path: &Path,
    out_dir: &Path,
    transform: &SubtitleTimingTransform,
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
            render_vtt_with_transform(&decoded, transform).map_err(|e| e.to_string())?,
        ),
        "ass" | "ssa" => (
            "ass",
            rescale_ass_text_with_transform(&decoded, transform).map_err(|e| e.to_string())?,
        ),
        _ => {
            let mut cues = parse_subtitles(&decoded).map_err(|e| e.to_string())?;
            rescale_cues_with_transform(&mut cues, transform).map_err(|e| e.to_string())?;
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

#[derive(Debug, Clone, Copy)]
struct BitmapPacketMeta {
    pts_ms: u64,
    dur_ms: u64,
    size: usize,
}

fn parse_timebase_header(line: &str) -> Option<(u128, u128)> {
    let rest = line.strip_prefix("#tb 0:")?.trim();
    let (num_s, den_s) = rest.split_once('/')?;
    let num = num_s.trim().parse::<u128>().ok()?;
    let den = den_s.trim().parse::<u128>().ok()?;
    if num > 0 && den > 0 {
        Some((num, den))
    } else {
        None
    }
}

/// Reconstruct dialogue-like `(start_ms, end_ms)` cues from `ffmpeg -c:s copy -f framecrc` output
/// for bitmap subtitle streams (`dvd_subtitle`, `hdmv_pgs_subtitle`, `dvb_subtitle`, `xsub`).
pub fn parse_bitmap_framecrc_cues(raw: &str, codec: Option<&str>) -> Result<Vec<SubtitleCue>, String> {
    let mut tb_num: u128 = 1;
    let mut tb_den: u128 = 1000;
    let mut packets: Vec<BitmapPacketMeta> = Vec::new();

    for raw_line in raw.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((num, den)) = parse_timebase_header(line) {
            tb_num = num;
            tb_den = den;
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let mut parts = line.split(',');
        let stream_ok = parts
            .next()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .is_some_and(|s| s == 0);
        if !stream_ok {
            continue;
        }
        let dts = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|&v| v >= 0);
        let pts = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|&v| v >= 0);
        let Some(ts_ticks) = pts.or(dts) else {
            continue;
        };
        let dur_ticks = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0)
            .max(0);
        let size = parts
            .next()
            .and_then(|s| s.trim().parse::<usize>().ok())
            .unwrap_or(0);

        let pts_ms = ((ts_ticks as u128).saturating_mul(1000).saturating_mul(tb_num) / tb_den) as u64;
        let dur_ms = ((dur_ticks as u128).saturating_mul(1000).saturating_mul(tb_num) / tb_den) as u64;
        packets.push(BitmapPacketMeta {
            pts_ms,
            dur_ms,
            size,
        });
    }

    if packets.is_empty() {
        return Err("Embedded image subtitle track contained no readable timing cues.".to_string());
    }

    packets.sort_by_key(|p| p.pts_ms);

    let codec_lower = codec.unwrap_or("").trim().to_ascii_lowercase();
    let is_pgs = codec_lower == "hdmv_pgs_subtitle" || codec_lower == "pgssub";
    let has_large_pgs = is_pgs && packets.iter().any(|p| p.size > 48);
    let clear_threshold = if has_large_pgs { 48 } else { 24 };

    let mut cues: Vec<SubtitleCue> = Vec::new();
    let mut open_start: Option<u64> = None;

    for pkt in packets {
        if pkt.dur_ms > 0 {
            if let Some(prev_start) = open_start.take() {
                if pkt.pts_ms >= prev_start + 100 {
                    cues.push(SubtitleCue {
                        index: cues.len() + 1,
                        start_ms: prev_start,
                        end_ms: pkt.pts_ms.min(prev_start + 5_000),
                        text: "dialogue".to_string(),
                    });
                }
            }
            cues.push(SubtitleCue {
                index: cues.len() + 1,
                start_ms: pkt.pts_ms,
                end_ms: pkt.pts_ms + pkt.dur_ms.clamp(200, 14_000),
                text: "dialogue".to_string(),
            });
            continue;
        }

        let is_clear_pkt = if is_pgs {
            has_large_pgs && pkt.size <= clear_threshold
        } else {
            pkt.size <= clear_threshold
        };
        if is_clear_pkt {
            if let Some(start) = open_start.take() {
                if pkt.pts_ms >= start + 100 {
                    cues.push(SubtitleCue {
                        index: cues.len() + 1,
                        start_ms: start,
                        end_ms: pkt.pts_ms.min(start + 14_000),
                        text: "dialogue".to_string(),
                    });
                }
            }
            continue;
        }

        if let Some(start) = open_start {
            if pkt.pts_ms.saturating_sub(start) >= 150 {
                cues.push(SubtitleCue {
                    index: cues.len() + 1,
                    start_ms: start,
                    end_ms: pkt.pts_ms.min(start + 4_500),
                    text: "dialogue".to_string(),
                });
                open_start = Some(pkt.pts_ms);
            }
        } else {
            open_start = Some(pkt.pts_ms);
        }
    }

    if let Some(start) = open_start.take() {
        cues.push(SubtitleCue {
            index: cues.len() + 1,
            start_ms: start,
            end_ms: start + 2_500,
            text: "dialogue".to_string(),
        });
    }

    if cues.is_empty() {
        return Err("Embedded image subtitle track contained no readable timing cues.".to_string());
    }
    Ok(cues)
}

pub fn resolve_in_place_delay_ms(cues: &[SubtitleCue], outcome: &AutoSyncOutcome) -> i64 {
    if !outcome.drift_applied && outcome.transform.segment_count() <= 1 {
        return outcome.offset_ms;
    }
    if cues.is_empty() {
        return outcome.offset_ms;
    }
    let mid = &cues[cues.len() / 2];
    match outcome.transform.map_cue(mid.start_ms, mid.end_ms) {
        Ok((mapped_start, _)) => (mapped_start as i64) - (mid.start_ms as i64),
        Err(_) => outcome.offset_ms,
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use crate::mpv::process::resolve_mpv_exe;
    use epilod_core::mpv_ipc::{
        autosync_extract_args_ffmpeg_dialogue, autosync_extract_args_mpv,
        autosync_extract_bitmap_framecrc_args_ffmpeg, autosync_extract_cc_args_ffmpeg,
        autosync_extract_stream_args_ffmpeg, autosync_extract_sub_args_ffmpeg,
        parse_ffmpeg_audio_stream_has_center, probe_extract_sub_sample_args_ffmpeg,
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
    fn prune_stale_work_files(dir: &Path, preserve: Option<&Path>) {
        let cutoff = Duration::from_secs(24 * 60 * 60);
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if preserve.is_some_and(|p| p == entry.path()) {
                continue;
            }
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

    async fn probe_ffmpeg_audio_has_center(
        ffmpeg_exe: &Path,
        video_pb: &Path,
        audio_stream_idx: usize,
    ) -> bool {
        let mut cmd = Command::new(ffmpeg_exe);
        cmd.args([
            "-nostdin",
            "-hide_banner",
            "-i",
            video_pb.to_string_lossy().as_ref(),
        ])
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

        let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await else {
            return false;
        };
        let stderr = String::from_utf8_lossy(&out.stderr);
        parse_ffmpeg_audio_stream_has_center(&stderr, audio_stream_idx)
    }

    #[allow(clippy::too_many_arguments)]
    async fn extract_embedded_subtitle(
        ffmpeg_exe: Option<&PathBuf>,
        video_pb: &Path,
        work_dir: &Path,
        sub_idx: Option<usize>,
        embedded_sub_ff_idx: Option<u64>,
        embedded_sub_codec: Option<&str>,
        cancel: &Arc<AtomicBool>,
        low_power: bool,
        pid: u32,
        job_seq: u64,
    ) -> Result<PathBuf, String> {
        if is_bitmap_subtitle_codec(embedded_sub_codec) {
            return Err(
                "Bitmap subtitles (PGS/VobSub) cannot be auto-synced. Load a text subtitle file (.srt, .ass, .vtt).".to_string()
            );
        }
        let Some(ff) = ffmpeg_exe else {
            return Err(
                "Extracting embedded subtitle tracks requires ffmpeg.exe alongside mpv.exe, or load an external subtitle file.".to_string()
            );
        };
        let is_cc = is_closed_caption_codec(embedded_sub_codec);
        let ext = if is_cc {
            "srt"
        } else {
            infer_sub_extension_from_codec(embedded_sub_codec)
        };
        let out_sub = work_dir.join(format!("embedded_{pid}_{job_seq}.{ext}"));
        let args = if is_cc {
            autosync_extract_cc_args_ffmpeg(
                video_pb.to_string_lossy().as_ref(),
                out_sub.to_string_lossy().as_ref(),
                None,
            )
        } else if let Some(ff_idx) = embedded_sub_ff_idx {
            autosync_extract_stream_args_ffmpeg(
                video_pb.to_string_lossy().as_ref(),
                out_sub.to_string_lossy().as_ref(),
                ff_idx,
            )
        } else if let Some(sub_idx) = sub_idx {
            autosync_extract_sub_args_ffmpeg(
                video_pb.to_string_lossy().as_ref(),
                out_sub.to_string_lossy().as_ref(),
                sub_idx,
            )
        } else {
            return Err("No subtitle track index available for auto-sync extraction.".to_string());
        };
        // Subtitle packets can be sparse across a huge remux, so the output file may legitimately
        // not grow for minutes while ffmpeg demuxes; rely on the overall ceiling instead of the
        // short stall timer here.
        if let Err(e) = run_command_with_watchdog(
            ff,
            &args,
            &out_sub,
            cancel,
            low_power,
            Duration::from_secs(DEFAULT_MAX_EXTRACT_SECS),
        )
        .await
        {
            let _ = fs::remove_file(&out_sub);
            return Err(e);
        }
        let extracted_bytes = tokio::fs::metadata(&out_sub)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if extracted_bytes == 0 {
            let _ = fs::remove_file(&out_sub);
            return Err(if is_cc {
                "No closed-caption text was found in this video stream.".to_string()
            } else {
                "Embedded subtitle track contained no readable cues.".to_string()
            });
        }
        Ok(out_sub)
    }

    #[allow(clippy::too_many_arguments)]
    async fn extract_bitmap_subtitle_cues(
        ffmpeg_exe: Option<&PathBuf>,
        video_pb: &Path,
        work_dir: &Path,
        sub_idx: Option<usize>,
        embedded_sub_ff_idx: Option<u64>,
        embedded_sub_codec: Option<&str>,
        cancel: &Arc<AtomicBool>,
        low_power: bool,
        pid: u32,
        job_seq: u64,
    ) -> Result<Vec<SubtitleCue>, String> {
        let Some(ff) = ffmpeg_exe else {
            return Err(
                "Syncing embedded image subtitles requires ffmpeg.exe alongside mpv.exe, or load an external subtitle file."
                    .to_string(),
            );
        };
        if embedded_sub_ff_idx.is_none() && sub_idx.is_none() {
            return Err("No subtitle track index available for bitmap timing extraction.".to_string());
        }
        let out_crc = work_dir.join(format!("bitmap_{pid}_{job_seq}.framecrc.txt"));
        let args = autosync_extract_bitmap_framecrc_args_ffmpeg(
            video_pb.to_string_lossy().as_ref(),
            out_crc.to_string_lossy().as_ref(),
            embedded_sub_ff_idx,
            sub_idx.unwrap_or(0),
        );
        if let Err(e) = run_command_with_watchdog(
            ff,
            &args,
            &out_crc,
            cancel,
            low_power,
            Duration::from_secs(DEFAULT_MAX_EXTRACT_SECS),
        )
        .await
        {
            let _ = fs::remove_file(&out_crc);
            return Err(e);
        }
        let raw = fs::read_to_string(&out_crc)
            .map_err(|e| format!("Failed reading extracted bitmap timing data: {e}"));
        let _ = fs::remove_file(&out_crc);
        parse_bitmap_framecrc_cues(&raw?, embedded_sub_codec)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn execute_auto_sync(
        app: &AppHandle,
        controller: &AutoSyncController,
        video_path: &str,
        subtitle_path: Option<&str>,
        audio_track_id: Option<u64>,
        embedded_sub_idx: Option<usize>,
        embedded_sub_ff_idx: Option<u64>,
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
                let ext_sub = match sub_owned {
                    Some(sp) => Some(
                        validate_existing_local_file_with_options(&sp, path_opts)
                            .map_err(|e| e.to_string())?,
                    ),
                    None => None,
                };
                prune_stale_work_files(&work_dir, ext_sub.as_deref());
                let ffmpeg_exe = resolve_ffmpeg_exe(&app_clone);
                let mpv_exe = resolve_mpv_exe(&app_clone)?;
                Ok::<_, String>((video_pb, work_dir, ffmpeg_exe, mpv_exe, ext_sub))
            })
            .await
            .map_err(|e| format!("Auto-sync preparation failed: {e}"))??;

        let mut temp_extracted_sub: Option<PathBuf> = None;
        let mut pre_parsed_cues: Option<Vec<SubtitleCue>> = None;
        let mut sub_pb: Option<PathBuf> = None;

        // Resolve external text file, embedded bitmap stream timing, or embedded text/CC extraction
        if let Some(sp) = external_sub_pb {
            sub_pb = Some(sp);
        } else if (embedded_sub_ff_idx.is_some() || embedded_sub_idx.is_some())
            && is_bitmap_subtitle_codec(embedded_sub_codec)
        {
            let cues = extract_bitmap_subtitle_cues(
                ffmpeg_exe.as_ref(),
                &video_pb,
                &work_dir,
                embedded_sub_idx,
                embedded_sub_ff_idx,
                embedded_sub_codec,
                &cancel,
                low_power,
                pid,
                job_seq,
            )
            .await?;
            pre_parsed_cues = Some(cues);
        } else if embedded_sub_ff_idx.is_some() || embedded_sub_idx.is_some() {
            let out_sub = extract_embedded_subtitle(
                ffmpeg_exe.as_ref(),
                &video_pb,
                &work_dir,
                embedded_sub_idx,
                embedded_sub_ff_idx,
                embedded_sub_codec,
                &cancel,
                low_power,
                pid,
                job_seq,
            )
            .await?;
            temp_extracted_sub = Some(out_sub.clone());
            sub_pb = Some(out_sub);
        } else {
            return Err("No subtitle track or file selected for auto-sync.".to_string());
        }

        let pcm_path = work_dir.join(format!("audio_{pid}_{job_seq}.pcm"));
        let _ = tokio::fs::remove_file(&pcm_path).await;

        let stall = Duration::from_secs(DEFAULT_STALL_TIMEOUT_SECS);
        let stream_idx = audio_track_id.map(|id| id.saturating_sub(1) as usize);
        let mut extracted_ok = false;
        let mut ff_err: Option<String> = None;

        if let Some(ref ff) = ffmpeg_exe {
            let prefer_center =
                probe_ffmpeg_audio_has_center(ff, &video_pb, stream_idx.unwrap_or(0)).await;
            let ff_args = autosync_extract_args_ffmpeg_dialogue(
                video_pb.to_string_lossy().as_ref(),
                pcm_path.to_string_lossy().as_ref(),
                stream_idx,
                prefer_center,
            );
            let ff_res =
                run_command_with_watchdog(ff, &ff_args, &pcm_path, &cancel, low_power, stall).await;
            extracted_ok = ff_res.is_ok()
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
                ff_err = ff_res.err();
            }
        }

        if !extracted_ok {
            let mpv_args = autosync_extract_args_mpv(
                video_pb.to_string_lossy().as_ref(),
                pcm_path.to_string_lossy().as_ref(),
                audio_track_id,
            );
            let mpv_res = run_command_with_watchdog(
                &mpv_exe, &mpv_args, &pcm_path, &cancel, low_power, stall,
            )
            .await;
            extracted_ok = mpv_res.is_ok()
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
                return Err(format_missing_extractor_error(
                    mpv_res.err().or(ff_err).as_deref(),
                    ffmpeg_exe.is_some(),
                ));
            }
        }

        // Stream PCM, decode/parse subtitles, and run CPU-bound alignment off the async executor
        let cancel_clone = Arc::clone(&cancel);
        let sub_pb_clone = sub_pb.clone();
        let pcm_path_clone = pcm_path.clone();
        let work_dir_clone = work_dir.clone();
        // Embedded subtitles extracted by ffmpeg are always UTF-8; never apply a legacy Windows
        // codepage override from user preferences onto fresh UTF-8 extraction output.
        let effective_hint = if temp_extracted_sub.is_some() {
            SubtitleEncodingHint::Utf8
        } else {
            encoding_hint
        };
        let (outcome, audio_duration_secs, synced_pb, applied_offset_ms) =
            tokio::task::spawn_blocking(move || {
                let cues = if let Some(bitmap_cues) = pre_parsed_cues {
                    bitmap_cues
                } else {
                    let Some(ref target_pb) = sub_pb_clone else {
                        let _ = fs::remove_file(&pcm_path_clone);
                        return Err("Missing subtitle path for auto-sync.".to_string());
                    };
                    let sub_bytes = match fs::read(target_pb) {
                        Ok(b) => b,
                        Err(e) => {
                            let _ = fs::remove_file(&pcm_path_clone);
                            return Err(format!("Failed reading subtitle file: {e}"));
                        }
                    };
                    let decoded = match decode_subtitle_bytes_with_hint(&sub_bytes, effective_hint) {
                        Ok(d) => d,
                        Err(e) => {
                            let _ = fs::remove_file(&pcm_path_clone);
                            return Err(e.to_string());
                        }
                    };
                    match parse_subtitles(&decoded) {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = fs::remove_file(&pcm_path_clone);
                            return Err(e.to_string());
                        }
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

                if let Some(ref target_pb) = sub_pb_clone {
                    let synced_pb = write_rescaled_subtitle_file_with_transform(
                        target_pb,
                        &work_dir_clone,
                        &outcome.transform,
                        effective_hint,
                    )?;
                    let offset_ms = outcome.offset_ms;
                    Ok((outcome, audio_duration_secs, Some(synced_pb), offset_ms))
                } else {
                    let delay_ms = resolve_in_place_delay_ms(&cues, &outcome);
                    Ok((outcome, audio_duration_secs, None, delay_ms))
                }
            })
            .await
            .map_err(|e| format!("Auto-sync worker failed: {e}"))??;

        let segments_applied = outcome.transform.segment_count();
        let bitmap_in_place = synced_pb.is_none();
        Ok(AutoSyncResultDto {
            offset_secs: if bitmap_in_place {
                applied_offset_ms as f64 / 1000.0
            } else {
                outcome.offset_ms as f64 / 1000.0
            },
            scale: outcome.scale,
            confidence_z: outcome.confidence_z,
            correlation: outcome.correlation,
            drift_applied: outcome.drift_applied,
            segments_applied,
            bitmap_in_place,
            synced_subtitle_path: synced_pb
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            source_subtitle_path: if bitmap_in_place {
                String::new()
            } else {
                temp_extracted_sub
                    .as_ref()
                    .or(sub_pb.as_ref())
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
            },
            audio_duration_secs,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn execute_two_anchor_sync(
        app: &AppHandle,
        subtitle_path: Option<&str>,
        video_path: Option<&str>,
        embedded_sub_idx: Option<usize>,
        embedded_sub_ff_idx: Option<u64>,
        embedded_sub_codec: Option<&str>,
        src_a_secs: f64,
        dst_a_secs: f64,
        src_b_secs: f64,
        dst_b_secs: f64,
        encoding_hint: SubtitleEncodingHint,
        path_opts: LocalPathOptions,
    ) -> Result<AutoSyncResultDto, String> {
        let start = Instant::now();
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

        let (sub_pb, is_extracted) = if let Some(sp) =
            subtitle_path.filter(|s| !s.trim().is_empty())
        {
            let sp_owned = sp.to_string();
            let pb = tokio::task::spawn_blocking(move || {
                validate_existing_local_file_with_options(&sp_owned, path_opts)
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| format!("Two-anchor sync preparation failed: {e}"))??;
            (pb, false)
        } else if let (Some(vp), true) = (
            video_path.filter(|s| !s.trim().is_empty()),
            embedded_sub_ff_idx.is_some() || embedded_sub_idx.is_some(),
        ) {
            let app_clone = app.clone();
            let vp_owned = vp.to_string();
            let (video_pb, work_dir, ffmpeg_exe) = tokio::task::spawn_blocking(move || {
                let video_pb = validate_existing_local_file_with_options(&vp_owned, path_opts)
                    .map_err(|e| e.to_string())?;
                let work_dir = temp_work_dir();
                fs::create_dir_all(&work_dir)
                    .map_err(|e| format!("Failed creating auto-sync temp directory: {e}"))?;
                let ffmpeg_exe = resolve_ffmpeg_exe(&app_clone);
                Ok::<_, String>((video_pb, work_dir, ffmpeg_exe))
            })
            .await
            .map_err(|e| format!("Two-anchor sync preparation failed: {e}"))??;
            let cancel = Arc::new(AtomicBool::new(false));
            let job_seq = AUTOSYNC_JOB_SEQ.fetch_add(1, Ordering::Relaxed);
            let extracted = extract_embedded_subtitle(
                ffmpeg_exe.as_ref(),
                &video_pb,
                &work_dir,
                embedded_sub_idx,
                embedded_sub_ff_idx,
                embedded_sub_codec,
                &cancel,
                false,
                std::process::id(),
                job_seq,
            )
            .await?;
            (extracted, true)
        } else {
            return Err(
                "Load an external subtitle file or select a text subtitle track first.".to_string(),
            );
        };

        let effective_hint = if is_extracted {
            SubtitleEncodingHint::Utf8
        } else {
            encoding_hint
        };
        let sub_pb_clone = sub_pb.clone();
        let synced_pb = tokio::task::spawn_blocking(move || {
            write_rescaled_subtitle_file(
                &sub_pb_clone,
                &temp_work_dir(),
                scale,
                src_a_ms,
                offset_ms,
                effective_hint,
            )
        })
        .await
        .map_err(|e| format!("Two-anchor sync task failed: {e}"))??;

        Ok(AutoSyncResultDto {
            offset_secs: offset_ms as f64 / 1000.0,
            scale,
            confidence_z: 10.0,
            correlation: 1.0,
            drift_applied: (scale - 1.0).abs() > 1e-4,
            segments_applied: 1,
            bitmap_in_place: false,
            synced_subtitle_path: synced_pb.to_string_lossy().into_owned(),
            source_subtitle_path: sub_pb.to_string_lossy().into_owned(),
            audio_duration_secs: 0.0,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn run_ffmpeg_sample_extract(
        ffmpeg_exe: &Path,
        args: &[String],
    ) -> Result<(), String> {
        let mut child = Command::new(ffmpeg_exe)
            .args(args)
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed starting {}: {e}", ffmpeg_exe.display()))?;
        match tokio::time::timeout(Duration::from_secs(6), child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(status)) => Err(format!("ffmpeg sample exited with status {status}")),
            Ok(Err(e)) => Err(format!("ffmpeg sample wait failed: {e}")),
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Err("ffmpeg subtitle language probe timed out".to_string())
            }
        }
    }

    /// Detect languages for untagged embedded text subtitle tracks by extracting bounded samples
    /// with FFmpeg and scoring script + dialogue cues. Bitmap and CC tracks are skipped cleanly.
    pub async fn detect_embedded_subtitle_languages_from_video(
        app: &AppHandle,
        video_path: &str,
        tracks: &[SubtitleLangProbeTrackDto],
        path_opts: LocalPathOptions,
    ) -> Result<Vec<DetectedSubtitleLangDto>, String> {
        if tracks.is_empty() {
            return Ok(Vec::new());
        }
        let app_clone = app.clone();
        let video_owned = video_path.to_string();
        let (video_pb, work_dir, ffmpeg_exe) = tokio::task::spawn_blocking(move || {
            let video_pb = validate_existing_local_file_with_options(&video_owned, path_opts)
                .map_err(|e| e.to_string())?;
            let work_dir = temp_work_dir();
            fs::create_dir_all(&work_dir)
                .map_err(|e| format!("Failed creating probe directory: {e}"))?;
            let ffmpeg_exe = resolve_ffmpeg_exe(&app_clone);
            Ok::<_, String>((video_pb, work_dir, ffmpeg_exe))
        })
        .await
        .map_err(|e| format!("Subtitle language probe setup failed: {e}"))??;

        let Some(ff) = ffmpeg_exe else {
            return Ok(Vec::new());
        };
        let pid = std::process::id();
        let mut results = Vec::new();

        for track in tracks.iter().take(8) {
            if is_bitmap_subtitle_codec(track.codec.as_deref())
                || is_closed_caption_codec(track.codec.as_deref())
            {
                continue;
            }
            if track.ff_index.is_none() && track.sub_stream_idx.is_none() {
                continue;
            }
            let sub_idx = track.sub_stream_idx.unwrap_or(0);
            let ext = infer_sub_extension_from_codec(track.codec.as_deref());
            let job_seq = AUTOSYNC_JOB_SEQ.fetch_add(1, Ordering::Relaxed);
            let sample_path = work_dir.join(format!("lang_probe_{pid}_{job_seq}.{ext}"));

            let mut detected: Option<&'static str> = None;
            for max_secs in [900u64, 0u64] {
                let args = probe_extract_sub_sample_args_ffmpeg(
                    video_pb.to_string_lossy().as_ref(),
                    sample_path.to_string_lossy().as_ref(),
                    track.ff_index,
                    sub_idx,
                    max_secs,
                );
                let ok = run_ffmpeg_sample_extract(&ff, &args).await.is_ok();
                let bytes = if ok {
                    let path_clone = sample_path.clone();
                    tokio::task::spawn_blocking(move || fs::read(&path_clone).ok())
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                let _ = fs::remove_file(&sample_path);
                if !bytes.is_empty() {
                    let slice = &bytes[..bytes.len().min(256 * 1024)];
                    if let Ok(decoded) =
                        decode_subtitle_bytes_with_hint(slice, SubtitleEncodingHint::Auto)
                    {
                        detected = detect_subtitle_language(&decoded);
                        if detected.is_some() || bytes.len() >= 256 {
                            break;
                        }
                    }
                }
            }
            if let Some(lang) = detected {
                results.push(DetectedSubtitleLangDto {
                    track_id: track.track_id,
                    lang: lang.to_string(),
                });
            }
        }

        Ok(results)
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
    fn test_parse_bitmap_framecrc_cues_and_aligns_dvd_and_pgs() {
        use epilod_core::subtitle_sync::{
            auto_align_subtitles, AudioEnvelopeBuilder, AutoSyncConfig,
        };

        // 1. DVD_SUBTITLE with 90kHz timebase + AV_NOPTS_VALUE + explicit durations
        let dvd_crc = "\
#tb 0: 1/90000
#media_type 0: subtitle
#codec_id 0: dvd_subtitle
0, -9223372036854775808, -9223372036854775808, 0, 120, 0x00000001
0, 180000, 180000, 180000, 1420, 0x11111111
0, 630000, 630000, 225000, 1580, 0x22222222
";
        let dvd_cues = parse_bitmap_framecrc_cues(dvd_crc, Some("dvd_subtitle")).unwrap();
        assert_eq!(dvd_cues.len(), 2);
        assert_eq!(dvd_cues[0].start_ms, 2_000);
        assert_eq!(dvd_cues[0].end_ms, 4_000);
        assert_eq!(dvd_cues[1].start_ms, 7_000);
        assert_eq!(dvd_cues[1].end_ms, 9_500);

        // 2. HDMV_PGS_SUBTITLE with 1/1000 timebase, multi-packet display set debounce, and clear packets
        let mut pgs_crc = String::from(
            "#tb 0: 1/1000\n#media_type 0: subtitle\n#codec_id 0: hdmv_pgs_subtitle\n",
        );
        // Non-periodic dialogue cadence prevents artificial correlation sidelobes in synthetic PCM.
        let speech_windows: [(u64, u64); 10] = [
            (2_000, 3_600),
            (5_100, 8_400),
            (12_800, 14_100),
            (15_400, 18_900),
            (24_200, 25_600),
            (27_000, 31_100),
            (37_500, 39_200),
            (41_000, 44_700),
            (48_200, 49_800),
            (51_500, 55_400),
        ];
        // PGS cues shifted early by 2.40s relative to audio
        let shift_early_ms: u64 = 2_400;
        for (idx, &(audio_start, audio_end)) in speech_windows.iter().enumerate() {
            let sub_start = audio_start + shift_early_ms;
            let sub_end = audio_end + shift_early_ms;
            pgs_crc.push_str(&format!("0, {sub_start}, {sub_start}, 0, 1850, 0xaaa{idx}\n"));
            // Split packet 30ms later for the same cue must not duplicate cue
            let split_t = sub_start + 30;
            pgs_crc.push_str(&format!("0, {split_t}, {split_t}, 0, 420, 0xbbb{idx}\n"));
            // Clear packet closes the open cue
            pgs_crc.push_str(&format!("0, {sub_end}, {sub_end}, 0, 19, 0xccc{idx}\n"));
        }

        let pgs_cues = parse_bitmap_framecrc_cues(&pgs_crc, Some("hdmv_pgs_subtitle")).unwrap();
        assert_eq!(pgs_cues.len(), 10);
        assert_eq!(pgs_cues[0].start_ms, 4_400);
        assert_eq!(pgs_cues[0].end_ms, 6_000);

        // Synthetic 60s speech envelope matching speech_windows
        let total_samples = 60 * 16_000;
        let mut pcm = Vec::with_capacity(total_samples * 2);
        for s in 0..total_samples {
            let t_ms = (s as u64 * 1000) / 16_000;
            let in_speech = speech_windows
                .iter()
                .any(|&(st, en)| t_ms >= st && t_ms <= en);
            let amp: i16 = if in_speech {
                if (s / 24) % 2 == 0 {
                    9_000
                } else {
                    -9_000
                }
            } else {
                0
            };
            pcm.extend_from_slice(&amp.to_le_bytes());
        }
        let mut builder = AudioEnvelopeBuilder::new();
        builder.push_pcm_s16le_bytes(&pcm);
        let env = builder.finish().unwrap();

        let outcome =
            auto_align_subtitles(&pgs_cues, &env, &AutoSyncConfig::default()).expect("PGS align");
        let applied_ms = resolve_in_place_delay_ms(&pgs_cues, &outcome);
        assert!(
            (applied_ms + shift_early_ms as i64).abs() <= 80,
            "applied_ms={applied_ms} expected ~-{}",
            shift_early_ms
        );
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

    #[test]
    fn test_write_rescaled_subtitle_file_with_piecewise_transform_formats() {
        use epilod_core::subtitle_sync::{
            parse_subtitles, SubtitleEncodingHint, SubtitleTimingTransform, TimingSegment,
        };
        use std::fs;

        let dir = std::env::temp_dir().join(format!("epilod_piecewise_fmt_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        let out_dir = dir.join("out");

        let transform = SubtitleTimingTransform::Piecewise {
            segments: vec![
                TimingSegment {
                    start_src_ms: 0,
                    scale: 1.0,
                    anchor_ms: 0,
                    offset_ms: 2_000,
                },
                TimingSegment {
                    start_src_ms: 20_000,
                    scale: 1.0,
                    anchor_ms: 20_000,
                    offset_ms: -4_000,
                },
            ],
        };

        // 1. SRT
        let srt_path = dir.join("sample.srt");
        fs::write(
            &srt_path,
            "1\n00:00:05,000 --> 00:00:07,000\nFirst act\n\n2\n00:00:25,000 --> 00:00:27,500\nSecond act\n",
        )
        .unwrap();
        let synced_srt = write_rescaled_subtitle_file_with_transform(
            &srt_path,
            &out_dir,
            &transform,
            SubtitleEncodingHint::Utf8,
        )
        .expect("piecewise srt");
        let parsed_srt = parse_subtitles(&fs::read_to_string(&synced_srt).unwrap()).unwrap();
        assert_eq!(parsed_srt[0].start_ms, 7_000);
        assert_eq!(parsed_srt[1].start_ms, 21_000);

        // 2. WebVTT preserving cue settings
        let vtt_path = dir.join("sample.vtt");
        fs::write(
            &vtt_path,
            "WEBVTT\n\n00:00:05.000 --> 00:00:07.000 align:start position:10%\nFirst act\n\n00:00:25.000 --> 00:00:27.500 line:85%\nSecond act\n",
        )
        .unwrap();
        let synced_vtt = write_rescaled_subtitle_file_with_transform(
            &vtt_path,
            &out_dir,
            &transform,
            SubtitleEncodingHint::Utf8,
        )
        .expect("piecewise vtt");
        let vtt_text = fs::read_to_string(&synced_vtt).unwrap();
        assert!(vtt_text.contains("00:00:07.000 --> 00:00:09.000 align:start position:10%"));
        assert!(vtt_text.contains("00:00:21.000 --> 00:00:23.500 line:85%"));

        // 3. ASS preserving vector drawing in segment 1 and shifting act 2 cleanly
        let ass_path = dir.join("sample.ass");
        fs::write(
            &ass_path,
            "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:07.00,Sign,,0,0,0,,{\\p1}m 0 0 l 10 0 10 10{\\p0}\nDialogue: 0,0:00:25.00,0:00:27.50,Default,,0,0,0,,Second act line\n",
        )
        .unwrap();
        let synced_ass = write_rescaled_subtitle_file_with_transform(
            &ass_path,
            &out_dir,
            &transform,
            SubtitleEncodingHint::Utf8,
        )
        .expect("piecewise ass");
        let ass_text = fs::read_to_string(&synced_ass).unwrap();
        assert!(ass_text.contains("Dialogue: 0,0:00:07.00,0:00:09.00,Sign"));
        assert!(ass_text.contains("{\\p1}"));
        assert!(ass_text.contains("Dialogue: 0,0:00:21.00,0:00:23.50,Default"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Real 5.1 surround MKV integration test with bundled `ffmpeg.exe`:
    /// verifies that center-channel probe (`parse_ffmpeg_audio_stream_has_center`) detects 5.1,
    /// center-weighted extraction (`autosync_extract_args_ffmpeg_dialogue`) isolates `FC` dialogue
    /// away from heavy L/R/LFE music, and piecewise commercial-cut alignment recovers both acts.
    #[cfg(windows)]
    #[test]
    fn test_real_5_1_surround_mkv_center_dialogue_and_piecewise_cut_autosync() {
        use epilod_core::mpv_ipc::{
            autosync_extract_args_ffmpeg_dialogue, parse_ffmpeg_audio_stream_has_center,
        };
        use epilod_core::subtitle_sync::{
            auto_align_subtitles, AudioEnvelopeBuilder, AutoSyncConfig, SubtitleCue,
        };
        use std::fs;
        use std::path::Path;
        use std::process::{Command, Stdio};

        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("resources/mpv/ffmpeg.exe");
        if !ffmpeg.is_file() {
            return;
        }

        let dir = std::env::temp_dir().join(format!("epilod_51_e2e_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");

        let sample_rate = 48_000usize;
        let duration_secs = 210usize;
        let total_samples = sample_rate * duration_secs;
        let channels = 6usize; // 5.1 layout: FL(0), FR(1), FC(2), LFE(3), BL(4), BR(5)

        // Act 1 dialogue bursts (6..88s), commercial break gap (88..112s), Act 2 bursts (112..198s)
        // Varied phrase lengths and conversational pauses (matching real dialogue cadence).
        let speech_bursts: &[(u64, u64)] = &[
            // Act 1 (15 bursts)
            (6_200, 1_100),
            (9_400, 2_800),
            (15_900, 950),
            (22_400, 3_400),
            (28_100, 1_300),
            (31_600, 1_900),
            (39_800, 2_700),
            (44_100, 1_050),
            (51_200, 3_200),
            (56_800, 1_400),
            (60_500, 2_100),
            (69_200, 1_150),
            (72_900, 3_100),
            (79_400, 1_500),
            (84_200, 2_400),
            // Act 2 (15 bursts)
            (113_100, 2_600),
            (117_800, 1_100),
            (124_500, 3_300),
            (130_200, 1_450),
            (133_900, 2_200),
            (141_600, 950),
            (147_800, 2_900),
            (153_200, 1_250),
            (161_400, 3_100),
            (166_900, 1_600),
            (170_800, 2_000),
            (179_100, 1_150),
            (182_700, 3_400),
            (189_600, 1_350),
            (194_900, 2_500),
        ];

        let mut fc_samples = vec![0.0f32; total_samples];
        for &(start_ms, len_ms) in speech_bursts {
            let s_idx = (start_ms as usize * sample_rate) / 1000;
            let e_idx = (((start_ms + len_ms) as usize) * sample_rate) / 1000;
            for (i, sample) in fc_samples[s_idx..e_idx].iter_mut().enumerate() {
                let t = i as f32 / sample_rate as f32;
                *sample = 0.28 * (2.0 * std::f32::consts::PI * 680.0 * t).sin()
                    + 0.12 * (2.0 * std::f32::consts::PI * 1360.0 * t).sin();
            }
        }

        // Write 6-channel 16-bit PCM WAV directly with loud non-speech L/R/LFE background
        let surround_wav = dir.join("surround_51.wav");
        let data_len = (total_samples * channels * 2) as u32;
        let mut wav_bytes = Vec::with_capacity(44 + data_len as usize);
        wav_bytes.extend_from_slice(b"RIFF");
        wav_bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav_bytes.extend_from_slice(b"WAVEfmt ");
        wav_bytes.extend_from_slice(&16u32.to_le_bytes());
        wav_bytes.extend_from_slice(&1u16.to_le_bytes());
        wav_bytes.extend_from_slice(&(channels as u16).to_le_bytes());
        wav_bytes.extend_from_slice(&(sample_rate as u32).to_le_bytes());
        wav_bytes.extend_from_slice(&((sample_rate * channels * 2) as u32).to_le_bytes());
        wav_bytes.extend_from_slice(&((channels * 2) as u16).to_le_bytes());
        wav_bytes.extend_from_slice(&16u16.to_le_bytes());
        wav_bytes.extend_from_slice(b"data");
        wav_bytes.extend_from_slice(&data_len.to_le_bytes());

        for (n, &center) in fc_samples.iter().enumerate() {
            let t = n as f32 / sample_rate as f32;
            // Heavy music + bass in L/R/LFE across the whole timeline including silence gaps
            let music_lr = 0.22 * (2.0 * std::f32::consts::PI * 440.0 * t).sin()
                + 0.14 * (2.0 * std::f32::consts::PI * 880.0 * t).sin();
            let bass_lfe = 0.35 * (2.0 * std::f32::consts::PI * 95.0 * t).sin();
            let frame = [music_lr, -music_lr, center, bass_lfe, 0.0, 0.0];
            for s in frame {
                let pcm = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                wav_bytes.extend_from_slice(&pcm.to_le_bytes());
            }
        }
        fs::write(&surround_wav, wav_bytes).expect("write 5.1 wav");

        let mkv = dir.join("surround.mkv");
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
                "testsrc=size=64x48:rate=5:duration=210",
                "-i",
            ])
            .arg(&surround_wav)
            .args([
                "-map", "0:v", "-map", "1:a", "-c:v", "mpeg4", "-c:a", "aac", "-ac", "6",
            ])
            .arg(&mkv)
            .stdin(Stdio::null())
            .output()
            .expect("mux 5.1 mkv");
        assert!(
            mux_out.status.success(),
            "5.1 mux failed: {}",
            String::from_utf8_lossy(&mux_out.stderr)
        );

        let mkv_str = mkv.to_string_lossy().into_owned();
        let probe_out = Command::new(&ffmpeg)
            .args(["-nostdin", "-hide_banner", "-i", &mkv_str])
            .stdin(Stdio::null())
            .output()
            .expect("probe 5.1 mkv");
        let probe_stderr = String::from_utf8_lossy(&probe_out.stderr);
        assert!(
            parse_ffmpeg_audio_stream_has_center(&probe_stderr, 0),
            "expected ffmpeg probe to detect 5.1 center channel in: {probe_stderr}"
        );

        let pcm_path = dir.join("dialogue.pcm");
        let ff_args = autosync_extract_args_ffmpeg_dialogue(
            &mkv_str,
            &pcm_path.to_string_lossy(),
            Some(0),
            true,
        );
        let ff_out = Command::new(&ffmpeg)
            .args(&ff_args)
            .stdin(Stdio::null())
            .output()
            .expect("extract 5.1 dialogue pcm");
        assert!(
            ff_out.status.success(),
            "5.1 extract failed: {}",
            String::from_utf8_lossy(&ff_out.stderr)
        );

        let pcm_bytes = fs::read(&pcm_path).expect("read extracted pcm");
        let mut builder = AudioEnvelopeBuilder::new();
        builder.push_pcm_s16le_bytes(&pcm_bytes);
        let envelope = builder.finish().expect("envelope");

        // Subtitles came from a broadcast cut: Act 1 runs 4.5s late, and a 15s commercial break
        // was removed between acts so Act 2 runs 10.5s early (15s jump between acts).
        let cues: Vec<SubtitleCue> = speech_bursts
            .iter()
            .enumerate()
            .map(|(i, &(audio_start_ms, len_ms))| {
                let sub_start = if i < 15 {
                    audio_start_ms + 4_500
                } else {
                    audio_start_ms - 10_500
                };
                SubtitleCue {
                    index: i + 1,
                    start_ms: sub_start,
                    end_ms: sub_start + len_ms,
                    text: format!("Line {}", i + 1),
                }
            })
            .collect();

        let outcome = auto_align_subtitles(&cues, &envelope, &AutoSyncConfig::default())
            .expect("5.1 piecewise align should succeed");
        assert!(
            outcome.transform.segment_count() >= 2,
            "expected >= 2 piecewise segments, got {} (transform={:?})",
            outcome.transform.segment_count(),
            outcome.transform
        );
        for (i, &(audio_start_ms, len_ms)) in speech_bursts.iter().enumerate() {
            let (mapped_start, mapped_end) = outcome
                .transform
                .map_cue(cues[i].start_ms, cues[i].end_ms)
                .expect("map_cue succeeds");
            assert!(
                (mapped_start as i64 - audio_start_ms as i64).abs() <= 150,
                "cue {i} mapped_start={mapped_start}ms vs expected {audio_start_ms}ms",
            );
            assert!(
                (mapped_end as i64 - (audio_start_ms + len_ms) as i64).abs() <= 150,
                "cue {i} mapped_end={mapped_end}ms vs expected {}ms",
                audio_start_ms + len_ms
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// Real MP4 + CEA-608 bitstream closed-caption (`eia_608` / `cc_dec`) integration test:
    /// embeds ATSC A/53 SEI captions shifted +4.2s into an H.264 stream saved under a path with
    /// brackets, apostrophe, comma, and spaces, extracts them via `autosync_extract_cc_args_ffmpeg`,
    /// aligns against speech bursts, and verifies rescaled `.srt` output. Skips if ffmpeg is absent.
    #[cfg(windows)]
    #[test]
    fn test_real_cea608_closed_caption_mp4_extraction_and_autosync() {
        use epilod_core::mpv_ipc::{
            autosync_extract_args_ffmpeg_dialogue, autosync_extract_cc_args_ffmpeg,
        };
        use epilod_core::subtitle_sync::{
            auto_align_subtitles, decode_subtitle_bytes_with_hint, parse_subtitles,
            AudioEnvelopeBuilder, AutoSyncConfig, SubtitleEncodingHint,
        };
        use std::fs;
        use std::path::Path;
        use std::process::{Command, Stdio};

        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("resources/mpv/ffmpeg.exe");
        if !ffmpeg.is_file() {
            return;
        }

        let dir = std::env::temp_dir().join(format!("epilod_cc_e2e_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let tricky_dir = dir.join("Show [1080p], S01");
        fs::create_dir_all(&tricky_dir).expect("create temp dir");

        // 1. Encode a clean 70s, 10 fps H.264 Annex-B video (700 frames, no B-frames)
        let raw_h264 = dir.join("raw.h264");
        let enc = Command::new(&ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=128x72:r=10:d=70",
                "-c:v",
                "libx264",
                "-bf",
                "0",
                "-g",
                "25",
                "-f",
                "h264",
            ])
            .arg(&raw_h264)
            .stdin(Stdio::null())
            .output()
            .expect("encode raw h264");
        assert!(
            enc.status.success(),
            "{}",
            String::from_utf8_lossy(&enc.stderr)
        );

        let raw_bytes = fs::read(&raw_h264).expect("read h264");
        let odd_parity = |b: u8| -> u8 {
            let v = b & 0x7F;
            if v.count_ones().is_multiple_of(2) {
                v | 0x80
            } else {
                v
            }
        };
        let make_sei = |pairs: &[(u8, u8)]| -> Vec<u8> {
            let mut payload = vec![0xB5, 0x00, 0x31, b'G', b'A', b'9', b'4', 0x03];
            payload.push(0x40 | (pairs.len() as u8 & 0x1F));
            payload.push(0xFF);
            for &(c1, c2) in pairs {
                payload.extend([0xFC, odd_parity(c1), odd_parity(c2)]);
            }
            payload.push(0xFF);
            let mut sei = vec![0x04];
            let mut rem = payload.len();
            while rem >= 255 {
                sei.push(255);
                rem -= 255;
            }
            sei.push(rem as u8);
            sei.extend_from_slice(&payload);
            sei.push(0x80);
            let mut nalu = vec![0, 0, 0, 1, 0x06];
            let mut zeros = 0u8;
            for b in sei {
                if zeros >= 2 && b <= 3 {
                    nalu.push(3);
                    zeros = 0;
                }
                nalu.push(b);
                zeros = if b == 0 { zeros + 1 } else { 0 };
            }
            nalu
        };

        // 10 varied dialogue bursts inside 70s audio; CEA-608 captions live +4.2s late
        let bursts: &[(u64, u64)] = &[
            (5_000, 1_400),
            (9_200, 2_300),
            (15_600, 1_100),
            (20_100, 2_700),
            (26_800, 1_500),
            (31_400, 2_100),
            (38_900, 1_300),
            (43_200, 2_600),
            (50_700, 1_600),
            (56_100, 2_200),
        ];
        let cc_shift_ms = 4_200u64;
        let mut cc_by_frame = std::collections::HashMap::<usize, Vec<(u8, u8)>>::new();
        for (idx, &(s_ms, len_ms)) in bursts.iter().enumerate() {
            let show_f = ((s_ms + cc_shift_ms) / 100) as usize;
            let hide_f = ((s_ms + cc_shift_ms + len_ms) / 100) as usize;
            let text = format!("SPOKEN LINE {idx}");
            let mut pairs = vec![(0x14, 0x20), (0x14, 0x2E)];
            for chunk in text.as_bytes().chunks(2) {
                pairs.push((chunk[0], *chunk.get(1).unwrap_or(&0)));
            }
            pairs.push((0x14, 0x2F));
            cc_by_frame.insert(show_f, pairs);
            cc_by_frame.insert(hide_f, vec![(0x14, 0x2C)]);
        }

        let mut starts = Vec::new();
        let mut i = 0usize;
        while i + 3 < raw_bytes.len() {
            if raw_bytes[i..i + 4] == [0, 0, 0, 1] {
                starts.push((i, 4usize));
                i += 4;
            } else if raw_bytes[i..i + 3] == [0, 0, 1] {
                starts.push((i, 3usize));
                i += 3;
            } else {
                i += 1;
            }
        }
        let mut cc_h264_bytes = Vec::with_capacity(raw_bytes.len() + 2048);
        let mut frame_idx = 0usize;
        for (idx, &(pos, sc_len)) in starts.iter().enumerate() {
            let end = starts.get(idx + 1).map(|x| x.0).unwrap_or(raw_bytes.len());
            let nalu = &raw_bytes[pos..end];
            let nal_type = nalu[sc_len] & 0x1F;
            if nal_type == 1 || nal_type == 5 {
                if let Some(pairs) = cc_by_frame.get(&frame_idx) {
                    cc_h264_bytes.extend_from_slice(&make_sei(pairs));
                }
                frame_idx += 1;
            }
            cc_h264_bytes.extend_from_slice(nalu);
        }
        let cc_h264 = dir.join("with_cc.h264");
        fs::write(&cc_h264, cc_h264_bytes).expect("write cc h264");

        // 2. Build 70s 48kHz audio with speech bursts matching `bursts`
        let sr = 48_000usize;
        let mut audio_samples = vec![0.0f32; sr * 70];
        for &(s_ms, len_ms) in bursts {
            let s_idx = (s_ms as usize * sr) / 1000;
            let e_idx = (((s_ms + len_ms) as usize) * sr) / 1000;
            for (k, sample) in audio_samples[s_idx..e_idx].iter_mut().enumerate() {
                let t = k as f32 / sr as f32;
                *sample = 0.28 * (2.0 * std::f32::consts::PI * 640.0 * t).sin();
            }
        }
        let wav = dir.join("audio.wav");
        let data_len = (audio_samples.len() * 2) as u32;
        let mut wav_bytes = Vec::with_capacity(44 + data_len as usize);
        wav_bytes.extend_from_slice(b"RIFF");
        wav_bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav_bytes.extend_from_slice(b"WAVEfmt ");
        wav_bytes.extend_from_slice(&16u32.to_le_bytes());
        wav_bytes.extend_from_slice(&1u16.to_le_bytes());
        wav_bytes.extend_from_slice(&1u16.to_le_bytes());
        wav_bytes.extend_from_slice(&(sr as u32).to_le_bytes());
        wav_bytes.extend_from_slice(&((sr * 2) as u32).to_le_bytes());
        wav_bytes.extend_from_slice(&2u16.to_le_bytes());
        wav_bytes.extend_from_slice(&16u16.to_le_bytes());
        wav_bytes.extend_from_slice(b"data");
        wav_bytes.extend_from_slice(&data_len.to_le_bytes());
        for s in audio_samples {
            wav_bytes.extend_from_slice(&((s * i16::MAX as f32).round() as i16).to_le_bytes());
        }
        fs::write(&wav, wav_bytes).expect("write wav");

        // Mux under a path containing apostrophe, brackets, comma, and space
        let mp4 = tricky_dir.join("Test's Show [CC], #1.mp4");
        let mux = Command::new(&ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-r",
                "10",
                "-i",
            ])
            .arg(&cc_h264)
            .arg("-i")
            .arg(&wav)
            .args(["-c:v", "copy", "-c:a", "aac"])
            .arg(&mp4)
            .stdin(Stdio::null())
            .output()
            .expect("mux mp4");
        assert!(
            mux.status.success(),
            "{}",
            String::from_utf8_lossy(&mux.stderr)
        );

        // 3. Extract CEA-608 closed captions using `autosync_extract_cc_args_ffmpeg`
        let mp4_str = mp4.to_string_lossy().into_owned();
        let cc_srt = dir.join("extracted_cc.srt");
        let cc_args = autosync_extract_cc_args_ffmpeg(&mp4_str, &cc_srt.to_string_lossy(), None);
        let cc_out = Command::new(&ffmpeg)
            .args(&cc_args)
            .stdin(Stdio::null())
            .output()
            .expect("extract cc");
        assert!(
            cc_out.status.success(),
            "cc extract failed: {}",
            String::from_utf8_lossy(&cc_out.stderr)
        );
        let sub_text = decode_subtitle_bytes_with_hint(
            &fs::read(&cc_srt).expect("read cc srt"),
            SubtitleEncodingHint::Utf8,
        )
        .expect("decode cc");
        let cues = parse_subtitles(&sub_text).expect("parse cc srt");
        assert_eq!(
            cues.len(),
            10,
            "expected 10 extracted CC cues, got: {sub_text}"
        );

        // 4. Extract audio and verify alignment + rescaled `.srt` output
        let pcm = dir.join("audio.pcm");
        let a_args =
            autosync_extract_args_ffmpeg_dialogue(&mp4_str, &pcm.to_string_lossy(), Some(0), false);
        let a_out = Command::new(&ffmpeg)
            .args(&a_args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(a_out.status.success());

        let mut env_builder = AudioEnvelopeBuilder::new();
        env_builder.push_pcm_s16le_bytes(&fs::read(&pcm).unwrap());
        let env = env_builder.finish().unwrap();

        let outcome = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default())
            .expect("CEA-608 alignment should succeed");
        assert!(
            (outcome.offset_ms + cc_shift_ms as i64).abs() <= 150,
            "offset_ms={} expected ~-{}",
            outcome.offset_ms,
            cc_shift_ms
        );

        let rescaled = write_rescaled_subtitle_file_with_transform(
            &cc_srt,
            &dir.join("out"),
            &outcome.transform,
            SubtitleEncodingHint::Utf8,
        )
        .expect("write rescaled cc");
        let aligned_cues = parse_subtitles(&fs::read_to_string(&rescaled).unwrap()).unwrap();
        assert!(
            (aligned_cues[0].start_ms as i64 - bursts[0].0 as i64).abs() <= 150,
            "aligned CC cue 0 start={} expected ~{}",
            aligned_cues[0].start_ms,
            bursts[0].0
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_arabic_cp1256_and_utf8_with_english_sdh_and_rtl_marks_autosync() {
        use epilod_core::subtitle_sync::{
            auto_align_subtitles, decode_subtitle_bytes_with_hint, format_srt_timestamp,
            parse_subtitles, AudioEnvelopeBuilder, AutoSyncConfig, SubtitleEncodingHint,
        };
        use std::fs;

        let dir = std::env::temp_dir().join(format!("epilod_ar_en_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");

        // Synthesize 70s of 16kHz PCM speech bursts matching varied dialogue cues
        let bursts: &[(u64, u64)] = &[
            (5_000, 1_400),
            (9_200, 2_300),
            (15_600, 1_100),
            (20_100, 2_700),
            (26_800, 1_500),
            (31_400, 2_100),
            (38_900, 1_300),
            (43_200, 2_600),
            (50_700, 1_600),
            (56_100, 2_200),
        ];
        let mut builder = AudioEnvelopeBuilder::new();
        let total_samples = 16_000 * 70;
        let mut pcm = vec![0i16; total_samples];
        for &(s_ms, len_ms) in bursts {
            let s0 = s_ms as usize * 16;
            let s1 = ((s_ms + len_ms) as usize * 16).min(total_samples);
            for (idx, slot) in pcm[s0..s1].iter_mut().enumerate() {
                let t = idx as f32 / 16_000.0;
                *slot = ((0.3 * (2.0 * std::f32::consts::PI * 620.0 * t).sin()) * i16::MAX as f32) as i16;
            }
        }
        let mut pcm_bytes = Vec::with_capacity(pcm.len() * 2);
        for s in pcm {
            pcm_bytes.extend_from_slice(&s.to_le_bytes());
        }
        builder.push_pcm_s16le_bytes(&pcm_bytes);
        let env = builder.finish().expect("envelope");

        // 1. Legacy Windows-1256 Arabic SRT bytes (mixed with an English [Music] SDH cue,
        // shifted 3.1s early) using raw CP1256 bytes for "مرحبا يا صديقي":
        let mut cp1256_bytes = b"1\r\n00:00:00,200 --> 00:00:01,500\r\n[Music]\r\n\r\n".to_vec();
        let shift_early_ms = 3_100u64;
        // CP1256 bytes for "مرحبا يا صديقي": E3 D1 CD C8 C7 20 ED C7 20 D5 CF ED DE ED
        let ar_cp1256 = [
            0xE3u8, 0xD1, 0xCD, 0xC8, 0xC7, b' ', 0xED, 0xC7, b' ', 0xD5, 0xCF, 0xED, 0xDE,
            0xED,
        ];
        for (i, &(s_ms, len_ms)) in bursts.iter().enumerate() {
            let sub_s = s_ms - shift_early_ms;
            let header = format!(
                "{}\r\n{} --> {}\r\n",
                i + 2,
                format_srt_timestamp(sub_s),
                format_srt_timestamp(sub_s + len_ms)
            );
            cp1256_bytes.extend_from_slice(header.as_bytes());
            cp1256_bytes.extend_from_slice(&ar_cp1256);
            cp1256_bytes.extend_from_slice(format!(" {}\r\n\r\n", i + 1).as_bytes());
        }
        let cp1256_path = dir.join("arabic_ansi.srt");
        fs::write(&cp1256_path, &cp1256_bytes).unwrap();

        let decoded_ar = decode_subtitle_bytes_with_hint(&cp1256_bytes, SubtitleEncodingHint::Auto)
            .expect("auto-detect CP1256 Arabic");
        assert!(decoded_ar.contains("مرحبا يا صديقي"));
        let cues_ar = parse_subtitles(&decoded_ar).unwrap();
        let outcome_ar = auto_align_subtitles(&cues_ar, &env, &AutoSyncConfig::default())
            .expect("Arabic CP1256 auto-align succeeds");
        assert!((outcome_ar.offset_ms - shift_early_ms as i64).abs() <= 70);
        let synced_ar = write_rescaled_subtitle_file_with_transform(
            &cp1256_path,
            &dir.join("out"),
            &outcome_ar.transform,
            SubtitleEncodingHint::Auto,
        )
        .unwrap();
        let synced_ar_txt = fs::read_to_string(&synced_ar).unwrap();
        assert!(synced_ar_txt.contains("مرحبا يا صديقي"));

        // 2. UTF-8 RTL SRT with U+200F RLM marks before cue timestamps (Arabic + English mix)
        let mut rtl_utf8 = String::from("\u{FEFF}1\n\u{200F}00:00:00,300 --> \u{200F}00:00:01,500\n[موسيقى]\n\n");
        for (i, &(s_ms, len_ms)) in bursts.iter().enumerate() {
            let sub_s = s_ms - shift_early_ms;
            rtl_utf8.push_str(&format!(
                "{}\n\u{200F}{} --> \u{200F}{}\nأهلاً بك يا friend #{}\n\n",
                i + 2,
                format_srt_timestamp(sub_s),
                format_srt_timestamp(sub_s + len_ms),
                i + 1
            ));
        }
        let rtl_cues = parse_subtitles(&rtl_utf8).expect("RTL mark SRT parses");
        let outcome_rtl = auto_align_subtitles(&rtl_cues, &env, &AutoSyncConfig::default())
            .expect("Arabic+English UTF-8 RTL auto-align succeeds");
        assert!((outcome_rtl.offset_ms - shift_early_ms as i64).abs() <= 70);

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn test_real_mkv_extracts_selected_language_via_ff_index() {
        use epilod_core::mpv_ipc::{
            autosync_extract_stream_args_ffmpeg, encode_observe, parse_line, MpvEvent, MpvMessage,
        };
        use epilod_core::subtitle_sync::{
            decode_subtitle_bytes_with_hint, parse_subtitles, SubtitleEncodingHint,
        };
        use std::fs::{self, OpenOptions};
        use std::io::{BufRead, BufReader, Write};
        use std::path::Path;
        use std::process::{Command, Stdio};

        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mpv = manifest_dir.join("resources/mpv/mpv.exe");
        let ffmpeg = manifest_dir.join("resources/mpv/ffmpeg.exe");
        if !mpv.is_file() || !ffmpeg.is_file() {
            return;
        }

        let dir = std::env::temp_dir().join(format!("epilod_ff_index_sub_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");

        let ara_srt = dir.join("ara.srt");
        fs::write(
            &ara_srt,
            "1\r\n00:00:01,000 --> 00:00:03,000\r\nمرحبا بالعالم\r\n\r\n",
        )
        .unwrap();
        let eng_srt = dir.join("eng.srt");
        fs::write(
            &eng_srt,
            "1\r\n00:00:01,000 --> 00:00:03,000\r\nHello English world\r\n\r\n",
        )
        .unwrap();

        let mkv = dir.join("multi_sub.mkv");
        let mux = Command::new(&ffmpeg)
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
                "testsrc=size=128x72:rate=10:duration=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=5",
                "-i",
            ])
            .arg(&ara_srt)
            .arg("-i")
            .arg(&eng_srt)
            .args([
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-map",
                "2:s",
                "-map",
                "3:s",
                "-metadata:s:s:0",
                "language=ara",
                "-metadata:s:s:1",
                "language=eng",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
                "-c:s",
                "subrip",
            ])
            .arg(&mkv)
            .stdin(Stdio::null())
            .output()
            .expect("mux multi-sub mkv");
        assert!(
            mux.status.success(),
            "ffmpeg mux failed: {}",
            String::from_utf8_lossy(&mux.stderr)
        );

        let mkv_str = mkv.to_string_lossy().into_owned();
        let pipe = format!(r"\\.\pipe\epilod-ffidx-test-{}", std::process::id());
        let mut mpv_child = Command::new(&mpv)
            .args([
                "--no-config",
                "--load-scripts=no",
                "--ytdl=no",
                "--vo=null",
                "--ao=null",
                "--pause",
                "--keep-open=yes",
                "--sub-create-cc-track=yes",
                &format!("--input-ipc-server={pipe}"),
                &mkv_str,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn mpv");

        let tracks = (0..40).find_map(|_| {
            std::thread::sleep(Duration::from_millis(100));
            let mut pipe_file = OpenOptions::new().read(true).write(true).open(&pipe).ok()?;
            let observe = encode_observe(1, 1, "track-list");
            pipe_file.write_all(observe.as_bytes()).ok()?;
            pipe_file.flush().ok()?;
            let mut reader = BufReader::new(pipe_file);
            for _ in 0..24 {
                let mut line = String::new();
                if reader.read_line(&mut line).ok()? == 0 {
                    break;
                }
                if let Ok(MpvMessage::Event(MpvEvent::TrackList(list))) = parse_line(&line) {
                    if list.iter().any(|t| t.kind == "sub") {
                        return Some(list);
                    }
                }
            }
            None
        });
        let _ = mpv_child.kill();
        let _ = mpv_child.wait();

        let tracks = tracks.expect("mpv reported track-list");
        let eng_track = tracks
            .iter()
            .find(|t| t.kind == "sub" && t.lang.as_deref() == Some("eng"))
            .expect("english sub track");
        let eng_ff_idx = eng_track.ff_index.expect("english track has ff-index");
        assert_ne!(
            eng_ff_idx, 0,
            "eng stream index should reflect container stream position"
        );

        let extracted = dir.join("extracted_eng.srt");
        let extract_args =
            autosync_extract_stream_args_ffmpeg(&mkv_str, &extracted.to_string_lossy(), eng_ff_idx);
        let out = Command::new(&ffmpeg)
            .args(&extract_args)
            .stdin(Stdio::null())
            .output()
            .expect("extract eng by ff-index");
        assert!(
            out.status.success(),
            "ffmpeg extract failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let raw = fs::read(&extracted).expect("read extracted srt");
        let text = decode_subtitle_bytes_with_hint(&raw, SubtitleEncodingHint::Auto).unwrap();
        let cues = parse_subtitles(&text).unwrap();
        assert_eq!(cues.len(), 1);
        assert!(cues[0].text.contains("Hello English world"));
        assert!(!text.contains("مرحبا"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn test_real_mkv_detects_untagged_subtitle_languages() {
        use epilod_core::mpv_ipc::probe_extract_sub_sample_args_ffmpeg;
        use epilod_core::subtitle_sync::{
            decode_subtitle_bytes_with_hint, detect_subtitle_language, SubtitleEncodingHint,
        };
        use std::fs;
        use std::path::Path;
        use std::process::{Command, Stdio};

        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("resources/mpv/ffmpeg.exe");
        if !ffmpeg.is_file() {
            return;
        }

        let dir = std::env::temp_dir().join(format!("epilod_lang_probe_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");

        let ara_srt = dir.join("untagged_ara.srt");
        fs::write(
            &ara_srt,
            "1\r\n00:00:01,000 --> 00:00:03,000\r\nأين كنت طوال هذا الوقت يا صديقي؟\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nكنت أبحث عنك في كل مكان.\r\n\r\n",
        )
        .unwrap();
        let eng_srt = dir.join("untagged_eng.srt");
        fs::write(
            &eng_srt,
            "1\r\n00:00:01,000 --> 00:00:03,000\r\nWhat are you doing here right now?\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nI don't think that we have time for this.\r\n\r\n",
        )
        .unwrap();

        let mkv = dir.join("untagged.mkv");
        let mux = Command::new(&ffmpeg)
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
                "testsrc=size=128x72:rate=10:duration=10",
                "-i",
            ])
            .arg(&ara_srt)
            .arg("-i")
            .arg(&eng_srt)
            .args([
                "-map", "0:v", "-map", "1:s", "-map", "2:s", "-c:v", "mpeg4", "-c:s", "subrip",
            ])
            .arg(&mkv)
            .stdin(Stdio::null())
            .output()
            .expect("mux untagged mkv");
        assert!(mux.status.success());

        let mkv_str = mkv.to_string_lossy().into_owned();
        let sample_0 = dir.join("sample_0.srt");
        let sample_1 = dir.join("sample_1.srt");

        for (ff_idx, sub_idx, out_path, expected) in [
            (Some(1u64), 0usize, &sample_0, Some("ara")),
            (Some(2u64), 1usize, &sample_1, Some("eng")),
        ] {
            let args = probe_extract_sub_sample_args_ffmpeg(
                &mkv_str,
                &out_path.to_string_lossy(),
                ff_idx,
                sub_idx,
                900,
            );
            let out = Command::new(&ffmpeg)
                .args(&args)
                .stdin(Stdio::null())
                .output()
                .expect("extract sample");
            assert!(out.status.success());
            let raw = fs::read(out_path).unwrap();
            let decoded =
                decode_subtitle_bytes_with_hint(&raw, SubtitleEncodingHint::Auto).unwrap();
            assert_eq!(detect_subtitle_language(&decoded), expected);
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
