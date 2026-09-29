import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  realpathSync,
  statSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { CliChild, CliSpawnOptions } from './local-cli-exec.js';
import type { Provider } from '../shared/types.js';

/**
 * LR-16 — a separate low-privilege Windows account (QRO-Agent) runs agent CLIs.
 *
 * There is no Node API to spawn-as-another-user on Windows, so the boundary is built from files
 * and one credential hop: the office launches a long-lived host (`agent-host.cjs`, written fresh
 * into the ACL'd sessions root) via `powershell → ProcessStartInfo` with the account credential — the password rides
 * the bootstrap's stdin, never argv — and the host then spawns each agent CLI itself, stdio
 * redirected to log files inside the same ACL'd channel. The office tails those files; every
 * request is a req-<id>.json the host polices (cwd must stay inside the sessions root).
 *
 * What isolation v1 is not: it does not give agents the office user's provider sign-ins — those
 * live in the office profile and do not transfer. Under isolation a dispatch must authenticate
 * with the provider API key saved in Settings (LR-15); without one the spawn refuses. The key
 * transits the request file — ACL'd to exactly the office account and QRO-Agent.
 */

/** The dedicated local account name the elevated setup creates and the office records. */
export const AGENT_USERNAME = 'QRO-Agent';

/** The payload written to a temp bundle and handed to the elevated setup script. */
export interface IsolationBundle {
  username: string;
  password: string;
  agentsRoot: string;
  toolDirs: string[];
  resultPath: string;
}

/** The elevated setup script's always-written report. */
export interface IsolationResult {
  ok: boolean;
  error?: string;
  created?: boolean;
  granted?: string[];
}

/**
 * The exact icacls argument vectors the elevated script runs — kept here as a pure function so
 * the plan is unit-tested verbatim. setup-agent-isolation.ps1 encodes the same two grants (keep
 * in sync): Modify+inheritance on the sessions root, Read+Execute+inheritance on each tool dir.
 */
export function buildAclPlan(bundle: Pick<IsolationBundle, 'username' | 'agentsRoot' | 'toolDirs'>): string[][] {
  return [
    [bundle.agentsRoot, '/grant', `${bundle.username}:(OI)(CI)M`, '/T'],
    ...bundle.toolDirs.map(dir => [dir, '/grant', `${bundle.username}:(OI)(CI)RX`, '/T']),
  ];
}

/**
 * The node.exe the credential hop launches for the agent host. It must resolve outside the
 * office user's own profile — the agent account cannot read into it — so profile-scoped
 * installs (nvm/fnm targets, scoop) are never selected. `C:\Program Files\nodejs\node.exe` is
 * preferred, then PATH order; candidates are realpath'd so a Program Files symlink that lands
 * inside the profile does not sneak through.
 */
export function resolveNodeExe(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
  realpath: (candidate: string) => string = c => realpathSync.native(c),
): string {
  const profileRaw = env.USERPROFILE || '';
  const profile = profileRaw
    .toLowerCase()
    .replaceAll('/', '\\')
    .replace(/[\\/]+$/, '');
  const outsideProfile = (candidate: string) => {
    if (!profile) return true;
    let resolved = candidate;
    try {
      resolved = realpath(candidate);
    } catch {
      /* keep the unresolved candidate for the prefix check */
    }
    const probe = resolved
      .toLowerCase()
      .replaceAll('/', '\\')
      .replace(/[\\/]+$/, '');
    return probe !== profile && !probe.startsWith(profile + '\\');
  };
  const candidates: string[] = [];
  candidates.push(path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  for (const entry of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean))
    candidates.push(path.join(entry, 'node.exe'));
  for (const candidate of candidates) if (exists(candidate) && outsideProfile(candidate)) return candidate;
  throw new Error('Node.js (node.exe) is required on PATH for agent isolation.');
}

/**
 * Where the bundled setup script lives: `scripts/agent-isolation/setup-agent-isolation.ps1`
 * relative to the app root in dev, and inside the packaged app.asar at the same relative offset
 * (package.mjs ships `scripts/`). __dirname is `dist/main` in both modes, so '../../scripts' lands
 * correctly either way. The script is copied to a temp file before elevation — an elevated
 * powershell cannot read inside the asar.
 */
export function isolationSetupScriptPath(dirname: string = __dirname): string {
  return path.join(dirname, '..', '..', 'scripts', 'agent-isolation', 'setup-agent-isolation.ps1');
}

/**
 * Where the host script source lives: `agent-host.cjs` ships next to the bundled main chunk
 * (build.mjs copies it into dist/main, package.mjs ships dist/main inside the asar — Electron's
 * patched fs reads it, and the office re-copies it into the ACL'd channel so plain node.exe can
 * read it there).
 */
export function agentHostSourcePath(dirname: string = __dirname): string {
  return path.join(dirname, 'agent-host.cjs');
}

/** Overwrite-then-delete for files that carried credential material — best effort, never throws. */
function scrubFile(file: string): void {
  try {
    writeFileSync(file, Buffer.alloc(Math.max(statSync(file).size, 1)));
  } catch {
    /* gone is the goal either way */
  }
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

function readIsolationResult(resultPath: string): IsolationResult | null {
  try {
    // Windows PowerShell 5.1's `Set-Content -Encoding UTF8` emits a BOM — strip it before parse.
    const parsed = JSON.parse(readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')) as Partial<IsolationResult>;
    return typeof parsed?.ok === 'boolean'
      ? (parsed as IsolationResult)
      : { ok: false, error: 'the result file was not an isolation setup report' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { ok: false, error: 'the result file could not be read' };
  }
}

export interface AgentIsolationSetupDeps {
  /** app.getPath('userData') — the sessions root is derived as <userData>\workspace\local-sessions. */
  userData: string;
  /** The encrypted store the credential lands in — injected, never imported. */
  secrets: { saveAgentUser(user: string, password: string): void };
  /** Resolves an installed provider CLI; throws when the provider is not installed. */
  toolPath(provider: Provider): string;
  /** Resolves node.exe outside the office profile; defaults to resolveNodeExe(). */
  nodeExe?: () => string;
  /** Temp dir for the bundle/script copy; tests point it at their scratch dir. */
  tmpdir?: () => string;
  uuid?: () => string;
  /** The packaged ps1; tests may point at the repo copy or a stub. */
  scriptPath?: string;
  /**
   * The elevation seam — the real default spawns `powershell → Start-Process -Verb RunAs -Wait`,
   * where the UAC prompt IS the user consent. Tests inject a same-process fake that just writes
   * the result file. Returns the outer powershell's exit code; the result JSON is authoritative.
   */
  elevate?: (scriptPath: string, bundlePath: string) => Promise<number | null>;
  log?: (line: string) => void;
}

/** The real elevation hop: a UAC-consented powershell running a temp copy of the setup script. */
async function defaultElevate(scriptPath: string, bundlePath: string): Promise<number | null> {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${quote(scriptPath)},'-Bundle',${quote(bundlePath)}`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  return new Promise((resolve, reject) => {
    child.on('exit', code => resolve(code));
    child.on('error', reject);
  });
}

/**
 * The one-time consented setup: generate the account password, collect the sessions root and the
 * tool dirs the agent must traverse, hand a bundle to the elevated script through a UAC prompt,
 * then persist the credential only when the script reports ok. Every temp artifact that carried
 * credential material is overwritten-then-deleted on the way out, success or failure.
 */
export async function setupAgentIsolation(deps: AgentIsolationSetupDeps): Promise<void> {
  const uuid = (deps.uuid ?? randomUUID)();
  const tmp = (deps.tmpdir ?? os.tmpdir)();
  const bundlePath = path.join(tmp, `qro-isolation-${uuid}.json`);
  const resultPath = path.join(tmp, `qro-isolation-${uuid}.result.json`);
  const scriptCopy = path.join(tmp, `qro-isolation-${uuid}.ps1`);
  try {
    const agentsRoot = path.join(deps.userData, 'workspace', 'local-sessions');
    mkdirSync(agentsRoot, { recursive: true });
    const password = randomBytes(48).toString('base64url');
    // Resolves or throws 'Node.js (node.exe) is required on PATH for agent isolation.'
    const nodeExe = (deps.nodeExe ?? resolveNodeExe)();
    // Every installed provider tool's install directory gets Read+Execute so the agent account
    // can run it; node.exe's own directory joins the plan for the same reason (a system install
    // is already world-readable, and the grant is harmless when redundant).
    const toolDirs = new Set<string>([path.dirname(nodeExe)]);
    for (const provider of ['claude', 'openai', 'devin'] as Provider[]) {
      try {
        toolDirs.add(path.dirname(deps.toolPath(provider)));
      } catch {
        /* a provider that is not installed needs no grant */
      }
    }
    const bundle: IsolationBundle = {
      username: AGENT_USERNAME,
      password,
      agentsRoot,
      toolDirs: [...toolDirs],
      resultPath,
    };
    writeFileSync(bundlePath, JSON.stringify(bundle), 'utf8');
    copyFileSync(deps.scriptPath ?? isolationSetupScriptPath(), scriptCopy);
    const elevate = deps.elevate ?? defaultElevate;
    try {
      await elevate(scriptCopy, bundlePath);
    } catch (error) {
      throw new Error(
        `Agent isolation setup failed: ${error instanceof Error ? error.message : 'the elevated step could not be launched'}`,
      );
    }
    const result = readIsolationResult(resultPath);
    if (!result?.ok)
      throw new Error(
        `Agent isolation setup failed: ${
          result?.error ?? 'the elevated step did not report a result — the consent prompt may have been declined'
        }`,
      );
    deps.secrets.saveAgentUser(AGENT_USERNAME, password);
    deps.log?.(
      `agent isolation configured: ${AGENT_USERNAME} ${result.created ? 'created' : 'already present'}, ${result.granted?.length ?? 0} ACL grant(s)`,
    );
  } finally {
    for (const file of [bundlePath, resultPath, scriptCopy]) scrubFile(file);
  }
}

/** The process the office launched for the host — the powershell bootstrap or a test's node. */
interface HostProcess {
  readonly stderr?: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface QroAgentSpawnDeps {
  secrets: { agentCredential(): { user: string; password: string; savedAt: string } | null };
  /** <userData>\workspace\local-sessions — the ACL'd root the host polices. */
  agentsRoot: string;
  log?: (line: string) => void;
  /**
   * The host launch seam. The default performs the credential hop; tests inject a same-user
   * `spawn(process.execPath, [hostSource, channelDir, process.pid])` so the whole file protocol
   * is exercised headless.
   */
  hostLauncher?: (channelDir: string) => HostProcess;
  hostSource?: string;
  nodeExe?: () => string;
  /** How long to wait for ready-<sessionId>.json before declaring the start failed. */
  readyTimeoutMs?: number;
  /** Log/exit file poll cadence; fs.watch still delivers the fast path. */
  pollMs?: number;
  uuid?: () => string;
}

/** The spawn seam handed to LocalCliExecAdapter — plus the office's shutdown handle. */
export interface QroAgentSpawn {
  (executable: string, args: string[], options: CliSpawnOptions): CliChild;
  /** Asks the host to kill its children and exit; used on office quit. Never throws. */
  shutdown(): void;
}

/**
 * The env keys the office lets cross into the agent child's environment — the same whitelist
 * agent-host.cjs enforces. Applied here too so office env never lands in the channel files at
 * all (defense in depth; the host-side check remains the enforcement).
 */
const ALLOWED_ENV = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|DEVIN_API_KEY|QRO_|NO_COLOR$|CI$)/;

/**
 * The only variables the credential bootstrap copies into the host's environment: system-wide
 * values that are the same for every account. The bootstrap adds the machine Path and a TEMP
 * inside the host tree; nothing user-specific from the office profile crosses.
 */
export const HOST_ENV_KEEP = [
  'SystemRoot',
  'windir',
  'SystemDrive',
  'ComSpec',
  'PATHEXT',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ALLUSERSPROFILE',
  'PUBLIC',
];

function sanitizedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env))
    if (ALLOWED_ENV.test(key) && typeof value === 'string') out[key] = value;
  return out;
}

/**
 * The isolated spawn surface: one lazily-started agent host per office run, requests delivered
 * as files, and each CliChild's streams fed by tailing the host-written logs in the channel.
 * Host start failure is reported as a child that emits 'error' — dispatches fail closed.
 */
export function qroAgentSpawn(deps: QroAgentSpawnDeps): QroAgentSpawn {
  const uuid = deps.uuid ?? randomUUID;
  const pollMs = deps.pollMs ?? 150;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 20_000;
  const hostDir = path.join(deps.agentsRoot, '.host');
  const hostSource = deps.hostSource ?? agentHostSourcePath();
  const launcher = deps.hostLauncher ?? defaultLauncher;
  const live = new Set<IsoChild>();

  type HostState =
    | { kind: 'idle' }
    | { kind: 'starting'; ready: Promise<void> }
    | { kind: 'ready'; channelDir: string }
    | { kind: 'failed'; error: string };
  let hostState: HostState = { kind: 'idle' };

  /** Atomic-ish request delivery: write <name>.tmp then rename — the host only sees .json names. */
  function post(channelDir: string, name: string, value: unknown): void {
    const target = path.join(channelDir, name);
    writeFileSync(target + '.tmp', JSON.stringify(value), 'utf8');
    renameSync(target + '.tmp', target);
  }

  /**
   * The credential hop: a powershell that reads the password from its own stdin and starts the
   * agent host as QRO-Agent through ProcessStartInfo (CreateProcessWithLogonW, profile loaded),
   * waiting on it. The host's environment is built explicitly from HOST_ENV_KEEP — that is what
   * spawned children inherit outside the whitelisted office keys, never the office env.
   * Found in the real-account acceptance on 2026-09-29, and why this is not Start-Process:
   * - `-UseNewEnvironment` rebuilds the block from the registry only, which drops SystemRoot
   *   (node.exe then aborts at startup on `ncrypto::CSPRNG`) and pulls in the office user's HKCU
   *   variables; without it, the Start-Process credential logon failed with "Access is denied".
   * - node realpaths its main script by lstat-ing every parent folder, and QRO-Agent may not
   *   look inside the office profile that holds userData. `--preserve-symlinks(-main)` skip that
   *   walk; the script itself is readable through the sessions-root grant.
   */
  function defaultLauncher(channelDir: string): HostProcess {
    const credential = deps.secrets.agentCredential();
    if (!credential) throw new Error('no agent account credential is saved');
    const nodeExe = (deps.nodeExe ?? resolveNodeExe)();
    const script = path.join(hostDir, 'agent-host.cjs');
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const bootstrap = [
      '$pw = [Console]::In.ReadLine()',
      // Build the SecureString with .NET directly. Some managed Windows PowerShell environments
      // can discover Microsoft.PowerShell.Security but fail to import it in this bootstrap.
      '$sec = New-Object System.Security.SecureString; foreach ($ch in $pw.ToCharArray()) { $sec.AppendChar($ch) }; $sec.MakeReadOnly()',
      // '--no-maglev' must precede the script: V8 Maglev JIT __fastfail's (0xC0000409) on
      // CFG/CET-enforcing Windows builds (nodejs/node#62260, e.g. Server 2025 CI). The host is
      // the only long-lived process in the chain — the sole candidate to tier up to Maglev; the
      // provider grandchildren are short-lived and can't be flagged anyway.
      `$si = New-Object System.Diagnostics.ProcessStartInfo(${quote(nodeExe)}, ${quote(`--no-maglev --preserve-symlinks --preserve-symlinks-main "${script}" "${channelDir}" ${process.pid}`)})`,
      "$si.UserName = $env:QRO_ISO_USER; $si.Domain = '.'; $si.Password = $sec; $si.LoadUserProfile = $true",
      `$si.UseShellExecute = $false; $si.CreateNoWindow = $true; $si.WorkingDirectory = ${quote(hostDir)}`,
      // The host's whole environment is built here: system-wide keys only, the machine Path, and
      // a temp folder inside the ACL'd host tree. Nothing from the office profile crosses.
      `$tmp = ${quote(path.join(hostDir, 'tmp'))}; [void][IO.Directory]::CreateDirectory($tmp)`,
      '$si.EnvironmentVariables.Clear()',
      `foreach ($k in @(${HOST_ENV_KEEP.map(quote).join(',')})) { $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $si.EnvironmentVariables[$k] = $v } }`,
      "$si.EnvironmentVariables['Path'] = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
      "$si.EnvironmentVariables['TEMP'] = $tmp; $si.EnvironmentVariables['TMP'] = $tmp",
      // The host's stderr comes back through this bootstrap, so a start failure is reported.
      '$si.RedirectStandardError = $true',
      '$p = [System.Diagnostics.Process]::Start($si); $err = $p.StandardError.ReadToEnd(); $p.WaitForExit(); [Console]::Error.Write($err); exit $p.ExitCode',
    ].join('; ');
    const proc = spawn('powershell.exe', ['-NoProfile', '-Command', bootstrap], {
      // Start-Process inherits its caller's working directory. Keep that directory inside the
      // ACL-granted host tree so the low-privilege account can create the process successfully.
      cwd: hostDir,
      env: { ...process.env, QRO_ISO_USER: credential.user },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.stdin.write(credential.password + '\r\n');
    proc.stdin.end();
    return proc;
  }

  function startHost(): Promise<void> {
    return new Promise(resolve => {
      const fail = (why: string) => {
        hostState = { kind: 'failed', error: why };
        resolve();
      };
      try {
        mkdirSync(hostDir, { recursive: true });
        // The host runs outside the bundle — always a fresh copy of the shipped source.
        writeFileSync(path.join(hostDir, 'agent-host.cjs'), readFileSync(hostSource));
      } catch (error) {
        return fail(`the agent host could not be staged: ${error instanceof Error ? error.message : String(error)}`);
      }
      const channelDir = path.join(hostDir, `run-${uuid()}`);
      let proc: HostProcess;
      try {
        proc = launcher(channelDir);
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'the host launcher failed');
      }
      const readyFile = path.join(channelDir, `ready-${path.basename(channelDir)}.json`);
      let stderrTail = '';
      proc.stderr?.on('data', chunk => {
        stderrTail = (stderrTail + String(chunk)).slice(-2048);
      });
      const detail = () => (stderrTail.trim() ? `: ${stderrTail.trim().slice(0, 400)}` : '');
      proc.on('exit', code => {
        if (hostState.kind === 'ready') {
          hostState = { kind: 'failed', error: `the agent host exited (code ${code})` };
          for (const child of [...live])
            child.fail(new Error(`Agent isolation host exited while the spawn was running (code ${code}).`));
        } else if (hostState.kind === 'starting') {
          fail(`the host launcher exited (code ${code}) before reporting ready${detail()}`);
        }
      });
      proc.on('error', error => {
        if (hostState.kind === 'ready') {
          hostState = { kind: 'failed', error: `the agent host errored: ${error.message}` };
          for (const child of [...live])
            child.fail(new Error(`Agent isolation host errored while the spawn was running: ${error.message}`));
        } else if (hostState.kind === 'starting') {
          fail(`the host launcher errored: ${error.message}`);
        }
      });
      const deadline = Date.now() + readyTimeoutMs;
      const timer = setInterval(() => {
        if (hostState.kind !== 'starting') {
          clearInterval(timer);
          return;
        }
        if (existsSync(readyFile)) {
          clearInterval(timer);
          hostState = { kind: 'ready', channelDir };
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          try {
            proc.kill();
          } catch {
            /* the failure record is what matters */
          }
          fail(`the agent host never wrote its ready file within ${Math.round(readyTimeoutMs / 1000)}s`);
        }
      }, 50);
      timer.unref?.();
    });
  }

  function ensureHost(): Promise<void> {
    if (hostState.kind === 'starting') return hostState.ready;
    if (hostState.kind === 'idle') hostState = { kind: 'starting', ready: startHost() };
    return hostState.kind === 'starting' ? hostState.ready : Promise.resolve();
  }

  /**
   * A CliChild whose streams are fed by tailing out-<id>.log / err-<id>.log in the channel, and
   * whose lifecycle is the host-written exit-<id>.json — {code,signal} on a real exit, or
   * {code:null,signal:null,error} when the host refused or could not start the child (reported
   * as an 'error' event, like a real spawn that never produced a process).
   */
  class IsoChild implements CliChild {
    readonly pid = undefined;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    private readonly listeners = {
      exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[],
      error: [] as ((error: Error) => void)[],
    };
    private offsets = { out: 0, err: 0 };
    private channelDir: string | null = null;
    private wantsCancel = false;
    private done = false;
    private timer: ReturnType<typeof setInterval> | undefined;
    private watcher: FSWatcher | null = null;
    constructor(private readonly id: string) {}
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'exit' | 'error', listener: unknown) {
      if (event === 'exit')
        this.listeners.exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      else this.listeners.error.push(listener as (error: Error) => void);
      return this;
    }
    kill(): boolean {
      if (this.done) return false;
      this.wantsCancel = true;
      return this.deliver(`req-${this.id}-cancel.json`, { op: 'cancel', id: this.id });
    }
    private deliver(name: string, request: Record<string, unknown>): boolean {
      if (!this.channelDir) return true; // host not ready yet — the cancel lands on bind
      try {
        post(this.channelDir, name, request);
        return true;
      } catch {
        return false;
      }
    }
    /** Binds the child to the started host's channel and posts its spawn request. */
    bind(channelDir: string, request: Record<string, unknown>): void {
      if (this.done) return;
      this.channelDir = channelDir;
      try {
        post(channelDir, `req-${this.id}.json`, request);
        // A cancel that arrived before the host was up still lands: the host records cancelled
        // ids, so whichever order the two files are read the spawn is refused cleanly.
        if (this.wantsCancel) post(channelDir, `req-${this.id}-cancel.json`, { op: 'cancel', id: this.id });
      } catch (error) {
        return this.fail(error instanceof Error ? error : new Error('the spawn request could not be delivered'));
      }
      this.timer = setInterval(() => this.poll(), pollMs);
      this.timer.unref?.();
      try {
        // The watch target must be the realpath'd dir: libuv's win fs-event asserts
        // !_wcsnicmp(filename, dir, dirlen) when the watched path carries an 8.3 short-name
        // (e.g. %TEMP% = C:\Users\RUNNER~1\… on CI) and the abort kills the process — the same
        // convention local-cli-exec.ts already uses. Events report basenames only, so the
        // canonicalized watch still matches this child's files.
        this.watcher = watch(realpathSync.native(channelDir), (_event, name) => {
          if (name === `out-${this.id}.log` || name === `err-${this.id}.log` || name === `exit-${this.id}.json`)
            this.poll();
        });
        this.watcher.unref?.();
      } catch {
        /* the poll alone still tails */
      }
      this.poll();
    }
    private drain(stream: 'out' | 'err'): void {
      if (!this.channelDir) return;
      const file = path.join(this.channelDir, `${stream}-${this.id}.log`);
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        return; // not written yet — the poll keeps looking
      }
      if (size <= this.offsets[stream]) return;
      const fd = openSync(file, 'r');
      try {
        const chunk = Buffer.alloc(size - this.offsets[stream]);
        readSync(fd, chunk, 0, chunk.length, this.offsets[stream]);
        (stream === 'out' ? this.stdout : this.stderr).push(chunk);
      } finally {
        closeSync(fd);
      }
      this.offsets[stream] = size;
    }
    /** One poll pass: drain both logs, then honor a fresh exit record. */
    private poll(): void {
      if (this.done || !this.channelDir) return;
      this.drain('out');
      this.drain('err');
      let record: { code?: number | null; signal?: string | null; error?: string };
      try {
        record = JSON.parse(readFileSync(path.join(this.channelDir, `exit-${this.id}.json`), 'utf8'));
      } catch {
        return; // absent or mid-rename — the next poll sees the settled bytes
      }
      this.finish(record);
    }
    private finish(record: { code?: number | null; signal?: string | null; error?: string }): void {
      if (this.done) return;
      this.done = true;
      // One last drain so bytes flushed just before the exit record still land on the streams.
      this.drain('out');
      this.drain('err');
      this.stdout.push(null);
      this.stderr.push(null);
      this.dispose();
      live.delete(this);
      if (record.error != null) this.emitError(new Error(String(record.error)));
      else this.emitExit(record.code ?? null, (record.signal ?? null) as NodeJS.Signals | null);
    }
    fail(error: Error): void {
      this.finish({ error: error.message });
    }
    private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
      for (const listener of this.listeners.exit) listener(code, signal);
    }
    private emitError(error: Error): void {
      for (const listener of this.listeners.error) listener(error);
    }
    private dispose(): void {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      try {
        this.watcher?.close();
      } catch {
        /* a dead watcher reports nothing */
      }
      this.watcher = null;
    }
  }

  const spawnAs = ((executable: string, args: string[], options: CliSpawnOptions): CliChild => {
    const id = uuid();
    const child = new IsoChild(id);
    live.add(child);
    const request = {
      op: 'spawn',
      id,
      exe: executable,
      argv: args,
      cwd: options.cwd,
      env: sanitizedEnv(options.env),
    };
    void ensureHost().then(() => {
      if (hostState.kind === 'ready') child.bind(hostState.channelDir, request);
      else
        child.fail(
          new Error(
            `Agent isolation host failed to start: ${
              hostState.kind === 'failed' ? hostState.error : 'the agent host is not running'
            }`,
          ),
        );
    });
    return child;
  }) as QroAgentSpawn;

  spawnAs.shutdown = () => {
    try {
      if (hostState.kind === 'ready') post(hostState.channelDir, `req-${uuid()}.json`, { op: 'shutdown' });
      for (const child of [...live]) child.fail(new Error('the office is shutting down'));
      hostState = { kind: 'idle' };
    } catch {
      /* shutdown is best-effort — the office is going away regardless */
    }
  };
  return spawnAs;
}
