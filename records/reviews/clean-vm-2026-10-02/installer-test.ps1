# Clean-VM acceptance helper for the Quant Research Office unsigned installer.
# Run inside the VM:  powershell -NoProfile -ExecutionPolicy Bypass -File Q:\installer-test.ps1 -Step <name>
# Steps, in order: install-old, install-new, rollback, uninstall
param([Parameter(Mandatory = $true)][ValidateSet('install-old', 'install-new', 'rollback', 'uninstall')][string]$Step)
$ErrorActionPreference = 'Stop'
$share = 'Q:\'
$log = 'R:\installer-test.log'
$app = Join-Path $env:ProgramFiles 'Quant Research Office'
$workspace = Join-Path $env:APPDATA 'Quant Research Office'
$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{6F3B2C1A-9D4E-4B7A-8C21-5E0F7A9B3D64}_is1'
# Expected digests recorded on the build machine (separate channel from the installers themselves).
$releases = @{
    old = @{ commit = '1fb488ba2c73a0ee76b0c48dbdf09d8c85181f2d'; sha = '3BBADCB3576E33571EF83B3DD0A4DE7C4557418126A6EC82E5914EA584E6D048' }
    new = @{ commit = '43b2f06c9d9d07d0cbc98131d3d39f056974b084'; sha = '979362505691178308AD79536EE287FA56F88F0C11D4875DBDD2344AEF7899B1' }
}
function Log([string]$m) { $line = "$(Get-Date -Format s) [$Step] $m"; Write-Host $line; Add-Content -LiteralPath $log -Value $line }
function Check-Installed([string]$which) {
    if (-not (Test-Path -LiteralPath (Join-Path $app 'Quant Research Office.exe'))) { Log "FAIL app not found in $app"; throw 'Not installed' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $share 'verify-portable.ps1') -PackageDirectory $app -Installed | Out-Host
    if ($LASTEXITCODE -ne 0) { Log "FAIL verify installed files $which"; throw 'Verifier failed' }
    $commit = (Get-Content -LiteralPath (Join-Path $app 'qro-release.json') -Raw | ConvertFrom-Json).sourceCommit
    Log "$(if ($commit -eq $releases[$which].commit) { 'PASS' } else { 'FAIL' }) installed source commit $commit (expected $which)"
    Log "INFO app.asar $((Get-FileHash -LiteralPath (Join-Path $app 'resources\app.asar') -Algorithm SHA256).Hash)"
    $writers = @((Get-Acl -LiteralPath $app).Access | Where-Object {
            $_.IdentityReference -match 'Users|Everyone|Authenticated' -and $_.AccessControlType -eq 'Allow' -and
            ($_.FileSystemRights.ToString() -match 'Write|Modify|FullControl') })
    Log "$(if ($writers.Count -eq 0) { 'PASS' } else { 'FAIL' }) install folder not writable by ordinary users ($($writers.Count) write grants)"
    $reg = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
    Log "$(if ($reg) { 'PASS' } else { 'FAIL' }) Installed apps entry: $($reg.DisplayName) $($reg.DisplayVersion)"
    $menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Quant Research Office.lnk'
    Log "$(if (Test-Path -LiteralPath $menu) { 'PASS' } else { 'FAIL' }) Start menu shortcut"
}
function Run-Setup([string]$which, [bool]$markDownloaded) {
    $r = $releases[$which]
    $src = Join-Path $share "qro-$($r.commit)-win-x64-setup.exe"
    $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
    if ($hash -ne $r.sha) { Log "FAIL installer hash $which got $hash"; throw 'Installer hash mismatch' }
    Log "PASS installer hash $which $hash"
    $local = Join-Path $env:USERPROFILE "Downloads\qro-$which-setup.exe"
    Copy-Item -LiteralPath $src -Destination $local -Force
    if ($markDownloaded) {
        # Mark it as downloaded from the internet (what a browser does), so SmartScreen behaves as for a real user.
        Set-Content -LiteralPath $local -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://example.invalid/qro-setup.exe"
        Log "INFO marked $local as downloaded (Zone 3)"
    }
    Log "INFO signature=$((Get-AuthenticodeSignature -LiteralPath $local).Status)"
    Log "ACTION opening installer: note any SmartScreen/unknown-publisher warning, approve UAC, finish the wizard"
    Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$local`""
    Read-Host 'Press Enter here after the installer has finished (leave the app closed)'
    if (Get-Process -Name 'Quant Research Office' -ErrorAction SilentlyContinue) { Read-Host 'Close Quant Research Office, then press Enter' }
}
if ($Step -eq 'install-old') {
    $os = Get-CimInstance Win32_OperatingSystem
    Log "INFO OS $($os.Caption) build $($os.BuildNumber) user $env:USERNAME"
    foreach ($tool in 'node', 'git', 'claude', 'codex', 'devin') { Log "INFO prerequisite $tool present=$([bool](Get-Command $tool -ErrorAction SilentlyContinue))" }
    Log "INFO workspace existed before first install=$(Test-Path -LiteralPath $workspace)"
    Run-Setup 'old' $true
    Check-Installed 'old'
    Log 'ACTION open the app from Start, create a project, close, reopen (persistence), close, then run install-new'
}
elseif ($Step -eq 'install-new') {
    Run-Setup 'new' $false
    Check-Installed 'new'
    Log 'ACTION open the app from Start: project still there? Make a backup in Settings > Data & recovery, close, then run rollback'
}
elseif ($Step -eq 'rollback') {
    Run-Setup 'old' $false
    Check-Installed 'old'
    Log 'ACTION open the app from Start: project still there? Close, then run uninstall'
}
elseif ($Step -eq 'uninstall') {
    if (Get-Process -Name 'Quant Research Office' -ErrorAction SilentlyContinue) { throw 'Close Quant Research Office first.' }
    Log 'ACTION uninstall from Settings > Apps > Installed apps > Quant Research Office (approve UAC)'
    Start-Process 'ms-settings:appsfeatures'
    Read-Host 'Press Enter here after the uninstall has finished'
    # The uninstaller removes itself and the folder a moment after its window closes.
    for ($i = 0; $i -lt 15 -and (Test-Path -LiteralPath $app); $i++) { Start-Sleep -Seconds 1 }
    if (Test-Path -LiteralPath $app) { Get-ChildItem -LiteralPath $app -Recurse -Force | ForEach-Object { Log "INFO left behind: $($_.FullName)" } }
    Log "$(if (Test-Path -LiteralPath $app) { 'FAIL' } else { 'PASS' }) install folder removed: $app"
    Log "$(if (Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue) { 'FAIL' } else { 'PASS' }) Installed apps entry removed"
    $menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Quant Research Office.lnk'
    Log "$(if (Test-Path -LiteralPath $menu) { 'FAIL' } else { 'PASS' }) Start menu shortcut removed"
    $svc = @(Get-Service | Where-Object { $_.DisplayName -match 'Quant Research' }).Count
    $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'Quant|QRO' }).Count
    Log "INFO services=$svc scheduled tasks=$tasks"
    Log "$(if (Test-Path -LiteralPath $workspace) { 'PASS' } else { 'FAIL' }) workspace preserved after uninstall: $workspace"
}
