#![cfg(windows)]

pub mod hwnd;
pub mod ipc;
pub mod process;

use epilod_core::mpv_ipc::{
    screenshot_to_file_cmd, seek_absolute_cmd, seek_keyframes_cmd, PendingSeekTracker,
};
use epilod_core::syncplay::PlayerSnapshot;
use hwnd::{
    apply_child_hwnd_size, capture_child_backdrop_rgba, create_child_hwnd, destroy_child_hwnd,
    is_child_window_alive, mark_child_closing_and_hide, nudge_child_hwnd_redraw, resize_child_hwnd,
    set_child_visible, PendingResize, PhysicalRect,
};
use ipc::PendingReplyMap;
use process::{resolve_fonts_dir, resolve_mpv_exe, spawn_mpv};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

static MPV_PIPE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSurfaceState {
    pub running: bool,
    pub has_media: bool,
    pub ui_visible: bool,
    pub surface_visible: bool,
}

pub struct MpvRuntime {
    pub session_id: u64,
    pub app: AppHandle,
    pub parent_hwnd: isize,
    pub hwnd: isize,
    pub child: Child,
    pub tx: mpsc::Sender<String>,
    pub last_rect: Option<PhysicalRect>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct DeferredLoadState {
    pub loading: bool,
    pub seek_secs: Option<f64>,
    pub pause: Option<bool>,
}

type VolumeReassertCallback = Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>;

pub struct MpvController {
    runtime: Arc<Mutex<Option<MpvRuntime>>>,
    snapshot: Arc<Mutex<PlayerSnapshot>>,
    loading_media: Arc<AtomicBool>,
    deferred_load: Arc<Mutex<DeferredLoadState>>,
    pending_seek: Arc<Mutex<PendingSeekTracker>>,
    pending_replies: PendingReplyMap,
    client_seek_seq: Arc<AtomicU64>,
    pending_resize: Arc<PendingResize>,
    lifecycle_lock: AsyncMutex<()>,
    next_req_id: AtomicU64,
    next_session_id: AtomicU64,
    shutting_down: Arc<AtomicBool>,
    has_media: Arc<AtomicBool>,
    ui_visible: Arc<AtomicBool>,
    last_app: Arc<Mutex<Option<AppHandle>>>,
    capture_busy: Arc<AtomicBool>,
    freeze_capture_busy: Arc<AtomicBool>,
    vo_nudge_pending: Arc<AtomicBool>,
    vo_nudge_in_flight: Arc<AtomicBool>,
    volume_reassert_cb: VolumeReassertCallback,
}

impl Default for MpvController {
    fn default() -> Self {
        Self::new()
    }
}

impl MpvController {
    pub fn new() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(None)),
            snapshot: Arc::new(Mutex::new(PlayerSnapshot::default())),
            loading_media: Arc::new(AtomicBool::new(false)),
            deferred_load: Arc::new(Mutex::new(DeferredLoadState::default())),
            pending_seek: Arc::new(Mutex::new(PendingSeekTracker::new())),
            pending_replies: Arc::new(Mutex::new(HashMap::new())),
            client_seek_seq: Arc::new(AtomicU64::new(0)),
            pending_resize: Arc::new(PendingResize::default()),
            lifecycle_lock: AsyncMutex::new(()),
            next_req_id: AtomicU64::new(100),
            next_session_id: AtomicU64::new(1),
            shutting_down: Arc::new(AtomicBool::new(false)),
            has_media: Arc::new(AtomicBool::new(false)),
            ui_visible: Arc::new(AtomicBool::new(true)),
            last_app: Arc::new(Mutex::new(None)),
            capture_busy: Arc::new(AtomicBool::new(false)),
            freeze_capture_busy: Arc::new(AtomicBool::new(false)),
            vo_nudge_pending: Arc::new(AtomicBool::new(false)),
            vo_nudge_in_flight: Arc::new(AtomicBool::new(false)),
            volume_reassert_cb: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_volume_reassert_callback(&self, cb: Arc<dyn Fn() + Send + Sync>) {
        *self
            .volume_reassert_cb
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(cb);
    }

    pub fn surface_state(&self) -> MpvSurfaceState {
        let mut guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let running = match guard.as_mut() {
            Some(rt) => {
                let exited = matches!(rt.child.try_wait(), Ok(Some(_)));
                !exited
                    && !self.shutting_down.load(Ordering::SeqCst)
                    && is_child_window_alive(rt.hwnd)
            }
            None => false,
        };
        drop(guard);
        let has_media = running && self.has_media.load(Ordering::SeqCst);
        let ui_visible = self.ui_visible.load(Ordering::SeqCst);
        MpvSurfaceState {
            running,
            has_media,
            ui_visible,
            surface_visible: running && has_media && ui_visible,
        }
    }

    fn emit_surface_state_with(&self, app: &AppHandle) {
        let state = self.surface_state();
        let _ = app.emit("mpv://surface-state", state);
    }

    fn emit_surface_state_best_effort(&self) {
        let app = self
            .last_app
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(app_handle) = app {
            self.emit_surface_state_with(&app_handle);
        }
    }

    pub fn next_request_id(&self) -> u64 {
        self.next_req_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        *self.snapshot.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn prepare_for_load(&self) {
        self.vo_nudge_pending.store(true, Ordering::SeqCst);
        {
            let mut def = self.deferred_load.lock().unwrap_or_else(|e| e.into_inner());
            *def = DeferredLoadState {
                loading: true,
                seek_secs: None,
                pause: None,
            };
            self.loading_media.store(true, Ordering::SeqCst);
        }
        self.pending_seek
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.pending_replies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = PlayerSnapshot {
            position: 0.0,
            paused: true,
        };
    }

    pub fn clear_loading_flag(&self) {
        let mut def = self.deferred_load.lock().unwrap_or_else(|e| e.into_inner());
        *def = DeferredLoadState::default();
        self.loading_media.store(false, Ordering::SeqCst);
    }

    pub fn is_loading_media(&self) -> bool {
        self.loading_media.load(Ordering::SeqCst)
    }

    /// Records the target seek position and returns `true` when deferred until `file-loaded`.
    pub fn note_seek_target(&self, target_secs: f64) -> bool {
        let safe = if target_secs.is_finite() && target_secs >= 0.0 {
            target_secs
        } else {
            0.0
        };
        let deferred = {
            let mut def = self.deferred_load.lock().unwrap_or_else(|e| e.into_inner());
            if def.loading {
                def.seek_secs = Some(safe);
                true
            } else {
                false
            }
        };
        if !deferred {
            self.pending_seek
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .note_dispatched_seek(safe, None, Instant::now());
        }
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .position = safe;
        deferred
    }

    /// Dispatches a tracked seek command (deferring exact seeks cleanly if media is still loading)
    /// and rolls back pending seek state if command submission fails.
    pub fn dispatch_seek(
        &self,
        target_secs: f64,
        preview: bool,
        client_seek_seq: Option<u64>,
    ) -> Result<(), String> {
        if let Some(seq) = client_seek_seq {
            self.client_seek_seq.fetch_max(seq, Ordering::SeqCst);
        }
        let safe = if target_secs.is_finite() && target_secs >= 0.0 {
            target_secs
        } else {
            0.0
        };
        {
            let mut def = self.deferred_load.lock().unwrap_or_else(|e| e.into_inner());
            if def.loading {
                if !preview {
                    def.seek_secs = Some(safe);
                    self.snapshot
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .position = safe;
                }
                return Ok(());
            }
        }
        let req = self.next_request_id();
        self.pending_seek
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .note_dispatched_seek(safe, Some(req), Instant::now());
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .position = safe;
        let cmd = if preview {
            seek_keyframes_cmd(req, safe)
        } else {
            seek_absolute_cmd(req, safe)
        };
        if let Err(err) = self.send_command(cmd) {
            self.pending_seek
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .on_reply_error(req);
            return Err(err);
        }
        Ok(())
    }

    /// Records desired pause state and returns `true` when deferred until `file-loaded`.
    pub fn note_paused(&self, paused: bool) -> bool {
        let deferred = {
            let mut def = self.deferred_load.lock().unwrap_or_else(|e| e.into_inner());
            if def.loading {
                def.pause = Some(paused);
                true
            } else {
                false
            }
        };
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .paused = paused;
        deferred
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        parent_hwnd: isize,
        rect: PhysicalRect,
    ) -> Result<(), String> {
        let _lifecycle = self.lifecycle_lock.lock().await;
        {
            let mut last = self.last_app.lock().unwrap_or_else(|e| e.into_inner());
            *last = Some(app.clone());
        }

        let stale_runtime = {
            let mut guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            let should_recycle = match guard.as_mut() {
                Some(rt) => {
                    let exited = matches!(rt.child.try_wait(), Ok(Some(_)));
                    let alive = is_child_window_alive(rt.hwnd);
                    exited || !alive || rt.parent_hwnd != parent_hwnd
                }
                None => false,
            };
            if should_recycle {
                guard.take()
            } else {
                None
            }
        };

        if let Some(mut stale) = stale_runtime {
            mark_child_closing_and_hide(&stale.app, stale.hwnd);
            drop(stale.tx);
            let _ = stale.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_millis(250), stale.child.wait()).await;
            destroy_child_hwnd(&stale.app, stale.hwnd);
            self.has_media.store(false, Ordering::SeqCst);
            self.clear_loading_flag();
        }

        {
            let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                drop(guard);
                let _ = self.resize(rect, true);
                self.emit_surface_state_with(app);
                return Ok(());
            }
        }

        self.shutting_down.store(false, Ordering::SeqCst);
        self.clear_loading_flag();
        self.has_media.store(false, Ordering::SeqCst);
        self.pending_resize.cancel();
        self.pending_seek
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.pending_replies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();

        let app_for_paths = app.clone();
        let (mpv_exe, fonts_dir) = tokio::task::spawn_blocking(move || {
            let exe = resolve_mpv_exe(&app_for_paths)?;
            let fonts = resolve_fonts_dir(&app_for_paths);
            Ok::<_, String>((exe, fonts))
        })
        .await
        .map_err(|e| format!("Failed resolving mpv paths: {e}"))??;

        let child_hwnd = create_child_hwnd(parent_hwnd, rect, app.clone())?;
        let seq = MPV_PIPE_SEQ.fetch_add(1, Ordering::Relaxed);
        let mut pipe_rand = [0u8; 8];
        epilod_core::p2p::fill_random_bytes(&mut pipe_rand);
        let pipe_name = format!(
            "epilod-mpv-{}-{seq}-{:016x}",
            std::process::id(),
            u64::from_le_bytes(pipe_rand)
        );
        let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed);

        let (child, stderr_tail) = match spawn_mpv(
            &mpv_exe,
            child_hwnd as u64,
            &pipe_name,
            fonts_dir.as_deref(),
        ) {
            Ok(res) => res,
            Err(e) => {
                destroy_child_hwnd(app, child_hwnd);
                return Err(e);
            }
        };

        let (tx, rx) = mpsc::channel::<String>(256);
        let cmd_tx_ipc = tx.clone();

        // Fix 15: Only cache last_rect if viewport dimensions are non-zero (not minimized).
        let cached_rect = if rect.width > 0 && rect.height > 0 {
            Some(rect)
        } else {
            None
        };

        {
            let mut guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(MpvRuntime {
                session_id,
                app: app.clone(),
                parent_hwnd,
                hwnd: child_hwnd,
                child,
                tx,
                last_rect: cached_rect,
            });
        }
        if self.has_media.load(Ordering::SeqCst) && self.ui_visible.load(Ordering::SeqCst) {
            set_child_visible(app, child_hwnd, true);
        }
        self.emit_surface_state_with(app);

        let app_clone = app.clone();
        let runtime_clone = Arc::clone(&self.runtime);
        let runtime_for_probe = Arc::clone(&self.runtime);
        let snap_clone = Arc::clone(&self.snapshot);
        let loading_clone = Arc::clone(&self.loading_media);
        let deferred_load_clone = Arc::clone(&self.deferred_load);
        let pending_seek_clone = Arc::clone(&self.pending_seek);
        let pending_replies_clone = Arc::clone(&self.pending_replies);
        let client_seek_seq_clone = Arc::clone(&self.client_seek_seq);
        let pending_resize_clone = Arc::clone(&self.pending_resize);
        let shutdown_flag = Arc::clone(&self.shutting_down);
        let has_media_clone = Arc::clone(&self.has_media);
        let ui_visible_clone = Arc::clone(&self.ui_visible);
        let volume_reassert_clone = Arc::clone(&self.volume_reassert_cb);
        let runtime_for_file_loaded = Arc::clone(&self.runtime);
        let has_media_for_file_loaded = Arc::clone(&self.has_media);
        let ui_visible_for_file_loaded = Arc::clone(&self.ui_visible);
        let pending_resize_for_file_loaded = Arc::clone(&self.pending_resize);
        let app_for_file_loaded = app.clone();
        let file_loaded_cb: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let effective = has_media_for_file_loaded.load(Ordering::SeqCst)
                && ui_visible_for_file_loaded.load(Ordering::SeqCst);
            let mut running = false;
            if let Ok(mut guard) = runtime_for_file_loaded.lock() {
                if let Some(ref mut rt) = *guard {
                    if rt.session_id == session_id {
                        running = !matches!(rt.child.try_wait(), Ok(Some(_)))
                            && is_child_window_alive(rt.hwnd);
                        set_child_visible(&rt.app, rt.hwnd, effective);
                        if let Some(r) = rt.last_rect {
                            if r.width > 0 && r.height > 0 {
                                resize_child_hwnd(
                                    &rt.app,
                                    rt.hwnd,
                                    r,
                                    &pending_resize_for_file_loaded,
                                );
                            }
                        }
                    }
                }
            }
            let has_media = running && has_media_for_file_loaded.load(Ordering::SeqCst);
            let ui_vis = ui_visible_for_file_loaded.load(Ordering::SeqCst);
            let _ = app_for_file_loaded.emit(
                "mpv://surface-state",
                MpvSurfaceState {
                    running,
                    has_media,
                    ui_visible: ui_vis,
                    surface_visible: running && has_media && ui_vis,
                },
            );
        });
        let runtime_for_vo_ready = Arc::clone(&self.runtime);
        let has_media_for_vo_ready = Arc::clone(&self.has_media);
        let ui_visible_for_vo_ready = Arc::clone(&self.ui_visible);
        let vo_nudge_pending_cb = Arc::clone(&self.vo_nudge_pending);
        let vo_nudge_in_flight_cb = Arc::clone(&self.vo_nudge_in_flight);
        let vo_ready_cb: Arc<dyn Fn(bool) + Send + Sync> = Arc::new(move |is_playback_restart| {
            let should_nudge = if is_playback_restart {
                vo_nudge_pending_cb.swap(false, Ordering::AcqRel)
            } else {
                vo_nudge_pending_cb.load(Ordering::Acquire)
            };
            if !should_nudge {
                return;
            }
            if vo_nudge_in_flight_cb
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return;
            }
            let runtime_nudge = Arc::clone(&runtime_for_vo_ready);
            let has_media_nudge = Arc::clone(&has_media_for_vo_ready);
            let ui_visible_nudge = Arc::clone(&ui_visible_for_vo_ready);
            let in_flight_reset = Arc::clone(&vo_nudge_in_flight_cb);
            let initial_delay_ms = if is_playback_restart { 20 } else { 40 };
            tokio::spawn(async move {
                struct InFlightReset(Arc<AtomicBool>);
                impl Drop for InFlightReset {
                    fn drop(&mut self) {
                        self.0.store(false, Ordering::Release);
                    }
                }
                let _reset = InFlightReset(in_flight_reset);
                tokio::time::sleep(Duration::from_millis(initial_delay_ms)).await;
                let effective = has_media_nudge.load(Ordering::Acquire)
                    && ui_visible_nudge.load(Ordering::Acquire);
                if !effective {
                    return;
                }
                let nudge_target = {
                    let Ok(guard) = runtime_nudge.lock() else {
                        return;
                    };
                    let Some(ref rt) = *guard else {
                        return;
                    };
                    if rt.session_id != session_id {
                        return;
                    }
                    rt.last_rect
                        .filter(|r| r.width > 1 && r.height > 1)
                        .map(|r| (rt.app.clone(), rt.hwnd, r))
                };
                if let Some((app_handle, hwnd, r)) = nudge_target {
                    nudge_child_hwnd_redraw(&app_handle, hwnd, r);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    if let Ok(guard) = runtime_nudge.lock() {
                        if let Some(ref rt2) = *guard {
                            if rt2.session_id == session_id {
                                if let Some(latest_r) = rt2.last_rect {
                                    apply_child_hwnd_size(&rt2.app, rt2.hwnd, latest_r);
                                }
                            }
                        }
                    }
                }
            });
        });
        tokio::spawn(async move {
            let reason = ipc::connect_and_run_ipc(
                pipe_name,
                app_clone.clone(),
                cmd_tx_ipc,
                rx,
                Arc::clone(&snap_clone),
                Arc::clone(&loading_clone),
                Arc::clone(&deferred_load_clone),
                Arc::clone(&pending_seek_clone),
                Arc::clone(&pending_replies_clone),
                Arc::clone(&client_seek_seq_clone),
                Arc::clone(&volume_reassert_clone),
                file_loaded_cb,
                vo_ready_cb,
                move || {
                    if let Ok(mut guard) = runtime_for_probe.try_lock() {
                        if let Some(rt) = guard.as_mut() {
                            if rt.session_id == session_id {
                                if let Ok(Some(status)) = rt.child.try_wait() {
                                    return Some(format!("exit status {status}"));
                                }
                            }
                        }
                    }
                    None
                },
            )
            .await;

            if !shutdown_flag.load(Ordering::SeqCst) {
                let taken = {
                    let mut guard = runtime_clone.lock().unwrap_or_else(|e| e.into_inner());
                    let is_same = guard
                        .as_ref()
                        .map(|rt| rt.session_id == session_id)
                        .unwrap_or(false);
                    if is_same {
                        guard.take()
                    } else {
                        None
                    }
                };
                if let Some(mut rt) = taken {
                    pending_resize_clone.cancel();
                    mark_child_closing_and_hide(&rt.app, rt.hwnd);
                    drop(rt.tx);
                    let exit_note = match rt.child.try_wait() {
                        Ok(Some(status)) => Some(format!("exit {status}")),
                        _ => None,
                    };
                    let _ = rt.child.start_kill();
                    let _ = tokio::time::timeout(Duration::from_millis(250), rt.child.wait()).await;
                    destroy_child_hwnd(&rt.app, rt.hwnd);
                    has_media_clone.store(false, Ordering::SeqCst);
                    loading_clone.store(false, Ordering::SeqCst);
                    pending_seek_clone
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clear();
                    *snap_clone.lock().unwrap_or_else(|e| e.into_inner()) =
                        PlayerSnapshot::default();
                    let _ = app_clone.emit(
                        "mpv://surface-state",
                        MpvSurfaceState {
                            running: false,
                            has_media: false,
                            ui_visible: ui_visible_clone.load(Ordering::SeqCst),
                            surface_visible: false,
                        },
                    );
                    let mut full_msg = reason;
                    if let Some(ex) = exit_note {
                        if !full_msg.contains("exit") {
                            full_msg = format!("{full_msg} ({ex})");
                        }
                    }
                    if let Some(stderr_info) = stderr_tail.summary() {
                        full_msg = format!("{full_msg} — {stderr_info}");
                    }
                    let _ =
                        app_clone.emit("mpv://error", serde_json::json!({ "message": full_msg }));
                }
            }
        });

        Ok(())
    }

    pub fn resize_for_window_size(&self, width: u32, height: u32) {
        if width == 0 || height == 0 || !self.has_media.load(Ordering::Acquire) {
            return;
        }
        let rect = PhysicalRect {
            x: 0,
            y: 0,
            width: width as i32,
            height: height as i32,
        };
        let _ = self.resize(rect, false);
    }

    pub fn resize(&self, rect: PhysicalRect, force: bool) -> Result<(), String> {
        let mut guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ref mut rt) = *guard else {
            return Ok(());
        };
        // Fix 15: Invalidate cached rect on 0x0 minimize so restore to exact same bounds resizes.
        if rect.width <= 0 || rect.height <= 0 {
            rt.last_rect = None;
            return Ok(());
        }
        if !force && rt.last_rect == Some(rect) {
            return Ok(());
        }
        rt.last_rect = Some(rect);
        resize_child_hwnd(&rt.app, rt.hwnd, rect, &self.pending_resize);
        Ok(())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.ui_visible.store(visible, Ordering::SeqCst);
        let effective = visible && self.has_media.load(Ordering::SeqCst);
        let app_to_emit = {
            let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ref rt) = *guard {
                set_child_visible(&rt.app, rt.hwnd, effective);
                Some(rt.app.clone())
            } else {
                None
            }
        };
        if let Some(app_handle) = app_to_emit {
            self.emit_surface_state_with(&app_handle);
        } else {
            self.emit_surface_state_best_effort();
        }
        Ok(())
    }

    pub fn set_media_loaded(&self, loaded: bool) {
        self.has_media.store(loaded, Ordering::SeqCst);
        let effective = loaded && self.ui_visible.load(Ordering::SeqCst);
        let app_to_emit = {
            let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ref rt) = *guard {
                set_child_visible(&rt.app, rt.hwnd, effective);
                Some(rt.app.clone())
            } else {
                None
            }
        };
        if let Some(app_handle) = app_to_emit {
            self.emit_surface_state_with(&app_handle);
        } else {
            self.emit_surface_state_best_effort();
        }
    }

    pub fn send_command(&self, cmd_line: String) -> Result<(), String> {
        let mut guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let exited_or_dead = match guard.as_mut() {
            Some(rt) => {
                matches!(rt.child.try_wait(), Ok(Some(_))) || !is_child_window_alive(rt.hwnd)
            }
            None => true,
        };
        if exited_or_dead {
            drop(guard);
            self.has_media.store(false, Ordering::SeqCst);
            self.emit_surface_state_best_effort();
            return Err("Video player is not running.".to_string());
        }
        let Some(ref rt) = *guard else {
            drop(guard);
            self.has_media.store(false, Ordering::SeqCst);
            self.emit_surface_state_best_effort();
            return Err("Video player is not running.".to_string());
        };
        if rt.tx.try_send(cmd_line).is_err() {
            drop(guard);
            self.has_media.store(false, Ordering::SeqCst);
            self.emit_surface_state_best_effort();
            return Err("Video player command queue is unavailable.".to_string());
        }
        Ok(())
    }

    /// Fix 18: Cleanly stop and await child exit up to 500ms before destroying HWND.
    pub async fn stop_and_clear(&self) {
        let _lifecycle = self.lifecycle_lock.lock().await;
        self.shutting_down.store(true, Ordering::SeqCst);
        self.clear_loading_flag();
        self.has_media.store(false, Ordering::SeqCst);
        self.pending_resize.cancel();
        self.pending_seek
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.pending_replies
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let taken = self
            .runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = PlayerSnapshot::default();
        if let Some(mut rt) = taken {
            let app_clone = rt.app.clone();
            mark_child_closing_and_hide(&rt.app, rt.hwnd);
            let _ = rt.tx.try_send("{\"command\":[\"quit\"]}\n".to_string());
            drop(rt.tx);
            let _ = tokio::time::timeout(Duration::from_millis(250), rt.child.wait()).await;
            let _ = rt.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_millis(250), rt.child.wait()).await;
            destroy_child_hwnd(&rt.app, rt.hwnd);
            self.emit_surface_state_with(&app_clone);
        } else {
            self.emit_surface_state_best_effort();
        }
    }

    /// Captures a downsampled RGBA snapshot of the active hardware mpv surface so
    /// translucent UI chrome can blur and refract live video underneath.
    pub async fn capture_backdrop_frame(
        &self,
        max_width: i32,
        max_height: i32,
    ) -> Result<Vec<u8>, String> {
        if self.shutting_down.load(Ordering::SeqCst)
            || !self.has_media.load(Ordering::SeqCst)
            || !self.ui_visible.load(Ordering::SeqCst)
        {
            return Ok(Vec::new());
        }
        let hwnd = {
            let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().map(|rt| rt.hwnd).unwrap_or(0)
        };
        if hwnd == 0 {
            return Ok(Vec::new());
        }
        if self
            .capture_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return Ok(Vec::new());
        }

        struct BusyReset(Arc<AtomicBool>);
        impl Drop for BusyReset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let busy_guard = BusyReset(Arc::clone(&self.capture_busy));
        let shutting_down = Arc::clone(&self.shutting_down);

        tokio::task::spawn_blocking(move || {
            let _guard = busy_guard;
            capture_child_backdrop_rgba(hwnd, max_width, max_height, &shutting_down)
        })
        .await
        .map_err(|e| format!("Backdrop capture task failed: {e}"))?
    }

    /// Captures an uncropped, UI-chrome-free video frame directly from `mpv` via `screenshot-to-file`
    /// JPEG so layout freeze transitions (`ChatSidebar`, `SettingsModal`, drag resize) scale smoothly
    /// at full clarity with zero duplicate TitleBar/Play Bar artifacts and zero HWND letterbox bars.
    pub async fn capture_clean_freeze_frame(&self) -> Result<Vec<u8>, String> {
        if self.shutting_down.load(Ordering::SeqCst)
            || !self.has_media.load(Ordering::SeqCst)
            || self.loading_media.load(Ordering::SeqCst)
        {
            return Ok(Vec::new());
        }
        if self
            .freeze_capture_busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return Ok(Vec::new());
        }

        struct BusyReset(Arc<AtomicBool>);
        impl Drop for BusyReset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _busy_guard = BusyReset(Arc::clone(&self.freeze_capture_busy));

        struct ReplyCleanup {
            map: PendingReplyMap,
            req_id: u64,
        }
        impl Drop for ReplyCleanup {
            fn drop(&mut self) {
                self.map
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&self.req_id);
            }
        }

        struct TempFileCleanup(std::path::PathBuf);
        impl Drop for TempFileCleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        let req_id = self.next_request_id();
        let temp_path =
            std::env::temp_dir().join(format!("epilod_freeze_{}_{req_id}.jpg", std::process::id()));
        let _file_cleanup = TempFileCleanup(temp_path.clone());
        let Some(path_str) = temp_path.to_str() else {
            return Ok(Vec::new());
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut map = self
                .pending_replies
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.insert(req_id, tx);
        }
        let _cleanup = ReplyCleanup {
            map: Arc::clone(&self.pending_replies),
            req_id,
        };

        let cmd = screenshot_to_file_cmd(req_id, path_str, true);
        if self.send_command(cmd).is_err() {
            return Ok(Vec::new());
        }

        let Ok(Ok(reply)) = tokio::time::timeout(Duration::from_millis(350), rx).await else {
            return Ok(Vec::new());
        };
        if reply.error != "success" && !reply.error.is_empty() {
            return Ok(Vec::new());
        }

        Ok(tokio::fs::read(&temp_path).await.unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_state_is_never_visible_without_running_runtime() {
        let ctrl = MpvController::new();
        let initial = ctrl.surface_state();
        assert!(!initial.running);
        assert!(!initial.has_media);
        assert!(!initial.surface_visible);

        // Even if load/visibility flags flip while stopped, surface_visible must remain false
        // so the frontend never reveals a transparent desktop cutout.
        ctrl.set_media_loaded(true);
        let _ = ctrl.set_visible(true);
        let state = ctrl.surface_state();
        assert!(!state.running);
        assert!(!state.has_media);
        assert!(!state.surface_visible);

        let err = ctrl
            .send_command("{\"command\":[\"get_property\",\"pause\"]}\n".to_string())
            .expect_err("send_command must fail when mpv runtime is absent");
        assert!(err.contains("not running"));
        assert!(!ctrl.surface_state().surface_visible);
    }

    #[test]
    fn deferred_load_defers_pause_and_seek_until_cleared_or_file_loaded() {
        let ctrl = MpvController::new();
        ctrl.prepare_for_load();
        assert!(ctrl.loading_media.load(Ordering::SeqCst));
        assert!(ctrl.note_seek_target(12.5));
        assert!(ctrl.note_paused(false));

        {
            let def = ctrl.deferred_load.lock().unwrap();
            assert!(def.loading);
            assert_eq!(def.seek_secs, Some(12.5));
            assert_eq!(def.pause, Some(false));
        }

        ctrl.clear_loading_flag();
        assert!(!ctrl.loading_media.load(Ordering::SeqCst));
        assert!(!ctrl.note_seek_target(20.0));
        assert!(!ctrl.note_paused(true));

        let def = ctrl.deferred_load.lock().unwrap();
        assert!(!def.loading);
        assert_eq!(def.seek_secs, None);
        assert_eq!(def.pause, None);
    }
}
