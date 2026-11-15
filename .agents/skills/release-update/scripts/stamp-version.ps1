<#
.SYNOPSIS
Stamps a new version in lockstep across every version source in Epilod Party.

.DESCRIPTION
Updates:
- crates/epilod-core/Cargo.toml (sets CURRENT_APP_VERSION in the app)
- crates/epilod-installer-core/Cargo.toml (sets APP_VERSION in installer)
- src-tauri/Cargo.toml
- src-installer/Cargo.toml
- src-tauri/tauri.conf.json (read by scripts/build-installer.ps1)
- src-installer/tauri.conf.json
- package.json
- package-lock.json (root & packages."")
- Cargo.lock (workspace packages via cargo update -w --offline)

Intentionally leaves UI mock fallbacks/tests (src/lib/updater.ts, tests/updaterUi.test.ts) untouched.

.EXAMPLE
.\stamp-version.ps1 0.1.1

.EXAMPLE
.\stamp-version.ps1 patch -WhatIf

.EXAMPLE
.\stamp-version.ps1 -CheckOnly
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Position = 0)]
    [string]$Version,

    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "common.ps1")

function Replace-FirstMatchGroup2 {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$NewValue,
        [Parameter(Mandatory = $true)][string]$ContextLabel
    )

    $regex = [regex]::new($Pattern)
    $match = $regex.Match($Content)
    if (-not $match.Success) {
        throw "Could not match version pattern in '$ContextLabel'."
    }
    if ($match.Groups[2].Value -eq $NewValue) {
        return $Content
    }
    return $regex.Replace(
        $Content,
        { param($m) $m.Groups[1].Value + $NewValue + $m.Groups[3].Value },
        1
    )
}

$repoRoot = Get-EpilodRepoRoot
$snapshotBefore = Get-RepoVersionSnapshot -RepoRoot $repoRoot

if ($CheckOnly) {
    Write-Host "==> Current Epilod Party version inventory:"
    $snapshotBefore.Entries | Format-Table -AutoSize | Out-String | Write-Host
    if (-not $snapshotBefore.InSync) {
        throw "Version mismatch detected across files: $($snapshotBefore.Distinct -join ', ')"
    }
    Write-Host "OK: All version files are in lockstep at v$($snapshotBefore.PrimaryVersion)."
    return $snapshotBefore
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "Provide a target version (e.g. '0.1.1', 'patch', 'minor', 'major') or pass -CheckOnly."
}

$tauriConfRaw = [System.IO.File]::ReadAllText((Join-Path $repoRoot "src-tauri\tauri.conf.json"))
$currentVersion = Read-VersionFromText -Content $tauriConfRaw -Kind "JsonTopLevel" -FileLabel "src-tauri/tauri.conf.json"
$targetVersion = Resolve-TargetSemVer -InputVersion $Version -CurrentVersion $currentVersion

Write-Host "==> Stamping Epilod Party version: v$currentVersion -> v$targetVersion"

foreach ($spec in (Get-VersionTargetSpecs)) {
    $fullPath = Join-Path $repoRoot $spec.RelativePath
    $raw = [System.IO.File]::ReadAllText($fullPath)
    $pattern = if ($spec.Kind -eq "CargoPackage") {
        '(?ms)(\[package\]\s*(?:(?!^\[)[\s\S])*?^version\s*=\s*")([^"]+)(")'
    } else {
        '(?m)^([ \t]*"version"\s*:\s*")([^"]+)(")'
    }

    $updated = Replace-FirstMatchGroup2 -Content $raw -Pattern $pattern -NewValue $targetVersion -ContextLabel $spec.RelativePath
    $verifiedVer = Read-VersionFromText -Content $updated -Kind $spec.Kind -FileLabel $spec.RelativePath
    if ($verifiedVer -ne $targetVersion) {
        throw "Post-stamp check failed for '$($spec.RelativePath)' (got '$verifiedVer')."
    }

    if ($updated -ne $raw -and $PSCmdlet.ShouldProcess($spec.RelativePath, "Stamp version $targetVersion")) {
        Write-Utf8NoBomFile -Path $fullPath -Content $updated
        Write-Host "  Updated $($spec.RelativePath) -> $targetVersion"
    } elseif ($updated -eq $raw) {
        Write-Host "  Already at $targetVersion`: $($spec.RelativePath)"
    }
}

$pkgLockPath = Join-Path $repoRoot "package-lock.json"
if (Test-Path $pkgLockPath) {
    $rawLock = [System.IO.File]::ReadAllText($pkgLockPath)
    $updatedLock = Replace-FirstMatchGroup2 -Content $rawLock -Pattern '(?m)^([ \t]{2}"version"\s*:\s*")([^"]+)(")' -NewValue $targetVersion -ContextLabel "package-lock.json (root)"
    # Stop scalar match before any nested objects (e.g. "dependencies": {) inside packages.""
    $updatedLock = Replace-FirstMatchGroup2 -Content $updatedLock -Pattern '(?ms)("packages"\s*:\s*\{\s*""\s*:\s*\{\s*[^\{\}]*?"version"\s*:\s*")([^"]+)(")' -NewValue $targetVersion -ContextLabel "package-lock.json (packages.'')"
    $lockVersions = Get-PackageLockVersions -Content $updatedLock
    if ([string]$lockVersions.root -ne $targetVersion -or [string]$lockVersions.pkg -ne $targetVersion) {
        throw "JSON post-check failed for package-lock.json (root='$($lockVersions.root)', pkg='$($lockVersions.pkg)')."
    }

    if ($updatedLock -ne $rawLock -and $PSCmdlet.ShouldProcess("package-lock.json", "Stamp version $targetVersion")) {
        Write-Utf8NoBomFile -Path $pkgLockPath -Content $updatedLock
        Write-Host "  Updated package-lock.json -> $targetVersion"
    }
}

if ($PSCmdlet.ShouldProcess("Cargo.lock", "Refresh workspace crate versions (cargo update -w --offline)")) {
    Push-Location $repoRoot
    try {
        Write-Host "==> Syncing Cargo.lock workspace versions..."
        Invoke-NativeChecked -FilePath "cargo" -Arguments @("update", "-w", "--offline") -FailureMessage "cargo update -w --offline failed"
    } finally {
        Pop-Location
    }

    $snapshotAfter = Get-RepoVersionSnapshot -RepoRoot $repoRoot
    if (-not $snapshotAfter.InSync -or $snapshotAfter.PrimaryVersion -ne $targetVersion) {
        $snapshotAfter.Entries | Format-Table -AutoSize | Out-String | Write-Host
        throw "Post-stamp verification failed! Expected all entries at '$targetVersion', saw: $($snapshotAfter.Distinct -join ', ')"
    }

    Write-Host "OK: Verified all 7 version manifests and lockfiles are in lockstep at v$targetVersion."
    return $snapshotAfter
}

return [pscustomobject]@{
    PrimaryVersion = $targetVersion
    PreviousVersion = $currentVersion
    DryRun = $true
}
