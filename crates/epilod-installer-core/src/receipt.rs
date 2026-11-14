use crate::archive::{hash_file, read_manifest, PackageManifest};
use crate::plan::{resolve_install_dir, validate_install_dir, ComponentId, APP_NAME};
use crate::semver::compare_versions;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const INSTALL_RECEIPT_FILENAME: &str = "epilod-install-manifest.json";
pub const UNINSTALLER_FILENAME: &str = "epilod-uninstall.exe";
pub const STAGING_DIR_NAME: &str = ".epilod-staging";
pub const BACKUP_DIR_NAME: &str = ".epilod-backup";
pub const UNINSTALL_TRASH_DIR_NAME: &str = ".epilod-uninstall-trash";
pub const TX_MARKER_FILENAME: &str = ".epilod-tx-committed";
pub const TX_JOURNAL_FILENAME: &str = ".epilod-tx-journal.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFileRecord {
    pub relative_path: String,
    pub component: ComponentId,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceipt {
    pub schema_version: u32,
    pub app_name: String,
    pub version: String,
    pub installed_at_unix: u64,
    pub install_dir: String,
    pub exe_relative_path: String,
    pub uninstaller_relative_path: String,
    pub managed_files: Vec<ManagedFileRecord>,
    pub shortcuts: Vec<String>,
    pub registry_keys: Vec<String>,
    pub file_associations: bool,
    pub desktop_shortcut: bool,
    pub start_menu_shortcut: bool,
    pub user_data_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileCheckState {
    MatchesTarget,
    IntactInstalled,
    OutdatedNeedsUpdate,
    Corrupted,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallDisposition {
    FreshInstall,
    UpToDateVerified,
    RepairNeeded,
    UpdateAvailable,
    DowngradeWarning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingInstallReport {
    pub install_dir: String,
    pub resolved_dir: String,
    pub disposition: InstallDisposition,
    pub installed_version: Option<String>,
    pub package_version: Option<String>,
    pub existing_exe_found: bool,
    pub receipt_present: bool,
    pub verified_intact_count: usize,
    pub update_count: usize,
    pub corrupted_count: usize,
    pub missing_count: usize,
    pub unrelated_file_count: usize,
    #[serde(default)]
    pub unrelated_count_capped: bool,
    pub reusable_bytes: u64,
    pub bytes_to_write: u64,
    pub total_package_bytes: u64,
    pub missing_files: Vec<String>,
    pub corrupted_files: Vec<String>,
    pub modified_files: Vec<String>,
    pub obsolete_files: Vec<String>,
    pub shortcuts_recorded: usize,
    pub summary_text: String,
}

pub fn read_receipt(install_dir: &Path) -> Option<InstallReceipt> {
    let path = install_dir.join(INSTALL_RECEIPT_FILENAME);
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

pub fn write_receipt_atomic(install_dir: &Path, receipt: &InstallReceipt) -> Result<(), String> {
    fs::create_dir_all(install_dir)
        .map_err(|e| format!("Failed creating install dir for receipt: {e}"))?;
    let target = install_dir.join(INSTALL_RECEIPT_FILENAME);
    let tmp = install_dir.join(".epilod-install-manifest.json.tmp");
    let json = serde_json::to_vec_pretty(receipt)
        .map_err(|e| format!("Failed serializing install manifest: {e}"))?;
    fs::write(&tmp, &json).map_err(|e| format!("Failed writing temp install manifest: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&tmp, &target).map_err(|e| format!("Failed committing install manifest: {e}"))?;
    Ok(())
}

pub fn inspect_existing_install(
    archive_path: Option<&Path>,
    raw_install_dir: &str,
) -> Result<ExistingInstallReport, String> {
    let syntax_dir = validate_install_dir(raw_install_dir).map_err(|e| e.to_string())?;
    let resolved_dir_str = resolve_install_dir(&syntax_dir).unwrap_or_else(|_| syntax_dir.clone());
    let dir_path = Path::new(&resolved_dir_str);

    let package_manifest: Option<PackageManifest> = archive_path
        .and_then(|p| read_manifest(p).ok())
        .map(|(m, _)| m);

    Ok(inspect_with_manifest(
        dir_path,
        &syntax_dir,
        &resolved_dir_str,
        package_manifest.as_ref(),
    ))
}

pub fn inspect_with_manifest(
    dir_path: &Path,
    display_dir: &str,
    resolved_dir: &str,
    package_manifest: Option<&PackageManifest>,
) -> ExistingInstallReport {
    let receipt = read_receipt(dir_path);
    let receipt_present = receipt.is_some();
    let installed_version = receipt.as_ref().map(|r| r.version.clone());
    let package_version = package_manifest.map(|m| m.version.clone());
    let total_package_bytes = package_manifest.map(|m| m.total_bytes).unwrap_or(0);

    let existing_exe_found =
        dir_path.join("Epilod Party.exe").is_file() || dir_path.join("epilod-party.exe").is_file();

    let mut verified_intact_count = 0usize;
    let mut update_count = 0usize;
    let mut corrupted_count = 0usize;
    let mut missing_count = 0usize;
    let mut reusable_bytes = 0u64;
    let mut bytes_to_write = 0u64;
    let mut missing_files = Vec::new();
    let mut corrupted_files = Vec::new();
    let mut modified_files = Vec::new();
    let mut obsolete_files = Vec::new();

    let mut managed_rel_set = BTreeSet::new();
    if let Some(pkg) = package_manifest {
        for e in &pkg.entries {
            managed_rel_set.insert(e.relative_path.replace('\\', "/").to_ascii_lowercase());
        }
    }
    if let Some(rec) = &receipt {
        for f in &rec.managed_files {
            managed_rel_set.insert(f.relative_path.replace('\\', "/").to_ascii_lowercase());
        }
    }
    managed_rel_set.insert(INSTALL_RECEIPT_FILENAME.to_ascii_lowercase());
    managed_rel_set.insert(UNINSTALLER_FILENAME.to_ascii_lowercase());

    let (unrelated_file_count, unrelated_count_capped) = if dir_path.is_dir() {
        count_unrelated_files_bounded(dir_path, &managed_rel_set, 6, 2_000)
    } else {
        (0, false)
    };

    if !dir_path.is_dir() || (!receipt_present && !existing_exe_found) {
        let count_label = if unrelated_count_capped {
            format!("{unrelated_file_count}+")
        } else {
            unrelated_file_count.to_string()
        };
        let summary_text = if unrelated_file_count > 0 {
            format!(
                "Clean setup ready · Folder contains {count_label} existing non-app file(s) which will be preserved"
            )
        } else {
            "Clean destination · Ready for fresh installation".to_string()
        };
        return ExistingInstallReport {
            install_dir: display_dir.to_string(),
            resolved_dir: resolved_dir.to_string(),
            disposition: InstallDisposition::FreshInstall,
            installed_version,
            package_version,
            existing_exe_found,
            receipt_present,
            verified_intact_count: 0,
            update_count: 0,
            corrupted_count: 0,
            missing_count: 0,
            unrelated_file_count,
            unrelated_count_capped,
            reusable_bytes: 0,
            bytes_to_write: total_package_bytes,
            total_package_bytes,
            missing_files,
            corrupted_files,
            modified_files,
            obsolete_files,
            shortcuts_recorded: 0,
            summary_text,
        };
    }

    // Compare against package manifest (install / verify / update / repair)
    if let Some(pkg) = package_manifest {
        let ver_cmp = installed_version
            .as_deref()
            .and_then(|iv| compare_versions(iv, &pkg.version));

        for entry in &pkg.entries {
            let norm_rel = entry.relative_path.replace('\\', "/");
            let full = dir_path.join(&norm_rel);
            if !full.is_file() {
                missing_count += 1;
                bytes_to_write = bytes_to_write.saturating_add(entry.size);
                missing_files.push(norm_rel);
                continue;
            }
            match hash_file(&full) {
                Ok((size, digest))
                    if size == entry.size && digest == entry.sha256.to_ascii_lowercase() =>
                {
                    verified_intact_count += 1;
                    reusable_bytes = reusable_bytes.saturating_add(entry.size);
                }
                _ => {
                    let is_upgrade = ver_cmp == Some(Ordering::Less);
                    if is_upgrade {
                        update_count += 1;
                        modified_files.push(norm_rel);
                    } else {
                        corrupted_count += 1;
                        corrupted_files.push(norm_rel);
                    }
                    bytes_to_write = bytes_to_write.saturating_add(entry.size);
                }
            }
        }

        // Detect obsolete files recorded by prior receipt no longer present in incoming manifest
        if let Some(rec) = &receipt {
            let incoming_lower: BTreeSet<String> = pkg
                .entries
                .iter()
                .map(|e| e.relative_path.replace('\\', "/").to_ascii_lowercase())
                .collect();
            for old in &rec.managed_files {
                let norm_old = old.relative_path.replace('\\', "/");
                if !incoming_lower.contains(&norm_old.to_ascii_lowercase())
                    && dir_path.join(&norm_old).is_file()
                {
                    obsolete_files.push(norm_old);
                }
            }
        }

        let uninstaller_missing = !dir_path.join(UNINSTALLER_FILENAME).is_file();

        let disposition = match ver_cmp {
            Some(Ordering::Greater) => InstallDisposition::DowngradeWarning,
            Some(Ordering::Less) => InstallDisposition::UpdateAvailable,
            _ => {
                if missing_count == 0
                    && corrupted_count == 0
                    && update_count == 0
                    && !uninstaller_missing
                {
                    InstallDisposition::UpToDateVerified
                } else {
                    InstallDisposition::RepairNeeded
                }
            }
        };

        let summary_text = match disposition {
            InstallDisposition::FreshInstall => {
                "Clean destination · Ready for installation".to_string()
            }
            InstallDisposition::UpToDateVerified => format!(
                "Verified v{} installed · {}/{} files match SHA-256",
                installed_version.as_deref().unwrap_or(&pkg.version),
                verified_intact_count,
                pkg.entries.len()
            ),
            InstallDisposition::RepairNeeded => {
                let issues = missing_count + corrupted_count + update_count;
                if issues > 0 {
                    format!(
                        "Repair needed · {} missing or damaged file{}",
                        issues,
                        if issues == 1 { "" } else { "s" }
                    )
                } else {
                    "Repair needed · Uninstaller component missing".to_string()
                }
            }
            InstallDisposition::UpdateAvailable => format!(
                "Upgrade v{} -> v{} · {} verified unchanged, {} to update",
                installed_version.as_deref().unwrap_or("0.0.0"),
                pkg.version,
                verified_intact_count,
                update_count + missing_count
            ),
            InstallDisposition::DowngradeWarning => format!(
                "Newer v{} is already installed (package is v{})",
                installed_version.as_deref().unwrap_or("?"),
                pkg.version
            ),
        };

        return ExistingInstallReport {
            install_dir: display_dir.to_string(),
            resolved_dir: resolved_dir.to_string(),
            disposition,
            installed_version,
            package_version,
            existing_exe_found,
            receipt_present,
            verified_intact_count,
            update_count,
            corrupted_count,
            missing_count,
            unrelated_file_count,
            unrelated_count_capped,
            reusable_bytes,
            bytes_to_write,
            total_package_bytes,
            missing_files,
            corrupted_files,
            modified_files,
            obsolete_files,
            shortcuts_recorded: receipt.as_ref().map(|r| r.shortcuts.len()).unwrap_or(0),
            summary_text,
        };
    }

    // No incoming package manifest (self-verification / uninstall inspection using receipt only)
    if let Some(rec) = &receipt {
        for item in &rec.managed_files {
            let norm_rel = item.relative_path.replace('\\', "/");
            let full = dir_path.join(&norm_rel);
            if !full.is_file() {
                missing_count += 1;
                missing_files.push(norm_rel);
                continue;
            }
            match hash_file(&full) {
                Ok((size, digest))
                    if size == item.size && digest == item.sha256.to_ascii_lowercase() =>
                {
                    verified_intact_count += 1;
                    reusable_bytes = reusable_bytes.saturating_add(item.size);
                }
                _ => {
                    corrupted_count += 1;
                    corrupted_files.push(norm_rel);
                }
            }
        }
        let disposition = if missing_count == 0 && corrupted_count == 0 {
            InstallDisposition::UpToDateVerified
        } else {
            InstallDisposition::RepairNeeded
        };
        let summary_text = if disposition == InstallDisposition::UpToDateVerified {
            format!(
                "Installed v{} · {}/{} verified files ready to remove",
                rec.version,
                verified_intact_count,
                rec.managed_files.len()
            )
        } else {
            format!(
                "Installed v{} · {} intact, {} missing/changed",
                rec.version,
                verified_intact_count,
                missing_count + corrupted_count
            )
        };
        return ExistingInstallReport {
            install_dir: display_dir.to_string(),
            resolved_dir: resolved_dir.to_string(),
            disposition,
            installed_version: Some(rec.version.clone()),
            package_version: None,
            existing_exe_found,
            receipt_present: true,
            verified_intact_count,
            update_count: 0,
            corrupted_count,
            missing_count,
            unrelated_file_count,
            unrelated_count_capped,
            reusable_bytes,
            bytes_to_write: 0,
            total_package_bytes: reusable_bytes,
            missing_files,
            corrupted_files,
            modified_files,
            obsolete_files,
            shortcuts_recorded: rec.shortcuts.len(),
            summary_text,
        };
    }

    // Legacy install without receipt and no package manifest
    ExistingInstallReport {
        install_dir: display_dir.to_string(),
        resolved_dir: resolved_dir.to_string(),
        disposition: InstallDisposition::RepairNeeded,
        installed_version: None,
        package_version: None,
        existing_exe_found,
        receipt_present: false,
        verified_intact_count: if existing_exe_found { 1 } else { 0 },
        update_count: 0,
        corrupted_count: 0,
        missing_count: 0,
        unrelated_file_count,
        unrelated_count_capped,
        reusable_bytes: 0,
        bytes_to_write: 0,
        total_package_bytes: 0,
        missing_files,
        corrupted_files,
        modified_files,
        obsolete_files,
        shortcuts_recorded: 0,
        summary_text: "Legacy Epilod Party installation detected (no receipt)".to_string(),
    }
}

/// Fast non-hashing destination check used during debounced path editing so typing into
/// arbitrary folders does not trigger expensive recursive walks or SHA-256 passes.
pub fn preflight_existing_install(
    archive_path: Option<&Path>,
    raw_install_dir: &str,
) -> Result<ExistingInstallReport, String> {
    let syntax_dir = validate_install_dir(raw_install_dir).map_err(|e| e.to_string())?;
    let resolved_dir_str = resolve_install_dir(&syntax_dir).unwrap_or_else(|_| syntax_dir.clone());
    let dir_path = Path::new(&resolved_dir_str);

    let package_manifest: Option<PackageManifest> = archive_path
        .and_then(|p| read_manifest(p).ok())
        .map(|(m, _)| m);
    let total_package_bytes = package_manifest
        .as_ref()
        .map(|m| m.total_bytes)
        .unwrap_or(0);
    let package_version = package_manifest.as_ref().map(|m| m.version.clone());

    let receipt = if dir_path.is_dir() {
        read_receipt(dir_path)
    } else {
        None
    };
    let receipt_present = receipt.is_some();
    let installed_version = receipt.as_ref().map(|r| r.version.clone());
    let existing_exe_found = dir_path.is_dir()
        && (dir_path.join("Epilod Party.exe").is_file()
            || dir_path.join("epilod-party.exe").is_file());

    let (disposition, summary_text) = if !dir_path.is_dir()
        || (!receipt_present && !existing_exe_found)
    {
        (
            InstallDisposition::FreshInstall,
            "Destination ready · Click Verify for SHA-256 check".to_string(),
        )
    } else if let (Some(iv), Some(pv)) = (installed_version.as_deref(), package_version.as_deref())
    {
        match compare_versions(iv, pv) {
            Some(Ordering::Less) => (
                InstallDisposition::UpdateAvailable,
                format!("Existing v{iv} found · Click Verify to check upgrade to v{pv}"),
            ),
            Some(Ordering::Greater) => (
                InstallDisposition::DowngradeWarning,
                format!("Newer v{iv} already installed (package is v{pv})"),
            ),
            _ => (
                InstallDisposition::UpToDateVerified,
                format!("Existing v{iv} found · Click Verify for SHA-256 check"),
            ),
        }
    } else {
        (
            InstallDisposition::RepairNeeded,
            "Existing Epilod Party files detected · Click Verify to inspect".to_string(),
        )
    };

    Ok(ExistingInstallReport {
        install_dir: syntax_dir,
        resolved_dir: resolved_dir_str,
        disposition,
        installed_version,
        package_version,
        existing_exe_found,
        receipt_present,
        verified_intact_count: 0,
        update_count: 0,
        corrupted_count: 0,
        missing_count: 0,
        unrelated_file_count: 0,
        unrelated_count_capped: false,
        reusable_bytes: 0,
        bytes_to_write: total_package_bytes,
        total_package_bytes,
        missing_files: Vec::new(),
        corrupted_files: Vec::new(),
        modified_files: Vec::new(),
        obsolete_files: Vec::new(),
        shortcuts_recorded: receipt.as_ref().map(|r| r.shortcuts.len()).unwrap_or(0),
        summary_text,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn build_receipt(
    manifest: &PackageManifest,
    install_dir: &Path,
    shortcuts: Vec<String>,
    registry_keys: Vec<String>,
    file_associations: bool,
    desktop_shortcut: bool,
    start_menu_shortcut: bool,
    user_data_dir: Option<String>,
) -> InstallReceipt {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    InstallReceipt {
        schema_version: 1,
        app_name: APP_NAME.to_string(),
        version: manifest.version.clone(),
        installed_at_unix: now_unix,
        install_dir: install_dir.to_string_lossy().into_owned(),
        exe_relative_path: "Epilod Party.exe".to_string(),
        uninstaller_relative_path: UNINSTALLER_FILENAME.to_string(),
        managed_files: manifest
            .entries
            .iter()
            .map(|e| ManagedFileRecord {
                relative_path: e.relative_path.replace('\\', "/"),
                component: e.component,
                size: e.size,
                sha256: e.sha256.clone(),
            })
            .collect(),
        shortcuts,
        registry_keys,
        file_associations,
        desktop_shortcut,
        start_menu_shortcut,
        user_data_dir,
    }
}

/// Fallback list of relative paths owned exclusively by Epilod Party if receipt was manually deleted.
pub fn fallback_known_epilod_relative_paths() -> Vec<&'static str> {
    vec![
        "Epilod Party.exe",
        "epilod-party.exe",
        UNINSTALLER_FILENAME,
        INSTALL_RECEIPT_FILENAME,
        ".epilod-install-manifest.json.tmp",
        ".epilod-uninstall.exe.tmp",
        TX_MARKER_FILENAME,
        TX_JOURNAL_FILENAME,
        ".epilod-write-probe",
        "resources/mpv/mpv.exe",
        "resources/mpv/ffmpeg.exe",
        "resources/fonts/Inter-Regular.ttf",
        "resources/fonts/NotoSansArabic-Regular.ttf",
        "resources/licenses/GPL-3.0.txt",
        "resources/licenses/README.txt",
        "resources/licenses/SOURCE_OFFER.txt",
    ]
}

fn is_reparse_or_symlink(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

pub fn count_unrelated_files_bounded(
    root: &Path,
    managed_lower: &BTreeSet<String>,
    max_depth: usize,
    max_entries: usize,
) -> (usize, bool) {
    let mut visited = 0usize;
    let mut count = 0usize;
    let mut capped = false;
    walk_unrelated_bounded(
        root,
        root,
        managed_lower,
        0,
        max_depth,
        max_entries,
        &mut visited,
        &mut count,
        &mut capped,
    );
    (count, capped)
}

#[allow(clippy::too_many_arguments)]
fn walk_unrelated_bounded(
    root: &Path,
    dir: &Path,
    managed_lower: &BTreeSet<String>,
    depth: usize,
    max_depth: usize,
    max_entries: usize,
    visited: &mut usize,
    count: &mut usize,
    capped: &mut bool,
) {
    if depth > max_depth || *visited >= max_entries {
        if *visited >= max_entries {
            *capped = true;
        }
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *visited >= max_entries {
            *capped = true;
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == STAGING_DIR_NAME
            || name == BACKUP_DIR_NAME
            || name == UNINSTALL_TRASH_DIR_NAME
            || name.starts_with(".epilod-")
            || name.ends_with(".tmp")
        {
            continue;
        }
        *visited = visited.saturating_add(1);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if is_reparse_or_symlink(&meta) {
            continue;
        }
        if meta.is_dir() {
            if depth < max_depth {
                walk_unrelated_bounded(
                    root,
                    &path,
                    managed_lower,
                    depth + 1,
                    max_depth,
                    max_entries,
                    visited,
                    count,
                    capped,
                );
            } else {
                *capped = true;
            }
        } else if meta.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                let norm = rel
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase();
                if !managed_lower.contains(&norm) && !is_known_epilod_fallback(&norm) {
                    *count = count.saturating_add(1);
                }
            }
        }
    }
}

fn is_known_epilod_fallback(lower_rel: &str) -> bool {
    fallback_known_epilod_relative_paths()
        .into_iter()
        .any(|p| p.to_ascii_lowercase() == lower_rel)
}

pub fn collect_managed_delete_targets(
    install_dir: &Path,
    receipt: Option<&InstallReceipt>,
) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    if let Some(rec) = receipt {
        for f in &rec.managed_files {
            let norm = f.relative_path.replace('\\', "/");
            if seen.insert(norm.to_ascii_lowercase()) {
                out.push(install_dir.join(norm));
            }
        }
        for rel in [&rec.exe_relative_path, &rec.uninstaller_relative_path] {
            let norm = rel.replace('\\', "/");
            if seen.insert(norm.to_ascii_lowercase()) {
                out.push(install_dir.join(norm));
            }
        }
    } else {
        for rel in fallback_known_epilod_relative_paths() {
            if seen.insert(rel.to_ascii_lowercase()) {
                out.push(install_dir.join(rel));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::pack_directory_with_version;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("epilod_receipt_test_{tag}_{nanos}"))
    }

    #[test]
    fn inspects_fresh_verified_corrupted_upgrade_and_downgrade_states() {
        let root = unique_tmp_dir("inspect");
        let src_v1 = root.join("src_v1");
        let src_v2 = root.join("src_v2");
        let pkg_v1 = root.join("v1.epkg");
        let pkg_v2 = root.join("v2.epkg");
        let dst = root.join("Epilod Party");

        fs::create_dir_all(src_v1.join("resources/mpv")).unwrap();
        fs::write(src_v1.join("Epilod Party.exe"), b"app-v1").unwrap();
        fs::write(src_v1.join("resources/mpv/mpv.exe"), b"mpv-same").unwrap();
        let m1 = pack_directory_with_version(&src_v1, &pkg_v1, "0.1.0").unwrap();

        fs::create_dir_all(src_v2.join("resources/mpv")).unwrap();
        fs::write(src_v2.join("Epilod Party.exe"), b"app-v2-new").unwrap();
        fs::write(src_v2.join("resources/mpv/mpv.exe"), b"mpv-same").unwrap();
        let _m2 = pack_directory_with_version(&src_v2, &pkg_v2, "0.2.0").unwrap();

        // 1. Fresh install
        let rep1 = inspect_existing_install(Some(&pkg_v1), dst.to_str().unwrap()).unwrap();
        assert_eq!(rep1.disposition, InstallDisposition::FreshInstall);

        // 2. Installed & verified v1 (all files + receipt + uninstaller + 1 user note)
        fs::create_dir_all(dst.join("resources/mpv")).unwrap();
        fs::write(dst.join("Epilod Party.exe"), b"app-v1").unwrap();
        fs::write(dst.join("resources/mpv/mpv.exe"), b"mpv-same").unwrap();
        fs::write(dst.join(UNINSTALLER_FILENAME), b"uninst").unwrap();
        fs::write(dst.join("user-notes.txt"), b"keep me").unwrap();
        let rec1 = build_receipt(&m1, &dst, vec![], vec![], true, true, true, None);
        write_receipt_atomic(&dst, &rec1).unwrap();

        let rep2 = inspect_existing_install(Some(&pkg_v1), dst.to_str().unwrap()).unwrap();
        assert_eq!(rep2.disposition, InstallDisposition::UpToDateVerified);
        assert_eq!(rep2.verified_intact_count, 2);
        assert_eq!(rep2.unrelated_file_count, 1);

        // 3. Upgrade v1 -> v2 detects reusable mpv.exe and 1 file to update
        let rep_up = inspect_existing_install(Some(&pkg_v2), dst.to_str().unwrap()).unwrap();
        assert_eq!(rep_up.disposition, InstallDisposition::UpdateAvailable);
        assert_eq!(rep_up.verified_intact_count, 1);
        assert_eq!(rep_up.update_count, 1);
        assert_eq!(rep_up.modified_files, vec!["Epilod Party.exe".to_string()]);

        // 4. Corrupt 1 byte on disk -> RepairNeeded identifies corrupted file
        fs::write(dst.join("resources/mpv/mpv.exe"), b"mpv-corrupt").unwrap();
        let rep_corrupt = inspect_existing_install(Some(&pkg_v1), dst.to_str().unwrap()).unwrap();
        assert_eq!(rep_corrupt.disposition, InstallDisposition::RepairNeeded);
        assert_eq!(rep_corrupt.corrupted_count, 1);
        assert_eq!(
            rep_corrupt.corrupted_files,
            vec!["resources/mpv/mpv.exe".to_string()]
        );

        // 5. Downgrade warning when v2 receipt is on disk against v1 pkg
        let rec2 = build_receipt(&_m2, &dst, vec![], vec![], true, true, true, None);
        write_receipt_atomic(&dst, &rec2).unwrap();
        let rep_down = inspect_existing_install(Some(&pkg_v1), dst.to_str().unwrap()).unwrap();
        assert_eq!(rep_down.disposition, InstallDisposition::DowngradeWarning);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unrelated_file_scan_respects_depth_and_entry_caps() {
        let root = unique_tmp_dir("cap_scan");
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        for i in 0..10 {
            fs::write(root.join(format!("note-{i}.txt")), b"hi").unwrap();
        }
        fs::write(root.join("a/b/c/deep.txt"), b"deep").unwrap();

        let empty = BTreeSet::new();
        let (count_capped, was_capped) = count_unrelated_files_bounded(&root, &empty, 1, 5);
        assert!(was_capped);
        assert!(count_capped <= 5);

        let (count_depth, depth_capped) = count_unrelated_files_bounded(&root, &empty, 0, 100);
        assert_eq!(count_depth, 10);
        assert!(depth_capped);

        let _ = fs::remove_dir_all(&root);
    }
}
