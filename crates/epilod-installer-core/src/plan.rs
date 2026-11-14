use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const APP_NAME: &str = "Epilod Party";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_REQUIRED_BYTES: u64 = 124 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComponentId {
    Core,
    Mpv,
    Fonts,
    Syncplay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TileId {
    Mpv,
    AutoSync,
    Syncplay,
    StartTls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepId {
    MpvEngine,
    FontsAndAutosync,
    SyncplayAndSystem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Pending,
    Active,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallMode {
    Install,
    Repair,
    Update,
    Uninstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallPhase {
    Ready,
    Preflight,
    VerifyingExisting,
    UnpackingCore,
    UnpackingMpv,
    UnpackingFonts,
    BackingUp,
    ConfiguringSyncplay,
    IntegratingWindows,
    Finalizing,
    RollingBack,
    RemovingFiles,
    CleaningRegistry,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub install_dir: String,
    pub create_desktop_shortcut: bool,
    pub create_start_menu_shortcut: bool,
    pub register_file_associations: bool,
    pub auto_launch: bool,
    #[serde(default)]
    pub force_reunpack: bool,
    #[serde(default)]
    pub wait_pid: Option<u32>,
    #[serde(default)]
    pub force_close_running: bool,
    #[serde(default)]
    pub allow_downgrade: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            install_dir: default_install_dir_string(),
            create_desktop_shortcut: true,
            create_start_menu_shortcut: true,
            register_file_associations: true,
            auto_launch: false,
            force_reunpack: false,
            wait_pid: None,
            force_close_running: false,
            allow_downgrade: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOptions {
    pub install_dir: String,
    pub remove_user_data: bool,
    #[serde(default)]
    pub force_close_running: bool,
    #[serde(default)]
    pub silent: bool,
}

impl Default for UninstallOptions {
    fn default() -> Self {
        Self {
            install_dir: default_install_dir_string(),
            remove_user_data: false,
            force_close_running: true,
            silent: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallSummary {
    pub install_dir: String,
    pub removed_files: usize,
    pub removed_dirs: usize,
    pub skipped_unrelated_files: usize,
    pub kept_unrelated_paths: Vec<String>,
    pub removed_shortcuts: usize,
    pub removed_registry: bool,
    pub removed_user_data: bool,
    pub scheduled_self_cleanup: bool,
    pub closed_processes: usize,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepProgress {
    pub id: StepId,
    pub title: String,
    pub detail: String,
    pub right_label: String,
    pub state: StepState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallTelemetry {
    pub phase: InstallPhase,
    pub overall_percent: f64,
    pub headline: String,
    pub live_status: String,
    pub active_tile: Option<TileId>,
    pub completed_tiles: Vec<TileId>,
    pub steps: [StepProgress; 3],
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub current_file: Option<String>,
    pub install_dir: String,
    pub finished: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCliArgs {
    pub mode: InstallMode,
    pub install_dir: Option<String>,
    pub wait_pid: Option<u32>,
    pub relaunch: bool,
    pub silent: bool,
    pub remove_user_data: bool,
    pub allow_downgrade: bool,
}

fn is_cli_flag(token: &str) -> bool {
    let trimmed = token.trim();
    trimmed.starts_with('-') || trimmed.eq_ignore_ascii_case("/s")
}

fn path_file_stem(raw: &str) -> Option<&str> {
    let trimmed = raw.trim().trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return None;
    }
    let file_part = trimmed
        .rsplit_once(['\\', '/'])
        .map(|(_, f)| f)
        .unwrap_or(trimmed);
    if let Some((stem, _ext)) = file_part.rsplit_once('.') {
        if !stem.is_empty() {
            return Some(stem);
        }
    }
    Some(file_part)
}

fn path_parent_dir(raw: &str) -> Option<&str> {
    let trimmed = raw.trim().trim_end_matches(['\\', '/']);
    let (parent, _) = trimmed.rsplit_once(['\\', '/'])?;
    let clean = parent.trim();
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

fn is_uninstaller_binary_str(raw: &str) -> bool {
    let Some(stem) = path_file_stem(raw) else {
        return false;
    };
    let lower = stem.trim().to_ascii_lowercase();
    lower == "epilod-uninstall" || lower.starts_with("epilod-uninstall-")
}

pub fn parse_setup_cli_args(args: &[String]) -> ParsedCliArgs {
    parse_setup_cli_args_with_exe(args, None)
}

pub fn parse_setup_cli_args_with_exe(args: &[String], current_exe: Option<&Path>) -> ParsedCliArgs {
    let mut mode = InstallMode::Install;
    let mut explicit_mode = false;
    let mut install_dir: Option<String> = None;
    let mut wait_pid: Option<u32> = None;
    let mut relaunch = false;
    let mut silent = false;
    let mut remove_user_data = false;
    let mut allow_downgrade = false;

    let mut i = 1usize;
    while i < args.len() {
        let arg = args[i].trim();
        if arg.eq_ignore_ascii_case("--uninstall") {
            mode = InstallMode::Uninstall;
            explicit_mode = true;
            if let Some(next) = args.get(i + 1) {
                let next_trim = next.trim();
                if !next_trim.is_empty() && !is_cli_flag(next_trim) {
                    install_dir = Some(next_trim.to_string());
                    i += 1;
                }
            }
        } else if arg.eq_ignore_ascii_case("--install") {
            mode = InstallMode::Install;
            explicit_mode = true;
        } else if arg.eq_ignore_ascii_case("--update") {
            mode = InstallMode::Update;
            explicit_mode = true;
        } else if arg.eq_ignore_ascii_case("--repair") {
            mode = InstallMode::Repair;
            explicit_mode = true;
        } else if arg.eq_ignore_ascii_case("--dir") {
            if let Some(next) = args.get(i + 1) {
                let next_trim = next.trim();
                if !next_trim.is_empty() && !is_cli_flag(next_trim) {
                    install_dir = Some(next_trim.to_string());
                    i += 1;
                }
            }
        } else if arg.eq_ignore_ascii_case("--wait-pid") {
            if let Some(next) = args.get(i + 1) {
                if let Ok(pid) = next.trim().parse::<u32>() {
                    wait_pid = Some(pid);
                    i += 1;
                }
            }
        } else if arg.eq_ignore_ascii_case("--relaunch") {
            relaunch = true;
        } else if arg.eq_ignore_ascii_case("--silent") || arg.eq_ignore_ascii_case("/s") {
            silent = true;
        } else if arg.eq_ignore_ascii_case("--remove-user-data") {
            remove_user_data = true;
        } else if arg.eq_ignore_ascii_case("--allow-downgrade") {
            allow_downgrade = true;
        }
        i += 1;
    }

    let current_exe_str = current_exe.map(|p| p.to_string_lossy().into_owned());
    let arg0_str = args
        .first()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let resolved_exe_str = current_exe_str.as_deref().or(arg0_str.as_deref());

    let running_as_uninstaller = resolved_exe_str
        .map(is_uninstaller_binary_str)
        .unwrap_or(false)
        || arg0_str
            .as_deref()
            .map(is_uninstaller_binary_str)
            .unwrap_or(false);

    if !explicit_mode && running_as_uninstaller {
        mode = InstallMode::Uninstall;
    }

    // Whenever running as `epilod-uninstall.exe` without an explicit directory (even when
    // invoked via `.\epilod-uninstall.exe` or `epilod-uninstall.exe --uninstall --silent`),
    // anchor install_dir to the executable's own folder rather than falling back to defaults.
    if running_as_uninstaller && mode == InstallMode::Uninstall && install_dir.is_none() {
        if let Some(exe_str) = resolved_exe_str {
            if let Some(parent_str) = path_parent_dir(exe_str) {
                if resolve_install_dir(parent_str).is_ok() {
                    install_dir = Some(parent_str.to_string());
                }
            }
        }
    }

    ParsedCliArgs {
        mode,
        install_dir,
        wait_pid,
        relaunch,
        silent,
        remove_user_data,
        allow_downgrade,
    }
}

pub fn default_install_dir_string() -> String {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local_str = local.to_string_lossy().trim().to_string();
        if !local_str.is_empty() {
            return Path::new(&local_str)
                .join(APP_NAME)
                .to_string_lossy()
                .into_owned();
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let prof_str = profile.to_string_lossy().trim().to_string();
        if !prof_str.is_empty() {
            return Path::new(&prof_str)
                .join("AppData")
                .join("Local")
                .join(APP_NAME)
                .to_string_lossy()
                .into_owned();
        }
    }
    r"%LocalAppData%\Epilod Party".to_string()
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PlanValidationError {
    #[error("Install path cannot be empty.")]
    EmptyPath,
    #[error("Install path contains unsupported control, wildcard, or bidi characters.")]
    InvalidChars,
    #[error("Install path must not contain relative '..' or '.' traversal segments.")]
    TraversalSegment,
    #[error("Install path cannot target a network UNC share or device namespace.")]
    NetworkOrDevicePath,
    #[error("Install path must be an absolute local directory or %LocalAppData% path.")]
    NotAbsolute,
    #[error("Install path references an unresolved environment variable: {0}")]
    UnresolvedEnvVar(String),
    #[error(
        "Install path must target a dedicated subfolder, not a drive root or system directory."
    )]
    UnsafeRootDir,
}

/// Expands `%VAR%` placeholders using the supplied lookup function (case-insensitive on common Windows vars).
pub fn expand_windows_env_vars_with<F>(raw: &str, mut lookup: F) -> String
where
    F: FnMut(&str) -> Option<String>,
{
    let mut out = String::with_capacity(raw.len());
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' {
            if let Some(end_rel) = chars[i + 1..].iter().position(|&c| c == '%') {
                let end = i + 1 + end_rel;
                let var_name: String = chars[i + 1..end].iter().collect();
                if !var_name.is_empty()
                    && var_name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'(' || b == b')')
                {
                    if let Some(val) = lookup(&var_name)
                        .or_else(|| lookup(&var_name.to_ascii_uppercase()))
                        .or_else(|| lookup(&var_name.to_ascii_lowercase()))
                    {
                        if !val.trim().is_empty() {
                            out.push_str(val.trim().trim_end_matches(['\\', '/']));
                            i = end + 1;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn expand_windows_env_vars(raw: &str) -> String {
    expand_windows_env_vars_with(raw, |key| std::env::var(key).ok())
}

fn first_unresolved_env_var(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(end_rel) = bytes[i + 1..].iter().position(|&b| b == b'%') {
                let name = &s[i + 1..i + 1 + end_rel];
                if !name.is_empty()
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'(' || b == b')')
                {
                    return Some(format!("%{name}%"));
                }
            }
        }
        i += 1;
    }
    None
}

fn collapse_repeated_backslashes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_bs = false;
    for ch in s.chars() {
        if ch == '\\' {
            if !prev_bs {
                out.push('\\');
                prev_bs = true;
            }
        } else {
            out.push(ch);
            prev_bs = false;
        }
    }
    out
}

fn is_unsafe_system_or_root_path(normalized: &str) -> bool {
    let trimmed = normalized.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return true;
    }
    // Unix `/`
    if normalized == "/" {
        return true;
    }
    // Bare drive root like `C:` or `C:\`
    let b = trimmed.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return true;
    }

    let lower = collapse_repeated_backslashes(&trimmed.replace('/', r"\")).to_ascii_lowercase();
    let lb = lower.as_bytes();
    if lb.len() >= 3 && lb[0].is_ascii_alphabetic() && lb[1] == b':' && lb[2] == b'\\' {
        let tail = &lower[3..];
        if tail == "windows"
            || tail.starts_with(r"windows\")
            || matches!(
                tail,
                "program files" | "program files (x86)" | "programdata" | "users"
            )
        {
            return true;
        }
    }

    if lower.starts_with(r"%systemroot%\") || lower.starts_with(r"%windir%\") {
        return true;
    }

    let forbidden_exact = [
        r"%localappdata%",
        r"%appdata%",
        r"%userprofile%",
        r"%programfiles%",
        r"%programfiles(x86)%",
        r"%programdata%",
        r"%systemroot%",
        r"%windir%",
        r"/usr",
        r"/bin",
        r"/etc",
        r"/var",
    ];
    if forbidden_exact.contains(&lower.as_str()) {
        return true;
    }

    for env_key in ["SystemRoot", "WINDIR"] {
        if let Ok(val) = std::env::var(env_key) {
            let sys = collapse_repeated_backslashes(&val.trim().replace('/', r"\"))
                .trim_end_matches('\\')
                .to_ascii_lowercase();
            if !sys.is_empty() && (lower == sys || lower.starts_with(&format!(r"{sys}\"))) {
                return true;
            }
        }
    }
    for env_key in [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
    ] {
        if let Ok(val) = std::env::var(env_key) {
            let pf = collapse_repeated_backslashes(&val.trim().replace('/', r"\"))
                .trim_end_matches('\\')
                .to_ascii_lowercase();
            if !pf.is_empty() && lower == pf {
                return true;
            }
        }
    }

    // Reject installing directly into bare AppData\Local without an app subfolder
    if lower.ends_with(r"\appdata\local") || lower.ends_with(r"\appdata\roaming") {
        return true;
    }

    false
}

/// Validates syntactic safety of an install directory string (allows `%LocalAppData%\...` placeholders).
pub fn validate_install_dir(raw: &str) -> Result<String, PlanValidationError> {
    validate_install_dir_syntax(raw)
}

fn validate_install_dir_syntax(raw: &str) -> Result<String, PlanValidationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PlanValidationError::EmptyPath);
    }

    // Reject '%' outside valid %VAR% segments? No, allow `%VAR%` during syntax check; resolve step enforces expansion.
    let bytes = trimmed.as_bytes();
    let has_drive_colon = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';

    for (idx, c) in trimmed.char_indices() {
        if c.is_control()
            || matches!(
                c,
                '\u{202A}'..='\u{202E}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{200E}'
                    | '\u{200F}'
                    | '\u{200B}'..='\u{200D}'
                    | '\u{FEFF}'
            )
            || matches!(c, '<' | '>' | '"' | '|' | '?' | '*')
        {
            return Err(PlanValidationError::InvalidChars);
        }
        if c == ':' && (!has_drive_colon || idx != 1) {
            return Err(PlanValidationError::InvalidChars);
        }
    }

    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return Err(PlanValidationError::NetworkOrDevicePath);
    }

    let normalized = trimmed.replace('/', r"\");
    for seg in normalized.split('\\') {
        if seg == ".." || seg == "." {
            return Err(PlanValidationError::TraversalSegment);
        }
    }

    let n_bytes = normalized.as_bytes();
    let is_windows_abs = n_bytes.len() >= 3
        && n_bytes[0].is_ascii_alphabetic()
        && n_bytes[1] == b':'
        && n_bytes[2] == b'\\';
    let is_env_abs = normalized.starts_with('%') && normalized.contains(r"\");
    let is_unix_abs = trimmed.starts_with('/');

    if !is_windows_abs && !is_env_abs && !is_unix_abs {
        return Err(PlanValidationError::NotAbsolute);
    }

    let candidate = if is_windows_abs || is_env_abs {
        collapse_repeated_backslashes(&normalized)
    } else {
        trimmed.to_string()
    };

    if is_unsafe_system_or_root_path(&candidate) {
        return Err(PlanValidationError::UnsafeRootDir);
    }

    let cleaned = trim_trailing_separators(&candidate);
    Ok(cleaned)
}

/// Expands Windows env vars AND validates the concrete filesystem path before touching disk.
pub fn resolve_install_dir_with_env<F>(raw: &str, lookup: F) -> Result<String, PlanValidationError>
where
    F: FnMut(&str) -> Option<String>,
{
    let syntax_ok = validate_install_dir_syntax(raw)?;
    let expanded = expand_windows_env_vars_with(&syntax_ok, lookup);
    if let Some(unresolved) = first_unresolved_env_var(&expanded) {
        return Err(PlanValidationError::UnresolvedEnvVar(unresolved));
    }
    validate_install_dir_syntax(&expanded)
}

pub fn resolve_install_dir(raw: &str) -> Result<String, PlanValidationError> {
    resolve_install_dir_with_env(raw, |key| std::env::var(key).ok())
}

fn trim_trailing_separators(path: &str) -> String {
    if path == "/" {
        return path.to_string();
    }
    let bytes = path.as_bytes();
    if bytes.len() == 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
        return path.to_string();
    }
    path.trim_end_matches(['\\', '/']).to_string()
}

pub fn resolve_install_path(raw: &str) -> Result<PathBuf, PlanValidationError> {
    resolve_install_dir(raw).map(PathBuf::from)
}

pub fn format_bytes_pair(done: u64, total: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const KB: f64 = 1024.0;
    if total >= 1024 * 1024 {
        format!("{:.1} / {:.1} MB", done as f64 / MB, total as f64 / MB)
    } else if total >= 1024 {
        format!("{:.0} / {:.0} KB", done as f64 / KB, total as f64 / KB)
    } else {
        format!("{done} / {total} B")
    }
}

pub fn compute_weighted_percent(
    phase: InstallPhase,
    bytes_done: u64,
    bytes_total: u64,
    post_step: usize,
    post_total: usize,
) -> f64 {
    match phase {
        InstallPhase::Ready => 0.0,
        InstallPhase::Preflight => 4.0,
        InstallPhase::VerifyingExisting => {
            if bytes_total == 0 {
                8.0
            } else {
                let ratio = (bytes_done as f64 / bytes_total as f64).clamp(0.0, 1.0);
                4.0 + ratio * 6.0
            }
        }
        InstallPhase::UnpackingCore | InstallPhase::UnpackingMpv | InstallPhase::UnpackingFonts => {
            if bytes_total == 0 {
                45.0
            } else {
                let ratio = (bytes_done as f64 / bytes_total as f64).clamp(0.0, 1.0);
                10.0 + ratio * 68.0
            }
        }
        InstallPhase::BackingUp => 80.0,
        InstallPhase::ConfiguringSyncplay => 85.0,
        InstallPhase::IntegratingWindows => {
            if post_total == 0 {
                92.0
            } else {
                let ratio = (post_step as f64 / post_total as f64).clamp(0.0, 1.0);
                86.0 + ratio * 10.0
            }
        }
        InstallPhase::Finalizing => 98.0,
        InstallPhase::RemovingFiles => {
            let ratio = if post_total == 0 {
                0.5
            } else {
                (post_step as f64 / post_total as f64).clamp(0.0, 1.0)
            };
            15.0 + ratio * 55.0
        }
        InstallPhase::CleaningRegistry => {
            let ratio = if post_total == 0 {
                0.5
            } else {
                (post_step as f64 / post_total as f64).clamp(0.0, 1.0)
            };
            70.0 + ratio * 26.0
        }
        InstallPhase::RollingBack => 12.0,
        InstallPhase::Complete => 100.0,
        InstallPhase::Cancelled | InstallPhase::Failed => 0.0,
    }
}

pub fn build_ready_telemetry(
    install_dir: &str,
    files_total: usize,
    bytes_total: u64,
) -> InstallTelemetry {
    InstallTelemetry {
        phase: InstallPhase::Ready,
        overall_percent: 0.0,
        headline: "Ready to install".to_string(),
        live_status: format!("Epilod Party v{APP_VERSION} is ready for Windows setup"),
        active_tile: None,
        completed_tiles: Vec::new(),
        steps: [
            StepProgress {
                id: StepId::MpvEngine,
                title: "mpv Playback Engine".to_string(),
                detail: "Embedded Win32 HWND player".to_string(),
                right_label: "Queued".to_string(),
                state: StepState::Pending,
            },
            StepProgress {
                id: StepId::FontsAndAutosync,
                title: "FFmpeg & Arabic Fonts".to_string(),
                detail: "Inter + Noto Arabic Auto-Sync".to_string(),
                right_label: "Queued".to_string(),
                state: StepState::Pending,
            },
            StepProgress {
                id: StepId::SyncplayAndSystem,
                title: "Syncplay TLS & Shortcuts".to_string(),
                detail: "STARTTLS & desktop integration".to_string(),
                right_label: "Queued".to_string(),
                state: StepState::Pending,
            },
        ],
        bytes_done: 0,
        bytes_total,
        files_done: 0,
        files_total,
        current_file: None,
        install_dir: install_dir.to_string(),
        finished: false,
        cancelled: false,
        error: None,
    }
}

pub fn build_uninstall_ready_telemetry(
    install_dir: &str,
    files_total: usize,
    bytes_total: u64,
) -> InstallTelemetry {
    InstallTelemetry {
        phase: InstallPhase::Ready,
        overall_percent: 0.0,
        headline: "Uninstall Epilod Party".to_string(),
        live_status: "Ready to safely remove Epilod Party components".to_string(),
        active_tile: None,
        completed_tiles: Vec::new(),
        steps: [
            StepProgress {
                id: StepId::MpvEngine,
                title: "Verified App Files".to_string(),
                detail: "Scoped removal · keeps user files".to_string(),
                right_label: "Queued".to_string(),
                state: StepState::Pending,
            },
            StepProgress {
                id: StepId::FontsAndAutosync,
                title: "Shortcuts & Registry".to_string(),
                detail: "Desktop, Start Menu & HKCU".to_string(),
                right_label: "Queued".to_string(),
                state: StepState::Pending,
            },
            StepProgress {
                id: StepId::SyncplayAndSystem,
                title: "Finalize Cleanup".to_string(),
                detail: "Empty folders & self-cleanup".to_string(),
                right_label: "Queued".to_string(),
                state: StepState::Pending,
            },
        ],
        bytes_done: 0,
        bytes_total,
        files_done: 0,
        files_total,
        current_file: None,
        install_dir: install_dir.to_string(),
        finished: false,
        cancelled: false,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_install_dirs_and_blocks_unsafe_paths() {
        assert!(validate_install_dir(r"C:\Users\Ahmed\AppData\Local\Epilod Party").is_ok());
        assert!(validate_install_dir(r"%LocalAppData%\Epilod Party").is_ok());
        assert!(validate_install_dir("/tmp/epilod-party").is_ok());
        assert_eq!(
            validate_install_dir("D:/Apps/Epilod Party/"),
            Ok(r"D:\Apps\Epilod Party".to_string())
        );
        assert!(validate_install_dir(r"C:\Program Files\Epilod Party").is_ok());

        assert_eq!(
            validate_install_dir("   "),
            Err(PlanValidationError::EmptyPath)
        );
        assert_eq!(
            validate_install_dir(r"\\server\share\Epilod"),
            Err(PlanValidationError::NetworkOrDevicePath)
        );
        assert_eq!(
            validate_install_dir(r"C:\Users\Ahmed\..\Windows\Epilod"),
            Err(PlanValidationError::TraversalSegment)
        );
        assert_eq!(
            validate_install_dir("relative/path"),
            Err(PlanValidationError::NotAbsolute)
        );
        assert_eq!(
            validate_install_dir("C:\\Users\\bad\u{202E}path"),
            Err(PlanValidationError::InvalidChars)
        );
        assert_eq!(
            validate_install_dir(r"C:\"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir(r"C:\Windows"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir(r"D:\Windows\MyApp"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir("E:/Windows/System32"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir(r"D:\Program Files"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir(r"D:\Program Files (x86)"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir(r"D:\ProgramData"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir(r"D:\Users"),
            Err(PlanValidationError::UnsafeRootDir)
        );
        assert_eq!(
            validate_install_dir(r"C:\Users\Ahmed\AppData\Local"),
            Err(PlanValidationError::UnsafeRootDir)
        );
    }

    #[test]
    fn expands_windows_env_vars_and_rejects_unresolved_placeholders() {
        let resolved = resolve_install_dir_with_env(r"%LocalAppData%\Epilod Party", |k| match k {
            "LOCALAPPDATA" => Some(r"C:\Users\Ahmed\AppData\Local".to_string()),
            _ => None,
        })
        .unwrap();
        assert_eq!(resolved, r"C:\Users\Ahmed\AppData\Local\Epilod Party");

        let unresolved = resolve_install_dir_with_env(r"%MISSING_VAR%\Epilod Party", |_| None);
        assert_eq!(
            unresolved,
            Err(PlanValidationError::UnresolvedEnvVar(
                "%MISSING_VAR%".to_string()
            ))
        );

        let unresolved_parens =
            resolve_install_dir_with_env(r"%ProgramFiles(x86)%\Epilod Party", |_| None);
        assert_eq!(
            unresolved_parens,
            Err(PlanValidationError::UnresolvedEnvVar(
                "%ProgramFiles(x86)%".to_string()
            ))
        );

        let args = vec![
            r"C:\Setup.exe".into(),
            "--install".into(),
            "--silent".into(),
            "--allow-downgrade".into(),
        ];
        assert!(parse_setup_cli_args(&args).allow_downgrade);
    }

    #[test]
    fn cli_arg_parser_handles_install_update_and_uninstall_modes() {
        let update_args = vec![
            r"C:\Temp\Epilod Party Setup.exe".into(),
            "--update".into(),
            "--dir".into(),
            r"C:\Users\Ahmed\AppData\Local\Epilod Party".into(),
            "--wait-pid".into(),
            "4242".into(),
            "--relaunch".into(),
        ];
        let parsed = parse_setup_cli_args(&update_args);
        assert_eq!(parsed.mode, InstallMode::Update);
        assert_eq!(
            parsed.install_dir.as_deref(),
            Some(r"C:\Users\Ahmed\AppData\Local\Epilod Party")
        );
        assert_eq!(parsed.wait_pid, Some(4242));
        assert!(parsed.relaunch);
        assert!(!parsed.silent);

        let silent_uninstall = vec![
            r"C:\Users\Ahmed\AppData\Local\Epilod Party\epilod-uninstall.exe".into(),
            "--uninstall".into(),
            r"C:\Users\Ahmed\AppData\Local\Epilod Party".into(),
            "--silent".into(),
            "--remove-user-data".into(),
        ];
        let parsed_un = parse_setup_cli_args(&silent_uninstall);
        assert_eq!(parsed_un.mode, InstallMode::Uninstall);
        assert!(parsed_un.silent);
        assert!(parsed_un.remove_user_data);

        // Double-clicking epilod-uninstall.exe directly with no flags defaults safely to Uninstall GUI
        let direct_un = vec![r"C:\Apps\Epilod Party\epilod-uninstall.exe".into()];
        let parsed_direct = parse_setup_cli_args(&direct_un);
        assert_eq!(parsed_direct.mode, InstallMode::Uninstall);
        assert_eq!(
            parsed_direct.install_dir.as_deref(),
            Some(r"C:\Apps\Epilod Party")
        );
    }

    #[test]
    fn cli_parser_resolves_exe_dir_on_relative_or_flagless_uninstall_and_avoids_substring_false_positive(
    ) {
        // Relative `.\epilod-uninstall.exe` uses resolved `current_exe` parent
        let rel_un = vec![r".\epilod-uninstall.exe".into()];
        let resolved_exe = Path::new(r"D:\Custom\Epilod Party\epilod-uninstall.exe");
        let parsed_rel = parse_setup_cli_args_with_exe(&rel_un, Some(resolved_exe));
        assert_eq!(parsed_rel.mode, InstallMode::Uninstall);
        assert_eq!(
            parsed_rel.install_dir.as_deref(),
            Some(r"D:\Custom\Epilod Party")
        );

        // `epilod-uninstall.exe --uninstall --silent` and `/S` do NOT swallow flags as dir and still resolve exe dir
        let flagless_dir = vec![
            "epilod-uninstall.exe".into(),
            "--uninstall".into(),
            "/S".into(),
        ];
        let parsed_flagless = parse_setup_cli_args_with_exe(&flagless_dir, Some(resolved_exe));
        assert_eq!(parsed_flagless.mode, InstallMode::Uninstall);
        assert!(parsed_flagless.silent);
        assert_eq!(
            parsed_flagless.install_dir.as_deref(),
            Some(r"D:\Custom\Epilod Party")
        );

        // Substring like "Setup_no_uninstall.exe" must NOT trigger Uninstall mode
        let renamed_setup = vec![r"C:\Downloads\Setup_no_uninstall.exe".into()];
        let parsed_renamed = parse_setup_cli_args(&renamed_setup);
        assert_eq!(parsed_renamed.mode, InstallMode::Install);
        assert!(parsed_renamed.install_dir.is_none());

        // Silent repair / install flags
        let silent_repair = vec![
            r"C:\Downloads\Epilod Party Setup.exe".into(),
            "--repair".into(),
            "--silent".into(),
        ];
        let parsed_repair = parse_setup_cli_args(&silent_repair);
        assert_eq!(parsed_repair.mode, InstallMode::Repair);
        assert!(parsed_repair.silent);
    }

    #[test]
    fn weighted_progress_stays_monotonic_and_bounded() {
        let p0 = compute_weighted_percent(InstallPhase::Ready, 0, 100, 0, 3);
        let p1 = compute_weighted_percent(InstallPhase::Preflight, 0, 100, 0, 3);
        let p1b = compute_weighted_percent(InstallPhase::VerifyingExisting, 50, 100, 0, 3);
        let p2 = compute_weighted_percent(InstallPhase::UnpackingCore, 25, 100, 0, 3);
        let p3 = compute_weighted_percent(InstallPhase::UnpackingMpv, 75, 100, 0, 3);
        let p4 = compute_weighted_percent(InstallPhase::UnpackingFonts, 100, 100, 0, 3);
        let p4b = compute_weighted_percent(InstallPhase::BackingUp, 100, 100, 0, 3);
        let p5 = compute_weighted_percent(InstallPhase::ConfiguringSyncplay, 100, 100, 0, 3);
        let p6 = compute_weighted_percent(InstallPhase::IntegratingWindows, 100, 100, 2, 3);
        let p7 = compute_weighted_percent(InstallPhase::Finalizing, 100, 100, 3, 3);
        let p8 = compute_weighted_percent(InstallPhase::Complete, 100, 100, 3, 3);

        let all = [p0, p1, p1b, p2, p3, p4, p4b, p5, p6, p7, p8];
        for win in all.windows(2) {
            assert!(win[0] < win[1], "Expected {} < {}", win[0], win[1]);
        }
        assert_eq!(p0, 0.0);
        assert_eq!(p8, 100.0);
    }
}
