pub mod autosync;

#[cfg(windows)]
pub mod cloud_sync;
#[cfg(windows)]
pub mod intro;
#[cfg(windows)]
pub mod media_library;
#[cfg(windows)]
pub mod mpv;
#[cfg(windows)]
pub mod p2p;
#[cfg(windows)]
pub mod sparse_align;
#[cfg(windows)]
pub mod subtitles;
#[cfg(windows)]
pub mod syncplay;
#[cfg(windows)]
pub mod updater;
#[cfg(windows)]
pub mod voice;

use epilod_core::rate_limit::CommandRateGuard;
use epilod_core::validation::LocalPathOptions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct NetworkSharePolicy {
    allow: AtomicBool,
}

impl NetworkSharePolicy {
    pub fn new(allow: bool) -> Self {
        Self {
            allow: AtomicBool::new(allow),
        }
    }

    pub fn set(&self, allow: bool) {
        self.allow.store(allow, Ordering::SeqCst);
    }

    pub fn options(&self) -> LocalPathOptions {
        LocalPathOptions {
            allow_network_shares: self.allow.load(Ordering::SeqCst),
        }
    }
}

/// Fix 15: Returns true when viewport dimensions are collapsed (e.g. minimized),
/// meaning any cached HWND rect must be invalidated.
pub fn is_zero_viewport(width: i32, height: i32) -> bool {
    width <= 0 || height <= 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DragRestoreBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[allow(clippy::too_many_arguments)]
pub fn compute_drag_restore_bounds(
    cursor_x: i32,
    cursor_y: i32,
    max_rect: (i32, i32, i32, i32),
    work_rect: (i32, i32, i32, i32),
    normal_size: (i32, i32),
    min_size: (i32, i32),
) -> DragRestoreBounds {
    let max_w = (max_rect.2 - max_rect.0).max(1);
    let max_h = (max_rect.3 - max_rect.1).max(1);
    let min_w = min_size.0.max(320).min(max_w);
    let min_h = min_size.1.max(240).min(max_h);

    let mut width = normal_size.0.max(min_w).min(max_w);
    let mut height = normal_size.1.max(min_h).min(max_h);
    if width >= max_w - 24 && height >= max_h - 24 {
        width = (((max_w as f64) * 0.80).round() as i32)
            .max(min_w)
            .min(max_w);
        height = (((max_h as f64) * 0.82).round() as i32)
            .max(min_h)
            .min(max_h);
    }

    let ratio = ((cursor_x - max_rect.0) as f64 / max_w as f64).clamp(0.08, 0.92);
    let offset_y = (cursor_y - max_rect.1).clamp(8, 44);
    let x = cursor_x - ((width as f64 * ratio).round() as i32);
    let y = (cursor_y - offset_y).max(work_rect.1);

    DragRestoreBounds {
        x,
        y,
        width,
        height,
    }
}

/// Tracks minimize/restore and fullscreen state transitions so `on_window_event`
/// only emits `window://restored` or `window://fullscreen` on actual transitions,
/// preventing IPC storms during drag-resizing and focus changes.
#[derive(Debug, Default)]
pub struct WindowTransitionTracker {
    was_minimized: AtomicBool,
    last_fullscreen: AtomicBool,
}

impl WindowTransitionTracker {
    pub fn on_resize(&self, width: u32, height: u32) -> bool {
        if width == 0 || height == 0 {
            self.was_minimized.store(true, Ordering::Release);
            false
        } else {
            self.was_minimized.swap(false, Ordering::AcqRel)
        }
    }

    pub fn on_fullscreen_sample(&self, is_fullscreen: bool) -> Option<bool> {
        let prev = self.last_fullscreen.swap(is_fullscreen, Ordering::AcqRel);
        if prev != is_fullscreen {
            Some(is_fullscreen)
        } else {
            None
        }
    }
}

/// Fix 18: Exempt explicit backup switches and distinct room/endpoint transitions
/// from aggressive `sync_connect` rate lockouts while still bounding abusive repeats.
pub fn check_sync_connect_allowed(
    guard: &mut CommandRateGuard,
    endpoint: &str,
    room: &str,
    is_backup_switch: bool,
    now: Instant,
) -> bool {
    if is_backup_switch {
        return guard.allow("sync_backup", 6, Duration::from_secs(10), now);
    }
    let key = format!("sync_connect:{endpoint}:{room}");
    guard.allow(&key, 6, Duration::from_secs(10), now)
}

pub fn resolve_update_target_dir(
    exe_dir: Option<&Path>,
    registry_dir: Option<&Path>,
    default_dir: &Path,
) -> PathBuf {
    if let Some(dir) = exe_dir {
        let norm = dir
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        let is_cargo_dev = norm.ends_with("/target/debug") || norm.ends_with("/target/release");
        if !is_cargo_dev
            && (dir.join("epilod-install-manifest.json").is_file()
                || dir.join("Epilod Party.exe").is_file()
                || dir.join("epilod-party.exe").is_file())
        {
            return dir.to_path_buf();
        }
    }

    if let Some(reg) = registry_dir {
        if !reg.as_os_str().is_empty() {
            return reg.to_path_buf();
        }
    }

    default_dir.to_path_buf()
}

#[cfg(windows)]
mod windows_app {
    use super::*;
    use crate::autosync::{
        detect_embedded_subtitle_languages_from_video, execute_auto_sync, execute_two_anchor_sync,
        AutoSyncController, AutoSyncResultDto, DetectedSubtitleLangDto, SubtitleLangProbeTrackDto,
    };
    use crate::mpv::hwnd::PhysicalRect;
    use crate::mpv::MpvController;
    use crate::syncplay::{LocalFileMeta, SyncCommand, SyncController};
    use epilod_core::logging::{LogLevel, LogsSnapshot, RingLogger};
    use epilod_core::mpv_ipc::{
        loadfile_cmd, set_aid_cmd, set_aspect_cmd, set_loop_cmd, set_mute_cmd, set_pause_cmd,
        set_secondary_sub_delay_cmd, set_secondary_sub_pos_cmd, set_secondary_sub_track_cmd,
        set_sid_cmd, set_speed_cmd, set_sub_delay_cmd, set_sub_style_cmds_with_bold,
        set_video_margin_right_cmd, set_volume_cmd, show_osd_text_cmd, sub_add_cmd_with_title,
        sub_remove_cmd,
    };
    use epilod_core::room_code::BACKUP_ENDPOINT;
    use epilod_core::subtitle_sync::{
        contains_arabic, decode_subtitle_bytes_with_hint, fix_rtl_subtitles, SubtitleEncodingHint,
    };
    use epilod_core::validation::{
        is_allowed_webview_url, sanitize_aspect_mode, sanitize_hex_color, sanitize_playback_speed,
        sanitize_username, validate_existing_local_file_with_options,
    };
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex};
    use std::time::SystemTime;
    use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

    static DECODED_SUB_SEQ: AtomicU64 = AtomicU64::new(1);

    use crate::intro::{execute_detect_intro, IntroDetectController, IntroDetectRequest};
    use crate::media_library::{
        check_local_files_exist as check_local_files_exist_impl,
        dpapi_protect_secret as dpapi_protect_impl, dpapi_unprotect_secret as dpapi_unprotect_impl,
        FindLocalMatchesRequest, MediaLibraryState,
    };
    use crate::syncplay::{
        probe_pinned_rooms as probe_pinned_rooms_impl, ProbeRoomRequest, RoomOccupancyDto,
    };
    use crate::voice::{
        list_voice_devices, VoiceConfigDto, VoiceController, VoiceDeviceListDto,
        VoiceDiagnosticsDto,
    };
    use epilod_core::intro_detect::IntroDetectionOutcome;
    use epilod_core::matching::LocalMatchCandidate;
    use epilod_core::mpv_ipc::MpvChapter;
    use epilod_core::room_code::{parse_invite_link, DeepLinkInvite};

    const DEEP_LINK_PIPE_NAME: &str = r"\\.\pipe\EpilodParty_DeepLink_v1";

    pub struct AppState {
        pub mpv: Arc<MpvController>,
        pub sync: Arc<SyncController>,
        pub voice: Arc<VoiceController>,
        pub autosync: Arc<AutoSyncController>,
        pub intro_detect: Arc<IntroDetectController>,
        pub media_library: Arc<MediaLibraryState>,
        pub pending_deep_link: Arc<Mutex<Option<DeepLinkInvite>>>,
        pub logger: Arc<Mutex<RingLogger>>,
        pub rate_guard: Arc<Mutex<CommandRateGuard>>,
        pub network_policy: Arc<NetworkSharePolicy>,
        pub updater: Arc<crate::updater::UpdaterState>,
    }

    fn log_backend(state: &AppState, level: LogLevel, target: &str, code: Option<&str>, msg: &str) {
        if let Ok(mut lg) = state.logger.lock() {
            lg.log(level, target, code, msg, SystemTime::now(), Instant::now());
        }
    }

    fn check_rate(
        state: &AppState,
        bucket: &str,
        limit: usize,
        window: Duration,
    ) -> Result<(), String> {
        let mut guard = state
            .rate_guard
            .lock()
            .map_err(|_| "Rate guard poisoned".to_string())?;
        if guard.allow(bucket, limit, window, Instant::now()) {
            Ok(())
        } else {
            Err("Too many rapid commands. Please slow down slightly.".to_string())
        }
    }

    #[tauri::command]
    async fn mpv_start(
        app: AppHandle,
        window: WebviewWindow,
        state: State<'_, AppState>,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<(), String> {
        let hwnd = window
            .hwnd()
            .map_err(|e| format!("Could not resolve parent HWND: {e}"))?
            .0 as isize;
        let rect = PhysicalRect {
            x,
            y,
            width,
            height,
        };
        state.mpv.start(&app, hwnd, rect).await.inspect_err(|e| {
            log_backend(
                &state,
                LogLevel::Error,
                "mpv.start",
                Some("ERR_MPV_START"),
                e,
            );
        })
    }

    #[tauri::command]
    async fn mpv_resize(
        state: State<'_, AppState>,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        force: Option<bool>,
    ) -> Result<(), String> {
        state.mpv.resize(
            PhysicalRect {
                x,
                y,
                width,
                height,
            },
            force.unwrap_or(false),
        )
    }

    #[tauri::command]
    async fn mpv_set_visible(state: State<'_, AppState>, visible: bool) -> Result<(), String> {
        state.mpv.set_visible(visible)
    }

    #[tauri::command]
    async fn mpv_get_surface_state(
        state: State<'_, AppState>,
    ) -> Result<crate::mpv::MpvSurfaceState, String> {
        Ok(state.mpv.surface_state())
    }

    #[tauri::command]
    async fn mpv_backdrop_frame(
        state: State<'_, AppState>,
        max_width: Option<i32>,
        max_height: Option<i32>,
    ) -> Result<tauri::ipc::Response, String> {
        let w = max_width.unwrap_or(240);
        let h = max_height.unwrap_or(135);
        let bytes = state.mpv.capture_backdrop_frame(w, h).await?;
        Ok(tauri::ipc::Response::new(bytes))
    }

    #[tauri::command]
    async fn mpv_capture_freeze_frame(
        state: State<'_, AppState>,
    ) -> Result<tauri::ipc::Response, String> {
        let bytes = state.mpv.capture_clean_freeze_frame().await?;
        Ok(tauri::ipc::Response::new(bytes))
    }

    #[tauri::command]
    async fn mpv_load(state: State<'_, AppState>, path: String) -> Result<(), String> {
        let opts = state.network_policy.options();
        let valid_path = tokio::task::spawn_blocking(move || {
            validate_existing_local_file_with_options(&path, opts).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("Failed validating video path: {e}"))??;
        let path_str = valid_path.to_string_lossy().into_owned();

        {
            let mut rg = state
                .rate_guard
                .lock()
                .map_err(|_| "Rate guard poisoned".to_string())?;
            if rg.is_duplicate_within(
                "mpv_load",
                &path_str,
                Duration::from_millis(500),
                Instant::now(),
            ) {
                return Ok(());
            }
        }

        state.autosync.cancel();
        state.intro_detect.cancel();
        state.mpv.prepare_for_load();
        state.mpv.set_media_loaded(true);
        let pause_req = state.mpv.next_request_id();
        let _ = state.mpv.send_command(set_pause_cmd(pause_req, true));

        let req = state.mpv.next_request_id();
        if let Err(e) = state.mpv.send_command(loadfile_cmd(req, &path_str)) {
            state.mpv.set_media_loaded(false);
            state.mpv.clear_loading_flag();
            if let Ok(mut rg) = state.rate_guard.lock() {
                rg.clear_dedup_if_matches("mpv_load", &path_str);
            }
            return Err(e);
        }
        state.sync.reset_for_new_file();
        state.sync.set_local_media_path(Some(valid_path.clone()));

        log_backend(
            &state,
            LogLevel::Info,
            "mpv.load",
            None,
            &format!(
                "Loaded local media file ({})",
                valid_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("video")
            ),
        );
        Ok(())
    }

    #[tauri::command]
    async fn mpv_set_pause(state: State<'_, AppState>, paused: bool) -> Result<(), String> {
        check_rate(&state, "mpv_transport", 40, Duration::from_secs(2))?;
        if state.mpv.note_paused(paused) {
            return Ok(());
        }
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_pause_cmd(req, paused))
    }

    #[tauri::command]
    async fn mpv_seek(
        state: State<'_, AppState>,
        seconds: f64,
        preview: Option<bool>,
        client_seek_seq: Option<u64>,
    ) -> Result<(), String> {
        check_rate(&state, "mpv_transport", 40, Duration::from_secs(2))?;
        state
            .mpv
            .dispatch_seek(seconds, preview.unwrap_or(false), client_seek_seq)
    }

    #[tauri::command]
    async fn mpv_stop(state: State<'_, AppState>) -> Result<(), String> {
        state.autosync.cancel();
        state.intro_detect.cancel();
        state.mpv.stop_and_clear().await;
        Ok(())
    }

    #[tauri::command]
    async fn mpv_set_volume(state: State<'_, AppState>, volume: f64) -> Result<(), String> {
        check_rate(&state, "mpv_volume", 60, Duration::from_secs(2))?;
        let effective = state.voice.duck().set_user_volume(volume);
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_volume_cmd(req, effective))
    }

    #[tauri::command]
    async fn mpv_set_mute(state: State<'_, AppState>, muted: bool) -> Result<(), String> {
        check_rate(&state, "mpv_volume", 60, Duration::from_secs(2))?;
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_mute_cmd(req, muted))
    }

    #[tauri::command]
    async fn mpv_set_speed(state: State<'_, AppState>, speed: f64) -> Result<(), String> {
        let safe = sanitize_playback_speed(speed).map_err(|e| e.to_string())?;
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_speed_cmd(req, safe))
    }

    #[tauri::command]
    async fn mpv_set_loop(state: State<'_, AppState>, looping: bool) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_loop_cmd(req, looping))
    }

    #[tauri::command]
    async fn mpv_set_aspect_mode(state: State<'_, AppState>, aspect: String) -> Result<(), String> {
        let safe = sanitize_aspect_mode(&aspect).map_err(|e| e.to_string())?;
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_aspect_cmd(req, safe))
    }

    #[tauri::command]
    async fn mpv_set_video_margin_right(
        state: State<'_, AppState>,
        ratio: f64,
    ) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state
            .mpv
            .send_command(set_video_margin_right_cmd(req, ratio))
    }

    fn prune_decoded_subs_dir(sub_dir: &Path, keep_latest: usize) {
        let Ok(entries) = std::fs::read_dir(sub_dir) else {
            return;
        };
        let mut files: Vec<(SystemTime, PathBuf)> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                let name = p.file_name()?.to_str()?;
                if !name.starts_with("decoded_") {
                    return None;
                }
                let modified = e
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                Some((modified, p))
            })
            .collect();
        if files.len() <= keep_latest {
            return;
        }
        files.sort_by_key(|b| std::cmp::Reverse(b.0));
        for (_, old_path) in files.into_iter().skip(keep_latest) {
            let _ = std::fs::remove_file(old_path);
        }
    }

    fn is_internal_temp_sub_name(name: &str) -> bool {
        let lower = name.trim().to_ascii_lowercase();
        lower.starts_with("decoded_")
            || lower.starts_with("synced_")
            || lower.starts_with("epilod_synced_")
            || lower.starts_with("embedded_")
            || lower.starts_with("autosync_")
    }

    fn derive_external_sub_title(path: &Path, explicit_title: Option<&str>) -> Option<String> {
        if let Some(raw) = explicit_title {
            let trimmed = raw.trim();
            if !trimmed.is_empty() && !is_internal_temp_sub_name(trimmed) {
                return Some(trimmed.chars().take(120).collect());
            }
        }
        let fname = path.file_name()?.to_str()?.trim();
        if fname.is_empty() || is_internal_temp_sub_name(fname) {
            None
        } else {
            Some(fname.chars().take(120).collect())
        }
    }

    #[tauri::command]
    async fn mpv_add_subtitle(
        state: State<'_, AppState>,
        path: String,
        encoding_hint: Option<SubtitleEncodingHint>,
        display_title: Option<String>,
        fix_rtl: Option<bool>,
    ) -> Result<(), String> {
        let opts = state.network_policy.options();
        let hint = encoding_hint.unwrap_or_default();
        let apply_fix_rtl = fix_rtl.unwrap_or(true);

        // Fix 25: Convert legacy non-UTF8 or explicit-hint subtitle files to clean UTF-8 temp file for libass.
        // Run all filesystem & decoding work off the async executor so UNC/large files never stall IPC.
        let (load_path, resolved_title) =
            tokio::task::spawn_blocking(move || -> Result<(String, Option<String>), String> {
                let valid = validate_existing_local_file_with_options(&path, opts)
                    .map_err(|e| e.to_string())?;
                let title = derive_external_sub_title(&valid, display_title.as_deref());
                match std::fs::read(&valid) {
                    Ok(bytes) => {
                        let ext = valid.extension().and_then(|e| e.to_str()).unwrap_or("srt");
                        let is_srt_or_vtt =
                            ext.eq_ignore_ascii_case("srt") || ext.eq_ignore_ascii_case("vtt");
                        let utf8_str = std::str::from_utf8(&bytes).ok();
                        let needs_rtl_fix =
                            apply_fix_rtl && is_srt_or_vtt && utf8_str.is_some_and(contains_arabic);
                        let needs_transcode = hint != SubtitleEncodingHint::Auto
                            || utf8_str.is_none()
                            || needs_rtl_fix;
                        if needs_transcode {
                            let decoded = decode_subtitle_bytes_with_hint(&bytes, hint)
                                .map_err(|e| e.to_string())?;
                            let final_text = if apply_fix_rtl && is_srt_or_vtt {
                                fix_rtl_subtitles(&decoded, ext)
                            } else {
                                decoded
                            };
                            let sub_dir = std::env::temp_dir().join("epilod-subs");
                            std::fs::create_dir_all(&sub_dir)
                                .map_err(|e| format!("Failed creating temp subtitle dir: {e}"))?;
                            let seq = DECODED_SUB_SEQ.fetch_add(1, Ordering::Relaxed);
                            let out =
                                sub_dir.join(format!("decoded_{}_{seq}.{ext}", std::process::id()));
                            std::fs::write(&out, final_text.as_bytes()).map_err(|e| {
                                format!("Failed writing decoded UTF-8 subtitle: {e}")
                            })?;
                            prune_decoded_subs_dir(&sub_dir, 10);
                            Ok((out.to_string_lossy().into_owned(), title))
                        } else {
                            Ok((valid.to_string_lossy().into_owned(), title))
                        }
                    }
                    Err(_) => Ok((valid.to_string_lossy().into_owned(), title)),
                }
            })
            .await
            .map_err(|e| format!("Subtitle processing task failed: {e}"))??;

        let req = state.mpv.next_request_id();
        state.mpv.send_command(sub_add_cmd_with_title(
            req,
            &load_path,
            resolved_title.as_deref(),
        ))
    }

    #[tauri::command]
    async fn mpv_remove_subtitle(state: State<'_, AppState>, sid: u64) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state.mpv.send_command(sub_remove_cmd(req, sid))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    async fn mpv_set_sub_style(
        state: State<'_, AppState>,
        font: String,
        bold: Option<bool>,
        font_size: u32,
        color: String,
        border_size: f64,
        pos: u32,
        visible: bool,
        override_ass: Option<bool>,
    ) -> Result<(), String> {
        let safe_color = sanitize_hex_color(&color).map_err(|e| e.to_string())?;
        let first_id = state.mpv.next_request_id();
        let cmds = set_sub_style_cmds_with_bold(
            first_id,
            font.trim(),
            font_size,
            &safe_color,
            border_size,
            pos,
            visible,
            override_ass.unwrap_or(false),
            bold.unwrap_or(false),
        );
        for _ in 1..cmds.len() {
            let _ = state.mpv.next_request_id();
        }
        for c in cmds {
            state.mpv.send_command(c)?;
        }
        Ok(())
    }

    #[tauri::command]
    async fn mpv_set_sub_delay(state: State<'_, AppState>, delay_secs: f64) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_sub_delay_cmd(req, delay_secs))
    }

    #[tauri::command]
    async fn mpv_set_audio_track(
        state: State<'_, AppState>,
        aid: Option<u64>,
    ) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_aid_cmd(req, aid))
    }

    #[tauri::command]
    async fn mpv_set_secondary_sub_track(
        state: State<'_, AppState>,
        sid: Option<u64>,
        pos: Option<u32>,
    ) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state
            .mpv
            .send_command(set_secondary_sub_track_cmd(req, sid))?;
        if sid.is_some() {
            let pos_req = state.mpv.next_request_id();
            state
                .mpv
                .send_command(set_secondary_sub_pos_cmd(pos_req, pos.unwrap_or(10)))?;
        }
        Ok(())
    }

    #[tauri::command]
    async fn mpv_set_secondary_sub_delay(
        state: State<'_, AppState>,
        delay_secs: f64,
    ) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state
            .mpv
            .send_command(set_secondary_sub_delay_cmd(req, delay_secs))
    }

    #[tauri::command]
    async fn mpv_show_osd_text(
        state: State<'_, AppState>,
        text: String,
        duration_ms: Option<u32>,
    ) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state
            .mpv
            .send_command(show_osd_text_cmd(req, &text, duration_ms.unwrap_or(2400)))
    }

    #[tauri::command]
    async fn mpv_set_sub_track(state: State<'_, AppState>, sid: Option<u64>) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_sid_cmd(req, sid))?;
        // Selecting a track must also make subtitles visible in mpv; otherwise a
        // previously hidden state (sub-visibility=no) keeps the chosen CC invisible.
        let vis_req = state.mpv.next_request_id();
        state
            .mpv
            .send_command(epilod_core::mpv_ipc::set_property_cmd(
                vis_req,
                "sub-visibility",
                serde_json::json!(sid.is_some()),
            ))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    async fn subtitle_auto_sync(
        app: AppHandle,
        state: State<'_, AppState>,
        video_path: String,
        subtitle_path: Option<String>,
        audio_track_id: Option<u64>,
        embedded_sub_idx: Option<usize>,
        embedded_sub_ff_idx: Option<u64>,
        embedded_sub_codec: Option<String>,
        encoding_hint: Option<SubtitleEncodingHint>,
        low_power: Option<bool>,
    ) -> Result<AutoSyncResultDto, String> {
        let opts = state.network_policy.options();
        execute_auto_sync(
            &app,
            &state.autosync,
            &video_path,
            subtitle_path.as_deref(),
            audio_track_id,
            embedded_sub_idx,
            embedded_sub_ff_idx,
            embedded_sub_codec.as_deref(),
            encoding_hint.unwrap_or_default(),
            low_power.unwrap_or(false),
            opts,
        )
        .await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    async fn subtitle_two_anchor_sync(
        app: AppHandle,
        state: State<'_, AppState>,
        subtitle_path: Option<String>,
        video_path: Option<String>,
        embedded_sub_idx: Option<usize>,
        embedded_sub_ff_idx: Option<u64>,
        embedded_sub_codec: Option<String>,
        src_a_secs: f64,
        dst_a_secs: f64,
        src_b_secs: f64,
        dst_b_secs: f64,
        encoding_hint: Option<SubtitleEncodingHint>,
    ) -> Result<AutoSyncResultDto, String> {
        let opts = state.network_policy.options();
        let hint = encoding_hint.unwrap_or_default();
        execute_two_anchor_sync(
            &app,
            subtitle_path.as_deref(),
            video_path.as_deref(),
            embedded_sub_idx,
            embedded_sub_ff_idx,
            embedded_sub_codec.as_deref(),
            src_a_secs,
            dst_a_secs,
            src_b_secs,
            dst_b_secs,
            hint,
            opts,
        )
        .await
    }

    #[tauri::command]
    async fn subtitle_cancel_auto_sync(state: State<'_, AppState>) -> Result<(), String> {
        state.autosync.cancel();
        Ok(())
    }

    #[tauri::command]
    async fn subtitle_search_online(
        state: State<'_, AppState>,
        req: crate::subtitles::SubtitleSearchRequest,
    ) -> Result<crate::subtitles::SubtitleSearchResultDto, String> {
        check_rate(&state, "sub_online_search", 16, Duration::from_secs(6))?;
        let opts = state.network_policy.options();
        crate::subtitles::search_online_subtitles_impl(req, opts).await
    }

    #[tauri::command]
    async fn subtitle_download_online(
        state: State<'_, AppState>,
        req: crate::subtitles::SubtitleDownloadRequest,
    ) -> Result<crate::subtitles::DownloadedSubtitleDto, String> {
        check_rate(&state, "sub_online_download", 16, Duration::from_secs(6))?;
        crate::subtitles::download_online_subtitle_impl(req).await
    }

    #[tauri::command]
    async fn subtitle_auto_fetch_online(
        state: State<'_, AppState>,
        req: crate::subtitles::AutoFetchSubtitleRequest,
    ) -> Result<crate::subtitles::AutoFetchSubtitleResultDto, String> {
        check_rate(&state, "sub_online_autofetch", 12, Duration::from_secs(6))?;
        let opts = state.network_policy.options();
        crate::subtitles::auto_fetch_online_subtitle_impl(req, opts).await
    }

    #[tauri::command]
    async fn detect_embedded_subtitle_languages(
        app: AppHandle,
        state: State<'_, AppState>,
        video_path: String,
        tracks: Vec<SubtitleLangProbeTrackDto>,
    ) -> Result<Vec<DetectedSubtitleLangDto>, String> {
        check_rate(&state, "sub_lang_probe", 20, Duration::from_secs(4))?;
        let opts = state.network_policy.options();
        detect_embedded_subtitle_languages_from_video(&app, &video_path, &tracks, opts).await
    }

    #[allow(clippy::too_many_arguments)]
    #[tauri::command]
    async fn detect_video_intro(
        app: AppHandle,
        state: State<'_, AppState>,
        video_path: String,
        duration_secs: f64,
        chapters: Vec<MpvChapter>,
        sibling_paths: Vec<String>,
        subtitle_path: Option<String>,
        embedded_sub_idx: Option<usize>,
        embedded_sub_codec: Option<String>,
        audio_stream_idx: Option<usize>,
        low_power: bool,
    ) -> Result<IntroDetectionOutcome, String> {
        check_rate(&state, "intro_detect", 16, Duration::from_secs(4))?;
        let opts = state.network_policy.options();
        let req = IntroDetectRequest {
            video_path,
            duration_secs,
            chapters,
            sibling_paths,
            subtitle_path,
            embedded_sub_idx,
            embedded_sub_codec,
            audio_stream_idx,
            low_power,
        };
        execute_detect_intro(&app, &state.intro_detect, req, opts).await
    }

    #[tauri::command]
    async fn intro_cancel_detect(state: State<'_, AppState>) -> Result<(), String> {
        state.intro_detect.cancel();
        Ok(())
    }

    #[tauri::command]
    async fn window_set_fullscreen(window: WebviewWindow, fullscreen: bool) -> Result<(), String> {
        window
            .set_fullscreen(fullscreen)
            .map_err(|e| format!("Fullscreen update failed: {e}"))
    }

    #[tauri::command]
    async fn window_is_fullscreen(window: WebviewWindow) -> Result<bool, String> {
        window
            .is_fullscreen()
            .map_err(|e| format!("Could not read fullscreen state: {e}"))
    }

    #[tauri::command]
    async fn window_drag_from_maximized(window: WebviewWindow) -> Result<(), String> {
        use std::sync::mpsc;
        use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
        use windows_sys::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetCursorPos, GetWindowPlacement, GetWindowRect, IsZoomed, SetWindowPlacement,
            SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOZORDER, SW_SHOWNORMAL, WINDOWPLACEMENT,
        };

        let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
        let win_for_ui = window.clone();
        window
            .run_on_main_thread(move || {
                let res = (|| -> Result<(), String> {
                    let hwnd = win_for_ui
                        .hwnd()
                        .map_err(|e| format!("Could not resolve window HWND: {e}"))?
                        .0 as HWND;
                    unsafe {
                        if IsZoomed(hwnd) != 0 {
                            let mut cursor_pt: POINT = std::mem::zeroed();
                            let _ = GetCursorPos(&mut cursor_pt);

                            let mut max_rect: RECT = std::mem::zeroed();
                            let _ = GetWindowRect(hwnd, &mut max_rect);

                            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                            let mut mi: MONITORINFO = std::mem::zeroed();
                            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
                            let has_mi = GetMonitorInfoW(monitor, &mut mi) != 0;
                            let work_rect = if has_mi { mi.rcWork } else { max_rect };
                            let mon_rect = if has_mi { mi.rcMonitor } else { max_rect };

                            let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
                            wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                            let _ = GetWindowPlacement(hwnd, &mut wp);

                            let normal_w =
                                (wp.rcNormalPosition.right - wp.rcNormalPosition.left).max(1024);
                            let normal_h =
                                (wp.rcNormalPosition.bottom - wp.rcNormalPosition.top).max(640);
                            let target = compute_drag_restore_bounds(
                                cursor_pt.x,
                                cursor_pt.y,
                                (max_rect.left, max_rect.top, max_rect.right, max_rect.bottom),
                                (
                                    work_rect.left,
                                    work_rect.top,
                                    work_rect.right,
                                    work_rect.bottom,
                                ),
                                (normal_w, normal_h),
                                (1024, 640),
                            );

                            let ws_dx = work_rect.left - mon_rect.left;
                            let ws_dy = work_rect.top - mon_rect.top;
                            wp.showCmd = SW_SHOWNORMAL as u32;
                            wp.rcNormalPosition = RECT {
                                left: target.x - ws_dx,
                                top: target.y - ws_dy,
                                right: (target.x - ws_dx) + target.width,
                                bottom: (target.y - ws_dy) + target.height,
                            };
                            let _ = SetWindowPlacement(hwnd, &wp);
                            let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
                            let _ = SetWindowPos(
                                hwnd,
                                std::ptr::null_mut(),
                                target.x,
                                target.y,
                                target.width,
                                target.height,
                                SWP_NOZORDER | SWP_NOACTIVATE,
                            );
                        }
                    }
                    win_for_ui
                        .start_dragging()
                        .map_err(|e| format!("Window drag start failed: {e}"))
                })();
                let _ = tx.send(res);
            })
            .map_err(|e| format!("Failed dispatching drag restore to main thread: {e}"))?;

        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|e| format!("Timed out starting window drag: {e}"))?
    }

    #[tauri::command]
    async fn set_allow_network_shares(
        state: State<'_, AppState>,
        allow: bool,
    ) -> Result<(), String> {
        state.network_policy.set(allow);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    #[tauri::command]
    async fn sync_connect(
        app: AppHandle,
        state: State<'_, AppState>,
        endpoint: String,
        username: String,
        room_code: String,
        literal_room: Option<bool>,
        password: Option<String>,
        host_only: Option<bool>,
        claim_empty: Option<bool>,
    ) -> Result<(), String> {
        let clean_user = sanitize_username(&username).map_err(|e| e.to_string())?;
        {
            let mut rg = state
                .rate_guard
                .lock()
                .map_err(|_| "Rate guard poisoned".to_string())?;
            if !check_sync_connect_allowed(&mut rg, &endpoint, &room_code, false, Instant::now()) {
                return Err("Too many room connection attempts. Please wait a moment.".to_string());
            }
        }
        state
            .sync
            .connect(
                app,
                Arc::clone(&state.mpv),
                endpoint,
                clean_user,
                room_code,
                literal_room.unwrap_or(false),
                password,
                host_only.unwrap_or(false),
                claim_empty.unwrap_or(false),
                state.network_policy.options(),
            )
            .await
    }

    #[tauri::command]
    async fn sync_reconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
        state.sync.reconnect(app, Arc::clone(&state.mpv)).await
    }

    #[tauri::command]
    async fn sync_force_resync(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
        check_rate(&state, "sync_resync", 6, Duration::from_secs(5))?;
        state.sync.force_resync(app, Arc::clone(&state.mpv)).await
    }

    #[tauri::command]
    async fn sync_set_room_admin(
        state: State<'_, AppState>,
        username: String,
        grant: bool,
    ) -> Result<(), String> {
        check_rate(&state, "sync_admin", 12, Duration::from_secs(5))?;
        let trimmed = username.trim();
        if trimmed.is_empty() || trimmed.len() > 64 {
            return Err("Invalid participant username.".to_string());
        }
        state.sync.set_room_admin(trimmed.to_string(), grant).await
    }

    #[tauri::command]
    async fn set_global_shortcuts_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

        let shortcuts = [
            (
                "Ctrl+Alt+Space",
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space),
            ),
            (
                "Ctrl+Alt+Left",
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowLeft),
            ),
            (
                "Ctrl+Alt+Right",
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowRight),
            ),
        ];

        let mgr = app.global_shortcut();
        for (_, sc) in &shortcuts {
            let _ = mgr.unregister(*sc);
        }
        if !enabled {
            return Ok(());
        }

        let mut registered: Vec<Shortcut> = Vec::new();
        for (label, sc) in &shortcuts {
            if let Err(err) = mgr.register(*sc) {
                for prev in registered {
                    let _ = mgr.unregister(prev);
                }
                return Err(format!(
                    "Could not register global shortcut ({label}): {err}. Another app may already be using it."
                ));
            }
            registered.push(*sc);
        }
        Ok(())
    }

    #[tauri::command]
    async fn scan_media_paths(
        state: State<'_, AppState>,
        paths: Vec<String>,
    ) -> Result<epilod_core::playlist::MediaScanResultDto, String> {
        let opts = state.network_policy.options();
        tokio::task::spawn_blocking(move || epilod_core::playlist::scan_media_paths(&paths, opts))
            .await
            .map_err(|e| format!("Failed scanning media paths: {e}"))?
    }

    #[tauri::command]
    async fn sync_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
        state.voice.leave_voice();
        state.sync.disconnect().await;
        let _ = app.emit(
            "sync://status",
            serde_json::json!({ "state": "disconnected" }),
        );
        let _ = app.emit("sync://participants", Vec::<serde_json::Value>::new());
        let _ = app.emit(
            "sync://room-control",
            serde_json::json!({
                "hostControlActive": false,
                "localIsHost": false,
                "localIsAdmin": false,
                "hostUsername": null,
                "adminUsernames": [],
            }),
        );
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    #[tauri::command]
    async fn sync_switch_backup(
        app: AppHandle,
        state: State<'_, AppState>,
        username: String,
        room_code: String,
        literal_room: Option<bool>,
        password: Option<String>,
        host_only: Option<bool>,
    ) -> Result<(), String> {
        let clean_user = sanitize_username(&username).map_err(|e| e.to_string())?;
        {
            let mut rg = state
                .rate_guard
                .lock()
                .map_err(|_| "Rate guard poisoned".to_string())?;
            if !check_sync_connect_allowed(
                &mut rg,
                BACKUP_ENDPOINT,
                &room_code,
                true,
                Instant::now(),
            ) {
                return Err("Too many backup switch attempts.".to_string());
            }
        }
        state
            .sync
            .connect(
                app,
                Arc::clone(&state.mpv),
                BACKUP_ENDPOINT.to_string(),
                clean_user,
                room_code,
                literal_room.unwrap_or(false),
                password,
                host_only.unwrap_or(false),
                false,
                state.network_policy.options(),
            )
            .await
    }

    #[tauri::command]
    async fn sync_set_file(
        state: State<'_, AppState>,
        name: String,
        path: Option<String>,
        size_bytes: Option<u64>,
        duration_secs: f64,
        hash_identity: Option<bool>,
    ) -> Result<(), String> {
        let opts = state.network_policy.options();
        let validated_path = match path {
            Some(ref p) => {
                let p_clone = p.clone();
                tokio::task::spawn_blocking(move || {
                    validate_existing_local_file_with_options(&p_clone, opts).ok()
                })
                .await
                .ok()
                .flatten()
            }
            None => None,
        };
        if let Some(ref vp) = validated_path {
            state.sync.set_local_media_path(Some(vp.clone()));
        }
        let resolved_size = match (size_bytes, validated_path) {
            (Some(s), _) => Some(s),
            (None, Some(p)) => {
                tokio::task::spawn_blocking(move || std::fs::metadata(p).ok().map(|m| m.len()))
                    .await
                    .ok()
                    .flatten()
            }
            (None, None) => None,
        };
        state.sync.set_local_file(Some(LocalFileMeta {
            name,
            size_bytes: resolved_size,
            duration_secs,
            hash_identity: hash_identity.unwrap_or(false),
        }));
        Ok(())
    }

    #[tauri::command]
    async fn sync_set_ready(
        state: State<'_, AppState>,
        is_ready: bool,
        manual: Option<bool>,
    ) -> Result<(), String> {
        state.sync.set_local_ready(is_ready, manual.unwrap_or(true));
        Ok(())
    }

    #[tauri::command]
    async fn sync_user_play(state: State<'_, AppState>, position: f64) -> Result<(), String> {
        check_rate(&state, "sync_ctl", 30, Duration::from_secs(2))?;
        state.sync.send_command(SyncCommand::UserPlay(position));
        Ok(())
    }

    #[tauri::command]
    async fn sync_user_pause(state: State<'_, AppState>, position: f64) -> Result<(), String> {
        check_rate(&state, "sync_ctl", 30, Duration::from_secs(2))?;
        state.sync.send_command(SyncCommand::UserPause(position));
        Ok(())
    }

    #[tauri::command]
    async fn sync_user_seek(state: State<'_, AppState>, position: f64) -> Result<(), String> {
        check_rate(&state, "sync_ctl", 30, Duration::from_secs(2))?;
        state.sync.send_command(SyncCommand::UserSeek(position));
        Ok(())
    }

    #[tauri::command]
    async fn sync_set_scrubbing(state: State<'_, AppState>, scrubbing: bool) -> Result<(), String> {
        state.sync.set_scrubbing(scrubbing);
        Ok(())
    }

    #[tauri::command]
    async fn sync_set_timeline_transform(
        app: AppHandle,
        state: State<'_, AppState>,
        offset_secs: f64,
        scale: f64,
    ) -> Result<(), String> {
        let tx = epilod_core::syncplay::TimelineTransform { offset_secs, scale }.sanitized();
        state.sync.set_timeline_transform(&app, tx);
        Ok(())
    }

    #[tauri::command]
    async fn sync_nudge_timeline_offset(
        state: State<'_, AppState>,
        delta_secs: f64,
    ) -> Result<(), String> {
        check_rate(&state, "sync_ctl", 40, Duration::from_secs(2))?;
        state.sync.nudge_timeline_offset(delta_secs);
        Ok(())
    }

    #[tauri::command]
    async fn sync_set_align_mode(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
        state.sync.set_align_mode(enabled);
        Ok(())
    }

    #[tauri::command]
    async fn sync_align_scene_here(
        state: State<'_, AppState>,
        local_pos_secs: Option<f64>,
    ) -> Result<epilod_core::syncplay::TimelineTransform, String> {
        state.sync.align_scene_here(local_pos_secs).await
    }

    #[tauri::command]
    async fn sync_run_p2p_auto_align(
        state: State<'_, AppState>,
        force: Option<bool>,
    ) -> Result<(), String> {
        check_rate(&state, "p2p_align", 6, Duration::from_secs(10))?;
        state.sync.trigger_p2p_realign(force.unwrap_or(true));
        Ok(())
    }

    #[tauri::command]
    async fn sync_send_reaction(
        state: State<'_, AppState>,
        emoji: String,
        avatar_id: Option<String>,
        count: Option<u8>,
    ) -> Result<(), String> {
        check_rate(&state, "sync_reaction", 80, Duration::from_secs(2))?;
        let clean_emoji = epilod_core::p2p::sanitize_reaction_emoji(&emoji)
            .ok_or_else(|| "Unsupported reaction emoji.".to_string())?;
        let clean_avatar = epilod_core::p2p::sanitize_avatar_id(avatar_id.as_deref().unwrap_or(""));
        let safe_count = count
            .unwrap_or(1)
            .clamp(1, epilod_core::p2p::MAX_REACTION_BURST_COUNT);
        state
            .sync
            .send_reaction(clean_emoji, clean_avatar, safe_count);
        Ok(())
    }

    #[tauri::command]
    async fn sync_send_chat(
        state: State<'_, AppState>,
        id: String,
        text: String,
        avatar_id: Option<String>,
        reply_to_id: Option<String>,
    ) -> Result<(), String> {
        check_rate(&state, "sync_chat", 20, Duration::from_secs(5))?;
        let clean_id = epilod_core::p2p::sanitize_chat_id(&id);
        if clean_id.is_empty() {
            return Err("Invalid chat message id.".to_string());
        }
        let clean_text = epilod_core::p2p::sanitize_chat_text(&text)
            .ok_or_else(|| "Chat message cannot be empty.".to_string())?;
        let clean_avatar = epilod_core::p2p::sanitize_avatar_id(avatar_id.as_deref().unwrap_or(""));
        let clean_reply = reply_to_id
            .as_deref()
            .map(epilod_core::p2p::sanitize_chat_id)
            .filter(|s| !s.is_empty());
        state
            .sync
            .send_chat(clean_id, clean_text, clean_avatar, clean_reply);
        Ok(())
    }

    #[tauri::command]
    async fn sync_send_chat_typing(
        state: State<'_, AppState>,
        is_typing: bool,
    ) -> Result<(), String> {
        check_rate(&state, "sync_chat_typing", 16, Duration::from_secs(5))?;
        state.sync.send_typing(is_typing);
        Ok(())
    }

    #[tauri::command]
    async fn sync_send_chat_edit(
        state: State<'_, AppState>,
        target_msg_id: String,
        text: String,
    ) -> Result<(), String> {
        check_rate(&state, "sync_chat_edit", 16, Duration::from_secs(5))?;
        let clean_id = epilod_core::p2p::sanitize_chat_id(&target_msg_id);
        if clean_id.is_empty() {
            return Err("Invalid chat message id.".to_string());
        }
        let clean_text = epilod_core::p2p::sanitize_chat_text(&text)
            .ok_or_else(|| "Edited message cannot be empty.".to_string())?;
        state.sync.send_chat_edit(clean_id, clean_text);
        Ok(())
    }

    #[tauri::command]
    async fn sync_send_chat_react(
        state: State<'_, AppState>,
        target_msg_id: String,
        emoji: String,
    ) -> Result<(), String> {
        check_rate(&state, "sync_chat_react", 30, Duration::from_secs(5))?;
        let clean_id = epilod_core::p2p::sanitize_chat_id(&target_msg_id);
        if clean_id.is_empty() {
            return Err("Invalid chat message id.".to_string());
        }
        let clean_emoji = epilod_core::p2p::sanitize_reaction_emoji(&emoji)
            .ok_or_else(|| "Unsupported reaction emoji.".to_string())?;
        state.sync.send_chat_react(clean_id, clean_emoji);
        Ok(())
    }

    #[tauri::command]
    async fn log_frontend_event(
        state: State<'_, AppState>,
        level: String,
        target: String,
        code: Option<String>,
        message: String,
    ) -> Result<(), String> {
        let lvl = match level.to_ascii_lowercase().as_str() {
            "error" => LogLevel::Error,
            "warn" => LogLevel::Warn,
            "debug" => LogLevel::Debug,
            _ => LogLevel::Info,
        };
        log_backend(&state, lvl, &target, code.as_deref(), &message);
        Ok(())
    }

    #[tauri::command]
    async fn get_logs_snapshot(
        state: State<'_, AppState>,
        limit: Option<usize>,
    ) -> Result<LogsSnapshot, String> {
        let guard = state
            .logger
            .lock()
            .map_err(|_| "Logger lock poisoned".to_string())?;
        Ok(guard.snapshot(limit.unwrap_or(150)))
    }

    #[tauri::command]
    async fn update_get_status(
        state: State<'_, AppState>,
    ) -> Result<crate::updater::AppUpdateStatusDto, String> {
        let updater = Arc::clone(&state.updater);
        tokio::task::spawn_blocking(move || crate::updater::get_app_update_status(&updater))
            .await
            .map_err(|e| format!("Failed checking cached update status: {e}"))
    }

    #[tauri::command]
    async fn update_check(
        state: State<'_, AppState>,
    ) -> Result<crate::updater::AppUpdateStatusDto, String> {
        let res = crate::updater::check_for_updates(&state.updater).await;
        if let Err(ref e) = res {
            log_backend(
                &state,
                LogLevel::Warn,
                "updater.check",
                Some("WARN_UPDATE_CHECK"),
                e,
            );
        }
        res
    }

    #[tauri::command]
    async fn update_download(
        app: AppHandle,
        state: State<'_, AppState>,
        manifest: Option<epilod_core::updater::ReleaseManifest>,
    ) -> Result<crate::updater::AppUpdateStatusDto, String> {
        crate::updater::download_update(app, &state.updater, manifest).await
    }

    #[tauri::command]
    async fn update_cancel_download(state: State<'_, AppState>) -> Result<(), String> {
        state.updater.cancel_download.store(true, Ordering::SeqCst);
        state.updater.cancel_notify.notify_waiters();
        Ok(())
    }

    #[tauri::command]
    async fn update_apply_and_restart(
        app: AppHandle,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        let apply_guard = state.updater.try_begin_apply()?;
        let cache_dir = crate::updater::update_cache_dir();
        let cache_clone = cache_dir.clone();
        let (setup_exe, install_dir, manifest, needs_elevation) =
            tokio::task::spawn_blocking(move || {
                crate::updater::prepare_verified_updater_launch(&cache_clone)
            })
            .await
            .map_err(|e| format!("Updater pre-launch verification failed: {e}"))??;

        log_backend(
            &state,
            LogLevel::Info,
            "updater.apply",
            None,
            &format!(
                "Launching verified updater v{} for {} (elevated={})",
                manifest.version,
                install_dir.display(),
                needs_elevation
            ),
        );

        if needs_elevation {
            let setup_clone = setup_exe.clone();
            let dir_clone = install_dir.clone();
            let cache_clone = cache_dir.clone();
            tokio::task::spawn_blocking(move || {
                crate::updater::spawn_elevated_updater(&setup_clone, &dir_clone, &cache_clone)
            })
            .await
            .map_err(|e| format!("Updater elevation task failed: {e}"))??;
        } else {
            let mut child = crate::updater::spawn_downloaded_updater(
                &setup_exe,
                &install_dir,
                &cache_dir,
                false,
            )?;
            tokio::time::sleep(Duration::from_millis(400)).await;
            if let Ok(Some(exit_status)) = child.try_wait() {
                if !exit_status.success() {
                    let mut silent_child = crate::updater::spawn_downloaded_updater(
                        &setup_exe,
                        &install_dir,
                        &cache_dir,
                        true,
                    )?;
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    if let Ok(Some(silent_status)) = silent_child.try_wait() {
                        if !silent_status.success() {
                            return Err(format!(
                                "Updater exited prematurely (code {:?}); please run the downloaded installer from {}.",
                                silent_status.code(),
                                cache_dir.display()
                            ));
                        }
                    }
                }
            }
        }

        state.autosync.cancel();
        state.intro_detect.cancel();
        state.voice.shutdown();
        state.mpv.stop_and_clear().await;
        state.sync.disconnect().await;

        apply_guard.disarm();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            app.exit(0);
        });
        Ok(())
    }

    #[tauri::command]
    async fn voice_list_devices(
        selected_input: Option<String>,
        selected_output: Option<String>,
    ) -> Result<VoiceDeviceListDto, String> {
        let sel_in = selected_input.unwrap_or_else(|| "default".to_string());
        let sel_out = selected_output.unwrap_or_else(|| "default".to_string());
        tokio::task::spawn_blocking(move || list_voice_devices(&sel_in, &sel_out))
            .await
            .map_err(|e| format!("Failed listing audio devices: {e}"))
    }

    #[tauri::command]
    async fn voice_set_config(
        app: AppHandle,
        state: State<'_, AppState>,
        config: VoiceConfigDto,
    ) -> Result<(), String> {
        state.voice.set_config(app, config);
        Ok(())
    }

    #[tauri::command]
    async fn voice_set_movie_playing(
        state: State<'_, AppState>,
        playing: bool,
    ) -> Result<(), String> {
        state.voice.set_movie_playing(playing);
        Ok(())
    }

    #[tauri::command]
    async fn voice_join(
        app: AppHandle,
        state: State<'_, AppState>,
        start_muted: Option<bool>,
    ) -> Result<(), String> {
        state.voice.join_voice(app, start_muted)
    }

    #[tauri::command]
    async fn voice_leave(state: State<'_, AppState>) -> Result<(), String> {
        state.voice.leave_voice();
        Ok(())
    }

    #[tauri::command]
    async fn voice_set_mute(state: State<'_, AppState>, muted: bool) -> Result<(), String> {
        state.voice.set_mute(muted);
        Ok(())
    }

    #[tauri::command]
    async fn voice_set_deafen(state: State<'_, AppState>, deafened: bool) -> Result<(), String> {
        state.voice.set_deafen(deafened);
        Ok(())
    }

    #[tauri::command]
    async fn voice_set_peer_volume(
        state: State<'_, AppState>,
        username: String,
        volume: f32,
        muted: bool,
    ) -> Result<(), String> {
        state.voice.set_peer_volume(&username, volume, muted);
        Ok(())
    }

    #[tauri::command]
    async fn voice_start_mic_monitor(
        app: AppHandle,
        state: State<'_, AppState>,
        loopback: bool,
    ) -> Result<(), String> {
        state.voice.start_mic_monitor(app, loopback);
        Ok(())
    }

    #[tauri::command]
    async fn voice_stop_mic_monitor(state: State<'_, AppState>) -> Result<(), String> {
        state.voice.stop_mic_monitor();
        Ok(())
    }

    #[tauri::command]
    async fn voice_get_diagnostics(
        state: State<'_, AppState>,
    ) -> Result<VoiceDiagnosticsDto, String> {
        Ok(state.voice.diagnostics())
    }

    #[tauri::command]
    async fn voice_start_calibration(
        app: AppHandle,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        state.voice.start_calibration(app);
        Ok(())
    }

    #[tauri::command]
    async fn voice_get_report(
        app: AppHandle,
        state: State<'_, AppState>,
    ) -> Result<String, String> {
        let entries = state
            .logger
            .lock()
            .map(|g| g.snapshot(400).entries)
            .unwrap_or_default();
        let ver = app.package_info().version.to_string();
        Ok(state.voice.build_voice_report(&ver, &entries))
    }

    #[tauri::command]
    async fn consume_pending_deep_link(
        state: State<'_, AppState>,
    ) -> Result<Option<DeepLinkInvite>, String> {
        let mut guard = state
            .pending_deep_link
            .lock()
            .map_err(|_| "Deep link lock poisoned".to_string())?;
        Ok(guard.take())
    }

    #[tauri::command]
    async fn probe_pinned_rooms(
        state: State<'_, AppState>,
        rooms: Vec<ProbeRoomRequest>,
    ) -> Result<Vec<RoomOccupancyDto>, String> {
        check_rate(&state, "probe_pinned_rooms", 4, Duration::from_secs(20))?;
        Ok(probe_pinned_rooms_impl(rooms).await)
    }

    #[tauri::command]
    async fn find_local_media_matches(
        app: AppHandle,
        state: State<'_, AppState>,
        request: FindLocalMatchesRequest,
    ) -> Result<Vec<LocalMatchCandidate>, String> {
        check_rate(
            &state,
            "find_local_media_matches",
            12,
            Duration::from_secs(10),
        )?;
        let opts = state.network_policy.options();
        Ok(state.media_library.find_matches(&app, request, opts).await)
    }

    #[tauri::command]
    async fn check_local_files_exist(
        state: State<'_, AppState>,
        paths: Vec<String>,
    ) -> Result<Vec<bool>, String> {
        let opts = state.network_policy.options();
        tokio::task::spawn_blocking(move || check_local_files_exist_impl(&paths, opts))
            .await
            .map_err(|e| format!("Failed checking file existence: {e}"))
    }

    #[tauri::command]
    async fn dpapi_protect_secret(plaintext: String) -> Result<String, String> {
        tokio::task::spawn_blocking(move || dpapi_protect_impl(&plaintext))
            .await
            .map_err(|e| format!("Failed protecting secret: {e}"))?
    }

    #[tauri::command]
    async fn dpapi_unprotect_secret(encoded: String) -> Result<String, String> {
        tokio::task::spawn_blocking(move || dpapi_unprotect_impl(&encoded))
            .await
            .map_err(|e| format!("Failed restoring secret: {e}"))?
    }

    fn extract_startup_deep_link() -> Option<DeepLinkInvite> {
        std::env::args()
            .skip(1)
            .find_map(|arg| parse_invite_link(&arg))
    }

    fn try_forward_deep_link_to_running_instance(invite: &DeepLinkInvite) -> bool {
        use std::io::Write;
        for _ in 0..4 {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(DEEP_LINK_PIPE_NAME)
            {
                let payload = format!("{}\n", invite.uri);
                if file.write_all(payload.as_bytes()).is_ok() && file.flush().is_ok() {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(75));
        }
        false
    }

    fn ensure_epilod_protocol_registered() {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
            REG_OPTION_NON_VOLATILE, REG_SZ,
        };

        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let norm = exe
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if norm.contains("/target/debug/") || norm.contains("/target/release/") {
            // Do not overwrite user's installed protocol handler during local cargo runs.
            return;
        }

        fn wide(s: &str) -> Vec<u16> {
            OsStr::new(s)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }
        unsafe fn set_sz(hkey: HKEY, name: &str, val: &str) {
            let wname = wide(name);
            let wval = wide(val);
            let name_ptr = if name.is_empty() {
                std::ptr::null()
            } else {
                wname.as_ptr()
            };
            let _ = RegSetValueExW(
                hkey,
                name_ptr,
                0,
                REG_SZ,
                wval.as_ptr() as *const u8,
                (wval.len() * 2) as u32,
            );
        }

        unsafe {
            let subkey = wide(r"Software\Classes\epilod");
            let mut hkey: HKEY = std::ptr::null_mut();
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                0,
                std::ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                std::ptr::null(),
                &mut hkey,
                std::ptr::null_mut(),
            ) == 0
            {
                set_sz(hkey, "", "URL:Epilod Party Protocol");
                set_sz(hkey, "URL Protocol", "");
                RegCloseKey(hkey);
            }

            let icon_key = wide(r"Software\Classes\epilod\DefaultIcon");
            let mut hicon: HKEY = std::ptr::null_mut();
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                icon_key.as_ptr(),
                0,
                std::ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                std::ptr::null(),
                &mut hicon,
                std::ptr::null_mut(),
            ) == 0
            {
                set_sz(hicon, "", &format!("\"{}\",0", exe.display()));
                RegCloseKey(hicon);
            }

            let cmd_key = wide(r"Software\Classes\epilod\shell\open\command");
            let mut hcmd: HKEY = std::ptr::null_mut();
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                cmd_key.as_ptr(),
                0,
                std::ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                std::ptr::null(),
                &mut hcmd,
                std::ptr::null_mut(),
            ) == 0
            {
                set_sz(hcmd, "", &format!("\"{}\" \"%1\"", exe.display()));
                RegCloseKey(hcmd);
            }
        }
    }

    fn spawn_deep_link_pipe_listener(app: AppHandle) {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
        use tokio::net::windows::named_pipe::ServerOptions;

        tauri::async_runtime::spawn(async move {
            let mut first = true;
            loop {
                let mut opts = ServerOptions::new();
                if first {
                    opts.first_pipe_instance(true);
                    first = false;
                }
                let Ok(server) = opts.create(DEEP_LINK_PIPE_NAME) else {
                    break;
                };
                if server.connect().await.is_err() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    let mut reader = BufReader::new(server.take(2048));
                    let mut line = String::new();
                    if let Ok(Ok(n)) = tokio::time::timeout(
                        Duration::from_millis(500),
                        reader.read_line(&mut line),
                    )
                    .await
                    {
                        if n > 0 {
                            if let Some(invite) = parse_invite_link(&line) {
                                if let Some(state) = app_clone.try_state::<AppState>() {
                                    if let Ok(mut guard) = state.pending_deep_link.lock() {
                                        *guard = Some(invite.clone());
                                    }
                                }
                                if let Some(win) = app_clone.get_webview_window("main") {
                                    let _ = win.unminimize();
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                                let _ = app_clone.emit("app://deep-link", invite);
                            }
                        }
                    }
                });
            }
        });
    }

    pub fn run() {
        let initial_deep_link = extract_startup_deep_link();
        if let Some(ref invite) = initial_deep_link {
            if try_forward_deep_link_to_running_instance(invite) {
                return;
            }
        }
        ensure_epilod_protocol_registered();
        crate::updater::spawn_startup_cache_cleanup();

        let log_path: Option<PathBuf> = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("EpilodParty").join("logs").join("epilod-party.log"));

        let logger = Arc::new(Mutex::new(RingLogger::new_async(log_path, 512 * 1024)));
        let logger_for_panic = Arc::clone(&logger);
        let prev_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let thread_name = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let msg = format!("PANIC on thread '{thread_name}': {info}");
            if let Ok(mut lg) = logger_for_panic.lock() {
                lg.log(
                    LogLevel::Error,
                    "rust.panic",
                    Some("ERR_PANIC"),
                    &msg,
                    SystemTime::now(),
                    Instant::now(),
                );
            }
            prev_hook(info);
        }));

        let watchdog_stop = Arc::new(AtomicBool::new(false));
        let watchdog_stop_for_event = Arc::clone(&watchdog_stop);
        let transitions = Arc::new(WindowTransitionTracker::default());
        let transitions_for_event = Arc::clone(&transitions);
        let logger_for_watchdog = Arc::clone(&logger);

        let mpv = Arc::new(MpvController::new());
        let voice = Arc::new(VoiceController::new(Arc::clone(&mpv)));
        let sync = Arc::new(SyncController::new());
        sync.set_voice_controller(Arc::clone(&voice));
        let voice_for_destroy = Arc::clone(&voice);
        let sync_for_destroy = Arc::clone(&sync);

        let app_state = AppState {
            mpv,
            sync,
            voice,
            autosync: Arc::new(AutoSyncController::new()),
            intro_detect: Arc::new(IntroDetectController::new()),
            media_library: Arc::new(MediaLibraryState::default()),
            pending_deep_link: Arc::new(Mutex::new(initial_deep_link)),
            logger,
            rate_guard: Arc::new(Mutex::new(CommandRateGuard::new())),
            network_policy: Arc::new(NetworkSharePolicy::new(false)),
            updater: Arc::new(crate::updater::UpdaterState::new()),
        };

        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        use tauri_plugin_global_shortcut::{Code, ShortcutState};
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        let action = match shortcut.key {
                            Code::Space => "toggle-play",
                            Code::ArrowLeft => "seek-back",
                            Code::ArrowRight => "seek-forward",
                            _ => return,
                        };
                        let _ = app.emit("app://global-shortcut", action);
                    })
                    .build(),
            )
            .manage(app_state)
            .on_window_event(move |window, event| match event {
                tauri::WindowEvent::Resized(size) => {
                    if let Some(state) = window.try_state::<AppState>() {
                        state.mpv.resize_for_window_size(size.width, size.height);
                    }
                    if let Ok(fs) = window.is_fullscreen() {
                        if let Some(changed) = transitions_for_event.on_fullscreen_sample(fs) {
                            let _ = window.emit(
                                "window://fullscreen",
                                serde_json::json!({ "fullscreen": changed }),
                            );
                        }
                    }
                    if transitions_for_event.on_resize(size.width, size.height) {
                        let _ = window.emit("window://restored", ());
                    }
                }
                tauri::WindowEvent::Focused(true) => {
                    if let Ok(fs) = window.is_fullscreen() {
                        if let Some(changed) = transitions_for_event.on_fullscreen_sample(fs) {
                            let _ = window.emit(
                                "window://fullscreen",
                                serde_json::json!({ "fullscreen": changed }),
                            );
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    watchdog_stop_for_event.store(true, Ordering::Release);
                    voice_for_destroy.shutdown();
                    let sync_shutdown = Arc::clone(&sync_for_destroy);
                    tauri::async_runtime::spawn(async move {
                        sync_shutdown.disconnect().await;
                    });
                }
                _ => {}
            })
            .setup(move |app| {
                if let Some(win) = app.get_webview_window("main") {
                    let url_str = win.url().map(|u| u.to_string()).unwrap_or_default();
                    if !url_str.is_empty()
                        && url_str != "about:blank"
                        && !is_allowed_webview_url(&url_str)
                    {
                        return Err(format!("Blocked unexpected WebView origin: {url_str}").into());
                    }
                    let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                }

                spawn_deep_link_pipe_listener(app.handle().clone());

                // Lightweight UI-thread heartbeat watchdog: detects and logs main-thread stalls.
                let app_handle = app.handle().clone();
                let stop_flag = Arc::clone(&watchdog_stop);
                let wd_logger = Arc::clone(&logger_for_watchdog);
                let _ = std::thread::Builder::new()
                    .name("epilod-ui-watchdog".to_string())
                    .spawn(move || {
                        while !stop_flag.load(Ordering::Acquire) {
                            std::thread::sleep(Duration::from_secs(2));
                            if stop_flag.load(Ordering::Acquire) {
                                break;
                            }
                            let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
                            let sent_at = Instant::now();
                            if app_handle
                                .run_on_main_thread(move || {
                                    let _ = tx.send(());
                                })
                                .is_err()
                            {
                                break;
                            }
                            match rx.recv_timeout(Duration::from_secs(5)) {
                                Ok(()) => {
                                    let rtt = sent_at.elapsed();
                                    if rtt >= Duration::from_millis(400) {
                                        let lvl = if rtt >= Duration::from_secs(2) {
                                            LogLevel::Error
                                        } else {
                                            LogLevel::Warn
                                        };
                                        if let Ok(mut lg) = wd_logger.lock() {
                                            lg.log(
                                                lvl,
                                                "ui.watchdog",
                                                Some("WARN_UI_STALL"),
                                                &format!(
                                                    "Main UI thread stalled for {} ms",
                                                    rtt.as_millis()
                                                ),
                                                SystemTime::now(),
                                                Instant::now(),
                                            );
                                        }
                                    }
                                }
                                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                    if !stop_flag.load(Ordering::Acquire) {
                                        if let Ok(mut lg) = wd_logger.lock() {
                                            lg.log(
                                                LogLevel::Error,
                                                "ui.watchdog",
                                                Some("ERR_UI_HANG"),
                                                "Main UI thread unresponsive for >5000 ms",
                                                SystemTime::now(),
                                                Instant::now(),
                                            );
                                        }
                                    }
                                }
                                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                            }
                        }
                    });
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                mpv_start,
                mpv_resize,
                mpv_set_visible,
                mpv_get_surface_state,
                mpv_backdrop_frame,
                mpv_capture_freeze_frame,
                mpv_load,
                mpv_set_pause,
                mpv_seek,
                mpv_stop,
                mpv_set_volume,
                mpv_set_mute,
                mpv_set_speed,
                mpv_set_loop,
                mpv_set_aspect_mode,
                mpv_set_video_margin_right,
                mpv_add_subtitle,
                mpv_remove_subtitle,
                mpv_set_sub_style,
                mpv_set_sub_delay,
                mpv_set_audio_track,
                mpv_set_sub_track,
                mpv_set_secondary_sub_track,
                mpv_set_secondary_sub_delay,
                mpv_show_osd_text,
                subtitle_auto_sync,
                subtitle_two_anchor_sync,
                subtitle_cancel_auto_sync,
                subtitle_search_online,
                subtitle_download_online,
                subtitle_auto_fetch_online,
                detect_embedded_subtitle_languages,
                detect_video_intro,
                intro_cancel_detect,
                window_set_fullscreen,
                window_is_fullscreen,
                window_drag_from_maximized,
                set_allow_network_shares,
                sync_connect,
                sync_reconnect,
                sync_force_resync,
                sync_set_room_admin,
                sync_disconnect,
                sync_switch_backup,
                sync_set_file,
                sync_set_ready,
                sync_user_play,
                sync_user_pause,
                sync_user_seek,
                sync_set_scrubbing,
                sync_set_timeline_transform,
                sync_nudge_timeline_offset,
                sync_set_align_mode,
                sync_align_scene_here,
                sync_run_p2p_auto_align,
                sync_send_reaction,
                sync_send_chat,
                sync_send_chat_edit,
                sync_send_chat_react,
                sync_send_chat_typing,
                scan_media_paths,
                consume_pending_deep_link,
                probe_pinned_rooms,
                find_local_media_matches,
                check_local_files_exist,
                dpapi_protect_secret,
                dpapi_unprotect_secret,
                set_global_shortcuts_enabled,
                log_frontend_event,
                get_logs_snapshot,
                update_get_status,
                update_check,
                update_download,
                update_cancel_download,
                update_apply_and_restart,
                voice_list_devices,
                voice_set_config,
                voice_set_movie_playing,
                voice_join,
                voice_leave,
                voice_set_mute,
                voice_set_deafen,
                voice_set_peer_volume,
                voice_start_mic_monitor,
                voice_stop_mic_monitor,
                voice_get_diagnostics,
                voice_start_calibration,
                voice_get_report,
            ])
            .run(tauri::generate_context!())
            .expect("error while running Epilod Party");
    }
}

#[cfg(windows)]
pub use windows_app::run;

#[cfg(not(windows))]
pub fn run() {
    eprintln!("Epilod Party desktop shell targets Windows 10/11.");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn test_network_share_policy_defaults_off_and_toggles() {
        let policy = NetworkSharePolicy::default();
        assert!(!policy.options().allow_network_shares);
        policy.set(true);
        assert!(policy.options().allow_network_shares);
        policy.set(false);
        assert!(!policy.options().allow_network_shares);
    }

    #[test]
    fn test_zero_viewport_detection() {
        assert!(is_zero_viewport(0, 0));
        assert!(is_zero_viewport(1280, 0));
        assert!(is_zero_viewport(0, 720));
        assert!(!is_zero_viewport(1280, 720));
    }

    #[test]
    fn test_sync_connect_rate_limit_exempts_distinct_rooms_and_backup_switch() {
        let mut guard = CommandRateGuard::new();
        let t0 = Instant::now();
        for i in 0..6 {
            assert!(check_sync_connect_allowed(
                &mut guard,
                "syncplay.pl:8999",
                "AAAA-BBBB-CCCC",
                false,
                t0 + Duration::from_millis(i * 100),
            ));
        }
        // 7th rapid connect to same endpoint+room is throttled
        assert!(!check_sync_connect_allowed(
            &mut guard,
            "syncplay.pl:8999",
            "AAAA-BBBB-CCCC",
            false,
            t0 + Duration::from_millis(700),
        ));
        // Switching to a different room or backup server works immediately
        assert!(check_sync_connect_allowed(
            &mut guard,
            "syncplay.pl:8999",
            "DDDD-EEEE-FFFF",
            false,
            t0 + Duration::from_millis(750),
        ));
        assert!(check_sync_connect_allowed(
            &mut guard,
            "syncplay.pl:8998",
            "AAAA-BBBB-CCCC",
            true,
            t0 + Duration::from_millis(800),
        ));
    }

    #[test]
    fn test_resolve_update_target_dir_prefers_portable_or_installed_dir_and_skips_cargo_target() {
        let uniq = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("epilod-upd-dir-{uniq}"));
        let portable_dir = root.join("CustomPortable");
        let cargo_release = root.join("target").join("release");
        let reg_dir = root.join("RegistryInstall");
        let default_dir = root.join("DefaultLocalAppData");

        fs::create_dir_all(&portable_dir).unwrap();
        fs::create_dir_all(&cargo_release).unwrap();
        fs::write(portable_dir.join("epilod-install-manifest.json"), "{}").unwrap();
        fs::write(cargo_release.join("epilod-party.exe"), "dev").unwrap();

        // Installed / portable directory with manifest wins over registry & default
        assert_eq!(
            resolve_update_target_dir(Some(&portable_dir), Some(&reg_dir), &default_dir),
            portable_dir
        );

        // Cargo build directory is ignored so updates target registry install folder
        assert_eq!(
            resolve_update_target_dir(Some(&cargo_release), Some(&reg_dir), &default_dir),
            reg_dir
        );

        // Falls back cleanly to default dir when neither exe_dir nor registry applies
        assert_eq!(
            resolve_update_target_dir(None, None, &default_dir),
            default_dir
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_window_transition_tracker_filters_redundant_events() {
        let tracker = WindowTransitionTracker::default();
        // Normal resizes do not trigger restore
        assert!(!tracker.on_resize(1360, 820));
        assert!(!tracker.on_resize(1400, 850));
        // Minimizing to 0x0 records minimized state without firing restore
        assert!(!tracker.on_resize(0, 0));
        // Restoring from 0x0 fires restore exactly once
        assert!(tracker.on_resize(1360, 820));
        assert!(!tracker.on_resize(1360, 820));

        // Fullscreen only emits on state transitions
        assert_eq!(tracker.on_fullscreen_sample(false), None);
        assert_eq!(tracker.on_fullscreen_sample(true), Some(true));
        assert_eq!(tracker.on_fullscreen_sample(true), None);
        assert_eq!(tracker.on_fullscreen_sample(false), Some(false));
    }

    #[test]
    fn test_compute_drag_restore_bounds_anchors_cursor_and_shrinks_full_normal_rect() {
        let mid = compute_drag_restore_bounds(
            960,
            18,
            (0, 0, 1920, 1032),
            (0, 0, 1920, 1032),
            (1360, 820),
            (1024, 640),
        );
        assert_eq!(mid.width, 1360);
        assert_eq!(mid.height, 820);
        assert_eq!(mid.x, 960 - 680);
        assert_eq!(mid.y, 0);

        // When saved normal rect covers the whole monitor, shrink smoothly below screen bounds.
        let shrunk = compute_drag_restore_bounds(
            1800,
            24,
            (0, 0, 1920, 1040),
            (0, 0, 1920, 1040),
            (1920, 1040),
            (1024, 640),
        );
        assert!(shrunk.width < 1920 && shrunk.width >= 1024);
        assert!(shrunk.height < 1040 && shrunk.height >= 640);
        assert!(shrunk.x + shrunk.width >= 1800);
        assert!(shrunk.y >= 0);
    }
}
