use crate::archive::{
    extract_entries_verified_streaming, hash_file, read_manifest, sanitize_relative_path,
    ArchiveError, ExtractAction, PackageManifest,
};
use crate::plan::{
    compute_weighted_percent, format_bytes_pair, resolve_install_dir, ComponentId, InstallOptions,
    InstallPhase, InstallTelemetry, StepId, StepProgress, StepState, TileId, UninstallOptions,
    UninstallSummary,
};
use crate::receipt::{
    build_receipt, collect_managed_delete_targets, read_receipt, write_receipt_atomic,
    InstallReceipt, BACKUP_DIR_NAME, INSTALL_RECEIPT_FILENAME, STAGING_DIR_NAME,
    TX_JOURNAL_FILENAME, TX_MARKER_FILENAME, UNINSTALLER_FILENAME, UNINSTALL_TRASH_DIR_NAME,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct IntegrationSnapshot(pub Vec<u8>);

#[derive(Debug, Clone, Default)]
pub struct IntegrationResult {
    pub created_shortcuts: Vec<String>,
    pub created_registry_keys: Vec<String>,
    pub user_data_dir: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CleanupReport {
    pub removed_shortcuts: usize,
    pub removed_registry: bool,
    pub removed_user_data: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJournal {
    pub newly_placed_rel_paths: Vec<String>,
    pub integration_snapshot: Option<Vec<u8>>,
}

pub trait SystemIntegrator {
    fn check_destination(&self, dir: &Path) -> Result<Option<u64>, String>;

    fn estimate_uninstaller_bytes(&self) -> u64 {
        16 * 1024 * 1024
    }

    fn prepare_for_file_changes(
        &self,
        _install_dir: &Path,
        _wait_pid: Option<u32>,
        _force_close_app: bool,
    ) -> Result<usize, String> {
        Ok(0)
    }

    fn install_uninstaller(&self, _install_dir: &Path, _backup_dir: &Path) -> Result<bool, String> {
        Ok(false)
    }

    fn capture_integration_snapshot(
        &self,
        _install_dir: &Path,
        _previous_receipt: Option<&InstallReceipt>,
    ) -> IntegrationSnapshot {
        IntegrationSnapshot::default()
    }

    fn revert_integration(
        &self,
        _install_dir: &Path,
        _snapshot: &IntegrationSnapshot,
        _previous_receipt: Option<&InstallReceipt>,
    ) -> Result<(), String> {
        Ok(())
    }

    fn apply_shortcuts_and_registry(
        &self,
        install_dir: &Path,
        options: &InstallOptions,
        target_version: &str,
        previous_receipt: Option<&InstallReceipt>,
        report: &mut dyn FnMut(&str, usize, usize),
    ) -> Result<IntegrationResult, String>;

    fn remove_shortcuts_and_registry(
        &self,
        _install_dir: &Path,
        _receipt: Option<&InstallReceipt>,
        _remove_user_data: bool,
        _report: &mut dyn FnMut(&str, usize, usize),
    ) -> Result<CleanupReport, String> {
        Ok(CleanupReport::default())
    }

    fn schedule_self_cleanup(
        &self,
        _install_dir: &Path,
        _uninstall_exe_rel: &str,
        _receipt_rel: &str,
    ) -> Result<bool, String> {
        Ok(false)
    }
}

pub fn run_install_pipeline<F>(
    archive_path: &Path,
    options: &InstallOptions,
    integrator: &dyn SystemIntegrator,
    cancel_flag: &AtomicBool,
    mut emit: F,
) -> Result<PackageManifest, String>
where
    F: FnMut(InstallTelemetry),
{
    let resolved_dir = resolve_install_dir(&options.install_dir).map_err(|e| e.to_string())?;
    let target_dir = PathBuf::from(&resolved_dir);
    let mut clean_options = options.clone();
    clean_options.install_dir = resolved_dir.clone();

    let (manifest, _) = read_manifest(archive_path).map_err(|e| e.to_string())?;
    let files_total = manifest.entries.len();
    let bytes_total = manifest.total_bytes;

    // 0. Recover any interrupted previous staging / transaction backup cleanly before preflight.
    let staging_dir = target_dir.join(STAGING_DIR_NAME);
    let backup_dir = target_dir.join(BACKUP_DIR_NAME);
    recover_interrupted_transaction(&target_dir, &backup_dir, &staging_dir, integrator)?;

    // 1. Preflight & destination lock check
    emit(InstallTelemetry {
        phase: InstallPhase::Preflight,
        overall_percent: compute_weighted_percent(InstallPhase::Preflight, 0, bytes_total, 0, 1),
        headline: "Preparing workspace".to_string(),
        live_status: "Checking folder write access & running processes".to_string(),
        active_tile: None,
        completed_tiles: Vec::new(),
        steps: make_steps(
            StepState::Active,
            "Verifying destination & manifest",
            "Checking",
            StepState::Pending,
            "Inter + Noto Arabic Auto-Sync",
            "Queued",
            StepState::Pending,
            "STARTTLS & desktop integration",
            "Queued",
        ),
        bytes_done: 0,
        bytes_total,
        files_done: 0,
        files_total,
        current_file: None,
        install_dir: resolved_dir.clone(),
        finished: false,
        cancelled: false,
        error: None,
    });

    let free_disk_bytes = integrator.check_destination(&target_dir)?;
    if let Some(free_bytes) = free_disk_bytes {
        let coarse_min = 32 * 1024 * 1024;
        if free_bytes < coarse_min {
            return Err(format!(
                "Not enough free disk space in {}. Need at least {} free ({} available).",
                resolved_dir,
                format_bytes_pair(coarse_min, coarse_min),
                format_bytes_pair(free_bytes, free_bytes),
            ));
        }
    }

    integrator.prepare_for_file_changes(
        &target_dir,
        clean_options.wait_pid,
        clean_options.force_close_running,
    )?;

    if cancel_flag.load(Ordering::SeqCst) {
        return Err("Installation cancelled cleanly — no files modified.".to_string());
    }

    // 2. Pre-Install Existing File Verification (SHA-256 compare against target manifest)
    let previous_receipt = read_receipt(&target_dir);
    if let Some(ref prev) = previous_receipt {
        if crate::semver::compare_versions(&manifest.version, &prev.version)
            == Some(std::cmp::Ordering::Less)
            && !clean_options.allow_downgrade
        {
            return Err(format!(
                "Installed version v{} is newer than package v{}. Pass allow_downgrade to replace it.",
                prev.version, manifest.version
            ));
        }
    }
    let mut reused_paths = BTreeSet::new();
    let mut files_to_write = Vec::new();
    let mut verified_existing_bytes = 0u64;
    let mut bytes_to_write = 0u64;

    for (idx, entry) in manifest.entries.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Installation cancelled cleanly — no files modified.".to_string());
        }
        let norm_rel = entry.relative_path.replace('\\', "/");
        let existing_file = target_dir.join(&norm_rel);
        let friendly = friendly_file_label(&norm_rel);

        if existing_file.is_file() {
            emit(InstallTelemetry {
                phase: InstallPhase::VerifyingExisting,
                overall_percent: compute_weighted_percent(
                    InstallPhase::VerifyingExisting,
                    verified_existing_bytes,
                    bytes_total.max(1),
                    idx,
                    files_total,
                ),
                headline: "Checking existing installation".to_string(),
                live_status: format!("Verifying existing {friendly}"),
                active_tile: None,
                completed_tiles: Vec::new(),
                steps: make_steps(
                    StepState::Active,
                    &format!("Verifying {friendly}"),
                    &format!("{}/{files_total}", idx + 1),
                    StepState::Pending,
                    "Inter + Noto Arabic Auto-Sync",
                    "Queued",
                    StepState::Pending,
                    "STARTTLS & desktop integration",
                    "Queued",
                ),
                bytes_done: 0,
                bytes_total,
                files_done: 0,
                files_total,
                current_file: Some(norm_rel.clone()),
                install_dir: resolved_dir.clone(),
                finished: false,
                cancelled: false,
                error: None,
            });

            if !clean_options.force_reunpack {
                if let Ok((sz, hex)) = hash_file(&existing_file) {
                    if sz == entry.size && hex == entry.sha256.to_ascii_lowercase() {
                        reused_paths.insert(norm_rel.clone());
                        verified_existing_bytes =
                            verified_existing_bytes.saturating_add(entry.size);
                        continue;
                    }
                }
            }
        }
        verified_existing_bytes = verified_existing_bytes.saturating_add(entry.size);
        bytes_to_write = bytes_to_write.saturating_add(entry.size);
        files_to_write.push(norm_rel);
    }

    if let Some(free_bytes) = free_disk_bytes {
        let peak_needed = bytes_to_write
            .saturating_add(integrator.estimate_uninstaller_bytes())
            .saturating_add(24 * 1024 * 1024);
        if free_bytes < peak_needed {
            return Err(format!(
                "Not enough free disk space in {}. Need {} free for staging and uninstaller ({} available).",
                resolved_dir,
                format_bytes_pair(peak_needed, peak_needed),
                format_bytes_pair(free_bytes, free_bytes),
            ));
        }
    }

    // 3. Verified streaming extraction into .epilod-staging
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }

    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_action: Option<(ExtractAction, String)> = None;

    let extract_res = extract_entries_verified_streaming(
        archive_path,
        &staging_dir,
        &reused_paths,
        cancel_flag,
        |p| {
            let now = Instant::now();
            let action_changed = last_action
                .as_ref()
                .map(|(act, rel)| *act != p.action || rel != &p.relative_path)
                .unwrap_or(true);
            let is_file_done = p.file_bytes_done == p.file_bytes_total;
            if !action_changed
                && !is_file_done
                && now.duration_since(last_emit) < Duration::from_millis(45)
            {
                return;
            }
            last_emit = now;
            last_action = Some((p.action, p.relative_path.clone()));

            let friendly_name = friendly_file_label(&p.relative_path);

            let (phase, active_tile, completed_tiles, step1_state, step2_state) = match p.component
            {
                ComponentId::Core => (
                    InstallPhase::UnpackingCore,
                    Some(TileId::Mpv),
                    vec![],
                    StepState::Active,
                    StepState::Pending,
                ),
                ComponentId::Mpv => (
                    InstallPhase::UnpackingMpv,
                    Some(TileId::Mpv),
                    vec![],
                    StepState::Active,
                    StepState::Pending,
                ),
                ComponentId::Fonts => (
                    InstallPhase::UnpackingFonts,
                    Some(TileId::AutoSync),
                    vec![TileId::Mpv],
                    StepState::Done,
                    StepState::Active,
                ),
                ComponentId::Syncplay => (
                    InstallPhase::UnpackingFonts,
                    Some(TileId::Syncplay),
                    vec![TileId::Mpv, TileId::AutoSync],
                    StepState::Done,
                    StepState::Done,
                ),
            };

            let live_status = match p.action {
                ExtractAction::Unpacking => format!(
                    "Unpacking {} · {}",
                    friendly_name,
                    format_bytes_pair(p.file_bytes_done, p.file_bytes_total)
                ),
                ExtractAction::VerifyingDigest => {
                    format!("Verified SHA-256 for {friendly_name}")
                }
                ExtractAction::ReusedVerified => {
                    format!("Verified intact {friendly_name} (unchanged)")
                }
            };

            let step1_detail = if step1_state == StepState::Done {
                "Embedded Win32 HWND player".to_string()
            } else if p.action == ExtractAction::ReusedVerified {
                format!("Verified intact {friendly_name}")
            } else {
                format!("Unpacking {friendly_name}")
            };
            let step1_right = if step1_state == StepState::Done {
                "Verified".to_string()
            } else {
                format!("{}/{}", p.files_done.max(1), p.files_total)
            };

            let step2_detail = match step2_state {
                StepState::Pending => "Inter + Noto Arabic Auto-Sync".to_string(),
                StepState::Active => {
                    if p.action == ExtractAction::ReusedVerified {
                        format!("Verified {friendly_name}")
                    } else {
                        format!("Installing {friendly_name}")
                    }
                }
                StepState::Done => "Inter + Noto Arabic Auto-Sync".to_string(),
                StepState::Error => "Font unpack failed".to_string(),
            };
            let step2_right = match step2_state {
                StepState::Pending => "Queued".to_string(),
                StepState::Active => format_bytes_pair(p.file_bytes_done, p.file_bytes_total),
                StepState::Done => "Done".to_string(),
                StepState::Error => "Error".to_string(),
            };

            emit(InstallTelemetry {
                phase,
                overall_percent: compute_weighted_percent(
                    phase,
                    p.total_bytes_done,
                    p.total_bytes,
                    0,
                    1,
                ),
                headline: "Installing Epilod Party".to_string(),
                live_status,
                active_tile,
                completed_tiles,
                steps: make_steps(
                    step1_state,
                    &step1_detail,
                    &step1_right,
                    step2_state,
                    &step2_detail,
                    &step2_right,
                    StepState::Pending,
                    "STARTTLS & desktop integration",
                    "Queued",
                ),
                bytes_done: p.total_bytes_done,
                bytes_total: p.total_bytes,
                files_done: p.files_done,
                files_total: p.files_total,
                current_file: Some(p.relative_path.clone()),
                install_dir: resolved_dir.clone(),
                finished: false,
                cancelled: false,
                error: None,
            });
        },
    );

    if let Err(err) = extract_res {
        let _ = fs::remove_dir_all(&staging_dir);
        let cancelled = matches!(err, ArchiveError::Cancelled);
        return Err(if cancelled {
            "Installation cancelled cleanly — no files modified.".to_string()
        } else {
            err.to_string()
        });
    }

    if cancel_flag.load(Ordering::SeqCst) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err("Installation cancelled cleanly — no files modified.".to_string());
    }

    // 4. Two-Phase Transactional Swap (with .epilod-backup & automatic rollback on any failure)
    emit(InstallTelemetry {
        phase: InstallPhase::BackingUp,
        overall_percent: compute_weighted_percent(
            InstallPhase::BackingUp,
            bytes_total,
            bytes_total,
            0,
            1,
        ),
        headline: "Committing verified files".to_string(),
        live_status: "Preparing atomic swap & backup guard".to_string(),
        active_tile: Some(TileId::Syncplay),
        completed_tiles: vec![TileId::Mpv, TileId::AutoSync],
        steps: make_steps(
            StepState::Done,
            "Embedded Win32 HWND player",
            "Verified",
            StepState::Done,
            "Inter + Noto Arabic Auto-Sync",
            "Done",
            StepState::Active,
            "Atomic file commit & backup",
            "Swapping",
        ),
        bytes_done: bytes_total,
        bytes_total,
        files_done: files_total,
        files_total,
        current_file: None,
        install_dir: resolved_dir.clone(),
        finished: false,
        cancelled: false,
        error: None,
    });

    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed creating transaction backup folder: {e}"))?;

    let incoming_lower: BTreeSet<String> = manifest
        .entries
        .iter()
        .map(|e| e.relative_path.replace('\\', "/").to_ascii_lowercase())
        .collect();

    let mut tx_log = TransactionLog {
        target_dir: target_dir.clone(),
        backup_dir: backup_dir.clone(),
        backed_up: Vec::new(),
        newly_placed: Vec::new(),
    };
    let mut tx_journal = TransactionJournal::default();

    // Backup previous receipt if present
    let receipt_path = target_dir.join(INSTALL_RECEIPT_FILENAME);
    if receipt_path.is_file() {
        if let Err(e) = tx_log.backup_file(&receipt_path, INSTALL_RECEIPT_FILENAME) {
            let rb_suffix = format_rollback_suffix(tx_log.rollback().err().as_deref());
            let _ = remove_dir_all_resilient(&staging_dir);
            return Err(format!("{e}{rb_suffix}"));
        }
    }

    // Remove obsolete files from previous receipt safely into backup
    if let Some(ref prev) = previous_receipt {
        for old in &prev.managed_files {
            let norm_old = old.relative_path.replace('\\', "/");
            if !incoming_lower.contains(&norm_old.to_ascii_lowercase()) {
                let old_path = target_dir.join(&norm_old);
                if old_path.is_file() {
                    if let Err(e) = tx_log.backup_and_remove(&old_path, &norm_old) {
                        let rb_suffix = format_rollback_suffix(tx_log.rollback().err().as_deref());
                        let _ = remove_dir_all_resilient(&staging_dir);
                        return Err(format!(
                            "Failed retiring obsolete file {norm_old}: {e}{rb_suffix}"
                        ));
                    }
                }
            }
        }
    }

    // Commit staged files atomically
    for rel in &files_to_write {
        let clean_rel = sanitize_relative_path(rel).map_err(|e| e.to_string())?;
        let src = staging_dir.join(&clean_rel);
        let dst = target_dir.join(&clean_rel);

        let existed_before = dst.is_file();
        if existed_before {
            if let Err(e) = tx_log.backup_and_remove(&dst, rel) {
                emit_rollback_status(
                    &mut emit,
                    &resolved_dir,
                    &manifest,
                    bytes_total,
                    files_total,
                );
                let rb_suffix = format_rollback_suffix(tx_log.rollback().err().as_deref());
                let _ = remove_dir_all_resilient(&staging_dir);
                return Err(format!(
                    "Rolled back cleanly — could not replace {rel} ({e}). Close Epilod Party and retry.{rb_suffix}"
                ));
            }
        }

        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                emit_rollback_status(
                    &mut emit,
                    &resolved_dir,
                    &manifest,
                    bytes_total,
                    files_total,
                );
                let rb_suffix = format_rollback_suffix(tx_log.rollback().err().as_deref());
                let _ = remove_dir_all_resilient(&staging_dir);
                return Err(format!(
                    "Rolled back cleanly — failed creating {}: {e}{rb_suffix}",
                    parent.display()
                ));
            }
        }

        if !existed_before {
            tx_journal.newly_placed_rel_paths.push(rel.clone());
            let _ = write_tx_journal(&backup_dir, &tx_journal);
        }

        clear_readonly(&dst);
        if rename_with_retry(&src, &dst).is_err() {
            if let Err(e) = copy_with_retry(&src, &dst) {
                emit_rollback_status(
                    &mut emit,
                    &resolved_dir,
                    &manifest,
                    bytes_total,
                    files_total,
                );
                let rb_suffix = format_rollback_suffix(tx_log.rollback().err().as_deref());
                let _ = remove_dir_all_resilient(&staging_dir);
                return Err(format!(
                    "Rolled back cleanly — failed writing {}: {e}{rb_suffix}",
                    dst.display()
                ));
            }
        }
        tx_log.newly_placed.push(dst);
    }

    let _ = remove_dir_all_resilient(&staging_dir);

    // Move old uninstaller (if present) into backup & install new uninstaller
    let uninst_dst = target_dir.join(UNINSTALLER_FILENAME);
    let had_prev_uninstaller = uninst_dst.is_file();
    if had_prev_uninstaller {
        if let Err(e) = tx_log.backup_and_remove(&uninst_dst, UNINSTALLER_FILENAME) {
            emit_rollback_status(
                &mut emit,
                &resolved_dir,
                &manifest,
                bytes_total,
                files_total,
            );
            let rb_suffix = format_rollback_suffix(tx_log.rollback().err().as_deref());
            return Err(format!(
                "Rolled back cleanly — could not back up previous uninstaller: {e}{rb_suffix}"
            ));
        }
    } else {
        tx_journal
            .newly_placed_rel_paths
            .push(UNINSTALLER_FILENAME.to_string());
        let _ = write_tx_journal(&backup_dir, &tx_journal);
    }

    match integrator.install_uninstaller(&target_dir, &backup_dir) {
        Ok(installed_now) => {
            if installed_now && !had_prev_uninstaller && uninst_dst.is_file() {
                tx_log.newly_placed.push(uninst_dst);
            }
        }
        Err(e) => {
            emit_rollback_status(
                &mut emit,
                &resolved_dir,
                &manifest,
                bytes_total,
                files_total,
            );
            let rb_suffix = format_rollback_suffix(tx_log.rollback().err().as_deref());
            return Err(format!(
                "Rolled back cleanly — uninstaller installation failed: {e}{rb_suffix}"
            ));
        }
    }

    // 5. Configuring Syncplay & Windows Integration
    emit(InstallTelemetry {
        phase: InstallPhase::ConfiguringSyncplay,
        overall_percent: compute_weighted_percent(
            InstallPhase::ConfiguringSyncplay,
            bytes_total,
            bytes_total,
            0,
            3,
        ),
        headline: "Configuring Syncplay TLS".to_string(),
        live_status: "Writing STARTTLS trust profile".to_string(),
        active_tile: Some(TileId::Syncplay),
        completed_tiles: vec![TileId::Mpv, TileId::AutoSync],
        steps: make_steps(
            StepState::Done,
            "Embedded Win32 HWND player",
            "Verified",
            StepState::Done,
            "Inter + Noto Arabic Auto-Sync",
            "Done",
            StepState::Active,
            "Applying STARTTLS defaults",
            "Active",
        ),
        bytes_done: bytes_total,
        bytes_total,
        files_done: files_total,
        files_total,
        current_file: None,
        install_dir: resolved_dir.clone(),
        finished: false,
        cancelled: false,
        error: None,
    });

    let integration_snapshot =
        integrator.capture_integration_snapshot(&target_dir, previous_receipt.as_ref());
    tx_journal.integration_snapshot = Some(integration_snapshot.0.clone());
    let _ = write_tx_journal(&backup_dir, &tx_journal);

    let integration_res = integrator.apply_shortcuts_and_registry(
        &target_dir,
        &clean_options,
        &manifest.version,
        previous_receipt.as_ref(),
        &mut |status_msg, idx, total| {
            let pct = compute_weighted_percent(
                InstallPhase::IntegratingWindows,
                bytes_total,
                bytes_total,
                idx,
                total.max(1),
            );
            let active_tile = if idx + 1 >= total {
                Some(TileId::StartTls)
            } else {
                Some(TileId::Syncplay)
            };
            let mut completed = vec![TileId::Mpv, TileId::AutoSync];
            if idx + 1 >= total {
                completed.push(TileId::Syncplay);
            }
            emit(InstallTelemetry {
                phase: InstallPhase::IntegratingWindows,
                overall_percent: pct,
                headline: "Finalizing desktop integration".to_string(),
                live_status: status_msg.to_string(),
                active_tile,
                completed_tiles: completed,
                steps: make_steps(
                    StepState::Done,
                    "Embedded Win32 HWND player",
                    "Verified",
                    StepState::Done,
                    "Inter + Noto Arabic Auto-Sync",
                    "Done",
                    StepState::Active,
                    status_msg,
                    "Syncing",
                ),
                bytes_done: bytes_total,
                bytes_total,
                files_done: files_total,
                files_total,
                current_file: None,
                install_dir: resolved_dir.clone(),
                finished: false,
                cancelled: false,
                error: None,
            });
        },
    );

    let integration = match integration_res {
        Ok(res) => res,
        Err(e) => {
            emit_rollback_status(
                &mut emit,
                &resolved_dir,
                &manifest,
                bytes_total,
                files_total,
            );
            let int_rb_err = integrator
                .revert_integration(
                    &target_dir,
                    &integration_snapshot,
                    previous_receipt.as_ref(),
                )
                .err();
            let fs_rb_err = tx_log.rollback().err();
            let rb_suffix =
                format_combined_rollback_suffix(fs_rb_err.as_deref(), int_rb_err.as_deref());
            return Err(format!(
                "Rolled back cleanly — Windows integration failed: {e}{rb_suffix}"
            ));
        }
    };

    // 6. Write authoritative install receipt and purge transaction backup
    emit(InstallTelemetry {
        phase: InstallPhase::Finalizing,
        overall_percent: compute_weighted_percent(
            InstallPhase::Finalizing,
            bytes_total,
            bytes_total,
            1,
            1,
        ),
        headline: "Finalizing setup".to_string(),
        live_status: "Recording SHA-256 install manifest & cleaning temp backups".to_string(),
        active_tile: Some(TileId::StartTls),
        completed_tiles: vec![TileId::Mpv, TileId::AutoSync, TileId::Syncplay],
        steps: make_steps(
            StepState::Done,
            "Embedded Win32 HWND player",
            "Verified",
            StepState::Done,
            "Inter + Noto Arabic Auto-Sync",
            "Done",
            StepState::Active,
            "Verifying receipt & cleanup",
            "98%",
        ),
        bytes_done: bytes_total,
        bytes_total,
        files_done: files_total,
        files_total,
        current_file: None,
        install_dir: resolved_dir.clone(),
        finished: false,
        cancelled: false,
        error: None,
    });

    let receipt = build_receipt(
        &manifest,
        &target_dir,
        integration.created_shortcuts,
        integration.created_registry_keys,
        clean_options.register_file_associations,
        clean_options.create_desktop_shortcut,
        clean_options.create_start_menu_shortcut,
        integration.user_data_dir,
    );

    if let Err(e) = write_receipt_atomic(&target_dir, &receipt) {
        emit_rollback_status(
            &mut emit,
            &resolved_dir,
            &manifest,
            bytes_total,
            files_total,
        );
        let int_rb_err = integrator
            .revert_integration(
                &target_dir,
                &integration_snapshot,
                previous_receipt.as_ref(),
            )
            .err();
        let fs_rb_err = tx_log.rollback().err();
        let rb_suffix =
            format_combined_rollback_suffix(fs_rb_err.as_deref(), int_rb_err.as_deref());
        return Err(format!("Rolled back cleanly — {e}{rb_suffix}"));
    }

    // Mark committed & remove backup directory + any empty obsolete folders
    let _ = fs::write(backup_dir.join(TX_MARKER_FILENAME), b"committed");
    let _ = remove_dir_all_resilient(&backup_dir);
    prune_empty_dirs_bottom_up(&target_dir, false);

    // 7. Complete
    emit(InstallTelemetry {
        phase: InstallPhase::Complete,
        overall_percent: 100.0,
        headline: "Epilod Party is ready".to_string(),
        live_status: format!(
            "Installed {} verified files ({}) cleanly",
            files_total,
            format_bytes_pair(bytes_total, bytes_total)
        ),
        active_tile: None,
        completed_tiles: vec![
            TileId::Mpv,
            TileId::AutoSync,
            TileId::Syncplay,
            TileId::StartTls,
        ],
        steps: make_steps(
            StepState::Done,
            "Embedded Win32 HWND player",
            "Verified",
            StepState::Done,
            "Inter + Noto Arabic Auto-Sync",
            "Done",
            StepState::Done,
            "STARTTLS & shortcuts registered",
            "Ready",
        ),
        bytes_done: bytes_total,
        bytes_total,
        files_done: files_total,
        files_total,
        current_file: None,
        install_dir: resolved_dir,
        finished: true,
        cancelled: false,
        error: None,
    });

    Ok(manifest)
}

pub fn run_uninstall_pipeline<F>(
    options: &UninstallOptions,
    integrator: &dyn SystemIntegrator,
    mut emit: F,
) -> Result<UninstallSummary, String>
where
    F: FnMut(InstallTelemetry),
{
    let resolved_dir = resolve_install_dir(&options.install_dir).map_err(|e| e.to_string())?;
    let target_dir = PathBuf::from(&resolved_dir);
    let receipt = if target_dir.is_dir() {
        read_receipt(&target_dir)
    } else {
        None
    };

    let targets = collect_managed_delete_targets(&target_dir, receipt.as_ref());
    let files_total = targets.len().max(1);

    emit(InstallTelemetry {
        phase: InstallPhase::Preflight,
        overall_percent: 4.0,
        headline: "Uninstalling Epilod Party".to_string(),
        live_status: "Checking running processes & installed manifest".to_string(),
        active_tile: None,
        completed_tiles: Vec::new(),
        steps: make_uninstall_steps(
            StepState::Active,
            "Closing active Epilod Party instances",
            "Checking",
            StepState::Pending,
            "Desktop, Start Menu & HKCU",
            "Queued",
            StepState::Pending,
            "Empty folders & self-cleanup",
            "Queued",
        ),
        bytes_done: 0,
        bytes_total: files_total as u64,
        files_done: 0,
        files_total,
        current_file: None,
        install_dir: resolved_dir.clone(),
        finished: false,
        cancelled: false,
        error: None,
    });

    let closed_processes = if target_dir.exists() {
        integrator.prepare_for_file_changes(&target_dir, None, options.force_close_running)?
    } else {
        0
    };

    // 1. Transactional file-first quarantine: verify EVERY non-self managed file can be vacated
    // BEFORE removing Start Menu/Desktop shortcuts, HKCU registry keys, or the install receipt.
    let current_exe_canon = std::env::current_exe()
        .ok()
        .and_then(|p| fs::canonicalize(p).ok());
    let receipt_canon = fs::canonicalize(target_dir.join(INSTALL_RECEIPT_FILENAME)).ok();
    let trash_dir = target_dir.join(UNINSTALL_TRASH_DIR_NAME);
    if trash_dir.is_dir() {
        // Restore any orphaned files from an aborted prior uninstall before fresh scan/quarantine
        restore_dir_recursive(&trash_dir, &trash_dir, &target_dir)?;
        let _ = remove_dir_all_resilient(&trash_dir);
    }

    let mut removed_files = 0usize;
    let mut self_cleanup_needed = false;
    let mut quarantined: Vec<(PathBuf, PathBuf)> = Vec::new();

    for (idx, file_path) in targets.iter().enumerate() {
        let short = file_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file");

        let cand_canon = fs::canonicalize(file_path).ok();
        let is_self_exe = file_path.exists()
            && current_exe_canon
                .as_ref()
                .zip(cand_canon.as_ref())
                .map(|(cur, cand)| cur == cand)
                .unwrap_or(false);

        if is_self_exe {
            self_cleanup_needed = true;
            continue;
        }

        // Defer receipt deletion until after shortcuts & registry are cleanly removed
        let is_receipt_file = short.eq_ignore_ascii_case(INSTALL_RECEIPT_FILENAME)
            && receipt_canon
                .as_ref()
                .zip(cand_canon.as_ref())
                .map(|(r, c)| r == c)
                .unwrap_or(file_path == &target_dir.join(INSTALL_RECEIPT_FILENAME));
        if is_receipt_file {
            continue;
        }

        if file_path.is_file() {
            let rel = file_path
                .strip_prefix(&target_dir)
                .unwrap_or_else(|_| Path::new(short));
            let trash_path = trash_dir.join(rel);
            if let Some(parent) = trash_path.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    restore_quarantined_files(&quarantined, &trash_dir);
                    return Err(format!(
                        "Cannot prepare uninstall quarantine for {} ({e}). Shortcuts and Windows Registry were left unchanged.",
                        file_path.display()
                    ));
                }
            }
            if let Err(e) = rename_with_retry(file_path, &trash_path) {
                restore_quarantined_files(&quarantined, &trash_dir);
                return Err(format!(
                    "Cannot remove {} ({e}). Shortcuts and Windows Registry were left unchanged — close any program locking it and retry.",
                    file_path.display()
                ));
            }
            quarantined.push((file_path.clone(), trash_path));
            removed_files += 1;
        }

        let pct = compute_weighted_percent(
            InstallPhase::RemovingFiles,
            0,
            1,
            idx + 1,
            targets.len().max(1),
        );
        emit(InstallTelemetry {
            phase: InstallPhase::RemovingFiles,
            overall_percent: pct,
            headline: "Removing application files".to_string(),
            live_status: format!("Removed {short}"),
            active_tile: Some(TileId::Mpv),
            completed_tiles: Vec::new(),
            steps: make_uninstall_steps(
                StepState::Active,
                &format!("Removing {short}"),
                &format!("{}/{}", idx + 1, targets.len().max(1)),
                StepState::Pending,
                "Desktop, Start Menu & HKCU",
                "Queued",
                StepState::Pending,
                "Empty folders & self-cleanup",
                "Queued",
            ),
            bytes_done: (idx + 1) as u64,
            bytes_total: targets.len().max(1) as u64,
            files_done: idx + 1,
            files_total: targets.len().max(1),
            current_file: Some(short.to_string()),
            install_dir: resolved_dir.clone(),
            finished: false,
            cancelled: false,
            error: None,
        });
    }

    // All non-self managed files are quarantined safely; purge quarantine & internal folders/markers
    if trash_dir.is_dir() {
        let _ = remove_dir_all_resilient(&trash_dir);
    }
    for internal in [
        STAGING_DIR_NAME,
        BACKUP_DIR_NAME,
        ".epilod-write-probe",
        ".epilod-install-manifest.json.tmp",
        ".epilod-uninstall.exe.tmp",
        TX_MARKER_FILENAME,
        TX_JOURNAL_FILENAME,
    ] {
        let p = target_dir.join(internal);
        if p.is_dir() {
            let _ = remove_dir_all_resilient(&p);
        } else if p.is_file() {
            let _ = remove_file_resilient(&p);
        }
    }
    if let Ok(entries) = fs::read_dir(&target_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if (name.starts_with(".epilod-write-probe-") || name.starts_with(".epilod-probe-"))
                && entry.path().is_file()
            {
                let _ = remove_file_resilient(&entry.path());
            }
        }
    }

    // 2. Remove shortcuts & registry ONLY after all application files were vacated
    emit(InstallTelemetry {
        phase: InstallPhase::CleaningRegistry,
        overall_percent: compute_weighted_percent(InstallPhase::CleaningRegistry, 0, 1, 0, 3),
        headline: "Removing system integration".to_string(),
        live_status: "Removing Start Menu, Desktop shortcuts & Windows registry".to_string(),
        active_tile: Some(TileId::StartTls),
        completed_tiles: vec![TileId::Mpv],
        steps: make_uninstall_steps(
            StepState::Done,
            "Managed app files removed",
            "Removed",
            StepState::Active,
            "Removing HKCU registry & handlers",
            "Cleaning",
            StepState::Pending,
            "Empty folders & self-cleanup",
            "Queued",
        ),
        bytes_done: files_total as u64,
        bytes_total: files_total as u64,
        files_done: files_total,
        files_total,
        current_file: None,
        install_dir: resolved_dir.clone(),
        finished: false,
        cancelled: false,
        error: None,
    });

    let cleanup = integrator.remove_shortcuts_and_registry(
        &target_dir,
        receipt.as_ref(),
        options.remove_user_data,
        &mut |status, idx, total| {
            let pct =
                compute_weighted_percent(InstallPhase::CleaningRegistry, 0, 1, idx, total.max(1));
            emit(InstallTelemetry {
                phase: InstallPhase::CleaningRegistry,
                overall_percent: pct,
                headline: "Removing system integration".to_string(),
                live_status: status.to_string(),
                active_tile: Some(TileId::StartTls),
                completed_tiles: vec![TileId::Mpv, TileId::Syncplay],
                steps: make_uninstall_steps(
                    StepState::Done,
                    "Managed app files removed",
                    "Removed",
                    StepState::Active,
                    status,
                    "Cleaning",
                    StepState::Pending,
                    "Empty folders & self-cleanup",
                    "Queued",
                ),
                bytes_done: files_total as u64,
                bytes_total: files_total as u64,
                files_done: files_total,
                files_total,
                current_file: None,
                install_dir: resolved_dir.clone(),
                finished: false,
                cancelled: false,
                error: None,
            });
        },
    )?;

    // 3. Finalize receipt, prune empty folders, and schedule self-cleanup when running from target_dir
    let receipt_file = target_dir.join(INSTALL_RECEIPT_FILENAME);
    if !self_cleanup_needed
        && receipt_file.is_file()
        && remove_file_resilient(&receipt_file).is_ok()
    {
        removed_files += 1;
    }

    let removed_dirs = if target_dir.is_dir() {
        prune_empty_dirs_bottom_up(&target_dir, !self_cleanup_needed)
    } else {
        0
    };

    let kept_unrelated_paths = if target_dir.is_dir() {
        list_remaining_unrelated_files(&target_dir, self_cleanup_needed)
    } else {
        Vec::new()
    };

    let scheduled_self_cleanup = if self_cleanup_needed {
        integrator
            .schedule_self_cleanup(&target_dir, UNINSTALLER_FILENAME, INSTALL_RECEIPT_FILENAME)
            .unwrap_or(false)
    } else {
        false
    };

    let skipped_unrelated_files = kept_unrelated_paths.len();
    let mut status_summary = if skipped_unrelated_files > 0 {
        format!(
            "Removed {removed_files} Epilod files · preserved {skipped_unrelated_files} non-app file(s)"
        )
    } else {
        format!("Removed {removed_files} files & Windows integration cleanly")
    };
    if !cleanup.warnings.is_empty() {
        status_summary = format!(
            "{status_summary} · {} cleanup warning(s)",
            cleanup.warnings.len()
        );
    }

    emit(InstallTelemetry {
        phase: InstallPhase::Complete,
        overall_percent: 100.0,
        headline: "Epilod Party uninstalled".to_string(),
        live_status: status_summary,
        active_tile: None,
        completed_tiles: vec![
            TileId::Mpv,
            TileId::AutoSync,
            TileId::Syncplay,
            TileId::StartTls,
        ],
        steps: make_uninstall_steps(
            StepState::Done,
            "App files removed safely",
            "Clean",
            StepState::Done,
            if cleanup.removed_registry {
                "Shortcuts & Registry cleaned"
            } else {
                "Shortcuts cleaned (registry warning)"
            },
            if cleanup.removed_registry {
                "Removed"
            } else {
                "Warning"
            },
            StepState::Done,
            if self_cleanup_needed {
                "Self-cleanup scheduled"
            } else {
                "Install folder cleaned"
            },
            "Done",
        ),
        bytes_done: targets.len().max(1) as u64,
        bytes_total: targets.len().max(1) as u64,
        files_done: targets.len().max(1),
        files_total: targets.len().max(1),
        current_file: None,
        install_dir: resolved_dir.clone(),
        finished: true,
        cancelled: false,
        error: None,
    });

    Ok(UninstallSummary {
        install_dir: resolved_dir,
        removed_files,
        removed_dirs,
        skipped_unrelated_files,
        kept_unrelated_paths,
        removed_shortcuts: cleanup.removed_shortcuts,
        removed_registry: cleanup.removed_registry,
        removed_user_data: cleanup.removed_user_data,
        scheduled_self_cleanup,
        closed_processes,
        warnings: cleanup.warnings,
    })
}

fn clear_readonly(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

fn is_transient_fs_error(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::PermissionDenied || matches!(err.raw_os_error(), Some(5 | 32 | 33))
}

fn retry_transient_fs<T, F>(mut op: F) -> io::Result<T>
where
    F: FnMut() -> io::Result<T>,
{
    const BACKOFF_MS: [u64; 5] = [100, 150, 250, 400, 600];
    let mut attempt = 0usize;
    loop {
        match op() {
            Ok(val) => return Ok(val),
            Err(err) if attempt < BACKOFF_MS.len() && is_transient_fs_error(&err) => {
                std::thread::sleep(Duration::from_millis(BACKOFF_MS[attempt]));
                attempt += 1;
            }
            Err(err) => return Err(err),
        }
    }
}

pub fn remove_file_resilient(path: &Path) -> io::Result<()> {
    retry_transient_fs(|| {
        clear_readonly(path);
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    })
}

fn rename_with_retry(src: &Path, dst: &Path) -> io::Result<()> {
    retry_transient_fs(|| {
        clear_readonly(src);
        if dst.exists() {
            clear_readonly(dst);
        }
        fs::rename(src, dst)
    })
}

fn copy_with_retry(src: &Path, dst: &Path) -> io::Result<u64> {
    retry_transient_fs(|| {
        if dst.exists() {
            clear_readonly(dst);
        }
        fs::copy(src, dst)
    })
}

fn clear_readonly_recursive(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            clear_readonly(&p);
            if p.is_dir() {
                clear_readonly_recursive(&p);
            }
        }
    }
    clear_readonly(dir);
}

pub fn remove_dir_all_resilient(dir: &Path) -> io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    clear_readonly_recursive(dir);
    retry_transient_fs(|| {
        clear_readonly_recursive(dir);
        match fs::remove_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    })
}

fn restore_quarantined_files(quarantined: &[(PathBuf, PathBuf)], trash_dir: &Path) {
    for (orig, trashed) in quarantined.iter().rev() {
        if !trashed.is_file() {
            continue;
        }
        if let Some(parent) = orig.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if rename_with_retry(trashed, orig).is_err() && copy_with_retry(trashed, orig).is_ok() {
            let _ = remove_file_resilient(trashed);
        }
    }
    let _ = remove_dir_all_resilient(trash_dir);
}

fn format_rollback_suffix(fs_err: Option<&str>) -> String {
    match fs_err {
        Some(err) => format!(
            " Partial rollback preserved backup snapshot in {BACKUP_DIR_NAME}; re-run Setup to complete recovery ({err})."
        ),
        None => String::new(),
    }
}

fn format_combined_rollback_suffix(fs_err: Option<&str>, int_err: Option<&str>) -> String {
    match (fs_err, int_err) {
        (Some(f), Some(i)) => format!(
            " Partial rollback preserved backup snapshot in {BACKUP_DIR_NAME}; re-run Setup to complete recovery ({f}; {i})."
        ),
        (Some(f), None) => format!(
            " Partial rollback preserved backup snapshot in {BACKUP_DIR_NAME}; re-run Setup to complete recovery ({f})."
        ),
        (None, Some(i)) => format!(" Desktop integration rollback warning: {i}."),
        (None, None) => String::new(),
    }
}

fn write_tx_journal(backup_dir: &Path, journal: &TransactionJournal) -> Result<(), String> {
    let path = backup_dir.join(TX_JOURNAL_FILENAME);
    let bytes = serde_json::to_vec(journal)
        .map_err(|e| format!("Failed serializing transaction journal: {e}"))?;
    fs::write(&path, bytes).map_err(|e| format!("Failed writing transaction journal: {e}"))
}

struct TransactionLog {
    target_dir: PathBuf,
    backup_dir: PathBuf,
    backed_up: Vec<(PathBuf, PathBuf)>,
    newly_placed: Vec<PathBuf>,
}

impl TransactionLog {
    fn backup_file(&mut self, original: &Path, rel: &str) -> Result<(), String> {
        let backup_target = self.backup_dir.join(rel);
        if let Some(parent) = backup_target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("Failed creating backup subfolder {}: {e}", parent.display())
            })?;
        }
        copy_with_retry(original, &backup_target)
            .map_err(|e| format!("Failed backing up {}: {e}", original.display()))?;
        self.backed_up.push((original.to_path_buf(), backup_target));
        Ok(())
    }

    fn backup_and_remove(&mut self, original: &Path, rel: &str) -> Result<(), String> {
        let backup_target = self.backup_dir.join(rel);
        if let Some(parent) = backup_target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("Failed creating backup subfolder {}: {e}", parent.display())
            })?;
        }
        if rename_with_retry(original, &backup_target).is_err() {
            copy_with_retry(original, &backup_target)
                .map_err(|e| format!("Failed backing up {}: {e}", original.display()))?;
            remove_file_resilient(original)
                .map_err(|e| format!("Failed removing locked file {}: {e}", original.display()))?;
        }
        self.backed_up.push((original.to_path_buf(), backup_target));
        Ok(())
    }

    fn rollback(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        // 1. Remove any newly placed files
        for placed in self.newly_placed.iter().rev() {
            if placed.is_file() {
                if let Err(e) = remove_file_resilient(placed) {
                    errors.push(format!("remove {}: {e}", placed.display()));
                }
            }
        }
        // 2. Restore original backed-up files
        for (original, backup) in self.backed_up.iter().rev() {
            if let Some(parent) = original.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    errors.push(format!("mkdir {}: {e}", parent.display()));
                    continue;
                }
            }
            if original.is_file() {
                if let Err(e) = remove_file_resilient(original) {
                    errors.push(format!("clear {}: {e}", original.display()));
                    continue;
                }
            }
            if backup.is_file() && rename_with_retry(backup, original).is_err() {
                match copy_with_retry(backup, original) {
                    Ok(_) => {
                        let _ = remove_file_resilient(backup);
                    }
                    Err(e) => {
                        errors.push(format!("restore {}: {e}", original.display()));
                    }
                }
            }
        }
        prune_empty_dirs_bottom_up(&self.target_dir, false);
        if errors.is_empty() {
            if let Err(e) = remove_dir_all_resilient(&self.backup_dir) {
                errors.push(format!("cleanup backup dir: {e}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn recover_interrupted_transaction(
    target_dir: &Path,
    backup_dir: &Path,
    staging_dir: &Path,
    integrator: &dyn SystemIntegrator,
) -> Result<(), String> {
    if staging_dir.exists() {
        let _ = remove_dir_all_resilient(staging_dir);
    }
    let trash_dir = target_dir.join(UNINSTALL_TRASH_DIR_NAME);
    if trash_dir.is_dir() {
        restore_dir_recursive(&trash_dir, &trash_dir, target_dir)?;
        let _ = remove_dir_all_resilient(&trash_dir);
    }
    if !backup_dir.is_dir() {
        return Ok(());
    }
    if backup_dir.join(TX_MARKER_FILENAME).is_file() {
        let _ = remove_dir_all_resilient(backup_dir);
        return Ok(());
    }

    // Incomplete previous transaction:
    // 1. Replay persisted transaction journal if present (revert integration snapshot & remove orphaned newly placed files).
    let journal_path = backup_dir.join(TX_JOURNAL_FILENAME);
    if journal_path.is_file() {
        if let Ok(raw) = fs::read(&journal_path) {
            if let Ok(journal) = serde_json::from_slice::<TransactionJournal>(&raw) {
                if let Some(snapshot_bytes) = journal.integration_snapshot {
                    let prev_receipt =
                        read_receipt(backup_dir).or_else(|| read_receipt(target_dir));
                    let _ = integrator.revert_integration(
                        target_dir,
                        &IntegrationSnapshot(snapshot_bytes),
                        prev_receipt.as_ref(),
                    );
                }
                for rel in journal.newly_placed_rel_paths.iter().rev() {
                    if let Ok(clean_rel) = sanitize_relative_path(rel) {
                        let placed = target_dir.join(clean_rel);
                        if placed.is_file() {
                            let _ = remove_file_resilient(&placed);
                        }
                    }
                }
            }
        }
    }

    // 2. Restore backed-up files into target_dir
    restore_dir_recursive(backup_dir, backup_dir, target_dir)?;
    prune_empty_dirs_bottom_up(target_dir, false);
    let _ = remove_dir_all_resilient(backup_dir);
    Ok(())
}

fn restore_dir_recursive(root: &Path, current: &Path, target_dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| {
        format!(
            "Failed reading interrupted backup {}: {e}",
            current.display()
        )
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        if matches!(
            path.file_name().and_then(|s| s.to_str()),
            Some(TX_MARKER_FILENAME | TX_JOURNAL_FILENAME)
        ) {
            continue;
        }
        if path.is_dir() {
            restore_dir_recursive(root, &path, target_dir)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                let dst = target_dir.join(rel);
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| {
                        format!(
                            "Failed creating folder {} during recovery: {e}",
                            parent.display()
                        )
                    })?;
                }
                if dst.is_file() {
                    clear_readonly(&dst);
                }
                if rename_with_retry(&path, &dst).is_err() {
                    copy_with_retry(&path, &dst).map_err(|e| {
                        format!("Failed restoring interrupted backup {}: {e}", dst.display())
                    })?;
                    let _ = remove_file_resilient(&path);
                }
            }
        }
    }
    Ok(())
}

fn emit_rollback_status<F>(
    emit: &mut F,
    resolved_dir: &str,
    manifest: &PackageManifest,
    bytes_total: u64,
    files_total: usize,
) where
    F: FnMut(InstallTelemetry),
{
    emit(InstallTelemetry {
        phase: InstallPhase::RollingBack,
        overall_percent: compute_weighted_percent(
            InstallPhase::RollingBack,
            bytes_total,
            bytes_total,
            0,
            1,
        ),
        headline: "Restoring previous version".to_string(),
        live_status: format!(
            "Rolling back v{} safely from backup snapshot",
            manifest.version
        ),
        active_tile: None,
        completed_tiles: Vec::new(),
        steps: make_steps(
            StepState::Error,
            "Commit interrupted",
            "Rollback",
            StepState::Pending,
            "Restoring backup snapshot",
            "Restoring",
            StepState::Pending,
            "System unchanged",
            "Reverted",
        ),
        bytes_done: 0,
        bytes_total,
        files_done: 0,
        files_total,
        current_file: None,
        install_dir: resolved_dir.to_string(),
        finished: false,
        cancelled: false,
        error: None,
    });
}

fn prune_empty_dirs_bottom_up(dir: &Path, remove_root_if_empty: bool) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            removed += prune_empty_dirs_bottom_up(&path, true);
        }
    }
    if remove_root_if_empty {
        if let Ok(mut remaining) = fs::read_dir(dir) {
            if remaining.next().is_none() && fs::remove_dir(dir).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

fn list_remaining_unrelated_files(dir: &Path, ignore_self_uninstaller: bool) -> Vec<String> {
    let mut out = Vec::new();
    collect_remaining_recursive(dir, dir, ignore_self_uninstaller, &mut out);
    out
}

fn collect_remaining_recursive(
    root: &Path,
    dir: &Path,
    ignore_self_uninstaller: bool,
    out: &mut Vec<String>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_remaining_recursive(root, &p, ignore_self_uninstaller, out);
        } else if p.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                let s = rel.to_string_lossy().replace('\\', "/");
                if ignore_self_uninstaller
                    && (s.eq_ignore_ascii_case(UNINSTALLER_FILENAME)
                        || s.eq_ignore_ascii_case(INSTALL_RECEIPT_FILENAME))
                {
                    continue;
                }
                out.push(s);
            }
        }
    }
}

fn friendly_file_label(relative_path: &str) -> &str {
    let short_name = Path::new(relative_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(relative_path);
    match short_name {
        "NotoSansArabic-Regular.ttf" => "Arabic UI font",
        "NotoSansArabic-Bold.ttf" => "Arabic Bold font",
        "Inter-Regular.ttf" => "Inter UI font",
        "Inter-Bold.ttf" => "Inter Bold font",
        "GPL-3.0.txt" => "GPL-3.0 notice",
        "SOURCE_OFFER.txt" => "source notice",
        other => other,
    }
}

#[allow(clippy::too_many_arguments)]
fn make_steps(
    s1: StepState,
    d1: &str,
    r1: &str,
    s2: StepState,
    d2: &str,
    r2: &str,
    s3: StepState,
    d3: &str,
    r3: &str,
) -> [StepProgress; 3] {
    [
        StepProgress {
            id: StepId::MpvEngine,
            title: "mpv Playback Engine".to_string(),
            detail: d1.to_string(),
            right_label: r1.to_string(),
            state: s1,
        },
        StepProgress {
            id: StepId::FontsAndAutosync,
            title: "FFmpeg & Arabic Fonts".to_string(),
            detail: d2.to_string(),
            right_label: r2.to_string(),
            state: s2,
        },
        StepProgress {
            id: StepId::SyncplayAndSystem,
            title: "Syncplay TLS & Shortcuts".to_string(),
            detail: d3.to_string(),
            right_label: r3.to_string(),
            state: s3,
        },
    ]
}

#[allow(clippy::too_many_arguments)]
fn make_uninstall_steps(
    s1: StepState,
    d1: &str,
    r1: &str,
    s2: StepState,
    d2: &str,
    r2: &str,
    s3: StepState,
    d3: &str,
    r3: &str,
) -> [StepProgress; 3] {
    [
        StepProgress {
            id: StepId::MpvEngine,
            title: "Verified App Files".to_string(),
            detail: d1.to_string(),
            right_label: r1.to_string(),
            state: s1,
        },
        StepProgress {
            id: StepId::FontsAndAutosync,
            title: "Shortcuts & Registry".to_string(),
            detail: d2.to_string(),
            right_label: r2.to_string(),
            state: s2,
        },
        StepProgress {
            id: StepId::SyncplayAndSystem,
            title: "Finalize Cleanup".to_string(),
            detail: d3.to_string(),
            right_label: r3.to_string(),
            state: s3,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::pack_directory_with_version;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct MockIntegrator {
        fail_registry: bool,
        block_running: bool,
        free_bytes_override: Option<u64>,
        uninstaller_bytes_override: Option<u64>,
        poison_receipt_tmp_in_integration: bool,
        lock_mpv_dir_on_fail: bool,
        simulate_reg_warning: bool,
        reverted_integration: Arc<AtomicBool>,
        removed_shortcuts_called: Arc<AtomicBool>,
        seen_target_version: std::sync::Mutex<Option<String>>,
    }

    impl SystemIntegrator for MockIntegrator {
        fn check_destination(&self, dir: &Path) -> Result<Option<u64>, String> {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            Ok(Some(self.free_bytes_override.unwrap_or(500 * 1024 * 1024)))
        }

        fn estimate_uninstaller_bytes(&self) -> u64 {
            self.uninstaller_bytes_override.unwrap_or(16 * 1024 * 1024)
        }

        fn prepare_for_file_changes(
            &self,
            _install_dir: &Path,
            _wait_pid: Option<u32>,
            force_close_app: bool,
        ) -> Result<usize, String> {
            if self.block_running && !force_close_app {
                return Err("[LOCKED_PROCESSES] Epilod Party.exe is currently running.".into());
            }
            Ok(if self.block_running { 1 } else { 0 })
        }

        fn install_uninstaller(
            &self,
            install_dir: &Path,
            backup_dir: &Path,
        ) -> Result<bool, String> {
            let uninst = install_dir.join(UNINSTALLER_FILENAME);
            if uninst.is_file() {
                let b = backup_dir.join(UNINSTALLER_FILENAME);
                let _ = fs::copy(&uninst, &b);
            }
            fs::write(uninst, b"mock-uninstaller").map_err(|e| e.to_string())?;
            Ok(true)
        }

        fn capture_integration_snapshot(
            &self,
            _install_dir: &Path,
            _previous_receipt: Option<&InstallReceipt>,
        ) -> IntegrationSnapshot {
            IntegrationSnapshot(b"mock-prev-snapshot".to_vec())
        }

        fn revert_integration(
            &self,
            install_dir: &Path,
            snapshot: &IntegrationSnapshot,
            _previous_receipt: Option<&InstallReceipt>,
        ) -> Result<(), String> {
            assert_eq!(snapshot.0, b"mock-prev-snapshot");
            self.reverted_integration.store(true, Ordering::SeqCst);
            let _ = fs::remove_dir_all(install_dir.join(".epilod-install-manifest.json.tmp"));
            Ok(())
        }

        fn apply_shortcuts_and_registry(
            &self,
            install_dir: &Path,
            options: &InstallOptions,
            target_version: &str,
            _prev: Option<&InstallReceipt>,
            report: &mut dyn FnMut(&str, usize, usize),
        ) -> Result<IntegrationResult, String> {
            *self.seen_target_version.lock().unwrap() = Some(target_version.to_string());
            report("Creating Start Menu shortcut", 1, 3);
            report("Creating Desktop shortcut", 2, 3);
            if self.lock_mpv_dir_on_fail {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mpv_dir = install_dir.join("resources/mpv");
                    if mpv_dir.is_dir() {
                        let _ = fs::set_permissions(&mpv_dir, fs::Permissions::from_mode(0o555));
                    }
                }
            }
            if self.fail_registry {
                return Err("Simulated HKCU registry write error".into());
            }
            if self.poison_receipt_tmp_in_integration {
                let _ = fs::create_dir_all(
                    install_dir
                        .join(".epilod-install-manifest.json.tmp")
                        .join("blocker"),
                );
            }
            report("Registering Windows uninstall", 3, 3);
            let mut shortcuts = Vec::new();
            if options.create_desktop_shortcut {
                shortcuts.push(
                    install_dir
                        .join("mock_desktop.lnk")
                        .to_string_lossy()
                        .into(),
                );
            }
            Ok(IntegrationResult {
                created_shortcuts: shortcuts,
                created_registry_keys: vec!["HKCU\\Software\\Mock".into()],
                user_data_dir: None,
            })
        }

        fn remove_shortcuts_and_registry(
            &self,
            _install_dir: &Path,
            receipt: Option<&InstallReceipt>,
            remove_user_data: bool,
            report: &mut dyn FnMut(&str, usize, usize),
        ) -> Result<CleanupReport, String> {
            self.removed_shortcuts_called.store(true, Ordering::SeqCst);
            report("Removing shortcuts & registry", 1, 1);
            Ok(CleanupReport {
                removed_shortcuts: receipt.map(|r| r.shortcuts.len()).unwrap_or(0),
                removed_registry: !self.simulate_reg_warning,
                removed_user_data: remove_user_data,
                warnings: if self.simulate_reg_warning {
                    vec!["Failed deleting simulated HKCU key".to_string()]
                } else {
                    Vec::new()
                },
            })
        }
    }

    fn unique_tmp(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("epilod_pipe_test_{tag}_{nanos}"))
    }

    #[test]
    fn full_pipeline_emits_monotonic_progress_and_commits_files_and_receipt() {
        let root = unique_tmp("full");
        let src = root.join("src");
        let pkg = root.join("payload.epkg");
        let dst = root.join("installed");

        fs::create_dir_all(src.join("resources/mpv")).unwrap();
        fs::create_dir_all(src.join("resources/fonts")).unwrap();
        fs::write(src.join("Epilod Party.exe"), vec![1u8; 80_000]).unwrap();
        fs::write(src.join("resources/mpv/mpv.exe"), vec![2u8; 90_000]).unwrap();
        fs::write(
            src.join("resources/fonts/NotoSansArabic-Regular.ttf"),
            b"arabic",
        )
        .unwrap();

        pack_directory_with_version(&src, &pkg, "0.1.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        let mut telemetry = Vec::new();
        run_install_pipeline(&pkg, &opts, &MockIntegrator::default(), &cancel, |t| {
            telemetry.push(t);
        })
        .unwrap();

        assert!(telemetry.len() >= 5);
        assert!(telemetry.last().unwrap().finished);
        assert_eq!(telemetry.last().unwrap().overall_percent, 100.0);
        assert!(dst.join("Epilod Party.exe").exists());
        assert!(dst.join("resources/mpv/mpv.exe").exists());
        assert!(dst.join(INSTALL_RECEIPT_FILENAME).is_file());
        assert!(dst.join(UNINSTALLER_FILENAME).is_file());
        assert!(!dst.join(STAGING_DIR_NAME).exists());
        assert!(!dst.join(BACKUP_DIR_NAME).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn transactional_rollback_restores_previous_version_on_integration_failure() {
        let root = unique_tmp("rollback");
        let src_v1 = root.join("v1");
        let src_v2 = root.join("v2");
        let pkg_v1 = root.join("v1.epkg");
        let pkg_v2 = root.join("v2.epkg");
        let dst = root.join("installed");

        fs::create_dir_all(src_v1.join("resources/mpv")).unwrap();
        fs::write(src_v1.join("Epilod Party.exe"), b"binary-v1").unwrap();
        fs::write(src_v1.join("legacy-v1.dat"), b"old-legacy-file").unwrap();
        fs::write(src_v1.join("resources/mpv/mpv.exe"), b"mpv-v1").unwrap();
        pack_directory_with_version(&src_v1, &pkg_v1, "0.1.0").unwrap();

        fs::create_dir_all(src_v2.join("resources/mpv")).unwrap();
        fs::write(src_v2.join("Epilod Party.exe"), b"binary-v2").unwrap();
        fs::write(src_v2.join("new-v2.dat"), b"brand-new-file").unwrap();
        fs::write(src_v2.join("resources/mpv/mpv.exe"), b"mpv-v1").unwrap();
        pack_directory_with_version(&src_v2, &pkg_v2, "0.2.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg_v1, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        // Upgrade to v2 with simulated failure in registry step -> must rollback completely to v1!
        let v1_uninstaller_bytes = fs::read(dst.join(UNINSTALLER_FILENAME)).unwrap();
        let fail_integrator = MockIntegrator {
            fail_registry: true,
            ..Default::default()
        };
        let err =
            run_install_pipeline(&pkg_v2, &opts, &fail_integrator, &cancel, |_| {}).unwrap_err();
        assert!(err.contains("Rolled back cleanly"));
        assert!(fail_integrator.reverted_integration.load(Ordering::SeqCst));

        assert_eq!(
            fs::read(dst.join("Epilod Party.exe")).unwrap(),
            b"binary-v1"
        );
        assert_eq!(
            fs::read(dst.join("legacy-v1.dat")).unwrap(),
            b"old-legacy-file"
        );
        assert_eq!(
            fs::read(dst.join(UNINSTALLER_FILENAME)).unwrap(),
            v1_uninstaller_bytes
        );
        assert!(!dst.join("new-v2.dat").exists());
        assert_eq!(read_receipt(&dst).unwrap().version, "0.1.0");
        assert!(!dst.join(BACKUP_DIR_NAME).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn upgrade_prunes_obsolete_files_while_preserving_user_files() {
        let root = unique_tmp("upgrade_prune");
        let src_v1 = root.join("v1");
        let src_v2 = root.join("v2");
        let pkg_v1 = root.join("v1.epkg");
        let pkg_v2 = root.join("v2.epkg");
        let dst = root.join("installed");

        fs::create_dir_all(&src_v1).unwrap();
        fs::write(src_v1.join("Epilod Party.exe"), b"v1").unwrap();
        fs::write(src_v1.join("obsolete.dll"), b"old-dll").unwrap();
        pack_directory_with_version(&src_v1, &pkg_v1, "0.1.0").unwrap();

        fs::create_dir_all(&src_v2).unwrap();
        fs::write(src_v2.join("Epilod Party.exe"), b"v2").unwrap();
        pack_directory_with_version(&src_v2, &pkg_v2, "0.2.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg_v1, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        // Add unrelated user file inside install directory
        fs::write(dst.join("my-custom-notes.txt"), b"user-data-keep").unwrap();

        run_install_pipeline(&pkg_v2, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        assert_eq!(fs::read(dst.join("Epilod Party.exe")).unwrap(), b"v2");
        assert!(!dst.join("obsolete.dll").exists());
        assert_eq!(
            fs::read(dst.join("my-custom-notes.txt")).unwrap(),
            b"user-data-keep"
        );
        assert_eq!(read_receipt(&dst).unwrap().version, "0.2.0");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_scoped_uninstall_deletes_app_and_preserves_unrelated_user_files() {
        let root = unique_tmp("uninstall_scoped");
        let src = root.join("src");
        let pkg = root.join("app.epkg");
        let dst = root.join("SharedApps");

        fs::create_dir_all(src.join("resources/fonts")).unwrap();
        fs::write(src.join("Epilod Party.exe"), b"app").unwrap();
        fs::write(src.join("resources/fonts/Inter-Regular.ttf"), b"font").unwrap();
        pack_directory_with_version(&src, &pkg, "0.1.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        // Simulate user having an unrelated file inside same directory
        fs::write(dst.join("watch-history-backup.srt"), b"1\n00:00:01").unwrap();

        let un_opts = UninstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            remove_user_data: true,
            force_close_running: true,
            silent: false,
        };
        let summary = run_uninstall_pipeline(&un_opts, &MockIntegrator::default(), |_| {}).unwrap();

        assert!(!dst.join("Epilod Party.exe").exists());
        assert!(!dst.join("resources").exists());
        assert!(!dst.join(INSTALL_RECEIPT_FILENAME).exists());
        assert!(dst.join("watch-history-backup.srt").is_file());
        assert_eq!(summary.skipped_unrelated_files, 1);
        assert_eq!(
            summary.kept_unrelated_paths,
            vec!["watch-history-backup.srt".to_string()]
        );
        assert!(summary.removed_registry);
        assert!(summary.removed_user_data);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn interrupted_backup_recovery_restores_original_files() {
        let root = unique_tmp("recover_tx");
        let src = root.join("src");
        let pkg = root.join("app.epkg");
        let dst = root.join("App");

        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("Epilod Party.exe"), b"fresh").unwrap();
        pack_directory_with_version(&src, &pkg, "0.2.0").unwrap();

        // Simulate leftover interrupted .epilod-backup without committed marker
        fs::create_dir_all(dst.join(BACKUP_DIR_NAME)).unwrap();
        fs::write(dst.join(BACKUP_DIR_NAME).join("old-extra.txt"), b"restored").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        assert!(dst.join("old-extra.txt").is_file());
        assert!(dst.join("Epilod Party.exe").is_file());
        assert!(!dst.join(BACKUP_DIR_NAME).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn running_process_check_blocks_before_touching_files() {
        let root = unique_tmp("locked");
        let src = root.join("src");
        let pkg = root.join("app.epkg");
        let dst = root.join("App");

        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("Epilod Party.exe"), b"app").unwrap();
        pack_directory_with_version(&src, &pkg, "0.1.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        let blocked = MockIntegrator {
            block_running: true,
            ..Default::default()
        };
        let err = run_install_pipeline(&pkg, &opts, &blocked, &cancel, |_| {}).unwrap_err();
        assert!(err.contains("LOCKED_PROCESSES"));
        assert!(!dst.join("Epilod Party.exe").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cancel_during_extract_cleans_staging_and_leaves_dest_untouched() {
        let root = unique_tmp("cancel");
        let src = root.join("src");
        let pkg = root.join("payload.epkg");
        let dst = root.join("installed");

        fs::create_dir_all(src.join("resources/mpv")).unwrap();
        fs::write(src.join("Epilod Party.exe"), vec![1u8; 160_000]).unwrap();
        fs::write(src.join("resources/mpv/mpv.exe"), vec![2u8; 160_000]).unwrap();
        pack_directory_with_version(&src, &pkg, "0.1.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        let mut seen = 0usize;
        let err = run_install_pipeline(&pkg, &opts, &MockIntegrator::default(), &cancel, |_| {
            seen += 1;
            if seen >= 2 {
                cancel.store(true, Ordering::SeqCst);
            }
        })
        .unwrap_err();

        assert!(err.contains("cancelled"));
        assert!(!dst.join(STAGING_DIR_NAME).exists());
        assert!(!dst.join("Epilod Party.exe").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn integration_or_receipt_failure_rolls_back_shortcuts_and_registry() {
        let root = unique_tmp("receipt_rollback");
        let src_v1 = root.join("v1");
        let src_v2 = root.join("v2");
        let pkg_v1 = root.join("v1.epkg");
        let pkg_v2 = root.join("v2.epkg");
        let dst = root.join("installed");

        fs::create_dir_all(&src_v1).unwrap();
        fs::write(src_v1.join("Epilod Party.exe"), b"v1-app").unwrap();
        pack_directory_with_version(&src_v1, &pkg_v1, "0.1.0").unwrap();

        fs::create_dir_all(&src_v2).unwrap();
        fs::write(src_v2.join("Epilod Party.exe"), b"v2-app").unwrap();
        pack_directory_with_version(&src_v2, &pkg_v2, "0.2.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg_v1, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        let fail_receipt_integrator = MockIntegrator {
            poison_receipt_tmp_in_integration: true,
            ..Default::default()
        };
        let err = run_install_pipeline(&pkg_v2, &opts, &fail_receipt_integrator, &cancel, |_| {})
            .unwrap_err();

        assert!(err.contains("Rolled back cleanly"));
        assert!(fail_receipt_integrator
            .reverted_integration
            .load(Ordering::SeqCst));
        assert_eq!(fs::read(dst.join("Epilod Party.exe")).unwrap(), b"v1-app");
        assert_eq!(read_receipt(&dst).unwrap().version, "0.1.0");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preflight_budget_rejects_when_insufficient_space_for_staging_plus_uninstaller() {
        let root = unique_tmp("disk_budget");
        let src = root.join("src");
        let pkg = root.join("app.epkg");
        let dst = root.join("App");

        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("Epilod Party.exe"), vec![7u8; 4 * 1024 * 1024]).unwrap();
        pack_directory_with_version(&src, &pkg, "0.1.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        // Passes 32 MiB coarse preflight (40 MiB free), but fails exact pre-write check:
        // 4 MiB bytes_to_write + 20 MiB uninstaller + 24 MiB safety headroom = 48 MiB > 40 MiB.
        let tight_disk = MockIntegrator {
            free_bytes_override: Some(40 * 1024 * 1024),
            uninstaller_bytes_override: Some(20 * 1024 * 1024),
            ..Default::default()
        };
        let err = run_install_pipeline(&pkg, &opts, &tight_disk, &cancel, |_| {}).unwrap_err();
        assert!(err.contains("Not enough free disk space"));
        assert!(!dst.join(STAGING_DIR_NAME).exists());
        assert!(!dst.join("Epilod Party.exe").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn readonly_target_files_are_cleared_and_replaced_or_removed() {
        let root = unique_tmp("readonly_handling");
        let src_v1 = root.join("v1");
        let src_v2 = root.join("v2");
        let pkg_v1 = root.join("v1.epkg");
        let pkg_v2 = root.join("v2.epkg");
        let dst = root.join("App");

        fs::create_dir_all(&src_v1).unwrap();
        fs::write(src_v1.join("Epilod Party.exe"), b"v1").unwrap();
        pack_directory_with_version(&src_v1, &pkg_v1, "0.1.0").unwrap();

        fs::create_dir_all(&src_v2).unwrap();
        fs::write(src_v2.join("Epilod Party.exe"), b"v2").unwrap();
        pack_directory_with_version(&src_v2, &pkg_v2, "0.2.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg_v1, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        // Mark installed executable and uninstaller read-only before upgrade
        let mut perms = fs::metadata(dst.join("Epilod Party.exe"))
            .unwrap()
            .permissions();
        perms.set_readonly(true);
        fs::set_permissions(dst.join("Epilod Party.exe"), perms).unwrap();

        run_install_pipeline(&pkg_v2, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();
        assert_eq!(fs::read(dst.join("Epilod Party.exe")).unwrap(), b"v2");

        // Mark upgraded executable read-only before uninstall
        let mut perms2 = fs::metadata(dst.join("Epilod Party.exe"))
            .unwrap()
            .permissions();
        perms2.set_readonly(true);
        fs::set_permissions(dst.join("Epilod Party.exe"), perms2).unwrap();

        let un_opts = UninstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            remove_user_data: false,
            force_close_running: true,
            silent: false,
        };
        run_uninstall_pipeline(&un_opts, &MockIntegrator::default(), |_| {}).unwrap();
        assert!(!dst.join("Epilod Party.exe").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn uninstall_file_lock_aborts_before_removing_shortcuts_or_registry() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_tmp("uninstall_lock_order");
        let src = root.join("src");
        let pkg = root.join("app.epkg");
        let dst = root.join("App");

        fs::create_dir_all(src.join("resources/mpv")).unwrap();
        fs::write(src.join("Epilod Party.exe"), b"app").unwrap();
        fs::write(src.join("resources/mpv/mpv.exe"), b"mpv").unwrap();
        pack_directory_with_version(&src, &pkg, "0.1.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        // Simulate locked binary inside resources/mpv by denying directory write access
        let mpv_dir = dst.join("resources/mpv");
        fs::set_permissions(&mpv_dir, fs::Permissions::from_mode(0o555)).unwrap();

        let integrator = MockIntegrator::default();
        let un_opts = UninstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            remove_user_data: false,
            force_close_running: true,
            silent: false,
        };
        let err = run_uninstall_pipeline(&un_opts, &integrator, |_| {}).unwrap_err();
        assert!(err.contains("left unchanged"));
        assert!(!integrator.removed_shortcuts_called.load(Ordering::SeqCst));
        assert!(dst.join("Epilod Party.exe").is_file());
        assert!(dst.join("resources/mpv/mpv.exe").is_file());
        assert!(dst.join(INSTALL_RECEIPT_FILENAME).is_file());
        assert!(!dst.join(UNINSTALL_TRASH_DIR_NAME).exists());

        fs::set_permissions(&mpv_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn rollback_failure_preserves_backup_dir_for_recovery() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_tmp("preserve_backup");
        let src_v1 = root.join("v1");
        let src_v2 = root.join("v2");
        let pkg_v1 = root.join("v1.epkg");
        let pkg_v2 = root.join("v2.epkg");
        let dst = root.join("App");

        fs::create_dir_all(src_v1.join("resources/mpv")).unwrap();
        fs::write(src_v1.join("Epilod Party.exe"), b"v1-exe").unwrap();
        fs::write(src_v1.join("legacy-v1.dat"), b"keep-from-v1").unwrap();
        fs::write(src_v1.join("resources/mpv/mpv.exe"), b"mpv-v1").unwrap();
        pack_directory_with_version(&src_v1, &pkg_v1, "0.1.0").unwrap();

        fs::create_dir_all(src_v2.join("resources/mpv")).unwrap();
        fs::write(src_v2.join("Epilod Party.exe"), b"v2-exe").unwrap();
        fs::write(src_v2.join("resources/mpv/mpv.exe"), b"mpv-v2").unwrap();
        pack_directory_with_version(&src_v2, &pkg_v2, "0.2.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        run_install_pipeline(&pkg_v1, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();

        let fail_and_lock = MockIntegrator {
            fail_registry: true,
            lock_mpv_dir_on_fail: true,
            ..Default::default()
        };
        let err =
            run_install_pipeline(&pkg_v2, &opts, &fail_and_lock, &cancel, |_| {}).unwrap_err();
        assert!(err.contains("Partial rollback preserved backup snapshot"));
        assert!(dst.join(BACKUP_DIR_NAME).is_dir());

        // Restore write permission and re-run setup (blocking right after step 0 recovery):
        // interrupted backup must recover legacy-v1.dat and v1 receipt cleanly first!
        let mpv_dir = dst.join("resources/mpv");
        fs::set_permissions(&mpv_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let blocked_after_recovery = MockIntegrator {
            block_running: true,
            ..Default::default()
        };
        let _ = run_install_pipeline(&pkg_v2, &opts, &blocked_after_recovery, &cancel, |_| {});
        assert!(dst.join("legacy-v1.dat").is_file());
        assert_eq!(fs::read(dst.join("Epilod Party.exe")).unwrap(), b"v1-exe");
        assert_eq!(
            fs::read(dst.join("resources/mpv/mpv.exe")).unwrap(),
            b"mpv-v1"
        );
        assert_eq!(read_receipt(&dst).unwrap().version, "0.1.0");
        assert!(!dst.join(BACKUP_DIR_NAME).exists());

        run_install_pipeline(&pkg_v2, &opts, &MockIntegrator::default(), &cancel, |_| {}).unwrap();
        assert_eq!(read_receipt(&dst).unwrap().version, "0.2.0");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tx_journal_recovery_deletes_orphaned_new_files_and_reverts_integration() {
        let root = unique_tmp("journal_crash");
        let src_v1 = root.join("v1");
        let src_v2 = root.join("v2");
        let pkg_v1 = root.join("v1.epkg");
        let pkg_v2 = root.join("v2.epkg");
        let dst = root.join("App");

        fs::create_dir_all(&src_v1).unwrap();
        fs::write(src_v1.join("Epilod Party.exe"), b"v1-exe").unwrap();
        pack_directory_with_version(&src_v1, &pkg_v1, "0.1.0").unwrap();

        fs::create_dir_all(&src_v2).unwrap();
        fs::write(src_v2.join("Epilod Party.exe"), b"v2-exe").unwrap();
        pack_directory_with_version(&src_v2, &pkg_v2, "0.2.0").unwrap();

        let opts = InstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            ..InstallOptions::default()
        };
        let cancel = AtomicBool::new(false);
        let first_int = MockIntegrator::default();
        run_install_pipeline(&pkg_v1, &opts, &first_int, &cancel, |_| {}).unwrap();
        assert_eq!(
            first_int.seen_target_version.lock().unwrap().as_deref(),
            Some("0.1.0")
        );

        // Simulate a hard crash mid-v2 transaction after placing an extra file & writing journal
        let backup_dir = dst.join(BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir).unwrap();
        fs::copy(
            dst.join("Epilod Party.exe"),
            backup_dir.join("Epilod Party.exe"),
        )
        .unwrap();
        fs::copy(
            dst.join(INSTALL_RECEIPT_FILENAME),
            backup_dir.join(INSTALL_RECEIPT_FILENAME),
        )
        .unwrap();
        fs::write(dst.join("Epilod Party.exe"), b"partial-v2-exe").unwrap();
        fs::write(dst.join("orphan-v2.dat"), b"should-be-deleted").unwrap();

        let journal = TransactionJournal {
            newly_placed_rel_paths: vec![
                "Epilod Party.exe".to_string(),
                "orphan-v2.dat".to_string(),
            ],
            integration_snapshot: Some(b"mock-prev-snapshot".to_vec()),
        };
        write_tx_journal(&backup_dir, &journal).unwrap();

        // Next run triggers recovery first (and then aborts at prepare_for_file_changes so we inspect recovered v1 state)
        let recovering = MockIntegrator {
            block_running: true,
            ..Default::default()
        };
        let _ = run_install_pipeline(&pkg_v2, &opts, &recovering, &cancel, |_| {});

        assert!(recovering.reverted_integration.load(Ordering::SeqCst));
        assert_eq!(fs::read(dst.join("Epilod Party.exe")).unwrap(), b"v1-exe");
        assert!(!dst.join("orphan-v2.dat").exists());
        assert!(!dst.join(BACKUP_DIR_NAME).exists());
        assert!(!dst.join(TX_JOURNAL_FILENAME).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn receiptless_uninstall_cleans_internal_markers_and_surfaces_registry_warnings() {
        let root = unique_tmp("uninstall_warnings");
        let dst = root.join("App");
        fs::create_dir_all(&dst).unwrap();

        fs::write(dst.join("Epilod Party.exe"), b"exe").unwrap();
        fs::write(dst.join(".epilod-install-manifest.json.tmp"), b"tmp").unwrap();
        fs::write(dst.join(".epilod-write-probe-1234"), b"ok").unwrap();
        fs::write(dst.join(TX_JOURNAL_FILENAME), b"{}").unwrap();
        fs::write(dst.join("user-note.txt"), b"keep").unwrap();

        let integrator = MockIntegrator {
            simulate_reg_warning: true,
            ..Default::default()
        };
        let un_opts = UninstallOptions {
            install_dir: dst.to_string_lossy().into_owned(),
            remove_user_data: false,
            force_close_running: true,
            silent: false,
        };
        let summary = run_uninstall_pipeline(&un_opts, &integrator, |_| {}).unwrap();

        assert!(!dst.join("Epilod Party.exe").exists());
        assert!(!dst.join(".epilod-install-manifest.json.tmp").exists());
        assert!(!dst.join(".epilod-write-probe-1234").exists());
        assert!(!dst.join(TX_JOURNAL_FILENAME).exists());
        assert!(dst.join("user-note.txt").is_file());
        assert!(!summary.removed_registry);
        assert_eq!(summary.warnings.len(), 1);

        let _ = fs::remove_dir_all(&root);
    }
}
