#![cfg(windows)]

use epilod_core::updater::{
    cleanup_stale_update_cache, cleanup_update_cache_with_keep, compare_semver,
    extract_manifest_url_from_github_release, find_http_header_end,
    parse_and_validate_manifest_with_signature, parse_content_range, parse_http_head,
    resolve_redirect_url, safe_version_filename_token, validate_https_url,
    verify_downloaded_installer, verify_manifest_signature_with_pubkey, ChunkedDecoder,
    HttpResponseHead, ReleaseManifest, UpdateAvailability, ALLOWED_UPDATE_HOSTS,
    CURRENT_APP_VERSION, DEFAULT_MANIFEST_URL, DEFAULT_RELEASES_API_URL,
    EMBEDDED_UPDATE_PUBKEY_HEX, MAX_INSTALLER_BYTES, MAX_MANIFEST_BYTES, MAX_REDIRECTS,
};
use epilod_installer_core::archive::{
    has_pe_authenticode_signature, read_manifest as read_sfx_manifest,
};
use native_tls::TlsConnector as NativeTlsConnector;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::time::timeout;
use tokio_native_tls::TlsConnector;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION,
    ERROR_NOT_SUPPORTED, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE,
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
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const UNINSTALL_REG_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\EpilodParty";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(25);
const USER_AGENT: &str = concat!("EpilodParty/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatusDto {
    pub current_version: String,
    pub availability: UpdateAvailability,
    pub available_release: Option<ReleaseManifest>,
    pub downloaded_installer_path: Option<String>,
    pub cache_dir: String,
    pub checked_at_unix: Option<u64>,
    pub signature_verified: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressDto {
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub speed_bps: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedReadyMetadata {
    manifest: ReleaseManifest,
    installer_file: String,
    verified_at_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PartResumeMetadata {
    version: String,
    sha256: String,
    size_bytes: u64,
    download_url: String,
}

pub struct UpdaterState {
    pub downloading: Mutex<bool>,
    pub cancel_download: Arc<AtomicBool>,
    pub cancel_notify: Arc<Notify>,
    pub latest_release: Mutex<Option<ReleaseManifest>>,
    pub last_checked_unix: Mutex<Option<u64>>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            downloading: Mutex::new(false),
            cancel_download: Arc::new(AtomicBool::new(false)),
            cancel_notify: Arc::new(Notify::new()),
            latest_release: Mutex::new(None),
            last_checked_unix: Mutex::new(None),
        }
    }
}

impl UpdaterState {
    pub fn new() -> Self {
        Self::default()
    }
}

pub fn update_cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("EpilodParty")
        .join("updates")
}

pub fn cleanup_update_cache_on_startup() {
    let dir = update_cache_dir();
    cleanup_stale_update_cache(&dir, CURRENT_APP_VERSION, unix_now());
}

/// Runs startup cache cleanup asynchronously once the updates cache folder exists.
pub fn spawn_startup_cache_cleanup() {
    let dir = update_cache_dir();
    if !dir.exists() {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("epilod-cache-cleanup".to_string())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            cleanup_update_cache_on_startup();
        });
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn ready_meta_path(cache_dir: &Path, version: &str) -> PathBuf {
    let token = safe_version_filename_token(version);
    cache_dir.join(format!("update-ready-{token}.json"))
}

fn installer_exe_path(cache_dir: &Path, version: &str) -> PathBuf {
    let token = safe_version_filename_token(version);
    cache_dir.join(format!("Epilod Party Setup-{token}.exe"))
}

fn installer_part_path(cache_dir: &Path, version: &str) -> PathBuf {
    let token = safe_version_filename_token(version);
    cache_dir.join(format!("Epilod Party Setup-{token}.exe.part"))
}

fn part_meta_path(part_path: &Path) -> PathBuf {
    let mut os = part_path.as_os_str().to_os_string();
    os.push(".meta.json");
    PathBuf::from(os)
}

fn write_ready_metadata_atomic(
    cache_dir: &Path,
    release: &ReleaseManifest,
    final_exe: &Path,
    now_unix: u64,
) -> Result<(), String> {
    let meta_file = ready_meta_path(cache_dir, &release.version);
    let meta = CachedReadyMetadata {
        manifest: release.clone(),
        installer_file: final_exe.to_string_lossy().into_owned(),
        verified_at_unix: now_unix,
    };
    let meta_bytes = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
    let meta_tmp = cache_dir.join(format!(
        ".update-ready-{}.json.tmp",
        safe_version_filename_token(&release.version)
    ));
    fs::write(&meta_tmp, meta_bytes)
        .and_then(|()| {
            if meta_file.exists() {
                let _ = fs::remove_file(&meta_file);
            }
            fs::rename(&meta_tmp, &meta_file)
        })
        .map_err(|e| format!("Failed writing update ready metadata: {e}"))
}

fn verify_sfx_payload_matches(installer_path: &Path, expected_version: &str) -> Result<(), String> {
    let (pkg_manifest, _) = read_sfx_manifest(installer_path)
        .map_err(|e| format!("Downloaded installer payload failed format verification: {e}"))?;
    if pkg_manifest.entries.is_empty() {
        return Err("Downloaded installer archive contains no payload files.".to_string());
    }
    if let Some(ord) = compare_semver(&pkg_manifest.version, expected_version) {
        if ord == Ordering::Less {
            return Err(format!(
                "Installer internal version (v{}) is older than manifest v{}.",
                pkg_manifest.version, expected_version
            ));
        }
    }
    Ok(())
}

/// If the PE carries a WIN_CERTIFICATE Authenticode table, validates it via Windows WinVerifyTrust
/// (`Get-AuthenticodeSignature`) and rejects corrupted or untrusted signatures before execution.
fn verify_authenticode_if_signed(setup_exe: &Path) -> Result<(), String> {
    if !has_pe_authenticode_signature(setup_exe) {
        return Ok(());
    }
    let ps = "$sig = Get-AuthenticodeSignature -LiteralPath $env:EPILOD_CHK_EXE; if ($null -eq $sig) { exit 2 }; Write-Output $sig.Status; if ($sig.Status -ne 'Valid') { exit 3 }";
    let out = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            ps,
        ])
        .current_dir(std::env::temp_dir())
        .env("EPILOD_CHK_EXE", setup_exe.as_os_str())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed running Authenticode signature check: {e}"))?;
    if !out.status.success() {
        let status_label = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(format!(
            "Downloaded installer failed Windows Authenticode signature check ({}).",
            if status_label.is_empty() {
                "Invalid"
            } else {
                &status_label
            }
        ));
    }
    Ok(())
}

fn find_verified_cached_update(
    cache_dir: &Path,
    fallback_release: Option<&ReleaseManifest>,
    deep_verify: bool,
) -> Option<(ReleaseManifest, PathBuf, bool)> {
    let mut best: Option<(ReleaseManifest, PathBuf, bool)> = None;

    if let Ok(entries) = fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !path.is_file() || !name.starts_with("update-ready-") || !name.ends_with(".json") {
                continue;
            }
            let Ok(raw) = fs::read(&path) else {
                continue;
            };
            let Ok(meta) = serde_json::from_slice::<CachedReadyMetadata>(&raw) else {
                continue;
            };
            if compare_semver(&meta.manifest.version, CURRENT_APP_VERSION)
                != Some(Ordering::Greater)
            {
                continue;
            }
            let Ok(sig_verified) =
                verify_manifest_signature_with_pubkey(&meta.manifest, EMBEDDED_UPDATE_PUBKEY_HEX)
            else {
                continue;
            };
            let exe_path = {
                let recorded = PathBuf::from(&meta.installer_file);
                if recorded.is_file() {
                    recorded
                } else {
                    installer_exe_path(cache_dir, &meta.manifest.version)
                }
            };
            let ok = if deep_verify {
                verify_downloaded_installer(
                    &exe_path,
                    meta.manifest.size_bytes,
                    &meta.manifest.sha256,
                )
                .is_ok()
                    && verify_sfx_payload_matches(&exe_path, &meta.manifest.version).is_ok()
            } else {
                fs::metadata(&exe_path)
                    .map(|m| m.is_file() && m.len() == meta.manifest.size_bytes)
                    .unwrap_or(false)
            };
            if ok {
                let replace = best
                    .as_ref()
                    .and_then(|(b, _, _)| compare_semver(&meta.manifest.version, &b.version))
                    .map(|ord| ord == Ordering::Greater)
                    .unwrap_or(true);
                if replace {
                    best = Some((meta.manifest, exe_path, sig_verified));
                }
            }
        }
    }

    if best.is_some() {
        return best;
    }

    // Self-heal if Setup-<ver>.exe was verified or finished downloading but its sidecar was missing.
    if let Some(release) = fallback_release {
        if compare_semver(&release.version, CURRENT_APP_VERSION) == Some(Ordering::Greater) {
            if let Ok(sig_verified) =
                verify_manifest_signature_with_pubkey(release, EMBEDDED_UPDATE_PUBKEY_HEX)
            {
                let exe_path = installer_exe_path(cache_dir, &release.version);
                if verify_downloaded_installer(&exe_path, release.size_bytes, &release.sha256)
                    .is_ok()
                    && verify_sfx_payload_matches(&exe_path, &release.version).is_ok()
                {
                    let _ = write_ready_metadata_atomic(cache_dir, release, &exe_path, unix_now());
                    return Some((release.clone(), exe_path, sig_verified));
                }
            }
        }
    }

    None
}

pub fn get_app_update_status(state: &UpdaterState) -> AppUpdateStatusDto {
    let cache_dir = update_cache_dir();
    let checked_at = state.last_checked_unix.lock().ok().and_then(|g| *g);
    let cached_release = state.latest_release.lock().ok().and_then(|g| g.clone());

    if let Some((manifest, exe_path, sig_verified)) =
        find_verified_cached_update(&cache_dir, cached_release.as_ref(), false)
    {
        return AppUpdateStatusDto {
            current_version: CURRENT_APP_VERSION.to_string(),
            availability: UpdateAvailability::DownloadedReady,
            available_release: Some(manifest.clone()),
            downloaded_installer_path: Some(exe_path.to_string_lossy().into_owned()),
            cache_dir: cache_dir.to_string_lossy().into_owned(),
            checked_at_unix: checked_at,
            signature_verified: sig_verified,
            message: format!(
                "Epilod Party v{} downloaded and verified — ready to install",
                manifest.version
            ),
        };
    }

    if let Some(release) = cached_release {
        if compare_semver(&release.version, CURRENT_APP_VERSION) == Some(Ordering::Greater) {
            let sig_verified =
                verify_manifest_signature_with_pubkey(&release, EMBEDDED_UPDATE_PUBKEY_HEX)
                    .unwrap_or(false);
            return AppUpdateStatusDto {
                current_version: CURRENT_APP_VERSION.to_string(),
                availability: UpdateAvailability::UpdateAvailable,
                available_release: Some(release.clone()),
                downloaded_installer_path: None,
                cache_dir: cache_dir.to_string_lossy().into_owned(),
                checked_at_unix: checked_at,
                signature_verified: sig_verified,
                message: format!("Update available: Epilod Party v{}", release.version),
            };
        }
    }

    AppUpdateStatusDto {
        current_version: CURRENT_APP_VERSION.to_string(),
        availability: UpdateAvailability::UpToDate,
        available_release: None,
        downloaded_installer_path: None,
        cache_dir: cache_dir.to_string_lossy().into_owned(),
        checked_at_unix: checked_at,
        signature_verified: false,
        message: format!("Epilod Party v{CURRENT_APP_VERSION} is up to date"),
    }
}

pub async fn check_for_updates(state: &UpdaterState) -> Result<AppUpdateStatusDto, String> {
    let cache_dir = update_cache_dir();
    let cache_for_cleanup = cache_dir.clone();
    let _ = tokio::task::spawn_blocking(move || {
        cleanup_stale_update_cache(&cache_for_cleanup, CURRENT_APP_VERSION, unix_now());
    })
    .await;

    let manifest_bytes = match fetch_https_bytes(DEFAULT_MANIFEST_URL, MAX_MANIFEST_BYTES).await {
        Ok(bytes) => bytes,
        Err((status_opt, first_err)) => {
            // If direct fixed latest manifest returns 404 or hit a transient socket/TLS error,
            // probe GitHub Releases API cleanly while preserving API rate-limit / HTTP errors.
            if matches!(status_opt, Some(404) | None) {
                match fetch_https_bytes(DEFAULT_RELEASES_API_URL, MAX_MANIFEST_BYTES).await {
                    Ok(api_bytes) => match extract_manifest_url_from_github_release(&api_bytes) {
                        Ok(Some(asset_url)) => fetch_https_bytes(&asset_url, MAX_MANIFEST_BYTES)
                            .await
                            .map_err(|(_, e)| e)?,
                        Ok(None) => {
                            let now = unix_now();
                            if let Ok(mut ts) = state.last_checked_unix.lock() {
                                *ts = Some(now);
                            }
                            return Ok(AppUpdateStatusDto {
                                current_version: CURRENT_APP_VERSION.to_string(),
                                availability: UpdateAvailability::UpToDate,
                                available_release: None,
                                downloaded_installer_path: None,
                                cache_dir: cache_dir.to_string_lossy().into_owned(),
                                checked_at_unix: Some(now),
                                signature_verified: false,
                                message: format!(
                                    "No update manifest published yet (running v{CURRENT_APP_VERSION})"
                                ),
                            });
                        }
                        Err(e) => return Err(e.to_string()),
                    },
                    Err((Some(404), _)) => {
                        let now = unix_now();
                        if let Ok(mut ts) = state.last_checked_unix.lock() {
                            *ts = Some(now);
                        }
                        return Ok(AppUpdateStatusDto {
                            current_version: CURRENT_APP_VERSION.to_string(),
                            availability: UpdateAvailability::UpToDate,
                            available_release: None,
                            downloaded_installer_path: None,
                            cache_dir: cache_dir.to_string_lossy().into_owned(),
                            checked_at_unix: Some(now),
                            signature_verified: false,
                            message: format!(
                                "No public releases published yet (running v{CURRENT_APP_VERSION})"
                            ),
                        });
                    }
                    Err((Some(403 | 429), _)) => {
                        return Err(
                            "GitHub API rate limit exceeded while checking for updates; please wait a few minutes and retry."
                                .to_string(),
                        );
                    }
                    Err((Some(_), api_err)) => {
                        return Err(api_err);
                    }
                    Err((None, api_err)) => {
                        return Err(if matches!(status_opt, Some(404)) || first_err.is_empty() {
                            api_err
                        } else {
                            format!("{first_err} (Releases API fallback: {api_err})")
                        });
                    }
                }
            } else {
                return Err(first_err);
            }
        }
    };

    let now = unix_now();
    if let Ok(mut ts) = state.last_checked_unix.lock() {
        *ts = Some(now);
    }

    let cache_for_verify = cache_dir.clone();
    let verify_outcome = tokio::task::spawn_blocking(move || {
        let parsed =
            parse_and_validate_manifest_with_signature(&manifest_bytes, CURRENT_APP_VERSION);
        match parsed {
            Ok((manifest, mut availability, sig_verified)) => {
                // Prune any older superseded cached updates when a newer release becomes latest
                cleanup_update_cache_with_keep(
                    &cache_for_verify,
                    CURRENT_APP_VERSION,
                    Some(&manifest.version),
                    now,
                );

                let mut downloaded_path: Option<String> = None;
                let mut message = match availability {
                    UpdateAvailability::UpToDate => {
                        format!("Epilod Party v{CURRENT_APP_VERSION} is up to date")
                    }
                    UpdateAvailability::UpdateAvailable => {
                        format!("Update available: Epilod Party v{}", manifest.version)
                    }
                    UpdateAvailability::DownloadedReady => {
                        format!("Epilod Party v{} ready to install", manifest.version)
                    }
                    UpdateAvailability::UnsupportedUpgrade => {
                        "Manual reinstall required for this release".to_string()
                    }
                };

                if availability == UpdateAvailability::UpdateAvailable {
                    let candidate = installer_exe_path(&cache_for_verify, &manifest.version);
                    if verify_downloaded_installer(
                        &candidate,
                        manifest.size_bytes,
                        &manifest.sha256,
                    )
                    .is_ok()
                        && verify_sfx_payload_matches(&candidate, &manifest.version).is_ok()
                    {
                        let _ = write_ready_metadata_atomic(
                            &cache_for_verify,
                            &manifest,
                            &candidate,
                            now,
                        );
                        availability = UpdateAvailability::DownloadedReady;
                        downloaded_path = Some(candidate.to_string_lossy().into_owned());
                        message = format!(
                            "Epilod Party v{} already downloaded and verified — ready to install",
                            manifest.version
                        );
                    }
                }
                Ok(Ok((
                    manifest,
                    availability,
                    sig_verified,
                    downloaded_path,
                    message,
                )))
            }
            Err(e) => Ok(Err(e)),
        }
    })
    .await
    .map_err(|e| format!("Update verification task failed: {e}"))?;

    match verify_outcome {
        Ok(Ok((manifest, availability, sig_verified, downloaded_path, message))) => {
            if let Ok(mut rel) = state.latest_release.lock() {
                *rel = Some(manifest.clone());
            }
            Ok(AppUpdateStatusDto {
                current_version: CURRENT_APP_VERSION.to_string(),
                availability,
                available_release: if availability == UpdateAvailability::UpToDate {
                    None
                } else {
                    Some(manifest)
                },
                downloaded_installer_path: downloaded_path,
                cache_dir: cache_dir.to_string_lossy().into_owned(),
                checked_at_unix: Some(now),
                signature_verified: sig_verified,
                message,
            })
        }
        Ok(Err(epilod_core::updater::UpdateError::UnsupportedDirectUpgrade {
            current,
            target,
            min_req,
        })) => Ok(AppUpdateStatusDto {
            current_version: current,
            availability: UpdateAvailability::UnsupportedUpgrade,
            available_release: None,
            downloaded_installer_path: None,
            cache_dir: cache_dir.to_string_lossy().into_owned(),
            checked_at_unix: Some(now),
            signature_verified: false,
            message: format!(
                "Update v{target} requires v{min_req} or newer; download the installer directly from GitHub."
            ),
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(e) => Err(e),
    }
}

pub async fn download_update(
    app: AppHandle,
    state: &UpdaterState,
    manifest: Option<ReleaseManifest>,
) -> Result<AppUpdateStatusDto, String> {
    let (target_release, sig_verified) = match manifest {
        Some(m) => {
            let encoded = serde_json::to_vec(&m).map_err(|e| e.to_string())?;
            let (validated, avail, sig_verified) =
                parse_and_validate_manifest_with_signature(&encoded, CURRENT_APP_VERSION)
                    .map_err(|e| e.to_string())?;
            if avail != UpdateAvailability::UpdateAvailable {
                return Err("Selected release is not newer than the installed version.".to_string());
            }
            (validated, sig_verified)
        }
        None => {
            let cached = state
                .latest_release
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .ok_or_else(|| "Run 'Check for Updates' first.".to_string())?;
            let sig_verified =
                verify_manifest_signature_with_pubkey(&cached, EMBEDDED_UPDATE_PUBKEY_HEX)
                    .map_err(|e| e.to_string())?;
            (cached, sig_verified)
        }
    };

    {
        let mut guard = state
            .downloading
            .lock()
            .map_err(|_| "Updater lock poisoned.".to_string())?;
        if *guard {
            return Err("Update download is already in progress.".to_string());
        }
        *guard = true;
    }
    state.cancel_download.store(false, AtomicOrdering::SeqCst);

    let res = download_update_inner(
        &app,
        &state.cancel_download,
        &state.cancel_notify,
        &target_release,
        sig_verified,
    )
    .await;

    if let Ok(mut guard) = state.downloading.lock() {
        *guard = false;
    }

    res
}

async fn download_update_inner(
    app: &AppHandle,
    cancel_flag: &AtomicBool,
    cancel_notify: &Arc<Notify>,
    release: &ReleaseManifest,
    sig_verified: bool,
) -> Result<AppUpdateStatusDto, String> {
    let cache_dir = update_cache_dir();
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Cannot create update cache folder: {e}"))?;

    let final_exe = installer_exe_path(&cache_dir, &release.version);

    // Return immediately if an already-verified installer for this exact version & digest is present
    if verify_downloaded_installer(&final_exe, release.size_bytes, &release.sha256).is_ok()
        && verify_sfx_payload_matches(&final_exe, &release.version).is_ok()
    {
        let now = unix_now();
        let _ = write_ready_metadata_atomic(&cache_dir, release, &final_exe, now);
        cleanup_update_cache_with_keep(
            &cache_dir,
            CURRENT_APP_VERSION,
            Some(&release.version),
            now,
        );
        emit_progress(
            app,
            "ready",
            release.size_bytes,
            release.size_bytes,
            100.0,
            0,
            format!("Verified v{} update installer", release.version),
        );
        return Ok(AppUpdateStatusDto {
            current_version: CURRENT_APP_VERSION.to_string(),
            availability: UpdateAvailability::DownloadedReady,
            available_release: Some(release.clone()),
            downloaded_installer_path: Some(final_exe.to_string_lossy().into_owned()),
            cache_dir: cache_dir.to_string_lossy().into_owned(),
            checked_at_unix: Some(now),
            signature_verified: sig_verified,
            message: format!("Epilod Party v{} downloaded and verified", release.version),
        });
    }

    let needed_free = release.size_bytes.saturating_add(64 * 1024 * 1024);
    if let Some(free) = query_free_disk_bytes(&cache_dir) {
        if free < needed_free {
            return Err(format!(
                "Not enough free disk space in {} (need at least {} MB).",
                cache_dir.display(),
                needed_free / (1024 * 1024)
            ));
        }
    }

    let part_path = installer_part_path(&cache_dir, &release.version);
    let p_meta_path = part_meta_path(&part_path);
    emit_progress(
        app,
        "downloading",
        0,
        release.size_bytes,
        0.0,
        0,
        format!(
            "Connecting to official GitHub release v{}...",
            release.version
        ),
    );

    if let Err(direct_err) =
        stream_https_download_resumable(release, &part_path, cancel_flag, cancel_notify, app).await
    {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            let saved_bytes = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
            let saved_pct = if release.size_bytes > 0 {
                ((saved_bytes as f64 / release.size_bytes as f64) * 98.0).clamp(0.0, 98.0)
            } else {
                0.0
            };
            emit_progress(
                app,
                "paused",
                saved_bytes,
                release.size_bytes,
                saved_pct,
                0,
                format!(
                    "Download paused ({:.1} / {:.1} MB kept)",
                    saved_bytes as f64 / (1024.0 * 1024.0),
                    release.size_bytes as f64 / (1024.0 * 1024.0)
                ),
            );
            return Err("Update download paused — partial file kept for resume.".to_string());
        }

        // Proxy / corporate TLS fallback via hardened .NET HttpWebRequest
        let resume_offset = validated_resume_offset(release, &part_path).unwrap_or(0);
        emit_progress(
            app,
            "downloading",
            resume_offset,
            release.size_bytes,
            if release.size_bytes > 0 {
                ((resume_offset as f64 / release.size_bytes as f64) * 98.0).clamp(0.0, 98.0)
            } else {
                0.0
            },
            0,
            "Direct TLS unavailable — retrying through Windows proxy settings...",
        );

        let proxy_res = download_via_windows_proxy_fallback(
            release,
            &part_path,
            resume_offset,
            cancel_flag,
            cancel_notify,
            app,
        )
        .await;

        if cancel_flag.load(AtomicOrdering::SeqCst) {
            let saved_bytes = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
            let saved_pct = if release.size_bytes > 0 {
                ((saved_bytes as f64 / release.size_bytes as f64) * 98.0).clamp(0.0, 98.0)
            } else {
                0.0
            };
            emit_progress(
                app,
                "paused",
                saved_bytes,
                release.size_bytes,
                saved_pct,
                0,
                format!(
                    "Download paused ({:.1} / {:.1} MB kept)",
                    saved_bytes as f64 / (1024.0 * 1024.0),
                    release.size_bytes as f64 / (1024.0 * 1024.0)
                ),
            );
            return Err("Update download paused — partial file kept for resume.".to_string());
        }

        if let Err(proxy_err) = proxy_res {
            return Err(format!("{direct_err} (Proxy fallback: {proxy_err})"));
        }
    }

    emit_progress(
        app,
        "verifying",
        release.size_bytes,
        release.size_bytes,
        99.0,
        0,
        "Verifying installer SHA-256 checksum & package integrity...",
    );

    if let Err(err) = verify_downloaded_installer(&part_path, release.size_bytes, &release.sha256) {
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&p_meta_path);
        return Err(err.to_string());
    }
    if let Err(err) = verify_sfx_payload_matches(&part_path, &release.version) {
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&p_meta_path);
        return Err(err);
    }

    if final_exe.exists() {
        let _ = fs::remove_file(&final_exe);
    }
    fs::rename(&part_path, &final_exe)
        .map_err(|e| format!("Failed saving verified update installer: {e}"))?;
    let _ = fs::remove_file(&p_meta_path);

    let now = unix_now();
    write_ready_metadata_atomic(&cache_dir, release, &final_exe, now)?;
    cleanup_update_cache_with_keep(&cache_dir, CURRENT_APP_VERSION, Some(&release.version), now);

    emit_progress(
        app,
        "ready",
        release.size_bytes,
        release.size_bytes,
        100.0,
        0,
        format!(
            "Verified v{} installer — ready to restart and update",
            release.version
        ),
    );

    Ok(AppUpdateStatusDto {
        current_version: CURRENT_APP_VERSION.to_string(),
        availability: UpdateAvailability::DownloadedReady,
        available_release: Some(release.clone()),
        downloaded_installer_path: Some(final_exe.to_string_lossy().into_owned()),
        cache_dir: cache_dir.to_string_lossy().into_owned(),
        checked_at_unix: Some(now),
        signature_verified: sig_verified,
        message: format!("Epilod Party v{} downloaded and verified", release.version),
    })
}

pub fn prepare_verified_updater_launch(
    cache_dir: &Path,
) -> Result<(PathBuf, PathBuf, ReleaseManifest, bool), String> {
    let (manifest, setup_exe, _) =
        find_verified_cached_update(cache_dir, None, true).ok_or_else(|| {
            "No verified downloaded update was found. Check for updates and download again."
                .to_string()
        })?;

    // Strict pre-execution integrity & optional Authenticode re-check right before spawning
    verify_downloaded_installer(&setup_exe, manifest.size_bytes, &manifest.sha256)
        .map_err(|e| e.to_string())?;
    verify_sfx_payload_matches(&setup_exe, &manifest.version)?;
    verify_authenticode_if_signed(&setup_exe)?;

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let reg_dir = read_hkcu_install_location();
    let default_dir = std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("Epilod Party"))
        .unwrap_or_else(|| PathBuf::from(r"C:\Epilod Party"));

    let install_dir =
        crate::resolve_update_target_dir(exe_dir.as_deref(), reg_dir.as_deref(), &default_dir);

    let needs_elevation = check_directory_acl_writable(&install_dir).is_err();

    Ok((setup_exe, install_dir, manifest, needs_elevation))
}

pub fn spawn_downloaded_updater(
    setup_exe: &Path,
    install_dir: &Path,
    cache_dir: &Path,
    silent: bool,
) -> Result<Child, String> {
    let pid_str = std::process::id().to_string();
    let dir_str = install_dir.to_string_lossy().into_owned();
    let mut args = vec![
        "--update",
        "--dir",
        &dir_str,
        "--wait-pid",
        &pid_str,
        "--relaunch",
    ];
    if silent {
        args.push("--silent");
    }

    Command::new(setup_exe)
        .args(&args)
        .current_dir(cache_dir)
        .spawn()
        .map_err(|e| format!("Failed launching Epilod Party Setup updater: {e}"))
}

pub fn spawn_elevated_updater(
    setup_exe: &Path,
    install_dir: &Path,
    cache_dir: &Path,
) -> Result<(), String> {
    let pid = std::process::id();
    let escaped_dir = install_dir.to_string_lossy().replace('"', "\"\"");
    let params = format!("--update --dir \"{escaped_dir}\" --wait-pid {pid} --relaunch");

    let w_verb: Vec<u16> = OsStr::new("runas")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let w_exe: Vec<u16> = setup_exe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let w_params: Vec<u16> = OsStr::new(&params)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let w_dir: Vec<u16> = cache_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let hinst = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            w_verb.as_ptr(),
            w_exe.as_ptr(),
            w_params.as_ptr(),
            w_dir.as_ptr(),
            SW_SHOWNORMAL,
        )
    };
    let code = hinst as isize;
    if code <= 32 {
        let win_err = unsafe { GetLastError() };
        if code == 5 || win_err == 1223 {
            return Err(
                "Administrator permission was cancelled or denied; update was not started."
                    .to_string(),
            );
        }
        return Err(format!(
            "Failed requesting elevation for updater (ShellExecute code {code}, Win32 {win_err})."
        ));
    }
    Ok(())
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

fn check_directory_acl_writable(dir: &Path) -> Result<(), String> {
    let Some(existing_dir) = nearest_existing_dir(dir) else {
        return Err("Target drive or parent folder does not exist.".to_string());
    };
    let wide_path: Vec<u16> = existing_dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
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
            return Err("Install folder requires Administrator privileges.".to_string());
        }
        if sec_status == ERROR_INVALID_FUNCTION || sec_status == ERROR_NOT_SUPPORTED {
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

    if (check_ok != 0 && access_status == 0)
        || (check_ok == 0 && unsafe { GetLastError() } == ERROR_ACCESS_DENIED)
    {
        return Err("Install folder requires Administrator privileges.".to_string());
    }

    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: f64,
    speed_bps: u64,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "updater://progress",
        UpdateProgressDto {
            stage: stage.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
            speed_bps,
            message: message.into(),
        },
    );
}

fn validated_resume_offset(release: &ReleaseManifest, part_path: &Path) -> Option<u64> {
    let p_meta_path = part_meta_path(part_path);
    let len = fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);
    if len == 0 || len >= release.size_bytes {
        let _ = fs::remove_file(part_path);
        let _ = fs::remove_file(&p_meta_path);
        return None;
    }
    let Ok(raw) = fs::read(&p_meta_path) else {
        let _ = fs::remove_file(part_path);
        return None;
    };
    let Ok(meta) = serde_json::from_slice::<PartResumeMetadata>(&raw) else {
        let _ = fs::remove_file(part_path);
        let _ = fs::remove_file(&p_meta_path);
        return None;
    };
    let matches = meta.version == release.version
        && meta.sha256.eq_ignore_ascii_case(&release.sha256)
        && meta.size_bytes == release.size_bytes
        && meta.download_url == release.download_url;
    if !matches {
        let _ = fs::remove_file(part_path);
        let _ = fs::remove_file(&p_meta_path);
        return None;
    }
    Some(len)
}

fn write_part_metadata_atomic(release: &ReleaseManifest, part_path: &Path) -> Result<(), String> {
    let p_meta_path = part_meta_path(part_path);
    let meta = PartResumeMetadata {
        version: release.version.clone(),
        sha256: release.sha256.to_ascii_lowercase(),
        size_bytes: release.size_bytes,
        download_url: release.download_url.clone(),
    };
    let json = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
    let tmp = part_path.with_extension("part.meta.json.tmp");
    fs::write(&tmp, json)
        .and_then(|()| {
            if p_meta_path.exists() {
                let _ = fs::remove_file(&p_meta_path);
            }
            fs::rename(&tmp, &p_meta_path)
        })
        .map_err(|e| format!("Failed writing partial download metadata: {e}"))
}

fn validate_partial_head(
    head: &HttpResponseHead,
    expected_offset: u64,
    expected_total: u64,
) -> bool {
    if head.status != 206 {
        return false;
    }
    let Some(ref cr) = head.content_range else {
        return false;
    };
    if cr.start != Some(expected_offset) {
        return false;
    }
    if let Some(total) = cr.total {
        if total != expected_total {
            return false;
        }
    }
    if let Some(end) = cr.end {
        if end < expected_offset || end >= expected_total {
            return false;
        }
    }
    if let Some(cl) = head.content_length {
        if expected_offset.saturating_add(cl) != expected_total {
            return false;
        }
    }
    true
}

async fn await_or_cancel<T, F>(
    cancel_flag: &AtomicBool,
    cancel_notify: &Notify,
    op: F,
) -> Result<T, (Option<u16>, String)>
where
    F: std::future::Future<Output = Result<T, (Option<u16>, String)>>,
{
    let cancelled = cancel_notify.notified();
    tokio::pin!(cancelled);
    if cancel_flag.load(AtomicOrdering::SeqCst) {
        return Err((None, "Download paused cleanly.".to_string()));
    }
    tokio::select! {
        biased;
        _ = &mut cancelled => Err((None, "Download paused cleanly.".to_string())),
        res = op => res,
    }
}

async fn open_https_get(
    start_url: &str,
    range_start: Option<u64>,
    cancel_flag: &AtomicBool,
    cancel_notify: &Notify,
) -> Result<
    (
        HttpResponseHead,
        Vec<u8>,
        tokio_native_tls::TlsStream<TcpStream>,
    ),
    (Option<u16>, String),
> {
    let mut current =
        validate_https_url(start_url, ALLOWED_UPDATE_HOSTS).map_err(|e| (None, e.to_string()))?;

    for _hop in 0..=MAX_REDIRECTS {
        let addr = format!("{}:{}", current.host, current.port);
        let tcp = await_or_cancel(cancel_flag, cancel_notify, async {
            timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
                .await
                .map_err(|_| (None, format!("Timed out connecting to {}", current.host)))?
                .map_err(|e| (None, format!("Connection failed to {}: {e}", current.host)))
        })
        .await?;

        let connector = NativeTlsConnector::new()
            .map_err(|e| (None, format!("TLS initializer failed: {e}")))?;
        let tls_connector = TlsConnector::from(connector);
        let mut tls = await_or_cancel(cancel_flag, cancel_notify, async {
            timeout(CONNECT_TIMEOUT, tls_connector.connect(&current.host, tcp))
                .await
                .map_err(|_| {
                    (
                        None,
                        format!("TLS handshake timed out with {}", current.host),
                    )
                })?
                .map_err(|e| {
                    (
                        None,
                        format!("TLS verification failed for {}: {e}", current.host),
                    )
                })
        })
        .await?;

        let mut req = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: {}\r\nAccept: application/json, application/octet-stream, */*\r\nConnection: close\r\n",
            current.path_and_query, current.host, USER_AGENT
        );
        if let Some(start) = range_start {
            if start > 0 {
                req.push_str(&format!("Range: bytes={start}-\r\n"));
            }
        }
        req.push_str("\r\n");

        await_or_cancel(cancel_flag, cancel_notify, async {
            timeout(READ_TIMEOUT, tls.write_all(req.as_bytes()))
                .await
                .map_err(|_| (None, "Timed out sending HTTPS request.".to_string()))?
                .map_err(|e| (None, format!("Failed sending HTTPS request: {e}")))
        })
        .await?;

        let mut header_buf = Vec::with_capacity(8192);
        let mut tmp = [0u8; 4096];
        loop {
            if find_http_header_end(&header_buf).is_some() {
                break;
            }
            if header_buf.len() > 64 * 1024 {
                return Err((
                    None,
                    "HTTP response headers exceeded 64 KB limit.".to_string(),
                ));
            }
            let n = await_or_cancel(cancel_flag, cancel_notify, async {
                timeout(READ_TIMEOUT, tls.read(&mut tmp))
                    .await
                    .map_err(|_| {
                        (
                            None,
                            "Timed out reading HTTPS response headers.".to_string(),
                        )
                    })?
                    .map_err(|e| (None, format!("Error reading HTTPS headers: {e}")))
            })
            .await?;
            if n == 0 {
                return Err((
                    None,
                    "Update server closed connection before headers.".to_string(),
                ));
            }
            header_buf.extend_from_slice(&tmp[..n]);
        }

        let head = parse_http_head(&header_buf).map_err(|e| (None, e.to_string()))?;
        if matches!(head.status, 301 | 302 | 303 | 307 | 308) {
            let loc = head.location.as_deref().ok_or_else(|| {
                (
                    Some(head.status),
                    "HTTP redirect missing Location header.".to_string(),
                )
            })?;
            current = resolve_redirect_url(&current, loc, ALLOWED_UPDATE_HOSTS)
                .map_err(|e| (Some(head.status), e.to_string()))?;
            continue;
        }

        let leftover = header_buf[head.body_offset..].to_vec();
        return Ok((head, leftover, tls));
    }

    Err((
        None,
        "Too many redirects while contacting update server.".to_string(),
    ))
}

async fn fetch_https_bytes(url: &str, max_bytes: usize) -> Result<Vec<u8>, (Option<u16>, String)> {
    match fetch_https_bytes_direct(url, max_bytes).await {
        Ok(bytes) => Ok(bytes),
        Err((None, direct_err)) => match fetch_via_windows_proxy_fallback(url, max_bytes).await {
            Ok(bytes) => Ok(bytes),
            Err((Some(status), proxy_err)) => Err((Some(status), proxy_err)),
            Err((None, proxy_err)) => {
                Err((None, format!("{direct_err} (Proxy fallback: {proxy_err})")))
            }
        },
        Err(http_err) => Err(http_err),
    }
}

async fn fetch_https_bytes_direct(
    url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, (Option<u16>, String)> {
    let never_cancel = AtomicBool::new(false);
    let never_notify = Notify::new();
    let (head, leftover, mut tls) = open_https_get(url, None, &never_cancel, &never_notify).await?;
    if head.status < 200 || head.status >= 300 {
        return Err((
            Some(head.status),
            format!("Update server returned HTTP {}", head.status),
        ));
    }

    let mut body = Vec::new();
    let mut decoder = ChunkedDecoder::default();
    if head.chunked {
        let piece = decoder
            .push(&leftover)
            .map_err(|e| (Some(head.status), e.to_string()))?;
        body.extend_from_slice(&piece);
    } else {
        body.extend_from_slice(&leftover);
    }
    if body.len() > max_bytes {
        return Err((
            Some(head.status),
            "Release manifest exceeds size limit.".to_string(),
        ));
    }

    let mut tmp = [0u8; 16 * 1024];
    while !(head.chunked && decoder.is_finished())
        && head
            .content_length
            .map(|len| (body.len() as u64) < len)
            .unwrap_or(true)
    {
        let n = timeout(READ_TIMEOUT, tls.read(&mut tmp))
            .await
            .map_err(|_| (None, "Timed out reading release manifest.".to_string()))?
            .map_err(|e| (None, format!("Error reading release manifest: {e}")))?;
        if n == 0 {
            break;
        }
        if head.chunked {
            let piece = decoder
                .push(&tmp[..n])
                .map_err(|e| (Some(head.status), e.to_string()))?;
            body.extend_from_slice(&piece);
        } else {
            body.extend_from_slice(&tmp[..n]);
        }
        if body.len() > max_bytes {
            return Err((
                Some(head.status),
                "Release manifest exceeds size limit.".to_string(),
            ));
        }
    }

    if head.chunked && !decoder.is_finished() {
        return Err((
            Some(head.status),
            "Release manifest response ended before final HTTP chunk.".to_string(),
        ));
    }
    if let Some(expected_len) = head.content_length {
        if (body.len() as u64) != expected_len {
            return Err((
                Some(head.status),
                format!(
                    "Release manifest response truncated ({} of {} bytes received).",
                    body.len(),
                    expected_len
                ),
            ));
        }
    }
    if body.is_empty() {
        return Err((
            Some(head.status),
            "Release manifest response was empty.".to_string(),
        ));
    }

    Ok(body)
}

async fn stream_https_download_resumable(
    release: &ReleaseManifest,
    part_path: &Path,
    cancel_flag: &AtomicBool,
    cancel_notify: &Notify,
    app: &AppHandle,
) -> Result<(), String> {
    let url = release.download_url.as_str();
    let expected_size = release.size_bytes;
    let p_meta_path = part_meta_path(part_path);
    let mut resume_from = validated_resume_offset(release, part_path);

    let (mut head, mut leftover, mut tls) =
        open_https_get(url, resume_from, cancel_flag, cancel_notify)
            .await
            .map_err(|(_, e)| e)?;

    if head.status == 416 && resume_from.is_some() {
        let _ = fs::remove_file(part_path);
        let _ = fs::remove_file(&p_meta_path);
        resume_from = None;
        let retry = open_https_get(url, None, cancel_flag, cancel_notify)
            .await
            .map_err(|(_, e)| e)?;
        head = retry.0;
        leftover = retry.1;
        tls = retry.2;
    } else if head.status == 206 {
        let valid_206 = resume_from
            .map(|off| validate_partial_head(&head, off, expected_size))
            .unwrap_or(false);
        if !valid_206 {
            let _ = fs::remove_file(part_path);
            let _ = fs::remove_file(&p_meta_path);
            resume_from = None;
            let retry = open_https_get(url, None, cancel_flag, cancel_notify)
                .await
                .map_err(|(_, e)| e)?;
            head = retry.0;
            leftover = retry.1;
            tls = retry.2;
        }
    } else if head.status == 200 {
        if let Some(cl) = head.content_length {
            if cl != expected_size {
                return Err(format!(
                    "Download server reported unexpected size ({cl} != {expected_size})."
                ));
            }
        }
    }

    if head.status != 200 && head.status != 206 {
        return Err(format!("Download server returned HTTP {}", head.status));
    }

    let mut file = if head.status == 206 && resume_from.is_some() {
        let offset = resume_from.unwrap_or(0);
        let mut f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(part_path)
            .map_err(|e| format!("Cannot open partial update file: {e}"))?;
        f.set_len(offset)
            .and_then(|()| f.seek(SeekFrom::Start(offset)))
            .map_err(|e| format!("Failed seeking partial update file: {e}"))?;
        f
    } else {
        File::create(part_path).map_err(|e| format!("Cannot create update file: {e}"))?
    };

    write_part_metadata_atomic(release, part_path)?;

    let mut downloaded: u64 = if head.status == 206 {
        resume_from.unwrap_or(0)
    } else {
        0
    };
    let start_instant = Instant::now();
    let start_offset = downloaded;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut decoder = ChunkedDecoder::default();

    let mut push_bytes = |downloaded: &mut u64, chunk: &[u8]| -> Result<(), String> {
        if chunk.is_empty() {
            return Ok(());
        }
        *downloaded = downloaded.saturating_add(chunk.len() as u64);
        if *downloaded > MAX_INSTALLER_BYTES
            || *downloaded > expected_size.saturating_add(1024 * 1024)
        {
            return Err("Downloaded stream exceeded declared installer size.".to_string());
        }
        file.write_all(chunk)
            .map_err(|e| format!("Disk write error during update download: {e}"))?;
        Ok(())
    };

    if head.chunked {
        let decoded = decoder.push(&leftover).map_err(|e| e.to_string())?;
        push_bytes(&mut downloaded, &decoded)?;
    } else {
        push_bytes(&mut downloaded, &leftover)?;
    }

    let mut buf = vec![0u8; 64 * 1024];
    while downloaded < expected_size && !(head.chunked && decoder.is_finished()) {
        if cancel_flag.load(AtomicOrdering::SeqCst) {
            let _ = file.flush();
            return Err("Download paused cleanly.".to_string());
        }

        let n = match await_or_cancel(cancel_flag, cancel_notify, async {
            timeout(READ_TIMEOUT, tls.read(&mut buf))
                .await
                .map_err(|_| (None, "Timed out receiving installer bytes.".to_string()))?
                .map_err(|e| (None, format!("Network error receiving update: {e}")))
        })
        .await
        {
            Ok(n) => n,
            Err((_, e)) => {
                let _ = file.flush();
                return Err(e);
            }
        };
        if n == 0 {
            break;
        }

        if head.chunked {
            let decoded = decoder.push(&buf[..n]).map_err(|e| e.to_string())?;
            push_bytes(&mut downloaded, &decoded)?;
        } else {
            push_bytes(&mut downloaded, &buf[..n])?;
        }

        let now = Instant::now();
        if now.duration_since(last_emit) >= Duration::from_millis(75) || downloaded >= expected_size
        {
            last_emit = now;
            let elapsed = now.duration_since(start_instant).as_secs_f64().max(0.05);
            let session_bytes = downloaded.saturating_sub(start_offset);
            let speed_bps = (session_bytes as f64 / elapsed) as u64;
            let pct = if expected_size > 0 {
                ((downloaded as f64 / expected_size as f64) * 98.0).clamp(0.0, 98.0)
            } else {
                0.0
            };
            emit_progress(
                app,
                "downloading",
                downloaded,
                expected_size,
                pct,
                speed_bps,
                format!(
                    "Downloading update ({:.1} / {:.1} MB)",
                    downloaded as f64 / (1024.0 * 1024.0),
                    expected_size as f64 / (1024.0 * 1024.0)
                ),
            );
        }
    }

    file.flush()
        .map_err(|e| format!("Failed flushing downloaded installer: {e}"))?;

    if downloaded != expected_size {
        return Err(format!(
            "Download ended early ({downloaded} of {expected_size} bytes received)."
        ));
    }

    Ok(())
}

const PS_MANUAL_PROXY_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$proto = [Net.SecurityProtocolType]::Tls12
try { $proto = $proto -bor [Net.SecurityProtocolType]::Tls13 } catch {}
[Net.ServicePointManager]::SecurityProtocol = $proto

$allowed = @('github.com','api.github.com','objects.githubusercontent.com','release-assets.githubusercontent.com','github-releases.githubusercontent.com','raw.githubusercontent.com')
function Test-AllowedUri([Uri]$u) {
  if ($null -eq $u -or $u.Scheme -ne 'https' -or $u.Port -ne 443) { return $false }
  if (-not [string]::IsNullOrEmpty($u.UserInfo)) { return $false }
  $h = $u.Host.ToLowerInvariant()
  if ($allowed -notcontains $h) { return $false }
  $pq = $u.PathAndQuery
  if ($h -eq 'github.com' -and -not $pq.StartsWith('/ahmednazief/epilod-party/')) { return $false }
  if ($h -eq 'api.github.com' -and -not $pq.StartsWith('/repos/ahmednazief/epilod-party/')) { return $false }
  return $true
}

$curUri = [Uri]$env:EPILOD_DL_URL
$resume = [long]($env:EPILOD_DL_RESUME)
$maxBytes = [long]($env:EPILOD_DL_MAX)
$expected = [long]($env:EPILOD_DL_EXPECTED)
$resp = $null

for ($hop = 0; $hop -le 6; $hop++) {
  if (-not (Test-AllowedUri $curUri)) {
    [Console]::Out.WriteLine("UNTRUSTED_REDIRECT=$($curUri.AbsoluteUri)")
    exit 4
  }
  $req = [System.Net.HttpWebRequest]::Create($curUri)
  $req.UserAgent = $env:EPILOD_UA
  $req.Accept = 'application/json, application/octet-stream, */*'
  $req.Timeout = 20000
  $req.ReadWriteTimeout = 25000
  $req.AllowAutoRedirect = $false
  if ($resume -gt 0) { $req.AddRange($resume) }
  try {
    $r = [System.Net.HttpWebResponse]$req.GetResponse()
  } catch [System.Net.WebException] {
    if ($null -ne $_.Exception.Response) {
      $r = [System.Net.HttpWebResponse]$_.Exception.Response
      $sc = [int]$r.StatusCode
      if ($sc -in 301,302,303,307,308) {
        $loc = $r.Headers['Location']
        $r.Dispose()
        if ([string]::IsNullOrWhiteSpace($loc)) { exit 5 }
        $curUri = [Uri]::new($curUri, $loc)
        continue
      }
      $r.Dispose()
      [Console]::Out.WriteLine("STATUS=$sc")
      exit 6
    }
    throw
  }
  $sc = [int]$r.StatusCode
  if ($sc -in 301,302,303,307,308) {
    $loc = $r.Headers['Location']
    $r.Dispose()
    if ([string]::IsNullOrWhiteSpace($loc)) { exit 5 }
    $curUri = [Uri]::new($curUri, $loc)
    continue
  }
  $resp = $r
  break
}

if ($null -eq $resp) { exit 7 }
try {
  $sc = [int]$resp.StatusCode
  [Console]::Out.WriteLine("STATUS=$sc")
  [Console]::Out.WriteLine("FINAL_URI=$($resp.ResponseUri.AbsoluteUri)")
  if ($sc -lt 200 -or $sc -ge 300) { exit 6 }

  $cr = $resp.Headers['Content-Range']
  if ($sc -eq 206 -and $resume -gt 0) {
    if ([string]::IsNullOrWhiteSpace($cr)) {
      [Console]::Out.WriteLine("RANGE_MISMATCH=missing")
      exit 8
    }
    [Console]::Out.WriteLine("CONTENT_RANGE=$cr")
    if ($resp.ContentLength -ge 0 -and $expected -gt 0 -and ($resume + $resp.ContentLength) -ne $expected) {
      [Console]::Out.WriteLine("RANGE_MISMATCH=length")
      exit 8
    }
  } else {
    $resume = 0
    [Console]::Out.WriteLine("RESET_ZERO=1")
    if ($maxBytes -gt 0 -and $resp.ContentLength -gt $maxBytes) { exit 9 }
    if ($expected -gt 0 -and $resp.ContentLength -ge 0 -and $resp.ContentLength -ne $expected) {
      [Console]::Out.WriteLine("SIZE_MISMATCH=$($resp.ContentLength)")
      exit 9
    }
  }
  [Console]::Out.Flush()

  $in = $resp.GetResponseStream()
  if ($sc -eq 206 -and $resume -gt 0) {
    $out = [System.IO.FileStream]::new($env:EPILOD_DL_OUT, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $out.Seek($resume, [System.IO.SeekOrigin]::Begin) | Out-Null
    $out.SetLength($resume)
  } else {
    $out = [System.IO.File]::Create($env:EPILOD_DL_OUT)
  }
  $totalWritten = $resume
  $sinceEmit = 0
  try {
    $buf = New-Object byte[] 65536
    while (($read = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $totalWritten += $read
      if ($maxBytes -gt 0 -and $totalWritten -gt $maxBytes) { throw 'Exceeded maxBytes' }
      $out.Write($buf, 0, $read)
      $sinceEmit += $read
      if ($sinceEmit -ge 131072) {
        $sinceEmit = 0
        [Console]::Out.WriteLine("PROGRESS=$totalWritten")
        [Console]::Out.Flush()
      }
    }
    [Console]::Out.WriteLine("PROGRESS=$totalWritten")
    [Console]::Out.Flush()
  } finally {
    $out.Dispose()
    $in.Dispose()
  }
} finally {
  $resp.Dispose()
}
"#;

async fn fetch_via_windows_proxy_fallback(
    url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, (Option<u16>, String)> {
    let parsed =
        validate_https_url(url, ALLOWED_UPDATE_HOSTS).map_err(|e| (None, e.to_string()))?;
    let uniq = unix_now();
    let tmp_out = std::env::temp_dir().join(format!(
        "epilod-proxy-fetch-{}-{uniq}.tmp",
        std::process::id()
    ));

    let out = tokio::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            PS_MANUAL_PROXY_SCRIPT,
        ])
        .current_dir(std::env::temp_dir())
        .env("EPILOD_DL_URL", &parsed.full_url)
        .env("EPILOD_DL_OUT", tmp_out.as_os_str())
        .env("EPILOD_DL_RESUME", "0")
        .env("EPILOD_DL_MAX", max_bytes.to_string())
        .env("EPILOD_DL_EXPECTED", "0")
        .env("EPILOD_UA", USER_AGENT)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| (None, format!("Proxy check failed to start: {e}")))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let status_code = stdout
        .lines()
        .find_map(|l| l.strip_prefix("STATUS="))
        .and_then(|s| s.trim().parse::<u16>().ok());

    if let Some(final_url) = stdout
        .lines()
        .find_map(|l| l.strip_prefix("FINAL_URI="))
        .map(str::trim)
    {
        if validate_https_url(final_url, ALLOWED_UPDATE_HOSTS).is_err() {
            let _ = fs::remove_file(&tmp_out);
            return Err((
                status_code,
                "Blocked redirect to untrusted domain during proxy check.".to_string(),
            ));
        }
    }

    if !out.status.success() {
        let _ = fs::remove_file(&tmp_out);
        if let Some(sc) = status_code {
            return Err((Some(sc), format!("Update server returned HTTP {sc}")));
        }
        return Err((None, "Windows proxy HTTPS request failed.".to_string()));
    }

    let bytes = fs::read(&tmp_out)
        .map_err(|e| (status_code, format!("Failed reading proxy response: {e}")));
    let _ = fs::remove_file(&tmp_out);
    let bytes = bytes?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err((
            status_code,
            "Proxy manifest response size out of bounds.".to_string(),
        ));
    }
    Ok(bytes)
}

async fn download_via_windows_proxy_fallback(
    release: &ReleaseManifest,
    dest_part_path: &Path,
    resume_offset: u64,
    cancel_flag: &AtomicBool,
    cancel_notify: &Notify,
    app: &AppHandle,
) -> Result<(), String> {
    let parsed = validate_https_url(&release.download_url, ALLOWED_UPDATE_HOSTS)
        .map_err(|e| e.to_string())?;
    let expected_size = release.size_bytes;

    // Try with requested resume_offset first; if server rejects Range or mismatches Content-Range, retry once cleanly from 0.
    let mut active_resume = resume_offset;
    for attempt in 0..2 {
        write_part_metadata_atomic(release, dest_part_path)?;
        let mut child = tokio::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                PS_MANUAL_PROXY_SCRIPT,
            ])
            .current_dir(std::env::temp_dir())
            .env("EPILOD_DL_URL", &parsed.full_url)
            .env("EPILOD_DL_OUT", dest_part_path.as_os_str())
            .env("EPILOD_DL_RESUME", active_resume.to_string())
            .env("EPILOD_DL_MAX", MAX_INSTALLER_BYTES.to_string())
            .env("EPILOD_DL_EXPECTED", expected_size.to_string())
            .env("EPILOD_UA", USER_AGENT)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Proxy downloader failed to start: {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Proxy stdout unavailable".to_string())?;
        let mut lines = BufReader::new(stdout).lines();

        let start_instant = Instant::now();
        let mut baseline = active_resume;
        let mut saw_untrusted = false;
        let mut saw_range_mismatch = false;
        let mut status_code: Option<u16> = None;

        loop {
            let cancelled = cancel_notify.notified();
            tokio::pin!(cancelled);
            if cancel_flag.load(AtomicOrdering::SeqCst) {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err("Download paused cleanly.".to_string());
            }

            let line_opt = tokio::select! {
                biased;
                _ = &mut cancelled => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err("Download paused cleanly.".to_string());
                }
                res = lines.next_line() => res.map_err(|e| format!("Proxy output read error: {e}"))?,
            };

            let Some(line) = line_opt else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.starts_with("UNTRUSTED_REDIRECT=") {
                saw_untrusted = true;
            } else if trimmed.starts_with("RANGE_MISMATCH=") {
                saw_range_mismatch = true;
            } else if trimmed == "RESET_ZERO=1" {
                baseline = 0;
            } else if let Some(sc_str) = trimmed.strip_prefix("STATUS=") {
                status_code = sc_str.trim().parse::<u16>().ok();
            } else if let Some(cr_raw) = trimmed.strip_prefix("CONTENT_RANGE=") {
                let valid = parse_content_range(cr_raw)
                    .map(|cr| {
                        cr.start == Some(active_resume)
                            && cr.total.map(|t| t == expected_size).unwrap_or(true)
                    })
                    .unwrap_or(false);
                if !valid {
                    saw_range_mismatch = true;
                    let _ = child.kill().await;
                    break;
                }
            } else if let Some(final_url) = trimmed.strip_prefix("FINAL_URI=") {
                if validate_https_url(final_url, ALLOWED_UPDATE_HOSTS).is_err() {
                    saw_untrusted = true;
                    let _ = child.kill().await;
                    break;
                }
            } else if let Some(bytes_str) = trimmed.strip_prefix("PROGRESS=") {
                if let Ok(done) = bytes_str.trim().parse::<u64>() {
                    let elapsed = start_instant.elapsed().as_secs_f64().max(0.05);
                    let session_bytes = done.saturating_sub(baseline);
                    let speed_bps = (session_bytes as f64 / elapsed) as u64;
                    let pct = if expected_size > 0 {
                        ((done as f64 / expected_size as f64) * 98.0).clamp(0.0, 98.0)
                    } else {
                        0.0
                    };
                    emit_progress(
                        app,
                        "downloading",
                        done,
                        expected_size,
                        pct,
                        speed_bps,
                        format!(
                            "Downloading via Windows proxy ({:.1} / {:.1} MB)",
                            done as f64 / (1024.0 * 1024.0),
                            expected_size as f64 / (1024.0 * 1024.0)
                        ),
                    );
                }
            }
        }

        let exit = child
            .wait()
            .await
            .map_err(|e| format!("Proxy downloader wait error: {e}"))?;

        if saw_untrusted {
            let _ = fs::remove_file(dest_part_path);
            let _ = fs::remove_file(part_meta_path(dest_part_path));
            return Err("Blocked redirect to untrusted domain during proxy download.".to_string());
        }

        if (saw_range_mismatch || status_code == Some(416)) && active_resume > 0 && attempt == 0 {
            let _ = fs::remove_file(dest_part_path);
            let _ = fs::remove_file(part_meta_path(dest_part_path));
            active_resume = 0;
            continue;
        }

        if !exit.success() {
            if let Some(sc) = status_code {
                return Err(format!("Windows proxy download returned HTTP {sc}."));
            }
            return Err("Windows proxy download failed.".to_string());
        }

        let actual_size = fs::metadata(dest_part_path).map(|m| m.len()).unwrap_or(0);
        if actual_size != expected_size {
            return Err(format!(
                "Proxy download size mismatch ({actual_size} != {expected_size})."
            ));
        }
        return Ok(());
    }

    Err("Windows proxy download failed after range reset retry.".to_string())
}

fn query_free_disk_bytes(path: &Path) -> Option<u64> {
    let mut probe = path;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let wide: Vec<u16> = probe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
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

fn read_hkcu_install_location() -> Option<PathBuf> {
    let subkey: Vec<u16> = OsStr::new(UNINSTALL_REG_SUBKEY)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let value_name: Vec<u16> = OsStr::new("InstallLocation")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut hkey: HKEY = ptr::null_mut();
    let open_res =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) };
    if open_res != ERROR_SUCCESS || hkey.is_null() {
        return None;
    }

    let mut val_type: u32 = 0;
    let mut byte_len: u32 = 2048;
    let mut buf = vec![0u16; 1024];
    let query_res = unsafe {
        RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            ptr::null(),
            &mut val_type,
            buf.as_mut_ptr() as *mut u8,
            &mut byte_len,
        )
    };
    unsafe {
        RegCloseKey(hkey);
    }

    if query_res != ERROR_SUCCESS || val_type != REG_SZ || byte_len < 2 {
        return None;
    }

    let u16_len = (byte_len as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..u16_len])
        .trim_end_matches('\0')
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}
