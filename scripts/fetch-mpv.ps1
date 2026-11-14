param(
    [string]$Url,
    [string]$Sha256
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$MpvDir = Join-Path $RepoRoot "src-tauri\resources\mpv"
$LockPath = Join-Path $PSScriptRoot "mpv.lock"

New-Item -ItemType Directory -Force -Path $MpvDir | Out-Null
$TargetExe = Join-Path $MpvDir "mpv.exe"

if (Test-Path $TargetExe) {
    Write-Host "mpv.exe already present at $TargetExe"
    exit 0
}

$lock = Get-Content $LockPath -Raw | ConvertFrom-Json
if (-not $Url) { $Url = $lock.mpv.url }
if (-not $Sha256) { $Sha256 = $lock.mpv.sha256 }

if (-not $Url -or $Url -notmatch "\.7z$" -or -not $Sha256 -or $Sha256 -like "REPLACE_*") {
    Write-Error "Update scripts/mpv.lock with a direct shinchiro/mpv-winbuild-cmake .7z release URL and verified SHA-256 hash, or pass -Url and -Sha256."
    exit 1
}

$TmpArchive = Join-Path $env:TEMP "epilod-mpv.7z"
$TmpExtract = Join-Path $env:TEMP "epilod-mpv-extract"
if (Test-Path $TmpExtract) { Remove-Item -Recurse -Force $TmpExtract }

Write-Host "Downloading mpv archive..."
Invoke-WebRequest -Uri $Url -OutFile $TmpArchive

$actualHash = (Get-FileHash -Path $TmpArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $Sha256.ToLowerInvariant()) {
    Remove-Item -Force $TmpArchive
    throw "SHA-256 mismatch! Expected $Sha256, got $actualHash"
}

$7z = Get-Command 7z -ErrorAction SilentlyContinue
if (-not $7z) {
    $fallback7z = "C:\Program Files\7-Zip\7z.exe"
    if (Test-Path $fallback7z) { $7z = $fallback7z }
}
if (-not $7z) {
    throw "7z.exe is required to extract $TmpArchive"
}

& $7z x $TmpArchive "-o$TmpExtract" -y | Out-Null
$foundMpv = Get-ChildItem -Path $TmpExtract -Filter "mpv.exe" -Recurse | Select-Object -First 1
if (-not $foundMpv) {
    throw "mpv.exe not found inside archive"
}

Copy-Item -Path $foundMpv.FullName -Destination $TargetExe -Force
$foundFfmpeg = Get-ChildItem -Path $TmpExtract -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
if ($foundFfmpeg) {
    Copy-Item -Path $foundFfmpeg.FullName -Destination (Join-Path $MpvDir "ffmpeg.exe") -Force
}

Remove-Item -Force $TmpArchive
Remove-Item -Recurse -Force $TmpExtract
Write-Host "Verified and installed mpv.exe to $TargetExe"
