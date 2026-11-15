#![cfg(windows)]

pub mod hwnd;
pub mod ipc;
pub mod process;

use epilod_core::syncplay::PlayerSnapshot;
use hwnd::{
    create_child_hwnd, destroy_child_hwnd, mark_child_closing_and_hide, resize_child_hwnd,
    set_child_visible, PendingResize, PhysicalRect,
};
use process::{resolve_fonts_dir, resolve_mpv_exe, spawn_mpv};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

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
    pending_resize: Arc<PendingResize>,
    lifecycle_lock: AsyncMutex<()>,
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
            pending_resize: Arc::new(PendingResize::default()),
            lifecycle_lock: AsyncMutex::new(()),
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
        *self.snapshot.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn prepare_for_load(&self) {
        self.loading_media.store(true, Ordering::SeqCst);
        *self.pending_seek.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = PlayerSnapshot {
            position: 0.0,
            paused: true,
        };
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
        *self.pending_seek.lock().unwrap_or_else(|e| e.into_inner()) = Some((safe, Instant::now()));
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .position = safe;
    }

    pub fn note_paused(&self, paused: bool) {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .paused = paused;
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        parent_hwnd: isize,
        rect: PhysicalRect,
    ) -> Result<(), String> {
        let _lifecycle = self.lifecycle_lock.lock().await;
        {
            let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return Ok(());
            }
        }

        self.shutting_down.store(false, Ordering::SeqCst);
        self.loading_media.store(false, Ordering::SeqCst);
        self.has_media.store(false, Ordering::SeqCst);
        self.pending_resize.cancel();
        *self.pending_seek.lock().unwrap_or_else(|e| e.into_inner()) = None;

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

        let (tx, rx) = mpsc::channel::<String>(256);

        // Fix 15: Only cache last_rect if viewport dimensions are non-zero (not minimized).
        let cached_rect = if rect.width > 0 && rect.height > 0 {
            Some(rect)
        } else {
            None
        };

        {
            let mut guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
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
        let pending_resize_clone = Arc::clone(&self.pending_resize);
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
                pending_resize_clone.cancel();
                let taken = runtime_clone
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if let Some(mut rt) = taken {
                    mark_child_closing_and_hide(&rt.app, rt.hwnd);
                    drop(rt.tx);
                    let _ = rt.child.start_kill();
                    let _ = tokio::time::timeout(Duration::from_millis(250), rt.child.wait()).await;
                    destroy_child_hwnd(&rt.app, rt.hwnd);
                }
                has_media_clone.store(false, Ordering::SeqCst);
                loading_clone.store(false, Ordering::SeqCst);
                *pending_seek_clone.lock().unwrap_or_else(|e| e.into_inner()) = None;
                *snap_clone.lock().unwrap_or_else(|e| e.into_inner()) = PlayerSnapshot::default();
                let _ = app_clone.emit(
                    "mpv://error",
                    serde_json::json!({ "message": "Playback engine stopped unexpectedly." }),
                );
            }
        });

        Ok(())
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
        let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref rt) = *guard {
            set_child_visible(&rt.app, rt.hwnd, effective);
        }
        Ok(())
    }

    pub fn set_media_loaded(&self, loaded: bool) {
        self.has_media.store(loaded, Ordering::SeqCst);
        let effective = loaded && self.ui_visible.load(Ordering::SeqCst);
        let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref rt) = *guard {
            set_child_visible(&rt.app, rt.hwnd, effective);
        }
    }

    pub fn send_command(&self, cmd_line: String) -> Result<(), String> {
        let guard = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ref rt) = *guard else {
            return Err("Video player is not running.".to_string());
        };
        rt.tx
            .try_send(cmd_line)
            .map_err(|_| "Video player command queue is unavailable.".to_string())
    }

    /// Fix 18: Cleanly stop and await child exit up to 500ms before destroying HWND.
    pub async fn stop_and_clear(&self) {
        let _lifecycle = self.lifecycle_lock.lock().await;
        self.shutting_down.store(true, Ordering::SeqCst);
        self.loading_media.store(false, Ordering::SeqCst);
        self.has_media.store(false, Ordering::SeqCst);
        self.pending_resize.cancel();
        *self.pending_seek.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let taken = self
            .runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        *self.snapshot.lock().unwrap_or_else(|e| e.into_inner()) = PlayerSnapshot::default();
        if let Some(mut rt) = taken {
            mark_child_closing_and_hide(&rt.app, rt.hwnd);
            let _ = rt.tx.try_send("{\"command\":[\"quit\"]}\n".to_string());
            drop(rt.tx);
            let _ = tokio::time::timeout(Duration::from_millis(250), rt.child.wait()).await;
            let _ = rt.child.start_kill();
            let _ = tokio::time::timeout(Duration::from_millis(250), rt.child.wait()).await;
            destroy_child_hwnd(&rt.app, rt.hwnd);
        }
    }
}
