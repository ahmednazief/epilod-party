#[cfg(windows)]
fn main() {
    let attrs = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
    // Link Common Controls v6 via linker flags instead of resource.lib's rustc-link-arg-bins
    // so both binaries and --lib unit test harnesses resolve TaskDialogIndirect without CVT1100.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}

#[cfg(not(windows))]
fn main() {}
