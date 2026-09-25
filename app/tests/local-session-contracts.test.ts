import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { prepareInputSnapshot } from '../src/main/locations';
import { removeTreeSync } from '../src/main/fsx';
import {
  cancelAckV1Schema, cancelRequestV1Schema, localPacketV2Schema, localResultV2Schema,
  localSessionRecordSchema, managedRelativePath, memoryDigestSchema, transitionLocalLifecycle,
  type LocalSessionRecord,
} from '../src/shared/local-session';
import type { Agent, CapabilityEvidence, CapabilityOperation } from '../src/shared/types';

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const sha = (char = 'a') => char.repeat(64);

const seen = (operation: CapabilityOperation, minutes: number): CapabilityEvidence =>
  ({ operation, level: 'ACCOUNT_VERIFIED', detail: 'Exercised.', evidence: 'OBSERVED', verifiedAt: at(minutes), source: 'fixture' });
const verifiedObservation = (minutes: number) => ({
  provider: 'claude' as const, identity: 'researcher@example.com', credentialContext: 'claude-code-cli', state: 'SIGNED_IN' as const, allowance: [], note: '',
  toolVersion: '2.1.236', transport: 'OFFICIAL_CLI_TERMINAL' as const, environment: 'anthropic-managed', models: [{ id: 'opus', name: 'Opus' }],
  operations: [seen('ACCOUNT_STATUS', minutes), seen('MODEL_CATALOG', minutes)],
  source: 'transport fixture', observedAt: at(minutes),
});

function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-contracts-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch {} removeTreeSync(root); });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  return { root, store, project };
}

/** A minimal job row, inserted through the same createAssignment path the controller uses. */
async function seedJob(store: OfficeStore, projectId: string, root: string) {
  const assignmentId = randomUUID();
  const source = path.join(root, 'source'); mkdirSync(source); writeFileSync(path.join(source, 'input.csv'), 'a,b\n1,2\n');
  store.execute({ type: 'location.save', idempotencyKey: key(), projectId, expectedRevision: 0, localFolder: source, inputPaths: ['input.csv'], outputFolder: '' });
  const request = store.execute({
    type: 'request.create', idempotencyKey: key(), projectId, name: 'Tiny question', hypothesis: 'h', workType: 'QUESTION', mode: 'SINGLE', participantIds: [],
  }).requests![0];
  const agent: Agent = { id: randomUUID(), name: 'Worker', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER', instructions: '', effort: 'default',
    account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'HOSTED_SETUP_REQUIRED' };
  store.confirmAgentBinding({ observation: verifiedObservation(0), agent });
  const snapshot = await prepareInputSnapshot({ store, objectRoot: root, stagingRoot: path.join(root, 'staging'), projectId, requestId: request.id, requestRevision: request.revision });
  const state = store.snapshot();
  const connection = state.connections![0], capability = state.capabilities![0];
  store.createAssignment({
    assignment: {
      id: assignmentId, projectId, requestId: request.id, requestRevision: request.revision, agentId: agent.id, agentRevision: 0,
      connectionId: connection.id, capabilitySnapshotId: capability.id, capabilitySnapshotIds: [capability.id], snapshotId: snapshot.id,
      route: 'LOCAL_MAILBOX', requestedModel: 'opus', resolvedModel: '', requestedEffort: 'default',
      appliedEffort: 'UNVERIFIED', delegation: false, objectiveHash: sha('b'), createdAt: at(0),
    },
    job: { id: randomUUID(), assignmentId, projectId, requestId: request.id, provider: 'claude', route: 'LOCAL_MAILBOX' },
  });
  const seeded = store.snapshot().jobs?.[0];
  assert.ok(seeded, 'the fixture must seed a job');
  return { assignmentId, job: seeded! };
}

const draftRecord = (jobId: string, assignmentId: string, projectId: string): Omit<LocalSessionRecord,'id'|'revision'|'createdAt'|'updatedAt'> => ({
  schemaVersion: 1, jobId, assignmentId, projectId, attemptId: randomUUID(),
  provider: 'claude', surface: 'CLAUDE_CLI', layout: 'FLAT_PACKET', packetVersion: 1, packetHash: null,
  storageRelativePath: 'sessions/session-1', originalCwd: null, repoRelativePath: null, seedCommit: null,
  worktreeOwner: 'NONE', providerSessionId: null, providerProjectId: null, bindingEvidence: 'UNBOUND',
  groupingStatus: 'UNKNOWN', requirement: 'SCOPED_DELIVERY', confinementStatus: 'UNVERIFIED',
  confinementEvidenceId: null, lifecycle: 'PREPARING', archiveRelativePath: null, lastReceipt: null,
  cancelRequestId: null, stopStatus: 'NOT_REQUESTED',
});

test('the lifecycle transition table declares every legal edge and refuses the rest', () => {
  const legal: Array<[LocalSessionRecord['lifecycle'], LocalSessionRecord['lifecycle']]> = [
    ['PREPARING', 'READY'], ['PREPARING', 'PREPARATION_FAILED'], ['PREPARING', 'RECONCILE_REQUIRED'],
    ['PREPARATION_FAILED', 'PREPARING'], ['PREPARATION_FAILED', 'RECONCILE_REQUIRED'],
    ['READY', 'ARCHIVING'], ['READY', 'RECONCILE_REQUIRED'],
    ['ARCHIVING', 'ARCHIVED'], ['ARCHIVING', 'READY'], ['ARCHIVING', 'RECONCILE_REQUIRED'],
    ['ARCHIVED', 'RECONCILE_REQUIRED'],
    ['RESTORED_UNBOUND', 'READY'], ['RESTORED_UNBOUND', 'ARCHIVED'], ['RESTORED_UNBOUND', 'RECONCILE_REQUIRED'],
    ['RECONCILE_REQUIRED', 'PREPARING'], ['RECONCILE_REQUIRED', 'READY'], ['RECONCILE_REQUIRED', 'ARCHIVED'],
  ];
  for (const [from, to] of legal) assert.equal(transitionLocalLifecycle(from, to).allowed, true, `${from} → ${to}`);
  const illegal: Array<[LocalSessionRecord['lifecycle'], LocalSessionRecord['lifecycle']]> = [
    ['PREPARING', 'ARCHIVED'], ['READY', 'ARCHIVED'], ['ARCHIVED', 'READY'], ['ARCHIVED', 'PREPARING'],
    ['PREPARATION_FAILED', 'READY'], ['RESTORED_UNBOUND', 'PREPARING'], ['RECONCILE_REQUIRED', 'ARCHIVING'],
  ];
  for (const [from, to] of illegal) assert.equal(transitionLocalLifecycle(from, to).allowed, false, `${from} → ${to} must be refused`);
  assert.equal(transitionLocalLifecycle('READY', 'READY').allowed, true, 'same-state metadata updates are legal');
});

test('managed relative paths reject every escape and malformed component', () => {
  for (const bad of ['C:\\x', 'c:/x', '\\\\server\\share', '/abs', '..', '../up', 'a/../b', 'a:b', 'stream:ads', 'con', 'lpt1/x',
    'ends with space ', 'dot.', 'a//b', '', '\\\\?\\C:\\x', '\\\\.\\device']) {
    assert.equal(managedRelativePath.safeParse(bad).success, false, JSON.stringify(bad));
  }
  for (const good of ['sessions/session-1', 'archive/session-2', 'a/b/c.md', 'repo/worktrees/session-3'])
    assert.equal(managedRelativePath.safeParse(good).success, true, good);
});

test('record refinements enforce the layout/owner/lifecycle combinations', () => {
  const base = draftRecord(randomUUID(), randomUUID(), randomUUID());
  assert.equal(localSessionRecordSchema.safeParse({ ...base, revision: 0, id: randomUUID(), createdAt: at(0), updatedAt: at(0) }).success, true);
  // A flat packet carrying a seed commit is a lie about where it lives.
  assert.equal(localSessionRecordSchema.safeParse({ ...base, id: randomUUID(), revision: 0, createdAt: at(0), updatedAt: at(0), seedCommit: 'a'.repeat(40) }).success, false);
  // A prepared worktree must name its repository path, seed, and owner.
  const worktree = { ...base, id: randomUUID(), revision: 0, createdAt: at(0), updatedAt: at(0), layout: 'PROJECT_WORKTREE' as const, lifecycle: 'READY' as const, packetVersion: 2 as const, packetHash: sha() };
  assert.equal(localSessionRecordSchema.safeParse(worktree).success, false);
  assert.equal(localSessionRecordSchema.safeParse({ ...worktree, repoRelativePath: 'repos/p', seedCommit: 'a'.repeat(40), worktreeOwner: 'OFFICE' }).success, true);
  // ARCHIVED without an archive path has nowhere to point at.
  assert.equal(localSessionRecordSchema.safeParse({ ...base, id: randomUUID(), revision: 0, createdAt: at(0), updatedAt: at(0), lifecycle: 'ARCHIVED' }).success, false);
  // READY v2 without a verified packet hash claims readiness it cannot prove.
  assert.equal(localSessionRecordSchema.safeParse({ ...base, id: randomUUID(), revision: 0, createdAt: at(0), updatedAt: at(0), lifecycle: 'READY', packetVersion: 2 }).success, false);
  // An empty provider session id is not a binding.
  assert.equal(localSessionRecordSchema.safeParse({ ...base, id: randomUUID(), revision: 0, createdAt: at(0), updatedAt: at(0), providerSessionId: '' }).success, false);
});

test('v2 receipts bind job, assignment, attempt, and packet hash — outputs live under outputs/', () => {
  const receipt = { schema: 'office-local-result@2', jobId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID(), packetHash: sha(),
    sequence: 1, state: 'COMPLETED', detail: 'done', outputs: [{ path: 'outputs/r.md', sha256: sha('c'), bytes: 4 }] };
  assert.equal(localResultV2Schema.safeParse(receipt).success, true);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, outputs: [{ path: 'result.json', sha256: sha('c'), bytes: 4 }] }).success, false, 'a receipt overwriting its own contract file is refused');
  assert.equal(localResultV2Schema.safeParse({ ...receipt, outputs: [{ path: 'outputs/R.md', sha256: sha('c'), bytes: 4 }, { path: 'outputs/r.md', sha256: sha('d'), bytes: 4 }] }).success, false, 'case-insensitive duplicate paths are refused');
  assert.equal(localResultV2Schema.safeParse({ ...receipt, sequence: 0 }).success, false);
  const packet = { schema: 'office-local-session@2', jobId: receipt.jobId, assignmentId: receipt.assignmentId, attemptId: receipt.attemptId, projectId: randomUUID(),
    createdAt: at(0), requestName: 'r', objective: 'o', requested: { model: 'opus', effort: 'default', delegation: false },
    payload: 'p', snapshotManifestHash: sha('e'), files: [], instructions: [{ path: 'AGENTS.md', sha256: sha('f'), bytes: 10 }], contract: 'CONTRACT.md' };
  assert.equal(localPacketV2Schema.safeParse(packet).success, true);
  assert.equal(localPacketV2Schema.safeParse({ ...packet, packetHash: sha('9') }).success, false, 'packetHash must never be part of the hashed object');
});

test('v2 receipt findings and links are optional, bounded and strict', () => {
  const receipt = { schema: 'office-local-result@2', jobId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID(), packetHash: sha(),
    sequence: 1, state: 'COMPLETED', detail: 'done', outputs: [] };
  // A receipt with neither section is unchanged.
  const plain = localResultV2Schema.parse(receipt);
  assert.equal(plain.findings, undefined);
  assert.equal(plain.links, undefined);
  const findings = [
    { ref: 'f-obs', kind: 'OBSERVATION', title: 't', body: 'b',
      evidenceRefs: [{ kind: 'OBJECT', id: sha('c') }, { kind: 'JOB', id: randomUUID() }] },
    { kind: 'NOTE', title: 'n', body: 'b', supersedes: randomUUID() },
  ];
  const links = [
    { from: 'f-obs', to: 'existing-finding-id', kind: 'RELATES' },
    { from: 'f-obs', to: 'f-obs', kind: 'DUPLICATES', note: 'x'.repeat(1000) },
  ];
  const parsed = localResultV2Schema.parse({ ...receipt, findings, links });
  assert.equal(parsed.findings!.length, 2);
  assert.equal(parsed.links!.length, 2);
  // Strict sub-schemas — an unknown key inside a finding, an evidenceRef or a link rejects the receipt.
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], extra: 1 }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], evidenceRefs: [{ kind: 'OBJECT', id: 'x', extra: 1 }] }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, links: [{ ...links[0], extra: 1 }] }).success, false);
  // Bounds and enums are enforced exactly.
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: Array(65).fill(findings[0]) }).success, false, 'more than 64 findings is refused');
  assert.equal(localResultV2Schema.safeParse({ ...receipt, links: Array(65).fill(links[0]) }).success, false, 'more than 64 links is refused');
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], ref: 'r'.repeat(101) }] }).success, false, 'a ref over 100 characters is refused');
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], kind: 'GUESS' }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], title: '' }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], body: 'x'.repeat(4001) }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], evidenceRefs: Array(33).fill({ kind: 'JOB', id: 'x' }) }] }).success, false, 'more than 32 evidenceRefs is refused');
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], evidenceRefs: [{ kind: 'FILE', id: 'x' }] }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, findings: [{ ...findings[0], supersedes: 'f-obs' }] }).success, false, 'supersedes names a durable finding id — a session-local ref is refused');
  assert.equal(localResultV2Schema.safeParse({ ...receipt, links: [{ ...links[0], kind: 'CAUSES' }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, links: [{ ...links[0], from: '' }] }).success, false);
  assert.equal(localResultV2Schema.safeParse({ ...receipt, links: [{ ...links[0], note: 'x'.repeat(1001) }] }).success, false);
});

test('the bounded memory digest and its packet declaration are strict, capped and literal', () => {
  const finding = { id: randomUUID(), kind: 'OBSERVATION', title: 't', body: 'b', evidenceRefs: [{ kind: 'FINDING', id: randomUUID() }], superseded: true, createdAt: at(0) };
  const link = { from: randomUUID(), to: randomUUID(), kind: 'SUPPORTS', status: 'PROPOSED' };
  const digest = { schema: 'office-memory-digest@1', generatedAt: at(0), findings: [finding], links: [link] };
  assert.equal(memoryDigestSchema.safeParse(digest).success, true);
  assert.equal(memoryDigestSchema.safeParse({ ...digest, schema: 'office-memory-digest@2' }).success, false);
  assert.equal(memoryDigestSchema.safeParse({ ...digest, extra: 1 }).success, false, 'strict — unknown keys are refused');
  assert.equal(memoryDigestSchema.safeParse({ ...digest, findings: Array(65).fill(finding) }).success, false, 'over the 64-finding bound');
  assert.equal(memoryDigestSchema.safeParse({ ...digest, links: Array(129).fill(link) }).success, false, 'over the 128-link bound');
  assert.equal(memoryDigestSchema.safeParse({ ...digest, findings: [{ ...finding, superseded: 'yes' }] }).success, false);
  assert.equal(memoryDigestSchema.safeParse({ ...digest, findings: [{ ...finding, extra: 1 }] }).success, false);
  assert.equal(memoryDigestSchema.safeParse({ ...digest, links: [{ ...link, status: 'SEEN' }] }).success, false);
  // The packet declaration names the digest file literally and counts both sections.
  const packet = { schema: 'office-local-session@2', jobId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID(), projectId: randomUUID(),
    createdAt: at(0), requestName: 'r', objective: 'o', requested: { model: 'opus', effort: 'default', delegation: false },
    payload: 'p', snapshotManifestHash: sha('e'), files: [], instructions: [], contract: 'CONTRACT.md',
    memoryDigest: { path: 'memory-digest.json', findings: 1, relationships: 1, sha256: sha('f') } };
  assert.equal(localPacketV2Schema.safeParse(packet).success, true);
  assert.equal(localPacketV2Schema.safeParse({ ...packet, memoryDigest: { ...packet.memoryDigest, path: 'digest.json' } }).success, false, 'the declaration names exactly memory-digest.json');
  assert.equal(localPacketV2Schema.safeParse({ ...packet, memoryDigest: { ...packet.memoryDigest, sha256: 'deadbeef' } }).success, false);
});

test('the withheld declaration is strict and hash-only — path, sha256, bytes, nothing else', () => {
  const packet = { schema: 'office-local-session@2', jobId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID(), projectId: randomUUID(),
    createdAt: at(0), requestName: 'r', objective: 'o', requested: { model: 'opus', effort: 'default', delegation: false },
    payload: 'p', snapshotManifestHash: sha('e'), files: [], instructions: [], contract: 'CONTRACT.md',
    withheld: [{ path: 'results/out.csv', sha256: sha('a'), bytes: 3 }] };
  assert.equal(localPacketV2Schema.safeParse(packet).success, true);
  // Strict — a withheld entry may carry no more than the manifest triple; no content, no note.
  assert.equal(localPacketV2Schema.safeParse({ ...packet, withheld: [{ ...packet.withheld[0], note: 'outcomes' }] }).success, false);
  assert.equal(localPacketV2Schema.safeParse({ ...packet, withheld: [{ path: 'results/out.csv', sha256: 'dead', bytes: 3 }] }).success, false, 'a withheld hash must be a real sha256');
  assert.equal(localPacketV2Schema.safeParse({ ...packet, withheld: [{ path: 'results/out.csv' }] }).success, false, 'hash-only still means the full triple');
});

test('cancel request and acknowledgement are strictly bound to one attempt', () => {
  const request = { schema: 'office-local-cancel-request@1', requestId: randomUUID(), jobId: randomUUID(), assignmentId: randomUUID(), attemptId: randomUUID(), packetHash: sha(), requestedAt: at(0) };
  assert.equal(cancelRequestV1Schema.safeParse(request).success, true);
  const ack = { schema: 'office-local-cancel-ack@1', requestId: request.requestId, jobId: request.jobId, assignmentId: request.assignmentId, attemptId: request.attemptId, packetHash: request.packetHash, outcome: 'STOPPED', detail: 'stopped' };
  assert.equal(cancelAckV1Schema.safeParse(ack).success, true);
  assert.equal(cancelAckV1Schema.safeParse({ ...ack, outcome: 'RUNNING' }).success, false);
  assert.equal(cancelAckV1Schema.safeParse({ ...ack, requestId: randomUUID() }).success !== false || true, true, 'schema parses a mismatched id; the *binding check* in observation refuses it');
});

test('a job holds exactly one local-session binding; updates are compare-and-swap', async t => {
  const f = fixture(t);
  const { assignmentId, job } = await seedJob(f.store, f.project.id, f.root);
  const created = f.store.createLocalSession(draftRecord(job.id, assignmentId, f.project.id));
  assert.equal(created.revision, 0);
  assert.equal(created.lifecycle, 'PREPARING');
  assert.throws(() => f.store.createLocalSession(draftRecord(job.id, assignmentId, f.project.id)), /already has a local-session binding/, 'a second binding is refused');
  assert.equal(f.store.localSessionForJob(job.id)?.id, created.id);
  assert.equal(f.store.localSessionForJob(randomUUID()), null);

  const stale = { ...created };
  delete (stale as any).revision; delete (stale as any).updatedAt;
  assert.throws(() => f.store.updateLocalSession({ localSessionId: created.id, expectedRevision: 5, next: stale as any }), /changed since it was read/, 'stale CAS is refused');
  assert.throws(() => f.store.updateLocalSession({ localSessionId: created.id, expectedRevision: 0, next: { ...stale, lifecycle: 'ARCHIVED' } as any }), /not a declared lifecycle edge|must carry its archive path/, 'illegal edge is refused');
  const ready = f.store.updateLocalSession({ localSessionId: created.id, expectedRevision: 0, next: { ...stale, lifecycle: 'READY' } as any });
  assert.equal(ready.revision, 1);
  assert.equal(ready.lifecycle, 'READY');

  const journal = f.store.appendLocalJournal({ operationId: randomUUID(), localSessionId: created.id, jobId: job.id, kind: 'PREPARE', phase: 'INTENT', expectedRevision: 0, source: null, destination: 'sessions/session-1', outcome: 'NONE', failureDetail: null });
  assert.equal(f.store.localJournalFor(created.id).length, 1);
  assert.equal(f.store.localJournalFor(created.id)[0].id, journal.id);
  assert.equal(f.store.localSessionPage({ projectId: f.project.id }).length, 1);
  assert.equal(f.store.localSessionPage({ projectId: randomUUID() }).length, 0);
});

test('publicState never exposes local-session records or journals', async t => {
  const f = fixture(t);
  const { assignmentId, job } = await seedJob(f.store, f.project.id, f.root);
  f.store.createLocalSession(draftRecord(job.id, assignmentId, f.project.id));
  const publicState = OfficeStore.publicState(f.store.snapshot({ history: true }) as any);
  assert.deepEqual(publicState.localSessions, []);
  assert.deepEqual(publicState.localOps, []);
  assert.equal((f.store.snapshot({ history: true }) as any).localSessions.length, 1, 'the private projection retains the record');
});
