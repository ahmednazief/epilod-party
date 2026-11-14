#![cfg(windows)]

use std::ffi::c_void;
use std::sync::{mpsc, Once};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, RegisterClassExW,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, CS_DBLCLKS, GWLP_USERDATA, HWND_TOP,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE,
    WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_NCDESTROY, WM_PARENTNOTIFY, WNDCLASSEXW, WS_CHILD,
    WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

struct SurfaceContext {
    app: AppHandle,
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
                let _ = ctx.app.emit("mpv://surface-click", ());
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const SurfaceContext;
            if !ptr.is_null() {
                let ctx = &*ptr;
                let _ = ctx.app.emit("mpv://surface-dblclick", ());
            }
            0
        }
        WM_PARENTNOTIFY => {
            let event = (wparam & 0xFFFF) as u32;
            if event == WM_LBUTTONDOWN {
                let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const SurfaceContext;
                if !ptr.is_null() {
                    let ctx = &*ptr;
                    let _ = ctx.app.emit("mpv://surface-click", ());
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
                let ctx = Box::new(SurfaceContext { app: app_for_ctx });
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(ctx) as isize);
                Ok(hwnd as isize)
            }
        };
        let _ = tx.send(res);
    })
    .map_err(|e| format!("Failed dispatching child HWND creation to main UI thread: {e}"))?;

    rx.recv()
        .map_err(|_| "Main UI thread dropped child HWND creation result.".to_string())?
}

pub fn resize_child_hwnd(app: &AppHandle, hwnd: isize, rect: PhysicalRect) {
    if hwnd == 0 {
        return;
    }
    let w = rect.width.max(1);
    let h = rect.height.max(1);
    let _ = app.run_on_main_thread(move || unsafe {
        SetWindowPos(
            hwnd as HWND,
            HWND_TOP,
            rect.x,
            rect.y,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    });
}

pub fn set_child_visible(app: &AppHandle, hwnd: isize, visible: bool) {
    if hwnd == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        ShowWindow(
            hwnd as HWND,
            if visible { SW_SHOWNOACTIVATE } else { SW_HIDE },
        );
        if visible {
            SetWindowPos(
                hwnd as HWND,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    });
}

pub fn destroy_child_hwnd(app: &AppHandle, hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || unsafe {
        DestroyWindow(hwnd as HWND);
    });
}
