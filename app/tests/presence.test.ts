import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRESENCE_STALLED_MS, RECENT_OUTCOME_MS, officeActivity, type LivePresence } from '../src/shared/activity';
import { LocalCliExecAdapter, type CliSpawn } from '../src/main/local-cli-exec';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import type { LocalSessionRecord } from '../src/shared/local-session';
import type { Agent, Assignment, InputSnapshot, JobEvent, ProviderJob, Request } from '../src/shared/types';

const now = Date.parse('2026-09-29T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

/** The synthetic record set officeActivity reads — one worker with one open local job. */
function records(
  jobPatch: Partial<ProviderJob> = {},
  extra: { events?: JobEvent[]; request?: Partial<Request>; sessions?: LocalSessionRecord[] } = {},
) {
  const old = ago(60 * 60000);
  const agent = {
    id: 'agent-1',
    name: 'Test worker 1',
    provider: 'claude',
    model: 'opus',
    role: 'WORKER',
    team: 'Research',
    instructions: '',
    account: 'acct',
    createdAt: old,
    connectionVerifiedAt: old,
    execution: 'LOCAL',
  } as Agent;
  const assignment = { id: 'assignment-1', agentId: agent.id } as Assignment;
  const job = {
    id: 'job-1',
    assignmentId: assignment.id,
    projectId: 'project-1',
    requestId: 'request-1',
    state: 'RUNNING',
    // A local launch records the office's own bookkeeping, never a provider report.
    evidence: 'OFFICE_LOCAL',
    detail: 'Spawned.',
    createdAt: old,
    updatedAt: old,
    settledAt: '',
    ...jobPatch,
  } as unknown as ProviderJob;
  return {
    agents: [agent],
    assignments: [assignment],
    jobs: [job],
    jobEvents: extra.events ?? [],
    messages: [],
    requests: [{ id: 'request-1', status: 'ACTIVE', ...extra.request } as Request],
    localSessions: extra.sessions ?? [],
  };
}
const presence = (patch: Partial<LivePresence> = {}): LivePresence => ({
  jobId: 'job-1',
  provider: 'claude',
  pid: 4321,
  startedAt: ago(90_000),
  lastOutputAt: null,
  alive: true,
  ...patch,
});

test('without presence an office-launched job with no provider event is unknown, as before', () => {
  const [seat] = officeActivity(records(), { now });
  assert.equal(seat.kind, 'UNKNOWN');
  assert.equal(seat.evidence, 'NONE');
});

test('an alive office-owned process lights the seat as working, labelled office-observed', () => {
  const [seat] = officeActivity(records(), { now, presence: [presence()] });
  assert.equal(seat.kind, 'WORKING');
  assert.equal(seat.evidence, 'OFFICE_OBSERVED');
  assert.equal(seat.jobId, 'job-1');
  assert.equal(seat.startedAt, ago(90_000));
  assert.equal(seat.silentMs, 90_000, 'silence is measured from launch when the child has written nothing');
  assert.equal(seat.stalled, undefined);
  assert.match(seat.detail, /claude process/);
  assert.match(seat.detail, /has not reported progress/, 'the office never invents what the CLI is doing');
});

test('presence for another job, or a process that ended, never lights a seat', () => {
  assert.equal(officeActivity(records(), { now, presence: [presence({ jobId: 'other-job' })] })[0].kind, 'UNKNOWN');
  const [ended] = officeActivity(records(), { now, presence: [presence({ alive: false })] });
  assert.equal(ended.kind, 'UNKNOWN');
  assert.match(ended.detail, /has exited/);
});

test('a fresh provider event outranks the office observation as evidence', () => {
  const events = [
    {
      id: 'e1',
      jobId: 'job-1',
      kind: 'STATUS',
      text: 'Reading data.csv',
      occurredAt: ago(20_000),
      receivedAt: ago(20_000),
      evidence: 'PROVIDER_REPORTED',
    } as JobEvent,
  ];
  const [seat] = officeActivity(records({}, { events }), { now, presence: [presence()] });
  assert.equal(seat.kind, 'WORKING');
  assert.equal(seat.evidence, 'PROVIDER_REPORTED');
  assert.equal(seat.detail, 'Reading data.csv');
});

test('an alive process that spoke and then went quiet for ten minutes is flagged stalled, not idle', () => {
  const quiet = presence({ lastOutputAt: ago(PRESENCE_STALLED_MS + 1000), startedAt: ago(PRESENCE_STALLED_MS * 2) });
  const [seat] = officeActivity(records(), { now, presence: [quiet] });
  assert.equal(seat.kind, 'WORKING');
  assert.equal(seat.stalled, true);
  const [buffered] = officeActivity(records(), {
    now,
    presence: [presence({ startedAt: ago(PRESENCE_STALLED_MS * 2) })],
  });
  assert.equal(
    buffered.stalled,
    undefined,
    'a CLI that buffers all output until exit is silent by design, not stalled',
  );
});

test('a canceled request with a live office process still reads as working until the process ends', () => {
  const [seat] = officeActivity(records({}, { request: { status: 'CANCELED' } }), { now, presence: [presence()] });
  assert.equal(seat.kind, 'WORKING');
});

test('a job that settled moments ago is a recorded recent outcome on an idle seat', () => {
  const done = records({ state: 'COMPLETED', settledAt: ago(60_000), updatedAt: ago(60_000) });
  const [seat] = officeActivity(done, { now });
  assert.equal(seat.kind, 'IDLE');
  assert.equal(seat.recent?.outcome, 'DONE');
  assert.equal(seat.recent?.requestId, 'request-1');
  const failed = records({ state: 'FAILED', settledAt: ago(60_000), updatedAt: ago(60_000) });
  assert.equal(officeActivity(failed, { now })[0].recent?.outcome, 'FAILED');
  const old = records({
    state: 'COMPLETED',
    settledAt: ago(RECENT_OUTCOME_MS + 1000),
    updatedAt: ago(RECENT_OUTCOME_MS + 1000),
  });
  assert.equal(officeActivity(old, { now })[0].recent, undefined, 'an old outcome no longer flashes');
});

// --- the adapter's side ---------------------------------------------------------------------

class Child {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private exits: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  constructor(readonly pid = 777) {}
  kill() {
    return true;
  }
  on(event: string, listener: never) {
    if (event === 'exit') this.exits.push(listener);
    return this;
  }
  exit(code = 0) {
    for (const listener of this.exits) (listener as (c: number | null, s: null) => void)(code, null);
  }
}

test('the exec adapter reports presence for children it owns, and only those', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-presence-'));
  const sessions = path.join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const staging = path.join(root, 'staging');
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'notes.txt'), 'notes');
  let clock = Date.parse('2026-09-29T10:00:00Z');
  const children: Child[] = [];
  const spawn: CliSpawn = () => {
    const child = new Child();
    children.push(child);
    return child as never;
  };
  const adapter = new LocalCliExecAdapter({
    sessionsRoot: () => sessions,
    executable: () => 'claude.exe',
    now: () => new Date(clock).toISOString(),
    spawnChild: spawn,
    environment: () => ({}),
  });
  t.after(() => {
    adapter.disposeAll();
    removeTreeSync(root);
  });
  const announcements: number[] = [];
  adapter.onPresence = () => announcements.push(1);
  assert.deepEqual(adapter.presence(), [], 'nothing spawned means nothing is claimed');

  const snapshot = {
    id: randomUUID(),
    projectId: randomUUID(),
    requestId: randomUUID(),
    locationRevision: 0,
    requestRevision: 1,
    route: 'SELECTED_FILES_GIT_SNAPSHOT',
    files: [],
    totalBytes: 0,
    manifestHash: 'a'.repeat(64),
    stagingCommit: 'c',
    stagingPath: staging,
    warnings: [],
    provenance: 'OFFICE_STAGED',
    createdAt: new Date(clock).toISOString(),
  } as InputSnapshot;
  const assignment = {
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
    objectiveHash: 'b'.repeat(64),
    createdAt: new Date(clock).toISOString(),
  } as Assignment;
  const binding = {
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
    createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(),
  } as LocalSessionRecord;
  const context: SubmitContext = {
    assignment,
    snapshot,
    objective: 'Summarize.',
    requestName: 'Presence',
    payload: buildProviderPayload({
      requestName: 'Presence',
      objective: 'Summarize.',
      acceptanceCriteria: 'A summary.',
      instructions: '',
      model: 'm',
      effort: 'default',
      delegation: false,
    }),
    jobId: binding.jobId,
    localSession: binding,
  };
  await adapter.submit(context);
  assert.equal(announcements.length, 1, 'a spawn announces itself');
  const [started] = adapter.presence();
  assert.equal(started.jobId, binding.jobId);
  assert.equal(started.provider, 'claude');
  assert.equal(started.pid, 777);
  assert.equal(started.alive, true);
  assert.equal(started.lastOutputAt, null, 'silent since launch is stated as null, not as a guess');

  clock += 5000;
  children[0].stdout.write('{"partial":');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.presence()[0].lastOutputAt, new Date(clock).toISOString());
  assert.ok(announcements.length >= 2, 'output announces presence so the window can refresh');

  clock += 5000;
  children[0].exit(0);
  assert.equal(adapter.presence()[0].alive, false, 'an exited child is no longer alive, even before it is observed');
  adapter.disposeAll();
  assert.deepEqual(adapter.presence(), [], 'a released record leaves no presence behind');
});
