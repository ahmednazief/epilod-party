$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $RepoRoot

try {
    Write-Host "==> Checking toolchain..."
    cargo --version
    node --version
    npm --version

    $MpvExe = Join-Path $RepoRoot "src-tauri\resources\mpv\mpv.exe"
    $FfmpegExe = Join-Path $RepoRoot "src-tauri\resources\mpv\ffmpeg.exe"
    if (-not (Test-Path $MpvExe) -or -not (Test-Path $FfmpegExe)) {
        Write-Host "==> mpv.exe and/or ffmpeg.exe missing; attempting fetch-mpv.ps1..."
        & (Join-Path $PSScriptRoot "fetch-mpv.ps1")
    }

    Write-Host "==> Running Rust tests and clippy..."
    cargo fmt --all -- --check
    cargo test --workspace
    cargo clippy --all-targets -- -D warnings

    Write-Host "==> Running TypeScript check, Vite builds, and Node tests..."
    npm ci
    npm run build
    node --test tests/*.test.ts

    Write-Host "==> Building custom standalone Windows installer (Epilod Party Setup.exe)..."
    & (Join-Path $PSScriptRoot "build-installer.ps1") -SkipFrontendBuild
    Write-Host "==> Windows verification & custom installer build complete!"
}
finally {
    Pop-Location
}
