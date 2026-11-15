use epilod_installer_core::archive::read_manifest;
use std::path::{Path, PathBuf};

#[cfg(windows)]
pub mod windows_install;

/// Resolves the installer payload archive with strict trust priority:
/// 1. Embedded SFX overlay attached directly to the running executable (never shadowed by a sibling `.epkg`).
/// 2. Explicit bundled Tauri `resource_dir` locations.
/// 3. In debug/dev builds only (`#[cfg(debug_assertions)]`), sibling `.epkg` next to the dev binary.
pub fn resolve_payload_path_from_exe_and_resources(
    current_exe: Option<&Path>,
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(exe) = current_exe {
        if exe.is_file() && read_manifest(exe).is_ok() {
            return Some(exe.to_path_buf());
        }
    }

    if let Some(res_dir) = resource_dir {
        let res_candidates = [
            res_dir
                .join("resources")
                .join("payload")
                .join("epilod-payload.epkg"),
            res_dir.join("payload").join("epilod-payload.epkg"),
            res_dir.join("epilod-payload.epkg"),
        ];
        for cand in res_candidates {
            if cand.is_file() && read_manifest(&cand).is_ok() {
                return Some(cand);
            }
        }
    }

    #[cfg(debug_assertions)]
    if let Some(dir) = current_exe.and_then(|p| p.parent()) {
        let dev_candidates = [
            dir.join("resources")
                .join("payload")
                .join("epilod-payload.epkg"),
            dir.join("epilod-payload.epkg"),
        ];
        for cand in dev_candidates {
            if cand.is_file() && read_manifest(&cand).is_ok() {
                return Some(cand);
            }
        }
    }

    None
}

#[cfg(windows)]
mod windows_app {
    use crate::resolve_payload_path_from_exe_and_resources;
    use crate::windows_install::{
        attach_parent_console, check_directory_acl_writable, close_running_processes_in_dir,
        detect_running_processes_in_dir, installed_exe_path, is_protected_windows_dir,
        query_free_disk_bytes, read_hkcu_install_location, run_silent_install_flow,
        run_silent_uninstall_flow, show_error_dialog, show_webview2_missing_dialog,
        test_directory_writable, SingleInstanceGuard, WindowsIntegrator,
    };
    use epilod_installer_core::archive::{estimate_uninstaller_copy_bytes, read_manifest};
    use epilod_installer_core::engine::{run_install_pipeline, run_uninstall_pipeline};
    use epilod_installer_core::plan::{
        build_ready_telemetry, build_uninstall_ready_telemetry, default_install_dir_string,
        parse_setup_cli_args_with_exe, resolve_install_dir, InstallMode, InstallOptions,
        InstallPhase, InstallTelemetry, UninstallOptions, UninstallSummary, APP_VERSION,
        DEFAULT_REQUIRED_BYTES,
    };
    use epilod_installer_core::receipt::{
        inspect_existing_install, preflight_existing_install, read_receipt, ExistingInstallReport,
        InstallDisposition,
    };
    use serde::Serialize;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::{AppHandle, Emitter, Manager, State};

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RunningProcessDto {
        pub pid: u32,
        pub name: String,
        pub executable_path: String,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DestinationInspection {
        pub resolved_dir: String,
        pub free_disk_bytes: Option<u64>,
        pub writable: bool,
        pub write_error: Option<String>,
        pub report: ExistingInstallReport,
        pub peak_required_bytes: u64,
        pub running_processes: Vec<RunningProcessDto>,
        pub saved_desktop_shortcut: Option<bool>,
        pub saved_start_menu_shortcut: Option<bool>,
        pub saved_file_associations: Option<bool>,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PreflightResult {
        pub resolved_dir: String,
        pub free_disk_bytes: Option<u64>,
        pub writable: bool,
        pub write_error: Option<String>,
        pub protected_dir: bool,
        pub report: ExistingInstallReport,
        pub peak_required_bytes: u64,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct InstallerDefaults {
        pub version: String,
        pub package_version: String,
        pub launch_mode: InstallMode,
        pub default_install_dir: String,
        pub writable: bool,
        pub write_error: Option<String>,
        pub free_disk_bytes: Option<u64>,
        pub required_bytes: u64,
        pub peak_required_bytes: u64,
        pub payload_files: usize,
        pub payload_available: bool,
        pub existing_install: bool,
        pub existing_report: ExistingInstallReport,
        pub running_processes: Vec<RunningProcessDto>,
        pub wait_pid: Option<u32>,
        pub auto_start: bool,
        pub auto_relaunch: bool,
        pub remove_user_data_default: bool,
        pub saved_desktop_shortcut: Option<bool>,
        pub saved_start_menu_shortcut: Option<bool>,
        pub saved_file_associations: Option<bool>,
        pub ready_telemetry: InstallTelemetry,
    }

    pub struct LaunchContext {
        pub mode: InstallMode,
        pub initial_install_dir: String,
        pub wait_pid: Option<u32>,
        pub auto_relaunch: bool,
        pub remove_user_data: bool,
    }

    pub struct InstallerState {
        pub running: Mutex<bool>,
        pub cancel_flag: Arc<AtomicBool>,
    }

    impl Default for InstallerState {
        fn default() -> Self {
            Self {
                running: Mutex::new(false),
                cancel_flag: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    fn compute_peak_required_bytes(bytes_to_write: u64) -> u64 {
        let uninstaller_bytes = std::env::current_exe()
            .ok()
            .map(|p| estimate_uninstaller_copy_bytes(&p))
            .unwrap_or(16 * 1024 * 1024);
        bytes_to_write
            .saturating_add(uninstaller_bytes)
            .saturating_add(24 * 1024 * 1024)
    }

    fn planned_write_bytes_for_report(report: &ExistingInstallReport) -> u64 {
        if report.disposition == InstallDisposition::UpToDateVerified {
            report.total_package_bytes.max(report.bytes_to_write)
        } else {
            report.bytes_to_write
        }
    }

    fn resolve_payload_path(app: &AppHandle) -> Option<PathBuf> {
        let exe_path = std::env::current_exe().ok();
        let res_dir = app.path().resource_dir().ok();
        resolve_payload_path_from_exe_and_resources(exe_path.as_deref(), res_dir.as_deref())
    }

    fn inspect_dir_internal(
        payload_path: Option<&Path>,
        raw_dir: &str,
    ) -> Result<DestinationInspection, String> {
        let resolved = resolve_install_dir(raw_dir).map_err(|e| e.to_string())?;
        let dir_path = Path::new(&resolved);
        let free_disk_bytes = query_free_disk_bytes(dir_path);
        let (writable, write_error) = match test_directory_writable(dir_path) {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        };

        let report = inspect_existing_install(payload_path, &resolved)?;
        let peak_required_bytes =
            compute_peak_required_bytes(planned_write_bytes_for_report(&report));
        let prev_receipt = read_receipt(dir_path);
        let running_processes = detect_running_processes_in_dir(dir_path)
            .into_iter()
            .map(|p| RunningProcessDto {
                pid: p.pid,
                name: p.name,
                executable_path: p.executable_path,
            })
            .collect();

        Ok(DestinationInspection {
            resolved_dir: resolved,
            free_disk_bytes,
            writable,
            write_error,
            report,
            peak_required_bytes,
            running_processes,
            saved_desktop_shortcut: prev_receipt.as_ref().map(|r| r.desktop_shortcut),
            saved_start_menu_shortcut: prev_receipt.as_ref().map(|r| r.start_menu_shortcut),
            saved_file_associations: prev_receipt.as_ref().map(|r| r.file_associations),
        })
    }

    #[tauri::command]
    async fn get_installer_defaults(
        app: AppHandle,
        ctx: State<'_, LaunchContext>,
    ) -> Result<InstallerDefaults, String> {
        let payload = resolve_payload_path(&app);
        let target_dir = ctx.initial_install_dir.clone();
        let mode_initial = ctx.mode;
        let wait_pid = ctx.wait_pid;
        let auto_relaunch = ctx.auto_relaunch;
        let remove_user_data_default = ctx.remove_user_data;

        tokio::task::spawn_blocking(move || {
            let manifest_meta = payload
                .as_deref()
                .and_then(|p| read_manifest(p).ok())
                .map(|(m, _)| (m.version, m.entries.len(), m.total_bytes.max(1)));

            let inspection = inspect_dir_internal(payload.as_deref(), &target_dir)?;

            let (package_version, payload_files, required_bytes, payload_available) =
                match manifest_meta {
                    Some((ver, count, bytes)) => (ver, count, bytes, true),
                    None => (
                        APP_VERSION.to_string(),
                        inspection.report.verified_intact_count
                            + inspection.report.corrupted_count
                            + inspection.report.missing_count,
                        inspection
                            .report
                            .total_package_bytes
                            .max(DEFAULT_REQUIRED_BYTES),
                        false,
                    ),
                };

            let peak_required_bytes = if payload_available {
                inspection.peak_required_bytes
            } else {
                compute_peak_required_bytes(required_bytes)
            };

            let effective_mode = match mode_initial {
                InstallMode::Uninstall => InstallMode::Uninstall,
                InstallMode::Update => InstallMode::Update,
                InstallMode::Repair => InstallMode::Repair,
                InstallMode::Install => match inspection.report.disposition {
                    InstallDisposition::UpdateAvailable => InstallMode::Update,
                    InstallDisposition::RepairNeeded => InstallMode::Repair,
                    _ => InstallMode::Install,
                },
            };

            let existing_install =
                inspection.report.disposition != InstallDisposition::FreshInstall;
            let ready_telemetry = if effective_mode == InstallMode::Uninstall {
                build_uninstall_ready_telemetry(
                    &inspection.resolved_dir,
                    payload_files.max(1),
                    inspection.report.total_package_bytes.max(1),
                )
            } else {
                build_ready_telemetry(
                    &inspection.resolved_dir,
                    payload_files.max(1),
                    required_bytes,
                )
            };

            let enough_disk = inspection
                .free_disk_bytes
                .map(|free| free >= peak_required_bytes)
                .unwrap_or(true);
            let auto_start = mode_initial == InstallMode::Update
                && payload_available
                && inspection.writable
                && enough_disk;

            Ok(InstallerDefaults {
                version: APP_VERSION.to_string(),
                package_version,
                launch_mode: effective_mode,
                default_install_dir: inspection.resolved_dir,
                writable: inspection.writable,
                write_error: inspection.write_error,
                free_disk_bytes: inspection.free_disk_bytes,
                required_bytes,
                peak_required_bytes,
                payload_files,
                payload_available,
                existing_install,
                existing_report: inspection.report,
                running_processes: inspection.running_processes,
                wait_pid,
                auto_start,
                auto_relaunch,
                remove_user_data_default,
                saved_desktop_shortcut: inspection.saved_desktop_shortcut,
                saved_start_menu_shortcut: inspection.saved_start_menu_shortcut,
                saved_file_associations: inspection.saved_file_associations,
                ready_telemetry,
            })
        })
        .await
        .map_err(|e| format!("Failed inspecting installer defaults: {e}"))?
    }

    #[tauri::command]
    fn check_install_dir(path: String) -> Result<Option<u64>, String> {
        let resolved = resolve_install_dir(&path).map_err(|e| e.to_string())?;
        let dir_path = Path::new(&resolved);
        test_directory_writable(dir_path)?;
        Ok(query_free_disk_bytes(dir_path))
    }

    #[tauri::command]
    async fn preflight_install_dir(
        app: AppHandle,
        path: String,
    ) -> Result<PreflightResult, String> {
        let payload = resolve_payload_path(&app);
        tokio::task::spawn_blocking(move || {
            let resolved = resolve_install_dir(&path).map_err(|e| e.to_string())?;
            let dir_path = Path::new(&resolved);
            let free_disk_bytes = query_free_disk_bytes(dir_path);
            let protected_dir = is_protected_windows_dir(dir_path);
            let (writable, write_error) = match check_directory_acl_writable(dir_path) {
                Ok(()) => (true, None),
                Err(e) => (false, Some(e)),
            };
            let report = preflight_existing_install(payload.as_deref(), &resolved)?;
            let peak_required_bytes =
                compute_peak_required_bytes(planned_write_bytes_for_report(&report));
            Ok(PreflightResult {
                resolved_dir: resolved,
                free_disk_bytes,
                writable,
                write_error,
                protected_dir,
                report,
                peak_required_bytes,
            })
        })
        .await
        .map_err(|e| format!("Destination preflight failed: {e}"))?
    }

    #[tauri::command]
    async fn inspect_install_dir(
        app: AppHandle,
        path: String,
    ) -> Result<DestinationInspection, String> {
        let payload = resolve_payload_path(&app);
        tokio::task::spawn_blocking(move || inspect_dir_internal(payload.as_deref(), &path))
            .await
            .map_err(|e| format!("Destination inspection task failed: {e}"))?
    }

    #[tauri::command]
    async fn verify_existing_install(
        app: AppHandle,
        path: String,
    ) -> Result<DestinationInspection, String> {
        inspect_install_dir(app, path).await
    }

    #[tauri::command]
    async fn close_running_epilod_processes(install_dir: String) -> Result<usize, String> {
        let resolved = resolve_install_dir(&install_dir).map_err(|e| e.to_string())?;
        tokio::task::spawn_blocking(move || close_running_processes_in_dir(Path::new(&resolved)))
            .await
            .map_err(|e| format!("Process cleanup task failed: {e}"))?
    }

    #[tauri::command]
    async fn start_install(
        app: AppHandle,
        state: State<'_, InstallerState>,
        ctx: State<'_, LaunchContext>,
        options: InstallOptions,
    ) -> Result<(), String> {
        let resolved_dir = resolve_install_dir(&options.install_dir).map_err(|e| e.to_string())?;
        let mut clean_options = options;
        clean_options.install_dir = resolved_dir.clone();
        if clean_options.wait_pid.is_none() {
            clean_options.wait_pid = ctx.wait_pid;
        }
        if ctx.mode == InstallMode::Update {
            clean_options.force_close_running = true;
        }

        {
            let mut running = state
                .running
                .lock()
                .map_err(|_| "Installer state lock poisoned.".to_string())?;
            if *running {
                return Err("An operation is already in progress.".to_string());
            }
            *running = true;
        }
        state.cancel_flag.store(false, Ordering::SeqCst);

        let payload = resolve_payload_path(&app);
        let Some(payload_path) = payload else {
            if let Ok(mut r) = state.running.lock() {
                *r = false;
            }
            return Err(
                "Installer payload (epilod-payload.epkg) was not found. Build the release package with scripts/build-installer.ps1."
                    .to_string(),
            );
        };

        let cancel_flag = Arc::clone(&state.cancel_flag);
        let app_handle = app.clone();

        let join_res = tokio::task::spawn_blocking(move || {
            let integrator = WindowsIntegrator;
            run_install_pipeline(
                &payload_path,
                &clean_options,
                &integrator,
                &cancel_flag,
                |t| {
                    let _ = app_handle.emit("installer://progress", &t);
                },
            )
        })
        .await;

        if let Ok(mut running) = state.running.lock() {
            *running = false;
        }

        match join_res {
            Ok(Ok(_manifest)) => Ok(()),
            Ok(Err(err_msg)) => {
                let cancelled = state.cancel_flag.load(Ordering::SeqCst);
                let mut err_telemetry =
                    build_ready_telemetry(&resolved_dir, 0, DEFAULT_REQUIRED_BYTES);
                err_telemetry.phase = if cancelled {
                    InstallPhase::Cancelled
                } else {
                    InstallPhase::Failed
                };
                err_telemetry.headline = if cancelled {
                    "Installation cancelled".to_string()
                } else {
                    "Installation interrupted".to_string()
                };
                err_telemetry.live_status = err_msg.clone();
                err_telemetry.cancelled = cancelled;
                err_telemetry.error = Some(err_msg.clone());
                let _ = app.emit("installer://progress", &err_telemetry);
                Err(err_msg)
            }
            Err(join_err) => Err(format!("Installer background task failed: {join_err}")),
        }
    }

    #[tauri::command]
    async fn start_uninstall(
        app: AppHandle,
        state: State<'_, InstallerState>,
        options: UninstallOptions,
    ) -> Result<UninstallSummary, String> {
        let resolved_dir = resolve_install_dir(&options.install_dir).map_err(|e| e.to_string())?;
        let mut clean_options = options;
        clean_options.install_dir = resolved_dir.clone();

        {
            let mut running = state
                .running
                .lock()
                .map_err(|_| "Installer state lock poisoned.".to_string())?;
            if *running {
                return Err("An operation is already in progress.".to_string());
            }
            *running = true;
        }

        let app_handle = app.clone();
        let join_res = tokio::task::spawn_blocking(move || {
            let integrator = WindowsIntegrator;
            run_uninstall_pipeline(&clean_options, &integrator, |t| {
                let _ = app_handle.emit("installer://progress", &t);
            })
        })
        .await;

        if let Ok(mut running) = state.running.lock() {
            *running = false;
        }

        match join_res {
            Ok(Ok(summary)) => Ok(summary),
            Ok(Err(err_msg)) => {
                let mut err_telemetry = build_uninstall_ready_telemetry(&resolved_dir, 1, 1);
                err_telemetry.phase = InstallPhase::Failed;
                err_telemetry.headline = "Uninstall interrupted".to_string();
                err_telemetry.live_status = err_msg.clone();
                err_telemetry.error = Some(err_msg.clone());
                let _ = app.emit("installer://progress", &err_telemetry);
                Err(err_msg)
            }
            Err(join_err) => Err(format!("Uninstaller background task failed: {join_err}")),
        }
    }

    #[tauri::command]
    fn cancel_install(state: State<'_, InstallerState>) -> Result<(), String> {
        state.cancel_flag.store(true, Ordering::SeqCst);
        Ok(())
    }

    #[tauri::command]
    fn launch_installed_app(app: AppHandle, install_dir: String) -> Result<(), String> {
        let resolved = resolve_install_dir(&install_dir).map_err(|e| e.to_string())?;
        let dir_path = Path::new(&resolved);
        let exe = installed_exe_path(dir_path).ok_or_else(|| {
            format!(
                "Could not locate Epilod Party executable inside {}.",
                dir_path.display()
            )
        })?;

        Command::new(&exe)
            .current_dir(dir_path)
            .spawn()
            .map_err(|e| format!("Failed launching Epilod Party: {e}"))?;

        app.exit(0);
        Ok(())
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        let exe_path = std::env::current_exe().ok();
        let cli = parse_setup_cli_args_with_exe(&args, exe_path.as_deref());

        if cli.silent {
            attach_parent_console();
        }

        let _instance_guard =
            match SingleInstanceGuard::acquire(cli.silent || cli.mode == InstallMode::Update) {
                Ok(guard) => guard,
                Err(msg) => {
                    if cli.silent {
                        eprintln!("{msg}");
                    } else {
                        show_error_dialog("Epilod Party Setup", &msg);
                    }
                    std::process::exit(2);
                }
            };

        if cli.silent {
            if cli.mode == InstallMode::Uninstall {
                let code = run_silent_uninstall_flow(
                    cli.install_dir.as_deref().map(Path::new),
                    cli.remove_user_data,
                );
                std::process::exit(code);
            }
            let Some(payload_path) =
                resolve_payload_path_from_exe_and_resources(exe_path.as_deref(), None)
            else {
                eprintln!("Installer payload not found for silent setup.");
                std::process::exit(1);
            };
            let code = run_silent_install_flow(
                &payload_path,
                cli.mode,
                cli.install_dir.as_deref().map(Path::new),
                cli.wait_pid,
                cli.relaunch,
                cli.allow_downgrade,
            );
            std::process::exit(code);
        }

        if let Err(_wv_err) = tauri::webview_version() {
            show_webview2_missing_dialog();
            std::process::exit(1);
        }

        let initial_install_dir = cli
            .install_dir
            .as_deref()
            .and_then(|d| resolve_install_dir(d).ok())
            .or_else(|| {
                if cli.mode == InstallMode::Uninstall {
                    read_hkcu_install_location()
                } else {
                    None
                }
            })
            .unwrap_or_else(default_install_dir_string);

        let launch_ctx = LaunchContext {
            mode: cli.mode,
            initial_install_dir,
            wait_pid: cli.wait_pid,
            auto_relaunch: cli.relaunch,
            remove_user_data: cli.remove_user_data,
        };

        if let Err(err) = tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(InstallerState::default())
            .manage(launch_ctx)
            .invoke_handler(tauri::generate_handler![
                get_installer_defaults,
                check_install_dir,
                preflight_install_dir,
                inspect_install_dir,
                verify_existing_install,
                close_running_epilod_processes,
                start_install,
                start_uninstall,
                cancel_install,
                launch_installed_app,
            ])
            .run(tauri::generate_context!())
        {
            show_error_dialog(
                "Epilod Party Setup Error",
                &format!("Failed launching installer UI: {err}"),
            );
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
pub use windows_app::run;

#[cfg(not(windows))]
pub fn run() {
    eprintln!("Epilod Party Setup targets Windows 10/11.");
}

#[cfg(test)]
mod tests {
    use super::*;
    use epilod_installer_core::archive::{attach_payload_sfx, pack_directory_with_version};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn resolve_payload_prefers_embedded_sfx_over_sibling_epkg() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("epilod_setup_lib_test_{nanos}"));
        let src_sfx = root.join("src_sfx");
        let src_stale = root.join("src_stale");
        let out_dir = root.join("out");
        fs::create_dir_all(&src_sfx).unwrap();
        fs::create_dir_all(&src_stale).unwrap();
        fs::create_dir_all(&out_dir).unwrap();

        fs::write(src_sfx.join("Epilod Party.exe"), b"embedded-binary").unwrap();
        fs::write(src_stale.join("Epilod Party.exe"), b"stale-binary").unwrap();

        let sfx_pkg = root.join("sfx.epkg");
        let sibling_pkg = out_dir.join("epilod-payload.epkg");
        pack_directory_with_version(&src_sfx, &sfx_pkg, "0.2.0").unwrap();
        pack_directory_with_version(&src_stale, &sibling_pkg, "0.0.1").unwrap();

        let stub = root.join("stub.exe");
        fs::write(
            &stub,
            vec![0x4Du8, 0x5A, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44],
        )
        .unwrap();
        let fake_exe = out_dir.join("Epilod Party Setup.exe");
        attach_payload_sfx(&stub, &sfx_pkg, &fake_exe).unwrap();

        let resolved = resolve_payload_path_from_exe_and_resources(Some(&fake_exe), Some(&out_dir));
        assert_eq!(resolved.as_deref(), Some(fake_exe.as_path()));

        let (manifest, _) = read_manifest(resolved.as_ref().unwrap()).unwrap();
        assert_eq!(manifest.version, "0.2.0");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn built_release_sfx_installer_fresh_install_and_in_place_update_end_to_end() {
        use epilod_installer_core::archive::{
            copy_uninstaller_executable, hash_file, read_manifest,
        };
        use epilod_installer_core::engine::{
            run_install_pipeline, IntegrationResult, SystemIntegrator,
        };
        use epilod_installer_core::plan::{ComponentId, InstallOptions};
        use epilod_installer_core::receipt::{
            read_receipt, write_receipt_atomic, InstallReceipt, ManagedFileRecord,
            INSTALL_RECEIPT_FILENAME, UNINSTALLER_FILENAME,
        };
        use std::sync::atomic::AtomicBool;

        struct TestSandboxIntegrator {
            setup_exe: PathBuf,
        }

        impl SystemIntegrator for TestSandboxIntegrator {
            fn check_destination(&self, dir: &Path) -> Result<Option<u64>, String> {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                Ok(Some(50 * 1024 * 1024 * 1024))
            }

            fn install_uninstaller(
                &self,
                install_dir: &Path,
                _backup_dir: &Path,
            ) -> Result<bool, String> {
                copy_uninstaller_executable(
                    &self.setup_exe,
                    &install_dir.join(UNINSTALLER_FILENAME),
                )
                .map_err(|e| e.to_string())?;
                Ok(true)
            }

            fn apply_shortcuts_and_registry(
                &self,
                _install_dir: &Path,
                _options: &InstallOptions,
                _target_version: &str,
                _previous_receipt: Option<&InstallReceipt>,
                _report: &mut dyn FnMut(&str, usize, usize),
            ) -> Result<IntegrationResult, String> {
                Ok(IntegrationResult {
                    created_shortcuts: vec!["Desktop\\Epilod Party.lnk".into()],
                    created_registry_keys: vec![
                        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EpilodParty"
                            .into(),
                    ],
                    user_data_dir: None,
                })
            }
        }

        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root");
        let setup_exe = repo_root.join("target/release/Epilod Party Setup.exe");
        let release_app_exe = repo_root.join("target/release/epilod-party.exe");
        let update_manifest_path = repo_root.join("target/release/epilod-update-manifest.json");
        if !setup_exe.is_file() || !release_app_exe.is_file() {
            return;
        }

        let (manifest, _) = read_manifest(&setup_exe).expect("read sfx manifest");
        let required_paths = [
            "Epilod Party.exe",
            "resources/mpv/mpv.exe",
            "resources/mpv/ffmpeg.exe",
            "resources/fonts/Inter-Regular.ttf",
            "resources/fonts/NotoSansArabic-Regular.ttf",
            "resources/licenses/GPL-3.0.txt",
            "resources/licenses/SOURCE_OFFER.txt",
        ];
        for rel in required_paths {
            assert!(
                manifest
                    .entries
                    .iter()
                    .any(|e| e.relative_path.replace('\\', "/") == rel),
                "SFX installer missing required payload entry: {rel}"
            );
        }

        let (app_size, app_sha) = hash_file(&release_app_exe).expect("hash release app exe");
        let packed_app = manifest
            .entries
            .iter()
            .find(|e| e.relative_path.replace('\\', "/") == "Epilod Party.exe")
            .expect("Epilod Party.exe entry");
        assert_eq!(
            (packed_app.size, packed_app.sha256.to_ascii_lowercase()),
            (app_size, app_sha.to_ascii_lowercase()),
            "SFX installer Epilod Party.exe does not match target/release/epilod-party.exe"
        );

        assert!(
            update_manifest_path.is_file(),
            "missing release update manifest at {}",
            update_manifest_path.display()
        );
        let (setup_size, setup_sha) = hash_file(&setup_exe).expect("hash setup exe");
        let um_bytes = fs::read(&update_manifest_path).expect("read update manifest");
        let um_json: serde_json::Value =
            serde_json::from_slice(&um_bytes).expect("parse update manifest");
        assert_eq!(um_json["sizeBytes"].as_u64(), Some(setup_size));
        assert_eq!(
            um_json["sha256"]
                .as_str()
                .map(|s| s.to_ascii_lowercase())
                .as_deref(),
            Some(setup_sha.to_ascii_lowercase().as_str())
        );

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let install_dir =
            std::env::temp_dir().join(format!("epilod_release_e2e_{}_{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&install_dir);

        let integrator = TestSandboxIntegrator {
            setup_exe: setup_exe.clone(),
        };
        let cancel = AtomicBool::new(false);
        let opts = InstallOptions {
            install_dir: install_dir.to_string_lossy().into_owned(),
            create_desktop_shortcut: true,
            create_start_menu_shortcut: true,
            register_file_associations: true,
            auto_launch: false,
            force_reunpack: false,
            wait_pid: None,
            force_close_running: false,
            allow_downgrade: false,
        };

        // 1) Fresh install verification
        run_install_pipeline(&setup_exe, &opts, &integrator, &cancel, |_| {})
            .expect("fresh install failed");
        for rel in required_paths {
            assert!(
                install_dir.join(rel).is_file(),
                "fresh install missing {rel}"
            );
        }
        assert!(install_dir.join(UNINSTALLER_FILENAME).is_file());
        assert!(install_dir.join(INSTALL_RECEIPT_FILENAME).is_file());
        let (installed_app_size, installed_app_sha) =
            hash_file(&install_dir.join("Epilod Party.exe")).expect("hash installed app");
        assert_eq!(installed_app_size, app_size);
        assert_eq!(
            installed_app_sha.to_ascii_lowercase(),
            app_sha.to_ascii_lowercase()
        );

        // 2) In-place update verification
        fs::write(install_dir.join("Epilod Party.exe"), b"old-version-binary")
            .expect("simulate older app exe");
        let obsolete_rel = "resources/mpv/obsolete-old.dll";
        let obsolete_path = install_dir.join(obsolete_rel);
        fs::write(&obsolete_path, b"old-dll").expect("write obsolete managed file");
        let user_sub_path = install_dir.join("my-custom-subtitles.srt");
        fs::write(&user_sub_path, "custom user subtitle").expect("write user file");

        let mut prev_receipt = read_receipt(&install_dir).expect("read fresh receipt");
        prev_receipt.version = "0.0.9".to_string();
        prev_receipt.managed_files.push(ManagedFileRecord {
            relative_path: obsolete_rel.to_string(),
            component: ComponentId::Mpv,
            size: 7,
            sha256: "0".repeat(64),
        });
        write_receipt_atomic(&install_dir, &prev_receipt).expect("write simulated old receipt");

        run_install_pipeline(&setup_exe, &opts, &integrator, &cancel, |_| {})
            .expect("in-place update failed");

        let (updated_app_size, updated_app_sha) =
            hash_file(&install_dir.join("Epilod Party.exe")).expect("hash updated app");
        assert_eq!(updated_app_size, app_size);
        assert_eq!(
            updated_app_sha.to_ascii_lowercase(),
            app_sha.to_ascii_lowercase()
        );

        let mpv_entry = manifest
            .entries
            .iter()
            .find(|e| e.relative_path.replace('\\', "/") == "resources/mpv/mpv.exe")
            .expect("mpv entry");
        let ffmpeg_entry = manifest
            .entries
            .iter()
            .find(|e| e.relative_path.replace('\\', "/") == "resources/mpv/ffmpeg.exe")
            .expect("ffmpeg entry");
        assert_eq!(
            hash_file(&install_dir.join("resources/mpv/mpv.exe")).expect("hash mpv.exe"),
            (mpv_entry.size, mpv_entry.sha256.to_ascii_lowercase())
        );
        assert_eq!(
            hash_file(&install_dir.join("resources/mpv/ffmpeg.exe")).expect("hash ffmpeg.exe"),
            (ffmpeg_entry.size, ffmpeg_entry.sha256.to_ascii_lowercase())
        );

        assert!(
            !obsolete_path.exists(),
            "obsolete managed file should be pruned on update"
        );
        assert_eq!(
            fs::read_to_string(&user_sub_path).expect("read preserved user file"),
            "custom user subtitle"
        );
        assert_eq!(
            read_receipt(&install_dir)
                .expect("read updated receipt")
                .version,
            manifest.version
        );

        let _ = fs::remove_dir_all(&install_dir);
    }
}
