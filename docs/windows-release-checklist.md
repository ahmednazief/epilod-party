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

## 3. Run Full Windows Verification Script

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/windows-verify.ps1
```

This runs:
- `cargo fmt --all -- --check`
- `cargo test --workspace` (including `#[cfg(windows)]` modules in `src-tauri`)
- `cargo clippy --all-targets -- -D warnings`
- `npx tsc --noEmit && npm run build`
- `node --test tests/*.test.ts`
- `npx tauri build` (NSIS / MSI bundle output)

## 4. Manual End-to-End GUI Smoke Checks on Windows

1. **Embedded Video HWND & DPI:** Drag a local `.mkv` / `.mp4` into a room, verify video renders inside the dark viewport canvas, open Settings / Shortcuts modal (video hides cleanly without z-order overlap), close modal (video returns), minimize window and restore (video resizes back cleanly).
2. **Syncplay Connection & Rooms:**
   - Connect to `syncplay.pl:8999` with `STARTTLS` badge (`TLS`).
   - Verify backup `:8998` warning banner appears when switching servers.
   - Join a standard Syncplay room name via the literal toggle and verify peers match.
3. **Subtitles & Auto-Sync:**
   - Load Windows-1256 Arabic `.srt`, switch subtitle tracks (`S` shortcut), verify delay resets to `0.00s`.
   - Run **Auto-Sync Subtitles** on an offset file and verify speech alignment + `.vtt`/`.srt`/`.ass` preservation.
   - Test fullscreen toggle (`F` / double-click / `Esc`), EOF replay (`Space`), and keyboard seek coalescing (`ArrowRight` ×3).
