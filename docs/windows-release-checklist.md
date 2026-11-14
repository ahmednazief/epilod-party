# Windows Build & Release Verification Checklist

Because this repository is authored with native Win32 (`HWND` embedding, named pipes, `tokio-native-tls` Schannel, `mpv.exe`, `ffmpeg.exe`), final binary packaging and native GUI checks must be run on a Windows 10/11 host.

## 1. Prerequisites on Windows

- **Rust MSVC toolchain** (`stable-x86_64-pc-windows-msvc`)
- **Node.js 22+ LTS** (`npm ci`)
- **Microsoft Edge WebView2 Runtime** (preinstalled on Windows 10/11)
- **Visual Studio Build Tools** (Desktop development with C++)
- **7-Zip** (`7z` on `PATH` or installed at `C:\Program Files\7-Zip\7z.exe`) for extracting `mpv.exe` archives

## 2. Fetch Pinned Media Engine Binaries (`mpv.exe` & `ffmpeg.exe`)

Run from repository root in PowerShell:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1
```

Confirm:
- `src-tauri/resources/mpv/mpv.exe` exists and matches SHA-256 pinned in `scripts/mpv.lock`.
- `src-tauri/resources/mpv/ffmpeg.exe` exists if you require embedded MKV subtitle/audio extraction fallback.
- `src-tauri/resources/licenses/GPL-3.0.txt` and `SOURCE_OFFER.txt` are bundled alongside the binaries.

## 3. Run Full Windows Verification & Custom Installer Build

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/windows-verify.ps1
```

Or build the standalone custom installer directly after fetching `mpv.exe`:

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/build-installer.ps1
```

This runs:
- `cargo fmt --all -- --check`
- `cargo test --workspace` (including `epilod-core`, `epilod-installer-core`, and `#[cfg(windows)]` modules in `src-tauri`)
- `cargo clippy --all-targets -- -D warnings`
- `tsc --noEmit && vite build && npm run installer:build`
- `node --test tests/*.test.ts`
- `scripts/build-installer.ps1`: packs `epilod-payload.epkg` with version + SHA-256 digests and outputs `target/release/Epilod Party Setup.exe` alongside `target/release/epilod-update-manifest.json`

## 4. Manual End-to-End GUI Smoke Checks on Windows

1. **Custom Installer (`Epilod Party Setup.exe`):**
   - Launch `Epilod Party Setup.exe`, drag window via header pill, toggle tabs (**Install location**, **Setup progress**, **Install options**), browse/verify `%LocalAppData%\Epilod Party` space check, run install, confirm monotonic live status updates (`mpv.exe`, `ffmpeg.exe`, fonts, STARTTLS, shortcuts), and click **Launch Epilod Party**.
   - **Authenticode-signed SFX & payload precedence:** Sign `Epilod Party Setup.exe` with `signtool.exe` (`WIN_CERTIFICATE` appended after EOF), place a stale `epilod-payload.epkg` next to the signed binary, launch it, and verify Setup reads its own embedded signed SFX payload and preserves the signature on installed `epilod-uninstall.exe`.
   - **Single-instance & protected directory checks:** Double-click `Epilod Party Setup.exe` twice concurrently and confirm the second instance reports the active setup dialog instead of corrupting `.epilod-staging`; type `C:\Program Files\Epilod Party` in **Install location** and confirm non-destructive UAC guidance appears without touching disk.
   - **Silent CLI modes:** Verify headless `--install --silent`, `--repair --silent`, `--update --silent`, and `--uninstall --silent` (`--uninstall /S`) all return exit code `0` cleanly.
   - Re-launch `Epilod Party Setup.exe` on an existing install: confirm SHA-256 pre-install verification reports `Epilod Party v... verified`, delete or corrupt a bundled asset and confirm **Repair Epilod Party** restores only missing/corrupted files cleanly while preserving unrelated files in the destination folder.
   - Launch setup while `Epilod Party.exe` (`msedgewebview2.exe` / `mpv.exe` child processes) is running from the install directory and verify the **Close & Retry** prompt closes both the app and its descendant WebView2/mpv processes cleanly before swapping binaries.
2. **Scoped Uninstaller (`epilod-uninstall.exe` & Apps & Features):**
   - Verify Start Menu / Desktop shortcuts (including OneDrive Known Folder Move paths), HKCU uninstall registration (`HKCU\...\Uninstall\EpilodParty`), and optional **Open with** registration work without UAC elevation.
   - Run uninstall from **Apps & Features** (both interactive UI and `--silent` quiet uninstall) AND flagless double-click (`epilod-uninstall.exe` from another working directory): confirm files are removed *before* registry/shortcuts, unrelated user files inside the folder stay untouched, all shortcuts and HKCU registry keys are removed, and `epilod-uninstall.exe` + `epilod-install-manifest.json` self-clean (with `RunOnce` fallback if AV temporarily locks the binary).
3. **In-App Updater Flow (`Settings -> Updates`):**
   - Open **Settings -> Updates**, run **Check for Updates**, start download and verify pause/resume preserves partial `.exe.part` progress, verify SHA-256 + SFX payload check passes, and click **Restart & Update** to confirm clean mpv/Syncplay shutdown, atomic upgrade, shortcut/Open With preference preservation, and automatic relaunch.
4. **Embedded Video HWND & DPI:** Drag a local `.mkv` / `.mp4` into a room, verify video renders inside the dark viewport canvas, open Settings / Shortcuts modal (video hides cleanly without z-order overlap), close modal (video returns), minimize window and restore (video resizes back cleanly).
5. **Syncplay Connection & Rooms:**
   - Connect to `syncplay.pl:8999` with `STARTTLS` badge (`TLS`).
   - Verify backup `:8998` warning banner appears when switching servers.
   - Join a standard Syncplay room name via the literal toggle and verify peers match.
6. **Subtitles & Auto-Sync:**
   - Load Windows-1256 Arabic `.srt`, switch subtitle tracks (`S` shortcut), verify delay resets to `0.00s`.
   - Run **Auto-Sync Subtitles** on an offset file and verify speech alignment + `.vtt`/`.srt`/`.ass` preservation.
   - Test fullscreen toggle (`F` / double-click / `Esc`), EOF replay (`Space`), and keyboard seek coalescing (`ArrowRight` ×3).
