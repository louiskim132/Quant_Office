import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runAgentIsolationAcceptance, type AcceptanceSpawn } from '../src/main/agent-isolation-acceptance.js';

type Script = { out?: string; err?: string; code?: number; error?: string; hang?: boolean };

function scriptedSpawn(script: (exe: string, args: string[], cwd: string) => Script) {
  const calls: { exe: string; args: string[]; cwd: string }[] = [];
  const spawnAs: AcceptanceSpawn = (exe, args, options) => {
    calls.push({ exe, args, cwd: options.cwd });
    const plan = script(exe, args, options.cwd);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (plan.hang) return;
      if (plan.error) return void child.emit('error', new Error(plan.error));
      if (plan.out) child.stdout.write(plan.out);
      if (plan.err) child.stderr.write(plan.err);
      child.emit('exit', plan.code ?? 0, null);
    });
    return child as unknown as ReturnType<AcceptanceSpawn>;
  };
  return { spawnAs, calls };
}

const sessionDir = 'C:\\ws\\local-sessions\\acceptance-1';
const protectedDir = 'C:\\Users\\office\\AppData\\Roaming\\Quant Research Office';

function isolatedAccount(exe: string, args: string[], cwd: string): Script {
  if (cwd === 'C:\\') return { error: 'refused: cwd is outside the agent sessions root' };
  if (exe.endsWith('cmd.exe')) return { code: 1, err: 'Access is denied.\r\n' };
  if (args[0] === '/groups') return { out: 'BUILTIN\\Users  S-1-5-32-545\r\n' };
  return { out: 'pc\\qro-agent\r\n' };
}

test('runner issues the four probes in order and passes a correctly isolated account', async () => {
  const { spawnAs, calls } = scriptedSpawn(isolatedAccount);
  const report = await runAgentIsolationAcceptance({ spawnAs, username: 'QRO-Agent', sessionDir, protectedDir });
  assert.deepEqual(
    report.probes.map(p => p.label),
    ['whoami', 'whoami /groups', 'office profile read', 'cwd escape C:\\'],
  );
  assert.equal(calls[2].args.at(-1), protectedDir);
  assert.deepEqual(
    calls.map(c => c.cwd),
    [sessionDir, sessionDir, sessionDir, 'C:\\'],
  );
  assert.equal(report.passed, true, JSON.stringify(report.checks));
});

test('runner fails when agents still run as the office account', async () => {
  const { spawnAs } = scriptedSpawn((exe, args, cwd) =>
    cwd === 'C:\\'
      ? { out: 'pc\\office\r\n' }
      : exe.endsWith('cmd.exe')
        ? { out: 'Volume in drive C' }
        : { out: 'pc\\office\r\n' },
  );
  const report = await runAgentIsolationAcceptance({ spawnAs, username: 'QRO-Agent', sessionDir, protectedDir });
  assert.equal(report.passed, false);
  assert.equal(report.checks['whoami is qro-agent'], false);
  assert.equal(report.checks['office profile denied'], false);
  assert.equal(report.checks['cwd escape refused'], false);
});

test('runner fails closed when the host never starts or a probe hangs', async () => {
  const failed = scriptedSpawn(() => ({ error: 'the agent host is not running' }));
  const down = await runAgentIsolationAcceptance({
    spawnAs: failed.spawnAs,
    username: 'QRO-Agent',
    sessionDir,
    protectedDir,
  });
  assert.equal(down.passed, false);
  assert.ok(Object.values(down.checks).every(ok => !ok));

  const hung = scriptedSpawn(() => ({ hang: true }));
  const slow = await runAgentIsolationAcceptance({
    spawnAs: hung.spawnAs,
    username: 'QRO-Agent',
    sessionDir,
    protectedDir,
    timeoutMs: 50,
  });
  assert.equal(slow.passed, false);
  assert.match(slow.probes[0].error ?? '', /timed out/);
});
