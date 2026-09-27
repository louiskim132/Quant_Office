import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mintEntriesFor, planCommRoundMint, planRefineHop, REFINE_NOTE_MAX } from '../src/main/round-executor';
import {
  ANALYST_TOOL_PROFILE,
  DIRECTOR_TOOL_PROFILE,
  PLANNER_TOOL_PROFILE,
  WORKER_TOOL_PROFILE,
} from '../src/main/round-template';
import * as roundTemplate from '../src/main/round-template';
import type { Agent, Assignment, Request, Role } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const analysisBuilder = (roundTemplate as unknown as { buildAnalysisRound?: unknown }).buildAnalysisRound;

function agent(role: Role, overrides: Partial<Agent> = {}): Agent {
  return {
    id: randomUUID(),
    name: `${role} seat`,
    provider: 'claude',
    model: 'opus',
    team: 'Research',
    role,
    instructions: '',
    account: `${role.toLowerCase()}@example.com`,
    createdAt: at(0),
    connectionVerifiedAt: at(0),
    execution: 'LOCAL',
    ...overrides,
  };
}

function request(
  kind: 'PLANNING' | 'RESULT_ANALYSIS' | 'QUESTION',
  leadAgentId: string | null,
  overrides: Partial<Request> = {},
): Request {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    experimentId: null,
    name: 'Pipeline request',
    objective: 'Ship the bounded plan.',
    workType: kind === 'QUESTION' ? 'QUESTION' : kind,
    mode: 'GROUP',
    leadAgentId,
    participantIds: [],
    acceptanceCriteria: 'A plan.',
    revision: 0,
    status: 'READY',
    blockers: [],
    delegation: false,
    createdAt: at(0),
    updatedAt: at(0),
    ...(kind === 'QUESTION'
      ? {}
      : { pipeline: { kind, specHash: null, phase: 'BRIEFING' as const, briefAssignmentId: null } }),
    ...overrides,
  };
}

function assignment(id: string, pipelineKey?: string): Assignment {
  return {
    id,
    pipelineKey,
    projectId: randomUUID(),
    requestId: randomUUID(),
    requestRevision: 0,
    agentId: randomUUID(),
    agentRevision: 0,
    connectionId: randomUUID(),
    capabilitySnapshotId: randomUUID(),
    snapshotId: randomUUID(),
    route: 'LOCAL_CLI_EXEC',
    requestedModel: 'fixture-model',
    resolvedModel: '',
    requestedEffort: 'default',
    appliedEffort: 'UNVERIFIED',
    delegation: false,
    objectiveHash: 'a'.repeat(64),
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
  return {
    director,
    plannerA,
    plannerB,
    analystC,
    analystD,
    worker1,
    worker2,
    agents: [director, plannerA, plannerB, analystC, analystD, worker1, worker2],
  };
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
  assert.deepEqual(synthesis.dependsOnKeys, [
    'plan-draft-a',
    'plan-draft-b',
    'plan-critique-a-on-b',
    'plan-critique-b-on-a',
  ]);
  const implements_ = mint.entries.filter(entry => entry.phase === 'IMPLEMENT');
  assert.equal(implements_.length, 2, 'one implement hop per live worker');
  assert.deepEqual(
    implements_.map(entry => entry.agentId),
    [r.worker1.id, r.worker2.id],
  );
  for (const entry of implements_) assert.equal(entry.armRole, 'WORKER');
  assert.deepEqual(
    byKey.get('verify')!.dependsOnKeys,
    implements_.map(entry => entry.key),
  );
  assert.equal(
    mint.entries.at(-1)!.key,
    'verify',
    'the terminal hop is verify — the seal is a wait state, not a minted hop',
  );
  assert.equal(byKey.get('user-gate'), undefined, 'no user-gate hop exists in the spec');
  for (const entry of mint.entries) {
    assert.ok(entry.objectiveText.includes('Ship the bounded plan.'), `${entry.key} carries the request objective`);
    assert.ok(entry.objectiveText.length <= REFINE_NOTE_MAX, `${entry.key} instruction stays bounded`);
  }
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
  assert.equal(
    mint.entries.at(-1)!.key,
    'analysis-report',
    'the terminal hop is the report — the seal is a wait state, not a minted hop',
  );
  assert.equal(byKey.get('user-gate'), undefined, 'no user-gate hop exists in the spec');
  assert.match(byKey.get('analysis-digest')!.objectiveText, /evidence brief.*name the gaps|name the gaps/);
});

test('every missing required role produces ok:false naming it — never a partial silent mint', () => {
  const r = roster();
  const req = request('PLANNING', r.director.id);
  const withoutB = planCommRoundMint({
    request: req,
    agents: r.agents.filter(a => a !== r.plannerB),
    existingAssignments: [],
  });
  assert.deepEqual(withoutB.ok ? [] : withoutB.missingRoles, ['PM_B']);
  const noWorkers = planCommRoundMint({
    request: req,
    agents: r.agents.filter(a => a.role !== 'WORKER'),
    existingAssignments: [],
  });
  assert.deepEqual(noWorkers.ok ? [] : noWorkers.missingRoles, ['WORKER']);
  const noLead = planCommRoundMint({ request: request('PLANNING', null), agents: r.agents, existingAssignments: [] });
  assert.deepEqual(noLead.ok ? [] : noLead.missingRoles, ['DIRECTOR']);
  const archivedLead = planCommRoundMint({
    request: req,
    agents: [{ ...r.director, removedAt: at(1) }, ...r.agents.slice(1)],
    existingAssignments: [],
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
  assert.equal(
    mint.entries.find(entry => entry.key === 'plan-draft-a')!.agentId,
    second.id,
    'the archived PM_A is skipped for the next live one',
  );
});

test('a non-pipeline request refuses without minting', () => {
  const r = roster();
  const mint = planCommRoundMint({
    request: request('QUESTION', r.director.id),
    agents: r.agents,
    existingAssignments: [],
  });
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
  const req = request('PLANNING', r.director.id);
  const existing = { ...assignment(randomUUID(), 'plan-draft-a'), requestId: req.id };
  const mint = planCommRoundMint({ request: req, agents: r.agents, existingAssignments: [existing] });
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
  const req = request('PLANNING', r.director.id);
  const mint = planCommRoundMint({ request: req, agents: r.agents, existingAssignments: [] });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  const minted = mint.spec.entries.map(entry => ({ ...assignment(randomUUID(), entry.key), requestId: req.id }));
  const resolved = mintEntriesFor(mint.spec, req, minted);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const byKey = new Map(resolved.entries.map(entry => [entry.key, entry] as const));
  const synthesis = byKey.get('plan-synthesis')!;
  assert.deepEqual(
    synthesis.dependsOn,
    ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a'].map(
      key => byKey.get(key)!.assignmentId,
    ),
  );
  assert.deepEqual(
    byKey.get('verify')!.dependsOn,
    mint.spec.entries.filter(entry => entry.phase === 'IMPLEMENT').map(entry => byKey.get(entry.key)!.assignmentId),
  );
  // Assignments without a pipeline key are unrelated work, not an error.
  const withForeign = mintEntriesFor(mint.spec, req, [...minted, assignment(randomUUID())]);
  assert.equal(withForeign.ok, true);
});

test('mintEntriesFor refuses unminted spec keys, unknown assignment keys and duplicate claims', () => {
  const r = roster();
  const req = request('PLANNING', r.director.id);
  const mint = planCommRoundMint({ request: req, agents: r.agents, existingAssignments: [] });
  assert.equal(mint.ok, true);
  if (!mint.ok) return;
  const minted = mint.spec.entries.map(entry => ({ ...assignment(randomUUID(), entry.key), requestId: req.id }));
  const missing = mintEntriesFor(
    mint.spec,
    req,
    minted.filter(a => a.pipelineKey !== 'verify'),
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.detail, /verify/);
  const unknown = mintEntriesFor(mint.spec, req, [
    ...minted,
    { ...assignment(randomUUID(), 'not-in-the-spec'), requestId: req.id },
  ]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.detail, /'not-in-the-spec'/);
  const dup = mintEntriesFor(mint.spec, req, [...minted, { ...assignment(randomUUID(), 'verify'), requestId: req.id }]);
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.detail, /pipeline key 'verify'/);
});

test("pipelineKey lookups are request-scoped — another request's hops are invisible", () => {
  const r = roster();
  const reqA = request('PLANNING', r.director.id);
  const reqB = request('PLANNING', r.director.id);
  // Request A's already-minted hop must never satisfy request B's mint.
  const foreign = { ...assignment(randomUUID(), 'plan-draft-a'), requestId: reqA.id };
  const mintB = planCommRoundMint({ request: reqB, agents: r.agents, existingAssignments: [foreign] });
  assert.equal(mintB.ok, true);
  if (!mintB.ok) return;
  assert.equal(
    mintB.entries.find(entry => entry.key === 'plan-draft-a')!.assignmentId,
    undefined,
    "a foreign-request pipeline key is not this round's mint",
  );
  const own = { ...assignment(randomUUID(), 'plan-draft-a'), requestId: reqB.id };
  const remintB = planCommRoundMint({ request: reqB, agents: r.agents, existingAssignments: [foreign, own] });
  if (!remintB.ok) return assert.fail('mint should resolve');
  assert.equal(
    remintB.entries.find(entry => entry.key === 'plan-draft-a')!.assignmentId,
    own.id,
    "the request's own assignment carries the key",
  );
  // mintEntriesFor sees only the request's assignments even when both requests' hops are listed.
  const allB = mintB.spec.entries.map(entry => ({ ...assignment(randomUUID(), entry.key), requestId: reqB.id }));
  const allA = mintB.spec.entries.map(entry => ({ ...assignment(randomUUID(), entry.key), requestId: reqA.id }));
  const resolved = mintEntriesFor(mintB.spec, reqB, [...allA, ...allB]);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const bIds = new Set(allB.map(item => item.id));
  for (const entry of resolved.entries) {
    assert.ok(bIds.has(entry.assignmentId), `${entry.key} resolved to request B's own assignment`);
    for (const dep of entry.dependsOn) assert.ok(bIds.has(dep), "edges bind request B's ids only");
  }
  // Two requests minting identical spec keys never collide on the duplicate-key guard either.
});

test('every hop instruction names the file it writes, and only implement hops may write the deliverables', () => {
  const r = roster();
  const mint = planCommRoundMint({
    request: request('PLANNING', r.director.id),
    agents: r.agents,
    existingAssignments: [],
  });
  assert.ok(mint.ok);
  if (!mint.ok) return;
  const byKey = new Map(mint.entries.map(entry => [entry.key, entry.objectiveText] as const));
  const writes: Record<string, RegExp> = {
    'plan-brief': /Write outputs\/brief\.md/,
    'plan-draft-a': /Write outputs\/plan\.md/,
    'plan-draft-b': /Write outputs\/plan\.md/,
    'plan-critique-a-on-b': /Write outputs\/critique\.md/,
    'plan-critique-b-on-a': /Write outputs\/critique\.md/,
    'plan-synthesis': /outputs\/plan\.md[\s\S]*outputs\/analysis-plan\.md/,
    verify: /write outputs\/verification\.md/,
  };
  for (const [key, pattern] of Object.entries(writes))
    assert.match(byKey.get(key)!, pattern, `${key} names its output file`);
  for (const key of ['plan-brief', 'plan-draft-a', 'plan-draft-b', 'plan-synthesis'])
    assert.match(
      byKey.get(key)!,
      /Do not write code or the request's deliverables/,
      `${key} is told not to produce the deliverable`,
    );
  assert.match(
    byKey.get('plan-critique-a-on-b')!,
    /inputs\/inherited\/plan-draft-b\/plan\.md/,
    'a critique names the staged path of the opposite draft',
  );
  assert.match(byKey.get('plan-draft-a')!, /inputs\/inherited\/plan-brief\/brief\.md/);
  assert.match(byKey.get('verify')!, /Do not rewrite the deliverables/);
  assert.match(
    byKey.get('plan-synthesis')!,
    /exactly 2 sections headed "## Slice 1" … "## Slice 2"/,
    'two workers get two disjoint slices',
  );
  assert.match(byKey.get('implement-1')!, /^Implement Slice 1 of inputs\/inherited\/plan-synthesis\/plan\.md/);
  assert.match(byKey.get('implement-2')!, /^Implement Slice 2 of .*If Slice 2 is EMPTY/);
  for (const text of byKey.values()) assert.ok(text.length <= REFINE_NOTE_MAX);
});

test('a single-worker round has no slices', () => {
  const r = roster();
  const agents = r.agents.filter(item => item.id !== r.worker2.id);
  const mint = planCommRoundMint({ request: request('PLANNING', r.director.id), agents, existingAssignments: [] });
  assert.ok(mint.ok);
  if (!mint.ok) return;
  const byKey = new Map(mint.entries.map(entry => [entry.key, entry.objectiveText] as const));
  assert.doesNotMatch(byKey.get('plan-synthesis')!, /Slice/);
  assert.match(byKey.get('implement-1')!, /^Implement inputs\/inherited\/plan-synthesis\/plan\.md exactly/);
  assert.doesNotMatch(byKey.get('implement-1')!, /Slice/);
});

test('analysis-round hops name their output files and the brief adopts a pre-registered plan', () => {
  const r = roster();
  const mint = planCommRoundMint({
    request: request('RESULT_ANALYSIS', r.director.id),
    agents: r.agents,
    existingAssignments: [],
  });
  assert.ok(mint.ok);
  if (!mint.ok) return;
  const byKey = new Map(mint.entries.map(entry => [entry.key, entry.objectiveText] as const));
  assert.match(
    byKey.get('analysis-brief')!,
    /Write outputs\/brief\.md[\s\S]*analysis-plan\.md[\s\S]*adopt it as the work order/,
  );
  assert.match(byKey.get('analysis-digest')!, /Write outputs\/digest\.md/);
  assert.match(byKey.get('analysis-finalize')!, /Write outputs\/assessment\.md/);
  assert.match(byKey.get('analysis-report')!, /Write outputs\/report\.md/);
});

test('a QUICK planning round is brief → one planner → one worker → verify, and needs no PM_B', () => {
  const r = roster();
  const agents = r.agents.filter(item => item.id !== r.plannerB.id);
  const req = request('PLANNING', r.director.id);
  const full = planCommRoundMint({ request: req, agents, existingAssignments: [] });
  assert.equal(full.ok, false, 'the full round still requires PM_B');
  const mint = planCommRoundMint({ request: req, agents, existingAssignments: [], shape: 'QUICK' });
  assert.ok(mint.ok);
  if (!mint.ok) return;
  assert.deepEqual(
    mint.entries.map(entry => entry.key),
    ['plan-brief', 'plan-draft-a', 'implement-1', 'verify'],
  );
  const byKey = new Map(mint.entries.map(entry => [entry.key, entry] as const));
  assert.equal(byKey.get('implement-1')!.agentId, r.worker1.id, 'the first live worker takes the single seat');
  assert.deepEqual(byKey.get('implement-1')!.dependsOnKeys, ['plan-draft-a']);
  assert.match(
    byKey.get('plan-draft-a')!.objectiveText,
    /quick round[\s\S]*this plan is final[\s\S]*outputs\/analysis-plan\.md/,
  );
  assert.match(byKey.get('implement-1')!.objectiveText, /^Implement inputs\/inherited\/plan-draft-a\/plan\.md exactly/);
  // The recorded shape is read when no override is passed.
  const recorded = planCommRoundMint({
    request: { ...req, pipeline: { ...req.pipeline!, shape: 'QUICK' } },
    agents,
    existingAssignments: [],
  });
  assert.ok(recorded.ok && recorded.entries.length === 4);
});

test('a QUICK analysis round drops only the two cross-responses', () => {
  const r = roster();
  const mint = planCommRoundMint({
    request: request('RESULT_ANALYSIS', r.director.id),
    agents: r.agents,
    existingAssignments: [],
    shape: 'QUICK',
  });
  assert.ok(mint.ok);
  if (!mint.ok) return;
  assert.deepEqual(
    mint.entries.map(entry => entry.key),
    [
      'analysis-brief',
      'analysis-digest',
      'analysis-interpret',
      'analysis-falsify',
      'analysis-finalize',
      'analysis-report',
    ],
  );
  assert.deepEqual(mint.entries.find(entry => entry.key === 'analysis-finalize')!.dependsOnKeys, [
    'analysis-interpret',
    'analysis-falsify',
  ]);
});

test('a revision that restarts at implementation mints brief → implement-1 → verify with no planner seat', () => {
  const r = roster();
  const agents = r.agents.filter(item => item.role !== 'PM_A' && item.role !== 'PM_B');
  const req = request('PLANNING', r.director.id, {
    revisionOf: { requestId: randomUUID(), decisionAt: at(1), round: 1, restartAt: 'IMPLEMENTATION' },
  });
  const mint = planCommRoundMint({ request: req, agents, existingAssignments: [] });
  assert.ok(mint.ok, mint.ok ? '' : mint.detail);
  if (!mint.ok) return;
  assert.deepEqual(
    mint.entries.map(entry => entry.key),
    ['plan-brief', 'implement-1', 'verify'],
  );
  const byKey = new Map(mint.entries.map(entry => [entry.key, entry.objectiveText] as const));
  assert.match(
    byKey.get('plan-brief')!,
    /keeps the approved plan[\s\S]*outputs\/plan\.md[\s\S]*outputs\/analysis-plan\.md[\s\S]*outputs\/brief\.md/,
  );
  assert.match(
    byKey.get('implement-1')!,
    /^Apply the amended plan inputs\/inherited\/plan-brief\/plan\.md[\s\S]*prior-implement-\*/,
  );
});
