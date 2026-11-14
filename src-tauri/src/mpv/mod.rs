#![cfg(windows)]

pub mod hwnd;
pub mod ipc;
pub mod process;

use epilod_core::syncplay::PlayerSnapshot;
use hwnd::{
    create_child_hwnd, destroy_child_hwnd, resize_child_hwnd, set_child_visible, PhysicalRect,
};
use process::{resolve_fonts_dir, resolve_mpv_exe, spawn_mpv};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::process::Child;
use tokio::sync::mpsc;

static MPV_PIPE_SEQ: AtomicU64 = AtomicU64::new(1);

pub struct MpvRuntime {
    pub app: AppHandle,
    pub hwnd: isize,
    pub child: Child,
    pub tx: mpsc::Sender<String>,
    pub last_rect: Option<PhysicalRect>,
}

pub struct MpvController {
    runtime: Arc<Mutex<Option<MpvRuntime>>>,
    snapshot: Arc<Mutex<PlayerSnapshot>>,
    loading_media: Arc<AtomicBool>,
    pending_seek: Arc<Mutex<Option<(f64, Instant)>>>,
    next_req_id: AtomicU64,
    shutting_down: Arc<AtomicBool>,
    has_media: Arc<AtomicBool>,
    ui_visible: AtomicBool,
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
            pending_seek: Arc::new(Mutex::new(None)),
            next_req_id: AtomicU64::new(100),
            shutting_down: Arc::new(AtomicBool::new(false)),
            has_media: Arc::new(AtomicBool::new(false)),
            ui_visible: AtomicBool::new(true),
        }
    }

    pub fn next_request_id(&self) -> u64 {
        self.next_req_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        self.snapshot.lock().map(|g| *g).unwrap_or_default()
    }

    pub fn prepare_for_load(&self) {
        self.loading_media.store(true, Ordering::SeqCst);
        if let Ok(mut ps) = self.pending_seek.lock() {
            *ps = None;
        }
        if let Ok(mut snap) = self.snapshot.lock() {
            *snap = PlayerSnapshot {
                position: 0.0,
                paused: true,
            };
        }
    }

    pub fn clear_loading_flag(&self) {
        self.loading_media.store(false, Ordering::SeqCst);
    }

    pub fn note_seek_target(&self, target_secs: f64) {
        let safe = if target_secs.is_finite() && target_secs >= 0.0 {
            target_secs
        } else {
            0.0
        };
        if let Ok(mut ps) = self.pending_seek.lock() {
            *ps = Some((safe, Instant::now()));
        }
        if let Ok(mut snap) = self.snapshot.lock() {
            snap.position = safe;
        }
    }

    pub fn note_paused(&self, paused: bool) {
        if let Ok(mut snap) = self.snapshot.lock() {
            snap.paused = paused;
        }
    }

    pub fn start(
        &self,
        app: &AppHandle,
        parent_hwnd: isize,
        rect: PhysicalRect,
    ) -> Result<(), String> {
        {
            let guard = self
                .runtime
                .lock()
                .map_err(|_| "Mpv state poisoned".to_string())?;
            if guard.is_some() {
                return Ok(());
            }
        }

        self.shutting_down.store(false, Ordering::SeqCst);
        self.loading_media.store(false, Ordering::SeqCst);
        self.has_media.store(false, Ordering::SeqCst);
        if let Ok(mut ps) = self.pending_seek.lock() {
            *ps = None;
        }

        let mpv_exe = resolve_mpv_exe(app)?;
        let fonts_dir = resolve_fonts_dir(app);
        let child_hwnd = create_child_hwnd(parent_hwnd, rect, app.clone())?;
        let seq = MPV_PIPE_SEQ.fetch_add(1, Ordering::Relaxed);
        let pipe_name = format!("epilod-mpv-{}-{seq}", std::process::id());

        let child = match spawn_mpv(
            &mpv_exe,
            child_hwnd as u64,
            &pipe_name,
            fonts_dir.as_deref(),
        ) {
            Ok(c) => c,
            Err(e) => {
                destroy_child_hwnd(app, child_hwnd);
                return Err(e);
            }
        };

        let (tx, rx) = mpsc::channel::<String>(128);

        // Fix 15: Only cache last_rect if viewport dimensions are non-zero (not minimized).
        let cached_rect = if rect.width > 0 && rect.height > 0 {
            Some(rect)
        } else {
            None
        };

        {
            let mut guard = self
                .runtime
                .lock()
                .map_err(|_| "Mpv state poisoned".to_string())?;
            *guard = Some(MpvRuntime {
                app: app.clone(),
                hwnd: child_hwnd,
                child,
                tx,
                last_rect: cached_rect,
            });
        }
        if self.has_media.load(Ordering::SeqCst) && self.ui_visible.load(Ordering::SeqCst) {
            set_child_visible(app, child_hwnd, true);
        }

        let app_clone = app.clone();
        let runtime_clone = Arc::clone(&self.runtime);
        let snap_clone = Arc::clone(&self.snapshot);
        let loading_clone = Arc::clone(&self.loading_media);
        let pending_seek_clone = Arc::clone(&self.pending_seek);
        let shutdown_flag = Arc::clone(&self.shutting_down);
        let has_media_clone = Arc::clone(&self.has_media);
        tokio::spawn(async move {
            ipc::connect_and_run_ipc(
                pipe_name,
                app_clone.clone(),
                rx,
                Arc::clone(&snap_clone),
                Arc::clone(&loading_clone),
                Arc::clone(&pending_seek_clone),
            )
            .await;
            if !shutdown_flag.load(Ordering::SeqCst) {
                let taken = runtime_clone.lock().ok().and_then(|mut g| g.take());
                if let Some(mut rt) = taken {
                    drop(rt.tx);
                    let _ = rt.child.start_kill();
                    let _ = tokio::time::timeout(Duration::from_millis(250), rt.child.wait()).await;
                    destroy_child_hwnd(&rt.app, rt.hwnd);
                }
                has_media_clone.store(false, Ordering::SeqCst);
                loading_clone.store(false, Ordering::SeqCst);
                if let Ok(mut ps) = pending_seek_clone.lock() {
                    *ps = None;
                }
                if let Ok(mut snap) = snap_clone.lock() {
                    *snap = PlayerSnapshot::default();
                }
                let _ = app_clone.emit(
                    "mpv://error",
                    serde_json::json!({ "message": "Playback engine stopped unexpectedly." }),
                );
            }
        });

        Ok(())
    }

    pub fn resize(&self, rect: PhysicalRect, force: bool) -> Result<(), String> {
        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| "Mpv state poisoned".to_string())?;
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
        resize_child_hwnd(&rt.app, rt.hwnd, rect);
        Ok(())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        self.ui_visible.store(visible, Ordering::SeqCst);
        let effective = visible && self.has_media.load(Ordering::SeqCst);
        let guard = self
            .runtime
            .lock()
            .map_err(|_| "Mpv state poisoned".to_string())?;
        if let Some(ref rt) = *guard {
            set_child_visible(&rt.app, rt.hwnd, effective);
        }
        Ok(())
    }

    pub fn set_media_loaded(&self, loaded: bool) {
        self.has_media.store(loaded, Ordering::SeqCst);
        let effective = loaded && self.ui_visible.load(Ordering::SeqCst);
        if let Ok(guard) = self.runtime.lock() {
            if let Some(ref rt) = *guard {
                set_child_visible(&rt.app, rt.hwnd, effective);
            }
        }
    }

    pub fn send_command(&self, cmd_line: String) -> Result<(), String> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| "Mpv state poisoned".to_string())?;
        let Some(ref rt) = *guard else {
            return Err("Video player is not running.".to_string());
        };
        rt.tx
            .try_send(cmd_line)
            .map_err(|_| "Video player command queue is unavailable.".to_string())
    }

    /// Fix 18: Cleanly stop and await child exit up to 500ms before destroying HWND.
    pub async fn stop_and_clear(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.loading_media.store(false, Ordering::SeqCst);
        self.has_media.store(false, Ordering::SeqCst);
        if let Ok(mut ps) = self.pending_seek.lock() {
            *ps = None;
        }
        let taken = {
            if let Ok(mut guard) = self.runtime.lock() {
                guard.take()
            } else {
                None
            }
        };
        if let Ok(mut snap) = self.snapshot.lock() {
            *snap = PlayerSnapshot::default();
        }
        if let Some(mut rt) = taken {
            let _ = rt.tx.try_send("{\"command\":[\"quit\"]}\n".to_string());
            drop(rt.tx);
            let _ = rt.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_millis(500), rt.child.wait()).await;
            destroy_child_hwnd(&rt.app, rt.hwnd);
        }
    }
}
