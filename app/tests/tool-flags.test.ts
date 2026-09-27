import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import { LocalCliExecAdapter, type CliSpawn, type CliSpawnOptions } from '../src/main/local-cli-exec';
import {
  CLAUDE_DEFAULT_TOOLS,
  CLAUDE_ISOLATION_FLAGS,
  CODEX_DISABLED_FEATURES,
  mapToolFlags,
} from '../src/main/tool-flags';
import type { LocalSessionRecord } from '../src/shared/local-session';
import type { ToolProfile } from '../src/shared/tool-profile';
import type { Assignment, InputSnapshot, Provider, ProviderJob } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const PROMPT_SUFFIX =
  'This directory is an office-local-session@2 packet: read packet.json and CONTRACT.md, place declared outputs under outputs/, then write result.json exactly as CONTRACT.md specifies.';
const PROMPT = 'fixture prompt';

/** The pre-profile claude argv; every claude launch now adds the isolation flags after it. */
const CLAUDE_BASE = [
  '-p',
  PROMPT,
  '--output-format',
  'json',
  '--dangerously-skip-permissions',
  '--model',
  'fixture-model',
];
const CLAUDE_ISOLATION = [...CLAUDE_ISOLATION_FLAGS];
const CLAUDE_DEFAULT = ['--tools', CLAUDE_DEFAULT_TOOLS.join(',')];
/** codex's lean baseline: user MCP servers detached, unused tool features (and sub-agents) disabled. */
const CODEX_LEAN = [
  '-c',
  'mcp_servers={}',
  ...[...CODEX_DISABLED_FEATURES, 'multi_agent'].flatMap(feature => ['--disable', feature]),
];
/**
 * The argv for each provider with no profile, frozen verbatim — devin stays byte-identical to
 * the pre-profile builder; claude adds the session-isolation flags and the default packet tool
 * set; codex adds its lean feature/MCP overrides before the prompt.
 */
const BASELINE: Record<Provider, string[]> = {
  claude: [...CLAUDE_BASE, ...CLAUDE_ISOLATION, ...CLAUDE_DEFAULT],
  openai: ['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-m', 'fixture-model', ...CODEX_LEAN, PROMPT],
  devin: [
    '-p',
    PROMPT,
    '--model',
    'fixture-model',
    '--respect-workspace-trust',
    'false',
    '--permission-mode',
    'dangerous',
  ],
};
const flags = (
  provider: Provider,
  profile?: ToolProfile,
  effort: 'default' | 'high' | 'minimal' = 'default',
  platform?: NodeJS.Platform,
) =>
  mapToolFlags(
    { provider, model: 'fixture-model', effort, prompt: PROMPT, ...(profile ? { profile } : {}) },
    ...(platform ? [platform] : []),
  );

test('an absent profile produces byte-identical args for every provider', () => {
  for (const provider of ['claude', 'openai', 'devin'] as const) {
    const result = flags(provider);
    assert.deepEqual(result.args, BASELINE[provider], `${provider} argv is unchanged without a profile`);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.unmapped, []);
    assert.equal(result.effortFlag, null);
    assert.equal(result.unmappedEffort, null);
  }
  const effort = flags('claude', undefined, 'high');
  assert.deepEqual(
    effort.args,
    [...CLAUDE_BASE, '--effort', 'high', ...CLAUDE_ISOLATION, ...CLAUDE_DEFAULT],
    'the documented effort flag still lands',
  );
  assert.equal(effort.effortFlag, '--effort high');
  const codexHigh = flags('openai', undefined, 'high');
  assert.equal(
    codexHigh.effortFlag,
    '-c model_reasoning_effort=high',
    'codex effort rides the documented config override',
  );
  assert.deepEqual(codexHigh.args.slice(6, 8), ['-c', 'model_reasoning_effort=high']);
  assert.equal(codexHigh.unmappedEffort, null);
  assert.equal(
    flags('openai', undefined, 'minimal').unmappedEffort,
    'minimal',
    'an effort codex refuses stays honestly unmapped',
  );
  assert.ok(!flags('openai', undefined, 'minimal').args.some(arg => arg.startsWith('model_reasoning_effort')));
});

test('claude maps allowedTools to --tools and mcpServers to --mcp-config, both verified in --help', () => {
  const profile: ToolProfile = {
    allowedTools: ['Read', 'Bash(git *)'],
    mcpServers: [{ id: 'serena', command: 'serena serve', args: ['--scope', 'packet'], readOnly: true }],
  };
  const result = flags('claude', profile);
  assert.deepEqual(result.args.slice(-4), [
    '--tools',
    'Read,Bash(git *)',
    '--mcp-config',
    JSON.stringify({ mcpServers: { serena: { command: 'serena', args: ['serve', '--scope', 'packet'] } } }),
  ]);
  assert.deepEqual(
    result.args.slice(0, CLAUDE_BASE.length + CLAUDE_ISOLATION.length),
    [...CLAUDE_BASE, ...CLAUDE_ISOLATION],
    'profile flags append after the baseline argv',
  );
  assert.ok(!result.args.includes(CLAUDE_DEFAULT[1]), 'a declared allowlist replaces the default tool set');
  assert.equal(result.applied.length, 2);
  assert.match(result.applied[0], /allowedTools \[Read, Bash\(git \*\)\] restricted via --tools/);
  assert.match(result.applied[1], /mcpServers \[serena\] attached via --mcp-config/);
  assert.deepEqual(result.unmapped, []);
});

test('claude cannot express filesystem or read-only restrictions — both stay declared, not enforced', () => {
  const result = flags('claude', { filesystem: 'PACKET_ONLY', canWrite: false });
  assert.deepEqual(result.args, BASELINE.claude, 'no phantom flag is added for an unexpressible restriction');
  assert.deepEqual(result.applied, []);
  assert.equal(result.unmapped.length, 2);
  assert.match(result.unmapped[0], /filesystem=PACKET_ONLY: declared, not enforced by claude/);
  assert.match(result.unmapped[1], /canWrite=false: declared, not enforced by claude/);
});

test('codex maps canWrite=false to the verified -s read-only sandbox mode', () => {
  const result = flags('openai', { canWrite: false });
  const expected = [...BASELINE.openai];
  expected[2] = 'read-only';
  assert.deepEqual(result.args, expected, 'the baseline -s value is replaced, never duplicated');
  assert.deepEqual(
    result.bypassFlags,
    ['-s', 'read-only', '--skip-git-repo-check'],
    'the recorded bypass flags name the mode actually spawned',
  );
  assert.match(result.applied[0], /canWrite=false enforced via -s read-only/);
  assert.deepEqual(result.unmapped, []);
});

test('codex carries filesystem through the sandbox mode but cannot express a tool allowlist or mcp attach', () => {
  const profile: ToolProfile = {
    filesystem: 'PACKET_ONLY',
    canWrite: false,
    allowedTools: ['shell'],
    mcpServers: [{ id: 'serena', command: 'serena serve', readOnly: true }],
  };
  const result = flags('openai', profile);
  assert.equal(result.args[2], 'read-only');
  assert.equal(result.applied.length, 2, 'canWrite and filesystem are carried');
  assert.match(result.applied[1], /filesystem=PACKET_ONLY carried by -s read-only/);
  assert.equal(result.unmapped.length, 2);
  assert.match(result.unmapped[0], /allowedTools \[shell\]: declared, not enforced by codex/);
  assert.match(result.unmapped[1], /mcpServers \[serena\]: declared, not enforced by codex/);
});

test('codex satisfies READ_PROJECT and canWrite=true under the baseline workspace-write sandbox', () => {
  const result = flags('openai', { filesystem: 'READ_PROJECT', canWrite: true });
  assert.deepEqual(result.args, BASELINE.openai, 'the baseline mode already covers both declarations');
  assert.equal(result.applied.length, 2);
  assert.match(result.applied[0], /canWrite=true permitted by the baseline -s workspace-write/);
  assert.match(result.applied[1], /filesystem=READ_PROJECT satisfied by -s workspace-write/);
  assert.deepEqual(result.unmapped, []);
});

test('devin on Windows expresses nothing but a write-permitted baseline — every restriction is honestly unmapped', () => {
  const profile: ToolProfile = {
    allowedTools: ['exec'],
    filesystem: 'PACKET_ONLY',
    canWrite: false,
    mcpServers: [{ id: 'serena', command: 'serena serve', readOnly: true }],
  };
  const result = flags('devin', profile, 'default', 'win32');
  assert.deepEqual(result.args, BASELINE.devin, 'devin adds no flag it cannot honor on this OS');
  assert.equal(result.unmapped.length, 4);
  for (const entry of result.unmapped) assert.match(entry, /declared, not enforced by devin/);
  assert.match(
    result.unmapped.find(e => e.startsWith('filesystem'))!,
    /--sandbox is documented for macOS seatbelt \/ Linux bwrap only/,
  );
  assert.match(
    result.unmapped.find(e => e.startsWith('canWrite'))!,
    /--permission-mode dangerous verbatim/,
  );
  const writable = flags('devin', { canWrite: true }, 'default', 'win32');
  assert.match(writable.applied[0], /canWrite=true permitted by the baseline --permission-mode dangerous/);
});

test('devin on a sandboxed OS carries filesystem via --sandbox and still cannot refuse writes', () => {
  const result = flags('devin', { filesystem: 'PACKET_ONLY', canWrite: false }, 'default', 'linux');
  assert.ok(result.args.includes('--sandbox'));
  assert.match(result.applied[0], /filesystem=PACKET_ONLY partially carried by --sandbox/);
  assert.match(result.unmapped[0], /canWrite=false: declared, not enforced by devin/);
});

test('a documented effort flag and a tool profile coexist on the same argv', () => {
  const result = flags('claude', { allowedTools: ['Read'] }, 'high');
  assert.deepEqual(result.args.slice(7, 9), ['--effort', 'high']);
  assert.deepEqual(result.args.slice(-2), ['--tools', 'Read']);
  const unmapped = flags('claude', { allowedTools: ['Read'] }, 'minimal');
  assert.equal(unmapped.unmappedEffort, 'minimal', 'an undocumented effort is still recorded alongside the profile');
});

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

function fixture(t: test.TestContext, options: { provider?: Provider; profile?: ToolProfile } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-tool-flags-'));
  const staging = path.join(root, 'staging');
  mkdirSync(path.join(staging, 'data'), { recursive: true });
  writeFileSync(path.join(staging, 'data', 'input.csv'), 'a,b\n1,2\n');
  const snapshot: InputSnapshot = {
    id: randomUUID(),
    projectId: randomUUID(),
    requestId: randomUUID(),
    locationRevision: 0,
    requestRevision: 1,
    route: 'SELECTED_FILES_GIT_SNAPSHOT',
    files: [{ path: 'data/input.csv', bytes: Buffer.byteLength('a,b\n1,2\n'), sha256: sha('a,b\n1,2\n') }],
    totalBytes: Buffer.byteLength('a,b\n1,2\n'),
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
    const child = new FakeChild();
    calls.push({ executable, args, options: spawnOptions, child });
    return child;
  };
  const adapter = new LocalCliExecAdapter(
    () => sessions,
    provider => `${provider}.exe`,
    () => at(1),
    undefined,
    spawn,
    () => ({ TEST_ENV: 'scrubbed' }),
  );
  t.after(() => {
    adapter.disposeAll();
    removeTreeSync(root);
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
    requestedEffort: 'default',
    appliedEffort: 'UNVERIFIED',
    delegation: false,
    objectiveHash: sha('objective'),
    ...(options.profile ? { toolProfile: options.profile } : {}),
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
    ...(options.profile ? { toolProfile: options.profile } : {}),
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
      effort: 'default',
      delegation: false,
    }),
    jobId: binding.jobId,
    localSession: binding,
  };
  const dir = path.resolve(sessions, binding.storageRelativePath);
  return { root, sessions, calls, adapter, assignment, binding, context, dir };
}

test('a bound tool profile reaches the spawned argv and the confinement record names every residue', async t => {
  const profile: ToolProfile = {
    allowedTools: ['Read'],
    filesystem: 'PACKET_ONLY',
    canWrite: false,
    mcpServers: [{ id: 'serena', command: 'serena serve', readOnly: true }],
  };
  const f = fixture(t, { provider: 'openai', profile });
  const result = await f.adapter.submit(f.context);
  const prompt = f.calls[0].args.at(-1)!;
  assert.ok(prompt.startsWith(`${f.context.payload.text}\n\n## Packet essentials (office-generated)`));
  assert.deepEqual(
    f.calls[0].args,
    ['exec', '-s', 'read-only', '--skip-git-repo-check', '-m', 'fixture-model', ...CODEX_LEAN, prompt],
    'the profile downgraded the sandbox to the verified read-only mode',
  );
  const evidence = f.adapter.submitEvidence(f.context, result);
  const submit = evidence.find(e => e.operation === 'LOCAL_SUBMIT')!;
  assert.match(
    submit.detail,
    /"appliedRestrictions":\["canWrite=false enforced via -s read-only/,
    'the launch record carries the applied restriction verbatim',
  );
  assert.match(
    submit.detail,
    /"unmappedRestrictions":\["allowedTools \[Read\]: declared, not enforced by codex/,
    'the launch record carries the unmapped residue verbatim',
  );
  const tools = evidence.find(e => e.operation === 'TOOL_CONFINEMENT')!.confinement!.tools;
  assert.match(tools, /profile restrictions carried by verified CLI flags/);
  assert.match(tools, /canWrite=false enforced via -s read-only/);
  assert.match(tools, /filesystem=PACKET_ONLY carried by -s read-only/);
  assert.match(tools, /allowedTools \[Read\]: declared, not enforced by codex/);
  assert.match(tools, /mcpServers \[serena\]: declared, not enforced by codex/);
  assert.equal(
    (tools.match(/declared, not enforced by codex/g) ?? []).length,
    2,
    'each unmapped restriction is named individually',
  );
});

test('a claude profile lands --tools on the spawned argv and the record marks what claude cannot express', async t => {
  const f = fixture(t, { provider: 'claude', profile: { allowedTools: ['Read', 'Edit'], canWrite: false } });
  const result = await f.adapter.submit(f.context);
  assert.deepEqual(f.calls[0].args.slice(-2), ['--tools', 'Read,Edit']);
  const tools = f.adapter.submitEvidence(f.context, result).find(e => e.operation === 'TOOL_CONFINEMENT')!.confinement!
    .tools;
  assert.match(tools, /allowedTools \[Read, Edit\] restricted via --tools/);
  assert.match(tools, /canWrite=false: declared, not enforced by claude/);
});

test('an unprofiled binding keeps the baseline argv and declares no tool restriction', async t => {
  const f = fixture(t, { provider: 'claude' });
  const result = await f.adapter.submit(f.context);
  const prompt = f.calls[0].args[1];
  assert.deepEqual(f.calls[0].args, [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--model',
    'fixture-model',
    ...CLAUDE_ISOLATION,
    ...CLAUDE_DEFAULT,
  ]);
  const submit = f.adapter.submitEvidence(f.context, result).find(e => e.operation === 'LOCAL_SUBMIT')!;
  assert.match(
    submit.detail,
    /"appliedRestrictions":\[\],"unmappedRestrictions":\[\]/,
    'the launch record shows no profile residue',
  );
  const tools = f.adapter.submitEvidence(f.context, result).find(e => e.operation === 'TOOL_CONFINEMENT')!.confinement!
    .tools;
  assert.equal(tools, 'packet contents delivered: packet.json, the result contract and declared snapshot inputs');
});

test('the launch-plan preview applies the same profile flags a dispatch would spawn', async t => {
  const f = fixture(t, { provider: 'openai', profile: { canWrite: false } });
  const plan = f.adapter.plan(f.context);
  const prompt = `${f.context.payload.text}\n\n${PROMPT_SUFFIX}`;
  assert.deepEqual(plan.args, [
    'exec',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '-m',
    'fixture-model',
    ...CODEX_LEAN,
    prompt,
  ]);
  assert.equal(plan.executable, 'openai.exe');
});

test("delegation keeps each CLI's own sub-agent surface; without it the lean launch drops it", () => {
  const withAgents = mapToolFlags({
    provider: 'claude',
    model: 'm',
    effort: 'default',
    prompt: PROMPT,
    delegation: true,
  });
  assert.deepEqual(withAgents.args.slice(-2), ['--tools', [...CLAUDE_DEFAULT_TOOLS, 'Agent'].join(',')]);
  assert.ok(!flags('claude').args.at(-1)!.includes('Agent'));
  const codex = mapToolFlags({ provider: 'openai', model: 'm', effort: 'default', prompt: PROMPT, delegation: true });
  assert.ok(!codex.args.includes('multi_agent'), 'authorized delegation keeps codex multi_agent');
  assert.ok(flags('openai').args.includes('multi_agent'));
  assert.equal(codex.args.at(-1), PROMPT, 'the prompt stays the final codex argument');
});
