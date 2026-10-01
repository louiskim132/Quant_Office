import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, NotLaunchedError, type SubmitContext } from '../src/main/controller';
import {
  LocalCliExecAdapter,
  MAX_ARGV_PROMPT_CHARS,
  PROMPT_FILE,
  PROMPT_POINTER,
  type CliSpawn,
  type CliSpawnOptions,
} from '../src/main/local-cli-exec';
import { CONTRACT_FILE, PACKET_FILE, RESULT_FILE } from '../src/main/local-packet';
import { PACKET_HASH_FILE, PACKET_READY_FILE } from '../src/main/local-packet';
import { CLAUDE_DEFAULT_TOOLS, CLAUDE_ISOLATION_FLAGS, CODEX_DISABLED_FEATURES } from '../src/main/tool-flags';
const CODEX_LEAN = [
  '--json',
  '-c',
  'mcp_servers={}',
  ...[...CODEX_DISABLED_FEATURES, 'multi_agent'].flatMap(feature => ['--disable', feature]),
];
import type { LocalSessionRecord } from '../src/shared/local-session';
import type { Assignment, Effort, InputSnapshot, Provider, ProviderJob } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ESSENTIALS = '\n\n## Packet essentials (office-generated)';
const CLAUDE_TAIL = [...CLAUDE_ISOLATION_FLAGS, '--tools', CLAUDE_DEFAULT_TOOLS.join(',')];
const PROMPT_SUFFIX =
  'This directory is an office-local-session@2 packet: read packet.json and CONTRACT.md, place declared outputs under outputs/, then write result.json exactly as CONTRACT.md specifies.';

/** A scripted child process — emits output, records kills, exits on command. Never a real spawn. */
class FakeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  private readonly listeners = {
    exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[],
    error: [] as ((error: Error) => void)[],
  };
  constructor(readonly pid: number | undefined = 4321) {}
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
  options: CliSpawnOptions;
  child: FakeChild;
}

function fixture(
  t: test.TestContext,
  options: {
    provider?: Provider;
    effort?: Effort;
    timeoutMs?: number;
    pid?: number | undefined;
    executableError?: boolean;
    spawnThrows?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-cli-exec-'));
  t.after(() => {
    adapter.disposeAll();
    removeTreeSync(root);
  });
  const staging = path.join(root, 'staging');
  mkdirSync(path.join(staging, 'data'), { recursive: true });
  writeFileSync(path.join(staging, 'data', 'input.csv'), 'a,b\n1,2\n');
  writeFileSync(path.join(staging, 'notes.txt'), 'fixture notes');
  const snapshot: InputSnapshot = {
    id: randomUUID(),
    projectId: randomUUID(),
    requestId: randomUUID(),
    locationRevision: 0,
    requestRevision: 1,
    route: 'SELECTED_FILES_GIT_SNAPSHOT',
    files: [
      { path: 'data/input.csv', bytes: Buffer.byteLength('a,b\n1,2\n'), sha256: sha('a,b\n1,2\n') },
      { path: 'notes.txt', bytes: Buffer.byteLength('fixture notes'), sha256: sha('fixture notes') },
    ],
    totalBytes: Buffer.byteLength('a,b\n1,2\n') + Buffer.byteLength('fixture notes'),
    manifestHash: sha('manifest'),
    stagingCommit: 'fixture-commit',
    stagingPath: staging,
    warnings: [],
    provenance: 'OFFICE_STAGED',
    createdAt: at(0),
  };
  const sessions = path.join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const calls: SpawnCall[] = [];
  const spawn: CliSpawn = (executable, args, spawnOptions) => {
    if (options.spawnThrows) throw new Error('spawn failed synchronously');
    const child = new FakeChild(options.pid === undefined ? 4321 : options.pid);
    calls.push({ executable, args, options: spawnOptions, child });
    return child;
  };
  const environment = () => ({ TEST_ENV: 'scrubbed-subscription-env' });
  const executables: Record<Provider, string> = { devin: 'devin.exe', claude: 'claude.exe', openai: 'codex.exe' };
  const adapter = new LocalCliExecAdapter({
    sessionsRoot: () => sessions,
    executable: provider => {
      if (options.executableError) throw new Error(`no ${provider} executable on PATH`);
      return executables[provider];
    },
    now: () => at(1),
    spawnChild: spawn,
    environment,
    timeoutMs: options.timeoutMs,
    claudeSpawnGapMs: 0,
  });
  const assignment: Assignment = {
    id: randomUUID(),
    projectId: snapshot.projectId,
    requestId: snapshot.requestId!,
    requestRevision: 1,
    agentId: randomUUID(),
    agentRevision: 0,
    connectionId: randomUUID(),
    capabilitySnapshotId: randomUUID(),
    snapshotId: snapshot.id,
    route: 'LOCAL_CLI_EXEC',
    requestedModel: 'fixture-model',
    resolvedModel: '',
    requestedEffort: options.effort ?? 'default',
    appliedEffort: 'UNVERIFIED',
    delegation: false,
    objectiveHash: sha('objective'),
    createdAt: at(0),
  };
  const binding: LocalSessionRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    jobId: randomUUID(),
    assignmentId: assignment.id,
    projectId: assignment.projectId,
    attemptId: randomUUID(),
    revision: 0,
    provider: options.provider ?? 'claude',
    surface: 'DEVIN_CLI',
    layout: 'FLAT_PACKET',
    packetVersion: 2,
    packetHash: null,
    storageRelativePath: 'exec-session',
    originalCwd: null,
    repoRelativePath: null,
    seedCommit: null,
    worktreeOwner: 'NONE',
    providerSessionId: null,
    providerProjectId: null,
    bindingEvidence: 'UNBOUND',
    groupingStatus: 'UNKNOWN',
    requirement: 'SCOPED_DELIVERY',
    confinementStatus: 'UNVERIFIED',
    confinementEvidenceId: null,
    lifecycle: 'READY',
    archiveRelativePath: null,
    lastReceipt: null,
    cancelRequestId: null,
    stopStatus: 'NOT_REQUESTED',
    createdAt: at(0),
    updatedAt: at(0),
  };
  const context: SubmitContext = {
    assignment,
    snapshot,
    objective: 'Summarize the fixture input.',
    requestName: 'Tiny exec task',
    payload: buildProviderPayload({
      requestName: 'Tiny exec task',
      objective: 'Summarize the fixture input.',
      acceptanceCriteria: 'A summary file.',
      instructions: '',
      model: 'fixture-model',
      effort: options.effort ?? 'default',
      delegation: false,
    }),
    jobId: binding.jobId,
    localSession: binding,
  };
  const dir = path.resolve(sessions, binding.storageRelativePath);
  const job = (detail = ''): ProviderJob => ({
    id: binding.jobId,
    assignmentId: assignment.id,
    projectId: assignment.projectId,
    requestId: assignment.requestId,
    provider: binding.provider,
    route: 'LOCAL_CLI_EXEC',
    state: 'UNKNOWN',
    evidence: 'OFFICE_LOCAL',
    detail,
    externalId: 'exec-session',
    externalUrl: '',
    outputs: [],
    revision: 0,
    createdAt: at(0),
    updatedAt: at(0),
    dispatchedAt: at(0),
    settledAt: '',
  });
  return {
    root,
    staging,
    sessions,
    calls,
    spawn,
    environment,
    executables,
    adapter,
    assignment,
    binding,
    context,
    dir,
    job,
  };
}

/** A well-formed v2 receipt for the fixture binding — callers override what they attack. */
function v2Receipt(binding: LocalSessionRecord, overrides: Record<string, unknown> = {}) {
  return {
    schema: 'office-local-result@2',
    jobId: binding.jobId,
    assignmentId: binding.assignmentId,
    attemptId: binding.attemptId,
    packetHash: binding.packetHash,
    sequence: 1,
    state: 'COMPLETED',
    detail: 'Done.',
    outputs: [],
    ...overrides,
  };
}

/** Runs the fixture through submit and returns the bound record with the proven packet hash. */
async function submitted(f: ReturnType<typeof fixture>) {
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  return { result, bound };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the adapter declares the LOCAL_CLI_EXEC route and v2 packet contract', async t => {
  const f = fixture(t);
  assert.equal(f.adapter.route, 'LOCAL_CLI_EXEC');
  assert.equal(f.adapter.packetVersion, 2);
  assert.deepEqual([...f.adapter.providers!].sort(), ['claude', 'devin', 'openai']);
});

test('submit refuses without a bound v2 flat-packet context', async t => {
  const f = fixture(t);
  await assert.rejects(
    f.adapter.submit({ ...f.context, localSession: undefined }),
    /requires a persisted local-session binding/,
  );
  await assert.rejects(
    f.adapter.submit({ ...f.context, localSession: { ...f.binding, packetVersion: 1 } }),
    /office-local-session@2/,
  );
  await assert.rejects(
    f.adapter.submit({ ...f.context, localSession: { ...f.binding, layout: 'PROJECT_WORKTREE' } }),
    /flat office-local-session@2/,
  );
  assert.equal(f.calls.length, 0, 'a refused submit never spawns a process');
});

test('submit writes a real v2 packet and spawns the claude command with cwd inside it', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { result } = await submitted(f);
  assert.equal(result.externalId, 'exec-session');
  assert.ok(result.localPacket?.packetHash);
  assert.ok(existsSync(path.join(f.dir, PACKET_FILE)), 'packet.json exists');
  assert.ok(existsSync(path.join(f.dir, CONTRACT_FILE)), 'CONTRACT.md exists');
  assert.ok(existsSync(path.join(f.dir, PACKET_HASH_FILE)), 'packet.sha256 exists');
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.dir, PACKET_READY_FILE), 'utf8')), {
    attemptId: f.binding.attemptId,
    packetHash: result.localPacket!.packetHash,
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  const prompt = call.args[1];
  assert.ok(
    prompt.startsWith(`${f.context.payload.text}${ESSENTIALS}`),
    'the frozen payload rides first, then the office-generated packet essentials',
  );
  assert.ok(
    prompt.includes(`"packetHash":"${result.localPacket!.packetHash}"`),
    'the receipt skeleton carries the packet hash, which packet.json does not',
  );
  assert.ok(prompt.includes(`"attemptId":"${f.binding.attemptId}"`));
  assert.equal(call.executable, 'claude.exe');
  assert.deepEqual(call.args, [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--model',
    'fixture-model',
    ...CLAUDE_TAIL,
  ]);
  assert.equal(call.options.cwd, f.dir, 'the spawn cwd is the packet directory — authoritative over any -C flag');
  assert.equal(
    call.options.env.TEST_ENV,
    'scrubbed-subscription-env',
    'the injected environment is used, never ambient',
  );
  assert.equal(call.options.windowsHide, true);
  assert.match(result.detail, /spawned unattended \(pid 4321\)/);
  assert.match(result.detail, /The office owns the process/);
});

test('codex and devin commands match the probed table verbatim', async t => {
  const codex = fixture(t, { provider: 'openai' });
  await submitted(codex);
  const codexPrompt = codex.calls[0].args.at(-1)!;
  assert.ok(codexPrompt.startsWith(`${codex.context.payload.text}${ESSENTIALS}`));
  assert.equal(codex.calls[0].executable, 'codex.exe');
  assert.deepEqual(codex.calls[0].args, [
    'exec',
    '-s',
    'workspace-write',
    '--skip-git-repo-check',
    '-m',
    'fixture-model',
    ...CODEX_LEAN,
    codexPrompt,
  ]);
  assert.equal(codex.calls[0].options.cwd, codex.dir);

  const devin = fixture(t, { provider: 'devin' });
  await submitted(devin);
  const devinPrompt = devin.calls[0].args[1];
  assert.ok(devinPrompt.startsWith(`${devin.context.payload.text}${ESSENTIALS}`));
  assert.equal(devin.calls[0].executable, 'devin.exe');
  assert.deepEqual(devin.calls[0].args, [
    '-p',
    devinPrompt,
    '--model',
    'fixture-model',
    '--respect-workspace-trust',
    'false',
    '--permission-mode',
    'dangerous',
  ]);
});

test('effort maps only where the CLI documents a flag; unmapped effort is recorded, not dropped', async t => {
  const claude = fixture(t, { provider: 'claude', effort: 'high' });
  await submitted(claude);
  const effortAt = claude.calls[0].args.indexOf('--effort');
  assert.deepEqual(
    claude.calls[0].args.slice(effortAt, effortAt + 2),
    ['--effort', 'high'],
    'claude --effort is documented and emitted',
  );

  const unmapped = fixture(t, { provider: 'claude', effort: 'minimal' });
  await submitted(unmapped);
  assert.ok(!unmapped.calls[0].args.includes('--effort'), 'minimal has no documented claude mapping');
  const unmappedEvidence = unmapped.adapter.submitEvidence(unmapped.context, {
    externalId: 'exec-session',
    externalUrl: '',
    detail: '',
    localPacket: { packetHash: 'x' },
  });
  assert.match(
    unmappedEvidence.find(e => e.operation === 'LOCAL_SUBMIT')!.detail,
    /"unmappedEffort":"minimal"/,
    'the launch record keeps the unmapped effort',
  );

  const codex = fixture(t, { provider: 'openai', effort: 'high' });
  await submitted(codex);
  assert.ok(
    codex.calls[0].args.includes('model_reasoning_effort=high'),
    'codex effort rides -c model_reasoning_effort',
  );
  const codexEvidence = codex.adapter.submitEvidence(codex.context, {
    externalId: 'exec-session',
    externalUrl: '',
    detail: '',
    localPacket: { packetHash: 'x' },
  });
  assert.match(
    codexEvidence.find(e => e.operation === 'LOCAL_SUBMIT')!.detail,
    /"effortFlag":"-c model_reasoning_effort=high","unmappedEffort":null/,
  );
  assert.match(
    codexEvidence.find(e => e.operation === 'LOCAL_SUBMIT')!.detail,
    /"requestedEffort":"high"/,
    'the requested effort is still on record',
  );
});

test('submitEvidence carries the launch record — pid, arg marker, bypass flags, spawned wording', async t => {
  const f = fixture(t, { provider: 'openai' });
  const { result } = await submitted(f);
  const evidence = f.adapter.submitEvidence(f.context, result);
  const submit = evidence.find(e => e.operation === 'LOCAL_SUBMIT')!;
  assert.ok(submit, 'LOCAL_SUBMIT is recorded');
  assert.equal(submit.route, 'LOCAL_CLI_EXEC');
  assert.equal(submit.level, 'TOOL_SUPPORTED');
  assert.equal(submit.evidence, 'OBSERVED');
  assert.equal(submit.source, 'office-local-cli-exec@1');
  assert.match(submit.detail, /office-spawned unattended run/);
  assert.match(submit.detail, /"pid":4321/);
  assert.match(submit.detail, /"executable":"codex\.exe"/);
  const promptSha = sha(f.calls[0].args.at(-1)!);
  assert.match(submit.detail, new RegExp(`<prompt:${promptSha}>`), 'the prompt slot is the hash marker, not the text');
  assert.ok(!submit.detail.includes(f.context.payload.text), 'the payload text itself is not in the record');
  assert.match(
    submit.detail,
    /"bypassFlags":\["-s","workspace-write","--skip-git-repo-check"\]/,
    'exact flags verbatim',
  );
  assert.match(submit.detail, /"spawnedAt":"/);
  assert.match(submit.detail, /"timeoutMs":/);
  const confinement = evidence.find(e => e.operation === 'TOOL_CONFINEMENT')!;
  assert.match(
    confinement.detail,
    /workspace-write — the probe observed it refusing an out-of-workspace cd; Windows read confinement is untested/,
  );
});

test('observe validates a fabricated v2 receipt through the real reader and reports liveness', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  // While nothing terminal has been reported the liveness bracket rides the detail.
  const pending = await f.adapter.observe(f.job(), bound);
  assert.equal(pending.state, 'UNKNOWN');
  assert.match(
    pending.detail,
    /office-spawned process 4321 is still running/,
    'liveness rides on a non-terminal detail',
  );
  const output = { path: 'outputs/out.txt', sha256: sha('result bytes'), bytes: Buffer.byteLength('result bytes') };
  mkdirSync(path.join(f.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'out.txt'), 'result bytes');
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound, { outputs: [output] })));
  const observed = await f.adapter.observe(f.job(), bound);
  assert.equal(observed.state, 'COMPLETED');
  assert.equal(observed.provenance, 'PROVIDER_REPORTED');
  assert.deepEqual(observed.outputs, [output]);
  assert.ok(observed.receipt && observed.receipt.sequence === 1 && /^[a-f0-9]{64}$/.test(observed.receipt.hash));
  assert.doesNotMatch(
    observed.detail,
    /office-spawned process|still running/,
    'a terminal receipt never carries the stale liveness suffix',
  );
});

test('observe defects a malformed or misbound receipt as UNKNOWN, never success', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  writeFileSync(path.join(f.dir, RESULT_FILE), 'not json{');
  let observed = await f.adapter.observe(f.job(), bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.equal(observed.provenance, 'OFFICE_LOCAL');

  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound, { attemptId: randomUUID() })));
  observed = await f.adapter.observe(f.job(), bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(observed.detail, /attemptId/);

  const drift = {
    path: 'outputs/out.txt',
    sha256: sha('declared but different'),
    bytes: Buffer.byteLength('result bytes'),
  };
  mkdirSync(path.join(f.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'out.txt'), 'result bytes');
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound, { outputs: [drift] })));
  observed = await f.adapter.observe(f.job(), bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(observed.detail, /hashes to/);
});

test('a self-exited process without a receipt stays UNKNOWN — dying is not a failure claim', async t => {
  const f = fixture(t, { provider: 'claude' });
  await submitted(f);
  f.calls[0].child.emitExit(2, null);
  const observed = await f.adapter.observe(f.job(), f.binding);
  assert.equal(observed.state, 'UNKNOWN');
  assert.equal(observed.provenance, 'OFFICE_LOCAL');
  assert.match(
    observed.detail,
    /exited on its own \(code 2\) without a trusted receipt — no receipt, no provider error record; a self-exit is not a failure claim/,
  );
  assert.match(observed.detail, /spawned process 4321 exited \(code 2\)/);
});

test('a self-exited claude CLI that reported its own error lands FAILED, provider-reported', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  const child = f.calls[0].child;
  child.stdout.write('{"type":"system","subtype":"init"}\n');
  child.stdout.write(
    '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Rate limit reached while streaming."}\n',
  );
  child.emitExit(1, null);
  const observed = await f.adapter.observe(f.job(), bound);
  assert.equal(observed.state, 'FAILED');
  assert.equal(observed.provenance, 'PROVIDER_REPORTED');
  assert.match(observed.detail, /Rate limit reached while streaming/);
  assert.doesNotMatch(
    observed.detail,
    /office-spawned process|still running/,
    'a terminal observation carries no liveness suffix',
  );
  assert.equal(observed.transientProviderError, undefined, 'no documented transient signature — no retry flag');
});

test('the documented transient OAuth-refresh signature flags transientProviderError', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  const child = f.calls[0].child;
  child.stdout.write(
    '{"type":"result","is_error":true,"terminal_reason":"api_error","result":"Failed to refresh OAuth token (transient). Please try again."}\n',
  );
  child.emitExit(1, null);
  const observed = await f.adapter.observe(f.job(), bound);
  assert.equal(observed.state, 'FAILED');
  assert.equal(observed.provenance, 'PROVIDER_REPORTED');
  assert.equal(observed.transientProviderError, true, "the office's one-shot retry flag rides the failure");
});

test('the transient flag needs the whole documented signature — partial matches stay plain failures', async t => {
  // The OAuth text without terminal_reason 'api_error' is not the documented transient.
  const a = fixture(t, { provider: 'claude' });
  await submitted(a);
  a.calls[0].child.stdout.write(
    '{"type":"result","is_error":true,"terminal_reason":"execution_error","result":"Failed to refresh OAuth token"}\n',
  );
  a.calls[0].child.emitExit(1, null);
  const first = await a.adapter.observe(a.job(), a.binding);
  assert.equal(first.state, 'FAILED');
  assert.equal(first.transientProviderError, undefined);
  // api_error without the documented text is not either.
  const b = fixture(t, { provider: 'claude' });
  await submitted(b);
  b.calls[0].child.stdout.write(
    '{"type":"result","is_error":true,"terminal_reason":"api_error","result":"Request rejected: context length exceeded."}\n',
  );
  b.calls[0].child.emitExit(1, null);
  const second = await b.adapter.observe(b.job(), b.binding);
  assert.equal(second.state, 'FAILED');
  assert.equal(second.transientProviderError, undefined);
});

test('a codex self-exit with a Claude result-looking line stays UNKNOWN', async t => {
  const f = fixture(t, { provider: 'openai' });
  await submitted(f);
  f.calls[0].child.stdout.write('{"type":"result","is_error":true,"result":"not a documented record"}\n');
  f.calls[0].child.emitExit(1, null);
  const observed = await f.adapter.observe(f.job(), f.binding);
  assert.equal(observed.state, 'UNKNOWN');
  assert.equal(observed.provenance, 'OFFICE_LOCAL');
  assert.match(observed.detail, /no receipt, no provider error record/);
});

test('Codex turn.failed is a provider terminal failure; a standalone error remains UNKNOWN', async t => {
  for (const terminal of [false, true]) {
    const f = fixture(t, { provider: 'openai' });
    const { bound } = await submitted(f);
    f.calls[0].child.stdout.write(
      JSON.stringify(
        terminal
          ? { type: 'turn.failed', error: { message: 'Invalid model' } }
          : { type: 'error', message: 'Reconnecting' },
      ) + '\n',
    );
    f.calls[0].child.emitExit(1);
    const observed = await f.adapter.observe(f.job(), bound);
    assert.equal(observed.state, terminal ? 'FAILED' : 'UNKNOWN');
    if (terminal) {
      assert.equal(observed.provenance, 'PROVIDER_REPORTED');
      assert.match(observed.detail, /provider reported a failed turn: Invalid model/);
      assert.equal(observed.transientProviderError, undefined);
    }
  }
});

test('Codex structured tool items stream as TOOL events before a receipt; prose stays MESSAGE', async t => {
  const f = fixture(t, { provider: 'openai' });
  const { bound } = await submitted(f);
  for (const type of ['item.started', 'item.updated', 'item.completed'])
    f.calls[0].child.stdout.write(
      JSON.stringify({ type, item: { type: 'command_execution', command: 'synthetic command' } }) + '\n',
    );
  f.calls[0].child.stdout.write('ordinary tool-looking prose\n');
  const observed = await f.adapter.observe(f.job(), bound);
  assert.deepEqual(
    observed.events!.map(e => e.kind),
    ['TOOL', 'TOOL', 'TOOL', 'MESSAGE'],
  );
  assert.equal(observed.state, 'UNKNOWN', 'streaming does not invent a terminal receipt');
});

test('failures before any child could spawn throw NotLaunchedError; a spawn throw stays ordinary', async t => {
  // A dirty packet destination — prepareLocalPacket refuses before anything could spawn.
  const dirty = fixture(t);
  mkdirSync(dirty.dir, { recursive: true });
  writeFileSync(path.join(dirty.dir, RESULT_FILE), '{}');
  await assert.rejects(dirty.adapter.submit(dirty.context), (error: unknown) => error instanceof NotLaunchedError);
  assert.equal(dirty.calls.length, 0, 'no provider spawn happened');
  // A missing CLI executable — resolved after the packet and probes, still pre-spawn.
  const missing = fixture(t, { executableError: true });
  await assert.rejects(missing.adapter.submit(missing.context), (error: unknown) => error instanceof NotLaunchedError);
  assert.equal(missing.calls.length, 0);
  // A synchronous spawn failure keeps an ordinary error — the child may exist.
  const spawnFailed = fixture(t, { spawnThrows: true });
  await assert.rejects(
    spawnFailed.adapter.submit(spawnFailed.context),
    (error: unknown) => !(error instanceof NotLaunchedError) && /spawn failed/.test((error as Error).message),
  );
});

test('buffered child output drains into deduped PROVIDER_REPORTED job events', async t => {
  const f = fixture(t, { provider: 'claude' });
  await submitted(f);
  const child = f.calls[0].child;
  child.stdout.write('first line\nsecond ');
  child.stdout.write('line\n');
  child.stderr.write('an error line\n');
  const first = await f.adapter.observe(f.job(), f.binding);
  assert.equal(first.events!.length, 3);
  assert.deepEqual(
    first.events!.map(e => e.text),
    ['first line', 'second line', 'an error line'],
  );
  for (const [index, event] of first.events!.entries()) {
    assert.equal(event.kind, 'MESSAGE');
    assert.equal(event.evidence, 'PROVIDER_REPORTED');
    assert.equal(event.externalId, `spawn:4321:${index + 1}`);
    assert.equal(event.cursor, `spawn:4321:${index + 1}`);
  }
  const again = await f.adapter.observe(f.job(), f.binding);
  assert.equal(again.events, undefined, 'repeat observations emit no duplicate events');
  child.stdout.write('late line\n');
  const third = await f.adapter.observe(f.job(), f.binding);
  assert.deepEqual(
    third.events!.map(e => e.text),
    ['late line'],
  );
});

test('a timeout fires the office kill and observe reports FAILED office-local', async t => {
  const f = fixture(t, { provider: 'claude', timeoutMs: 30 });
  await submitted(f);
  await sleep(80);
  assert.equal(f.calls[0].child.kills.length, 1, 'the office killed the timed-out child');
  f.calls[0].child.emitExit(null, 'SIGTERM');
  const observed = await f.adapter.observe(f.job(), f.binding);
  assert.equal(observed.state, 'FAILED');
  assert.equal(observed.provenance, 'OFFICE_LOCAL');
  assert.match(
    observed.detail,
    /office terminated the spawned process \([^)]*run limit elapsed\); a killed run cannot be trusted to write a receipt/,
  );
});

test('cancel writes the sentinel and kills the office-owned child', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  const cancelled = await f.adapter.cancel(f.job(), bound);
  assert.equal(cancelled.acknowledged, true);
  assert.ok(cancelled.requestId);
  assert.ok(existsSync(path.join(f.dir, 'cancel.requested')), 'the cooperative sentinel is on disk');
  const request = JSON.parse(readFileSync(path.join(f.dir, 'cancel.requested'), 'utf8'));
  assert.equal(request.requestId, cancelled.requestId);
  assert.equal(request.attemptId, bound.attemptId);
  assert.equal(f.calls[0].child.kills.length, 1, 'the office-owned child was terminated');
  assert.match(cancelled.detail, /the office terminated the spawned process \(pid 4321\)/);
  const observed = await f.adapter.observe(f.job(), bound);
  assert.equal(observed.state, 'FAILED');
  assert.match(observed.detail, /a killed run cannot be trusted to write a receipt/);
});

test('cancel with no office-owned process writes the advisory sentinel only', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  f.calls[0].child.emitExit(0, null);
  const cancelled = await f.adapter.cancel(f.job(), bound);
  assert.equal(cancelled.acknowledged, true);
  assert.ok(existsSync(path.join(f.dir, 'cancel.requested')));
  assert.equal(f.calls[0].child.kills.length, 0, 'nothing is killed twice');
  assert.match(cancelled.detail, /no office-owned process is alive — the sentinel is advisory/);

  const restarted = fixture(t, { provider: 'claude' });
  const restartResult = await restarted.adapter.submit(restarted.context);
  const restartBound = { ...restarted.binding, packetHash: restartResult.localPacket!.packetHash };
  const fresh = new LocalCliExecAdapter({
    sessionsRoot: () => restarted.sessions,
    executable: p => restarted.executables[p],
    now: () => at(2),
  });
  const orphan = await fresh.cancel(restarted.job(), restartBound);
  assert.equal(orphan.acknowledged, true, 'the sentinel is still delivered');
  assert.ok(existsSync(path.join(restarted.dir, 'cancel.requested')));
  assert.match(orphan.detail, /no office-owned process is alive — the sentinel is advisory/);
  assert.equal(restarted.calls[0].child.kills.length, 0, 'a fresh office never kills a child it does not own');
});

test('a restarted office reports the recorded pid as informational, never ownership', async t => {
  // The fixture's recorded pid is this very test process — alive, but not spawned by the office.
  const f = fixture(t, { provider: 'claude', pid: process.pid });
  const { result, bound } = await submitted(f);
  const fresh = new LocalCliExecAdapter({
    sessionsRoot: () => f.sessions,
    executable: p => f.executables[p],
    now: () => at(2),
  });
  const observed = await fresh.observe(f.job(result.detail), bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(
    observed.detail,
    new RegExp(
      `a process with the recorded pid ${process.pid} is alive, but this office process did not spawn it — liveness is informational; the office does not claim ownership`,
    ),
  );
});

test('a dead recorded pid reports as not running after a restart', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  const fresh = new LocalCliExecAdapter({
    sessionsRoot: () => f.sessions,
    executable: p => f.executables[p],
    now: () => at(2),
  });
  // A pid the test fabricates is overwhelmingly unlikely to name a live process; either honest
  // wording is accepted — the requirement is that no ownership is claimed.
  const observed = await fresh.observe(
    f.job('Packet written and spawned unattended (pid 4194303). The office owns the process.'),
    bound,
  );
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(observed.detail, /the recorded pid 4194303 (is not running|could not be checked)/);
  assert.doesNotMatch(observed.detail, /office owns|office-spawned process 4194303 is still running/);
});

test('plan returns the exact spawn command for the preview, prompt included', async t => {
  const f = fixture(t, { provider: 'claude', effort: 'low' });
  const planned = f.adapter.plan(f.context);
  const prompt = `${f.context.payload.text}\n\n${PROMPT_SUFFIX}`;
  assert.equal(planned.executable, 'claude.exe');
  assert.deepEqual(planned.args, [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--model',
    'fixture-model',
    '--effort',
    'low',
    ...CLAUDE_TAIL,
  ]);
  assert.equal(planned.cwd, f.dir, 'a bound context plans into the recorded session directory');
});

test('fetch returns verified output bytes through the guarded boundary', async t => {
  const f = fixture(t, { provider: 'claude' });
  const { bound } = await submitted(f);
  mkdirSync(path.join(f.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'out.txt'), 'result bytes');
  const output = { path: 'outputs/out.txt', sha256: sha('result bytes'), bytes: Buffer.byteLength('result bytes') };
  const bytes = await f.adapter.fetch(f.job(), output, bound);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'result bytes');
  await assert.rejects(f.adapter.fetch(f.job(), { ...output, sha256: sha('drifted') }, bound), /hashes to/);
  await assert.rejects(f.adapter.fetch(f.job(), { ...output, bytes: 1 }, bound), /not the 1 the receipt recorded/);
});

test('consecutive claude launches are spaced so concurrent sessions do not race the OAuth refresh', async t => {
  const f = fixture(t, { provider: 'claude' });
  const spawnedAt: number[] = [];
  const spawn: CliSpawn = (executable, args, options) => {
    spawnedAt.push(Date.now());
    return f.spawn(executable, args, options);
  };
  const gap = 150;
  const adapter = new LocalCliExecAdapter({
    sessionsRoot: () => f.sessions,
    executable: provider => f.executables[provider],
    now: () => at(1),
    spawnChild: spawn,
    environment: f.environment,
    claudeSpawnGapMs: gap,
  });
  t.after(() => adapter.disposeAll());
  const second = {
    ...f.binding,
    id: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    storageRelativePath: 'exec-session-2',
  };
  await Promise.all([
    adapter.submit(f.context),
    adapter.submit({ ...f.context, jobId: second.jobId, localSession: second }),
  ]);
  assert.equal(spawnedAt.length, 2);
  assert.ok(
    spawnedAt[1] - spawnedAt[0] >= gap - 5,
    `the second claude spawn waited ${spawnedAt[1] - spawnedAt[0]}ms, at least the ${gap}ms gap`,
  );
});

test('a prompt longer than the argv bound rides in PROMPT.md and the argv carries a pointer', async t => {
  const f = fixture(t, { provider: 'claude' });
  const longText = 'x'.repeat(MAX_ARGV_PROMPT_CHARS + 1000);
  await f.adapter.submit({ ...f.context, payload: { ...f.context.payload, text: longText } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[1], PROMPT_POINTER, 'the argv carries the short pointer, not the long prompt');
  const written = readFileSync(path.join(f.dir, PROMPT_FILE), 'utf8');
  assert.ok(written.startsWith(longText), 'PROMPT.md holds the full prompt, payload first');
  assert.ok(written.includes('## Packet essentials (office-generated)'), 'the packet essentials follow the payload');
});

test('a prompt within the argv bound is passed directly and writes no PROMPT.md', async t => {
  const f = fixture(t, { provider: 'claude' });
  await submitted(f);
  assert.notEqual(f.calls[0].args[1], PROMPT_POINTER);
  assert.equal(existsSync(path.join(f.dir, PROMPT_FILE)), false);
});
