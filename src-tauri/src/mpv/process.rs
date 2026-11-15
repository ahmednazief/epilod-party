#![cfg(windows)]

use epilod_core::mpv_ipc::launch_args_with_fonts;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::process::{Child, Command};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn resolve_mpv_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("resources").join("mpv").join("mpv.exe"));
        candidates.push(res_dir.join("mpv").join("mpv.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join("mpv").join("mpv.exe"));
            candidates.push(dir.join("mpv.exe"));
        }
    }
    for cand in candidates {
        if cand.is_file() {
            return Ok(cand);
        }
    }
    Err("mpv.exe not found in resources/mpv/. See scripts/fetch-mpv.ps1.".to_string())
}

pub fn resolve_fonts_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("resources").join("fonts"));
        candidates.push(res_dir.join("fonts"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join("fonts"));
        }
    }
    candidates.into_iter().find(|p| p.is_dir())
}

pub fn spawn_mpv(
    mpv_path: &Path,
    wid: u64,
    pipe_name: &str,
    fonts_dir: Option<&Path>,
) -> Result<Child, String> {
    let fonts_str = fonts_dir.and_then(|p| p.to_str());
    let args = launch_args_with_fonts(wid, pipe_name, fonts_str);
    let mut cmd = Command::new(mpv_path);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
        .map_err(|e| format!("Failed to start mpv.exe: {e}"))
}
