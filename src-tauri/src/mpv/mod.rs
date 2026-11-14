#![cfg(windows)]

pub mod hwnd;
pub mod ipc;
pub mod process;

use epilod_core::syncplay::PlayerSnapshot;
use hwnd::{
    create_child_hwnd, destroy_child_hwnd, resize_child_hwnd, set_child_visible, PhysicalRect,
};
use process::{resolve_fonts_dir, resolve_mpv_exe, spawn_mpv};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::Child;
use tokio::sync::mpsc;

pub struct MpvRuntime {
    pub hwnd: isize,
    pub child: Child,
    pub tx: mpsc::Sender<String>,
    pub last_rect: Option<PhysicalRect>,
}

pub struct MpvController {
    runtime: Mutex<Option<MpvRuntime>>,
    snapshot: Arc<Mutex<PlayerSnapshot>>,
    next_req_id: AtomicU64,
}

impl Default for MpvController {
    fn default() -> Self {
        Self::new()
    }
}

impl MpvController {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
            snapshot: Arc::new(Mutex::new(PlayerSnapshot::default())),
            next_req_id: AtomicU64::new(100),
        }
    }

    pub fn next_request_id(&self) -> u64 {
        self.next_req_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        self.snapshot.lock().map(|g| *g).unwrap_or_default()
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

        let mpv_exe = resolve_mpv_exe(app)?;
        let fonts_dir = resolve_fonts_dir(app);
        let child_hwnd = create_child_hwnd(parent_hwnd, rect, app.clone())?;
        let pipe_name = format!("epilod-mpv-{}", std::process::id());

        let child = match spawn_mpv(
            &mpv_exe,
            child_hwnd as u64,
            &pipe_name,
            fonts_dir.as_deref(),
        ) {
            Ok(c) => c,
            Err(e) => {
                destroy_child_hwnd(child_hwnd);
                return Err(e);
            }
        };

        let (tx, rx) = mpsc::channel::<String>(128);
        let app_clone = app.clone();
        let snap_clone = Arc::clone(&self.snapshot);
        tauri::async_runtime::spawn(async move {
            ipc::connect_and_run_ipc(pipe_name, app_clone.clone(), rx, snap_clone).await;
            let _ = app_clone.emit(
                "mpv://error",
                serde_json::json!({ "message": "Playback engine stopped unexpectedly." }),
            );
        });

        // Fix 15: Only cache last_rect if viewport dimensions are non-zero (not minimized).
        let cached_rect = if rect.width > 0 && rect.height > 0 {
            Some(rect)
        } else {
            None
        };

        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| "Mpv state poisoned".to_string())?;
        *guard = Some(MpvRuntime {
            hwnd: child_hwnd,
            child,
            tx,
            last_rect: cached_rect,
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
        resize_child_hwnd(rt.hwnd, rect);
        Ok(())
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), String> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| "Mpv state poisoned".to_string())?;
        if let Some(ref rt) = *guard {
            set_child_visible(rt.hwnd, visible);
        }
        Ok(())
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
            destroy_child_hwnd(rt.hwnd);
        }
    }
}
