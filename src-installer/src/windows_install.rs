use epilod_installer_core::archive::estimate_uninstaller_copy_bytes;
use epilod_installer_core::engine::{
    remove_dir_all_resilient, remove_file_resilient, CleanupReport, IntegrationResult,
    IntegrationSnapshot, SystemIntegrator,
};
use epilod_installer_core::plan::{
    default_install_dir_string, resolve_install_dir, InstallMode, InstallOptions, APP_NAME,
    APP_VERSION,
};
use epilod_installer_core::receipt::{
    inspect_existing_install, read_receipt, InstallDisposition, InstallReceipt,
    INSTALL_RECEIPT_FILENAME, UNINSTALLER_FILENAME,
};
use epilod_installer_core::semver::parse_semver;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::{c_void, OsStr};
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS,
    ERROR_FILE_NOT_FOUND, ERROR_INVALID_FUNCTION, ERROR_MORE_DATA, ERROR_NOT_SUPPORTED,
    ERROR_NO_MORE_ITEMS, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, HANDLE, HWND, INVALID_HANDLE_VALUE,
    LPARAM, S_OK, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    AccessCheck, DuplicateToken, MapGenericMask, SecurityImpersonation, DACL_SECURITY_INFORMATION,
    GENERIC_MAPPING, GROUP_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PRIVILEGE_SET,
    PSECURITY_DESCRIPTOR, TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_ALL_ACCESS,
    FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_WRITE_DATA,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegEnumValueW, RegOpenKeyExW, RegQueryValueExW,
    RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_DWORD,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    ReleaseMutex, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Programs, SHGetKnownFolderPath, ShellExecuteW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, MessageBoxW, PostMessageW, IDYES, MB_ICONERROR,
    MB_ICONWARNING, MB_OK, MB_YESNO, SW_SHOWNORMAL, WM_CLOSE,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const UNINSTALL_REG_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\EpilodParty";
const OPEN_WITH_APP_SUBKEY: &str = r"Software\Classes\Applications\Epilod Party.exe";
const INSTANCE_MUTEX_NAME: &str = r"Local\EpilodParty_Installer_Instance";
const WEBVIEW2_DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const REPO_URL: &str = "https://github.com/ahmednazief/epilod-party";

pub struct WindowsIntegrator;

#[derive(Debug, Clone)]
pub struct RunningProcessInfo {
    pub pid: u32,
    pub name: String,
    pub executable_path: String,
}

fn to_wide_null(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_str_to_string(slice: &[u16]) -> String {
    let len = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..len])
}

struct HandleGuard {
    handle: HANDLE,
}

impl HandleGuard {
    fn new(handle: HANDLE) -> Option<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self { handle })
        }
    }
}

impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

pub struct SingleInstanceGuard {
    handle: HANDLE,
    owns_mutex: bool,
}

impl SingleInstanceGuard {
    pub fn acquire(wait_for_handoff: bool) -> Result<Self, String> {
        let wide_name = to_wide_null(OsStr::new(INSTANCE_MUTEX_NAME));
        let handle = unsafe { CreateMutexW(ptr::null(), 0, wide_name.as_ptr()) };
        if handle.is_null() {
            let err = unsafe { GetLastError() };
            return Err(format!(
                "Failed creating installer single-instance lock (error {err})."
            ));
        }

        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if !already_exists {
            // Take immediate ownership when we created it cleanly.
            let wait = unsafe { WaitForSingleObject(handle, 0) };
            return Ok(Self {
                handle,
                owns_mutex: wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED,
            });
        }

        // Wait briefly for an outgoing handoff process in silent/update mode, and always recover
        // abandoned mutex ownership (`WAIT_ABANDONED`) left behind by a crashed prior setup process.
        let timeout_ms = if wait_for_handoff { 5_000 } else { 0 };
        let wait = unsafe { WaitForSingleObject(handle, timeout_ms) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            return Ok(Self {
                handle,
                owns_mutex: true,
            });
        }

        unsafe {
            let _ = CloseHandle(handle);
        }
        if wait == WAIT_TIMEOUT {
            return Err(if wait_for_handoff {
                "Another Epilod Party Setup or Uninstaller instance is already running.".to_string()
            } else {
                "Epilod Party Setup or Uninstaller is already running.".to_string()
            });
        }
        Err("Epilod Party Setup or Uninstaller is already running.".to_string())
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            if self.owns_mutex {
                let _ = ReleaseMutex(self.handle);
            }
            let _ = CloseHandle(self.handle);
        }
    }
}

pub fn attach_parent_console() {
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

pub fn show_error_dialog(title: &str, message: &str) {
    let wtitle = to_wide_null(OsStr::new(title));
    let wmsg = to_wide_null(OsStr::new(message));
    unsafe {
        MessageBoxW(
            ptr::null_mut(),
            wmsg.as_ptr(),
            wtitle.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

pub fn show_webview2_missing_dialog() {
    let wtitle = to_wide_null(OsStr::new("Epilod Party Setup — WebView2 Required"));
    let body =
        "Microsoft Edge WebView2 Runtime is required to display the Epilod Party Setup window.\n\n\
You can also install or uninstall without WebView2 using headless CLI flags (--silent).\n\n\
Would you like to open Microsoft's WebView2 Runtime download page now?";
    let wmsg = to_wide_null(OsStr::new(body));

    let choice = unsafe {
        MessageBoxW(
            ptr::null_mut(),
            wmsg.as_ptr(),
            wtitle.as_ptr(),
            MB_YESNO | MB_ICONWARNING,
        )
    };
    if choice == IDYES {
        let wop = to_wide_null(OsStr::new("open"));
        let wurl = to_wide_null(OsStr::new(WEBVIEW2_DOWNLOAD_URL));
        unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                wop.as_ptr(),
                wurl.as_ptr(),
                ptr::null(),
                ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
}

pub fn query_free_disk_bytes(path: &Path) -> Option<u64> {
    let mut probe = path;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let wide = to_wide_null(probe.as_os_str());
    let mut free_avail: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_avail,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok != 0 {
        Some(free_avail)
    } else {
        None
    }
}

pub fn is_protected_windows_dir(dir: &Path) -> bool {
    let norm = canonical_dir_key(dir);
    let mut protected_roots: Vec<String> = Vec::new();
    for env_key in [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "SystemRoot",
        "WINDIR",
    ] {
        if let Some(val) = std::env::var_os(env_key) {
            let key = canonical_dir_key(Path::new(&val));
            if !key.is_empty() {
                protected_roots.push(key);
            }
        }
    }
    for root in protected_roots {
        let root_prefix = format!("{root}\\");
        if norm == root || norm.starts_with(&root_prefix) {
            return true;
        }
    }
    false
}

fn nearest_existing_dir(dir: &Path) -> Option<PathBuf> {
    if dir.exists() {
        return Some(dir.to_path_buf());
    }
    let mut parent = dir.parent();
    while let Some(p) = parent {
        if p.exists() {
            return Some(p.to_path_buf());
        }
        parent = p.parent();
    }
    None
}

/// Non-destructive NTFS ACL check used during fast UI preflight so typing into arbitrary paths
/// never writes or deletes probe files on disk.
pub fn check_directory_acl_writable(dir: &Path) -> Result<(), String> {
    if dir.exists() && !dir.is_dir() {
        return Err(format!(
            "Destination {} exists as a file rather than a folder.",
            dir.display()
        ));
    }

    let Some(existing_dir) = nearest_existing_dir(dir) else {
        return Err(format!(
            "Drive or root for {} does not exist.",
            dir.display()
        ));
    };
    if !existing_dir.is_dir() {
        return Err(format!(
            "Parent path {} is not a directory.",
            existing_dir.display()
        ));
    }

    let wide_path = to_wide_null(existing_dir.as_os_str());
    let mut psd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let sec_status = unsafe {
        GetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut psd,
        )
    };

    if sec_status != ERROR_SUCCESS {
        if sec_status == ERROR_ACCESS_DENIED {
            return Err(format_permission_denied_message(dir));
        }
        if sec_status == ERROR_INVALID_FUNCTION || sec_status == ERROR_NOT_SUPPORTED {
            // Non-NTFS volumes (FAT32/exFAT/WebDAV) do not expose NTFS security descriptors;
            // fall back cleanly to the definitive probe on Verify/Install.
            return Ok(());
        }
        return Ok(());
    }

    struct SdGuard(PSECURITY_DESCRIPTOR);
    impl Drop for SdGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = LocalFree(self.0);
                }
            }
        }
    }
    let _sd_guard = SdGuard(psd);

    let mut proc_token: HANDLE = ptr::null_mut();
    let open_ok = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_IMPERSONATE | TOKEN_QUERY,
            &mut proc_token,
        )
    };
    let Some(_proc_token_guard) = HandleGuard::new(proc_token) else {
        return Ok(());
    };
    if open_ok == 0 {
        return Ok(());
    }

    let mut imp_token: HANDLE = ptr::null_mut();
    let dup_ok = unsafe { DuplicateToken(proc_token, SecurityImpersonation, &mut imp_token) };
    let Some(_imp_token_guard) = HandleGuard::new(imp_token) else {
        return Ok(());
    };
    if dup_ok == 0 {
        return Ok(());
    }

    let mut desired_access: u32 = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_WRITE_DATA;
    let generic_mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    unsafe {
        MapGenericMask(&mut desired_access, &generic_mapping);
    }

    let mut priv_set: PRIVILEGE_SET = unsafe { std::mem::zeroed() };
    let mut priv_len = std::mem::size_of::<PRIVILEGE_SET>() as u32;
    let mut granted_access: u32 = 0;
    let mut access_status: i32 = 0;

    let check_ok = unsafe {
        AccessCheck(
            psd,
            imp_token,
            desired_access,
            &generic_mapping,
            &mut priv_set,
            &mut priv_len,
            &mut granted_access,
            &mut access_status,
        )
    };

    if check_ok != 0 && access_status == 0 {
        return Err(format_permission_denied_message(dir));
    }
    if check_ok == 0 && unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
        return Err(format_permission_denied_message(dir));
    }

    Ok(())
}

fn format_permission_denied_message(dir: &Path) -> String {
    if is_protected_windows_dir(dir) {
        format!(
            "Administrator permission is required to write to {}. Choose a user folder such as %LocalAppData%\\Epilod Party or run Setup as Administrator.",
            dir.display()
        )
    } else {
        format!(
            "Destination folder {} is not writable for your account.",
            dir.display()
        )
    }
}

pub fn test_directory_writable(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        if !dir.is_dir() {
            return Err(format!(
                "Destination {} exists as a file rather than a folder.",
                dir.display()
            ));
        }
        let probe_file = dir.join(format!(".epilod-write-probe-{}", std::process::id()));
        if let Err(e) = fs::write(&probe_file, b"ok") {
            if is_protected_windows_dir(dir) {
                return Err(format_permission_denied_message(dir));
            }
            return Err(format!("Destination folder is not writable ({e})."));
        }
        let _ = fs::remove_file(&probe_file);
        return Ok(());
    }

    let Some(existing_parent) = nearest_existing_dir(dir) else {
        return Err(format!(
            "Drive or root for {} does not exist.",
            dir.display()
        ));
    };
    if !existing_parent.is_dir() {
        return Err(format!(
            "Parent path {} is not a directory.",
            existing_parent.display()
        ));
    }

    let probe = existing_parent.join(format!(".epilod-probe-{}", std::process::id()));
    if let Err(e) = fs::write(&probe, b"ok") {
        if is_protected_windows_dir(dir) || is_protected_windows_dir(&existing_parent) {
            return Err(format_permission_denied_message(dir));
        }
        return Err(format!("Destination folder is not writable ({e})."));
    }
    let _ = fs::remove_file(&probe);
    Ok(())
}

pub fn existing_install_detected(dir: &Path) -> bool {
    dir.join("Epilod Party.exe").is_file()
        || dir.join("epilod-party.exe").is_file()
        || dir.join(INSTALL_RECEIPT_FILENAME).is_file()
}

pub fn installed_exe_path(dir: &Path) -> Option<PathBuf> {
    let primary = dir.join("Epilod Party.exe");
    if primary.is_file() {
        return Some(primary);
    }
    let secondary = dir.join("epilod-party.exe");
    if secondary.is_file() {
        return Some(secondary);
    }
    None
}

pub fn local_user_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("EpilodParty"))
}

pub fn read_hkcu_install_location() -> Option<String> {
    let subkey = to_wide_null(OsStr::new(UNINSTALL_REG_SUBKEY));
    let mut hkey: HKEY = ptr::null_mut();
    let res = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) };
    if res != ERROR_SUCCESS {
        return None;
    }
    let val_name = to_wide_null(OsStr::new("InstallLocation"));
    let mut val_type: u32 = 0;
    let mut byte_len: u32 = 0;
    let q1 = unsafe {
        RegQueryValueExW(
            hkey,
            val_name.as_ptr(),
            ptr::null_mut(),
            &mut val_type,
            ptr::null_mut(),
            &mut byte_len,
        )
    };
    if q1 != ERROR_SUCCESS || val_type != REG_SZ || byte_len == 0 {
        unsafe {
            RegCloseKey(hkey);
        }
        return None;
    }

    let mut buf = vec![0u16; (byte_len as usize).div_ceil(2) + 1];
    let q2 = unsafe {
        RegQueryValueExW(
            hkey,
            val_name.as_ptr(),
            ptr::null_mut(),
            &mut val_type,
            buf.as_mut_ptr() as *mut u8,
            &mut byte_len,
        )
    };
    unsafe {
        RegCloseKey(hkey);
    }
    if q2 != ERROR_SUCCESS || val_type != REG_SZ {
        return None;
    }
    let raw = wide_str_to_string(&buf);
    resolve_install_dir(raw.trim()).ok()
}

fn strip_verbatim_prefix(raw: &str) -> String {
    if let Some(unc_tail) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc_tail}")
    } else if let Some(drive_tail) = raw.strip_prefix(r"\\?\") {
        drive_tail.to_string()
    } else {
        raw.to_string()
    }
}

/// Normalizes paths via filesystem canonicalization (when available on disk) and strips `\\?\`,
/// resolving 8.3 short paths (`AHMED~1`) and NTFS junctions for reliable prefix comparison.
fn canonical_dir_key(path: &Path) -> String {
    let resolved_path: PathBuf = if path.exists() {
        fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    } else {
        // Walk up to the longest existing ancestor, canonicalize that, then push trailing components.
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        let mut cur = Some(path);
        let mut base: Option<PathBuf> = None;
        while let Some(p) = cur {
            if p.exists() {
                base = fs::canonicalize(p).ok().or_else(|| Some(p.to_path_buf()));
                break;
            }
            if let Some(name) = p.file_name() {
                tail.push(name.to_os_string());
            } else {
                // Prefix/Root
                base = Some(p.to_path_buf());
                break;
            }
            cur = p.parent();
        }
        let mut rebuilt = base.unwrap_or_else(|| path.to_path_buf());
        for seg in tail.into_iter().rev() {
            rebuilt.push(seg);
        }
        rebuilt
    };

    let clean = strip_verbatim_prefix(&resolved_path.to_string_lossy());
    clean
        .replace('/', r"\")
        .trim_end_matches('\\')
        .to_lowercase()
}

#[derive(Debug, Clone)]
struct OsProcessRow {
    pid: u32,
    parent_pid: u32,
    exe_name: String,
    image_path: Option<String>,
    canonical_image_key: Option<String>,
}

fn query_process_image_path(pid: u32) -> Option<String> {
    let hproc = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    let _guard = HandleGuard::new(hproc)?;
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(hproc, 0, buf.as_mut_ptr(), &mut len) };
    if ok == 0 || len == 0 {
        return None;
    }
    let slice = &buf[..len as usize];
    Some(String::from_utf16_lossy(slice))
}

fn snapshot_all_processes() -> Vec<OsProcessRow> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    let Some(_snap_guard) = HandleGuard::new(snap) else {
        return Vec::new();
    };

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    if unsafe { Process32FirstW(snap, &mut entry) } == 0 {
        return Vec::new();
    }

    let self_pid = std::process::id();
    let mut rows = Vec::new();
    loop {
        let pid = entry.th32ProcessID;
        if pid != 0 && pid != 4 && pid != self_pid {
            let exe_name = wide_str_to_string(&entry.szExeFile);
            let image_path = query_process_image_path(pid);
            let canonical_image_key = image_path
                .as_deref()
                .map(|p| canonical_dir_key(Path::new(p)));
            rows.push(OsProcessRow {
                pid,
                parent_pid: entry.th32ParentProcessID,
                exe_name,
                image_path,
                canonical_image_key,
            });
        }
        if unsafe { Process32NextW(snap, &mut entry) } == 0 {
            break;
        }
    }
    rows
}

fn is_epilod_descendant_candidate(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "msedgewebview2.exe" | "mpv.exe" | "ffmpeg.exe" | "crashpad_handler.exe"
    )
}

fn is_epilod_root_binary(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "epilod party.exe" | "epilod-party.exe" | "epilod-uninstall.exe"
    )
}

pub fn detect_running_processes_in_dir(install_dir: &Path) -> Vec<RunningProcessInfo> {
    let resolved_dir = resolve_install_dir(&install_dir.to_string_lossy())
        .map(PathBuf::from)
        .unwrap_or_else(|_| install_dir.to_path_buf());
    let dir_key = canonical_dir_key(&resolved_dir);
    if dir_key.is_empty() {
        return Vec::new();
    }
    let dir_prefix = format!("{dir_key}\\");

    let rows = snapshot_all_processes();
    let mut children_by_parent: HashMap<u32, Vec<usize>> = HashMap::new();
    for (idx, row) in rows.iter().enumerate() {
        children_by_parent
            .entry(row.parent_pid)
            .or_default()
            .push(idx);
    }

    let mut selected_indices: HashSet<usize> = HashSet::new();
    let mut bfs_queue: VecDeque<u32> = VecDeque::new();

    for (idx, row) in rows.iter().enumerate() {
        let in_dir = row
            .canonical_image_key
            .as_deref()
            .map(|k| k.starts_with(&dir_prefix))
            .unwrap_or(false);
        if in_dir {
            selected_indices.insert(idx);
            if is_epilod_root_binary(&row.exe_name) {
                bfs_queue.push_back(row.pid);
            }
        }
    }

    // Walk process tree from Epilod root PIDs to capture WebView2 / mpv / ffmpeg descendants
    // whose executable binary resides outside install_dir (e.g., System Edge WebView2 runtime).
    let mut visited_roots: HashSet<u32> = HashSet::new();
    while let Some(parent_pid) = bfs_queue.pop_front() {
        if !visited_roots.insert(parent_pid) {
            continue;
        }
        if let Some(children) = children_by_parent.get(&parent_pid) {
            for &child_idx in children {
                let child = &rows[child_idx];
                let in_dir = child
                    .canonical_image_key
                    .as_deref()
                    .map(|k| k.starts_with(&dir_prefix))
                    .unwrap_or(false);
                if in_dir || is_epilod_descendant_candidate(&child.exe_name) {
                    selected_indices.insert(child_idx);
                    bfs_queue.push_back(child.pid);
                }
            }
        }
    }

    let mut out: Vec<RunningProcessInfo> = selected_indices
        .into_iter()
        .map(|idx| {
            let row = &rows[idx];
            RunningProcessInfo {
                pid: row.pid,
                name: row.exe_name.clone(),
                executable_path: row.image_path.clone().unwrap_or_default(),
            }
        })
        .collect();
    out.sort_by_key(|p| p.pid);
    out
}

pub fn wait_for_pid_exit(pid: u32, timeout_secs: u64) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    let hproc = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    let Some(_guard) = HandleGuard::new(hproc) else {
        return;
    };
    let wait_ms = (timeout_secs.saturating_mul(1000)).min(u32::MAX as u64) as u32;
    unsafe {
        let _ = WaitForSingleObject(hproc, wait_ms);
    }
}

struct EnumWindowsCloseCtx {
    target_pids: HashSet<u32>,
}

unsafe extern "system" fn enum_windows_close_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
    if lparam == 0 {
        return 1;
    }
    let ctx = &*(lparam as *const EnumWindowsCloseCtx);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid != 0 && ctx.target_pids.contains(&pid) {
        let _ = PostMessageW(hwnd, WM_CLOSE, 0, 0);
    }
    1
}

pub fn close_running_processes_in_dir(install_dir: &Path) -> Result<usize, String> {
    let initial = detect_running_processes_in_dir(install_dir);
    if initial.is_empty() {
        return Ok(0);
    }

    let target_pids: HashSet<u32> = initial.iter().map(|p| p.pid).collect();
    let ctx = EnumWindowsCloseCtx { target_pids };
    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_close_proc),
            (&ctx as *const EnumWindowsCloseCtx) as LPARAM,
        );
    }

    // Give graceful WM_CLOSE handlers up to ~1.5 seconds across root + child processes.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1_500);
    while std::time::Instant::now() < deadline {
        if detect_running_processes_in_dir(install_dir).is_empty() {
            return Ok(initial.len());
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }

    // Terminate survivors cleanly and wait on their process kernel handles so file locks clear.
    let survivors = detect_running_processes_in_dir(install_dir);
    for proc_info in &survivors {
        let hproc =
            unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, proc_info.pid) };
        if let Some(_guard) = HandleGuard::new(hproc) {
            unsafe {
                let _ = TerminateProcess(hproc, 1);
                let _ = WaitForSingleObject(hproc, 2_000);
            }
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(200));
    let remaining = detect_running_processes_in_dir(install_dir);
    if !remaining.is_empty() {
        let names: Vec<String> = remaining.into_iter().map(|r| r.name).collect();
        return Err(format!(
            "[LOCKED_PROCESSES] Could not close running processes cleanly ({}). Please close Epilod Party manually and retry.",
            names.join(", ")
        ));
    }

    Ok(initial.len())
}

fn resolve_known_folder_win32(rfid: *const windows_sys::core::GUID) -> Option<PathBuf> {
    let mut raw_ptr: windows_sys::core::PWSTR = ptr::null_mut();
    let hr = unsafe { SHGetKnownFolderPath(rfid, 0, ptr::null_mut(), &mut raw_ptr) };
    if raw_ptr.is_null() {
        return None;
    }
    struct CoTaskGuard(*const c_void);
    impl Drop for CoTaskGuard {
        fn drop(&mut self) {
            unsafe {
                CoTaskMemFree(self.0);
            }
        }
    }
    let _guard = CoTaskGuard(raw_ptr as *const c_void);
    if hr != S_OK {
        return None;
    }
    let mut len = 0usize;
    unsafe {
        while *raw_ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(raw_ptr, len);
        let s = String::from_utf16_lossy(slice);
        if s.trim().is_empty() {
            None
        } else {
            Some(PathBuf::from(s))
        }
    }
}

/// Resolves Desktop and Start Menu Programs folders natively via `SHGetKnownFolderPath`
/// (supporting OneDrive Known Folder Move automatically without spawning PowerShell).
fn resolve_windows_known_folders() -> (Option<PathBuf>, Option<PathBuf>) {
    let desk = resolve_known_folder_win32(&FOLDERID_Desktop)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Desktop")));
    let prog = resolve_known_folder_win32(&FOLDERID_Programs).or_else(|| {
        std::env::var_os("APPDATA").map(|p| {
            PathBuf::from(p)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
        })
    });
    (desk, prog)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FileBackup {
    path: String,
    existed: bool,
    bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum RegValData {
    Sz(String),
    Dword(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegKeyBackup {
    subkey: String,
    existed: bool,
    values: Vec<(String, RegValData)>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WindowsIntegrationBackup {
    files: Vec<FileBackup>,
    keys: Vec<RegKeyBackup>,
}

fn snapshot_file_path(path: &Path) -> FileBackup {
    if path.is_file() {
        FileBackup {
            path: path.to_string_lossy().into_owned(),
            existed: true,
            bytes: fs::read(path).ok(),
        }
    } else {
        FileBackup {
            path: path.to_string_lossy().into_owned(),
            existed: false,
            bytes: None,
        }
    }
}

fn read_hkcu_key_snapshot(subkey_str: &str) -> RegKeyBackup {
    let wsubkey = to_wide_null(OsStr::new(subkey_str));
    let mut hkey: HKEY = ptr::null_mut();
    let res = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wsubkey.as_ptr(), 0, KEY_READ, &mut hkey) };
    if res != ERROR_SUCCESS {
        return RegKeyBackup {
            subkey: subkey_str.to_string(),
            existed: false,
            values: Vec::new(),
        };
    }

    let mut values = Vec::new();
    let mut idx = 0u32;
    let mut name_cap = 256usize;
    let mut data_cap = 1024usize;

    loop {
        let mut name_buf = vec![0u16; name_cap];
        let mut data_buf = vec![0u8; data_cap];
        let mut name_len = name_buf.len() as u32;
        let mut data_len = data_buf.len() as u32;
        let mut val_type: u32 = 0;

        let enum_res = unsafe {
            RegEnumValueW(
                hkey,
                idx,
                name_buf.as_mut_ptr(),
                &mut name_len,
                ptr::null_mut(),
                &mut val_type,
                data_buf.as_mut_ptr(),
                &mut data_len,
            )
        };

        if enum_res == ERROR_MORE_DATA {
            name_cap = (name_len as usize + 2).max(name_cap * 2);
            data_cap = (data_len as usize + 4).max(data_cap * 2);
            continue;
        }
        if enum_res == ERROR_NO_MORE_ITEMS || enum_res != ERROR_SUCCESS {
            break;
        }

        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        if val_type == REG_SZ {
            let u16_count = (data_len as usize) / 2;
            let mut u16s = Vec::with_capacity(u16_count);
            for chunk in data_buf[..u16_count * 2].chunks_exact(2) {
                u16s.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            let str_val = wide_str_to_string(&u16s);
            values.push((name, RegValData::Sz(str_val)));
        } else if val_type == REG_DWORD && data_len >= 4 {
            let dword = u32::from_le_bytes([data_buf[0], data_buf[1], data_buf[2], data_buf[3]]);
            values.push((name, RegValData::Dword(dword)));
        }
        idx += 1;
    }

    unsafe {
        RegCloseKey(hkey);
    }

    RegKeyBackup {
        subkey: subkey_str.to_string(),
        existed: true,
        values,
    }
}

fn capture_integration_backup(
    previous_receipt: Option<&InstallReceipt>,
) -> WindowsIntegrationBackup {
    let (desktop_dir, programs_dir) = resolve_windows_known_folders();
    let mut shortcut_paths: Vec<PathBuf> = Vec::new();
    if let Some(prog_root) = programs_dir {
        shortcut_paths.push(prog_root.join(APP_NAME).join("Epilod Party.lnk"));
    }
    if let Some(desk_root) = desktop_dir {
        shortcut_paths.push(desk_root.join("Epilod Party.lnk"));
    }
    if let Some(prev) = previous_receipt {
        for s in &prev.shortcuts {
            let p = PathBuf::from(s);
            if !shortcut_paths.iter().any(|existing| existing == &p) {
                shortcut_paths.push(p);
            }
        }
    }

    let files = shortcut_paths
        .iter()
        .map(|p| snapshot_file_path(p))
        .collect();

    let open_with_cmd = format!(r"{OPEN_WITH_APP_SUBKEY}\shell\open\command");
    let open_with_sup = format!(r"{OPEN_WITH_APP_SUBKEY}\SupportedTypes");
    let keys = vec![
        read_hkcu_key_snapshot(UNINSTALL_REG_SUBKEY),
        read_hkcu_key_snapshot(OPEN_WITH_APP_SUBKEY),
        read_hkcu_key_snapshot(&open_with_cmd),
        read_hkcu_key_snapshot(&open_with_sup),
    ];

    WindowsIntegrationBackup { files, keys }
}

fn restore_integration_backup(backup: &WindowsIntegrationBackup) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    for fb in &backup.files {
        let p = Path::new(&fb.path);
        if fb.existed {
            if let Some(bytes) = &fb.bytes {
                if let Some(parent) = p.parent() {
                    if let Err(e) = fs::create_dir_all(parent) {
                        errors.push(format!("create_dir_all({}): {e}", parent.display()));
                        continue;
                    }
                }
                if let Err(e) = fs::write(p, bytes) {
                    errors.push(format!("restore shortcut {}: {e}", p.display()));
                }
            }
        } else if p.is_file() {
            if let Err(e) = fs::remove_file(p) {
                errors.push(format!("remove shortcut {}: {e}", p.display()));
            } else if let Some(parent) = p.parent() {
                if parent
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|n| n.eq_ignore_ascii_case(APP_NAME))
                    .unwrap_or(false)
                {
                    let _ = fs::remove_dir(parent);
                }
            }
        }
    }

    // Remove registry subtrees in reverse (leaves first) if they did not exist prior,
    // or recreate and restore values cleanly if they did exist.
    for kb in backup.keys.iter().rev() {
        if !kb.existed {
            if let Err(e) = delete_hkcu_tree(&kb.subkey) {
                errors.push(e);
            }
        }
    }
    for kb in &backup.keys {
        if kb.existed {
            if let Err(e) = delete_hkcu_tree(&kb.subkey) {
                errors.push(e);
                continue;
            }
            match reg_create_hkcu(&kb.subkey) {
                Ok(hkey) => {
                    for (name, val) in &kb.values {
                        let wres = match val {
                            RegValData::Sz(s) => reg_set_str(hkey, name, s),
                            RegValData::Dword(d) => reg_set_dword(hkey, name, *d),
                        };
                        if let Err(e) = wres {
                            errors.push(e);
                        }
                    }
                    unsafe {
                        RegCloseKey(hkey);
                    }
                }
                Err(e) => errors.push(e),
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

impl SystemIntegrator for WindowsIntegrator {
    fn check_destination(&self, dir: &Path) -> Result<Option<u64>, String> {
        test_directory_writable(dir)?;
        fs::create_dir_all(dir)
            .map_err(|e| format!("Unable to access destination folder {}: {e}", dir.display()))?;
        Ok(query_free_disk_bytes(dir))
    }

    fn estimate_uninstaller_bytes(&self) -> u64 {
        std::env::current_exe()
            .ok()
            .map(|p| estimate_uninstaller_copy_bytes(&p))
            .unwrap_or(16 * 1024 * 1024)
    }

    fn prepare_for_file_changes(
        &self,
        install_dir: &Path,
        wait_pid: Option<u32>,
        force_close_app: bool,
    ) -> Result<usize, String> {
        if let Some(pid) = wait_pid {
            wait_for_pid_exit(pid, 8);
        }

        let running = detect_running_processes_in_dir(install_dir);
        if running.is_empty() {
            return Ok(0);
        }

        if force_close_app || wait_pid.is_some() {
            return close_running_processes_in_dir(install_dir);
        }

        let names: Vec<String> = running.into_iter().map(|r| r.name).collect();
        Err(format!(
            "[LOCKED_PROCESSES] Close running Epilod Party processes ({}) before modifying files.",
            names.join(", ")
        ))
    }

    fn install_uninstaller(&self, install_dir: &Path, _backup_dir: &Path) -> Result<bool, String> {
        let uninstall_exe = install_dir.join(UNINSTALLER_FILENAME);
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Cannot resolve current setup executable path: {e}"))?;

        let same_file = fs::canonicalize(&current_exe)
            .ok()
            .zip(fs::canonicalize(&uninstall_exe).ok())
            .map(|(a, b)| a == b)
            .unwrap_or(false);

        if same_file {
            return Ok(true);
        }

        // Previous epilod-uninstall.exe is already backed up & removed in-place by engine.rs.
        epilod_installer_core::archive::copy_uninstaller_executable(&current_exe, &uninstall_exe)
            .map_err(|e| format!("Failed installing uninstaller binary ({e})."))?;
        Ok(true)
    }

    fn capture_integration_snapshot(
        &self,
        _install_dir: &Path,
        previous_receipt: Option<&InstallReceipt>,
    ) -> IntegrationSnapshot {
        let backup = capture_integration_backup(previous_receipt);
        let bytes = serde_json::to_vec(&backup).unwrap_or_default();
        IntegrationSnapshot(bytes)
    }

    fn revert_integration(
        &self,
        _install_dir: &Path,
        snapshot: &IntegrationSnapshot,
        _previous_receipt: Option<&InstallReceipt>,
    ) -> Result<(), String> {
        if snapshot.0.is_empty() {
            return Ok(());
        }
        let backup: WindowsIntegrationBackup = serde_json::from_slice(&snapshot.0)
            .map_err(|e| format!("Failed decoding integration backup snapshot: {e}"))?;
        restore_integration_backup(&backup)
    }

    fn apply_shortcuts_and_registry(
        &self,
        install_dir: &Path,
        options: &InstallOptions,
        target_version: &str,
        previous_receipt: Option<&InstallReceipt>,
        report: &mut dyn FnMut(&str, usize, usize),
    ) -> Result<IntegrationResult, String> {
        let total_steps = 4usize;
        let exe_path =
            installed_exe_path(install_dir).unwrap_or_else(|| install_dir.join("Epilod Party.exe"));
        let uninstall_exe = install_dir.join(UNINSTALLER_FILENAME);

        let pre_step_backup = capture_integration_backup(previous_receipt);
        let (desktop_dir, programs_dir) = resolve_windows_known_folders();
        let mut created_shortcuts = Vec::new();
        let mut created_registry_keys = Vec::new();

        let step_result: Result<(), String> = (|| {
            // 1. Start Menu shortcut
            report("Updating Start Menu integration", 1, total_steps);
            if let Some(ref prog_root) = programs_dir {
                let menu_dir = prog_root.join(APP_NAME);
                let menu_lnk = menu_dir.join("Epilod Party.lnk");
                if options.create_start_menu_shortcut {
                    fs::create_dir_all(&menu_dir)
                        .map_err(|e| format!("Failed creating Start Menu folder: {e}"))?;
                    create_shortcut_lnk(
                        &menu_lnk,
                        &exe_path,
                        install_dir,
                        "Synchronized Watch Party",
                    )?;
                    created_shortcuts.push(menu_lnk.to_string_lossy().into_owned());
                } else {
                    if menu_lnk.is_file() {
                        let _ = remove_file_resilient(&menu_lnk);
                    }
                    if menu_dir.is_dir() {
                        // Only remove Start Menu folder when empty so third-party items inside are preserved.
                        let _ = fs::remove_dir(&menu_dir);
                    }
                }
            }

            // 2. Desktop shortcut (supports OneDrive Desktop Known Folder Move)
            report("Updating Desktop integration", 2, total_steps);
            if let Some(ref desk_root) = desktop_dir {
                let desktop_lnk = desk_root.join("Epilod Party.lnk");
                if options.create_desktop_shortcut {
                    fs::create_dir_all(desk_root)
                        .map_err(|e| format!("Failed accessing Desktop folder: {e}"))?;
                    create_shortcut_lnk(
                        &desktop_lnk,
                        &exe_path,
                        install_dir,
                        "Synchronized Watch Party",
                    )?;
                    created_shortcuts.push(desktop_lnk.to_string_lossy().into_owned());
                } else {
                    let _ = remove_file_resilient(&desktop_lnk);
                }
            }
            // Clean up any stale Desktop shortcut recorded by an older install when disabled
            if !options.create_desktop_shortcut {
                if let Some(prev) = previous_receipt {
                    for old_lnk in &prev.shortcuts {
                        if old_lnk.to_ascii_lowercase().contains("desktop") {
                            let _ = remove_file_resilient(Path::new(old_lnk));
                        }
                    }
                }
            }

            // 3. Windows Apps & Features HKCU Uninstall key
            report("Registering Windows uninstall", 3, total_steps);
            let est_kb = dir_size_bytes(install_dir) / 1024;
            write_uninstall_registry(
                install_dir,
                &exe_path,
                &uninstall_exe,
                target_version,
                est_kb as u32,
            )?;
            created_registry_keys.push(format!(r"HKCU\{UNINSTALL_REG_SUBKEY}"));

            // 4. Optional non-invasive "Open with Epilod Party" video/subtitle context menu integration
            report("Configuring Open With handlers", 4, total_steps);
            if options.register_file_associations {
                write_open_with_registry(&exe_path)?;
                created_registry_keys.push(format!(r"HKCU\{OPEN_WITH_APP_SUBKEY}"));
            } else {
                delete_hkcu_tree(OPEN_WITH_APP_SUBKEY)?;
            }

            Ok(())
        })();

        if let Err(err) = step_result {
            if let Err(rev_err) = restore_integration_backup(&pre_step_backup) {
                return Err(format!("{err} (integration rollback note: {rev_err})"));
            }
            return Err(err);
        }

        Ok(IntegrationResult {
            created_shortcuts,
            created_registry_keys,
            user_data_dir: local_user_data_dir().map(|p| p.to_string_lossy().into_owned()),
        })
    }

    fn remove_shortcuts_and_registry(
        &self,
        _install_dir: &Path,
        receipt: Option<&InstallReceipt>,
        remove_user_data: bool,
        report: &mut dyn FnMut(&str, usize, usize),
    ) -> Result<CleanupReport, String> {
        let mut removed_shortcuts = 0usize;

        report("Removing Start Menu & Desktop links", 1, 3);
        if let Some(rec) = receipt {
            for lnk in &rec.shortcuts {
                let p = Path::new(lnk);
                if p.is_file() && remove_file_resilient(p).is_ok() {
                    removed_shortcuts += 1;
                }
                if let Some(parent) = p.parent() {
                    if parent
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|n| n.eq_ignore_ascii_case(APP_NAME))
                        .unwrap_or(false)
                    {
                        let _ = fs::remove_dir(parent);
                    }
                }
            }
        }

        // Also sweep standard & OneDrive Known Folders in case legacy shortcuts or moved folders exist,
        // deleting only Epilod Party's own shortcut and removing the parent folder only when empty.
        let (desktop_dir, programs_dir) = resolve_windows_known_folders();
        if let Some(prog) = programs_dir {
            let menu_dir = prog.join(APP_NAME);
            let menu_lnk = menu_dir.join("Epilod Party.lnk");
            if menu_lnk.is_file() && remove_file_resilient(&menu_lnk).is_ok() {
                removed_shortcuts += 1;
            }
            if menu_dir.is_dir() {
                let _ = fs::remove_dir(&menu_dir);
            }
        }
        if let Some(desk) = desktop_dir {
            let desktop_lnk = desk.join("Epilod Party.lnk");
            if desktop_lnk.is_file() && remove_file_resilient(&desktop_lnk).is_ok() {
                removed_shortcuts += 1;
            }
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let fallback_lnk = PathBuf::from(profile)
                .join("Desktop")
                .join("Epilod Party.lnk");
            if fallback_lnk.is_file() && remove_file_resilient(&fallback_lnk).is_ok() {
                removed_shortcuts += 1;
            }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let fallback_menu = PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join(APP_NAME);
            let fallback_menu_lnk = fallback_menu.join("Epilod Party.lnk");
            if fallback_menu_lnk.is_file() && remove_file_resilient(&fallback_menu_lnk).is_ok() {
                removed_shortcuts += 1;
            }
            if fallback_menu.is_dir() {
                let _ = fs::remove_dir(&fallback_menu);
            }
        }

        report("Removing Windows registry entries", 2, 3);
        let mut warnings = Vec::new();
        if let Err(e) = delete_hkcu_tree(UNINSTALL_REG_SUBKEY) {
            warnings.push(e);
        }
        if let Err(e) = delete_hkcu_tree(OPEN_WITH_APP_SUBKEY) {
            warnings.push(e);
        }
        if let Some(rec) = receipt {
            for reg_key in &rec.registry_keys {
                if let Some(sub) = reg_key.strip_prefix(r"HKCU\") {
                    if let Err(e) = delete_hkcu_tree(sub) {
                        warnings.push(e);
                    }
                }
            }
        }
        let removed_registry = warnings.is_empty();

        let mut removed_user_data = false;
        if remove_user_data {
            report("Removing local logs & update cache", 3, 3);
            let data_dir = receipt
                .and_then(|r| r.user_data_dir.as_deref())
                .map(PathBuf::from)
                .or_else(local_user_data_dir);
            if let Some(dir) = data_dir {
                if dir.is_dir() {
                    match remove_dir_all_resilient(&dir) {
                        Ok(()) => {
                            removed_user_data = true;
                        }
                        Err(err) => {
                            warnings.push(format!(
                                "Could not remove all local user data in {}: {err}",
                                dir.display()
                            ));
                        }
                    }
                }
            }
        } else {
            report("Preserving local logs & settings", 3, 3);
        }

        Ok(CleanupReport {
            removed_shortcuts,
            removed_registry,
            removed_user_data,
            warnings,
        })
    }

    fn schedule_self_cleanup(
        &self,
        install_dir: &Path,
        uninstall_exe_rel: &str,
        receipt_rel: &str,
    ) -> Result<bool, String> {
        let uninstall_path = install_dir.join(uninstall_exe_rel);
        let receipt_path = install_dir.join(receipt_rel);

        // Switch immediately to %TEMP% so this cleanup script holds zero CWD handles inside install_dir,
        // wait up to 10 minutes for the uninstaller UI PID to exit, clear any ReadOnly flag, retry up
        // to ~20s (40 x 500ms) for Defender scans to finish, and remove empty directories only.
        // If Windows/AV still holds a lock after 20s, register a scoped HKCU\...\RunOnce entry
        // referencing only our exact leftover paths so standard users get silent cleanup on next login.
        let ps_script = r#"
Set-Location $env:TEMP
$pidWait = [int]$env:EPILOD_SELF_PID
try {
  $p = Get-Process -Id $pidWait -ErrorAction SilentlyContinue
  if ($p) { $null = $p.WaitForExit(600000) }
} catch {}
Start-Sleep -Milliseconds 350

$remainingLocked = @()
foreach ($f in @($env:EPILOD_UNINST_FILE, $env:EPILOD_RECEIPT_FILE)) {
  if ($f -and (Test-Path -LiteralPath $f)) {
    $deleted = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      try {
        $item = Get-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReadOnly)) {
          $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
        }
        Remove-Item -LiteralPath $f -Force -ErrorAction Stop
        $deleted = $true
        break
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }
    if (-not $deleted -and (Test-Path -LiteralPath $f)) {
      $remainingLocked += $f
    }
  }
}

$dir = $env:EPILOD_TARGET_DIR
if ($remainingLocked.Count -eq 0) {
  if ($dir -and (Test-Path -LiteralPath $dir)) {
    $rem = Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    if (-not $rem -or $rem.Count -eq 0) {
      try { Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
} else {
  $safeFiles = @($remainingLocked | Where-Object { $_ -and -not ($_ -match '["%\r\n]') })
  if ($safeFiles.Count -gt 0) {
    $cmds = New-Object System.Collections.Generic.List[string]
    foreach ($sf in $safeFiles) {
      $cmds.Add("if exist `"$sf`" del /f /q `"$sf`"")
    }
    if ($dir -and -not ($dir -match '["%\r\n]')) {
      $cmds.Add("if exist `"$dir`" rmdir `"$dir`"")
    }
    $runOnceCmd = "cmd.exe /d /c " + ($cmds -join " & ")
    try {
      $roPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
      if (-not (Test-Path $roPath)) { $null = New-Item -Path $roPath -Force }
      Set-ItemProperty -Path $roPath -Name 'EpilodPartySelfCleanup' -Value $runOnceCmd -ErrorAction SilentlyContinue
    } catch {}
  }
}
"#;

        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                ps_script,
            ])
            .current_dir(std::env::temp_dir())
            .env("EPILOD_SELF_PID", std::process::id().to_string())
            .env("EPILOD_UNINST_FILE", uninstall_path.as_os_str())
            .env("EPILOD_RECEIPT_FILE", receipt_path.as_os_str())
            .env("EPILOD_TARGET_DIR", install_dir.as_os_str())
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed scheduling uninstaller cleanup: {e}"))?;

        Ok(true)
    }
}

struct ComAptGuard(bool);
impl Drop for ComAptGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

/// Native COM `IShellLinkW` + `IPersistFile` shortcut writer (replaces `WScript.Shell`).
fn create_shortcut_lnk(
    lnk_path: &Path,
    target_exe: &Path,
    work_dir: &Path,
    description: &str,
) -> Result<(), String> {
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        return Err(format!(
            "Failed initializing COM for shortcut creation (0x{:08X}).",
            hr.0 as u32
        ));
    }
    let _com_guard = ComAptGuard(hr.is_ok());

    let shell_link: IShellLinkW =
        unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| format!("Failed creating ShellLink COM instance: {e}"))?;

    let wtarget = to_wide_null(target_exe.as_os_str());
    let wworkdir = to_wide_null(work_dir.as_os_str());
    let wdesc = to_wide_null(OsStr::new(description));
    let wlnk = to_wide_null(lnk_path.as_os_str());

    unsafe {
        shell_link
            .SetPath(PCWSTR::from_raw(wtarget.as_ptr()))
            .map_err(|e| format!("ShellLink SetPath failed: {e}"))?;
        shell_link
            .SetWorkingDirectory(PCWSTR::from_raw(wworkdir.as_ptr()))
            .map_err(|e| format!("ShellLink SetWorkingDirectory failed: {e}"))?;
        shell_link
            .SetIconLocation(PCWSTR::from_raw(wtarget.as_ptr()), 0)
            .map_err(|e| format!("ShellLink SetIconLocation failed: {e}"))?;
        shell_link
            .SetDescription(PCWSTR::from_raw(wdesc.as_ptr()))
            .map_err(|e| format!("ShellLink SetDescription failed: {e}"))?;

        let persist: IPersistFile = shell_link
            .cast()
            .map_err(|e| format!("ShellLink IPersistFile cast failed: {e}"))?;
        persist
            .Save(PCWSTR::from_raw(wlnk.as_ptr()), true)
            .map_err(|e| format!("Shortcut save failed for {}: {e}", lnk_path.display()))?;
    }

    Ok(())
}

fn reg_set_str(hkey: HKEY, name: &str, val: &str) -> Result<(), String> {
    let wname = to_wide_null(OsStr::new(name));
    let wval = to_wide_null(OsStr::new(val));
    let byte_len = (wval.len() * 2) as u32;
    let res = unsafe {
        RegSetValueExW(
            hkey,
            wname.as_ptr(),
            0,
            REG_SZ,
            wval.as_ptr() as *const u8,
            byte_len,
        )
    };
    if res != ERROR_SUCCESS {
        return Err(format!("Registry write failed for '{name}' (code {res})."));
    }
    Ok(())
}

fn reg_set_dword(hkey: HKEY, name: &str, val: u32) -> Result<(), String> {
    let wname = to_wide_null(OsStr::new(name));
    let bytes = val.to_le_bytes();
    let res = unsafe { RegSetValueExW(hkey, wname.as_ptr(), 0, REG_DWORD, bytes.as_ptr(), 4) };
    if res != ERROR_SUCCESS {
        return Err(format!(
            "Registry DWORD write failed for '{name}' (code {res})."
        ));
    }
    Ok(())
}

fn reg_create_hkcu(subkey_str: &str) -> Result<HKEY, String> {
    let subkey = to_wide_null(OsStr::new(subkey_str));
    let mut hkey: HKEY = ptr::null_mut();
    let res = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            ptr::null(),
            &mut hkey,
            ptr::null_mut(),
        )
    };
    if res != ERROR_SUCCESS {
        return Err(format!("Failed opening HKCU\\{subkey_str} (code {res})."));
    }
    Ok(hkey)
}

fn delete_hkcu_tree(subkey_str: &str) -> Result<(), String> {
    let subkey = to_wide_null(OsStr::new(subkey_str));
    let res = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, subkey.as_ptr()) };
    if res == ERROR_SUCCESS || res == ERROR_FILE_NOT_FOUND || res == ERROR_PATH_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("Failed deleting HKCU\\{subkey_str} (code {res})."))
    }
}

fn write_uninstall_registry(
    install_dir: &Path,
    exe_path: &Path,
    uninstall_exe: &Path,
    target_version: &str,
    estimated_kb: u32,
) -> Result<(), String> {
    let hkey = reg_create_hkcu(UNINSTALL_REG_SUBKEY)?;
    let effective_version = if target_version.trim().is_empty() {
        APP_VERSION
    } else {
        target_version.trim()
    };
    let write_res = (|| -> Result<(), String> {
        let uninstall_cmd = format!(
            "\"{}\" --uninstall \"{}\"",
            uninstall_exe.display(),
            install_dir.display()
        );
        let quiet_cmd = format!(
            "\"{}\" --uninstall \"{}\" --silent",
            uninstall_exe.display(),
            install_dir.display()
        );

        reg_set_str(hkey, "DisplayName", APP_NAME)?;
        reg_set_str(hkey, "DisplayVersion", effective_version)?;
        reg_set_str(hkey, "Publisher", "Epilod Party")?;
        reg_set_str(hkey, "InstallLocation", &install_dir.display().to_string())?;
        reg_set_str(hkey, "DisplayIcon", &format!("{},0", exe_path.display()))?;
        reg_set_str(hkey, "UninstallString", &uninstall_cmd)?;
        reg_set_str(hkey, "QuietUninstallString", &quiet_cmd)?;
        reg_set_str(hkey, "URLInfoAbout", REPO_URL)?;
        if let Some(sv) = parse_semver(effective_version) {
            reg_set_dword(hkey, "VersionMajor", sv.major as u32)?;
            reg_set_dword(hkey, "VersionMinor", sv.minor as u32)?;
        }
        reg_set_dword(hkey, "NoModify", 1)?;
        reg_set_dword(hkey, "NoRepair", 1)?;
        reg_set_dword(hkey, "EstimatedSize", estimated_kb.max(1024))?;
        Ok(())
    })();

    unsafe {
        RegCloseKey(hkey);
    }
    write_res
}

fn write_open_with_registry(exe_path: &Path) -> Result<(), String> {
    // Non-invasive per-user registration: adds "Epilod Party" to Windows "Open with" menu cleanly.
    let hkey_app = reg_create_hkcu(OPEN_WITH_APP_SUBKEY)?;
    let r1 = reg_set_str(hkey_app, "FriendlyAppName", APP_NAME);
    unsafe {
        RegCloseKey(hkey_app);
    }
    r1?;

    let cmd_key = format!(r"{OPEN_WITH_APP_SUBKEY}\shell\open\command");
    let hkey_cmd = reg_create_hkcu(&cmd_key)?;
    let cmd_val = format!("\"{}\" \"%1\"", exe_path.display());
    let r2 = reg_set_str(hkey_cmd, "", &cmd_val);
    unsafe {
        RegCloseKey(hkey_cmd);
    }
    r2?;

    let sup_key = format!(r"{OPEN_WITH_APP_SUBKEY}\SupportedTypes");
    let hkey_sup = reg_create_hkcu(&sup_key)?;
    let r3 = (|| -> Result<(), String> {
        for ext in [
            ".mkv", ".mp4", ".ts", ".m2ts", ".avi", ".webm", ".srt", ".ass", ".vtt",
        ] {
            reg_set_str(hkey_sup, ext, "")?;
        }
        Ok(())
    })();
    unsafe {
        RegCloseKey(hkey_sup);
    }
    r3
}

pub fn run_silent_uninstall_flow(target_dir: Option<&Path>, remove_user_data: bool) -> i32 {
    let resolved_dir = target_dir
        .and_then(|p| resolve_install_dir(&p.to_string_lossy()).ok())
        .or_else(read_hkcu_install_location)
        .unwrap_or_else(default_install_dir_string);

    let opts = epilod_installer_core::plan::UninstallOptions {
        install_dir: resolved_dir,
        remove_user_data,
        force_close_running: true,
        silent: true,
    };

    match epilod_installer_core::engine::run_uninstall_pipeline(&opts, &WindowsIntegrator, |_| {}) {
        Ok(summary) => {
            println!(
                "Epilod Party uninstalled from {} (removed {} files, preserved {} non-app files).",
                summary.install_dir, summary.removed_files, summary.skipped_unrelated_files
            );
            for warning in &summary.warnings {
                eprintln!("Epilod Party silent uninstall warning: {warning}");
            }
            if !summary.removed_registry || !summary.warnings.is_empty() {
                1
            } else {
                0
            }
        }
        Err(err) => {
            eprintln!("Epilod Party silent uninstall error: {err}");
            1
        }
    }
}

pub fn run_silent_install_flow(
    payload_path: &Path,
    mode: InstallMode,
    target_dir: Option<&Path>,
    wait_pid: Option<u32>,
    relaunch: bool,
    allow_downgrade: bool,
) -> i32 {
    let resolved_dir = target_dir
        .and_then(|p| resolve_install_dir(&p.to_string_lossy()).ok())
        .unwrap_or_else(default_install_dir_string);

    if !allow_downgrade {
        if let Ok(report) = inspect_existing_install(Some(payload_path), &resolved_dir) {
            if report.disposition == InstallDisposition::DowngradeWarning {
                eprintln!(
                    "Epilod Party silent setup ({mode:?}) blocked: {} Pass --allow-downgrade to override.",
                    report.summary_text
                );
                return 1;
            }
        }
    }

    let prev_receipt = read_receipt(Path::new(&resolved_dir));

    let opts = InstallOptions {
        install_dir: resolved_dir.clone(),
        create_desktop_shortcut: prev_receipt
            .as_ref()
            .map(|r| r.desktop_shortcut)
            .unwrap_or(true),
        create_start_menu_shortcut: prev_receipt
            .as_ref()
            .map(|r| r.start_menu_shortcut)
            .unwrap_or(true),
        register_file_associations: prev_receipt
            .as_ref()
            .map(|r| r.file_associations)
            .unwrap_or(true),
        auto_launch: relaunch,
        force_reunpack: mode == InstallMode::Repair,
        wait_pid,
        force_close_running: true,
        allow_downgrade,
    };

    let cancel = std::sync::atomic::AtomicBool::new(false);
    match epilod_installer_core::engine::run_install_pipeline(
        payload_path,
        &opts,
        &WindowsIntegrator,
        &cancel,
        |_| {},
    ) {
        Ok(manifest) => {
            println!(
                "Epilod Party v{} ({mode:?}) installed to {}.",
                manifest.version, resolved_dir
            );
            if relaunch {
                let dir_path = Path::new(&resolved_dir);
                if let Some(exe) = installed_exe_path(dir_path) {
                    let _ = Command::new(&exe).current_dir(dir_path).spawn();
                }
            }
            0
        }
        Err(err) => {
            eprintln!("Epilod Party silent setup ({mode:?}) error: {err}");
            1
        }
    }
}

pub fn run_silent_update_flow(
    payload_path: &Path,
    target_dir: Option<&Path>,
    wait_pid: Option<u32>,
    relaunch: bool,
) -> i32 {
    run_silent_install_flow(
        payload_path,
        InstallMode::Update,
        target_dir,
        wait_pid,
        relaunch,
        false,
    )
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut sum = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = fs::metadata(&path) {
                if meta.is_dir() {
                    sum = sum.saturating_add(dir_size_bytes(&path));
                } else {
                    sum = sum.saturating_add(meta.len());
                }
            }
        }
    }
    sum
}
