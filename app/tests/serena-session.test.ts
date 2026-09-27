import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  spawnSerenaSession,
  SERENA_READ_ONLY_ARG,
  type SerenaSpawn,
  type SerenaSpawnOptions,
} from '../src/main/serena-session';
import type { ToolProfile } from '../src/shared/tool-profile';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const packetDir = path.join(tmpdir(), 'serena-packet-dir');

/** A scripted serena child — writable stdin for the handshake, scripted stdout, recorded kills. */
class FakeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  private readonly listeners = {
    exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[],
    error: [] as ((error: Error) => void)[],
  };
  constructor(readonly pid: number | undefined = 5150) {}
  kill(signal?: NodeJS.Signals | number) {
    this.kills.push(signal);
    return true;
  }
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'error', listener: unknown) {
    if (event === 'exit')
      this.listeners.exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    else this.listeners.error.push(listener as (error: Error) => void);
    return this;
  }
  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    for (const listener of this.listeners.exit) listener(code, signal);
  }
  emitError(error: Error) {
    for (const listener of this.listeners.error) listener(error);
  }
}

interface SpawnCall {
  executable: string;
  args: string[];
  options: SerenaSpawnOptions;
  child: FakeChild;
}

function spawnLog() {
  const calls: SpawnCall[] = [];
  const spawn: SerenaSpawn = (executable, args, options) => {
    const child = new FakeChild();
    calls.push({ executable, args, options, child });
    return child;
  };
  return { calls, spawn };
}

const serenaProfile = (readOnly: boolean, extra?: Partial<ToolProfile>): ToolProfile => ({
  mcpServers: [{ id: 'serena', command: 'uvx', args: ['serena-agent==1.7.0', 'serena', 'start-mcp-server'], readOnly }],
  ...extra,
});
const binding = { jobId: 'job-serena-1' };
const initializeResult =
  '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"serena","version":"1.7.0"}}}\n';

test('a profile without a serena mcpServers entry spawns nothing and reports not ready', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: {}, packetDir }, { spawn });
  assert.equal(calls.length, 0);
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /no 'serena'/);
  session.dispose();
});

test('a serena entry spawns the profile command with --project bound to the packet dir', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.executable, 'uvx');
  assert.deepEqual(call.args, ['serena-agent==1.7.0', 'serena', 'start-mcp-server', '--project', packetDir]);
  assert.equal(call.options.cwd, packetDir);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(!call.args.includes(SERENA_READ_ONLY_ARG));
  call.child.emitExit(1);
  await session.ready;
  session.dispose();
});

test('a readOnly entry produces the read-only argument in spawned args', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(true), packetDir }, { spawn });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes(SERENA_READ_ONLY_ARG));
  const projectAt = calls[0].args.indexOf('--project');
  assert.equal(calls[0].args[projectAt + 1], packetDir);
  calls[0].child.emitExit(1);
  await session.ready;
  session.dispose();
});

test('readiness resolves ok:true only after an observed handshake response, never on spawn alone', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  const child = calls[0].child;
  let settled = false;
  session.ready.then(() => {
    settled = true;
  });
  // A spawned process alone is not ready — noise on stdout must not resolve it.
  child.stdout.write(
    'not json\n{"jsonrpc":"2.0","id":99,"result":{}}\n{"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n',
  );
  await sleep(20);
  assert.equal(settled, false);
  child.stdout.write(initializeResult);
  assert.deepEqual(await session.ready, { ok: true });
  assert.equal(settled, true);
  // The initialize request went over the child's stdin — an observed call, not config presence.
  const written = child.stdin.read()?.toString() ?? '';
  const request = JSON.parse(written.split('\n').filter(Boolean)[0]);
  assert.equal(request.method, 'initialize');
  assert.equal(request.id, 1);
  session.dispose();
});

test('a JSON-RPC error response resolves ok:false with the error detail', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  calls[0].child.stdout.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}\n');
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /bad params/);
  session.dispose();
});

test('a spawn error resolves ok:false with a reason, not a crash', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  calls[0].child.emitError(new Error('spawn uvx ENOENT'));
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /ENOENT/);
  session.dispose();
});

test('a spawn that throws synchronously resolves ok:false, never rejects', async () => {
  const spawn: SerenaSpawn = () => {
    throw new Error('not a spawnable command');
  };
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /not a spawnable command/);
  session.dispose();
});

test('a child that exits before the handshake resolves ok:false naming the exit', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  calls[0].child.emitExit(2);
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /code 2/);
  session.dispose();
});

test('a non-responsive child resolves ok:false on the handshake deadline and is killed', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession(
    { binding, profile: serenaProfile(false), packetDir },
    { spawn, readyTimeoutMs: 5 },
  );
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /within 5ms/);
  assert.equal(calls[0].child.kills.length, 1);
  session.dispose();
});

test('a child without a writable stdin resolves ok:false', async () => {
  const calls: SpawnCall[] = [];
  const spawn: SerenaSpawn = (executable, args, options) => {
    const child = new FakeChild();
    Object.defineProperty(child, 'stdin', { value: null });
    calls.push({ executable, args, options, child });
    return child;
  };
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /stdin/);
  session.dispose();
});

test('dispose kills the child once and tolerates repeated calls', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  calls[0].child.stdout.write(initializeResult);
  await session.ready;
  session.dispose();
  session.dispose();
  session.dispose();
  assert.equal(calls[0].child.kills.length, 1);
});

test('dispose before readiness resolves ready as ok:false and still kills once', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  session.dispose();
  session.dispose();
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /disposed/);
  assert.equal(calls[0].child.kills.length, 1);
});

test('a disposed session that then exits does not overwrite the readiness verdict', async () => {
  const { calls, spawn } = spawnLog();
  const session = spawnSerenaSession({ binding, profile: serenaProfile(false), packetDir }, { spawn });
  session.dispose();
  calls[0].child.emitExit(0);
  const outcome = await session.ready;
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /disposed/);
});
