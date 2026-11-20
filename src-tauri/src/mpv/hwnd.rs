#![cfg(windows)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, Once};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreateSolidBrush, DeleteDC,
    DeleteObject, GetDC, GetStockObject, RedrawWindow, ReleaseDC, SelectObject, SetBrushOrgEx,
    SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLACK_BRUSH,
    DIB_RGB_COLORS, HALFTONE, HDC, RDW_ALLCHILDREN, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
    SRCCOPY,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW, IsWindow,
    IsWindowVisible, RegisterClassExW, SetWindowLongPtrW, SetWindowPos, CS_DBLCLKS, GWLP_USERDATA,
    HWND_BOTTOM, SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_HIDEWINDOW, SWP_NOACTIVATE,
    SWP_NOCOPYBITS, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, WM_LBUTTONDBLCLK,
    WM_LBUTTONDOWN, WM_NCDESTROY, WM_PARENTNOTIFY, WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN,
};

#[link(name = "user32")]
extern "system" {
    fn PrintWindow(hwnd: HWND, hdcBlt: HDC, nFlags: u32) -> i32;
}

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
        let canvas_brush = CreateSolidBrush(0x0008_0606);
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_DBLCLKS,
            lpfnWndProc: Some(surface_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: if canvas_brush.is_null() {
                GetStockObject(BLACK_BRUSH)
            } else {
                canvas_brush
            },
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
                WS_CHILD | WS_CLIPCHILDREN,
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
                let mut actual_rect = RECT {
                    left: rect.x,
                    top: rect.y,
                    right: rect.x + w,
                    bottom: rect.y + h,
                };
                if GetClientRect(parent_hwnd as HWND, &mut actual_rect) != 0 {
                    let pw = (actual_rect.right - actual_rect.left).max(1);
                    let ph = (actual_rect.bottom - actual_rect.top).max(1);
                    if w <= 1 || h <= 1 {
                        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, pw, ph, SWP_NOACTIVATE);
                    } else {
                        SetWindowPos(
                            hwnd,
                            HWND_BOTTOM,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                        );
                    }
                } else {
                    SetWindowPos(
                        hwnd,
                        HWND_BOTTOM,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                    );
                }
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
                            let _ = RedrawWindow(
                                target_hwnd as HWND,
                                std::ptr::null(),
                                std::ptr::null_mut(),
                                RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_FRAME,
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

pub fn apply_child_hwnd_size(app: &AppHandle, hwnd: isize, rect: PhysicalRect) {
    if hwnd == 0 || rect.width <= 0 || rect.height <= 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        if IsWindow(hwnd as HWND) == 0 {
            return;
        }
        SetWindowPos(
            hwnd as HWND,
            HWND_BOTTOM,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            SWP_NOACTIVATE | SWP_NOCOPYBITS | SWP_FRAMECHANGED,
        );
        let _ = RedrawWindow(
            hwnd as HWND,
            std::ptr::null(),
            std::ptr::null_mut(),
            RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN | RDW_FRAME,
        );
    });
}

pub fn nudge_child_hwnd_redraw(app: &AppHandle, hwnd: isize, rect: PhysicalRect) {
    if hwnd == 0 || rect.width <= 1 || rect.height <= 1 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        if IsWindow(hwnd as HWND) == 0 || IsWindowVisible(hwnd as HWND) == 0 {
            return;
        }
        SetWindowPos(
            hwnd as HWND,
            HWND_BOTTOM,
            rect.x,
            rect.y,
            rect.width - 1,
            rect.height,
            SWP_NOACTIVATE | SWP_NOCOPYBITS,
        );
    });
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
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
            let _ = RedrawWindow(
                hwnd as HWND,
                std::ptr::null(),
                std::ptr::null_mut(),
                RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN | RDW_FRAME,
            );
        } else {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
            );
        }
    });
}

pub fn is_child_window_alive(hwnd: isize) -> bool {
    hwnd != 0 && unsafe { IsWindow(hwnd as HWND) != 0 }
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

struct ScopedDc(HDC);
impl Drop for ScopedDc {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                DeleteDC(self.0);
            }
        }
    }
}

struct ScopedScreenDc(HDC);
impl Drop for ScopedScreenDc {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                ReleaseDC(std::ptr::null_mut(), self.0);
            }
        }
    }
}

struct ScopedGdiObj(*mut std::ffi::c_void);
impl Drop for ScopedGdiObj {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                DeleteObject(self.0);
            }
        }
    }
}

/// Capture the native hardware `EpilodMpvSurface` window via `PrintWindow(PW_RENDERFULLCONTENT)`
/// and downsample via GDI HALFTONE StretchBlt into `[u16 LE width, u16 LE height, RGBA...]`.
/// Runs off the UI thread so DWM readback never blocks WebView2 or window input messages.
pub fn capture_child_backdrop_rgba(
    hwnd: isize,
    max_width: i32,
    max_height: i32,
    closing: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if hwnd == 0 || closing.load(Ordering::Acquire) {
        return Ok(Vec::new());
    }
    const PW_RENDERFULLCONTENT: u32 = 2;

    unsafe {
        let hwnd_ptr = hwnd as HWND;
        if IsWindow(hwnd_ptr) == 0 || IsWindowVisible(hwnd_ptr) == 0 {
            return Ok(Vec::new());
        }
        if closing.load(Ordering::Acquire) {
            return Ok(Vec::new());
        }

        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetClientRect(hwnd_ptr, &mut rect) == 0 {
            return Ok(Vec::new());
        }
        let src_w = rect.right - rect.left;
        let src_h = rect.bottom - rect.top;
        if src_w < 8 || src_h < 8 {
            return Ok(Vec::new());
        }

        let dst_w = max_width.clamp(64, 480).min(src_w);
        let dst_h = max_height.clamp(36, 270).min(src_h);

        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err("GetDC failed".to_string());
        }
        let _screen_guard = ScopedScreenDc(screen_dc);

        let full_dc = ScopedDc(CreateCompatibleDC(screen_dc));
        let dst_dc = ScopedDc(CreateCompatibleDC(screen_dc));
        if full_dc.0.is_null() || dst_dc.0.is_null() {
            return Err("CreateCompatibleDC failed".to_string());
        }

        let full_bmp = ScopedGdiObj(CreateCompatibleBitmap(screen_dc, src_w, src_h));
        if full_bmp.0.is_null() {
            return Err("CreateCompatibleBitmap failed".to_string());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: dst_w,
                biHeight: -dst_h, // Negative height = top-down row order matching HTML Canvas ImageData
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [std::mem::zeroed()],
        };

        let mut dib_bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dst_bmp = ScopedGdiObj(CreateDIBSection(
            dst_dc.0,
            &bmi,
            DIB_RGB_COLORS,
            &mut dib_bits,
            std::ptr::null_mut(),
            0,
        ));
        if dst_bmp.0.is_null() || dib_bits.is_null() {
            return Err("CreateDIBSection failed".to_string());
        }

        let old_full = SelectObject(full_dc.0, full_bmp.0);
        let old_dst = SelectObject(dst_dc.0, dst_bmp.0);

        let pw_ok = PrintWindow(hwnd_ptr, full_dc.0, PW_RENDERFULLCONTENT);
        let mut out = Vec::new();

        if pw_ok != 0 {
            SetStretchBltMode(dst_dc.0, HALFTONE);
            SetBrushOrgEx(dst_dc.0, 0, 0, std::ptr::null_mut());
            let blt_ok = StretchBlt(
                dst_dc.0, 0, 0, dst_w, dst_h, full_dc.0, 0, 0, src_w, src_h, SRCCOPY,
            );
            if blt_ok != 0 {
                let px_count = (dst_w as usize) * (dst_h as usize);
                let src_slice = std::slice::from_raw_parts(dib_bits as *const u8, px_count * 4);
                out.resize(4 + px_count * 4, 0);
                let w_bytes = (dst_w as u16).to_le_bytes();
                let h_bytes = (dst_h as u16).to_le_bytes();
                out[0] = w_bytes[0];
                out[1] = w_bytes[1];
                out[2] = h_bytes[0];
                out[3] = h_bytes[1];
                let mut max_channel = 0u8;
                for i in 0..px_count {
                    let s = i * 4;
                    let d = 4 + s;
                    let r = src_slice[s + 2];
                    let g = src_slice[s + 1];
                    let b = src_slice[s];
                    max_channel = max_channel.max(r).max(g).max(b);
                    // GDI 32bpp DIB is BGRA; force opaque alpha so Canvas composite sees solid pixels.
                    out[d] = r;
                    out[d + 1] = g;
                    out[d + 2] = b;
                    out[d + 3] = 255;
                }
                if max_channel <= 2 {
                    out.clear();
                }
            }
        }

        if !old_full.is_null() {
            SelectObject(full_dc.0, old_full);
        }
        if !old_dst.is_null() {
            SelectObject(dst_dc.0, old_dst);
        }

        Ok(out)
    }
}
