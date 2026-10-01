<#
  Quant Research Office — agent isolation setup (LR-16).

  Runs elevated via Start-Process -Verb RunAs after the office writes a bundle JSON to a temp
  file; the UAC prompt is the user's consent. Reads the bundle (-Bundle), performs the one-time
  account + ACL work, and ALWAYS writes a result JSON ({ok, error, created, granted[]}) to
  -ResultPath (default: the bundle's own resultPath) before exiting.

  Steps: create the low-privilege local account (or rotate its password when it already exists),
  assert it is not an Administrator, create the sessions root, then grant Modify+inheritance on
  the sessions root (/T so sessions written earlier are covered) and Read+Execute+inheritance on
  each tool directory the agent account must launch. These icacls vectors mirror buildAclPlan()
  in src/main/agent-isolation.ts — keep them in sync.
#>
param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [string]$ResultPath
)
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok = $false; created = $false; granted = @() }
$b = $null
try {
  $b = Get-Content -LiteralPath $Bundle -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  $result.error = "the setup bundle could not be read: $($_.Exception.Message)"
}
if (-not $ResultPath) {
  $ResultPath = if ($b -and $b.resultPath) { [string]$b.resultPath } else { "$Bundle.result.json" }
}
if ($b) {
  try {
    $user = [string]$b.username
    $existing = $null
    if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
      $existing = Get-LocalUser -Name $user -ErrorAction SilentlyContinue
    } else {
      net user $user 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $existing = $true }
    }
    if (-not $existing) {
      if (Get-Command New-LocalUser -ErrorAction SilentlyContinue) {
        New-LocalUser -Name $user `
          -Password (ConvertTo-SecureString ([string]$b.password) -AsPlainText -Force) `
          -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
      } else {
        # Older Home SKUs lack the LocalAccounts cmdlets — net.exe is the documented fallback.
        net user $user ([string]$b.password) /add | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "net user failed to create $user (code $LASTEXITCODE)" }
      }
      $result.created = $true
    } else {
      # A re-run after 'Remove isolation' must still bind the new bundle password to the account.
      if (Get-Command Set-LocalUser -ErrorAction SilentlyContinue) {
        Set-LocalUser -Name $user -Password (ConvertTo-SecureString ([string]$b.password) -AsPlainText -Force)
      } else {
        net user $user ([string]$b.password) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "net user failed to set the $user password (code $LASTEXITCODE)" }
      }
    }
    # New-LocalUser does not guarantee membership in the standard Users group. Without that
    # baseline group, Windows can refuse the credential logon the office uses to start the agent host.
    $sid = (New-Object System.Security.Principal.NTAccount($user)).Translate(
      [System.Security.Principal.SecurityIdentifier]).Value
    if (Get-Command Get-LocalGroupMember -ErrorAction SilentlyContinue) {
      $userSids = @(Get-LocalGroupMember -Group 'Users' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.SID.Value })
      $inUsers = $userSids -contains $sid
    } else {
      $inUsers = @((net localgroup Users) |
        Where-Object { $_ -eq $user -or $_ -like "*\$user" }).Count -gt 0
    }
    if (-not $inUsers) {
      if (Get-Command Add-LocalGroupMember -ErrorAction SilentlyContinue) {
        Add-LocalGroupMember -Group 'Users' -Member $user
      } else {
        net localgroup Users $user /add | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "net localgroup Users failed to add $user (code $LASTEXITCODE)" }
      }
    }
    # A local account that can administer the machine defeats the isolation boundary — refuse it.
    $admin = $false
    if (Get-Command Get-LocalGroupMember -ErrorAction SilentlyContinue) {
      $admin = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.SID.Value }) -contains $sid
    } else {
      $admin = @((net localgroup Administrators) |
        Where-Object { $_ -eq $user -or $_ -like "*\$user" }).Count -gt 0
    }
    if ($admin) { throw "$user is a member of Administrators — refusing to use an admin account for agent isolation" }
    if ($b.officeRoot) {
      $privateRoot = [IO.Path]::GetFullPath([string]$b.officeRoot).TrimEnd('\')
      $packetRoot = [IO.Path]::GetFullPath([string]$b.agentsRoot)
      if (-not $packetRoot.StartsWith($privateRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
          [string]$b.officeSid -notmatch '^S-1-5-[0-9-]+$') { throw 'Invalid office privacy scope or identity' }
      # Grant the owner before removing inherited broad Users access. The packet-root grant below
      # remains explicit; no ACL outside the selected office data root is tightened.
      $out = icacls $privateRoot /grant:r "*$($b.officeSid):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Office owner grant failed: $out" }
      $out = icacls $privateRoot /inheritance:r 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Office privacy inheritance failed: $out" }
      $out = icacls $privateRoot /remove:g '*S-1-1-0' '*S-1-5-11' '*S-1-5-32-545' $user 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Office broad-access removal failed: $out" }
    }
    New-Item -ItemType Directory -Force ([string]$b.agentsRoot) | Out-Null
    $out = icacls ([string]$b.agentsRoot) /grant "${user}:(OI)(CI)M" /T 2>&1
    if ($LASTEXITCODE -ne 0) { throw "icacls on the sessions root failed ($LASTEXITCODE): $out" }
    $result.granted += [string]$b.agentsRoot
    foreach ($dir in @($b.toolDirs)) {
      $out = icacls ([string]$dir) /grant "${user}:(OI)(CI)RX" /T 2>&1
      if ($LASTEXITCODE -ne 0) { throw "icacls on tool directory $dir failed ($LASTEXITCODE): $out" }
      $result.granted += [string]$dir
    }
    $result.ok = $true
  } catch {
    $result.ok = $false
    $result.error = $_.Exception.Message
  }
}
try {
  # BOM-free UTF-8: Windows PowerShell 5.1's `-Encoding UTF8` emits a BOM that JSON.parse rejects.
  [System.IO.File]::WriteAllText(
    $ResultPath,
    ($result | ConvertTo-Json -Compress),
    (New-Object System.Text.UTF8Encoding($false))
  )
} catch {
  # Nothing left to report through — the office treats a missing result as a failed setup.
}
