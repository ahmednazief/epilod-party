$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $RepoRoot

try {
    Write-Host "==> Checking toolchain..."
    cargo --version
    node --version
    npm --version

    $MpvExe = Join-Path $RepoRoot "src-tauri\resources\mpv\mpv.exe"
    if (-not (Test-Path $MpvExe)) {
        Write-Host "==> mpv.exe missing; attempting fetch-mpv.ps1..."
        & (Join-Path $PSScriptRoot "fetch-mpv.ps1")
    }

    Write-Host "==> Running Rust tests and clippy..."
    cargo fmt --all -- --check
    cargo test -p epilod-core
    cargo test -p epilod-party
    cargo clippy --all-targets -- -D warnings

    Write-Host "==> Running TypeScript check, Vite build, and Node tests..."
    npm ci
    npm run build
    node --test tests/*.test.ts

    Write-Host "==> Building Windows Tauri NSIS installer..."
    npx tauri build
    Write-Host "==> Windows verification & build complete!"
}
finally {
    Pop-Location
}
