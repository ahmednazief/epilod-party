pub mod autosync;

#[cfg(windows)]
pub mod mpv;
#[cfg(windows)]
pub mod syncplay;

use epilod_core::rate_limit::CommandRateGuard;
use epilod_core::validation::LocalPathOptions;
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

#[cfg(windows)]
mod windows_app {
    use super::*;
    use crate::autosync::{
        execute_auto_sync, execute_two_anchor_sync, AutoSyncController, AutoSyncResultDto,
    };
    use crate::mpv::hwnd::PhysicalRect;
    use crate::mpv::MpvController;
    use crate::syncplay::{LocalFileMeta, SyncCommand, SyncController};
    use epilod_core::logging::{LogLevel, LogsSnapshot, RingLogger};
    use epilod_core::mpv_ipc::{
        loadfile_cmd, seek_absolute_cmd, set_aid_cmd, set_aspect_cmd, set_loop_cmd, set_mute_cmd,
        set_pause_cmd, set_sid_cmd, set_speed_cmd, set_sub_delay_cmd, set_sub_style_cmds,
        set_volume_cmd, sub_add_cmd,
    };
    use epilod_core::room_code::BACKUP_ENDPOINT;
    use epilod_core::subtitle_sync::{decode_subtitle_bytes_with_hint, SubtitleEncodingHint};
    use epilod_core::validation::{
        is_allowed_webview_url, sanitize_aspect_mode, sanitize_hex_color, sanitize_playback_speed,
        sanitize_username, validate_existing_local_file_with_options,
    };
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::SystemTime;
    use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

    pub struct AppState {
        pub mpv: Arc<MpvController>,
        pub sync: Arc<SyncController>,
        pub autosync: Arc<AutoSyncController>,
        pub logger: Arc<Mutex<RingLogger>>,
        pub rate_guard: Arc<Mutex<CommandRateGuard>>,
        pub network_policy: Arc<NetworkSharePolicy>,
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
        state.mpv.start(&app, hwnd, rect).map_err(|e| {
            log_backend(
                &state,
                LogLevel::Error,
                "mpv.start",
                Some("ERR_MPV_START"),
                &e,
            );
            e
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
    async fn mpv_load(state: State<'_, AppState>, path: String) -> Result<(), String> {
        let opts = state.network_policy.options();
        let valid_path =
            validate_existing_local_file_with_options(&path, opts).map_err(|e| e.to_string())?;
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

        let req = state.mpv.next_request_id();
        if let Err(e) = state.mpv.send_command(loadfile_cmd(req, &path_str)) {
            if let Ok(mut rg) = state.rate_guard.lock() {
                rg.clear_dedup_if_matches("mpv_load", &path_str);
            }
            return Err(e);
        }
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
        check_rate(&state, "mpv_ctl", 30, Duration::from_secs(2))?;
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_pause_cmd(req, paused))
    }

    #[tauri::command]
    async fn mpv_seek(state: State<'_, AppState>, seconds: f64) -> Result<(), String> {
        check_rate(&state, "mpv_ctl", 30, Duration::from_secs(2))?;
        let req = state.mpv.next_request_id();
        state.mpv.send_command(seek_absolute_cmd(req, seconds))
    }

    #[tauri::command]
    async fn mpv_stop(state: State<'_, AppState>) -> Result<(), String> {
        state.autosync.cancel();
        state.mpv.stop_and_clear().await;
        Ok(())
    }

    #[tauri::command]
    async fn mpv_set_volume(state: State<'_, AppState>, volume: f64) -> Result<(), String> {
        check_rate(&state, "mpv_ctl", 40, Duration::from_secs(2))?;
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_volume_cmd(req, volume))
    }

    #[tauri::command]
    async fn mpv_set_mute(state: State<'_, AppState>, muted: bool) -> Result<(), String> {
        check_rate(&state, "mpv_ctl", 30, Duration::from_secs(2))?;
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
    async fn mpv_add_subtitle(
        state: State<'_, AppState>,
        path: String,
        encoding_hint: Option<SubtitleEncodingHint>,
    ) -> Result<(), String> {
        let opts = state.network_policy.options();
        let valid =
            validate_existing_local_file_with_options(&path, opts).map_err(|e| e.to_string())?;
        let hint = encoding_hint.unwrap_or_default();

        // Fix 25: Convert legacy non-UTF8 or explicit-hint subtitle files to clean UTF-8 temp file for libass.
        let load_path = match std::fs::read(&valid) {
            Ok(bytes) => {
                let needs_transcode =
                    hint != SubtitleEncodingHint::Auto || std::str::from_utf8(&bytes).is_err();
                if needs_transcode {
                    let decoded =
                        decode_subtitle_bytes_with_hint(&bytes, hint).map_err(|e| e.to_string())?;
                    let sub_dir = std::env::temp_dir().join("epilod-subs");
                    std::fs::create_dir_all(&sub_dir)
                        .map_err(|e| format!("Failed creating temp subtitle dir: {e}"))?;
                    let ext = valid.extension().and_then(|e| e.to_str()).unwrap_or("srt");
                    let out = sub_dir.join(format!("decoded.{ext}"));
                    std::fs::write(&out, decoded.as_bytes())
                        .map_err(|e| format!("Failed writing decoded UTF-8 subtitle: {e}"))?;
                    out.to_string_lossy().into_owned()
                } else {
                    valid.to_string_lossy().into_owned()
                }
            }
            Err(_) => valid.to_string_lossy().into_owned(),
        };

        let req = state.mpv.next_request_id();
        state.mpv.send_command(sub_add_cmd(req, &load_path))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    async fn mpv_set_sub_style(
        state: State<'_, AppState>,
        font: String,
        font_size: u32,
        color: String,
        border_size: f64,
        pos: u32,
        visible: bool,
        override_ass: Option<bool>,
    ) -> Result<(), String> {
        let safe_color = sanitize_hex_color(&color).map_err(|e| e.to_string())?;
        let first_id = state.mpv.next_request_id();
        let cmds = set_sub_style_cmds(
            first_id,
            font.trim(),
            font_size,
            &safe_color,
            border_size,
            pos,
            visible,
            override_ass.unwrap_or(false),
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
    async fn mpv_set_sub_track(state: State<'_, AppState>, sid: Option<u64>) -> Result<(), String> {
        let req = state.mpv.next_request_id();
        state.mpv.send_command(set_sid_cmd(req, sid))
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
            embedded_sub_codec.as_deref(),
            encoding_hint.unwrap_or_default(),
            low_power.unwrap_or(false),
            opts,
        )
        .await
    }

    #[tauri::command]
    async fn subtitle_two_anchor_sync(
        state: State<'_, AppState>,
        subtitle_path: String,
        src_a_secs: f64,
        dst_a_secs: f64,
        src_b_secs: f64,
        dst_b_secs: f64,
        encoding_hint: Option<SubtitleEncodingHint>,
    ) -> Result<AutoSyncResultDto, String> {
        let opts = state.network_policy.options();
        execute_two_anchor_sync(
            &subtitle_path,
            src_a_secs,
            dst_a_secs,
            src_b_secs,
            dst_b_secs,
            encoding_hint.unwrap_or_default(),
            opts,
        )
    }

    #[tauri::command]
    async fn subtitle_cancel_auto_sync(state: State<'_, AppState>) -> Result<(), String> {
        state.autosync.cancel();
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
    async fn set_allow_network_shares(
        state: State<'_, AppState>,
        allow: bool,
    ) -> Result<(), String> {
        state.network_policy.set(allow);
        Ok(())
    }

    #[tauri::command]
    async fn sync_connect(
        app: AppHandle,
        state: State<'_, AppState>,
        endpoint: String,
        username: String,
        room_code: String,
        literal_room: Option<bool>,
        password: Option<String>,
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
            )
            .await
    }

    #[tauri::command]
    async fn sync_reconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
        state.sync.reconnect(app, Arc::clone(&state.mpv)).await
    }

    #[tauri::command]
    async fn sync_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
        state.sync.disconnect().await;
        let _ = app.emit(
            "sync://status",
            serde_json::json!({ "state": "disconnected" }),
        );
        let _ = app.emit("sync://participants", Vec::<serde_json::Value>::new());
        Ok(())
    }

    #[tauri::command]
    async fn sync_switch_backup(
        app: AppHandle,
        state: State<'_, AppState>,
        username: String,
        room_code: String,
        literal_room: Option<bool>,
        password: Option<String>,
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
    ) -> Result<(), String> {
        let resolved_size = size_bytes.or_else(|| {
            path.as_deref()
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| m.len())
        });
        state.sync.set_local_file(Some(LocalFileMeta {
            name,
            size_bytes: resolved_size,
            duration_secs,
            hash_identity: true,
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

    pub fn run() {
        let log_path: Option<PathBuf> = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("EpilodParty").join("logs").join("epilod-party.log"));

        let app_state = AppState {
            mpv: Arc::new(MpvController::new()),
            sync: Arc::new(SyncController::new()),
            autosync: Arc::new(AutoSyncController::new()),
            logger: Arc::new(Mutex::new(RingLogger::new(log_path, 512 * 1024))),
            rate_guard: Arc::new(Mutex::new(CommandRateGuard::new())),
            network_policy: Arc::new(NetworkSharePolicy::new(false)),
        };

        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(app_state)
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true) = event {
                    if let Ok(fs) = window.is_fullscreen() {
                        let _ = window.emit(
                            "window://fullscreen",
                            serde_json::json!({ "fullscreen": fs }),
                        );
                    }
                    let _ = window.emit("window://restored", ());
                }
            })
            .setup(|app| {
                if let Some(win) = app.get_webview_window("main") {
                    let url_str = win.url().map(|u| u.to_string()).unwrap_or_default();
                    if !url_str.is_empty() && !is_allowed_webview_url(&url_str) {
                        return Err(format!("Blocked unexpected WebView origin: {url_str}").into());
                    }
                }
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                mpv_start,
                mpv_resize,
                mpv_set_visible,
                mpv_load,
                mpv_set_pause,
                mpv_seek,
                mpv_stop,
                mpv_set_volume,
                mpv_set_mute,
                mpv_set_speed,
                mpv_set_loop,
                mpv_set_aspect_mode,
                mpv_add_subtitle,
                mpv_set_sub_style,
                mpv_set_sub_delay,
                mpv_set_audio_track,
                mpv_set_sub_track,
                subtitle_auto_sync,
                subtitle_two_anchor_sync,
                subtitle_cancel_auto_sync,
                window_set_fullscreen,
                window_is_fullscreen,
                set_allow_network_shares,
                sync_connect,
                sync_reconnect,
                sync_disconnect,
                sync_switch_backup,
                sync_set_file,
                sync_set_ready,
                sync_user_play,
                sync_user_pause,
                sync_user_seek,
                log_frontend_event,
                get_logs_snapshot,
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
}
