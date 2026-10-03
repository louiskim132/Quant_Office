# Clean-VM acceptance helper for the Quant Research Office portable release.
# Run inside the VM:  powershell -NoProfile -ExecutionPolicy Bypass -File Q:\clean-test.ps1 -Step <name>
# Steps, in order: install-old, install-new, rollback, uninstall
param([Parameter(Mandatory = $true)][ValidateSet('install-old', 'install-new', 'rollback', 'uninstall')][string]$Step)
$ErrorActionPreference = 'Stop'
$share = 'Q:\'
$log = 'R:\clean-test.log'
$versions = Join-Path $env:LOCALAPPDATA 'QuantResearchOffice\versions'
$workspace = Join-Path $env:APPDATA 'Quant Research Office'
# Expected digests recorded on the build machine (separate channel from the ZIPs themselves).
$releases = @{
    old = @{ commit = '1fb488ba2c73a0ee76b0c48dbdf09d8c85181f2d'; sha = 'E87A9D46F748BA323A409C8CAE1C80EB04A6BF3CDD6647818368FB1AD0AF45E0' }
    new = @{ commit = '80df1078572d83181ee12e0cd8167d27b36d581e'; sha = '116A9F12EEE36A9B223A1A1F72E115C00CE37EF6649626A1C3811FE016F9041A' }
}
function Log([string]$m) { $line = "$(Get-Date -Format s) [$Step] $m"; Write-Host $line; Add-Content -LiteralPath $log -Value $line }
function Install([string]$which) {
    $r = $releases[$which]
    $zip = Join-Path $share "qro-$($r.commit)-win-x64.zip"
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
    if ($hash -ne $r.sha) { Log "FAIL zip hash $which got $hash"; throw 'ZIP hash mismatch' }
    Log "PASS zip hash $which $hash"
    $dest = Join-Path $versions $r.commit
    if (Test-Path -LiteralPath $dest) { Log "INFO $dest already extracted by an earlier run; re-verifying it" }
    else {
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Expand-Archive -LiteralPath $zip -DestinationPath $dest
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $share 'verify-portable.ps1') -PackageDirectory $dest | Out-Host
    if ($LASTEXITCODE -ne 0) { Log "FAIL verify-portable $which exit $LASTEXITCODE"; throw 'Verifier failed' }
    Log "PASS verify-portable $which"
    $asar = (Get-FileHash -LiteralPath (Join-Path $dest 'resources\app.asar') -Algorithm SHA256).Hash
    Log "INFO app.asar $which $asar"
    $exe = Join-Path $dest 'Quant Research Office.exe'
    $sig = (Get-AuthenticodeSignature -LiteralPath $exe).Status
    $zone = if (Get-Item -LiteralPath $exe -Stream Zone.Identifier -ErrorAction SilentlyContinue) { 'present' } else { 'absent' }
    Log "INFO signature=$sig zone.identifier=$zone exe=$exe"
    return $exe
}
if ($Step -eq 'install-old') {
    $os = Get-CimInstance Win32_OperatingSystem
    Log "INFO OS $($os.Caption) build $($os.BuildNumber) user $env:USERNAME admin=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'))"
    foreach ($tool in 'node', 'git', 'claude', 'codex', 'devin') { Log "INFO prerequisite $tool present=$([bool](Get-Command $tool -ErrorAction SilentlyContinue))" }
    Log "INFO workspace existed before first launch=$(Test-Path -LiteralPath $workspace)"
    $exe = Install 'old'
    Start-Process -FilePath $exe
    Log 'ACTION launched old version: record first-launch observations, create a project, close the app, then run install-new'
}
elseif ($Step -eq 'install-new') {
    if (Get-Process -Name 'Quant Research Office' -ErrorAction SilentlyContinue) { throw 'Close Quant Research Office first.' }
    Log "INFO workspace present before update=$(Test-Path -LiteralPath $workspace)"
    $exe = Install 'new'
    Start-Process -FilePath $exe
    Log 'ACTION launched new version: confirm the project from the old version is still there, use Settings > Data & recovery backup, close, then run rollback'
}
elseif ($Step -eq 'rollback') {
    if (Get-Process -Name 'Quant Research Office' -ErrorAction SilentlyContinue) { throw 'Close Quant Research Office first.' }
    $exe = Join-Path $versions "$($releases.old.commit)\Quant Research Office.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw 'Old version folder missing.' }
    Start-Process -FilePath $exe
    Log 'ACTION launched retained old version: confirm it opens and the project is still there, close, then run uninstall'
}
elseif ($Step -eq 'uninstall') {
    if (Get-Process -Name 'Quant Research Office' -ErrorAction SilentlyContinue) { throw 'Close Quant Research Office first.' }
    foreach ($r in $releases.Values) {
        $dir = Join-Path $versions $r.commit
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force; Log "INFO removed $dir" }
    }
    $left = @(Get-ChildItem -LiteralPath $versions -Force -ErrorAction SilentlyContinue).Count
    $svc = @(Get-Service | Where-Object { $_.DisplayName -match 'Quant Research' }).Count
    $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'Quant|QRO' }).Count
    Log "INFO after uninstall: version folders left=$left services=$svc scheduled tasks=$tasks"
    Log "$(if (Test-Path -LiteralPath $workspace) { 'PASS' } else { 'FAIL' }) workspace preserved after uninstall: $workspace"
}
