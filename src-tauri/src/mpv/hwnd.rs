#![cfg(windows)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, Once};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, IsWindow, RegisterClassExW,
    SetWindowLongPtrW, SetWindowPos, CS_DBLCLKS, GWLP_USERDATA, HWND_TOP, SWP_ASYNCWINDOWPOS,
    SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SWP_SHOWWINDOW, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_NCDESTROY, WM_PARENTNOTIFY, WNDCLASSEXW,
    WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Default)]
pub struct PendingResize {
    latest: Mutex<Option<(isize, PhysicalRect)>>,
    scheduled: AtomicBool,
}

impl PendingResize {
    pub fn cancel(&self) {
        self.scheduled.store(false, Ordering::Release);
        let mut guard = self.latest.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
}

struct SurfaceContext {
    app: AppHandle,
    closing: AtomicBool,
}

static REGISTER_CLASS: Once = Once::new();

fn class_name_wide() -> Vec<u16> {
    "EpilodMpvSurface\0".encode_utf16().collect()
}

unsafe extern "system" fn surface_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_LBUTTONDOWN => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const SurfaceContext;
            if !ptr.is_null() {
                let ctx = &*ptr;
                if !ctx.closing.load(Ordering::Acquire) {
                    let _ = ctx.app.emit("mpv://surface-click", ());
                }
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const SurfaceContext;
            if !ptr.is_null() {
                let ctx = &*ptr;
                if !ctx.closing.load(Ordering::Acquire) {
                    let _ = ctx.app.emit("mpv://surface-dblclick", ());
                }
            }
            0
        }
        WM_PARENTNOTIFY => {
            let event = (wparam & 0xFFFF) as u32;
            if event == WM_LBUTTONDOWN {
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const SurfaceContext;
                if !ptr.is_null() {
                    let ctx = &*ptr;
                    if !ctx.closing.load(Ordering::Acquire) {
                        let _ = ctx.app.emit("mpv://surface-click", ());
                    }
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_NCDESTROY => {
            let ptr = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *mut SurfaceContext;
            if !ptr.is_null() {
                drop(Box::from_raw(ptr));
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn ensure_surface_class() {
    REGISTER_CLASS.call_once(|| unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let cls_name = class_name_wide();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_DBLCLKS,
            lpfnWndProc: Some(surface_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: GetStockObject(BLACK_BRUSH),
            lpszMenuName: std::ptr::null(),
            lpszClassName: cls_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        RegisterClassExW(&wc);
    });
}

pub fn create_child_hwnd(
    parent_hwnd: isize,
    rect: PhysicalRect,
    app: AppHandle,
) -> Result<isize, String> {
    let (tx, rx) = mpsc::sync_channel::<Result<isize, String>>(1);
    let app_for_ctx = app.clone();

    app.run_on_main_thread(move || {
        ensure_surface_class();
        let cls = class_name_wide();
        let title: Vec<u16> = "EpilodVideoSurface\0".encode_utf16().collect();
        let w = rect.width.max(1);
        let h = rect.height.max(1);

        let res = unsafe {
            let hinstance = GetModuleHandleW(std::ptr::null());
            let hwnd = CreateWindowExW(
                0,
                cls.as_ptr(),
                title.as_ptr(),
                WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                rect.x,
                rect.y,
                w,
                h,
                parent_hwnd as HWND,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null::<c_void>(),
            );
            if hwnd.is_null() {
                Err("CreateWindowExW failed to create mpv host surface.".to_string())
            } else {
                let ctx = Box::new(SurfaceContext {
                    app: app_for_ctx,
                    closing: AtomicBool::new(false),
                });
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(ctx) as isize);
                Ok(hwnd as isize)
            }
        };
        let _ = tx.send(res);
    })
    .map_err(|e| format!("Failed dispatching child HWND creation to main UI thread: {e}"))?;

    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|e| format!("Timed out waiting for main UI thread to create video surface: {e}"))?
}

/// Coalesces rapid resize requests so at most one non-blocking `SWP_ASYNCWINDOWPOS`
/// call is queued on the main UI thread at any time.
pub fn resize_child_hwnd(
    app: &AppHandle,
    hwnd: isize,
    rect: PhysicalRect,
    pending: &Arc<PendingResize>,
) {
    if hwnd == 0 {
        return;
    }
    {
        let mut guard = pending.latest.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some((hwnd, rect));
    }
    if pending.scheduled.swap(true, Ordering::AcqRel) {
        return;
    }
    let pending_clone = Arc::clone(pending);
    if app
        .run_on_main_thread(move || {
            pending_clone.scheduled.store(false, Ordering::Release);
            let target = {
                let mut guard = pending_clone
                    .latest
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                guard.take()
            };
            if let Some((target_hwnd, r)) = target {
                if target_hwnd != 0 {
                    let w = r.width.max(1);
                    let h = r.height.max(1);
                    unsafe {
                        if IsWindow(target_hwnd as HWND) != 0 {
                            SetWindowPos(
                                target_hwnd as HWND,
                                std::ptr::null_mut(),
                                r.x,
                                r.y,
                                w,
                                h,
                                SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS | SWP_NOCOPYBITS,
                            );
                        }
                    }
                }
            }
        })
        .is_err()
    {
        pending.scheduled.store(false, Ordering::Release);
    }
}

pub fn set_child_visible(app: &AppHandle, hwnd: isize, visible: bool) {
    if hwnd == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        if IsWindow(hwnd as HWND) == 0 {
            return;
        }
        if visible {
            SetWindowPos(
                hwnd as HWND,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS,
            );
        } else {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_HIDEWINDOW
                    | SWP_NOACTIVATE
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOZORDER
                    | SWP_ASYNCWINDOWPOS,
            );
        }
    });
}

pub fn mark_child_closing_and_hide(app: &AppHandle, hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        if IsWindow(hwnd as HWND) == 0 {
            return;
        }
        let ptr = GetWindowLongPtrW(hwnd as HWND, GWLP_USERDATA) as *const SurfaceContext;
        if !ptr.is_null() {
            (*ptr).closing.store(true, Ordering::Release);
        }
        SetWindowPos(
            hwnd as HWND,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_HIDEWINDOW
                | SWP_NOACTIVATE
                | SWP_NOMOVE
                | SWP_NOSIZE
                | SWP_NOZORDER
                | SWP_ASYNCWINDOWPOS,
        );
    });
}

pub fn destroy_child_hwnd(app: &AppHandle, hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        if IsWindow(hwnd as HWND) != 0 {
            DestroyWindow(hwnd as HWND);
        }
    });
}
