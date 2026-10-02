param([Parameter(Mandatory = $true)][string]$PackageDirectory)
$ErrorActionPreference = 'Stop'
$releaseRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path.TrimEnd('\')
if ((Get-Item -LiteralPath $releaseRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Portable directory must not be a link.'
}
$releaseManifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'qro-release.json') -Raw | ConvertFrom-Json
if ($releaseManifest.format -ne 'QRO_PORTABLE_V1' -or $releaseManifest.signed -ne $false) {
    throw 'Unsupported portable manifest.'
}
# Walk one directory at a time; refuse a junction before ever traversing it.
function Get-ReleaseFiles([string]$Directory) {
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Portable artifact contains a link.' }
        if ($entry.PSIsContainer) { Get-ReleaseFiles $entry.FullName }
        else { $entry }
    }
}
$actualFiles = @(Get-ReleaseFiles $releaseRoot | Where-Object { $_.FullName -ne (Join-Path $releaseRoot 'qro-release.json') })
if ($actualFiles.Count -ne $releaseManifest.files.Count) { throw 'Portable inventory file count differs.' }
$seenPaths = @{}
foreach ($expected in $releaseManifest.files) {
    if ($expected.path -match '(^/|\\|(^|/)\.\.(/|$)|:)' -or $seenPaths.ContainsKey($expected.path)) {
        throw 'Invalid or duplicate manifest path.'
    }
    $seenPaths[$expected.path] = $true
    $actual = $actualFiles | Where-Object { $_.FullName.Substring($releaseRoot.Length + 1).Replace('\', '/') -ceq $expected.path }
    if (-not $actual -or $actual.Length -ne $expected.bytes) { throw "Missing or wrong-size file: $($expected.path)" }
    if ((Get-FileHash -LiteralPath $actual.FullName -Algorithm SHA256).Hash -ine $expected.sha256) {
        throw "Hash mismatch: $($expected.path)"
    }
}
Write-Output "PASS unsigned portable byte inventory; source commit $($releaseManifest.sourceCommit). Publisher trust is not established."
