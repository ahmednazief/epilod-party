param(
    [string]$Url,
    [string]$Sha256,
    [string]$FfmpegUrl,
    [string]$FfmpegSha256
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$MpvDir = Join-Path $RepoRoot "src-tauri\resources\mpv"
$LockPath = Join-Path $PSScriptRoot "mpv.lock"

New-Item -ItemType Directory -Force -Path $MpvDir | Out-Null
$TargetMpv = Join-Path $MpvDir "mpv.exe"
$TargetFfmpeg = Join-Path $MpvDir "ffmpeg.exe"

if ((Test-Path $TargetMpv) -and (Test-Path $TargetFfmpeg)) {
    Write-Host "mpv.exe and ffmpeg.exe already present in $MpvDir"
    exit 0
}

$lock = Get-Content $LockPath -Raw | ConvertFrom-Json
if (-not $Url) { $Url = $lock.mpv.url }
if (-not $Sha256) { $Sha256 = $lock.mpv.sha256 }
if (-not $FfmpegUrl) { $FfmpegUrl = $lock.ffmpeg.url }
if (-not $FfmpegSha256) { $FfmpegSha256 = $lock.ffmpeg.sha256 }

function Get-7zExe {
    $cmd = Get-Command 7z -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($fallback in @("C:\Program Files\7-Zip\7z.exe", "C:\Program Files (x86)\7-Zip\7z.exe")) {
        if (Test-Path $fallback) { return $fallback }
    }
    throw "7z.exe is required to extract the mpv/ffmpeg archives (install 7-Zip)."
}

# Downloads a .7z, verifies its SHA-256, extracts it and copies the named exe into resources/mpv.
function Install-VerifiedExe {
    param(
        [string]$Label,
        [string]$ArchiveUrl,
        [string]$ExpectedSha256,
        [string]$ExeName,
        [string]$Destination
    )

    if (-not $ArchiveUrl -or $ArchiveUrl -notmatch "\.7z$" -or -not $ExpectedSha256 -or $ExpectedSha256 -like "REPLACE_*") {
        throw "Update scripts/mpv.lock with a direct $Label .7z release URL and verified SHA-256 hash, or pass the matching -Url/-Sha256 parameters."
    }

    $tmpArchive = Join-Path $env:TEMP "epilod-$Label.7z"
    $tmpExtract = Join-Path $env:TEMP "epilod-$Label-extract"
    if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }

    Write-Host "Downloading $Label archive..."
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $tmpArchive

    $actualHash = (Get-FileHash -Path $tmpArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) {
        Remove-Item -Force $tmpArchive
        throw "$Label SHA-256 mismatch! Expected $ExpectedSha256, got $actualHash"
    }

    & (Get-7zExe) x $tmpArchive "-o$tmpExtract" -y | Out-Null
    $found = Get-ChildItem -Path $tmpExtract -Filter $ExeName -Recurse | Select-Object -First 1
    if (-not $found) {
        throw "$ExeName not found inside the $Label archive"
    }

    Copy-Item -Path $found.FullName -Destination $Destination -Force
    Remove-Item -Force $tmpArchive
    Remove-Item -Recurse -Force $tmpExtract
    Write-Host "Verified and installed $ExeName to $Destination"
}

if (-not (Test-Path $TargetMpv)) {
    Install-VerifiedExe -Label "mpv" -ArchiveUrl $Url -ExpectedSha256 $Sha256 -ExeName "mpv.exe" -Destination $TargetMpv
}

# ffmpeg.exe is published as a separate upstream archive. It is required to auto-sync against
# subtitle tracks embedded inside MKV files and as an audio-extraction fallback.
if (-not (Test-Path $TargetFfmpeg)) {
    Install-VerifiedExe -Label "ffmpeg" -ArchiveUrl $FfmpegUrl -ExpectedSha256 $FfmpegSha256 -ExeName "ffmpeg.exe" -Destination $TargetFfmpeg
}
