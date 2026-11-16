#![cfg(windows)]

use crate::mpv::process::{resolve_ffmpeg_exe, resolve_mpv_exe};
use epilod_core::intro_detect::{
    detect_intro_across_episodes, detect_intro_from_chapters, detect_intro_from_subtitle_text,
    detect_intro_from_unnamed_chapter_structure, pick_sibling_episode_paths,
    recommended_intro_window_secs, snap_interval_to_chapters, DetectedIntro, IntroDetectionOutcome,
    SpectralIntroFingerprint,
};
use epilod_core::mpv_ipc::{
    intro_extract_audio_args_ffmpeg, intro_extract_audio_args_mpv, intro_extract_sub_args_ffmpeg,
    MpvChapter,
};
use epilod_core::playlist::parse_episode_code;
use epilod_core::subtitle_sync::{decode_subtitle_bytes_with_hint, SubtitleEncodingHint};
use epilod_core::validation::{validate_existing_local_file_with_options, LocalPathOptions};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const FP_CACHE_CAPACITY: usize = 16;
const INTRO_CACHE_CAPACITY: usize = 64;
const MAX_AUDIO_PCM_BYTES: usize = 24 * 1024 * 1024;
const MAX_SUBTITLE_BYTES: usize = 4 * 1024 * 1024;
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(25);
const SUB_EXTRACT_TIMEOUT: Duration = Duration::from_secs(12);
const MIN_VALID_PCM_BYTES: usize = 4_000;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

struct BoundedCache<K, V> {
    cap: usize,
    entries: VecDeque<(K, V)>,
}

impl<K: PartialEq, V: Clone> BoundedCache<K, V> {
    fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            entries: VecDeque::with_capacity(cap.max(1)),
        }
    }

    fn get(&mut self, key: &K) -> Option<V> {
        let pos = self.entries.iter().position(|(k, _)| k == key)?;
        let item = self.entries.remove(pos)?;
        let val = item.1.clone();
        self.entries.push_back(item);
        Some(val)
    }

    fn insert(&mut self, key: K, val: V) {
        if let Some(pos) = self.entries.iter().position(|(k, _)| k == &key) {
            self.entries.remove(pos);
        } else if self.entries.len() >= self.cap {
            self.entries.pop_front();
        }
        self.entries.push_back((key, val));
    }

    fn clear(&mut self) {
        self.entries.clear();
    }
}

type CacheFileKey = (String, u64);

pub struct IntroDetectController {
    cancel_flag: Mutex<Arc<AtomicBool>>,
    fp_cache: Mutex<BoundedCache<CacheFileKey, Arc<SpectralIntroFingerprint>>>,
    intro_cache: Mutex<BoundedCache<CacheFileKey, DetectedIntro>>,
}

impl Default for IntroDetectController {
    fn default() -> Self {
        Self::new()
    }
}

impl IntroDetectController {
    pub fn new() -> Self {
        Self {
            cancel_flag: Mutex::new(Arc::new(AtomicBool::new(false))),
            fp_cache: Mutex::new(BoundedCache::new(FP_CACHE_CAPACITY)),
            intro_cache: Mutex::new(BoundedCache::new(INTRO_CACHE_CAPACITY)),
        }
    }

    /// Cancels any currently running background intro detection.
    pub fn cancel(&self) {
        let guard = self.cancel_flag.lock().unwrap_or_else(|e| e.into_inner());
        guard.store(true, Ordering::SeqCst);
    }

    /// Cancels any prior detection run and returns a fresh cancellation token for the new run.
    pub fn begin_run(&self) -> Arc<AtomicBool> {
        let mut guard = self.cancel_flag.lock().unwrap_or_else(|e| e.into_inner());
        guard.store(true, Ordering::SeqCst);
        let fresh = Arc::new(AtomicBool::new(false));
        *guard = Arc::clone(&fresh);
        fresh
    }

    pub fn clear_caches(&self) {
        self.fp_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.intro_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    fn get_cached_fp(&self, key: &CacheFileKey) -> Option<Arc<SpectralIntroFingerprint>> {
        self.fp_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
    }

    fn insert_cached_fp(&self, key: CacheFileKey, fp: Arc<SpectralIntroFingerprint>) {
        self.fp_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, fp);
    }

    fn get_cached_intro(&self, key: &CacheFileKey) -> Option<DetectedIntro> {
        self.intro_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
    }

    fn insert_cached_intro(&self, key: CacheFileKey, intro: DetectedIntro) {
        self.intro_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, intro);
    }
}

#[derive(Debug, Clone)]
pub struct IntroDetectRequest {
    pub video_path: String,
    pub duration_secs: f64,
    pub chapters: Vec<MpvChapter>,
    pub sibling_paths: Vec<String>,
    pub subtitle_path: Option<String>,
    pub embedded_sub_idx: Option<usize>,
    pub embedded_sub_codec: Option<String>,
    pub audio_stream_idx: Option<usize>,
    pub low_power: bool,
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn cache_key_for_path(path: &Path) -> Result<(CacheFileKey, PathBuf), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Cannot read media metadata: {e}"))?;
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key_str = canon.to_string_lossy().to_ascii_lowercase();
    Ok(((key_str, meta.len()), canon))
}

fn is_bitmap_or_cc_codec(codec: &str) -> bool {
    let lower = codec.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "hdmv_pgs_subtitle"
            | "pgssub"
            | "dvd_subtitle"
            | "dvdsub"
            | "dvb_subtitle"
            | "dvbsub"
            | "xsub"
            | "eia_608"
            | "eia_708"
            | "cea_608"
            | "cea_708"
            | "arib_caption"
    )
}

async fn run_command_stdout_with_cancel(
    exe: &Path,
    args: &[String],
    timeout: Duration,
    max_bytes: usize,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".to_string());
    }

    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start extractor ({}): {e}", exe.display()))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing child stdout".to_string())?;

    let read_handle = tokio::spawn(async move {
        let mut buf = Vec::with_capacity(64 * 1024);
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    let room = max_bytes.saturating_sub(buf.len());
                    if room == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok::<Vec<u8>, String>(buf)
    });

    let started = Instant::now();
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            read_handle.abort();
            return Err("Cancelled".to_string());
        }
        if started.elapsed() >= timeout {
            let _ = child.kill().await;
            let _ = child.wait().await;
            read_handle.abort();
            return Err("Intro extraction timed out".to_string());
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => tokio::time::sleep(Duration::from_millis(40)).await,
            Err(e) => {
                read_handle.abort();
                return Err(format!("Failed waiting on extractor: {e}"));
            }
        }
    };

    let bytes = read_handle
        .await
        .map_err(|_| "Extractor stdout task aborted".to_string())??;

    if !status.success() && bytes.is_empty() {
        return Err(format!(
            "Extractor exited cleanly without output ({})",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string())
        ));
    }
    Ok(bytes)
}

async fn run_mpv_file_extract_with_cancel(
    mpv_exe: &Path,
    video_str: &str,
    window_secs: f64,
    audio_track_id: Option<u64>,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".to_string());
    }
    let id = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path =
        std::env::temp_dir().join(format!("epilod_intro_{}_{}.s16le", std::process::id(), id));
    let _guard = TempFileGuard(tmp_path.clone());
    let args = intro_extract_audio_args_mpv(
        video_str,
        &tmp_path.to_string_lossy(),
        window_secs,
        audio_track_id,
    );

    let mut cmd = Command::new(mpv_exe);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start mpv extractor: {e}"))?;

    let started = Instant::now();
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("Cancelled".to_string());
        }
        if started.elapsed() >= EXTRACT_TIMEOUT {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("mpv intro extraction timed out".to_string());
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(e) => return Err(format!("Failed waiting on mpv extractor: {e}")),
        }
    };

    if !status.success() {
        return Err("mpv audio extraction failed".to_string());
    }
    let meta = std::fs::metadata(&tmp_path).map_err(|e| format!("Missing temp PCM: {e}"))?;
    if meta.len() > MAX_AUDIO_PCM_BYTES as u64 {
        return Err("Extracted intro PCM exceeded size cap".to_string());
    }
    std::fs::read(&tmp_path).map_err(|e| format!("Failed reading temp PCM: {e}"))
}

async fn extract_intro_pcm_8k(
    video_path: &Path,
    window_secs: f64,
    audio_stream_idx: Option<usize>,
    ffmpeg_exe: Option<&Path>,
    mpv_exe: Option<&Path>,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    let video_str = video_path.to_string_lossy();

    if let Some(ff) = ffmpeg_exe {
        if let Some(stream_idx) = audio_stream_idx {
            let args = intro_extract_audio_args_ffmpeg(&video_str, window_secs, Some(stream_idx));
            if let Ok(bytes) = run_command_stdout_with_cancel(
                ff,
                &args,
                EXTRACT_TIMEOUT,
                MAX_AUDIO_PCM_BYTES,
                cancel,
            )
            .await
            {
                if bytes.len() >= MIN_VALID_PCM_BYTES {
                    return Ok(bytes);
                }
            }
        }
        if !cancel.load(Ordering::SeqCst) {
            let args = intro_extract_audio_args_ffmpeg(&video_str, window_secs, None);
            if let Ok(bytes) = run_command_stdout_with_cancel(
                ff,
                &args,
                EXTRACT_TIMEOUT,
                MAX_AUDIO_PCM_BYTES,
                cancel,
            )
            .await
            {
                if bytes.len() >= MIN_VALID_PCM_BYTES {
                    return Ok(bytes);
                }
            }
        }
    }

    if let Some(mpv) = mpv_exe {
        let track_id = audio_stream_idx.map(|i| (i + 1) as u64);
        let bytes =
            run_mpv_file_extract_with_cancel(mpv, &video_str, window_secs, track_id, cancel)
                .await?;
        if bytes.len() >= MIN_VALID_PCM_BYTES {
            return Ok(bytes);
        }
    }

    Err("No valid opening audio stream extracted for intro analysis".to_string())
}

async fn get_or_extract_fingerprint(
    video_path: &Path,
    window_secs: f64,
    audio_stream_idx: Option<usize>,
    ffmpeg_exe: Option<&Path>,
    mpv_exe: Option<&Path>,
    controller: &IntroDetectController,
    cancel: &Arc<AtomicBool>,
) -> Result<(CacheFileKey, Arc<SpectralIntroFingerprint>), String> {
    let (key, canon) = cache_key_for_path(video_path)?;
    // Cache hit avoids re-running FFmpeg when flipping forward/backward in a season folder.
    if audio_stream_idx.is_none() {
        if let Some(cached) = controller.get_cached_fp(&key) {
            return Ok((key, cached));
        }
    }

    let pcm = extract_intro_pcm_8k(
        &canon,
        window_secs,
        audio_stream_idx,
        ffmpeg_exe,
        mpv_exe,
        cancel,
    )
    .await?;

    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".to_string());
    }

    let fp = tokio::task::spawn_blocking(move || SpectralIntroFingerprint::from_pcm_s16le_8k(&pcm))
        .await
        .map_err(|_| "Intro fingerprint worker panicked".to_string())?
        .ok_or_else(|| "Opening audio is silent or too short to fingerprint".to_string())?;

    let arc_fp = Arc::new(fp);
    if audio_stream_idx.is_none() {
        controller.insert_cached_fp(key.clone(), Arc::clone(&arc_fp));
    }
    Ok((key, arc_fp))
}

fn try_detect_from_external_sub(
    sub_path_raw: &str,
    duration_secs: f64,
    path_options: LocalPathOptions,
) -> Option<IntroDetectionOutcome> {
    let sub_pb = validate_existing_local_file_with_options(sub_path_raw, path_options).ok()?;
    let meta = std::fs::metadata(&sub_pb).ok()?;
    if meta.len() > MAX_SUBTITLE_BYTES as u64 {
        return None;
    }
    let bytes = std::fs::read(&sub_pb).ok()?;
    let ext_hint = sub_pb.extension().and_then(|e| e.to_str());
    let text = decode_subtitle_bytes_with_hint(&bytes, SubtitleEncodingHint::Auto).ok()?;
    let outcome = detect_intro_from_subtitle_text(&text, ext_hint, duration_secs);
    outcome.primary_intro.as_ref()?;
    Some(outcome)
}

pub async fn execute_detect_intro_with_tools(
    req: IntroDetectRequest,
    ffmpeg_exe: Option<&Path>,
    mpv_exe: Option<&Path>,
    controller: &IntroDetectController,
    path_options: LocalPathOptions,
) -> Result<IntroDetectionOutcome, String> {
    let cancel = controller.begin_run();

    // 1. Named embedded chapters (instant, zero subprocess overhead).
    let chap_outcome = detect_intro_from_chapters(&req.chapters, req.duration_secs);
    if chap_outcome.primary_intro.is_some() {
        return Ok(chap_outcome);
    }

    let target_pb = validate_existing_local_file_with_options(&req.video_path, path_options)
        .map_err(|e| e.to_string())?;
    let (target_key, target_canon) = cache_key_for_path(&target_pb)?;

    // 2. External subtitle cue markers (.ass OP style or explicit [Opening theme] lyrics).
    if let Some(sub_raw) = req.subtitle_path.as_deref() {
        let sub_trimmed = sub_raw.trim();
        if !sub_trimmed.is_empty() {
            let dur = req.duration_secs;
            let owned_sub = sub_trimmed.to_string();
            let sub_res = tokio::task::spawn_blocking(move || {
                try_detect_from_external_sub(&owned_sub, dur, path_options)
            })
            .await
            .ok()
            .flatten();
            if let Some(outcome) = sub_res {
                return Ok(outcome);
            }
        }
    }

    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".to_string());
    }

    // 3. Previously detected cached intro (e.g. pre-populated when scanning previous episode).
    if let Some(mut cached) = controller.get_cached_intro(&target_key) {
        let (snapped_s, snapped_e) = snap_interval_to_chapters(
            cached.start_secs,
            cached.end_secs,
            &req.chapters,
            req.duration_secs,
        );
        cached.start_secs = snapped_s;
        cached.end_secs = snapped_e;
        cached.skip_target_secs = snapped_e;
        return Ok(IntroDetectionOutcome::from_segments(vec![cached]));
    }

    // 4. Cross-episode spectral audio matching against sibling files in the playlist/folder.
    let duration_allows_audio =
        !req.duration_secs.is_finite() || req.duration_secs <= 0.0 || req.duration_secs >= 150.0;
    if duration_allows_audio
        && !req.sibling_paths.is_empty()
        && (ffmpeg_exe.is_some() || mpv_exe.is_some())
    {
        let window_secs = recommended_intro_window_secs(req.duration_secs);
        let candidate_paths = pick_sibling_episode_paths(&req.video_path, &req.sibling_paths, 3);
        let mut valid_siblings: Vec<(String, CacheFileKey, PathBuf)> = Vec::new();
        for sib_raw in candidate_paths {
            if let Ok(sib_pb) = validate_existing_local_file_with_options(&sib_raw, path_options) {
                if let Ok((sib_key, sib_canon)) = cache_key_for_path(&sib_pb) {
                    if sib_key != target_key
                        && sib_key.1 > 0
                        && valid_siblings.iter().all(|(_, k, _)| k != &sib_key)
                    {
                        valid_siblings.push((sib_raw, sib_key, sib_canon));
                    }
                }
            }
        }

        if !valid_siblings.is_empty() {
            let mut sib_fps: Vec<(String, CacheFileKey, Arc<SpectralIntroFingerprint>)> =
                Vec::new();
            let first_sib = &valid_siblings[0];

            let (target_fp_res, sib0_res, sib1_res) = if req.low_power {
                let t = get_or_extract_fingerprint(
                    &target_canon,
                    window_secs,
                    req.audio_stream_idx,
                    ffmpeg_exe,
                    mpv_exe,
                    controller,
                    &cancel,
                )
                .await;
                let s0 = get_or_extract_fingerprint(
                    &first_sib.2,
                    window_secs,
                    None,
                    ffmpeg_exe,
                    mpv_exe,
                    controller,
                    &cancel,
                )
                .await;
                let s1 = if let Some(second) = valid_siblings.get(1) {
                    Some(
                        get_or_extract_fingerprint(
                            &second.2,
                            window_secs,
                            None,
                            ffmpeg_exe,
                            mpv_exe,
                            controller,
                            &cancel,
                        )
                        .await,
                    )
                } else {
                    None
                };
                (t, s0, s1)
            } else {
                let fut_target = get_or_extract_fingerprint(
                    &target_canon,
                    window_secs,
                    req.audio_stream_idx,
                    ffmpeg_exe,
                    mpv_exe,
                    controller,
                    &cancel,
                );
                let fut_sib0 = get_or_extract_fingerprint(
                    &first_sib.2,
                    window_secs,
                    None,
                    ffmpeg_exe,
                    mpv_exe,
                    controller,
                    &cancel,
                );
                let fut_sib1 = async {
                    if let Some(second) = valid_siblings.get(1) {
                        Some(
                            get_or_extract_fingerprint(
                                &second.2,
                                window_secs,
                                None,
                                ffmpeg_exe,
                                mpv_exe,
                                controller,
                                &cancel,
                            )
                            .await,
                        )
                    } else {
                        None
                    }
                };
                tokio::join!(fut_target, fut_sib0, fut_sib1)
            };

            if cancel.load(Ordering::SeqCst) {
                return Err("Cancelled".to_string());
            }

            if let Ok((_, target_fp)) = target_fp_res {
                if let Ok((_, s0_fp)) = sib0_res {
                    sib_fps.push((first_sib.0.clone(), first_sib.1.clone(), s0_fp));
                }
                if let (Some(second), Some(Ok((_, s1_fp)))) = (valid_siblings.get(1), sib1_res) {
                    sib_fps.push((second.0.clone(), second.1.clone(), s1_fp));
                }

                // If <2 usable fingerprints or third sibling can corroborate, check third sibling.
                if sib_fps.len() < 2 {
                    if let Some(third) = valid_siblings.get(2) {
                        if let Ok((_, s2_fp)) = get_or_extract_fingerprint(
                            &third.2,
                            window_secs,
                            None,
                            ffmpeg_exe,
                            mpv_exe,
                            controller,
                            &cancel,
                        )
                        .await
                        {
                            sib_fps.push((third.0.clone(), third.1.clone(), s2_fp));
                        }
                    }
                }

                if cancel.load(Ordering::SeqCst) {
                    return Err("Cancelled".to_string());
                }

                if !sib_fps.is_empty() {
                    let target_chaps = req.chapters.clone();
                    let dur = req.duration_secs;
                    let sib_owned: Vec<(String, CacheFileKey, Arc<SpectralIntroFingerprint>)> =
                        sib_fps;
                    let (mut outcome, mut sibling_intros) =
                        tokio::task::spawn_blocking(move || {
                            let refs: Vec<(&str, &SpectralIntroFingerprint)> = sib_owned
                                .iter()
                                .map(|(p, _, fp)| (p.as_str(), fp.as_ref()))
                                .collect();
                            let res = detect_intro_across_episodes(
                                target_fp.as_ref(),
                                &refs,
                                &target_chaps,
                                dur,
                            );
                            (res.0, res.1)
                        })
                        .await
                        .map_err(|_| "Intro matching worker panicked".to_string())?;

                    if let Some(ref primary) = outcome.primary_intro {
                        controller.insert_cached_intro(target_key.clone(), primary.clone());
                        for (sib_path, sib_s, sib_e, sib_sim) in sibling_intros.drain(..) {
                            if let Some((_, sib_key, _)) =
                                valid_siblings.iter().find(|(p, _, _)| p == &sib_path)
                            {
                                let sib_intro = DetectedIntro {
                                    start_secs: sib_s,
                                    end_secs: sib_e,
                                    skip_target_secs: sib_e,
                                    kind: epilod_core::intro_detect::IntroSegmentKind::Intro,
                                    source: epilod_core::intro_detect::IntroSource::AudioMatch,
                                    confidence: primary.confidence,
                                    label: "Skip Intro".to_string(),
                                    similarity: Some(sib_sim),
                                    matched_episodes: primary.matched_episodes,
                                };
                                controller.insert_cached_intro(sib_key.clone(), sib_intro);
                            }
                        }
                        return Ok(outcome);
                    }
                    // Preserve unused mut warning cleanly
                    let _ = &mut outcome;
                }
            }
        }
    }

    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".to_string());
    }

    // 5. Embedded ASS/SRT subtitle stream opening window.
    if let (Some(ff), Some(sub_idx)) = (ffmpeg_exe, req.embedded_sub_idx) {
        let codec_ok = req
            .embedded_sub_codec
            .as_deref()
            .is_none_or(|c| !is_bitmap_or_cc_codec(c));
        if codec_ok && sub_idx <= 64 {
            let win = recommended_intro_window_secs(req.duration_secs).min(360.0);
            let args = intro_extract_sub_args_ffmpeg(&target_canon.to_string_lossy(), win, sub_idx);
            if let Ok(bytes) = run_command_stdout_with_cancel(
                ff,
                &args,
                SUB_EXTRACT_TIMEOUT,
                MAX_SUBTITLE_BYTES,
                &cancel,
            )
            .await
            {
                if !bytes.is_empty() {
                    if let Ok(decoded) =
                        decode_subtitle_bytes_with_hint(&bytes, SubtitleEncodingHint::Utf8)
                    {
                        let sub_outcome = detect_intro_from_subtitle_text(
                            &decoded,
                            Some("ass"),
                            req.duration_secs,
                        );
                        if let Some(ref primary) = sub_outcome.primary_intro {
                            controller.insert_cached_intro(target_key.clone(), primary.clone());
                            return Ok(sub_outcome);
                        }
                    }
                }
            }
        }
    }

    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled".to_string());
    }

    // 6. Unnamed episodic chapter structural heuristic (e.g. anime OP+body+ED).
    let file_name = target_pb
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let is_episodic = !req.sibling_paths.is_empty() || parse_episode_code(file_name).is_some();
    let struct_outcome =
        detect_intro_from_unnamed_chapter_structure(&req.chapters, req.duration_secs, is_episodic);
    Ok(struct_outcome)
}

pub async fn execute_detect_intro(
    app: &tauri::AppHandle,
    controller: &IntroDetectController,
    req: IntroDetectRequest,
    path_options: LocalPathOptions,
) -> Result<IntroDetectionOutcome, String> {
    let ffmpeg_exe = resolve_ffmpeg_exe(app);
    let mpv_exe = resolve_mpv_exe(app).ok();
    execute_detect_intro_with_tools(
        req,
        ffmpeg_exe.as_deref(),
        mpv_exe.as_deref(),
        controller,
        path_options,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use epilod_core::intro_detect::{IntroConfidence, IntroSource, INTRO_FP_SAMPLE_RATE};
    use std::io::Write;
    use std::process::Command as StdCommand;

    fn test_tools_paths() -> Option<(PathBuf, PathBuf)> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ffmpeg = manifest_dir.join("resources/mpv/ffmpeg.exe");
        let mpv = manifest_dir.join("resources/mpv/mpv.exe");
        if ffmpeg.is_file() && mpv.is_file() {
            Some((ffmpeg, mpv))
        } else {
            None
        }
    }

    fn gen_theme_pcm_s16le(seed: u64, dur_secs: usize) -> Vec<i16> {
        let notes = [
            220.0f32, 261.63, 293.66, 329.63, 392.0, 440.0, 493.88, 523.25, 587.33, 659.25,
        ];
        let total = dur_secs * INTRO_FP_SAMPLE_RATE;
        let step_len = (INTRO_FP_SAMPLE_RATE as f32 * 0.35) as usize;
        let mut rng = seed ^ 0x9E37_79B9_7F4A_7C15;
        let mut freqs = [220.0f32; 3];
        let mut out = Vec::with_capacity(total);
        for i in 0..total {
            if i % step_len == 0 {
                for slot in &mut freqs {
                    rng = rng
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    *slot = notes[((rng >> 33) as usize) % notes.len()];
                }
            }
            let t = i as f32 / INTRO_FP_SAMPLE_RATE as f32;
            let env = 0.65 + 0.35 * (2.0 * std::f32::consts::PI * 2.8 * t).sin();
            let v = ((2.0 * std::f32::consts::PI * freqs[0] * t).sin() * 0.45
                + (2.0 * std::f32::consts::PI * freqs[1] * 1.5 * t).sin() * 0.32
                + (2.0 * std::f32::consts::PI * freqs[2] * 2.0 * t).sin() * 0.23)
                * env
                * 0.55;
            out.push((v.clamp(-0.98, 0.98) * i16::MAX as f32) as i16);
        }
        out
    }

    fn gen_dialogue_pcm_s16le(seed: u64, dur_secs: usize) -> Vec<i16> {
        let total = dur_secs * INTRO_FP_SAMPLE_RATE;
        let mut out = vec![0i16; total];
        let mut rng = seed ^ 0xBF58_476D_1CE4_E5B9;
        let mut pos = 0usize;
        while pos < total {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let burst =
                (INTRO_FP_SAMPLE_RATE / 3) + (((rng >> 32) as usize) % (INTRO_FP_SAMPLE_RATE * 2));
            let pause =
                (INTRO_FP_SAMPLE_RATE / 4) + (((rng >> 40) as usize) % INTRO_FP_SAMPLE_RATE);
            let f0 = 115.0 + (((rng >> 24) % 175) as f32);
            let f1 = 520.0 + (((rng >> 16) % 880) as f32);
            let end = (pos + burst).min(total);
            for (idx, sample) in out[pos..end].iter_mut().enumerate() {
                let t = (pos + idx) as f32 / INTRO_FP_SAMPLE_RATE as f32;
                let v = 0.30
                    * ((2.0 * std::f32::consts::PI * f0 * t).sin() * 0.6
                        + (2.0 * std::f32::consts::PI * f1 * t).sin() * 0.4);
                *sample = (v.clamp(-0.98, 0.98) * i16::MAX as f32) as i16;
            }
            pos = end + pause;
        }
        out
    }

    fn write_s16le_pcm(path: &Path, samples: &[i16]) {
        let mut f = std::fs::File::create(path).expect("create pcm");
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for &s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        f.write_all(&bytes).expect("write pcm");
    }

    fn mux_aac_mkv(ffmpeg: &Path, pcm_path: &Path, total_secs: usize, out_mkv: &Path) {
        let out = StdCommand::new(ffmpeg)
            .args([
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=black:s=64x64:r=1:d={total_secs}"),
                "-f",
                "s16le",
                "-ar",
                "8000",
                "-ac",
                "1",
                "-i",
                &pcm_path.to_string_lossy(),
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
                "-b:a",
                "64k",
                "-shortest",
                &out_mkv.to_string_lossy(),
            ])
            .output()
            .expect("run ffmpeg mux");
        assert!(
            out.status.success(),
            "ffmpeg mux failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[tokio::test]
    async fn test_real_mkv_cross_episode_audio_and_mpv_extraction() {
        let Some((ffmpeg, mpv)) = test_tools_paths() else {
            return;
        };

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("epilod_intro_e2e_{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();

        let theme = gen_theme_pcm_s16le(777, 45);
        let quiet_theme: Vec<i16> = theme.iter().map(|&s| (s as f32 * 0.35) as i16).collect();

        // Ep1: 12s cold open + 45s theme (12..57s) + dialogue (57..160s)
        let mut ep1_pcm = gen_dialogue_pcm_s16le(1, 12);
        ep1_pcm.extend_from_slice(&theme);
        ep1_pcm.extend_from_slice(&gen_dialogue_pcm_s16le(2, 103));
        let ep1_raw = dir.join("ep1.pcm");
        write_s16le_pcm(&ep1_raw, &ep1_pcm);
        let ep1_mkv = dir.join("Show.S01E01.mkv");
        mux_aac_mkv(&ffmpeg, &ep1_raw, 160, &ep1_mkv);

        // Ep2: 38s cold open + 45s quiet theme (38..83s) + dialogue (83..160s)
        let mut ep2_pcm = gen_dialogue_pcm_s16le(3, 38);
        ep2_pcm.extend_from_slice(&quiet_theme);
        ep2_pcm.extend_from_slice(&gen_dialogue_pcm_s16le(4, 77));
        let ep2_raw = dir.join("ep2.pcm");
        write_s16le_pcm(&ep2_raw, &ep2_pcm);
        let ep2_mkv = dir.join("Show.S01E02.mkv");
        mux_aac_mkv(&ffmpeg, &ep2_raw, 160, &ep2_mkv);

        // Unrelated movie (no shared theme)
        let mov_pcm = gen_dialogue_pcm_s16le(99, 160);
        let mov_raw = dir.join("mov.pcm");
        write_s16le_pcm(&mov_raw, &mov_pcm);
        let mov_mkv = dir.join("Movie.Other.mkv");
        mux_aac_mkv(&ffmpeg, &mov_raw, 160, &mov_mkv);

        let controller = IntroDetectController::new();
        let path_opts = LocalPathOptions {
            allow_network_shares: false,
        };

        // 1. FFmpeg-based real MKV cross-episode AAC audio matching
        let res_ep1 = execute_detect_intro_with_tools(
            IntroDetectRequest {
                video_path: ep1_mkv.to_string_lossy().to_string(),
                duration_secs: 160.0,
                chapters: vec![],
                sibling_paths: vec![ep2_mkv.to_string_lossy().to_string()],
                subtitle_path: None,
                embedded_sub_idx: None,
                embedded_sub_codec: None,
                audio_stream_idx: Some(0),
                low_power: false,
            },
            Some(&ffmpeg),
            Some(&mpv),
            &controller,
            path_opts,
        )
        .await
        .expect("detect ep1 via ffmpeg");

        let intro1 = res_ep1
            .primary_intro
            .expect("must detect AAC intro between real MKVs");
        assert_eq!(intro1.source, IntroSource::AudioMatch);
        assert!(
            (intro1.start_secs - 12.0).abs() <= 2.0,
            "expected ep1 intro start ~12s, got {}",
            intro1.start_secs
        );
        assert!(
            (intro1.end_secs - 57.0).abs() <= 2.0,
            "expected ep1 intro end ~57s, got {}",
            intro1.end_secs
        );

        // 2. Ep2 immediately resolves via sibling cache with accurate ~38..83s bounds
        let res_ep2 = execute_detect_intro_with_tools(
            IntroDetectRequest {
                video_path: ep2_mkv.to_string_lossy().to_string(),
                duration_secs: 160.0,
                chapters: vec![],
                sibling_paths: vec![ep1_mkv.to_string_lossy().to_string()],
                subtitle_path: None,
                embedded_sub_idx: None,
                embedded_sub_codec: None,
                audio_stream_idx: None,
                low_power: false,
            },
            Some(&ffmpeg),
            Some(&mpv),
            &controller,
            path_opts,
        )
        .await
        .expect("detect ep2");
        let intro2 = res_ep2.primary_intro.expect("ep2 cached intro");
        assert!((intro2.start_secs - 38.0).abs() <= 2.0);
        assert!((intro2.end_secs - 83.0).abs() <= 2.0);

        // 3. Negative control: unrelated movie returns no false positive
        let res_mov = execute_detect_intro_with_tools(
            IntroDetectRequest {
                video_path: mov_mkv.to_string_lossy().to_string(),
                duration_secs: 160.0,
                chapters: vec![],
                sibling_paths: vec![ep1_mkv.to_string_lossy().to_string()],
                subtitle_path: None,
                embedded_sub_idx: None,
                embedded_sub_codec: None,
                audio_stream_idx: None,
                low_power: false,
            },
            Some(&ffmpeg),
            Some(&mpv),
            &controller,
            path_opts,
        )
        .await
        .expect("run unrelated check");
        assert!(res_mov.primary_intro.is_none());

        // 4. Verify mpv.exe fallback extractor (ffmpeg = None) also detects the real MKV intro
        controller.clear_caches();
        let res_mpv = execute_detect_intro_with_tools(
            IntroDetectRequest {
                video_path: ep1_mkv.to_string_lossy().to_string(),
                duration_secs: 160.0,
                chapters: vec![],
                sibling_paths: vec![ep2_mkv.to_string_lossy().to_string()],
                subtitle_path: None,
                embedded_sub_idx: None,
                embedded_sub_codec: None,
                audio_stream_idx: Some(0),
                low_power: true,
            },
            None,
            Some(&mpv),
            &controller,
            path_opts,
        )
        .await
        .expect("detect ep1 via mpv fallback");
        let mpv_intro = res_mpv.primary_intro.expect("mpv extractor intro");
        assert!((mpv_intro.start_secs - 12.0).abs() <= 2.5);
        assert!((mpv_intro.end_secs - 57.0).abs() <= 2.5);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn test_real_mkv_chapters_and_embedded_ass_intro() {
        let Some((ffmpeg, _mpv)) = test_tools_paths() else {
            return;
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("epilod_intro_sub_{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();

        let ass_content = "\
[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: OP-Romaji,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:08.00,Default,,0,0,0,,Previously on the show...
Dialogue: 0,0:00:15.00,0:00:35.00,OP-Romaji,,0,0,0,,Opening verse one
Dialogue: 0,0:00:36.00,0:01:05.00,OP-Romaji,,0,0,0,,Opening chorus
Dialogue: 0,0:01:06.00,0:01:40.00,OP-Romaji,,0,0,0,,Opening finale
Dialogue: 0,0:01:45.00,0:01:50.00,Default,,0,0,0,,Let us begin.
";
        let ass_path = dir.join("op.ass");
        std::fs::write(&ass_path, ass_content).unwrap();

        let mkv_path = dir.join("Show.S01E03.mkv");
        let out = StdCommand::new(&ffmpeg)
            .args([
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=64x64:r=1:d=180",
                "-i",
                &ass_path.to_string_lossy(),
                "-map",
                "0:v",
                "-map",
                "1:s",
                "-c:v",
                "mpeg4",
                "-c:s",
                "ass",
                "-shortest",
                &mkv_path.to_string_lossy(),
            ])
            .output()
            .expect("mux sub mkv");
        assert!(
            out.status.success(),
            "mux sub mkv failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let controller = IntroDetectController::new();
        let path_opts = LocalPathOptions {
            allow_network_shares: false,
        };

        // Embedded ASS OP style extraction directly from MKV
        let sub_res = execute_detect_intro_with_tools(
            IntroDetectRequest {
                video_path: mkv_path.to_string_lossy().to_string(),
                duration_secs: 180.0,
                chapters: vec![],
                sibling_paths: vec![],
                subtitle_path: None,
                embedded_sub_idx: Some(0),
                embedded_sub_codec: Some("ass".to_string()),
                audio_stream_idx: None,
                low_power: false,
            },
            Some(&ffmpeg),
            None,
            &controller,
            path_opts,
        )
        .await
        .expect("detect embedded ass intro");
        let sub_intro = sub_res
            .primary_intro
            .expect("detected OP from embedded ASS");
        assert_eq!(sub_intro.source, IntroSource::SubtitleCue);
        assert!((sub_intro.start_secs - 15.0).abs() < 0.5);
        assert!((sub_intro.end_secs - 100.0).abs() < 0.5);

        // Chapter priority overrides and handles Recap + OP cleanly
        let chap_res = execute_detect_intro_with_tools(
            IntroDetectRequest {
                video_path: mkv_path.to_string_lossy().to_string(),
                duration_secs: 180.0,
                chapters: vec![
                    MpvChapter {
                        title: Some("Recap".to_string()),
                        time: 0.0,
                    },
                    MpvChapter {
                        title: Some("Opening".to_string()),
                        time: 22.0,
                    },
                    MpvChapter {
                        title: Some("Main Story".to_string()),
                        time: 112.0,
                    },
                ],
                sibling_paths: vec![],
                subtitle_path: None,
                embedded_sub_idx: Some(0),
                embedded_sub_codec: Some("ass".to_string()),
                audio_stream_idx: None,
                low_power: false,
            },
            Some(&ffmpeg),
            None,
            &controller,
            path_opts,
        )
        .await
        .expect("detect chapter intro");
        assert_eq!(
            chap_res.primary_intro.as_ref().map(|i| i.confidence),
            Some(IntroConfidence::High)
        );
        assert_eq!(chap_res.segments.len(), 2);
        assert_eq!(chap_res.segments[0].skip_target_secs, 112.0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
