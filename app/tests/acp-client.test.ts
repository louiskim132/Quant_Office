import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AcpClient, AcpPacketChild, ACP_STATE_FILE, acpPermission } from '../src/main/acp-client';
import { removeTreeSync } from '../src/main/fsx';
import type { CliSpawn, CliSpawnOptions } from '../src/main/local-cli-exec';

class Peer extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 7654;
  frames: any[] = [];
  killed = false;
  onFrame?: (frame: any) => void;
  constructor() {
    super();
    let buffer = '';
    this.stdin.on('data', data => {
      buffer += String(data);
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        this.frames.push(frame);
        queueMicrotask(() => {
          this.onFrame?.(frame);
          if (frame.method === 'initialize')
            this.reply(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
          if (frame.method === 'session/new') this.reply(frame.id, { sessionId: 'synthetic-session-1' });
          if (frame.method === 'session/load') this.reply(frame.id, {});
        });
      }
    });
  }
  reply(id: number, result: unknown) {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  send(method: string, params: unknown, id?: number) {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params, ...(id !== undefined ? { id } : {}) }) + '\n');
  }
  kill() {
    if (!this.killed) {
      this.killed = true;
      this.emit('exit', 0, null);
    }
    return true;
  }
}
function fixture(t: test.TestContext) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'qro-acp-test-'));
  t.after(() => removeTreeSync(cwd));
  const peer = new Peer();
  const spawn: CliSpawn = () => peer;
  const options: CliSpawnOptions = { cwd, env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  return { cwd, peer, spawn, options };
}

test('ACP binds replies, streams matching session tools and accepts only single-use scoped permissions', async t => {
  const f = fixture(t),
    updates: unknown[] = [];
  const client = new AcpClient(f.spawn, 'synthetic-peer', [], f.options, frame => updates.push(frame), {
    allowedTools: ['Read'],
  });
  t.after(() => client.stop());
  await client.initialize();
  await client.create();
  const permission = {
    sessionId: 'synthetic-session-1',
    toolCall: { kind: 'read', locations: [{ path: 'inputs/a.txt' }] },
    options: [
      { kind: 'allow_always', optionId: 'always' },
      { kind: 'allow_once', optionId: 'once' },
    ],
  };
  f.peer.send('session/request_permission', permission, 80);
  f.peer.send('session/request_permission', { ...permission, sessionId: 'another-session' }, 81);
  f.peer.send('session/update', { sessionId: 'another-session', update: { sessionUpdate: 'tool_call' } });
  f.peer.send('session/update', { sessionId: 'synthetic-session-1', update: { sessionUpdate: 'tool_call' } });
  assert.equal(updates.length, 1);
  assert.deepEqual(f.peer.frames.find(frame => frame.id === 80).result, {
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  assert.equal(f.peer.frames.find(frame => frame.id === 81).error.code, -32601);
  assert.equal(f.peer.frames.find(frame => frame.method === 'initialize').params.clientCapabilities.terminal, false);
});
test('a partial permission request inherits kind from the same session tool call; foreign calls cannot supply it', async t => {
  const f = fixture(t);
  const client = new AcpClient(f.spawn, 'synthetic-peer', [], f.options, () => {}, { allowedTools: ['exec'] });
  t.after(() => client.stop());
  await client.initialize();
  await client.create();
  f.peer.send('session/update', {
    sessionId: 'synthetic-session-1',
    update: { sessionUpdate: 'tool_call', toolCallId: 'exec-1', kind: 'execute' },
  });
  f.peer.send('session/update', {
    sessionId: 'foreign',
    update: { sessionUpdate: 'tool_call', toolCallId: 'exec-2', kind: 'execute' },
  });
  for (const [id, toolCallId] of [
    [82, 'exec-1'],
    [83, 'exec-2'],
  ] as const)
    f.peer.send(
      'session/request_permission',
      {
        sessionId: 'synthetic-session-1',
        toolCall: { toolCallId },
        options: [{ kind: 'allow_once', optionId: 'once' }],
      },
      id,
    );
  assert.equal(f.peer.frames.find(frame => frame.id === 82).result.outcome.optionId, 'once');
  assert.equal(f.peer.frames.find(frame => frame.id === 83).result.outcome.outcome, 'cancelled');
});
test('permission handling refuses escaped paths, unknown kinds, writes on read-only profiles and malformed metadata', () => {
  const cwd = path.resolve('synthetic-packet');
  const params = {
    toolCall: { kind: 'read', locations: [{ path: '../other' }] },
    options: [{ kind: 'allow_once', optionId: 'yes' }],
  };
  for (const value of [
    params,
    { ...params, toolCall: { kind: 'other' } },
    { ...params, toolCall: { kind: 'edit' } },
    { ...params, toolCall: { kind: 'read', locations: {} } },
    { ...params, options: {} },
  ])
    assert.deepEqual(acpPermission(value, cwd, { canWrite: false }), { outcome: { outcome: 'cancelled' } });
});
test('ACP cancel is a notification; only the actual prompt response supplies acknowledgement', async t => {
  const f = fixture(t);
  let promptId = 0;
  f.peer.onFrame = frame => {
    if (frame.method === 'session/prompt') promptId = frame.id;
    if (frame.method === 'session/cancel') f.peer.reply(promptId, { stopReason: 'cancelled' });
  };
  const client = new AcpClient(f.spawn, 'synthetic-peer', [], f.options, () => {});
  t.after(() => client.stop());
  await client.initialize();
  await client.create();
  const prompt = client.prompt('Synthetic cancellation');
  await new Promise(resolve => setImmediate(resolve));
  client.cancel();
  assert.equal((await prompt).stopReason, 'cancelled');
  const cancellation = f.peer.frames.find(frame => frame.method === 'session/cancel');
  assert.equal(cancellation.id, undefined);
  assert.equal(cancellation.params.sessionId, 'synthetic-session-1');
});
test('restart reconciliation loads the bound identity without prompting or creating a session', async t => {
  const f = fixture(t);
  const client = new AcpClient(f.spawn, 'synthetic-peer', [], f.options, () => {});
  t.after(() => client.stop());
  await client.initialize();
  await client.load('durably-bound-session');
  assert.deepEqual(
    f.peer.frames.map(frame => frame.method),
    ['initialize', 'session/load'],
  );
  assert.equal(f.peer.frames[1].params.sessionId, 'durably-bound-session');
});
test('packet bridge persists the real session reply before prompting and never invents a receipt', async t => {
  const f = fixture(t);
  f.peer.onFrame = frame => {
    if (frame.method === 'session/prompt') {
      assert.equal(JSON.parse(readFileSync(path.join(f.cwd, ACP_STATE_FILE), 'utf8')).sessionId, 'synthetic-session-1');
      f.peer.reply(frame.id, { stopReason: 'end_turn' });
    }
  };
  const child = new AcpPacketChild(
    f.spawn,
    'synthetic-peer',
    ['acp', '--model', 'fixture-model', JSON.stringify({ prompt: 'Synthetic fixture' })],
    f.options,
  );
  await new Promise<void>(resolve => child.on('exit', () => resolve()));
  assert.equal(child.sessionId, 'synthetic-session-1');
  assert.equal(JSON.parse(readFileSync(path.join(f.cwd, ACP_STATE_FILE), 'utf8')).stopReason, 'end_turn');
  assert.equal(existsSync(path.join(f.cwd, 'result.json')), false);
  assert.equal(f.peer.frames.filter(frame => frame.method === 'session/prompt').length, 1);
});
test('packet cancellation waits for a prompt cancellation response before terminating its owned process', async t => {
  const f = fixture(t);
  let promptId = 0;
  f.peer.onFrame = frame => {
    if (frame.method === 'session/prompt') promptId = frame.id;
    if (frame.method === 'session/cancel') f.peer.reply(promptId, { stopReason: 'cancelled' });
  };
  const child = new AcpPacketChild(
    f.spawn,
    'synthetic-peer',
    ['acp', '--model', 'fixture-model', JSON.stringify({ prompt: 'Synthetic cancellation' })],
    f.options,
  );
  while (!promptId) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await child.cancelTurn(1000), true);
  assert.equal(f.peer.killed, true);
});

test('a model selection mismatch refuses the prompt even when initialization succeeded', async t => {
  const f = fixture(t);
  f.peer.onFrame = frame => {
    if (frame.method === 'session/new')
      f.peer.reply(frame.id, {
        sessionId: 'synthetic-session-1',
        configOptions: [{ id: 'model', currentValue: 'different-model' }],
      });
  };
  const child = new AcpPacketChild(
    f.spawn,
    'synthetic-peer',
    ['acp', '--model', 'fixture-model', JSON.stringify({ prompt: 'Synthetic model check' })],
    f.options,
  );
  await new Promise<void>(resolve => child.on('exit', () => resolve()));
  assert.match(child.providerError!, /different model/);
  assert.equal(
    f.peer.frames.some(frame => frame.method === 'session/prompt'),
    false,
  );
});
