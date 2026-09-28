import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../src/main/fsx';
import {
  AGENT_USERNAME,
  buildAclPlan,
  qroAgentSpawn,
  resolveNodeExe,
  setupAgentIsolation,
  type IsolationBundle,
  type QroAgentSpawn,
} from '../src/main/agent-isolation';
import { Secrets, type SecretBox } from '../src/main/secrets';
import type { CliChild, CliSpawnOptions } from '../src/main/local-cli-exec';

/**
 * Headless coverage for LR-16. The real credential hop (powershell → Start-Process -Credential →
 * the host as QRO-Agent) cannot run here — tests must never create Windows accounts, elevate, or
 * ACL real paths — so hostLauncher is injected to run the real shipped host script as the current
 * user. Everything except the account switch itself is exercised: the file protocol, the packet-
 * folder boundary, the env whitelist, cancel, shutdown, and the fail-closed start path.
 */
const HOST_SOURCE = path.resolve(import.meta.dirname, '..', 'src', 'main', 'agent-host.cjs');

/** A deterministic fake SecretBox — XOR-masked bytes, so ciphertext never equals plaintext. */
function stubBox(available = true): SecretBox {
  return {
    available: () => available,
    encrypt: plain => Buffer.from(Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0x5a)),
    decrypt: blob => Buffer.from(Array.from(blob, byte => byte ^ 0x5a)).toString('utf8'),
  };
}

function root(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-iso-'));
  t.after(() => removeTreeSync(dir));
  return dir;
}

/**
 * Runs the shipped host script as the current user — same file protocol, no credential hop.
 * The office pid it guards is this test process, which outlives every test.
 */
function sameUserHost(t: test.TestContext): {
  hostLauncher: (channelDir: string) => ChildProcess;
  procs: ChildProcess[];
} {
  const procs: ChildProcess[] = [];
  t.after(() => {
    for (const proc of procs)
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
  });
  return {
    procs,
    hostLauncher: channelDir => {
      // '--no-maglev' mirrors the production launcher: V8 Maglev __fastfail's on CFG-enforcing
      // Windows builds — a long-lived host is the only process in the chain that can tier up.
      const proc = spawn(process.execPath, ['--no-maglev', HOST_SOURCE, channelDir, String(process.pid)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // Deliberately NOT unref'd: every handle inside the channel is unref'd by design, so on a
      // loaded scheduler the loop could transiently hold zero ref'd handles while a test await is
      // pending — node then parks the file forever (the CI wedge this file hit). The live host
      // proc keeps the loop honest, and t.after still kills it so the process exits cleanly.
      procs.push(proc);
      return proc;
    },
  };
}

function spawnFixture(
  t: test.TestContext,
  dir: string,
): { spawnAs: QroAgentSpawn; agentsRoot: string; sessionDir: string; secrets: Secrets } {
  const agentsRoot = path.join(dir, 'workspace', 'local-sessions');
  const sessionDir = path.join(agentsRoot, 'session-a');
  mkdirSync(sessionDir, { recursive: true });
  const secrets = new Secrets(dir, stubBox());
  const { hostLauncher } = sameUserHost(t);
  const spawnAs = qroAgentSpawn({
    secrets,
    agentsRoot,
    hostLauncher,
    hostSource: HOST_SOURCE,
    readyTimeoutMs: 10000,
    pollMs: 20,
  });
  t.after(() => spawnAs.shutdown());
  return { spawnAs, agentsRoot, sessionDir, secrets };
}

function collect(child: CliChild) {
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on('data', chunk => out.push(String(chunk)));
  child.stderr?.on('data', chunk => err.push(String(chunk)));
  return {
    out,
    err,
    exited: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.on('exit', (code, signal) => resolve({ code, signal })),
    ),
    errored: new Promise<Error>(resolve => child.on('error', error => resolve(error))),
    /**
     * Whichever lifecycle event lands FIRST — a host-side spawn refusal/failure surfaces as
     * 'error' with the real message instead of silently outwaiting an 'exit' that never comes.
     */
    settled: new Promise<
      { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null } | { kind: 'error'; error: Error }
    >(resolve => {
      child.on('exit', (code, signal) => resolve({ kind: 'exit', code, signal }));
      child.on('error', error => resolve({ kind: 'error', error }));
    }),
  };
}

/**
 * Every host-driven await races a REF'd deadline timer: it holds the event loop open while the
 * channel settles, so a wedged host/protocol reports a fast explicit failure here instead of
 * node:test parking the file with zero ref'd handles (the exact CI symptom this guards).
 */
async function deadline<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after 15s waiting for ${what}`)), 15_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the channel's own evidence — host-trace.log and host-errors.log plus every err-*.log
 * under .host/run-*. On CI these files are the only window into a host that dies natively with
 * no JS stack.
 */
function channelEvidence(agentsRoot: string): string {
  try {
    const hostDir = path.join(agentsRoot, '.host');
    const chunks: string[] = [];
    for (const run of readdirSync(hostDir).filter(name => name.startsWith('run-'))) {
      const dir = path.join(hostDir, run);
      for (const name of readdirSync(dir).filter(
        name => name === 'host-errors.log' || name === 'host-trace.log' || /^err-.+\.log$/.test(name),
      )) {
        try {
          chunks.push(`${run}/${name}: ${readFileSync(path.join(dir, name), 'utf8').slice(0, 400)}`);
        } catch {
          /* vanished mid-read */
        }
      }
    }
    return chunks.join('\n').slice(0, 1600);
  } catch {
    return '';
  }
}

/** deadline + channel evidence on failure: a wedge or crash reports what the host last wrote. */
async function settle<T>(promise: Promise<T>, what: string, agentsRoot: string): Promise<T> {
  try {
    return await deadline(promise, what);
  } catch (error) {
    const evidence = channelEvidence(agentsRoot);
    throw new Error(`${(error as Error).message}${evidence ? `\nchannel evidence:\n${evidence}` : ''}`);
  }
}

const OPTS = (cwd: string, env: NodeJS.ProcessEnv = {}): CliSpawnOptions => ({
  cwd,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

test('isolated spawn: stdout bytes arrive and exit reports code 0', async t => {
  const dir = root(t);
  const { spawnAs, agentsRoot, sessionDir } = spawnFixture(t, dir);
  const child = spawnAs(process.execPath, ['-e', 'console.log("hi")'], OPTS(sessionDir));
  const seen = collect(child);
  const result = await settle(seen.settled, 'the spawned child to exit', agentsRoot);
  if (result.kind !== 'exit')
    assert.fail(
      `the child errored instead of exiting: ${result.error.message}\nchannel evidence:\n${channelEvidence(agentsRoot)}`,
    );
  assert.equal(result.code, 0);
  assert.ok(seen.out.join('').includes('hi'), `stdout carried the child output: ${seen.out.join('')}`);
});

test('isolated spawn: stderr bytes arrive on the stderr stream', async t => {
  const dir = root(t);
  const { spawnAs, agentsRoot, sessionDir } = spawnFixture(t, dir);
  const child = spawnAs(process.execPath, ['-e', 'console.error("oops")'], OPTS(sessionDir));
  const seen = collect(child);
  const result = await settle(seen.settled, 'the spawned child to exit', agentsRoot);
  if (result.kind !== 'exit')
    assert.fail(
      `the child errored instead of exiting: ${result.error.message}\nchannel evidence:\n${channelEvidence(agentsRoot)}`,
    );
  assert.ok(seen.err.join('').includes('oops'), `stderr carried the child output: ${seen.err.join('')}`);
});

test('isolated spawn: kill() delivers a cancel and the child exits', async t => {
  const dir = root(t);
  const { spawnAs, agentsRoot, sessionDir } = spawnFixture(t, dir);
  const child = spawnAs(process.execPath, ['-e', 'setInterval(()=>{},1e3)'], OPTS(sessionDir));
  const seen = collect(child);
  // Let the request reach the host before cancelling — either order must still converge on exit.
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(child.kill(), true);
  const result = await settle(seen.settled, 'the cancelled child to exit', agentsRoot);
  if (result.kind !== 'exit')
    assert.fail(
      `the child errored instead of exiting: ${result.error.message}\nchannel evidence:\n${channelEvidence(agentsRoot)}`,
    );
  const { code, signal } = result;
  assert.ok(code !== 0 || signal !== null, `a killed child reports a non-clean exit (${code}/${signal})`);
});

test('isolated spawn: the env whitelist drops office vars and keeps declared keys', async t => {
  const dir = root(t);
  const { spawnAs, agentsRoot, sessionDir } = spawnFixture(t, dir);
  const child = spawnAs(
    process.execPath,
    [
      '-e',
      'console.log(JSON.stringify({qx:process.env.QRO_X,ak:process.env.ANTHROPIC_API_KEY,pathOk:process.env.PATH!=="evil"}))',
    ],
    OPTS(sessionDir, { QRO_X: '1', PATH: 'evil', ANTHROPIC_API_KEY: 'sk-test-1' }),
  );
  const seen = collect(child);
  const result = await settle(seen.settled, 'the spawned child to exit', agentsRoot);
  if (result.kind !== 'exit')
    assert.fail(
      `the child errored instead of exiting: ${result.error.message}\nchannel evidence:\n${channelEvidence(agentsRoot)}`,
    );
  const payload = JSON.parse(seen.out.join('').trim());
  assert.equal(payload.qx, '1', 'QRO_* keys cross the channel');
  assert.equal(payload.ak, 'sk-test-1', 'the provider API key crosses the channel');
  assert.equal(payload.pathOk, true, 'the office PATH value never reaches the child');
});

test('isolated spawn: a cwd outside the sessions root is refused as an error', async t => {
  const dir = root(t);
  const { spawnAs, agentsRoot } = spawnFixture(t, dir);
  const outside = path.join(dir, 'not-a-session');
  mkdirSync(outside, { recursive: true });
  const child = spawnAs(process.execPath, ['-e', 'console.log("never")'], OPTS(outside));
  const result = await settle(collect(child).settled, 'the host to refuse the out-of-root cwd', agentsRoot);
  // The refusal must arrive AS an error record carrying the refusal reason — a host crash
  // ('host exited…') also surfaces 'error' but must not satisfy this assertion.
  if (result.kind !== 'error')
    assert.fail(
      `expected a refusal error, got exit code ${result.code}\nchannel evidence:\n${channelEvidence(agentsRoot)}`,
    );
  assert.ok(
    /outside the agent sessions root|refused/i.test(result.error.message),
    `expected a refusal message, got: ${result.error.message}\nchannel evidence:\n${channelEvidence(agentsRoot)}`,
  );
});

test('isolated spawn: a host that never reports ready fails closed with an error', async t => {
  const dir = root(t);
  const agentsRoot = path.join(dir, 'workspace', 'local-sessions');
  const sessionDir = path.join(agentsRoot, 'session-a');
  mkdirSync(sessionDir, { recursive: true });
  const spawnAs = qroAgentSpawn({
    secrets: new Secrets(dir, stubBox()),
    agentsRoot,
    // The launcher exits immediately — no ready file is ever written.
    hostLauncher: () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' }),
    hostSource: HOST_SOURCE,
    readyTimeoutMs: 4000,
    pollMs: 20,
  });
  t.after(() => spawnAs.shutdown());
  const child = spawnAs(process.execPath, ['-e', 'console.log("never")'], OPTS(sessionDir));
  const result = await settle(collect(child).settled, 'the host start failure to surface', agentsRoot);
  if (result.kind !== 'error')
    assert.fail(
      `expected a start-failure error, got exit code ${result.code}\nchannel evidence:\n${channelEvidence(agentsRoot)}`,
    );
  assert.match(result.error.message, /isolation/i);
});

test('secrets: the agent credential round-trips through the stub SecretBox', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-iso-secrets-'));
  try {
    const secrets = new Secrets(dir, stubBox());
    assert.equal(secrets.hasAgentCredential(), false);
    assert.equal(secrets.agentCredential(), null);
    secrets.saveAgentUser(AGENT_USERNAME, 'pw-' + 'x'.repeat(40));
    assert.equal(secrets.hasAgentCredential(), true);
    const credential = secrets.agentCredential()!;
    assert.equal(credential.user, 'QRO-Agent');
    assert.equal(credential.password, 'pw-' + 'x'.repeat(40));
    assert.ok(Date.parse(credential.savedAt), 'savedAt is a timestamp');
    const raw = readFileSync(path.join(dir, 'secrets.dat'), 'utf8');
    for (const leak of ['pw-', 'xxxx', 'QRO-Agent', 'agentUser', 'password'])
      assert.equal(raw.includes(leak), false, `secrets.dat carries no plaintext "${leak}"`);
    secrets.removeAgentUser();
    assert.equal(secrets.hasAgentCredential(), false);
    assert.equal(secrets.agentCredential(), null);
    // Removing a credential that was never there is a no-op, not an error.
    secrets.removeAgentUser();
  } finally {
    removeTreeSync(dir);
  }
});

test('buildAclPlan produces the exact icacls argument vectors', () => {
  const plan = buildAclPlan({
    username: 'QRO-Agent',
    agentsRoot: 'C:\\Users\\office\\AppData\\Roaming\\Quant Research Office\\workspace\\local-sessions',
    toolDirs: ['C:\\Program Files\\nodejs', 'C:\\Users\\office\\.local\\bin'],
  });
  assert.deepEqual(plan, [
    [
      'C:\\Users\\office\\AppData\\Roaming\\Quant Research Office\\workspace\\local-sessions',
      '/grant',
      'QRO-Agent:(OI)(CI)M',
      '/T',
    ],
    ['C:\\Program Files\\nodejs', '/grant', 'QRO-Agent:(OI)(CI)RX', '/T'],
    ['C:\\Users\\office\\.local\\bin', '/grant', 'QRO-Agent:(OI)(CI)RX', '/T'],
  ]);
});

test('resolveNodeExe prefers Program Files, walks PATH, and refuses profile installs', () => {
  const nodeUnderTools = 'C:\\tools\\node.exe';
  const resolved = resolveNodeExe(
    { PATH: 'C:\\tools', ProgramFiles: 'D:\\pf' },
    candidate => candidate === nodeUnderTools,
    candidate => candidate,
  );
  assert.equal(resolved, nodeUnderTools, 'a PATH node.exe outside the profile resolves');
  assert.throws(
    () =>
      resolveNodeExe(
        { USERPROFILE: 'C:\\Users\\office', PATH: 'C:\\Users\\office\\bin;C:\\tools' },
        candidate => candidate === 'C:\\Users\\office\\bin\\node.exe',
        candidate => candidate,
      ),
    /Node\.js \(node\.exe\) is required on PATH for agent isolation\./,
    'a node.exe only inside the office profile is never selected',
  );
  assert.throws(
    () =>
      resolveNodeExe(
        { ProgramFiles: 'D:\\pf' },
        () => false,
        candidate => candidate,
      ),
    /Node\.js \(node\.exe\) is required on PATH for agent isolation\./,
  );
  // A Program Files path that realpaths into the profile is still refused.
  assert.throws(
    () =>
      resolveNodeExe(
        { USERPROFILE: 'C:\\Users\\office', ProgramFiles: 'C:\\PF' },
        candidate => candidate === 'C:\\PF\\nodejs\\node.exe',
        () => 'C:\\Users\\office\\scoop\\apps\\nodejs\\node.exe',
      ),
    /required on PATH/,
  );
});

test('setup: a synthetic ok result lands the credential; bundle and result are scrubbed', async t => {
  const dir = root(t);
  const tmp = path.join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const script = path.join(dir, 'setup-agent-isolation.ps1');
  writeFileSync(script, '# stub\n');
  const secrets = new Secrets(dir, stubBox());
  let seen: IsolationBundle | undefined;
  await setupAgentIsolation({
    userData: dir,
    secrets,
    toolPath: provider => `C:\\tools\\${provider}\\tool.exe`,
    nodeExe: () => 'C:\\Program Files\\nodejs\\node.exe',
    tmpdir: () => tmp,
    uuid: () => 'test-uuid',
    scriptPath: script,
    // The injected elevation seam: no elevation, no accounts, no ACLs — the result file only.
    elevate: async (_scriptPath, bundlePath) => {
      const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as IsolationBundle;
      seen = bundle;
      writeFileSync(
        bundle.resultPath,
        JSON.stringify({ ok: true, created: true, granted: [bundle.agentsRoot, ...bundle.toolDirs] }),
      );
      return 0;
    },
  });
  assert.ok(seen, 'the bundle reached the elevated step');
  assert.equal(seen!.username, 'QRO-Agent');
  assert.equal(seen!.agentsRoot, path.join(dir, 'workspace', 'local-sessions'));
  assert.ok(seen!.password.length >= 32, 'the generated password is 32+ chars');
  assert.deepEqual(
    [...seen!.toolDirs].sort(),
    ['C:\\Program Files\\nodejs', 'C:\\tools\\claude', 'C:\\tools\\devin', 'C:\\tools\\openai'].sort(),
    'node.exe and every installed provider tool dir are in the plan',
  );
  assert.equal(seen!.resultPath, path.join(tmp, 'qro-isolation-test-uuid.result.json'));
  assert.equal(secrets.hasAgentCredential(), true);
  assert.equal(secrets.agentCredential()!.password, seen!.password, 'the stored password is the bundle one');
  // Every temp artifact that carried credential material is gone — overwritten then deleted.
  assert.deepEqual(
    readdirSync(tmp).filter(name => name.startsWith('qro-isolation-')),
    [],
    'bundle, result and script copy were scrubbed',
  );
});

test('setup script adds the isolated account to the standard Users group', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '../scripts/agent-isolation/setup-agent-isolation.ps1'),
    'utf8',
  );
  assert.match(source, /Get-LocalGroupMember -Group 'Users'/);
  assert.match(source, /Add-LocalGroupMember -Group 'Users' -Member \$user/);
  assert.match(source, /net localgroup Users \$user \/add/);
});

test('setup: a failed elevated step throws and persists no credential', async t => {
  const dir = root(t);
  const tmp = path.join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const script = path.join(dir, 'setup-agent-isolation.ps1');
  writeFileSync(script, '# stub\n');
  const secrets = new Secrets(dir, stubBox());
  await assert.rejects(
    setupAgentIsolation({
      userData: dir,
      secrets,
      toolPath: provider => `C:\\tools\\${provider}\\tool.exe`,
      nodeExe: () => 'C:\\Program Files\\nodejs\\node.exe',
      tmpdir: () => tmp,
      uuid: () => 'fail-uuid',
      scriptPath: script,
      elevate: async (_scriptPath, bundlePath) => {
        const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as IsolationBundle;
        writeFileSync(bundle.resultPath, JSON.stringify({ ok: false, error: 'access denied by policy' }));
        return 1;
      },
    }),
    /Agent isolation setup failed: access denied by policy/,
  );
  assert.equal(secrets.hasAgentCredential(), false, 'no credential is saved on failure');
  assert.deepEqual(
    readdirSync(tmp).filter(name => name.startsWith('qro-isolation-')),
    [],
    'the bundle is scrubbed even on failure',
  );
});

test('setup: a declined consent prompt leaves no result and fails closed', async t => {
  const dir = root(t);
  const tmp = path.join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const script = path.join(dir, 'setup-agent-isolation.ps1');
  writeFileSync(script, '# stub\n');
  const secrets = new Secrets(dir, stubBox());
  await assert.rejects(
    setupAgentIsolation({
      userData: dir,
      secrets,
      toolPath: provider => `C:\\tools\\${provider}\\tool.exe`,
      nodeExe: () => 'C:\\Program Files\\nodejs\\node.exe',
      tmpdir: () => tmp,
      uuid: () => 'declined-uuid',
      scriptPath: script,
      elevate: async () => 1, // UAC declined — the elevated script never ran, no result written
    }),
    /Agent isolation setup failed:/,
  );
  assert.equal(secrets.hasAgentCredential(), false);
});

test('setup: no node.exe outside the profile refuses before anything is written', async t => {
  const dir = root(t);
  const secrets = new Secrets(dir, stubBox());
  let elevated = false;
  await assert.rejects(
    setupAgentIsolation({
      userData: dir,
      secrets,
      toolPath: provider => `C:\\tools\\${provider}\\tool.exe`,
      nodeExe: () => {
        throw new Error('Node.js (node.exe) is required on PATH for agent isolation.');
      },
      tmpdir: () => path.join(dir, 'tmp'),
      scriptPath: path.join(dir, 'setup-agent-isolation.ps1'),
      elevate: async () => {
        elevated = true;
        return 0;
      },
    }),
    /Node\.js \(node\.exe\) is required on PATH for agent isolation\./,
  );
  assert.equal(elevated, false, 'elevation is never attempted without a node.exe plan');
  assert.equal(secrets.hasAgentCredential(), false);
});
