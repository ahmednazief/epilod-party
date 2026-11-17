---
name: release-update
description: Stamp a new Epilod Party version in lockstep across all manifests, build the standalone Windows installer (with bundled mpv, ffmpeg, fonts, and licenses) and update manifest, and upload the release assets to GitHub Releases.
---

# Epilod Party Release & Auto-Update Skill

Use this skill whenever the user invokes `/release-update` (e.g. `/release-update 0.1.1`, `/release-update patch`, or `/release-update`) or asks to bump the version, build a new standalone Windows installer, and publish an app update.

## Bundled Scripts

- [`scripts/stamp-version.ps1`](scripts/stamp-version.ps1) — Stamps or verifies the version in lockstep across all 7 source manifests plus `package-lock.json` and `Cargo.lock`.
- [`scripts/publish-release.ps1`](scripts/publish-release.ps1) — Runs preflight checks, stamps version, runs tests, invokes `scripts/build-installer.ps1`, verifies SHA-256 and manifest parity, commits/tags/pushes `v<Version>`, uploads `Epilod.Party.Setup.exe` and `epilod-update-manifest.json` to GitHub Releases (`ahmednazief/epilod-party`), and verifies live updater URLs.
- [`scripts/common.ps1`](scripts/common.ps1) — Shared semver, lockstep inventory, UTF-8 no-BOM, and PowerShell 5.1+ native execution helpers.

---

## Execution Workflow

Follow these steps sequentially whenever this skill is triggered:

### Step 1: Inspect Current Version & Changes

Run a quick read-only check before editing anything:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agents\skills\release-update\scripts\stamp-version.ps1 -CheckOnly
git status -s
git log -n 10 --oneline
```

1. **Determine Target Version**:
   - If the user passed a version (`0.1.2`, `v0.1.2`, `1.0.0-rc.1`) or bump keyword (`patch`, `minor`, `major`), use it.
   - If not specified, ask the user once (suggesting the next `patch` and `minor` versions based on `src-tauri/tauri.conf.json` and recent commits) before modifying files.
2. **Draft User-Friendly Release Notes**:
   - If the user supplied custom notes, lightly polish them into the format below while keeping their exact meaning; otherwise summarize the changes since the previous release tag (`git log <last-tag>..HEAD --oneline`, or recent commits if no tag exists).
   - **Follow these strict writing rules** (these notes are shown directly to everyday viewers inside **Settings -> Updates** and on GitHub Releases):
     - **Plain everyday language (zero technical jargon):** Translate internal/engineering changes into what the viewer actually feels or notices. Never include file names, code/symbol names, CSS classes, library/crate names, IPC details, or commit hashes.
       - *Bad (too technical):* `Coalesce mpv IPC seeks, fix SyncStateMachine offset reset, and refine .ep-glass-seek-bubble CSS.`
       - *Good (user-friendly):* `- **Smoother Video Skipping**: Jumping ahead or back lands cleanly on the right frame without glitches.`
     - **Bold points & concise bullets (3–5 bullets max):** Keep each point short and scannable in under 3 seconds — never dump walls of text or commit logs.
     - **Exact format:** One bullet per line using `- **Short Title**: One clear sentence.`:
       ```markdown
       - **Smoother Skipping**: Jumping through a video lands cleanly without glitches.
       - **Clearer Seek Bubble**: Skipping shows a clearer liquid-glass bubble with smooth animations.
       - **Refined Menu Polish**: Cleaner captions options, steadier party pills, and character cards.
       ```
   - Write the drafted notes to a temporary UTF-8 `.md` file and pass `-NotesFile <path>` (or `-Notes`) to `publish-release.ps1` so multi-line bold bullets are preserved identically in both GitHub Releases and `epilod-update-manifest.json`.

---

### Step 2: Run Preflight Checks (Fail Fast)

Run preflight BEFORE stamping any version files or running a long Release build:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agents\skills\release-update\scripts\publish-release.ps1 -Version <TargetVersion> -PreflightOnly
```

Verify every preflight result:
- **GitHub Upload Credentials**: Requires either authenticated GitHub CLI (`gh auth status`) OR `$env:GH_TOKEN` / `$env:GITHUB_TOKEN` (with `repo` / `contents:write` scope on `ahmednazief/epilod-party`).
  - If missing and the user wants a live upload, stop immediately and give the exact setup commands (`winget install GitHub.cli` + `gh auth login`, or `$env:GH_TOKEN = "<token>"`), or ask if they want a local build only (`-SkipUpload`).
- **Signing Consistency**:
  - Remember `crates/epilod-core/src/updater.rs` embeds `$env:EPILOD_UPDATE_PUBKEY` at compile time, and `epilod-pack` reads `$env:EPILOD_SIGNING_PRIVATE_KEY` (or `-SigningKey`) when generating `epilod-update-manifest.json`.
  - If `EPILOD_UPDATE_PUBKEY` is set, ensure `EPILOD_SIGNING_PRIVATE_KEY` or `-SigningKey` is also provided so installed apps will accept the manifest signature.
- **Working Tree Hygiene**:
  - If non-version files have uncommitted changes in `git status -s`, ask the user before releasing whether to:
    1. Commit those working changes first (recommended so git tag `v<TargetVersion>` matches the built installer binaries),
    2. Include all dirty changes in the release commit (`-IncludeAllDirtyChanges`), or
    3. Build locally without publishing (`-SkipUpload`).

---

### Step 3: Version Stamping Map (Handled by `stamp-version.ps1`)

Never hand-edit only one file. `stamp-version.ps1` keeps all of these in lockstep:

| File | Why It Must Be Stamped |
| :--- | :--- |
| `crates/epilod-core/Cargo.toml` | Sets `CURRENT_APP_VERSION = env!("CARGO_PKG_VERSION")` used by the runtime updater |
| `crates/epilod-installer-core/Cargo.toml` | Sets `APP_VERSION = env!("CARGO_PKG_VERSION")` inside installer engine & setup UI |
| `src-tauri/Cargo.toml` | Main Tauri app crate version |
| `src-tauri/tauri.conf.json` | Tauri bundle metadata & primary `$AppVersion` read by `scripts/build-installer.ps1` |
| `src-installer/Cargo.toml` | Setup executable crate version |
| `src-installer/tauri.conf.json` | Setup Tauri bundle metadata |
| `package.json` & `package-lock.json` | Frontend package & lockfile root versions |
| `Cargo.lock` | Refreshed via `cargo update -w --offline` |

**Intentionally untouched:** Preview/test mock fallbacks (`"0.1.0"` in `src/lib/updater.ts`, `tests/updaterUi.test.ts`, and `installer/src/lib/installerBridge.ts`), so unit tests continue passing.

---

### Step 4: Build Installer, Pack Components, Tag, and Publish

Once preflight passes and git state/notes are confirmed, run the full release script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.agents\skills\release-update\scripts\publish-release.ps1 `
  -Version <TargetVersion> `
  -NotesFile "<ReleaseNotesMdPath>" `
  -CommitAndTag
```

What this executes automatically:
1. Stamps `<TargetVersion>` across all version files and lockfiles via `stamp-version.ps1`.
2. Runs `cargo test --workspace` and `node --test` over `tests/*.test.ts` (pass `-SkipTests` only if already verified on the same code).
3. Runs `scripts/build-installer.ps1`:
   - Ensures `mpv.exe`, `ffmpeg.exe`, licenses, and fonts via `fetch-mpv.ps1`.
   - Builds frontend (`npm run build`).
   - Builds `epilod-party` (`--release --features custom-protocol`).
   - Packs payload archive (`epilod-payload.epkg`) with `--version <TargetVersion>`.
   - Builds `epilod-setup` (`--release --features custom-protocol`) and attaches SFX payload -> `target/release/Epilod Party Setup.exe`.
   - Generates `target/release/epilod-update-manifest.json` (`--write-update-manifest`), updating custom notes and Ed25519 signature when configured.
4. Verifies SHA-256 hash, byte size, `version`, `fileName`, and `downloadUrl` (`https://github.com/ahmednazief/epilod-party/releases/download/v<TargetVersion>/Epilod.Party.Setup.exe`).
5. Commits the release bump, tags `v<TargetVersion>`, and pushes branch + tag to `origin`.
6. Uploads **both** release assets as a **published** (non-draft, non-prerelease) GitHub Release on `ahmednazief/epilod-party`:
   - `Epilod.Party.Setup.exe` (uploaded from `target/release/Epilod Party Setup.exe` — dots replace spaces to match `downloadUrl`)
   - `epilod-update-manifest.json` (uploaded from `target/release/epilod-update-manifest.json`)
7. Verifies live public endpoints:
   - Fetches `https://github.com/ahmednazief/epilod-party/releases/latest/download/epilod-update-manifest.json` and verifies version & SHA-256.
   - Sends HTTP `HEAD` to `downloadUrl` and confirms HTTP `200` + matching `Content-Length`.

### Useful Flags for Edge Cases

- `-SkipBuild`: Reuse already-built `target/release/Epilod Party Setup.exe` and `epilod-update-manifest.json` (still enforces exact version/SHA-256 verification) to retry only upload.
- `-OverwriteRelease`: Replace assets/notes on an already-published `v<TargetVersion>` release.
- `-SigningKey <hex-or-file>`: Set `EPILOD_SIGNING_PRIVATE_KEY` for manifest signing during this release.
- `-SkipUpload`: Stamp, test, build, and verify local release artifacts without pushing or uploading.

---

### Step 5: Report Outcome

Summarize concisely with:
- Version stamped (`v<Old>` -> `v<New>`) and git commit/tag pushed
- Built installer size & SHA-256 (`target/release/Epilod Party Setup.exe`)
- GitHub Release link (`https://github.com/ahmednazief/epilod-party/releases/tag/v<New>`)
- Confirmation that `releases/latest/download/epilod-update-manifest.json` and `Epilod.Party.Setup.exe` `HEAD` checks succeeded (plus whether the manifest was Ed25519-signed or unsigned).
