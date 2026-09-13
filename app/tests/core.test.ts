import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { OfficeStore, canonical, canonicalHash, sha256 } from '../src/core/store.js';
import { assertBudgetReservation, assertExactApproval, assertHostedExecution, assertProviderDisclosure, assertSmokeGate, assertWorkerCapacity, bundleHash, commitReview, disclosedReports, type ApprovalBundle, type BudgetScope, type ReviewRound } from '../src/core/guards.js';
import type { Artifact, ResearchContract } from '../src/shared/types.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'quant-office-core-'));
  const path = join(directory, 'workspace.sqlite');
  const store = new OfficeStore(path);
  t.after(() => { store.close(); removeTreeSync(directory); });
  return { directory, path, store };
}
const key = () => randomUUID();
function createProject(store: OfficeStore, name = 'Forecast research') {
  const state = store.execute({ type: 'project.create', idempotencyKey: key(), name, mandate: 'Research a general predictive hypothesis', budgetCents: 0 });
  return state.projects.at(-1)!;
}
function createExperiment(store: OfficeStore, projectId: string) {
  const state = store.execute({ type: 'experiment.create', idempotencyKey: key(), projectId, name: 'Hypothesis one', hypothesis: 'Compare general models using predeclared evaluation' });
  return state.experiments.at(-1)!;
}
const contract: ResearchContract = { objective: 'Forecast uncertainty', dataPolicy: 'Public, ordinary partition only', modelFamilies: 'Linear and neural', evaluation: 'Predeclared out-of-time evaluation', economics: 'Not applicable: forecast calibration claim', protectedRegions: 'Final holdout', requiredChecks: 'Schema and chronology', limitations: 'Single dataset' };
function artifact(projectId: string, experimentId: string | null = null): Artifact {
  return { id: randomUUID(), projectId, experimentId, name: 'results.json', sha256: sha256('{}'), size: 2, kind: 'RESULT', classification: 'USER_ATTESTED', status: 'STORED', createdAt: new Date().toISOString(), mediaType: 'application/json', note: 'Explicit user import' };
}

test('fresh workspace has no agents, spend, approvals, reviews, projects, or synthetic work', t => {
  const { store } = fixture(t);
  assert.deepEqual(store.snapshot(), { schemaVersion: 1, projects: [], experiments: [], tasks: [], artifacts: [], reviews: [], events: [], agents: [], settings: { theme: 'dark', reducedMotion: false, globalBudgetCents: 0 }, spend: { actualCents: 0, reservedCents: 0 } });
});

test('different quant projects persist independently, and user prompts remain honestly blocked', t => {
  const { store, path } = fixture(t);
  const forecast = createProject(store);
  const risk = createProject(store, 'Risk estimation');
  const experiment = createExperiment(store, risk.id);
  store.execute({ type: 'task.create', idempotencyKey: key(), projectId: forecast.id, experimentId: null, prompt: 'Research forecast calibration', recipient: 'DIRECTOR' });
  const state = store.execute({ type: 'task.create', idempotencyKey: key(), projectId: risk.id, experimentId: experiment.id, prompt: 'Verify covariance estimators', recipient: 'PM_B' });
  assert.ok(state.tasks.every(task => task.status === 'BLOCKED' && task.blocker === 'No agents configured'));
  assert.deepEqual(state.spend, { actualCents: 0, reservedCents: 0 });
  assert.deepEqual(state.reviews, []);
  store.close();
  const reopened = new OfficeStore(path);
  try { assert.deepEqual(reopened.snapshot(), state); } finally { reopened.close(); }
});

test('idempotency survives restart, produces one event, and rejects conflicting replay', t => {
  const { store, path } = fixture(t);
  const command = { type: 'project.create', idempotencyKey: key(), name: 'Research', mandate: '', budgetCents: 100 };
  const first = store.execute(command);
  assert.deepEqual(store.execute(command), first);
  assert.throws(() => store.execute({ ...command, name: 'Different' }), /Idempotency/);
  store.close();
  const reopened = new OfficeStore(path);
  try {
    assert.deepEqual(reopened.execute(command), first);
    assert.equal(reopened.snapshot().events.length, 1);
    assert.throws(() => reopened.execute({ ...command, budgetCents: 101 }), /Idempotency/);
  } finally { reopened.close(); }
});

test('strict commands reject hidden authority fields, unknown actions, malformed IDs and unsafe money', t => {
  const { store } = fixture(t);
  const command = { type: 'project.create', idempotencyKey: key(), name: 'Research', mandate: '', budgetCents: 0 };
  for (const invalid of [
    { ...command, approved: true }, { type: 'review.approve', idempotencyKey: key() },
    { ...command, budgetCents: 0.1 }, { ...command, budgetCents: -1 }, { ...command, budgetCents: Number.MAX_SAFE_INTEGER + 1 },
    { ...command, budgetCents: 100_000_001 }, { ...command, budgetCents: Infinity },
    { ...command, idempotencyKey: 'short' }, { ...command, name: '   ' },
    { type: 'project.archive', idempotencyKey: key(), projectId: '../other', archived: false },
    { type: 'settings.update', idempotencyKey: key(), settings: { theme: 'dark', reducedMotion: false, globalBudgetCents: 0, agent: 'ADMIN' } },
  ]) assert.throws(() => store.execute(invalid));
  assert.equal(store.snapshot().events.length, 0);
});

test('cross-project tasks and artifacts fail atomically without consuming an idempotency key', t => {
  const { store } = fixture(t);
  const first = createProject(store), second = createProject(store, 'Other');
  const experiment = createExperiment(store, second.id);
  const command = { type: 'task.create', idempotencyKey: key(), projectId: first.id, experimentId: experiment.id, prompt: 'Check', recipient: 'PM_B' };
  const before = store.snapshot();
  assert.throws(() => store.execute(command), /does not belong/);
  assert.throws(() => store.addArtifact(artifact(first.id, experiment.id)), /does not belong/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.execute({ ...command, projectId: second.id }).tasks.length, 1);
});

test('optimistic contract revisions prevent stale overwrites and no review approval is fabricated', t => {
  const { store } = fixture(t);
  const project = createProject(store), experiment = createExperiment(store, project.id);
  const saved = store.execute({ type: 'contract.save', idempotencyKey: key(), experimentId: experiment.id, expectedRevision: 0, contract });
  assert.equal(saved.experiments[0].revision, 1);
  assert.throws(() => store.execute({ type: 'contract.save', idempotencyKey: key(), experimentId: experiment.id, expectedRevision: 0, contract: { ...contract, economics: 'Different' } }), /Stale/);
  assert.deepEqual(store.snapshot(), saved);
  const submitted = store.execute({ type: 'contract.submit', idempotencyKey: key(), experimentId: experiment.id, expectedRevision: 1 });
  assert.equal(submitted.experiments[0].stage, 'CONTRACT_REVIEW');
  assert.equal(submitted.tasks[0].status, 'BLOCKED');
  assert.deepEqual(submitted.reviews, []);
  assert.throws(() => store.execute({ type: 'contract.submit', idempotencyKey: key(), experimentId: experiment.id, expectedRevision: 2 }), /already awaiting/);
  const revised = store.execute({ type: 'contract.save', idempotencyKey: key(), experimentId: experiment.id, expectedRevision: 2, contract: { ...contract, objective: 'Revised hypothesis' } });
  assert.equal(revised.experiments[0].stage, 'DRAFT');
  assert.equal(revised.tasks[0].status, 'SUPERSEDED');
});

test('archived projects require explicit cancellation and restore visibility only', t => {
  const { store } = fixture(t);
  const project = createProject(store), experiment = createExperiment(store, project.id);
  store.execute({ type: 'task.create', idempotencyKey: key(), projectId: project.id, experimentId: null, prompt: 'Research', recipient: 'DIRECTOR' });
  assert.throws(()=>store.execute({type:'project.archive',idempotencyKey:key(),projectId:project.id,archived:true}),/Cancel outstanding/);
  store.execute({type:'task.cancel',idempotencyKey:key(),taskId:store.snapshot().tasks[0].id});
  const archived = store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: project.id, archived: true });
  assert.equal(archived.tasks[0].status, 'CANCELED');
  assert.throws(() => createExperiment(store, project.id), /Archived/);
  assert.throws(() => store.addArtifact(artifact(project.id)), /Archived/);
  assert.throws(() => store.execute({ type: 'contract.save', idempotencyKey: key(), experimentId: experiment.id, expectedRevision: 0, contract }), /Archived/);
  store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: project.id, archived: false });
  assert.equal(createExperiment(store, project.id).projectId, project.id);
  assert.equal(store.snapshot().tasks[0].status, 'CANCELED');
});

test('artifact metadata is immutable and imports cannot self-certify scientific content', t => {
  const { store } = fixture(t);
  const project = createProject(store), imported = artifact(project.id);
  const state = store.addArtifact(imported);
  assert.deepEqual(store.addArtifact(imported), state);
  assert.deepEqual(store.getArtifact(imported.id), imported);
  assert.throws(() => store.addArtifact({ ...imported, sha256: sha256('changed') }), /immutable/);
  assert.throws(() => store.addArtifact({ ...imported, id: randomUUID(), status: 'CONTENT_VERIFIED' }));
  assert.throws(() => store.addArtifact({ ...imported, id: randomUUID(), name: '../escape.json' }));
  assert.throws(() => store.addArtifact({ ...imported, id: randomUUID(), sha256: 'not a hash' }));
  assert.equal(store.snapshot().artifacts.length, 1);
});

test('event chain, projection and outbox commit together, with append-only events', t => {
  const { store, path } = fixture(t);
  createProject(store); createProject(store, 'Second');
  const db = new DatabaseSync(path);
  try {
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n), 2);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM commands').get()!.n), 2);
    assert.throws(() => db.prepare('DELETE FROM events WHERE sequence=1').run(), /immutable/);
    assert.throws(() => db.prepare("UPDATE events SET record='{}' WHERE sequence=1").run(), /immutable/);
  } finally { db.close(); }
  const events = store.snapshot().events;
  assert.equal(events[0].previousHash, '0'.repeat(64));
  assert.equal(events[1].previousHash, events[0].hash);
});

test('startup refuses changed event contents even if SQLite pages remain valid', t => {
  const { store, path } = fixture(t);
  createProject(store); store.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TRIGGER events_no_update');
  const row = db.prepare('SELECT record FROM events WHERE sequence=1').get()!;
  const record = JSON.parse(String(row.record)); record.reason = 'Rewritten';
  db.prepare('UPDATE events SET record=? WHERE sequence=1').run(JSON.stringify(record));
  db.exec("CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are immutable'); END"); db.close();
  assert.throws(() => new OfficeStore(path), /hash chain integrity/);
});

test('startup refuses projection tampering', t => {
  const { store, path } = fixture(t);
  createProject(store); store.close();
  const db = new DatabaseSync(path);
  const state = JSON.parse(String(db.prepare('SELECT state FROM projection').get()!.state));
  state.projects[0].budgetCents = 9999;
  db.prepare('UPDATE projection SET state=?').run(JSON.stringify(state)); db.close();
  assert.throws(() => new OfficeStore(path), /projection integrity/);
});

test('startup refuses missing recovery work or command replay receipts', t => {
  const { store, path } = fixture(t);
  createProject(store); store.close();
  const db = new DatabaseSync(path); db.exec('DELETE FROM commands'); db.close();
  assert.throws(() => new OfficeStore(path), /receipt integrity/);
});

test('future and unversioned databases are rejected without destructive migration', t => {
  const { store, path, directory } = fixture(t);
  store.close();
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => new OfficeStore(path), /Unsupported database schema/);
  const unknownPath = join(directory, 'unknown.sqlite');
  const unknown = new DatabaseSync(unknownPath); unknown.exec('CREATE TABLE precious(data TEXT)'); unknown.close();
  assert.throws(() => new OfficeStore(unknownPath), /Unversioned/);
  const stillThere = new DatabaseSync(unknownPath);
  try { assert.equal(stillThere.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='precious'").get()!.n, 1); } finally { stillThere.close(); }
});

test('SQLite backup produces a consistent verified copy while original stays usable', async t => {
  const { store, directory, path } = fixture(t);
  createProject(store);
  const before = store.snapshot();
  const destination = join(directory, 'backup.sqlite');
  await assert.rejects(store.backup(path), /active workspace/);
  await store.backup(destination);
  const copy = new OfficeStore(destination);
  try { assert.deepEqual(copy.snapshot(), before); } finally { copy.close(); }
  store.recordTransfer('WORKSPACE_BACKED_UP', null, 'User selected a backup destination');
  assert.equal(store.snapshot().events.length, before.events.length + 1);
});

test('transfer records cannot invent scientific approval or use nonexistent scope', t => {
  const { store } = fixture(t);
  const project = createProject(store);
  assert.throws(() => store.recordTransfer('RUN_APPROVED', project.id, 'Claim')); 
  assert.throws(() => store.recordTransfer('PROJECT_EXPORTED', null, 'Missing scope'));
  assert.throws(() => store.recordTransfer('PROJECT_EXPORTED', randomUUID(), 'Other scope'));
  assert.equal(store.recordTransfer('PROJECT_EXPORTED', project.id, 'Unreviewed project archive exported').events.at(-1)!.kind, 'PROJECT_EXPORTED');
});

test('canonical records have deterministic golden identities and reject lossy values', () => {
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalHash({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(canonical({ nested: [null, true, 'é', -0] }), '{"nested":[null,true,"é",0]}');
  assert.notEqual(canonicalHash({ required: null }), canonicalHash({}));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const invalid of [undefined, NaN, Infinity, 1n, new Date(), { missing: undefined }, [undefined], Array(1), cycle, { [Symbol('key')]: 1 }]) assert.throws(() => canonical(invalid));
});

test('maximum liability is reserved against actual plus all outstanding liability in every scope', () => {
  const scopes: BudgetScope[] = ['task','experiment','project','global'].map(scope => ({ scope: scope as BudgetScope['scope'], ceilingCents: 1000, actualCents: 300, reservedCents: 600 }));
  assert.doesNotThrow(() => assertBudgetReservation(100, scopes));
  assert.throws(() => assertBudgetReservation(101, scopes), /budget exceeded/);
  assert.throws(() => assertBudgetReservation(null, scopes), /Unknown/);
  assert.throws(() => assertBudgetReservation(0.5, scopes), /Invalid/);
  assert.throws(() => assertBudgetReservation(10, scopes.slice(1)), /four/);
  assert.throws(() => assertBudgetReservation(10, [scopes[0], scopes[0], scopes[2], scopes[3]]), /distinct/);
  assert.throws(() => assertBudgetReservation(10, scopes.map(item => item.scope === 'global' ? { ...item, ceilingCents: 905 } : item)), /global budget/);
});

function bundle(): ApprovalBundle {
  return { schemaVersion: 1, projectId: randomUUID(), experimentId: randomUUID(), purpose: 'FULL_RUN', sourceHash: sha256('source'), dataHash: sha256('data'), configurationHash: sha256('config'), testsHash: sha256('tests'), environmentHash: sha256('env'), launcherHash: sha256('launcher'), policyHash: sha256('policy') };
}
test('approvals bind every dependency, scope, purpose and revocation status', () => {
  const original = bundle();
  const approval = { projectId: original.projectId, experimentId: original.experimentId, purpose: 'FULL_RUN', bundleHash: bundleHash(original), revoked: false };
  assert.doesNotThrow(() => assertExactApproval(original, approval));
  for (const property of ['sourceHash','dataHash','configurationHash','testsHash','environmentHash','launcherHash','policyHash'] as const) assert.throws(() => assertExactApproval({ ...original, [property]: sha256('changed') }, approval), /exact active bundle/);
  assert.throws(() => assertExactApproval(original, { ...approval, projectId: randomUUID() }));
  assert.throws(() => assertExactApproval(original, { ...approval, revoked: true }));
  assert.throws(() => bundleHash({ ...original, schemaVersion: 2 } as unknown as ApprovalBundle));
  assert.throws(() => bundleHash({ ...original, extra: true } as unknown as ApprovalBundle));
});

test('smoke metadata preserves the distinction between passed and conditional package approval', () => {
  const hash = bundleHash(bundle());
  assert.throws(() => assertSmokeGate(hash, null, null), /Full run requires/);
  assert.throws(() => assertSmokeGate(hash, { bundleHash: hash, accepted: true, origin: 'USER_ATTESTED' }, null));
  assert.equal(assertSmokeGate(hash, { bundleHash: hash, accepted: true, origin: 'PROVIDER_VERIFIED' }, null), 'PASSED');
  const launcher = { bundleHash: hash, reviewed: true, failsClosed: true, smokeBeforeExpensiveStages: true };
  assert.equal(assertSmokeGate(hash, null, launcher), 'CONDITIONAL');
  assert.throws(() => assertSmokeGate(hash, null, { ...launcher, failsClosed: false }));
  assert.throws(() => assertSmokeGate(sha256('changed bundle'), null, launcher));
});

test('ordinary grants never disclose mixed, unclassified or protected-derived artifacts', () => {
  const projectId = randomUUID(), artifactHash = sha256('artifact');
  const access = { projectId, artifactProjectId: projectId, artifactHash, classification: 'ORDINARY' as const, ordinaryGrant: true, protectedGrant: null };
  assert.doesNotThrow(() => assertProviderDisclosure(access));
  for (const classification of ['MIXED','UNCLASSIFIED','PROTECTED','PROTECTED_DERIVED'] as const) assert.throws(() => assertProviderDisclosure({ ...access, classification }));
  const grant = { projectId, artifactHash, userDecisionId: randomUUID(), exposureEventSequence: 8 };
  assert.doesNotThrow(() => assertProviderDisclosure({ ...access, classification: 'PROTECTED_DERIVED', protectedGrant: grant }));
  assert.throws(() => assertProviderDisclosure({ ...access, classification: 'PROTECTED', protectedGrant: { ...grant, exposureEventSequence: 0 } }));
  assert.throws(() => assertProviderDisclosure({ ...access, classification: 'PROTECTED', protectedGrant: { ...grant, artifactHash: sha256('different') } }));
  assert.throws(() => assertProviderDisclosure({ ...access, artifactProjectId: randomUUID() }));
});

test('first reviews remain isolated until all are immutable and rebuttals are bounded to one each', () => {
  const hash = sha256('bundle');
  let round: ReviewRound = { bundleHash: hash, participants: ['PM_A','PM_B'], reports: [] };
  round = commitReview(round, { role: 'PM_A', phase: 'FIRST', contentHash: sha256('A conclusion'), bundleHash: hash });
  assert.equal(disclosedReports(round, 'PM_A').length, 1);
  assert.deepEqual(disclosedReports(round, 'PM_B'), []);
  assert.throws(() => commitReview(round, { role: 'PM_A', phase: 'REBUTTAL', contentHash: sha256('early'), bundleHash: hash }), /preceded/);
  assert.throws(() => commitReview(round, round.reports[0]), /duplicate/);
  assert.throws(() => commitReview(round, { role: 'PM_B', phase: 'FIRST', contentHash: sha256('B'), bundleHash: sha256('other') }));
  round = commitReview(round, { role: 'PM_B', phase: 'FIRST', contentHash: sha256('B conclusion'), bundleHash: hash });
  assert.equal(disclosedReports(round, 'PM_B').length, 2);
  round = commitReview(round, { role: 'PM_A', phase: 'REBUTTAL', contentHash: sha256('A rebuttal'), bundleHash: hash });
  assert.throws(() => commitReview(round, { role: 'PM_A', phase: 'REBUTTAL', contentHash: sha256('again'), bundleHash: hash }), /duplicate/);
  assert.throws(() => disclosedReports(round, 'PM_D'), /not a review participant/);
});

test('execution guard rejects local, Colab, unrestricted and unsupported provider execution', () => {
  const valid = { provider: 'OPENAI', location: 'PROVIDER_HOSTED', constrainedTools: true, colabAccess: false, localExecution: false };
  assert.doesNotThrow(() => assertHostedExecution(valid));
  assert.doesNotThrow(() => assertHostedExecution({ ...valid, provider: 'ANTHROPIC' }));
  for (const invalid of [{ ...valid, provider: 'OTHER' }, { ...valid, location: 'LOCAL' }, { ...valid, constrainedTools: false }, { ...valid, colabAccess: true }, { ...valid, localExecution: true }]) assert.throws(() => assertHostedExecution(invalid), /provider-hosted/);
});

test('unknown and cancel-requested worker jobs retain global slots until provider reconciliation', () => {
  assert.doesNotThrow(() => assertWorkerCapacity([], 2));
  assert.doesNotThrow(() => assertWorkerCapacity([{ id: 'one', state: 'RUNNING' }, { id: 'finished', state: 'COMPLETED' }], 1));
  assert.throws(() => assertWorkerCapacity([{ id: 'one', state: 'UNKNOWN' }, { id: 'two', state: 'CANCEL_REQUESTED' }], 1, 2), /Provider concurrency/);
  assert.doesNotThrow(() => assertWorkerCapacity([{ id: 'one', state: 'UNKNOWN' }, { id: 'two', state: 'CANCELED_ACKNOWLEDGED' }]));
  assert.throws(() => assertWorkerCapacity([{ id: 'same', state: 'RUNNING' }, { id: 'same', state: 'COMPLETED' }]), /duplicate/);
  assert.doesNotThrow(() => assertWorkerCapacity([], 300));
  assert.throws(() => assertWorkerCapacity([], 0), /Invalid/);
});
