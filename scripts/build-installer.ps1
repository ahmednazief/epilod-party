param(
    [switch]$SkipMpvFetch,
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $RepoRoot

try {
    Write-Host "==> Checking Windows build prerequisites..."
    cargo --version
    node --version
    npm --version

    if (-not $SkipMpvFetch) {
        $MpvExe = Join-Path $RepoRoot "src-tauri\resources\mpv\mpv.exe"
        $FfmpegExe = Join-Path $RepoRoot "src-tauri\resources\mpv\ffmpeg.exe"
        if (-not (Test-Path $MpvExe) -or -not (Test-Path $FfmpegExe)) {
            Write-Host "==> mpv.exe and/or ffmpeg.exe missing; running fetch-mpv.ps1..."
            & (Join-Path $PSScriptRoot "fetch-mpv.ps1")
        }
    }

    # Hard gate: never produce an installer that is missing something the app needs at runtime.
    $RequiredResources = @(
        "src-tauri\resources\mpv\mpv.exe",
        "src-tauri\resources\mpv\ffmpeg.exe",
        "src-tauri\resources\fonts\Inter-Regular.ttf",
        "src-tauri\resources\fonts\Inter-Bold.ttf",
        "src-tauri\resources\fonts\NotoSansArabic-Regular.ttf",
        "src-tauri\resources\fonts\NotoSansArabic-Bold.ttf",
        "src-tauri\resources\licenses\GPL-3.0.txt",
        "src-tauri\resources\licenses\SOURCE_OFFER.txt"
    )
    $MissingResources = $RequiredResources | Where-Object { -not (Test-Path (Join-Path $RepoRoot $_)) }
    if ($MissingResources) {
        throw "Refusing to build installer; required bundled files are missing:`n  $($MissingResources -join "`n  ")"
    }

    if (-not $SkipFrontendBuild) {
        Write-Host "==> Building main app and custom installer frontends..."
        if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
            npm ci
        }
        npm run build
    }

    foreach ($DistFile in @("dist\index.html", "installer\dist\index.html")) {
        if (-not (Test-Path (Join-Path $RepoRoot $DistFile))) {
            throw "Frontend build output missing: $DistFile (run npm run build)."
        }
    }

    Write-Host "==> Compiling release Epilod Party binary (frontend embedded via custom-protocol)..."
    cargo build --release -p epilod-party --features custom-protocol
    if ($LASTEXITCODE -ne 0) { throw "cargo build epilod-party failed" }

    $ReleaseDir = Join-Path $RepoRoot "target\release"
    $AppExe = Join-Path $ReleaseDir "epilod-party.exe"
    if (-not (Test-Path $AppExe)) {
        throw "Expected release binary not found at $AppExe"
    }

    $StagingDir = Join-Path $RepoRoot "target\installer-staging"
    if (Test-Path $StagingDir) {
        Remove-Item -Recurse -Force $StagingDir
    }
    New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $StagingDir "resources\mpv") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $StagingDir "resources\fonts") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $StagingDir "resources\licenses") | Out-Null

    Write-Host "==> Staging application payload..."
    Copy-Item -Path $AppExe -Destination (Join-Path $StagingDir "Epilod Party.exe") -Force

    $MpvSrc = Join-Path $RepoRoot "src-tauri\resources\mpv"
    Get-ChildItem -Path $MpvSrc -File | Where-Object { $_.Name -ne ".gitkeep" } | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $StagingDir "resources\mpv\$($_.Name)") -Force
    }

    $FontsSrc = Join-Path $RepoRoot "src-tauri\resources\fonts"
    Get-ChildItem -Path $FontsSrc -File | Where-Object { $_.Name -ne ".gitkeep" } | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $StagingDir "resources\fonts\$($_.Name)") -Force
    }

    $LicensesSrc = Join-Path $RepoRoot "src-tauri\resources\licenses"
    Get-ChildItem -Path $LicensesSrc -File | Where-Object { $_.Name -ne ".gitkeep" } | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $StagingDir "resources\licenses\$($_.Name)") -Force
    }

    $TauriConfPath = Join-Path $RepoRoot "src-tauri\tauri.conf.json"
    $AppVersion = (Get-Content -Path $TauriConfPath -Raw | ConvertFrom-Json).version
    if (-not $AppVersion) {
        $AppVersion = "0.1.0"
    }

    $PayloadOut = Join-Path $RepoRoot "src-installer\resources\payload\epilod-payload.epkg"
    Write-Host "==> Packing SHA-256 verified payload archive (v$AppVersion)..."
    cargo run --release -p epilod-installer-core --bin epilod-pack -- $StagingDir $PayloadOut --version $AppVersion

    Write-Host "==> Compiling custom Windows setup GUI (epilod-setup.exe)..."
    cargo build --release -p epilod-setup --features custom-protocol
    if ($LASTEXITCODE -ne 0) { throw "cargo build epilod-setup failed" }

    $SetupStub = Join-Path $ReleaseDir "epilod-setup.exe"
    if (-not (Test-Path $SetupStub)) {
        throw "Expected installer binary not found at $SetupStub"
    }

    $FinalSetupExe = Join-Path $ReleaseDir "Epilod Party Setup.exe"
    Write-Host "==> Attaching standalone SFX payload overlay..."
    cargo run --release -p epilod-installer-core --bin epilod-pack -- --attach-sfx $SetupStub $PayloadOut $FinalSetupExe

    $ManifestOut = Join-Path $ReleaseDir "epilod-update-manifest.json"
    $ReleaseAssetUrl = "https://github.com/ahmednazief/epilod-party/releases/download/v$AppVersion/Epilod.Party.Setup.exe"
    Write-Host "==> Generating verified release update manifest..."
    cargo run --release -p epilod-installer-core --bin epilod-pack -- --write-update-manifest $FinalSetupExe $AppVersion $ReleaseAssetUrl $ManifestOut

    $SizeMb = [Math]::Round(((Get-Item $FinalSetupExe).Length / 1MB), 2)
    Write-Host "==> Built standalone custom Windows installer: $FinalSetupExe ($SizeMb MB)"
    Write-Host "==> Generated release update manifest: $ManifestOut"
}
finally {
    Pop-Location
}
