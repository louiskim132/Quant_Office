import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { PtyCloudAdapter, readReceipt, stripAnsi, type PtyLike, type PtySpawn } from '../src/main/pty';
import { prepareInputSnapshot } from '../src/main/locations';
import type { Agent, CapabilityEvidence, CapabilityOperation } from '../src/shared/types';

const execFile = promisify(execFileCallback);
const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 12, 0, 0) + minutes * 60000).toISOString();
const ROUTES = ['FAKE_ADAPTER', 'OFFICIAL_TERMINAL_HANDOFF', 'OFFICIAL_CLI_PTY'] as const;
const CLOUD: CapabilityOperation[] = [
  'CLOUD_SUBMIT',
  'CLOUD_OBSERVE',
  'CLOUD_OUTPUT_FETCH',
  'CLOUD_CANCEL_REQUEST',
  'CLOUD_CANCEL_ACK',
  'MODEL_APPLICATION',
  'EFFORT_APPLICATION',
  'ENVIRONMENT_IDENTITY',
  'DELEGATION_CONTROL',
  'TOOL_CONFINEMENT',
];
const seen = (
  operation: CapabilityOperation,
  minutes: number,
  extra: Partial<CapabilityEvidence> = {},
): CapabilityEvidence => ({
  operation,
  level: 'ACCOUNT_VERIFIED',
  detail: 'Exercised.',
  evidence: 'OBSERVED',
  verifiedAt: at(minutes),
  source: 'fixture',
  ...extra,
});
/** A hypothetical account where the transport has been verified, so automatic dispatch is allowed. */
const verified = (minutes: number) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '2.1.236',
  transport: 'OFFICIAL_CLI_TERMINAL' as const,
  environment: 'anthropic-managed',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [
    seen('ACCOUNT_STATUS', minutes),
    seen('MODEL_CATALOG', minutes),
    ...CLOUD.flatMap(o =>
      ROUTES.flatMap(route =>
        o === 'DELEGATION_CONTROL'
          ? [
              seen(o, minutes, { model: 'opus', route, delegation: false }),
              seen(o, minutes, { model: 'opus', route, delegation: true }),
            ]
          : o === 'EFFORT_APPLICATION'
            ? [seen(o, minutes, { model: 'opus', route, effort: 'default' })]
            : o === 'TOOL_CONFINEMENT'
              ? [
                  seen(o, minutes, {
                    model: 'opus',
                    route,
                    confinement: {
                      tools: 'Only the read-only fixture tools were offered.',
                      filesystem: 'Confined to the staged snapshot directory.',
                      network: 'No outbound network was reachable from the session.',
                      environment: 'anthropic-managed',
                    },
                  }),
                ]
              : [seen(o, minutes, { model: 'opus', route })],
      ),
    ),
  ],
  source: 'transport fixture',
  observedAt: at(minutes),
});

/** A scripted terminal. Chunks arrive split mid-token, with ANSI noise, like a real one. */
class FakePty implements PtyLike {
  killed = 0;
  written: string[] = [];
  private data: ((chunk: string) => void)[] = [];
  private exit: ((event: { exitCode: number }) => void)[] = [];
  private pending?: () => void;
  /** Runs once the adapter attaches, so a test never races the work that happens before the spawn. */
  script(run: () => void) {
    this.pending = run;
    return this;
  }
  onData(listener: (chunk: string) => void) {
    this.data.push(listener);
    if (this.pending) {
      const run = this.pending;
      this.pending = undefined;
      setTimeout(run, 1);
    }
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exit.push(listener);
  }
  write(value: string) {
    this.written.push(value);
  }
  kill() {
    this.killed++;
  }
  emit(chunk: string) {
    for (const listener of [...this.data]) listener(chunk);
  }
  close(exitCode: number) {
    for (const listener of [...this.exit]) listener({ exitCode });
  }
}

async function fixture(t: any, spawn: PtySpawn, timeoutMs = 200) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-pty-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'input.csv'), 'a\n1\n');
  store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: project.id,
    expectedRevision: 0,
    localFolder: source,
    inputPaths: ['input.csv'],
    outputFolder: '',
  });
  const agent: Agent = {
    id: randomUUID(),
    name: 'Sole worker',
    provider: 'claude',
    model: 'opus',
    team: 'Research',
    role: 'WORKER',
    instructions: '',
    account: 'researcher@example.com',
    createdAt: at(0),
    connectionVerifiedAt: at(0),
    execution: 'HOSTED_SETUP_REQUIRED',
  };
  store.confirmAgentBinding({ observation: verified(0), agent });
  const request = store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: project.id,
    name: 'Tiny question',
    hypothesis: 'Read the README and stop',
    workType: 'QUESTION',
    mode: 'SINGLE',
    leadAgentId: agent.id,
    participantIds: [],
  }).requests![0];
  const snapshot = await prepareInputSnapshot({
    store,
    stagingRoot: path.join(root, 'staging'),
    projectId: project.id,
    requestId: request.id,
    requestRevision: request.revision,
  });
  const adapter = new PtyCloudAdapter({ executable: () => 'C:/Users/example/.local/bin/claude.exe', spawn, timeoutMs });
  // One injected clock, held just inside the account-freshness window, so a run's result never
  // depends on the calendar date the suite happens to execute on.
  let tick = 0;
  const clock = () => at(++tick / 60);
  const controller = new AssignmentController(store, adapter, clock);
  const { assignment } = controller.prepare({ requestId: request.id, agentId: agent.id, snapshotId: snapshot.id });
  return { root, store, controller, adapter, assignment, snapshot, request, agent };
}

test('terminal noise is stripped and a receipt is read across split chunks', () => {
  assert.equal(stripAnsi('\u001b[32mgreen\u001b[0m text'), 'green text');
  assert.equal(stripAnsi('\u001b]0;window title\u0007ready'), 'ready');
  assert.equal(readReceipt('working…'), null);
  assert.equal(
    readReceipt('Created cloud session: Fixture\nView: https://claude.ai/code/sessi'),
    null,
    'a partial identifier is not a receipt',
  );
  const full = readReceipt(
    '\u001b[2KCreated cloud session: Fixture\r\nView: \u001b[4mhttps://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB?from=cli&m=0\u001b[0m\r\n',
  )!;
  assert.equal(full.externalId, 'session_01Aj1hpgmeoZLdgYVR9eQ6PB');
  assert.equal(full.externalUrl, 'https://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB');
  assert.equal(
    readReceipt('Created cloud session: session_01Aj1hpgmeoZLdgYVR9eQ6PB'),
    null,
    'an identifier echoed on the creation line, with no official view URL, is not a complete receipt',
  );
});

test('an incomplete, unrelated or echoed identifier never establishes acceptance', () => {
  const id = 'session_01Aj1hpgmeoZLdgYVR9eQ6PB';
  const framed = (line: string) => `Created cloud session: Fixture\r\nView: ${line}\r\n`;
  // A chunk boundary inside a valid-looking identifier must not terminate the read. Every prefix of
  // the real identifier long enough to satisfy the minimum length is still an unfinished line.
  for (let cut = 16; cut < id.length - 'session_'.length; cut++) {
    const partial = `Created cloud session: Fixture\r\nView: https://claude.ai/code/${id.slice(0, 'session_'.length + cut)}`;
    assert.equal(readReceipt(partial), null, `a ${cut}-character identifier prefix is not a receipt yet`);
  }
  assert.equal(
    readReceipt(framed('https://claude.ai/code/session_short123')),
    null,
    'an identifier below the observed length is refused',
  );
  assert.equal(
    readReceipt(framed(`https://example.invalid/code/${id}`)),
    null,
    'an unrelated host is not an official receipt',
  );
  assert.equal(
    readReceipt(framed(`https://claude.ai/other/${id}`)),
    null,
    'an unrelated path is not an official receipt',
  );
  assert.equal(
    readReceipt(`the user mentioned ${id} in passing\r\n`),
    null,
    'a bare identifier anywhere in the transcript is not a receipt',
  );
  assert.equal(
    readReceipt(
      `\u001b[2mCreated cloud session: Fixture\u001b[0m\r\nView: \u001b[4mhttps://claude.ai/code/${id}?from=cli&m=0\u001b[0m\r\n`,
    )!.externalUrl,
    `https://claude.ai/code/${id}`,
    'ANSI noise is stripped and the stored URL carries no CLI query parameters',
  );
});

test('the PTY route runs only the official cloud command in the staged directory', async t => {
  let seenArgs: string[] = [];
  let seenCwd = '';
  const terminal = new FakePty();
  terminal.script(() =>
    terminal.emit(
      'Created cloud session: Tiny question\r\nView: https://claude.ai/code/session_0123456789abcdef?from=cli\r\n',
    ),
  );
  const f = await fixture(t, (_exe, args, options) => {
    seenArgs = args;
    seenCwd = options.cwd;
    return terminal;
  });
  await f.controller.dispatch(f.assignment.id);
  assert.equal(seenCwd, f.snapshot.stagingPath);
  assert.ok(seenArgs.includes('--cloud'));
  assert.ok(seenArgs.includes('--safe-mode'));
  assert.equal(seenArgs.includes('--teleport'), false);
  assert.equal(
    seenArgs.some(a => a.startsWith('--environment')),
    false,
  );
  assert.equal(seenArgs.includes('-p'), false, 'never a local print-mode run');
});

test('a real receipt is recorded as an accepted job with the provider identifier', async t => {
  const terminal = new FakePty();
  terminal.script(() => {
    terminal.emit('\u001b[2mstarting\u001b[0m\r\n');
    terminal.emit('Created cloud session: Tiny ');
    terminal.emit('question\r\nView: https://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB?from=cli&m=0\r\n');
  });
  const f = await fixture(t, () => terminal);
  const state = await f.controller.dispatch(f.assignment.id);
  const job = state.jobs![0];
  assert.equal(job.state, 'ACCEPTED');
  assert.equal(job.externalId, 'session_01Aj1hpgmeoZLdgYVR9eQ6PB');
  assert.equal(job.evidence, 'PROVIDER_REPORTED');
  assert.equal(terminal.killed, 1, 'the terminal is always closed after the receipt');
  assert.equal(terminal.written.length, 1, 'the objective is written once');
});

test('a terminal that exits without a receipt leaves the job unknown', async t => {
  const terminal = new FakePty();
  terminal.script(() => {
    terminal.emit('error: --cloud requires an interactive terminal\r\n');
    terminal.close(1);
  });
  const f = await fixture(t, () => terminal);
  const state = await f.controller.dispatch(f.assignment.id);
  assert.equal(state.jobs![0].state, 'UNKNOWN');
  assert.match(state.jobs![0].detail, /exited with code 1 without reporting a session/);
  assert.equal(state.jobs![0].externalId, '');
});

test('a silent terminal times out, is killed, and leaves the job unknown', async t => {
  const terminal = new FakePty();
  const f = await fixture(t, () => terminal, 120);
  const state = await f.controller.dispatch(f.assignment.id);
  assert.equal(state.jobs![0].state, 'UNKNOWN');
  assert.match(state.jobs![0].detail, /did not report a session within/);
  assert.equal(terminal.killed, 1, 'a timed out terminal is cleaned up');
});

test('an exit code of zero without a receipt is still not a submission', async t => {
  const terminal = new FakePty();
  terminal.script(() => terminal.close(0));
  const f = await fixture(t, () => terminal);
  const state = await f.controller.dispatch(f.assignment.id);
  assert.equal(state.jobs![0].state, 'UNKNOWN');
  assert.equal(state.jobs![0].evidence, 'OFFICE_LOCAL');
});

test('the office reads a bounded transcript and stops runaway output', async t => {
  const terminal = new FakePty();
  terminal.script(() => {
    for (let i = 0; i < 70; i++) terminal.emit('x'.repeat(40000));
  });
  const f = await fixture(t, () => terminal, 5000);
  const state = await f.controller.dispatch(f.assignment.id);
  assert.equal(state.jobs![0].state, 'UNKNOWN');
  assert.match(state.jobs![0].detail, /more output than the office will read/);
  assert.equal(terminal.killed, 1);
});

test('node-pty is installed, loads, and drives a real terminal on this machine', async () => {
  // Run in a child process: node-pty keeps a ConPTY handle alive after its child exits, which would
  // otherwise hold this test runner open. The adapter always closes its own terminal.
  const { stdout } = await execFile(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'pty-smoke.cjs')], {
    cwd: path.join(import.meta.dirname, '..'),
    timeout: 60000,
  });
  const result = JSON.parse(stdout.trim().split(String.fromCharCode(10)).at(-1)!);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.sawOutput, true, 'a real ConPTY terminal produced the expected output');
});
