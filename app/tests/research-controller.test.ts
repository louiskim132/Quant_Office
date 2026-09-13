import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OfficeStore } from '../src/core/store.js';
import { STAGE_FUNCTIONS_REQUIRED, adjudicate, promotable, recheckMandatoryGates, scheduleStage } from '../src/main/research-controller.js';
import { migrateRolesToFunctions, resolveFunctions } from '../src/main/context-policy.js';
import { MANDATORY_GATES, STAGE_GATES, type GateId, type ResearchBranch, type ResearchRecords, type Stage } from '../src/shared/research.js';
import type { Agent, AppState, FunctionAssignment, GateReceipt, TrialLedgerEntry } from '../src/shared/types.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const SUBJECT = sha256('candidate-1');
const PROJECT = randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2024, 0, 1, 0, minutes)).toISOString();

function agent(name: string, role: Agent['role'], revision = 0): Agent {
  return { id: randomUUID(), name, provider: 'claude', model: 'opus', team: 'Research', role, instructions: 'Do the work.',
    account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'HOSTED_SETUP_REQUIRED', revision };
}
const state = (agents: Agent[]): Pick<AppState, 'agents'> => ({ agents });

function assign(stage: Stage, fn: FunctionAssignment['function'], target: Agent, overrides: Partial<FunctionAssignment> = {}): FunctionAssignment {
  return { id: randomUUID(), projectId: PROJECT, stage, function: fn, agentId: target.id, agentRevision: target.revision ?? 0,
    appendedAt: at(1), supersededById: null, origin: 'EXPLICIT', note: '', ...overrides };
}

function branch(stage: Stage, overrides: Partial<ResearchBranch> = {}): ResearchBranch {
  const id = overrides.id ?? randomUUID();
  return { id, projectId: PROJECT, name: 'Momentum decay', parentBranchId: null, lineageId: overrides.lineageId ?? id,
    stage, outcome: 'IN_PROGRESS', specId: '00000000-0000-4000-8000-000000000009', predictionId: randomUUID(),
    revision: 1, createdAt: at(0), updatedAt: at(1), ...overrides };
}

const receipt = (target: ResearchBranch, gate: GateId, outcome: GateReceipt['outcome'], stage: Stage = 'S2'): GateReceipt => ({
  id: randomUUID(), branchId: target.id, stage, gate, outcome, subjectHash: SUBJECT, specId: target.specId!,
  detail: 'fixture', rationale: outcome === 'NOT_APPLICABLE' ? 'declared at freeze' : '', evidenceRef: sha256(gate), createdAt: at(2),
});

/** Receipts that pass every mandatory gate reached by `stage`, so a test can fail exactly one. */
function passingReceipts(target: ResearchBranch, stage: Stage): GateReceipt[] {
  const order: Stage[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
  const gates = new Set(order.slice(0, order.indexOf(stage) + 1).flatMap(item => STAGE_GATES[item]));
  return [...gates].map(gate => receipt(target, gate, 'PASS'));
}

test('a stage schedules only its own next assignments, resolved to live profile revisions', () => {
  const principal = agent('Principal', 'PM_A');
  const assignments = [assign('S3', 'PRINCIPAL', principal)];
  const target = branch('S3');
  const result = scheduleStage({ state: state([principal]), records: { branches: [target] }, assignments, branch: target,
    subjectHash: SUBJECT, mode: 'GROUP', outputSchema: 'run-report@1' });
  assert.equal(result.tasks.length, 1);
  assert.deepEqual([result.tasks[0].function, result.tasks[0].agentId], ['PRINCIPAL', principal.id]);
  assert.match(result.tasks[0].contextHash, /^[a-f0-9]{64}$/);

  // The same call twice is the same frozen context; nothing about it depends on when it was made.
  const again = scheduleStage({ state: state([principal]), records: { branches: [target] }, assignments, branch: target,
    subjectHash: SUBJECT, mode: 'GROUP', outputSchema: 'run-report@1' });
  assert.equal(again.tasks[0].contextHash, result.tasks[0].contextHash);

  // A different subject is different work, not a resumption of this one.
  const other = scheduleStage({ state: state([principal]), records: { branches: [target] }, assignments, branch: target,
    subjectHash: sha256('candidate-2'), mode: 'GROUP', outputSchema: 'run-report@1' });
  assert.notEqual(other.tasks[0].contextHash, result.tasks[0].contextHash);
});

test('an edited or removed profile blocks its function rather than running under changed instructions', () => {
  const reviewer = agent('Reviewer', 'PM_B', 2);
  const assignments = [assign('S2', 'CORRECTNESS_REVIEWER', reviewer, { agentRevision: 1 })];
  const target = branch('S2');
  const stale = scheduleStage({ state: state([reviewer]), records: { branches: [target] }, assignments, branch: target,
    subjectHash: SUBJECT, mode: 'GROUP', outputSchema: 'review@1' });
  assert.equal(stale.tasks.length, 0);
  assert.match(stale.blockers.join(' '), /Append a new assignment rather than running under changed instructions/);

  const removed = resolveFunctions(state([{ ...reviewer, revision: 1, removedAt: at(9) }]),
    [assign('S2', 'CORRECTNESS_REVIEWER', reviewer, { agentRevision: 1 })], { projectId: PROJECT, stage: 'S2', functions: ['CORRECTNESS_REVIEWER'] });
  assert.match(removed[0].blockers.join(' '), /has been removed/);

  const unassigned = resolveFunctions(state([reviewer]), [], { projectId: PROJECT, stage: 'S2', functions: ['CORRECTNESS_REVIEWER'] });
  assert.match(unassigned[0].blockers.join(' '), /No profile is assigned to the correctness reviewer function at S2/);
});

test('a single-agent request never recruits an independent reviewer by inference', () => {
  const principal = agent('Principal', 'PM_A'), reviewer = agent('Reviewer', 'PM_B');
  const assignments = [assign('S2', 'CORRECTNESS_REVIEWER', reviewer), assign('S3', 'PRINCIPAL', principal)];

  const solo = scheduleStage({ state: state([principal, reviewer]), records: {}, assignments, branch: branch('S2'),
    subjectHash: SUBJECT, mode: 'SINGLE', outputSchema: 'review@1' });
  assert.deepEqual(solo.tasks, []);
  assert.match(solo.blockers.join(' '), /Change the request's mode if the scope really is wider/);

  // A single-agent request is not broken; it simply stays solo where the stage allows it.
  const working = scheduleStage({ state: state([principal, reviewer]), records: {}, assignments, branch: branch('S3'),
    subjectHash: SUBJECT, mode: 'SINGLE', outputSchema: 'run-report@1' });
  assert.deepEqual(working.tasks.map(task => task.function), ['PRINCIPAL']);
});

test('S7 schedules an advocate and a skeptic, and S1 may fan out to bounded worker dependencies', () => {
  const advocate = agent('Advocate', 'PM_C'), skeptic = agent('Skeptic', 'PM_D'), principal = agent('Principal', 'PM_A');
  const assignments = [assign('S7', 'ADVOCATE', advocate), assign('S7', 'SKEPTIC', skeptic), assign('S1', 'PRINCIPAL', principal)];
  const adversarial = scheduleStage({ state: state([advocate, skeptic, principal]), records: {}, assignments, branch: branch('S7'),
    subjectHash: SUBJECT, mode: 'TEAM', outputSchema: 'argument@1' });
  assert.deepEqual(adversarial.tasks.map(task => task.function).sort(), ['ADVOCATE', 'SKEPTIC']);
  assert.notEqual(adversarial.tasks[0].agentId, adversarial.tasks[1].agentId);

  const workers = ['w1', 'w2'];
  const spec = scheduleStage({ state: state([principal]), records: {}, assignments, branch: branch('S1'),
    subjectHash: SUBJECT, mode: 'TEAM', outputSchema: 'spec@1', workerTaskIds: workers });
  assert.deepEqual(spec.tasks[0].dependsOn, workers);
  // Fan-out is an S1 allowance only; no other stage inherits it.
  const later = scheduleStage({ state: state([principal]), records: {}, assignments: [assign('S4', 'PRINCIPAL', principal)],
    branch: branch('S4'), subjectHash: SUBJECT, mode: 'TEAM', outputSchema: 'analysis@1', workerTaskIds: workers });
  assert.deepEqual(later.tasks[0].dependsOn, []);
});

test('legacy roles become explicit function assignments by appending, never by editing profiles', () => {
  const agents = [agent('Director', 'DIRECTOR'), agent('One', 'PM_A'), agent('Two', 'PM_B'), agent('Three', 'PM_C'), agent('Four', 'PM_D')];
  const before = JSON.stringify(agents);
  const appended = migrateRolesToFunctions(state(agents), { projectId: PROJECT, stage: 'S2', now: at(3), existing: [], id: randomUUID });
  assert.equal(JSON.stringify(agents), before, 'migration must not touch the profiles themselves');
  assert.deepEqual(appended.map(item => item.function).sort(), ['ADVOCATE', 'CORRECTNESS_REVIEWER', 'DIRECTOR', 'PRINCIPAL', 'SKEPTIC']);
  assert.ok(appended.every(item => item.origin === 'MIGRATED_FROM_ROLE'));
  assert.match(appended[0].note, /provider, model and instructions are unchanged/);

  // Running it again appends nothing: an explicit assignment is never overwritten by an inferred one.
  assert.deepEqual(migrateRolesToFunctions(state(agents), { projectId: PROJECT, stage: 'S2', now: at(4), existing: appended, id: randomUUID }), []);
});

test('a director cannot promote a branch through a failed or missing mandatory gate', () => {
  const target = branch('S2');
  const records: ResearchRecords = { branches: [target], specs: [], receipts: passingReceipts(target, 'S2') };
  const failing: ResearchRecords = { ...records, receipts: records.receipts!.map(item => item.gate === 'G-FIT' ? { ...item, outcome: 'FAIL' as const } : item) };

  const blocked = promotable(failing, target, SUBJECT);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reasons.join(' '), /G-FIT/);

  // A receipt earned by a different candidate does not carry over to this one.
  const transferred = promotable(records, target, sha256('candidate-2'));
  assert.equal(transferred.allowed, false);
  assert.match(transferred.reasons.join(' '), /no receipt for this exact subject/);

  assert.deepEqual(recheckMandatoryGates(failing, target, SUBJECT), ['G-FIT']);
  assert.deepEqual(recheckMandatoryGates(records, target, SUBJECT), []);
});

test('adjudication has four outcomes and no way to waive a mandatory gate', () => {
  const target = branch('S7');
  const clean: ResearchRecords = { branches: [target], receipts: passingReceipts(target, 'S7'), trials: [] };
  const both = (verdict: 'SUPPORTS' | 'OPPOSES') => ({ verdict, defectFound: false });

  assert.equal(adjudicate({ records: clean, branch: target, subjectHash: SUBJECT, advocate: both('SUPPORTS'), skeptic: both('SUPPORTS'), requestedFollowUp: false }).outcome, 'UPHELD');
  assert.equal(adjudicate({ records: clean, branch: target, subjectHash: SUBJECT, advocate: both('OPPOSES'), skeptic: both('OPPOSES'), requestedFollowUp: false }).outcome, 'REVISION_REQUIRED');

  const defect = adjudicate({ records: clean, branch: target, subjectHash: SUBJECT,
    advocate: both('SUPPORTS'), skeptic: { verdict: 'SUPPORTS', defectFound: true }, requestedFollowUp: false });
  assert.equal(defect.outcome, 'LINEAGE_SUSPENDED');
  assert.match(defect.detail, /not weighed against the strength of the result/);

  // A failing mandatory gate outranks any agreement between the two sides.
  const broken: ResearchRecords = { ...clean, receipts: clean.receipts!.map(item => item.gate === 'G-COST' ? { ...item, outcome: 'FAIL' as const } : item) };
  const forced = adjudicate({ records: broken, branch: target, subjectHash: SUBJECT, advocate: both('SUPPORTS'), skeptic: both('SUPPORTS'), requestedFollowUp: false });
  assert.equal(forced.outcome, 'REVISION_REQUIRED');
  assert.deepEqual(forced.failedMandatoryGates, ['G-COST']);
  assert.match(forced.detail, /cannot waive a mandatory gate/);
});

test('one scientific follow-up per lineage, and it survives a rename or a restart', () => {
  const root = branch('S7');
  const clean: ResearchRecords = { branches: [root], receipts: passingReceipts(root, 'S7'), trials: [] };
  const disagree = { advocate: { verdict: 'SUPPORTS' as const, defectFound: false }, skeptic: { verdict: 'OPPOSES' as const, defectFound: false } };

  const first = adjudicate({ records: clean, branch: root, subjectHash: SUBJECT, ...disagree, requestedFollowUp: true });
  assert.equal(first.outcome, 'FOLLOW_UP_GRANTED');
  assert.equal(first.followUpAllowanceRemaining, 0);

  // The allowance is counted on the lineage, so a renamed descendant with a new identity inherits it.
  const used: TrialLedgerEntry = { id: randomUUID(), lineageId: root.lineageId, branchId: root.id, kind: 'FOLLOW_UP',
    variantHash: sha256('v1'), description: 'the granted follow-up', outcome: 'COMPLETED', createdAt: at(5), settledAt: at(6) };
  const renamed = branch('S7', { id: randomUUID(), name: 'Momentum decay, restated', lineageId: root.lineageId, parentBranchId: root.id });
  const after: ResearchRecords = { branches: [root, renamed], trials: [used], receipts: passingReceipts(renamed, 'S7') };
  const second = adjudicate({ records: after, branch: renamed, subjectHash: SUBJECT, ...disagree, requestedFollowUp: true });
  assert.equal(second.outcome, 'REVISION_REQUIRED');
  assert.match(second.detail, /already used its 1 scientific follow-up/);

  // Disagreement without a requested follow-up is not an implicit one.
  assert.equal(adjudicate({ records: clean, branch: root, subjectHash: SUBJECT, ...disagree, requestedFollowUp: false }).outcome, 'REVISION_REQUIRED');
});

test('adjudication refuses an undeclared or unexplained NOT_APPLICABLE mandatory gate', () => {
  const target = branch('S7');
  const receipts = passingReceipts(target, 'S7').map(item => item.gate === 'G-FIT'
    ? { ...item, outcome: 'NOT_APPLICABLE' as const, rationale: 'Claimed exception' } : item);
  const records: ResearchRecords = { branches: [target], receipts };
  assert.deepEqual(recheckMandatoryGates(records, target, SUBJECT), ['G-FIT']);
  const outcome = adjudicate({ records, branch: target, subjectHash: SUBJECT,
    advocate: { verdict: 'SUPPORTS', defectFound: false }, skeptic: { verdict: 'SUPPORTS', defectFound: false }, requestedFollowUp: false });
  assert.equal(outcome.outcome, 'REVISION_REQUIRED');
  const spec = { id: target.specId!, branchId: target.id, sections: { estimand: 'e', splitPlan: 's', searchPlan: 's',
    costContract: 'c', portfolioContract: 'p', metricsAndGates: 'm', holdoutPolicy: 'h' }, thresholds: [],
    notApplicable: [{ gate: 'G-FIT' as const, rationale: 'Frozen exception' }], maxSelectionTrials: 1,
    frozen: true, contentHash: sha256('spec'), createdAt: at(0), frozenAt: at(1) };
  assert.deepEqual(recheckMandatoryGates({ ...records, specs: [spec] }, target, SUBJECT), []);
  assert.deepEqual(recheckMandatoryGates({ ...records, specs: [spec], receipts: receipts.map(r => r.gate === 'G-FIT' ? { ...r, rationale: '' } : r) }, target, SUBJECT), ['G-FIT']);
});

test('every stage declares the functions it needs, and mandatory gates are a closed list', () => {
  const stages: Stage[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
  for (const stage of stages) assert.ok(STAGE_FUNCTIONS_REQUIRED[stage].length >= 1, `${stage} declares no function`);
  assert.equal(STAGE_FUNCTIONS_REQUIRED.S2[0], 'CORRECTNESS_REVIEWER');
  assert.deepEqual(STAGE_FUNCTIONS_REQUIRED.S8, ['CUSTODIAN']);
  for (const gate of MANDATORY_GATES) assert.ok(stages.some(stage => STAGE_GATES[stage].includes(gate)), `${gate} belongs to no stage`);
});

test('function assignments are appended and superseded in the store, never edited in place', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-functions-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch { /* already closed */ } removeTreeSync(root); });
  const project = store.execute({ type: 'project.create', idempotencyKey: randomUUID(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const first = agent('First reviewer', 'PM_B'), second = agent('Second reviewer', 'PM_B');
  store.addAgent(first); store.addAgent(second);
  const row = (target: Agent, id: string = randomUUID()): FunctionAssignment => ({ id, projectId: project.id, stage: 'S2',
    function: 'CORRECTNESS_REVIEWER', agentId: target.id, agentRevision: target.revision ?? 0, appendedAt: at(1),
    supersededById: null, origin: 'EXPLICIT', note: '' });

  const original = row(first);
  const after = store.appendFunctionAssignment(original);
  assert.deepEqual(after.functions!.map(item => item.agentId), [first.id]);

  const replacement = row(second);
  const replaced = store.appendFunctionAssignment(replacement);
  assert.equal(replaced.functions!.length, 2, 'the earlier assignment is kept, not overwritten');
  assert.equal(replaced.functions!.find(item => item.id === original.id)!.supersededById, replacement.id);
  assert.equal(replaced.functions!.find(item => item.id === replacement.id)!.supersededById, null);

  // The profiles themselves are untouched by any of this.
  for (const person of [first, second]) {
    const stored = replaced.agents.find(item => item.id === person.id)!;
    assert.deepEqual([stored.provider, stored.model, stored.instructions], [person.provider, person.model, person.instructions]);
  }
  const resolved = resolveFunctions(replaced, replaced.functions!.filter(item => !item.supersededById),
    { projectId: project.id, stage: 'S2', functions: ['CORRECTNESS_REVIEWER'] });
  assert.deepEqual([resolved[0].agentId, resolved[0].blockers], [second.id, []]);

  assert.throws(() => store.appendFunctionAssignment(row(second, replacement.id)), /identities are immutable/);
  assert.throws(() => store.appendFunctionAssignment({ ...row(second), agentRevision: 5 }),
    /Read it again and assign the current revision/);
  assert.throws(() => store.appendFunctionAssignment({ ...row(second), agentId: randomUUID() }), /Agent not found/);
});
