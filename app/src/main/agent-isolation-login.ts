import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HOST_ENV_KEEP } from './agent-isolation.js';
import type { Provider } from '../shared/types.js';

/**
 * Official sign-in flows that need no browser inside the agent account. QRO-Agent has never logged
 * on interactively, so it has no browser and a localhost callback would never reach it; the user
 * finishes each flow in their own browser and the CLI polls (device code) or takes a pasted code.
 */
export function isolatedLoginArgs(provider: Provider): string[] {
  if (provider === 'openai') return ['login', '--device-auth'];
  if (provider === 'devin') return ['auth', 'login', '--force-manual-token-flow'];
  return ['auth', 'login', '--claudeai'];
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Official interactive login in the agent token/profile. No provider token is read by the office. */
export async function launchIsolatedLogin(input: {
  credential: { user: string; password: string };
  executable: string;
  provider: Provider;
  agentsRoot: string;
}): Promise<void> {
  const cwd = path.join(input.agentsRoot, '.login');
  mkdirSync(cwd, { recursive: true });
  const script = path.join(cwd, `login-${randomUUID()}.ps1`);
  writeFileSync(
    script,
    [
      "$ErrorActionPreference = 'Stop'",
      // Evidence that the window owns its console: both must be false for typing and output to work.
      `[IO.File]::WriteAllText(${quote(script + '.console.json')}, (@{ user = [Environment]::UserName; inputRedirected = [Console]::IsInputRedirected; outputRedirected = [Console]::IsOutputRedirected } | ConvertTo-Json -Compress))`,
      "$profileRoot = [Environment]::GetFolderPath('UserProfile')",
      '$env:USERPROFILE = $profileRoot; $env:HOME = $profileRoot; $env:USERNAME = [Environment]::UserName',
      "$env:APPDATA = Join-Path $profileRoot 'AppData\\Roaming'; $env:LOCALAPPDATA = Join-Path $profileRoot 'AppData\\Local'",
      "$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'; $env:TMP = $env:TEMP; [void][IO.Directory]::CreateDirectory($env:TEMP)",
      "$env:DISABLE_AUTOUPDATER = '1'",
      "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine')",
      "$env:HOMEDRIVE = [IO.Path]::GetPathRoot($profileRoot).TrimEnd('\\'); $env:HOMEPATH = $profileRoot.Substring($env:HOMEDRIVE.Length)",
      `Write-Host 'Official ${input.provider} sign-in for the isolated agent account.'`,
      "Write-Host 'Open the link below in your own browser; paste any code it gives you back into this window.'",
      'whoami',
      // Retry in this window: a sign-in typed into another shell would run as the office user.
      'do {',
      ...(input.provider === 'claude'
        ? [
            // Claude reads the code as one stdin line, but its raw console mode swallows a paste.
            // PowerShell's own prompt accepts Ctrl+V and right-click, so the code is relayed.
            `  $psi = New-Object System.Diagnostics.ProcessStartInfo(${quote(input.executable)}, ${quote(
              isolatedLoginArgs(input.provider)
                .map(arg => `"${arg}"`)
                .join(' '),
            )})`,
            '  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true',
            '  $p = [System.Diagnostics.Process]::Start($psi); Start-Sleep -Seconds 3',
            "  $code = Read-Host 'Paste the code from the browser here (Ctrl+V or right-click), then press Enter'",
            '  $p.StandardInput.WriteLine($code.Trim()); $p.StandardInput.Close(); $p.WaitForExit(); $exit = $p.ExitCode',
          ]
        : [
            `  & ${quote(input.executable)} ${isolatedLoginArgs(input.provider).map(quote).join(' ')}`,
            '  $exit = $LASTEXITCODE',
          ]),
      "  if ($exit -ne 0) { $again = Read-Host 'Sign-in did not finish. Press Enter to try again here, or type Q to stop' }",
      "} while ($exit -ne 0 -and $again -ne 'q')",
      "Read-Host 'Close this window, then check the agent subscription in QRO'",
    ].join('\r\n'),
    'utf8',
  );
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    '$pw = [Console]::In.ReadLine()',
    '$sec = New-Object System.Security.SecureString; foreach ($ch in $pw.ToCharArray()) { $sec.AppendChar($ch) }; $sec.MakeReadOnly()',
    // A logon launch (ProcessStartInfo or Start-Process -Credential) hands the child this hidden
    // process's std handles — the closed password pipe and NUL — so a window started directly is
    // blank and ignores typing. A hidden cmd as the agent account runs `start`, whose new console
    // owns fresh input/output handles.
    `$cred = New-Object System.Management.Automation.PSCredential(${quote('.\\' + input.credential.user)}, $sec)`,
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `$cmdArgs = '/d /c start "QRO-Agent sign-in" "' + $ps + '" -NoProfile -ExecutionPolicy Bypass -File ' + ${quote(`"${script}"`)}`,
    `Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -Credential $cred -LoadUserProfile -WindowStyle Hidden -WorkingDirectory ${quote(cwd)} -ArgumentList $cmdArgs`,
  ].join('; ');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', bootstrap], {
      cwd,
      // Start-Process may pass this environment on, so only the host allowlist crosses — never
      // the office user's profile variables or provider keys.
      env: Object.fromEntries(HOST_ENV_KEEP.flatMap(key => (process.env[key] ? [[key, process.env[key]]] : []))),
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Opening the agent sign-in window timed out.'));
    }, 20_000);
    child.stdin.end(input.credential.password + '\r\n');
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error('The agent-account sign-in window could not be opened.'));
    });
  });
}
