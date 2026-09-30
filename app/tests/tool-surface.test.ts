import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, NotLaunchedError, type SubmitContext } from '../src/main/controller';
import { LocalCliExecAdapter, type CliSpawn, type CliSpawnOptions } from '../src/main/local-cli-exec';
import {
  ANSWERS_DIR,
  QUERIES_DIR,
  isQueryFile,
  prepareEvidenceDropbox,
  serveEvidenceQuery,
} from '../src/main/evidence-dropbox';
import { GuardedLocalFileIO } from '../src/main/local-session-files';
import { mapToolFlags } from '../src/main/tool-flags';
import { EVIDENCE_SURFACE_ID, mountsEvidenceSurface, type ToolProfile } from '../src/shared/tool-profile';
import type { SerenaSpawn } from '../src/main/serena-session';
import type { EvidenceCaller } from '../src/main/evidence-tool';
import type { LocalSessionRecord } from '../src/shared/local-session';
import type { Assignment, InputSnapshot } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const CALLER: EvidenceCaller = { agentId: randomUUID(), projectId: randomUUID(), requestId: randomUUID() };

test('mountsEvidenceSurface detects only the reserved office id', () => {
  assert.equal(mountsEvidenceSurface(undefined), false);
  assert.equal(
    mountsEvidenceSurface({ mcpServers: [{ id: 'serena', command: 'serena start-mcp-server', readOnly: true }] }),
    false,
  );
  assert.equal(
    mountsEvidenceSurface({
      mcpServers: [{ id: EVIDENCE_SURFACE_ID, command: 'office evidence-surface', readOnly: true }],
    }),
    true,
  );
  assert.equal(isQueryFile('q-1.jsonl'), true);
  assert.equal(isQueryFile('nested/q-1.jsonl'), false);
  assert.equal(isQueryFile('note.txt'), false);
});

test('a query file is served under the office-bound caller, never the file bytes', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-dropbox-'));
  t.after(() => removeTreeSync(dir));
  const io = new GuardedLocalFileIO();
  mkdirSync(dir, { recursive: true });
  prepareEvidenceDropbox(dir, io);
  const seen: { caller: EvidenceCaller; line: string }[] = [];
  writeFileSync(
    path.join(dir, QUERIES_DIR, 'q-1.jsonl'),
    [
      '{"id":"a","op":"queryEvidence","args":{"pattern":"x"}}',
      '{"id":"b","op":"readEvidence","args":{"objectHash":"abc"}}',
      '',
    ].join('\n'),
  );
  await serveEvidenceQuery({
    dir,
    io,
    name: 'q-1.jsonl',
    caller: CALLER,
    frames: async (caller, line) => {
      seen.push({ caller, line });
      return JSON.stringify({ id: JSON.parse(line).id, result: { echo: true } });
    },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].caller, CALLER);
  const answer = readFileSync(path.join(dir, ANSWERS_DIR, 'q-1.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.deepEqual(
    answer.map(line => JSON.parse(line).id),
    ['a', 'b'],
  );
  assert.ok(answer.every(line => 'result' in JSON.parse(line)));
});

test('a repeated serve is a no-op — answers are never rewritten', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-dropbox-'));
  t.after(() => removeTreeSync(dir));
  const io = new GuardedLocalFileIO();
  prepareEvidenceDropbox(dir, io);
  writeFileSync(path.join(dir, QUERIES_DIR, 'q-2.jsonl'), '{"id":"a","op":"queryEvidence","args":{"pattern":"x"}}\n');
  let calls = 0;
  const frames = async () => {
    calls += 1;
    return JSON.stringify({ id: 'a', result: { n: calls } });
  };
  await serveEvidenceQuery({ dir, io, name: 'q-2.jsonl', caller: CALLER, frames });
  await serveEvidenceQuery({ dir, io, name: 'q-2.jsonl', caller: CALLER, frames });
  const answer = readFileSync(path.join(dir, ANSWERS_DIR, 'q-2.jsonl'), 'utf8');
  assert.match(answer, /"n":1/);
  assert.equal(calls >= 1, true);
});

test('an unreadable query file gets a FAILED frame instead of silence', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-dropbox-'));
  t.after(() => removeTreeSync(dir));
  const io = new GuardedLocalFileIO();
  prepareEvidenceDropbox(dir, io);
  writeFileSync(path.join(dir, QUERIES_DIR, 'q-3.jsonl'), 'x'.repeat(80 * 1024));
  await serveEvidenceQuery({ dir, io, name: 'q-3.jsonl', caller: CALLER, frames: async () => '' });
  const answer = JSON.parse(readFileSync(path.join(dir, ANSWERS_DIR, 'q-3.jsonl'), 'utf8').trim());
  assert.equal(answer.refused.reason, 'FAILED');
});

test('the evidence surface never reaches --mcp-config on any provider', () => {
  const profile: ToolProfile = {
    mcpServers: [
      { id: EVIDENCE_SURFACE_ID, command: 'office evidence-surface', readOnly: true },
      { id: 'serena', command: 'serena start-mcp-server', readOnly: true },
    ],
  };
  const claude = mapToolFlags({ provider: 'claude', model: 'm', effort: 'default', prompt: 'p', profile });
  const mcpIndex = claude.args.indexOf('--mcp-config');
  assert.ok(mcpIndex > 0);
  const config = JSON.parse(claude.args[mcpIndex + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ['serena']);
  assert.ok(claude.applied.some(line => line.includes('drop-box')));
  const codex = mapToolFlags({ provider: 'openai', model: 'm', effort: 'default', prompt: 'p', profile });
  assert.ok(codex.applied.some(line => line.includes('drop-box')));
  assert.ok(codex.unmapped.some(line => line.includes('[serena]')));
  const devin = mapToolFlags({ provider: 'devin', model: 'm', effort: 'default', prompt: 'p', profile });
  assert.ok(devin.applied.some(line => line.includes('drop-box')));
  assert.ok(devin.unmapped.some(line => line.includes('[serena]')));
});

/** A scripted serena child — stdin is writable, and the handshake answer can be pushed in. */
class FakeSerenaChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kills: unknown[] = [];
  constructor(
    readonly pid = 7777,
    handshake = true,
  ) {
    if (handshake)
      this.stdin.on('data', () => {
        this.stdout.write(
          '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"serena","version":"1.7.0"}}}\n',
        );
      });
  }
  kill(signal?: unknown) {
    this.kills.push(signal);
    return true;
  }
  on(_event: string, _listener: (...args: never[]) => void) {
    return this;
  }
}

interface ExecFixture {
  adapter: LocalCliExecAdapter;
  dir: string;
  context: SubmitContext;
  spawnCalls: SpawnCall[];
  serenaCalls: { executable: string; args: string[] }[];
}
interface SpawnCall {
  executable: string;
  args: string[];
  options: CliSpawnOptions;
  child: FakeChild;
}

class FakeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: unknown[] = [];
  constructor(readonly pid: number | undefined = 4321) {}
  kill(signal?: unknown) {
    this.kills.push(signal);
    return true;
  }
  on() {
    return this;
  }
}

function fixture(
  t: test.TestContext,
  options: {
    profile?: ToolProfile;
    serenaAnswers?: boolean;
    serenaMissing?: boolean;
    frames?: (caller: EvidenceCaller, line: string) => Promise<string>;
  } = {},
): ExecFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-surface-'));
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
  const spawnCalls: SpawnCall[] = [];
  const spawn: CliSpawn = (executable, args, spawnOptions) => {
    const child = new FakeChild();
    spawnCalls.push({ executable, args, options: spawnOptions, child });
    return child;
  };
  const serenaCalls: { executable: string; args: string[] }[] = [];
  const serenaSpawn: SerenaSpawn = (executable, args) => {
    serenaCalls.push({ executable, args });
    if (options.serenaMissing) throw Object.assign(new Error(`spawn ${executable} ENOENT`), { code: 'ENOENT' });
    return new FakeSerenaChild(7777, options.serenaAnswers ?? true) as never;
  };
  const adapter = new LocalCliExecAdapter({
    sessionsRoot: () => sessions,
    executable: provider => `${provider}.exe`,
    now: () => at(1),
    spawnChild: spawn,
    environment: () => ({ TEST_ENV: 'scrubbed' }),
    serenaSpawn,
    serenaReadyTimeoutMs: 60,
    evidenceFrames: options.frames,
    claudeSpawnGapMs: 0,
  });
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
    requestedModel: 'm',
    resolvedModel: '',
    requestedEffort: 'default',
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
    provider: 'claude',
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
      model: 'm',
      effort: 'default',
      delegation: false,
    }),
    jobId: binding.jobId,
    localSession: binding,
  };
  return { adapter, dir: path.resolve(sessions, binding.storageRelativePath), context, spawnCalls, serenaCalls };
}

test('a declared serena profile is gated on an observed initialize handshake before launch', async t => {
  const f = fixture(t, {
    profile: { mcpServers: [{ id: 'serena', command: 'serena start-mcp-server', readOnly: true }] },
  });
  const result = await f.adapter.submit(f.context);
  assert.equal(f.serenaCalls.length, 1);
  assert.equal(f.serenaCalls[0].executable, 'serena', 'spawn runs without a shell, so the sub-command is an argument');
  assert.equal(f.serenaCalls[0].args[0], 'start-mcp-server');
  assert.ok(f.serenaCalls[0].args.includes('--project'));
  assert.ok(f.serenaCalls[0].args.includes('--read-only'));
  assert.ok(existsSync(path.join(f.dir, '.serena', 'project.yml')));
  assert.match(readFileSync(path.join(f.dir, '.serena', 'project.yml'), 'utf8'), /read_only: true/);
  assert.equal(f.spawnCalls.length, 1);
  assert.match(result.detail, /readiness probe passed/);
});

test('a serena probe that never answers refuses the launch — no provider spawn', async t => {
  const f = fixture(t, {
    profile: { mcpServers: [{ id: 'serena', command: 'serena start-mcp-server', readOnly: true }] },
    serenaAnswers: false,
  });
  await assert.rejects(
    f.adapter.submit(f.context),
    (error: unknown) => error instanceof NotLaunchedError && /readiness probe/.test(error.message),
  );
  assert.equal(f.spawnCalls.length, 0);
});

test('an uninstalled serena is optional — the arm launches without it and the record says so', async t => {
  const f = fixture(t, {
    profile: { canWrite: false, mcpServers: [{ id: 'serena', command: 'serena start-mcp-server', readOnly: true }] },
    serenaMissing: true,
  });
  const result = await f.adapter.submit(f.context);
  assert.equal(f.spawnCalls.length, 1, 'the provider CLI still launched');
  assert.ok(!f.spawnCalls[0].args.includes('--mcp-config'), 'no --mcp-config names a server that is not installed');
  assert.match(result.detail, /serena is not installed on this machine/);
});

test('a declared evidence surface mounts the drop-box and serves a written query', async t => {
  const profile: ToolProfile = {
    mcpServers: [{ id: EVIDENCE_SURFACE_ID, command: 'office evidence-surface', readOnly: true }],
  };
  const answered: { caller: EvidenceCaller; line: string }[] = [];
  const f = fixture(t, {
    profile,
    frames: async (caller, line) => {
      answered.push({ caller, line });
      return JSON.stringify({ id: JSON.parse(line).id, result: { ok: true } });
    },
  });
  const result = await f.adapter.submit(f.context);
  assert.ok(existsSync(path.join(f.dir, QUERIES_DIR)) && existsSync(path.join(f.dir, ANSWERS_DIR)));
  assert.match(readFileSync(path.join(f.dir, 'CONTRACT.md'), 'utf8'), /queries\/<name>\.jsonl/);
  assert.match(result.detail, /evidence surface mounted/);
  // The agent writes a query file; the watcher serves it under the assignment's identity.
  writeFileSync(
    path.join(f.dir, QUERIES_DIR, 'q-9.jsonl'),
    '{"id":"one","op":"queryEvidence","args":{"pattern":"x"}}\n',
  );
  const deadline = Date.now() + 5000;
  let answer = '';
  while (Date.now() < deadline) {
    const file = path.join(f.dir, ANSWERS_DIR, 'q-9.jsonl');
    if (existsSync(file)) {
      answer = readFileSync(file, 'utf8');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(answer, /"id":"one".*"result"/);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].caller.agentId, f.context.assignment.agentId);
  assert.equal(answered[0].caller.requestId, f.context.assignment.requestId);
});

test('a declared evidence surface with no frame handler refuses the launch', async t => {
  const f = fixture(t, {
    profile: { mcpServers: [{ id: EVIDENCE_SURFACE_ID, command: 'office evidence-surface', readOnly: true }] },
  });
  await assert.rejects(
    f.adapter.submit(f.context),
    (error: unknown) => error instanceof NotLaunchedError && /evidence frame handler/.test(error.message),
  );
  assert.equal(f.spawnCalls.length, 0);
});

test('an unprofiled session still launches byte-identically — no probe, no drop-box', async t => {
  const f = fixture(t);
  const result = await f.adapter.submit(f.context);
  assert.equal(f.serenaCalls.length, 0);
  assert.equal(f.spawnCalls.length, 1);
  assert.ok(!existsSync(path.join(f.dir, QUERIES_DIR)));
  assert.doesNotMatch(result.detail, /serena|evidence surface/);
});
