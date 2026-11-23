#![cfg(windows)]

use epilod_core::mpv_ipc::launch_args_with_fonts;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_STDERR_LINES: usize = 12;

#[derive(Default)]
pub struct MpvStderrTail {
    lines: Mutex<VecDeque<String>>,
}

impl MpvStderrTail {
    pub fn push(&self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let mut guard = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() >= MAX_STDERR_LINES {
            guard.pop_front();
        }
        guard.push_back(trimmed.chars().take(220).collect());
    }

    pub fn summary(&self) -> Option<String> {
        let guard = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_empty() {
            return None;
        }
        let joined: String = guard.iter().cloned().collect::<Vec<_>>().join(" | ");
        Some(joined.chars().take(500).collect())
    }
}

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

pub fn resolve_ffmpeg_exe(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(mpv_path) = resolve_mpv_exe(app) {
        if let Some(dir) = mpv_path.parent() {
            let candidate = dir.join("ffmpeg.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
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
) -> Result<(Child, Arc<MpvStderrTail>), String> {
    let fonts_str = fonts_dir.and_then(|p| p.to_str());
    let args = launch_args_with_fonts(wid, pipe_name, fonts_str);
    let mut cmd = Command::new(mpv_path);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start mpv.exe: {e}"))?;
    if let Some(pid) = child.id() {
        crate::job_object::assign_pid_to_kill_job(pid);
    }
    let stderr_tail = Arc::new(MpvStderrTail::default());
    if let Some(stderr) = child.stderr.take() {
        let tail_clone = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tail_clone.push(&line);
            }
        });
    }
    Ok((child, stderr_tail))
}
