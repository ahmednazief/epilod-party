#![cfg(windows)]

use epilod_core::media_align::{
    build_probe_from_pcm_8k, candidate_fps_scales, extract_dual_envelope_50hz_from_pcm_8k,
    match_probe_in_haystack, pick_sparse_probe_windows, DualEnvelope50Hz, ProbeMatch,
    SparseAudioProbe,
};
use epilod_core::validation::{validate_existing_local_file_with_options, LocalPathOptions};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
const MAX_PCM_BYTES_PER_WINDOW: usize = 16_000 * 1_100; // ~17.6 MB ceiling for up to ~1100s window @ 8kHz mono s16le

pub fn validate_video_for_sparse_probe(
    raw_path: &str,
    network_opts: LocalPathOptions,
) -> Result<std::path::PathBuf, String> {
    validate_existing_local_file_with_options(raw_path, network_opts).map_err(|e| e.to_string())
}

/// Fast keyframe-seeked audio extraction directly to memory via `ffmpeg -ss <start> -i <path> -t <dur>`.
/// Reads only the requested window instead of decoding the entire video file.
pub async fn extract_pcm_window_8k(
    ffmpeg_exe: &Path,
    video_path: &Path,
    start_secs: f64,
    dur_secs: f64,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".to_string());
    }
    let safe_start = start_secs.max(0.0);
    let safe_dur = dur_secs.clamp(5.0, 960.0);
    let path_str = video_path.to_string_lossy().into_owned();

    let mut cmd = Command::new(ffmpeg_exe);
    cmd.args([
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-ss",
        &format!("{safe_start:.3}"),
        "-i",
        &path_str,
        "-t",
        &format!("{safe_dur:.3}"),
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "s16le",
        "pipe:1",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed launching ffmpeg.exe for sparse probe: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing ffmpeg stdout pipe".to_string())?;
    let mut stderr = child.stderr.take();

    let drain_err = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(ref mut se) = stderr {
            let _ = se.take(4096).read_to_end(&mut buf).await;
        }
        buf
    });

    let mut pcm = Vec::with_capacity((safe_dur * 16_000.0) as usize);
    let mut chunk = [0u8; 16_384];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);

    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err("Cancelled".to_string());
        }
        let read_res = tokio::time::timeout_at(deadline, stdout.read(&mut chunk)).await;
        match read_res {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                let take = n.min(MAX_PCM_BYTES_PER_WINDOW.saturating_sub(pcm.len()));
                pcm.extend_from_slice(&chunk[..take]);
                if pcm.len() >= MAX_PCM_BYTES_PER_WINDOW {
                    break;
                }
            }
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return Err(format!("ffmpeg read failed: {e}"));
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err("ffmpeg sparse window timed out".to_string());
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("ffmpeg wait failed: {e}"))?;
    let err_bytes = drain_err.await.unwrap_or_default();
    if pcm.len() < 8000 && !status.success() {
        let msg = String::from_utf8_lossy(&err_bytes).trim().to_string();
        return Err(if msg.is_empty() {
            "ffmpeg extracted empty sparse audio".to_string()
        } else {
            msg
        });
    }
    Ok(pcm)
}

pub async fn extract_reference_probes(
    ffmpeg_exe: &Path,
    video_path: &Path,
    duration_secs: f64,
    timestamps_override: Option<&[f64]>,
    cancel: &Arc<AtomicBool>,
) -> Vec<SparseAudioProbe> {
    let windows: Vec<(f64, f64)> = match timestamps_override {
        Some(ts) => ts
            .iter()
            .copied()
            .filter(|t| t.is_finite() && *t >= 0.0)
            .map(|t| (t, 20.0))
            .collect(),
        None => pick_sparse_probe_windows(duration_secs),
    };
    if windows.is_empty() {
        return Vec::new();
    }

    let mut handles = Vec::with_capacity(windows.len());
    for (start, dur) in windows {
        let ff = ffmpeg_exe.to_path_buf();
        let vp = video_path.to_path_buf();
        let c = Arc::clone(cancel);
        handles.push(tokio::spawn(async move {
            let pcm = extract_pcm_window_8k(&ff, &vp, start, dur, &c).await.ok()?;
            build_probe_from_pcm_8k(start, &pcm).ok()
        }));
    }

    let mut out = Vec::new();
    for h in handles {
        if let Ok(Some(probe)) = h.await {
            out.push(probe);
        }
    }
    out.sort_by(|a, b| a.anchor_room_secs.total_cmp(&b.anchor_room_secs));
    out
}

pub async fn extract_local_haystack_envelope(
    ffmpeg_exe: &Path,
    video_path: &Path,
    start_secs: f64,
    dur_secs: f64,
    cancel: &Arc<AtomicBool>,
) -> Option<(f64, DualEnvelope50Hz)> {
    let safe_start = start_secs.max(0.0);
    let pcm = extract_pcm_window_8k(ffmpeg_exe, video_path, safe_start, dur_secs, cancel)
        .await
        .ok()?;
    let env = extract_dual_envelope_50hz_from_pcm_8k(&pcm).ok()?;
    Some((safe_start, env))
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ProbeMatchHints {
    pub scale: Option<f64>,
    pub offset: Option<f64>,
}

/// Correlates a set of remote reference needles against local audio windows. Uses probe #0 first
/// with a wide radius to anchor large intro/recap cuts, then centers remaining windows tightly.
pub async fn match_remote_probes_locally(
    ffmpeg_exe: &Path,
    video_path: &Path,
    local_duration_secs: f64,
    ref_duration_secs: f64,
    probes: &[SparseAudioProbe],
    hints: ProbeMatchHints,
    cancel: &Arc<AtomicBool>,
) -> (Vec<ProbeMatch>, Vec<f64>) {
    let hint_scale = hints.scale;
    let hint_offset = hints.offset;
    if probes.is_empty() || cancel.load(Ordering::SeqCst) {
        return (Vec::new(), Vec::new());
    }

    let scales_all = if let Some(hs) = hint_scale {
        vec![hs]
    } else {
        candidate_fps_scales(ref_duration_secs, local_duration_secs)
    };
    let ratio_hint = if ref_duration_secs > 10.0 && local_duration_secs > 10.0 {
        let base_r = scales_all[0];
        if (base_r - 1.0).abs() > 0.005 {
            base_r
        } else {
            1.0
        }
    } else {
        1.0
    };

    let mut matched = Vec::new();
    let mut unmatched = Vec::new();
    let mut discovered_scale = hint_scale;
    let mut discovered_offset = hint_offset;

    // Step 1: When no anchor hint exists yet, run probe 0 (or 1 if silent) first with a ±260 s
    // window so even huge intro/recap cuts lock cleanly and speed up remaining probes.
    let mut idx = 0usize;
    while idx < probes.len() && discovered_offset.is_none() {
        if cancel.load(Ordering::SeqCst) {
            return (matched, unmatched);
        }
        let p = &probes[idx];
        let est_center = (p.anchor_room_secs * ratio_hint).max(0.0);
        let radius = if probes.len() == 1 { 200.0 } else { 260.0 };
        let hay_start = (est_center - radius).max(0.0);
        let hay_end = (est_center + p.duration_secs + radius).min(local_duration_secs);
        let hay_dur = (hay_end - hay_start).max(30.0);

        if let Some((actual_start, env)) =
            extract_local_haystack_envelope(ffmpeg_exe, video_path, hay_start, hay_dur, cancel)
                .await
        {
            let res = tokio::task::spawn_blocking({
                let p_c = p.clone();
                let sc = scales_all.clone();
                move || match_probe_in_haystack(&p_c, actual_start, &env, &sc)
            })
            .await
            .ok()
            .flatten();

            if let Some(m) = res {
                discovered_scale = Some(m.scale_used);
                discovered_offset = Some(m.local_secs - m.scale_used * m.room_secs);
                matched.push(m);
            } else {
                unmatched.push(p.anchor_room_secs);
            }
        } else {
            unmatched.push(p.anchor_room_secs);
        }
        idx += 1;
    }

    if idx >= probes.len() {
        return (matched, unmatched);
    }

    // Step 2: Run remaining probes in parallel centered around the anchored transform (wider ±220 s
    // so mid-movie cuts up to 3.5 minutes still fall cleanly inside the window).
    let anchor_sc = discovered_scale.unwrap_or(ratio_hint);
    let anchor_off = discovered_offset.unwrap_or(0.0);
    let active_scales = vec![anchor_sc];

    let mut tasks = Vec::new();
    for p in &probes[idx..] {
        let p_c = p.clone();
        let sc = active_scales.clone();
        let ff = ffmpeg_exe.to_path_buf();
        let vp = video_path.to_path_buf();
        let c = Arc::clone(cancel);
        let center = (p.anchor_room_secs * anchor_sc + anchor_off).max(0.0);
        let hay_start = (center - 220.0).max(0.0);
        let hay_end = (center + p.duration_secs + 220.0).min(local_duration_secs);
        let hay_dur = (hay_end - hay_start).max(30.0);

        tasks.push(tokio::spawn(async move {
            let room_t = p_c.anchor_room_secs;
            let Some((actual_start, env)) =
                extract_local_haystack_envelope(&ff, &vp, hay_start, hay_dur, &c).await
            else {
                return (room_t, None);
            };
            let m = tokio::task::spawn_blocking(move || {
                match_probe_in_haystack(&p_c, actual_start, &env, &sc)
            })
            .await
            .ok()
            .flatten();
            (room_t, m)
        }));
    }

    for t in tasks {
        if let Ok((rt, maybe_m)) = t.await {
            if let Some(m) = maybe_m {
                matched.push(m);
            } else {
                unmatched.push(rt);
            }
        }
    }

    (matched, unmatched)
}
