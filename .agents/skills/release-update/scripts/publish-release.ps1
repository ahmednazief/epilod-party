<#
.SYNOPSIS
End-to-end release pipeline for Epilod Party:
preflight -> stamp version -> verify tests -> build Windows installer + bundle + manifest ->
verify artifacts -> commit/tag/push (optional) -> upload to GitHub Releases -> verify live endpoints.

.EXAMPLE
.\publish-release.ps1 -Version 0.1.1 -PreflightOnly

.EXAMPLE
.\publish-release.ps1 -Version 0.1.1 -Notes "Bug fixes and playback improvements" -CommitAndTag

.EXAMPLE
.\publish-release.ps1 -SkipBuild -OverwriteRelease
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Version,

    [string]$Notes,
    [string]$NotesFile,
    [string]$SigningKey,

    [switch]$PreflightOnly,
    [switch]$SkipTests,
    [switch]$SkipFrontendBuild,
    [switch]$SkipBuild,
    [switch]$SkipUpload,
    [switch]$CommitAndTag,
    [switch]$IncludeAllDirtyChanges,
    [switch]$AllowUnpushedSource,
    [switch]$OverwriteRelease,
    [switch]$Draft,
    [switch]$Prerelease,

    [string]$Repo = "ahmednazief/epilod-party"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "common.ps1")

function Get-GitHubToken {
    if (-not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
        return $env:GH_TOKEN.Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
        return $env:GITHUB_TOKEN.Trim()
    }
    return $null
}

function Invoke-CurlApi {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Url,
        [string]$Token,
        [string]$JsonBody,
        [string]$FilePath,
        [string]$ContentType = "application/json",
        [int]$MaxTimeSeconds = 120
    )

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("epilod-curl-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    try {
        $respFile = Join-Path $tempDir "response.txt"
        $cfgLines = New-Object System.Collections.Generic.List[string]
        $cfgLines.Add('silent')
        $cfgLines.Add('show-error')
        $cfgLines.Add('header = "Accept: application/vnd.github+json"')
        $cfgLines.Add('header = "X-GitHub-Api-Version: 2022-11-28"')
        $cfgLines.Add('header = "User-Agent: Epilod-Party-Release-Skill"')
        if (-not [string]::IsNullOrWhiteSpace($Token)) {
            $cfgLines.Add("header = `"Authorization: Bearer $Token`"")
        }

        $args = New-Object System.Collections.Generic.List[string]
        $args.Add("-K")
        $args.Add("-")
        $args.Add("-X")
        $args.Add($Method)
        $args.Add("-o")
        $args.Add($respFile)
        $args.Add("-w")
        $args.Add("%{http_code}")
        $args.Add("--max-time")
        $args.Add([string]$MaxTimeSeconds)

        if ($null -ne $JsonBody) {
            $bodyPath = Join-Path $tempDir "body.json"
            Write-Utf8NoBomFile -Path $bodyPath -Content $JsonBody
            $args.Add("-H")
            $args.Add("Content-Type: $ContentType")
            $args.Add("--data-binary")
            $args.Add("@$bodyPath")
        } elseif (-not [string]::IsNullOrWhiteSpace($FilePath)) {
            $args.Add("-H")
            $args.Add("Content-Type: $ContentType")
            $args.Add("--data-binary")
            $args.Add("@$FilePath")
        }

        $args.Add($Url)
        $cfgText = ($cfgLines -join "`n") + "`n"

        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $statusRaw = $cfgText | & curl.exe @args 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevPref
        }

        if ($exitCode -ne 0) {
            throw "curl.exe failed ($Method $Url, exit code $exitCode): $($statusRaw -join ' ')"
        }

        $statusCode = [int](($statusRaw | Select-Object -Last 1).ToString().Trim())
        $rawBody = if (Test-Path $respFile) { [System.IO.File]::ReadAllText($respFile) } else { "" }
        $parsedJson = $null
        $trimmedBody = $rawBody.Trim()
        if ($trimmedBody.StartsWith("{") -or $trimmedBody.StartsWith("[")) {
            try {
                $parsedJson = $rawBody | ConvertFrom-Json
            } catch {
                $parsedJson = $null
            }
        }

        return [pscustomobject]@{
            StatusCode = $statusCode
            RawBody    = $rawBody
            Json       = $parsedJson
        }
    } finally {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Find-Executable {
    param(
        [Parameter(Mandatory = $true)][string]$CommandName,
        [string[]]$FallbackPaths = @()
    )

    $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in $FallbackPaths) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
            return $candidate
        }
    }
    return $null
}

function Find-GitHubCli {
    return Find-Executable -CommandName "gh" -FallbackPaths @(
        "C:\Program Files\GitHub CLI\gh.exe",
        "C:\Program Files (x86)\GitHub CLI\gh.exe",
        "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe"
    )
}

function Find-SevenZip {
    return Find-Executable -CommandName "7z" -FallbackPaths @(
        "C:\Program Files\7-Zip\7z.exe",
        "C:\Program Files (x86)\7-Zip\7z.exe"
    )
}

function Resolve-UploadTransport {
    $ghPath = Find-GitHubCli
    if ($ghPath) {
        $authRes = Invoke-NativeCapture -FilePath $ghPath -Arguments @("auth", "status")
        if ($authRes.ExitCode -eq 0) {
            return [pscustomobject]@{
                Mode   = "gh"
                GhPath = $ghPath
                Token  = $null
                Detail = "GitHub CLI ($ghPath) authenticated"
            }
        }
    }

    $token = Get-GitHubToken
    if ($token) {
        $curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
        if (-not $curlCmd) {
            throw "GH_TOKEN/GITHUB_TOKEN is set, but curl.exe was not found for GitHub REST API uploads."
        }
        $userCheck = Invoke-CurlApi -Method "GET" -Url "https://api.github.com/user" -Token $token -MaxTimeSeconds 30
        if ($userCheck.StatusCode -lt 200 -or $userCheck.StatusCode -ge 300) {
            throw "GH_TOKEN/GITHUB_TOKEN authentication check failed (HTTP $($userCheck.StatusCode))."
        }
        $login = if ($userCheck.Json -and $userCheck.Json.login) { $userCheck.Json.login } else { "<authenticated>" }
        return [pscustomobject]@{
            Mode   = "rest"
            GhPath = $null
            Token  = $token
            Detail = "GitHub REST API via token (user: $login)"
        }
    }

    if ($ghPath) {
        throw @"
Cannot publish to GitHub Releases: GitHub CLI is installed at '$ghPath', but not authenticated (`gh auth status` failed).
Fix using one of these options:
  1. Authenticate GitHub CLI in your terminal:
     & "$ghPath" auth login
  2. Set a GitHub personal access token (repo / contents:write) in your session:
     `$env:GH_TOKEN = "<token>"
"@
    }

    throw @"
Cannot publish to GitHub Releases: GitHub CLI (`gh`) is not installed and neither `$env:GH_TOKEN` nor `$env:GITHUB_TOKEN` is set.
Fix using one of these options:
  1. Install GitHub CLI and authenticate:
     winget install GitHub.cli
     gh auth login
  2. Set a GitHub personal access token (repo / contents:write) in your session:
     `$env:GH_TOKEN = "<token>"
"@
}

function Get-NonVersionDirtyPaths {
    param([string[]]$PorcelainLines)

    $versionFiles = @(
        "crates/epilod-core/Cargo.toml",
        "crates/epilod-installer-core/Cargo.toml",
        "src-tauri/Cargo.toml",
        "src-installer/Cargo.toml",
        "src-tauri/tauri.conf.json",
        "src-installer/tauri.conf.json",
        "package.json",
        "package-lock.json",
        "Cargo.lock"
    )

    $other = New-Object System.Collections.Generic.List[string]
    foreach ($line in $PorcelainLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $rel = $line.Substring(3).Trim()
        if ($rel -match '->\s*(.+)$') { $rel = $Matches[1].Trim() }
        $rel = $rel.Trim('"') -replace '\\', '/'
        if ($rel -notin $versionFiles) {
            $other.Add($rel)
        }
    }
    return @($other)
}

function Resolve-ReleaseNotes {
    param(
        [string]$NotesText,
        [string]$NotesFilePath,
        [string]$TargetVersion
    )

    if (-not [string]::IsNullOrWhiteSpace($NotesFilePath)) {
        if (-not (Test-Path $NotesFilePath)) {
            throw "NotesFile not found: '$NotesFilePath'"
        }
        return ([System.IO.File]::ReadAllText($NotesFilePath)).Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace($NotesText)) {
        return $NotesText.Trim()
    }
    return "Epilod Party v$TargetVersion Windows release"
}

$repoRoot = Get-EpilodRepoRoot
$stampScript = Join-Path $PSScriptRoot "stamp-version.ps1"
$buildScript = Join-Path $repoRoot "scripts\build-installer.ps1"

if (-not [string]::IsNullOrWhiteSpace($SigningKey)) {
    $env:EPILOD_SIGNING_PRIVATE_KEY = $SigningKey
}

$snapshot = Get-RepoVersionSnapshot -RepoRoot $repoRoot
$currentVersion = $snapshot.PrimaryVersion
$targetVersion = if (-not [string]::IsNullOrWhiteSpace($Version)) {
    Resolve-TargetSemVer -InputVersion $Version -CurrentVersion $currentVersion
} else {
    if (-not $snapshot.InSync) {
        throw "No -Version specified and repo versions are out of sync: $($snapshot.Distinct -join ', ')"
    }
    $currentVersion
}

$releaseTag = "v$targetVersion"
$expectedAssetName = "Epilod.Party.Setup.exe"
$manifestFileName = "epilod-update-manifest.json"
$expectedDownloadUrl = "https://github.com/$Repo/releases/download/$releaseTag/$expectedAssetName"
$resolvedNotes = Resolve-ReleaseNotes -NotesText $Notes -NotesFilePath $NotesFile -TargetVersion $targetVersion

Write-Host "==> Epilod Party Release Preflight ($releaseTag -> $Repo)"

# 1. Check build toolchain unless skipping build
$toolFailures = New-Object System.Collections.Generic.List[string]
if (-not $SkipBuild) {
    foreach ($tool in @("cargo", "rustc", "node", "npm")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            $toolFailures.Add("Missing required build tool in PATH: $tool")
        }
    }
    if (-not (Find-SevenZip)) {
        $toolFailures.Add("Missing 7-Zip (`7z.exe` not in PATH or Program Files)")
    }
}

# 2. Check signing key alignment
$hasPubKey = -not [string]::IsNullOrWhiteSpace($env:EPILOD_UPDATE_PUBKEY)
$hasPrivKey = -not [string]::IsNullOrWhiteSpace($env:EPILOD_SIGNING_PRIVATE_KEY)
if ($hasPubKey -and -not $hasPrivKey) {
    $toolFailures.Add("EPILOD_UPDATE_PUBKEY is set in environment, so EPILOD_SIGNING_PRIVATE_KEY (or -SigningKey) is required to sign the release manifest.")
} elseif ($hasPrivKey -and -not $hasPubKey) {
    Write-Warning "EPILOD_SIGNING_PRIVATE_KEY is set, but EPILOD_UPDATE_PUBKEY is not set in environment; compiled binaries will only enforce signatures if EPILOD_UPDATE_PUBKEY is embedded during build."
}

# 3. Check git state and remote origin
Push-Location $repoRoot
try {
    $originUrl = (Invoke-NativeCapture -FilePath "git" -Arguments @("remote", "get-url", "origin")).Output.Trim()
    $branch = (Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "--abbrev-ref", "HEAD")).Output.Trim()
    $headSha = (Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "HEAD")).Output.Trim()
    $porcelain = @((Invoke-NativeCapture -FilePath "git" -Arguments @("status", "--porcelain")).Output -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $remoteTagCheck = Invoke-NativeCapture -FilePath "git" -Arguments @("ls-remote", "--tags", "origin", "refs/tags/$releaseTag")
    $localTagCheck = Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "-q", "--verify", "refs/tags/$releaseTag")
} finally {
    Pop-Location
}

if ($originUrl -and ($originUrl -notmatch [regex]::Escape($Repo))) {
    Write-Warning "Git origin '$originUrl' does not match target repo '$Repo'."
}
if ($branch -eq "HEAD" -or [string]::IsNullOrWhiteSpace($branch)) {
    $toolFailures.Add("Repository is in detached HEAD state. Check out a release branch (e.g. main) first.")
}

if ($remoteTagCheck.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($remoteTagCheck.Output) -and -not $OverwriteRelease) {
    $toolFailures.Add("Remote git tag '$releaseTag' already exists on origin (pass -OverwriteRelease or pick a higher version).")
}
if ($localTagCheck.ExitCode -eq 0 -and -not $OverwriteRelease -and -not $CommitAndTag) {
    Write-Warning "Local tag '$releaseTag' already exists at $($localTagCheck.Output.Trim())."
}

$otherDirty = Get-NonVersionDirtyPaths -PorcelainLines $porcelain
if ($otherDirty.Count -gt 0) {
    Write-Warning ("Working tree has {0} non-version uncommitted change(s): {1}" -f $otherDirty.Count, ($otherDirty -join ", "))
    if ($CommitAndTag -and -not $IncludeAllDirtyChanges) {
        $toolFailures.Add("-CommitAndTag refused because non-version files have uncommitted changes. Commit/stash them first or pass -IncludeAllDirtyChanges.")
    }
}

# 4. Check upload auth unless skipping upload
$uploadTransport = $null
if (-not $SkipUpload) {
    try {
        $uploadTransport = Resolve-UploadTransport
        Write-Host "  Upload transport : $($uploadTransport.Detail)"
    } catch {
        $toolFailures.Add($_.Exception.Message)
    }
} else {
    Write-Host "  Upload transport : <skipped (-SkipUpload)>"
}

Write-Host "  Current version  : v$currentVersion (in sync: $($snapshot.InSync))"
Write-Host "  Target version   : v$targetVersion (tag: $releaseTag)"
Write-Host "  Target branch    : $branch ($headSha)"
Write-Host "  Signing key      : $(if ($hasPrivKey) { 'configured' } else { 'unsigned' })"

if ($toolFailures.Count -gt 0) {
    $msg = ($toolFailures | ForEach-Object { "  - $_" }) -join "`n"
    throw "Release preflight failed:`n$msg"
}

if ($PreflightOnly) {
    Write-Host "OK: Preflight passed for $releaseTag."
    return [pscustomobject]@{
        PreflightPassed = $true
        CurrentVersion  = $currentVersion
        TargetVersion   = $targetVersion
        Branch          = $branch
        UploadMode      = if ($uploadTransport) { $uploadTransport.Mode } else { "skipped" }
        DirtyFilesCount = $porcelain.Count
    }
}

# 5. Stamp version (or validate lockstep if no version change requested)
if (-not [string]::IsNullOrWhiteSpace($Version)) {
    & $stampScript -Version $targetVersion | Out-Null
} else {
    & $stampScript -CheckOnly | Out-Null
}

Push-Location $repoRoot
try {
    # 6. Verification tests
    if (-not $SkipBuild -and -not $SkipTests) {
        Write-Host "==> Running workspace Rust tests (cargo test --workspace)..."
        Invoke-NativeChecked -FilePath "cargo" -Arguments @("test", "--workspace") -FailureMessage "cargo test --workspace failed"

        $testFiles = @(Get-ChildItem (Join-Path $repoRoot "tests") -Filter "*.test.ts" | Sort-Object Name | ForEach-Object FullName)
        if ($testFiles.Count -gt 0) {
            Write-Host "==> Running frontend/updater unit tests ($($testFiles.Count) files)..."
            Invoke-NativeChecked -FilePath "node" -Arguments (@("--test") + $testFiles) -FailureMessage "node --test failed"
        }
    }

    # 7. Build installer & manifest
    $releaseDir = Join-Path $repoRoot "target\release"
    $setupExe = Join-Path $releaseDir "Epilod Party Setup.exe"
    $manifestJson = Join-Path $releaseDir $manifestFileName

    if (-not $SkipBuild) {
        $buildArgs = @{}
        if ($SkipFrontendBuild) { $buildArgs["SkipFrontendBuild"] = $true }
        & $buildScript @buildArgs

        $defaultNotes = "Epilod Party v$targetVersion Windows release"
        $manifestNotes = ($resolvedNotes -replace '(\r?\n)+', '; ').Trim()
        if ($manifestNotes -ne $defaultNotes -and -not [string]::IsNullOrWhiteSpace($manifestNotes)) {
            Write-Host "==> Updating release manifest with custom notes..."
            Invoke-NativeChecked -FilePath "cargo" -Arguments @(
                "run", "--release", "-p", "epilod-installer-core", "--bin", "epilod-pack", "--",
                "--write-update-manifest", $setupExe, $targetVersion, $expectedDownloadUrl, $manifestJson, $manifestNotes
            ) -FailureMessage "epilod-pack --write-update-manifest failed"
        }
    }

    # 8. Strict artifact parity checks
    if (-not (Test-Path $setupExe)) {
        throw "Installer binary missing at '$setupExe'."
    }
    if (-not (Test-Path $manifestJson)) {
        throw "Update manifest missing at '$manifestJson'."
    }

    $exeInfo = Get-Item $setupExe
    if ($exeInfo.Length -lt 10MB) {
        throw "Built setup binary looks unexpectedly small ($($exeInfo.Length) bytes): '$setupExe'."
    }

    $actualSha256 = (Get-FileHash -Path $setupExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestObj = ([System.IO.File]::ReadAllText($manifestJson)) | ConvertFrom-Json

    if ([string]$manifestObj.version -ne $targetVersion) {
        throw "Manifest version mismatch: expected '$targetVersion', got '$($manifestObj.version)'."
    }
    if ([string]$manifestObj.downloadUrl -ne $expectedDownloadUrl) {
        throw "Manifest downloadUrl mismatch: expected '$expectedDownloadUrl', got '$($manifestObj.downloadUrl)'."
    }
    if ([string]$manifestObj.fileName -ne "Epilod Party Setup.exe") {
        throw "Manifest fileName mismatch: expected 'Epilod Party Setup.exe', got '$($manifestObj.fileName)'."
    }
    if ([string]$manifestObj.sha256 -ne $actualSha256) {
        throw "Manifest sha256 mismatch: expected '$actualSha256', got '$($manifestObj.sha256)'."
    }
    if ([int64]$manifestObj.sizeBytes -ne [int64]$exeInfo.Length) {
        throw "Manifest sizeBytes mismatch: expected '$($exeInfo.Length)', got '$($manifestObj.sizeBytes)'."
    }
    if ($hasPubKey -and [string]::IsNullOrWhiteSpace($manifestObj.signature)) {
        throw "EPILOD_UPDATE_PUBKEY is set, but manifest.signature is empty/null."
    }

    Write-Host "==> Verified built release artifacts:"
    Write-Host "  Installer : $setupExe ($($exeInfo.Length) bytes, sha256=$actualSha256)"
    Write-Host "  Manifest  : $manifestJson (version=$($manifestObj.version), signed=$(-not [string]::IsNullOrWhiteSpace($manifestObj.signature)))"

    if ($SkipUpload) {
        Write-Host "OK: Build and verification complete (-SkipUpload set)."
        return [pscustomobject]@{
            Version      = $targetVersion
            SetupExe     = $setupExe
            ManifestJson = $manifestJson
            Sha256       = $actualSha256
            SizeBytes    = $exeInfo.Length
            Uploaded     = $false
        }
    }

    # 9. Commit / Tag / Push handling
    if ($CommitAndTag) {
        Write-Host "==> Committing release bump and pushing tag $releaseTag..."
        if ($IncludeAllDirtyChanges) {
            Invoke-NativeChecked -FilePath "git" -Arguments @("add", "-A") -FailureMessage "git add -A failed"
        } else {
            $toStage = @(
                "crates/epilod-core/Cargo.toml",
                "crates/epilod-installer-core/Cargo.toml",
                "src-tauri/Cargo.toml",
                "src-installer/Cargo.toml",
                "src-tauri/tauri.conf.json",
                "src-installer/tauri.conf.json",
                "package.json",
                "package-lock.json",
                "Cargo.lock"
            ) | Where-Object { Test-Path (Join-Path $repoRoot $_) }
            Invoke-NativeChecked -FilePath "git" -Arguments (@("add", "--") + $toStage) -FailureMessage "git add version files failed"
        }

        $stagedDiff = Invoke-NativeCapture -FilePath "git" -Arguments @("diff", "--cached", "--quiet")
        if ($stagedDiff.ExitCode -eq 1) {
            Invoke-NativeChecked -FilePath "git" -Arguments @("commit", "-m", "chore(release): $releaseTag") -FailureMessage "git commit failed"
        }

        $headSha = (Invoke-NativeCapture -FilePath "git" -Arguments @("rev-parse", "HEAD")).Output.Trim()
        if ($OverwriteRelease) {
            Invoke-NativeChecked -FilePath "git" -Arguments @("tag", "-f", $releaseTag, $headSha) -FailureMessage "git tag -f failed"
            Invoke-NativeChecked -FilePath "git" -Arguments @("push", "origin", $branch) -FailureMessage "git push branch failed"
            Invoke-NativeChecked -FilePath "git" -Arguments @("push", "-f", "origin", "refs/tags/$releaseTag") -FailureMessage "git push -f tag failed"
        } else {
            Invoke-NativeChecked -FilePath "git" -Arguments @("tag", $releaseTag, $headSha) -FailureMessage "git tag failed"
            Invoke-NativeChecked -FilePath "git" -Arguments @("push", "origin", $branch) -FailureMessage "git push branch failed"
            Invoke-NativeChecked -FilePath "git" -Arguments @("push", "origin", "refs/tags/$releaseTag") -FailureMessage "git push tag failed"
        }
    } else {
        $postBuildDirty = @((Invoke-NativeCapture -FilePath "git" -Arguments @("status", "--porcelain")).Output -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $headRemote = Invoke-NativeCapture -FilePath "git" -Arguments @("branch", "-r", "--contains", "HEAD")
        $headIsPushed = ($headRemote.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($headRemote.Output))

        if (($postBuildDirty.Count -gt 0 -or -not $headIsPushed) -and -not $AllowUnpushedSource) {
            throw @"
Refusing to publish GitHub tag '$releaseTag' while local changes or commits are unpushed to origin.
Pass -CommitAndTag (after reviewing/committing WIP changes) or commit/push first, or pass -AllowUnpushedSource to tag current remote branch head explicitly.
"@
        }
    }

    # 10. Stage renamed asset (`Epilod.Party.Setup.exe`) and publish to GitHub Releases
    $stageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("epilod-release-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
    try {
        $stagedExe = Join-Path $stageDir $expectedAssetName
        $notesTempFile = Join-Path $stageDir "release-notes.md"
        Copy-Item -Path $setupExe -Destination $stagedExe -Force
        Write-Utf8NoBomFile -Path $notesTempFile -Content $resolvedNotes

        $releaseUrl = "https://github.com/$Repo/releases/tag/$releaseTag"

        if ($uploadTransport.Mode -eq "gh") {
            $gh = $uploadTransport.GhPath
            $exists = (Invoke-NativeCapture -FilePath $gh -Arguments @("release", "view", $releaseTag, "--repo", $Repo)).ExitCode -eq 0
            if ($exists) {
                if (-not $OverwriteRelease) {
                    throw "GitHub Release '$releaseTag' already exists on $Repo. Re-run with -OverwriteRelease to replace assets."
                }
                Write-Host "==> Updating existing GitHub Release $releaseTag via gh..."
                Invoke-NativeChecked -FilePath $gh -Arguments @(
                    "release", "edit", $releaseTag, "--repo", $Repo,
                    "--title", "Epilod Party $releaseTag",
                    "--notes-file", $notesTempFile
                ) -FailureMessage "gh release edit failed"
                Invoke-NativeChecked -FilePath $gh -Arguments @(
                    "release", "upload", $releaseTag, $stagedExe, $manifestJson,
                    "--repo", $Repo, "--clobber"
                ) -FailureMessage "gh release upload failed"
            } else {
                Write-Host "==> Creating GitHub Release $releaseTag via gh..."
                $createArgs = @(
                    "release", "create", $releaseTag, $stagedExe, $manifestJson,
                    "--repo", $Repo,
                    "--title", "Epilod Party $releaseTag",
                    "--notes-file", $notesTempFile
                )
                if ($Draft) { $createArgs += "--draft" }
                if ($Prerelease) { $createArgs += "--prerelease" }
                Invoke-NativeChecked -FilePath $gh -Arguments $createArgs -FailureMessage "gh release create failed"
            }
        } else {
            $tok = $uploadTransport.Token
            $existingResp = Invoke-CurlApi -Method "GET" -Url "https://api.github.com/repos/$Repo/releases/tags/$releaseTag" -Token $tok
            $releaseObj = $null
            if ($existingResp.StatusCode -eq 200) {
                if (-not $OverwriteRelease) {
                    throw "GitHub Release '$releaseTag' already exists on $Repo. Re-run with -OverwriteRelease to replace assets."
                }
                $releaseId = $existingResp.Json.id
                $patchBody = @{
                    name       = "Epilod Party $releaseTag"
                    body       = $resolvedNotes
                    draft      = [bool]$Draft
                    prerelease = [bool]$Prerelease
                } | ConvertTo-Json -Depth 4
                $patchResp = Invoke-CurlApi -Method "PATCH" -Url "https://api.github.com/repos/$Repo/releases/$releaseId" -Token $tok -JsonBody $patchBody
                if ($patchResp.StatusCode -lt 200 -or $patchResp.StatusCode -ge 300) {
                    throw "Failed to update GitHub Release metadata (HTTP $($patchResp.StatusCode)): $($patchResp.RawBody)"
                }
                $releaseObj = $patchResp.Json

                foreach ($asset in @($releaseObj.assets)) {
                    if ($asset.name -in @($expectedAssetName, $manifestFileName)) {
                        Write-Host "  Removing existing asset '$($asset.name)' (id=$($asset.id))..."
                        $delResp = Invoke-CurlApi -Method "DELETE" -Url "https://api.github.com/repos/$Repo/releases/assets/$($asset.id)" -Token $tok
                        if ($delResp.StatusCode -ne 204) {
                            throw "Failed to delete old asset '$($asset.name)' (HTTP $($delResp.StatusCode)): $($delResp.RawBody)"
                        }
                    }
                }
            } elseif ($existingResp.StatusCode -eq 404) {
                $createBody = @{
                    tag_name         = $releaseTag
                    target_commitish = $branch
                    name             = "Epilod Party $releaseTag"
                    body             = $resolvedNotes
                    draft            = [bool]$Draft
                    prerelease       = [bool]$Prerelease
                } | ConvertTo-Json -Depth 4
                Write-Host "==> Creating GitHub Release $releaseTag via REST API..."
                $createResp = Invoke-CurlApi -Method "POST" -Url "https://api.github.com/repos/$Repo/releases" -Token $tok -JsonBody $createBody
                if ($createResp.StatusCode -lt 200 -or $createResp.StatusCode -ge 300) {
                    throw "Failed to create GitHub Release (HTTP $($createResp.StatusCode)): $($createResp.RawBody)"
                }
                $releaseObj = $createResp.Json
            } else {
                throw "Failed querying existing GitHub Release '$releaseTag' (HTTP $($existingResp.StatusCode)): $($existingResp.RawBody)"
            }

            $uploadBase = ([string]$releaseObj.upload_url) -replace '\{\?name,label\}$', ''
            Write-Host "==> Uploading $expectedAssetName ($([math]::Round($exeInfo.Length / 1MB, 1)) MB)..."
            $exeUpload = Invoke-CurlApi -Method "POST" -Url "$uploadBase`?name=$expectedAssetName" -Token $tok -FilePath $stagedExe -ContentType "application/octet-stream" -MaxTimeSeconds 1800
            if ($exeUpload.StatusCode -lt 200 -or $exeUpload.StatusCode -ge 300) {
                throw "Failed uploading $expectedAssetName (HTTP $($exeUpload.StatusCode)): $($exeUpload.RawBody)"
            }

            Write-Host "==> Uploading $manifestFileName..."
            $jsonUpload = Invoke-CurlApi -Method "POST" -Url "$uploadBase`?name=$manifestFileName" -Token $tok -FilePath $manifestJson -ContentType "application/json" -MaxTimeSeconds 120
            if ($jsonUpload.StatusCode -lt 200 -or $jsonUpload.StatusCode -ge 300) {
                throw "Failed uploading $manifestFileName (HTTP $($jsonUpload.StatusCode)): $($jsonUpload.RawBody)"
            }
        }

        # 11. Live verification for published latest release endpoints
        if (-not $Draft -and -not $Prerelease) {
            $latestManifestUrl = "https://github.com/$Repo/releases/latest/download/$manifestFileName"
            Write-Host "==> Verifying live updater endpoint: $latestManifestUrl"
            $liveManifest = $null
            for ($attempt = 1; $attempt -le 4; $attempt++) {
                $res = Invoke-NativeCapture -FilePath "curl.exe" -Arguments @("-fsSL", "--max-time", "30", $latestManifestUrl)
                if ($res.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($res.Output)) {
                    $candidate = $res.Output | ConvertFrom-Json
                    if ([string]$candidate.version -eq $targetVersion -and [string]$candidate.sha256 -eq $actualSha256) {
                        $liveManifest = $candidate
                        break
                    }
                }
                Start-Sleep -Seconds (2 * $attempt)
            }
            if (-not $liveManifest) {
                throw "Live endpoint '$latestManifestUrl' did not return expected v$targetVersion / sha256=$actualSha256."
            }

            Write-Host "==> Verifying asset download HEAD: $expectedDownloadUrl"
            $headRes = Invoke-NativeCapture -FilePath "curl.exe" -Arguments @("-fsSLI", "--max-time", "30", $expectedDownloadUrl)
            if ($headRes.ExitCode -ne 0) {
                throw "Asset download URL check failed for '$expectedDownloadUrl': $($headRes.Output)"
            }
            if ($headRes.Output -notmatch "(?mi)^content-length:\s*$($exeInfo.Length)\b") {
                Write-Warning "HEAD response did not report expected content-length=$($exeInfo.Length). Raw headers:`n$($headRes.Output)"
            }
            Write-Host "OK: Live manifest and installer download URL verified!"
        }

        Write-Host "OK: Published Epilod Party $releaseTag -> $releaseUrl"
        return [pscustomobject]@{
            Version      = $targetVersion
            ReleaseTag   = $releaseTag
            ReleaseUrl   = $releaseUrl
            ManifestUrl  = "https://github.com/$Repo/releases/latest/download/$manifestFileName"
            DownloadUrl  = $expectedDownloadUrl
            Sha256       = $actualSha256
            SizeBytes    = $exeInfo.Length
            Uploaded     = $true
        }
    } finally {
        Remove-Item -Path $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}
