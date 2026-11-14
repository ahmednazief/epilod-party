use epilod_core::ed25519::{decode_hex_fixed, ed25519_sign, encode_hex};
use epilod_core::updater::{manifest_signing_message, ReleaseManifest};
use epilod_installer_core::archive::{attach_payload_sfx, hash_file, pack_directory_with_version};
use epilod_installer_core::plan::APP_VERSION;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

fn format_utc_date_approx() -> String {
    // Simple ISO date format based on Unix seconds without needing extra chrono dependency
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

fn load_signing_seed(raw_or_path: &str) -> Result<[u8; 32], String> {
    let candidate = raw_or_path.trim();
    if let Ok(seed) = decode_hex_fixed::<32>(candidate) {
        return Ok(seed);
    }
    let path = PathBuf::from(candidate);
    if path.is_file() {
        let contents =
            fs::read_to_string(&path).map_err(|e| format!("Failed reading key file: {e}"))?;
        return decode_hex_fixed::<32>(contents.trim()).map_err(|e| {
            format!(
                "Invalid 64-hex-char Ed25519 seed in {}: {e}",
                path.display()
            )
        });
    }
    Err(
        "Signing key must be a 64-hex-char Ed25519 private seed or a path to a file containing one"
            .into(),
    )
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() == 5 && args[1] == "--attach-sfx" {
        let base_exe = PathBuf::from(&args[2]);
        let archive = PathBuf::from(&args[3]);
        let out_exe = PathBuf::from(&args[4]);

        match attach_payload_sfx(&base_exe, &archive, &out_exe) {
            Ok(bytes) => {
                println!(
                    "Embedded payload overlay ({} bytes total) into standalone setup {}",
                    bytes,
                    out_exe.display()
                );
                return;
            }
            Err(err) => {
                eprintln!("Failed to attach SFX payload overlay: {err}");
                process::exit(1);
            }
        }
    }

    if args.len() >= 6 && args[1] == "--write-update-manifest" {
        let setup_exe = PathBuf::from(&args[2]);
        let version = args[3].trim().trim_start_matches(['v', 'V']).to_string();
        let download_url = args[4].clone();
        let out_json = PathBuf::from(&args[5]);

        let mut notes: Option<String> = None;
        let mut sign_key_arg: Option<String> = None;
        let mut idx = 6;
        while idx < args.len() {
            if args[idx] == "--sign-key" {
                let Some(val) = args.get(idx + 1) else {
                    eprintln!("--sign-key requires a 64-hex-char seed or key file path");
                    process::exit(2);
                };
                sign_key_arg = Some(val.clone());
                idx += 2;
            } else if notes.is_none() {
                notes = Some(args[idx].clone());
                idx += 1;
            } else {
                eprintln!("Unexpected extra argument: {}", args[idx]);
                process::exit(2);
            }
        }
        let notes = notes.unwrap_or_else(|| format!("Epilod Party v{version} Windows release"));

        let signing_input = sign_key_arg.or_else(|| {
            env::var("EPILOD_SIGNING_PRIVATE_KEY")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });

        match hash_file(&setup_exe) {
            Ok((size_bytes, sha256)) => {
                let file_name = setup_exe
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Epilod Party Setup.exe")
                    .to_string();
                let mut manifest = ReleaseManifest {
                    version,
                    released_at: format_utc_date_approx(),
                    notes,
                    download_url,
                    sha256,
                    size_bytes,
                    min_supported_version: Some("0.1.0".to_string()),
                    file_name: Some(file_name),
                    signature: None,
                };
                if let Some(key_spec) = signing_input {
                    match load_signing_seed(&key_spec) {
                        Ok(seed) => {
                            let msg = manifest_signing_message(&manifest);
                            let (pubkey, sig) = ed25519_sign(&seed, &msg);
                            manifest.signature = Some(encode_hex(&sig));
                            println!(
                                "Signed update manifest with Ed25519 public key: {}",
                                encode_hex(&pubkey)
                            );
                        }
                        Err(err) => {
                            eprintln!("Failed loading signing key: {err}");
                            process::exit(1);
                        }
                    }
                }
                match serde_json::to_vec_pretty(&manifest) {
                    Ok(bytes) => {
                        if let Err(err) = fs::write(&out_json, bytes) {
                            eprintln!(
                                "Failed writing update manifest {}: {err}",
                                out_json.display()
                            );
                            process::exit(1);
                        }
                        println!(
                            "Generated update manifest {} (sha256: {}, {} bytes{})",
                            out_json.display(),
                            manifest.sha256,
                            manifest.size_bytes,
                            if manifest.signature.is_some() {
                                ", signed"
                            } else {
                                ""
                            }
                        );
                        return;
                    }
                    Err(err) => {
                        eprintln!("Failed serializing update manifest: {err}");
                        process::exit(1);
                    }
                }
            }
            Err(err) => {
                eprintln!("Failed hashing setup exe {}: {err}", setup_exe.display());
                process::exit(1);
            }
        }
    }

    // Standard pack usage:
    //   epilod-pack <source-staging-dir> <output-epkg-path> [--version <ver>]
    if args.len() != 3 && !(args.len() == 5 && args[3] == "--version") {
        eprintln!(
            "Usage:\n  epilod-pack <source-staging-dir> <output-epkg-path> [--version <ver>]\n  epilod-pack --attach-sfx <base-exe> <archive.epkg> <out-setup-exe>\n  epilod-pack --write-update-manifest <setup-exe> <version> <download-url> <out-json> [notes] [--sign-key <hex-or-file>]"
        );
        process::exit(2);
    }

    let source_dir = PathBuf::from(&args[1]);
    let out_archive = PathBuf::from(&args[2]);
    let version = if args.len() == 5 {
        args[4].trim().trim_start_matches(['v', 'V'])
    } else {
        APP_VERSION
    };

    match pack_directory_with_version(&source_dir, &out_archive, version) {
        Ok(manifest) => {
            println!(
                "Packed {} verified files ({} bytes, v{}) into {}",
                manifest.entries.len(),
                manifest.total_bytes,
                manifest.version,
                out_archive.display()
            );
        }
        Err(err) => {
            eprintln!("Failed to pack installer payload: {err}");
            process::exit(1);
        }
    }
}
