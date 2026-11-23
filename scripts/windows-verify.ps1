$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $RepoRoot

try {
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue) -and (Test-Path "C:\Program Files\CMake\bin\cmake.exe")) {
        $env:PATH = "C:\Program Files\CMake\bin;$env:PATH"
    }
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
    if ($LASTEXITCODE -ne 0) { throw "cargo fmt --check failed" }
    cargo test --workspace
    if ($LASTEXITCODE -ne 0) { throw "cargo test --workspace failed" }
    cargo clippy --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "cargo clippy failed" }

    Write-Host "==> Running TypeScript check, Vite builds, and Node tests..."
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    node --test tests/*.test.ts
    if ($LASTEXITCODE -ne 0) { throw "node --test failed" }

    Write-Host "==> Building custom standalone Windows installer (Epilod Party Setup.exe)..."
    & (Join-Path $PSScriptRoot "build-installer.ps1") -SkipFrontendBuild
    Write-Host "==> Windows verification & custom installer build complete!"
}
finally {
    Pop-Location
}
