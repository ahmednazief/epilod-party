# Epilod Party

Synchronized local watch-party desktop application for Windows 10/11 built with **Tauri 2**, **React 19 / TypeScript / Tailwind v4**, **mpv** (child `HWND` + JSON IPC), and the **Syncplay** protocol (including `STARTTLS`).

## Key Capabilities

- **Zero-upload synchronized watch rooms:** Connect over Syncplay (`syncplay.pl:8999`, backup `:8998`, or custom servers) using either Epilod room codes (`XXXX-XXXX-XXXX`), literal Syncplay room names, and optional RAM-only session passwords, with pinned recent rooms, per-member drift indicators, and optional auto-start when all ready.
- **Native mpv playback engine:** Crisp embedded Windows child `HWND` playback with DPI-aware resize tracking, minimize/restore recovery, always-on-top & mini mode (`480×270`), global playback shortcuts, local playback resume, watched episode tracking & series continuation, clean EOF replay, keyboard shortcuts (`e.code` layout-independent), and native file drag-and-drop.
- **Arabic & multi-language subtitle tooling:** Automatic `UTF-8` / `Windows-1256` / `Windows-1252` / `Windows-1251` decoding, RTL punctuation wrapping for Arabic SRT/VTT, ASS override control, dual subtitles (`secondary-sid`), per-file subtitle delay memory, clean track-switch delay resets, and speech-envelope **Auto-Sync** (plus 2-point manual calibration fallback).
- **26 reliability hardening guards** across connection lifecycle, TLS framing, readiness/speed locking, managed controller rooms, subtitle extraction watchdogs, and WebView hardening.

## Repository Layout

- `crates/epilod-core/` — Pure Rust core library (Syncplay wire codec, `STARTTLS` state machine, room hashing, file matching, mpv JSON IPC builder, subtitle parser/rescaler/auto-aligner, rate limiter, diagnostics logger, validation).
- `src-tauri/` — Tauri 2 desktop shell, Windows child `HWND` host, mpv IPC manager, async Syncplay client, ffmpeg/mpv subtitle auto-sync runner.
- `src/` — React 19 + TypeScript + Tailwind v4 UI (`HomeScreen`, `WatchRoom`, `TransportBar`, `RoomPanel`, `PlaybackPanel`, `SubtitlePanel`, `SettingsModal`, `ShortcutsModal`).
- `scripts/` — Windows helper scripts (`fetch-mpv.ps1`, `mpv.lock`, `windows-verify.ps1`).
- `docs/` — Release and Windows verification checklists ([`windows-release-checklist.md`](docs/windows-release-checklist.md)).

## Development & Verification

### Cross-platform / Linux checks
```bash
cargo fmt --all -- --check
cargo test -p epilod-core
cargo test -p epilod-party
cargo clippy --all-targets -- -D warnings
npx tsc --noEmit
npm run build
```

### Windows desktop build
See [`docs/windows-release-checklist.md`](docs/windows-release-checklist.md) for fetching `mpv.exe` + `ffmpeg.exe` and running the Windows NSIS build (`npx tauri build`).

## License

GPL-3.0-or-later — see [`LICENSE`](LICENSE) and [`src-tauri/resources/licenses/SOURCE_OFFER.txt`](src-tauri/resources/licenses/SOURCE_OFFER.txt).
