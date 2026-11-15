# Shared helpers for Epilod Party release-update skill scripts.
# All functions assume Windows PowerShell 5.1+ or PowerShell 7+ compatibility.

Set-StrictMode -Version Latest

function Get-EpilodRepoRoot {
    <#
    .SYNOPSIS
    Resolves and validates the Epilod Party repository root from the skill script directory.
    #>
    param(
        [string]$StartDir = $PSScriptRoot
    )

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $StartDir "..\..\..\.."))
    $required = @(
        (Join-Path $candidate "src-tauri\tauri.conf.json"),
        (Join-Path $candidate "crates\epilod-core\Cargo.toml")
    )
    foreach ($path in $required) {
        if (-not (Test-Path $path)) {
            throw "Could not locate Epilod Party repo root from '$StartDir' (missing '$path')."
        }
    }
    return $candidate
}

function Write-Utf8NoBomFile {
    <#
    .SYNOPSIS
    Writes text to a file as UTF-8 without a byte-order mark (safe on PowerShell 5.1).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Invoke-NativeChecked {
    <#
    .SYNOPSIS
    Executes a native CLI tool with live output without PowerShell 5.1 stderr termination bugs.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$FailureMessage = "Native command failed"
    )

    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $FilePath @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevPref
    }

    if ($exitCode -ne 0) {
        throw "$FailureMessage (exit code $exitCode)."
    }
}

function Invoke-NativeCapture {
    <#
    .SYNOPSIS
    Runs a native command, returning ExitCode and captured Output cleanly on PS 5.1+.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevPref
    }

    $text = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = $text
    }
}

function Get-VersionTargetSpecs {
    <#
    .SYNOPSIS
    Returns the canonical list of version-bearing manifest and config files in Epilod Party.
    #>
    return @(
        [pscustomobject]@{ RelativePath = "crates\epilod-core\Cargo.toml"; Kind = "CargoPackage"; Role = "App CURRENT_APP_VERSION" },
        [pscustomobject]@{ RelativePath = "crates\epilod-installer-core\Cargo.toml"; Kind = "CargoPackage"; Role = "Installer APP_VERSION" },
        [pscustomobject]@{ RelativePath = "src-tauri\Cargo.toml"; Kind = "CargoPackage"; Role = "Main app crate version" },
        [pscustomobject]@{ RelativePath = "src-installer\Cargo.toml"; Kind = "CargoPackage"; Role = "Setup EXE crate version" },
        [pscustomobject]@{ RelativePath = "src-tauri\tauri.conf.json"; Kind = "JsonTopLevel"; Role = "Main Tauri bundle & build-installer.ps1 source" },
        [pscustomobject]@{ RelativePath = "src-installer\tauri.conf.json"; Kind = "JsonTopLevel"; Role = "Setup Tauri bundle version" },
        [pscustomobject]@{ RelativePath = "package.json"; Kind = "JsonTopLevel"; Role = "Frontend package version" }
    )
}

function Read-VersionFromText {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][ValidateSet("CargoPackage", "JsonTopLevel")][string]$Kind,
        [Parameter(Mandatory = $true)][string]$FileLabel
    )

    if ($Kind -eq "CargoPackage") {
        $pattern = '(?ms)(\[package\]\s*(?:(?!^\[)[\s\S])*?^version\s*=\s*")([^"]+)(")'
        $m = [regex]::Match($Content, $pattern)
        if (-not $m.Success) {
            throw "Could not locate [package] version in '$FileLabel'."
        }
        return $m.Groups[2].Value
    }

    $obj = $Content | ConvertFrom-Json
    if (-not $obj -or [string]::IsNullOrWhiteSpace($obj.version)) {
        throw "Could not locate top-level JSON version in '$FileLabel'."
    }
    return [string]$obj.version
}

function Resolve-TargetSemVer {
    <#
    .SYNOPSIS
    Resolves an explicit semver string (X.Y.Z, vX.Y.Z, or X.Y.Z-pre) or bump keyword (patch, minor, major).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$InputVersion,
        [Parameter(Mandatory = $true)][string]$CurrentVersion
    )

    $trimmed = $InputVersion.Trim()
    $normalized = if ($trimmed -match '^[vV](.+)$') { $Matches[1] } else { $trimmed }

    if ($normalized -in @("patch", "minor", "major")) {
        if ($CurrentVersion -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$') {
            throw "Current version '$CurrentVersion' is not valid MAJOR.MINOR.PATCH semver."
        }
        $maj = [int]$Matches[1]
        $min = [int]$Matches[2]
        $pat = [int]$Matches[3]
        switch ($normalized) {
            "patch" { return "$maj.$min.$($pat + 1)" }
            "minor" { return "$maj.$($min + 1).0" }
            "major" { return "$($maj + 1).0.0" }
        }
    }

    if ($normalized -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$') {
        throw "Invalid version '$InputVersion'. Expected semver like 0.1.1, 1.0.0-rc.1, or keyword patch/minor/major."
    }

    return $normalized
}

function Get-PackageLockVersions {
    <#
    .SYNOPSIS
    Validates package-lock.json and extracts root and packages[""] versions (PS 5.1 ConvertFrom-Json rejects "" keys).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Content
    )

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $script = "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);const p=(j.packages&&j.packages[''])||{};console.log(JSON.stringify({root:j.version||'',pkg:p.version||''}));});"
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $out = $Content | & $nodeCmd.Source -e $script 2>&1
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevPref
        }
        if ($code -ne 0) {
            throw "Failed parsing package-lock.json via node: $($out -join ' ')"
        }
        return (($out -join "`n") | ConvertFrom-Json)
    }

    $rootMatch = [regex]::Match($Content, '(?m)^[ \t]{2}"version"\s*:\s*"([^"]+)"')
    $pkgMatch = [regex]::Match($Content, '(?ms)"packages"\s*:\s*\{\s*""\s*:\s*\{\s*[^\{\}]*?"version"\s*:\s*"([^"]+)"')
    return [pscustomobject]@{
        root = if ($rootMatch.Success) { $rootMatch.Groups[1].Value } else { "" }
        pkg  = if ($pkgMatch.Success) { $pkgMatch.Groups[1].Value } else { "" }
    }
}

function Get-RepoVersionSnapshot {
    <#
    .SYNOPSIS
    Reads every stamped version source (plus lockfiles) and checks whether they match in lockstep.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )

    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($spec in (Get-VersionTargetSpecs)) {
        $fullPath = Join-Path $RepoRoot $spec.RelativePath
        if (-not (Test-Path $fullPath)) {
            throw "Missing version file '$fullPath'."
        }
        $raw = [System.IO.File]::ReadAllText($fullPath)
        $ver = Read-VersionFromText -Content $raw -Kind $spec.Kind -FileLabel $spec.RelativePath
        $entries.Add([pscustomobject]@{
            File    = $spec.RelativePath
            Role    = $spec.Role
            Version = $ver
        })
    }

    $pkgLockPath = Join-Path $RepoRoot "package-lock.json"
    if (Test-Path $pkgLockPath) {
        $pkgVersions = Get-PackageLockVersions -Content ([System.IO.File]::ReadAllText($pkgLockPath))
        $entries.Add([pscustomobject]@{
            File    = "package-lock.json (root)"
            Role    = "npm lockfile root version"
            Version = [string]$pkgVersions.root
        })
        if (-not [string]::IsNullOrWhiteSpace($pkgVersions.pkg)) {
            $entries.Add([pscustomobject]@{
                File    = "package-lock.json (packages.'')"
                Role    = "npm lockfile workspace root version"
                Version = [string]$pkgVersions.pkg
            })
        }
    }

    $cargoLockPath = Join-Path $RepoRoot "Cargo.lock"
    if (Test-Path $cargoLockPath) {
        $cargoLockRaw = [System.IO.File]::ReadAllText($cargoLockPath)
        foreach ($crate in @("epilod-core", "epilod-installer-core", "epilod-party", "epilod-setup")) {
            $pattern = '(?ms)\[\[package\]\]\s*name\s*=\s*"' + [regex]::Escape($crate) + '"\s*version\s*=\s*"([^"]+)"'
            $m = [regex]::Match($cargoLockRaw, $pattern)
            $entries.Add([pscustomobject]@{
                File    = "Cargo.lock ($crate)"
                Role    = "Cargo lockfile workspace crate"
                Version = if ($m.Success) { $m.Groups[1].Value } else { "<missing>" }
            })
        }
    }

    $distinct = @($entries | Select-Object -ExpandProperty Version -Unique)
    return [pscustomobject]@{
        PrimaryVersion = $entries[0].Version
        InSync         = ($distinct.Count -eq 1)
        Distinct       = $distinct
        Entries        = $entries
    }
}
