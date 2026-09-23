import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mintEntriesFor, planCommRoundMint, planRefineHop, REFINE_NOTE_MAX } from '../src/main/round-executor';
import { ANALYST_TOOL_PROFILE, DIRECTOR_TOOL_PROFILE, PLANNER_TOOL_PROFILE, WORKER_TOOL_PROFILE } from '../src/main/round-template';
import * as roundTemplate from '../src/main/round-template';
import type { Agent, Assignment, Request, Role } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const analysisBuilder = (roundTemplate as unknown as { buildAnalysisRound?: unknown }).buildAnalysisRound;

function agent(role: Role, overrides: Partial<Agent> = {}): Agent {
  return {
    id: randomUUID(), name: `${role} seat`, provider: 'claude', model: 'opus', team: 'Research',
    role, instructions: '', account: `${role.toLowerCase()}@example.com`,
    createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL', ...overrides,
  };
}

function request(kind: 'PLANNING' | 'RESULT_ANALYSIS' | 'QUESTION', leadAgentId: string | null, overrides: Partial<Request> = {}): Request {
  return {
    id: randomUUID(), projectId: randomUUID(), experimentId: null, name: 'Pipeline request',
    objective: 'Ship the bounded plan.', workType: kind === 'QUESTION' ? 'QUESTION' : kind, mode: 'GROUP',
    leadAgentId, participantIds: [], acceptanceCriteria: 'A plan.', revision: 0, status: 'READY',
    blockers: [], delegation: false, createdAt: at(0), updatedAt: at(0),
    ...(kind === 'QUESTION' ? {} : { pipeline: { kind, specHash: null, phase: 'BRIEFING' as const, briefAssignmentId: null } }),
    ...overrides,
  };
}

function assignment(id: string, pipelineKey?: string): Assignment {
  return {
    id, pipelineKey, projectId: randomUUID(), requestId: randomUUID(), requestRevision: 0,
    agentId: randomUUID(), agentRevision: 0, connectionId: randomUUID(), capabilitySnapshotId: randomUUID(),
    snapshotId: randomUUID(), route: 'LOCAL_CLI_EXEC', requestedModel: 'fixture-model', resolvedModel: '',
    requestedEffort: 'default', appliedEffort: 'UNVERIFIED', delegation: false, objectiveHash: 'a'.repeat(64),
    createdAt: at(0),
  } as Assignment;
}

/** A roster covering every seat: director, two planners, two analysts, two workers. */
function roster() {
  const director = agent('DIRECTOR');
  const plannerA = agent('PM_A');
  const plannerB = agent('PM_B');
  const analystC = agent('PM_C');
  const analystD = agent('PM_D');
  const worker1 = agent('WORKER');
  const worker2 = agent('WORKER');
  return { director, plannerA, plannerB, analystC, analystD, worker1, worker2,
    agents: [director, plannerA, plannerB, analystC, analystD, worker1, worker2] };
}

test('a PLANNING request mints the full phase-1 spec with seats resolved by role', () => {
  const r = roster();
  const req = request('PLANNING', r.director.id);
  const mint = planCommRoundMint({ request: req, agents: r.agents, existingAssignments: [] });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  assert.equal(mint.spec.schema, 'office-comm-round@1');
  assert.equal(mint.spec.projectId, req.projectId);
  assert.match(mint.specHash, /^[a-f0-9]{64}$/);
  const byKey = new Map(mint.entries.map(entry => [entry.key, entry] as const));
  const draftA = byKey.get('plan-draft-a')!;
  const draftB = byKey.get('plan-draft-b')!;
  assert.equal(draftA.agentId, r.plannerA.id, 'the PM_A seat resolves to the PM_A agent');
  assert.equal(draftB.agentId, r.plannerB.id);
  assert.equal(draftA.armRole, 'PM_A');
  assert.equal(draftB.armRole, 'PM_B');
  assert.deepEqual(draftA.toolProfile, PLANNER_TOOL_PROFILE);
  const synthesis = byKey.get('plan-synthesis')!;
  assert.equal(synthesis.agentId, r.director.id, 'the director seat is the request lead');
  assert.equal(synthesis.armRole, 'DIRECTOR');
  assert.deepEqual(synthesis.toolProfile, DIRECTOR_TOOL_PROFILE);
  assert.deepEqual(synthesis.dependsOnKeys, ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a']);
  const implements_ = mint.entries.filter(entry => entry.phase === 'IMPLEMENT');
  assert.equal(implements_.length, 2, 'one implement hop per live worker');
  assert.deepEqual(implements_.map(entry => entry.agentId), [r.worker1.id, r.worker2.id]);
  for (const entry of implements_) assert.equal(entry.armRole, 'WORKER');
  assert.deepEqual(byKey.get('verify')!.dependsOnKeys, implements_.map(entry => entry.key));
  assert.deepEqual(byKey.get('user-gate')!.dependsOnKeys, ['verify']);
  for (const entry of mint.entries) {
    assert.ok(entry.objectiveText.includes('Ship the bounded plan.'), `${entry.key} carries the request objective`);
    assert.ok(entry.objectiveText.length <= REFINE_NOTE_MAX, `${entry.key} instruction stays bounded`);
  }
  assert.match(byKey.get('user-gate')!.objectiveText, /Human gate/);
  assert.match(byKey.get('plan-critique-a-on-b')!.objectiveText, /opposite artifact plan-draft-b/);
});

test('a RESULT_ANALYSIS request mints the standalone analysis spec when the template exports it', () => {
  const r = roster();
  const req = request('RESULT_ANALYSIS', r.director.id);
  const mint = planCommRoundMint({ request: req, agents: r.agents, existingAssignments: [] });
  if (typeof analysisBuilder !== 'function') {
    assert.equal(mint.ok, false, 'pre-extension template refuses honestly rather than faking the spec');
    if (!mint.ok) assert.match(mint.detail, /buildAnalysisRound/);
    return;
  }
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  const byKey = new Map(mint.entries.map(entry => [entry.key, entry] as const));
  assert.equal(byKey.get('analysis-brief')!.agentId, r.director.id);
  assert.equal(byKey.get('analysis-digest')!.armRole, 'WORKER');
  assert.deepEqual(byKey.get('analysis-digest')!.toolProfile, WORKER_TOOL_PROFILE);
  assert.equal(byKey.get('analysis-interpret')!.agentId, r.analystC.id);
  assert.equal(byKey.get('analysis-falsify')!.agentId, r.analystD.id);
  assert.equal(byKey.get('analysis-interpret')!.armRole, 'PM_C');
  assert.equal(byKey.get('analysis-falsify')!.armRole, 'PM_D');
  assert.deepEqual(byKey.get('analysis-interpret')!.toolProfile, ANALYST_TOOL_PROFILE);
  assert.equal(byKey.get('analysis-finalize')!.agentId, r.director.id);
  assert.equal(byKey.get('analysis-report')!.armRole, 'WORKER');
  assert.deepEqual(byKey.get('user-gate')!.dependsOnKeys, ['analysis-report']);
  assert.match(byKey.get('analysis-digest')!.objectiveText, /evidence brief.*name the gaps|name the gaps/);
});

test('every missing required role produces ok:false naming it — never a partial silent mint', () => {
  const r = roster();
  const req = request('PLANNING', r.director.id);
  const withoutB = planCommRoundMint({ request: req, agents: r.agents.filter(a => a !== r.plannerB), existingAssignments: [] });
  assert.deepEqual(withoutB.ok ? [] : withoutB.missingRoles, ['PM_B']);
  const noWorkers = planCommRoundMint({ request: req, agents: r.agents.filter(a => a.role !== 'WORKER'), existingAssignments: [] });
  assert.deepEqual(noWorkers.ok ? [] : noWorkers.missingRoles, ['WORKER']);
  const noLead = planCommRoundMint({ request: request('PLANNING', null), agents: r.agents, existingAssignments: [] });
  assert.deepEqual(noLead.ok ? [] : noLead.missingRoles, ['DIRECTOR']);
  const archivedLead = planCommRoundMint({
    request: req, agents: [{ ...r.director, removedAt: at(1) }, ...r.agents.slice(1)], existingAssignments: [],
  });
  assert.deepEqual(archivedLead.ok ? [] : archivedLead.missingRoles, ['DIRECTOR']);
  const bare = planCommRoundMint({ request: req, agents: [], existingAssignments: [] });
  assert.deepEqual(bare.ok ? [] : bare.missingRoles, ['DIRECTOR', 'PM_A', 'PM_B', 'WORKER']);
  if (!bare.ok) assert.match(bare.detail, /DIRECTOR, PM_A, PM_B, WORKER/);
});

test('role resolution takes the first live agent in roster order and skips archived seats', () => {
  const r = roster();
  const second = agent('PM_A');
  const mint = planCommRoundMint({
    request: request('PLANNING', r.director.id),
    agents: [r.director, { ...r.plannerA, removedAt: at(1) }, second, ...r.agents.slice(2)],
    existingAssignments: [],
  });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  assert.equal(mint.entries.find(entry => entry.key === 'plan-draft-a')!.agentId, second.id,
    'the archived PM_A is skipped for the next live one');
});

test('a non-pipeline request refuses without minting', () => {
  const r = roster();
  const mint = planCommRoundMint({ request: request('QUESTION', r.director.id), agents: r.agents, existingAssignments: [] });
  assert.equal(mint.ok, false);
  if (!mint.ok) assert.match(mint.detail, /no pipeline kind/);
});

test('identical inputs mint identical specs, hashes and entries', () => {
  const r = roster();
  const req = request('PLANNING', r.director.id);
  const a = planCommRoundMint({ request: req, agents: r.agents, existingAssignments: [] });
  const b = planCommRoundMint({ request: req, agents: r.agents, existingAssignments: [] });
  assert.deepEqual(a, b);
  if (a.ok && b.ok) assert.equal(a.specHash, b.specHash);
});

test('an already-minted pipeline key attaches its assignment id to the mint entry', () => {
  const r = roster();
  const existing = assignment(randomUUID(), 'plan-draft-a');
  const mint = planCommRoundMint({ request: request('PLANNING', r.director.id), agents: r.agents, existingAssignments: [existing] });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  assert.equal(mint.entries.find(entry => entry.key === 'plan-draft-a')!.assignmentId, existing.id);
  assert.equal(mint.entries.find(entry => entry.key === 'plan-draft-b')!.assignmentId, undefined);
});

test('refine hops chain off the prior brief key and carry only the bounded note', () => {
  const r = roster();
  const req = request('PLANNING', r.director.id);
  const first = planRefineHop(req, 'Narrow the plan to ingestion only.', 'plan-brief');
  assert.equal(first.key, 'brief-refine-1');
  assert.equal(first.phase, 'BRIEF_REFINE');
  assert.equal(first.armRole, 'DIRECTOR');
  assert.equal(first.agentId, r.director.id);
  assert.deepEqual(first.dependsOnKeys, ['plan-brief']);
  assert.equal(first.objectiveText, 'Narrow the plan to ingestion only.');
  assert.deepEqual(first.toolProfile, DIRECTOR_TOOL_PROFILE);
  const fourth = planRefineHop(req, 'Fourth note.', 'brief-refine-3');
  assert.equal(fourth.key, 'brief-refine-4');
  assert.deepEqual(fourth.dependsOnKeys, ['brief-refine-3']);
});

test('refine hops refuse an oversized or empty note and a leaderless request', () => {
  const r = roster();
  const req = request('PLANNING', r.director.id);
  assert.throws(() => planRefineHop(req, 'x'.repeat(REFINE_NOTE_MAX + 1), 'plan-brief'), /bounded to 4000 characters/);
  assert.throws(() => planRefineHop(req, '   ', 'plan-brief'), /empty payload/);
  assert.throws(() => planRefineHop(request('PLANNING', null), 'note', 'plan-brief'), /no leadAgentId/);
  assert.throws(() => planRefineHop(req, 'note', ''), /prior brief key/);
  assert.equal(planRefineHop(req, 'x'.repeat(REFINE_NOTE_MAX), 'plan-brief').objectiveText.length, REFINE_NOTE_MAX);
});

test('mintEntriesFor re-keys the spec DAG onto assignment ids', () => {
  const r = roster();
  const mint = planCommRoundMint({ request: request('PLANNING', r.director.id), agents: r.agents, existingAssignments: [] });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  const minted = mint.spec.entries.map(entry => assignment(randomUUID(), entry.key));
  const resolved = mintEntriesFor(mint.spec, minted);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const byKey = new Map(resolved.entries.map(entry => [entry.key, entry] as const));
  const synthesis = byKey.get('plan-synthesis')!;
  assert.deepEqual(synthesis.dependsOn, ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a'].map(key => byKey.get(key)!.assignmentId));
  assert.equal(byKey.get('user-gate')!.dependsOn[0], byKey.get('verify')!.assignmentId);
  // Assignments without a pipeline key are unrelated work, not an error.
  const withForeign = mintEntriesFor(mint.spec, [...minted, assignment(randomUUID())]);
  assert.equal(withForeign.ok, true);
});

test('mintEntriesFor refuses unminted spec keys, unknown assignment keys and duplicate claims', () => {
  const r = roster();
  const mint = planCommRoundMint({ request: request('PLANNING', r.director.id), agents: r.agents, existingAssignments: [] });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  const minted = mint.spec.entries.map(entry => assignment(randomUUID(), entry.key));
  const missing = mintEntriesFor(mint.spec, minted.filter(a => a.pipelineKey !== 'verify'));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.detail, /verify/);
  const unknown = mintEntriesFor(mint.spec, [...minted, assignment(randomUUID(), 'not-in-the-spec')]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.detail, /'not-in-the-spec'/);
  const dup = mintEntriesFor(mint.spec, [...minted, assignment(randomUUID(), 'verify')]);
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.detail, /pipeline key 'verify'/);
});
