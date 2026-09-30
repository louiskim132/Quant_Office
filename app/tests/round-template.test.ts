import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../src/core/canonical';
import {
  ANALYST_TOOL_PROFILE,
  DIRECTOR_TOOL_PROFILE,
  PLANNER_TOOL_PROFILE,
  WORKER_TOOL_PROFILE,
  buildAnalysisRound,
  buildCommRound,
  type AnalysisRoundDeclaration,
  type CommRoundDeclaration,
  type CommRoundEntry,
} from '../src/main/round-template';

const declaration = (overrides: Partial<CommRoundDeclaration> = {}): CommRoundDeclaration => ({
  projectId: randomUUID(),
  brief: 'Plan the next evidence review for project alpha.',
  directorAgentId: 'director-1',
  planners: ['pm-a', 'pm-b'],
  workerAgentIds: ['worker-1', 'worker-2'],
  packetVersion: 2,
  ...overrides,
});

const analysisDeclaration = (overrides: Partial<AnalysisRoundDeclaration> = {}): AnalysisRoundDeclaration => ({
  projectId: randomUUID(),
  brief: 'Interpret the returned result bundle for project alpha.',
  directorAgentId: 'director-1',
  analysts: ['pm-c', 'pm-d'],
  workerAgentId: 'worker-1',
  packetVersion: 2,
  ...overrides,
});

const byKey = (entries: CommRoundEntry[]) => new Map(entries.map(item => [item.key, item]));

test('one declaration yields the full phase-1 DAG: brief → drafts ∥ → critiques ∥ → synthesis → implement → verify', () => {
  const declared = declaration();
  const spec = buildCommRound(declared);
  assert.equal(spec.schema, 'office-comm-round@1');
  assert.equal(spec.projectId, declared.projectId);
  assert.equal(spec.packetVersion, declared.packetVersion);
  const entries = spec.entries;
  // brief + 5 phase-1 entries + 2 implement + verify, in topological order — the seal after
  // verify is a wait state the office holds, not a hop any agent runs.
  assert.deepEqual(
    entries.map(item => item.key),
    [
      'plan-brief',
      'plan-draft-a',
      'plan-draft-b',
      'plan-critique-a-on-b',
      'plan-critique-b-on-a',
      'plan-synthesis',
      'implement-1',
      'implement-2',
      'verify',
    ],
  );
  assert.ok(!entries.some(item => item.key === 'user-gate'), 'no user-gate hop exists');
  const map = byKey(entries);
  // The director's brief hop leads the round — the user-facing "talk to the director first" step.
  assert.equal(map.get('plan-brief')!.phase, 'BRIEF');
  assert.equal(map.get('plan-brief')!.agentId, 'director-1');
  assert.equal(map.get('plan-brief')!.armRole, 'DIRECTOR');
  assert.deepEqual(map.get('plan-brief')!.dependsOnKeys, []);
  assert.deepEqual(map.get('plan-brief')!.toolProfile, DIRECTOR_TOOL_PROFILE);
  assert.equal(map.get('plan-draft-a')!.phase, 'PLAN_DRAFT');
  assert.equal(map.get('plan-draft-a')!.agentId, 'pm-a');
  assert.equal(map.get('plan-draft-b')!.agentId, 'pm-b');
  // Both draft arms read the director's brief artifact — identical manifests by construction.
  assert.deepEqual(map.get('plan-draft-a')!.dependsOnKeys, ['plan-brief']);
  assert.deepEqual(map.get('plan-draft-b')!.dependsOnKeys, ['plan-brief']);
  assert.equal(map.get('plan-draft-a')!.inputManifestNote, map.get('plan-draft-b')!.inputManifestNote);
  assert.deepEqual(map.get('plan-synthesis')!.dependsOnKeys, [
    'plan-draft-a',
    'plan-draft-b',
    'plan-critique-a-on-b',
    'plan-critique-b-on-a',
  ]);
  assert.equal(map.get('plan-synthesis')!.agentId, 'director-1');
  assert.deepEqual(map.get('implement-1')!.dependsOnKeys, ['plan-synthesis']);
  assert.deepEqual(map.get('implement-2')!.dependsOnKeys, ['plan-synthesis']);
  assert.equal(map.get('implement-1')!.phase, 'IMPLEMENT');
  assert.equal(map.get('verify')!.phase, 'VERIFY');
  assert.deepEqual(map.get('verify')!.dependsOnKeys, ['implement-1', 'implement-2']);
  // The terminal seal reads the whole round's verified artifacts, not only its barrier.
  assert.deepEqual(map.get('verify')!.inputKeys, [
    'plan-brief',
    'plan-draft-a',
    'plan-draft-b',
    'plan-critique-a-on-b',
    'plan-critique-b-on-a',
    'plan-synthesis',
    'implement-1',
    'implement-2',
  ]);
  // Every ordinary hop stages exactly the predecessors it was declared against.
  for (const item of entries.slice(0, -1))
    assert.deepEqual(item.inputKeys, item.dependsOnKeys, `${item.key} stages only its declared predecessors`);
  // Every dependency names an earlier entry — the emitted order is a topological one.
  const seen = new Set<string>();
  for (const item of entries) {
    for (const dep of item.dependsOnKeys) assert.ok(seen.has(dep), `${item.key} depends on un-emitted ${dep}`);
    seen.add(item.key);
  }
});

test('parallel arms carry byte-identical input manifests', () => {
  const entries = buildCommRound(declaration()).entries;
  const map = byKey(entries);
  assert.equal(map.get('plan-draft-a')!.inputManifestNote, map.get('plan-draft-b')!.inputManifestNote);
  assert.equal(
    canonicalHash(map.get('plan-draft-a')!.inputManifestNote),
    canonicalHash(map.get('plan-draft-b')!.inputManifestNote),
  );
  const withAnalysts = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const mirror = byKey(withAnalysts);
  assert.equal(mirror.get('analysis-interpret')!.inputManifestNote, mirror.get('analysis-falsify')!.inputManifestNote);
});

test('critique entries name only the opposite draft artifact; the spec carries no transcript fields', () => {
  const entries = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const map = byKey(entries);
  assert.deepEqual(
    map.get('plan-critique-a-on-b')!.dependsOnKeys,
    ['plan-draft-b'],
    'planner A responds to the named items of draft B, never the whole transcript',
  );
  assert.deepEqual(map.get('plan-critique-b-on-a')!.dependsOnKeys, ['plan-draft-a']);
  assert.deepEqual(map.get('analysis-response-interpret')!.dependsOnKeys, ['analysis-falsify']);
  assert.deepEqual(map.get('analysis-response-falsify')!.dependsOnKeys, ['analysis-interpret']);
  // No free-text carryover: every entry carries exactly the nine declared fields.
  for (const item of entries)
    assert.deepEqual(Object.keys(item).sort(), [
      'agentId',
      'armRole',
      'dependsOnKeys',
      'inputKeys',
      'inputManifestNote',
      'inputScope',
      'key',
      'phase',
      'toolProfile',
    ]);
  // And no field anywhere holds the brief prose or any transcript.
  for (const item of entries) {
    assert.ok(
      !JSON.stringify(item).includes('Plan the next evidence review'),
      `${item.key} must not carry the brief text`,
    );
    for (const dep of item.dependsOnKeys) assert.ok(!/transcript/i.test(dep));
  }
});

test('the phase-2 mirror emits interpret ∥ falsify → bounded responses → director finalize', () => {
  const entries = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const map = byKey(entries);
  assert.equal(map.get('analysis-interpret')!.agentId, 'pm-c');
  assert.equal(map.get('analysis-falsify')!.agentId, 'pm-d');
  assert.deepEqual(map.get('analysis-interpret')!.dependsOnKeys, ['plan-synthesis']);
  assert.deepEqual(map.get('analysis-falsify')!.dependsOnKeys, ['plan-synthesis']);
  assert.equal(map.get('analysis-interpret')!.phase, 'PLAN_DRAFT');
  assert.equal(map.get('analysis-response-interpret')!.phase, 'PLAN_CRITIQUE');
  assert.equal(map.get('analysis-finalize')!.phase, 'PLAN_SYNTHESIS');
  assert.deepEqual(map.get('analysis-finalize')!.dependsOnKeys, [
    'analysis-interpret',
    'analysis-falsify',
    'analysis-response-interpret',
    'analysis-response-falsify',
  ]);
  // With analysts present the implement hops ride the finalized analysis, not the plan alone.
  assert.deepEqual(map.get('implement-1')!.dependsOnKeys, ['analysis-finalize']);
  assert.deepEqual(
    entries.map(item => item.phase).filter(phase => phase === 'PLAN_SYNTHESIS'),
    ['PLAN_SYNTHESIS', 'PLAN_SYNTHESIS'],
  );
});

test('per-arm tool profiles match the plugin table', () => {
  const entries = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const map = byKey(entries);
  for (const key of ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a'])
    assert.deepEqual(map.get(key)!.toolProfile, PLANNER_TOOL_PROFILE, `${key} is a planner arm`);
  assert.equal(PLANNER_TOOL_PROFILE.mcpServers?.[0]?.id, 'serena');
  assert.equal(PLANNER_TOOL_PROFILE.mcpServers?.[0]?.readOnly, true);
  for (const key of [
    'analysis-interpret',
    'analysis-falsify',
    'analysis-response-interpret',
    'analysis-response-falsify',
  ])
    assert.deepEqual(map.get(key)!.toolProfile, ANALYST_TOOL_PROFILE, `${key} is an analyst arm`);
  assert.equal(ANALYST_TOOL_PROFILE.mcpServers?.[0]?.id, 'evidence-surface');
  assert.equal(ANALYST_TOOL_PROFILE.mcpServers?.[0]?.readOnly, true);
  assert.equal(ANALYST_TOOL_PROFILE.canWrite, false);
  for (const key of ['implement-1', 'implement-2']) assert.deepEqual(map.get(key)!.toolProfile, WORKER_TOOL_PROFILE);
  assert.equal(WORKER_TOOL_PROFILE.canWrite, true);
  for (const key of ['plan-brief', 'plan-synthesis', 'analysis-finalize', 'verify'])
    assert.deepEqual(map.get(key)!.toolProfile, DIRECTOR_TOOL_PROFILE, `${key} is a director hop`);
});

test('every entry carries the armRole its roster position fills', () => {
  const entries = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const expected: Record<string, CommRoundEntry['armRole']> = {
    'plan-brief': 'DIRECTOR',
    'plan-draft-a': 'PM_A',
    'plan-critique-a-on-b': 'PM_A',
    'plan-draft-b': 'PM_B',
    'plan-critique-b-on-a': 'PM_B',
    'analysis-interpret': 'PM_C',
    'analysis-response-interpret': 'PM_C',
    'analysis-falsify': 'PM_D',
    'analysis-response-falsify': 'PM_D',
    'plan-synthesis': 'DIRECTOR',
    'analysis-finalize': 'DIRECTOR',
    'implement-1': 'WORKER',
    'implement-2': 'WORKER',
    verify: 'DIRECTOR',
  };
  for (const item of entries) assert.equal(item.armRole, expected[item.key], `${item.key} fills the wrong roster role`);
  // The armRole names the declaration's own roster slot, so it stays honest under remapping.
  const remapped = buildCommRound(declaration({ planners: ['pm-x', 'pm-y'], analysts: ['pm-c', 'pm-d'] })).entries;
  const remap = byKey(remapped);
  assert.equal(remap.get('plan-draft-a')!.agentId, 'pm-x');
  assert.equal(remap.get('plan-draft-a')!.armRole, 'PM_A', 'the role names the roster slot, not the agent');
});

test('planning hops mint BLIND; implement, verify and the whole analysis round mint FULL', () => {
  const entries = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const map = byKey(entries);
  // Every hop ahead of implementation plans blind — including the phase-2 mirror, whose hops
  // analyze the synthesized plan, not delivered results.
  for (const key of [
    'plan-brief',
    'plan-draft-a',
    'plan-draft-b',
    'plan-critique-a-on-b',
    'plan-critique-b-on-a',
    'plan-synthesis',
    'analysis-interpret',
    'analysis-falsify',
    'analysis-response-interpret',
    'analysis-response-falsify',
    'analysis-finalize',
  ])
    assert.equal(map.get(key)!.inputScope, 'BLIND', `${key} plans blind`);
  for (const item of entries)
    if (item.key.startsWith('implement-') || item.key === 'verify')
      assert.equal(item.inputScope, 'FULL', `${item.key} reads outcomes`);
  // The standalone RESULT_ANALYSIS round exists to read results — every hop is FULL.
  for (const item of buildAnalysisRound(analysisDeclaration()).entries)
    assert.equal(item.inputScope, 'FULL', `${item.key} — the analysis round reads results`);
});

test('the analysis round emits brief → digest → interpret ∥ falsify → responses → finalize → report', () => {
  const declared = analysisDeclaration();
  const spec = buildAnalysisRound(declared);
  assert.equal(spec.schema, 'office-comm-round@1');
  assert.equal(spec.projectId, declared.projectId);
  assert.equal(spec.packetVersion, declared.packetVersion);
  const entries = spec.entries;
  assert.deepEqual(
    entries.map(item => item.key),
    [
      'analysis-brief',
      'analysis-digest',
      'analysis-interpret',
      'analysis-falsify',
      'analysis-response-interpret',
      'analysis-response-falsify',
      'analysis-finalize',
      'analysis-report',
    ],
  );
  assert.ok(!entries.some(item => item.key === 'user-gate'), 'no user-gate hop exists');
  const map = byKey(entries);
  // The director's brief leads; the worker digests it into the evidence surface before the
  // analyst pair diverges — neither arm reads the raw result directly.
  assert.equal(map.get('analysis-brief')!.phase, 'BRIEF');
  assert.equal(map.get('analysis-brief')!.armRole, 'DIRECTOR');
  assert.deepEqual(map.get('analysis-brief')!.dependsOnKeys, []);
  assert.equal(map.get('analysis-digest')!.phase, 'DIGEST');
  assert.equal(map.get('analysis-digest')!.agentId, 'worker-1');
  assert.equal(map.get('analysis-digest')!.armRole, 'WORKER');
  assert.deepEqual(map.get('analysis-digest')!.toolProfile, WORKER_TOOL_PROFILE);
  assert.deepEqual(map.get('analysis-digest')!.dependsOnKeys, ['analysis-brief']);
  assert.deepEqual(map.get('analysis-interpret')!.dependsOnKeys, ['analysis-digest']);
  assert.deepEqual(map.get('analysis-falsify')!.dependsOnKeys, ['analysis-digest']);
  assert.equal(map.get('analysis-interpret')!.agentId, 'pm-c');
  assert.equal(map.get('analysis-interpret')!.armRole, 'PM_C');
  assert.equal(map.get('analysis-falsify')!.agentId, 'pm-d');
  assert.equal(map.get('analysis-falsify')!.armRole, 'PM_D');
  for (const key of [
    'analysis-interpret',
    'analysis-falsify',
    'analysis-response-interpret',
    'analysis-response-falsify',
  ])
    assert.deepEqual(map.get(key)!.toolProfile, ANALYST_TOOL_PROFILE, `${key} is an analyst arm`);
  assert.equal(
    map.get('analysis-interpret')!.inputManifestNote,
    map.get('analysis-falsify')!.inputManifestNote,
    'the diverging analyst arms carry byte-identical manifests',
  );
  // Bounded cross-responses name only the opposite arm's artifact.
  assert.deepEqual(map.get('analysis-response-interpret')!.dependsOnKeys, ['analysis-falsify']);
  assert.deepEqual(map.get('analysis-response-falsify')!.dependsOnKeys, ['analysis-interpret']);
  assert.deepEqual(map.get('analysis-finalize')!.dependsOnKeys, [
    'analysis-interpret',
    'analysis-falsify',
    'analysis-response-interpret',
    'analysis-response-falsify',
  ]);
  assert.equal(map.get('analysis-finalize')!.armRole, 'DIRECTOR');
  assert.equal(map.get('analysis-report')!.phase, 'REPORT');
  assert.equal(map.get('analysis-report')!.armRole, 'WORKER');
  assert.deepEqual(map.get('analysis-report')!.dependsOnKeys, ['analysis-finalize']);
  // The terminal seal reads the whole round — every other key in declaration order.
  assert.deepEqual(map.get('analysis-report')!.inputKeys, [
    'analysis-brief',
    'analysis-digest',
    'analysis-interpret',
    'analysis-falsify',
    'analysis-response-interpret',
    'analysis-response-falsify',
    'analysis-finalize',
  ]);
  for (const item of entries.slice(0, -1))
    assert.deepEqual(item.inputKeys, item.dependsOnKeys, `${item.key} stages only its declared predecessors`);
  // Emission order is topological — every dependency names an earlier entry.
  const seen = new Set<string>();
  for (const item of entries) {
    for (const dep of item.dependsOnKeys) assert.ok(seen.has(dep), `${item.key} depends on un-emitted ${dep}`);
    seen.add(item.key);
  }
  // No field anywhere carries transcript prose.
  for (const item of entries)
    assert.ok(
      !JSON.stringify(item).includes('Interpret the returned result bundle'),
      `${item.key} must not carry the brief text`,
    );
});

test('the spec is byte-identical for identical declarations', () => {
  const declared = declaration();
  const one = buildCommRound(declared);
  const two = buildCommRound(declared);
  assert.deepEqual(one, two);
  assert.equal(canonicalHash(one), canonicalHash(two));
  // Identical declarations include analyst arms when declared.
  const withAnalysts = declaration({ analysts: ['pm-c', 'pm-d'] });
  assert.equal(canonicalHash(buildCommRound(withAnalysts)), canonicalHash(buildCommRound(withAnalysts)));
  // And the planner itself holds no state — building from a literal equal declaration is identical too.
  assert.equal(canonicalHash(buildCommRound({ ...declared })), canonicalHash(one));
  // The analysis round is deterministic the same way.
  const analysis = analysisDeclaration();
  assert.equal(canonicalHash(buildAnalysisRound(analysis)), canonicalHash(buildAnalysisRound(analysis)));
  assert.equal(canonicalHash(buildAnalysisRound({ ...analysis })), canonicalHash(buildAnalysisRound(analysis)));
});

test('malformed declarations throw instead of producing a spec', () => {
  // Missing arms.
  assert.throws(
    () => buildCommRound(declaration({ planners: ['pm-a'] as unknown as [string, string] })),
    /two distinct agents/,
  );
  assert.throws(
    () => buildCommRound(declaration({ planners: [] as unknown as [string, string] })),
    /two distinct agents/,
  );
  assert.throws(() => buildCommRound(declaration({ workerAgentIds: [] })), /at least one worker/);
  assert.throws(() => buildCommRound(declaration({ directorAgentId: '' })), /director/);
  assert.throws(() => buildCommRound(declaration({ brief: '  ' })), /brief/);
  assert.throws(() => buildCommRound(declaration({ projectId: '' })), /office project/);
  // A diverge pair cannot be one agent twice — that would be a duplicate arm, not a second opinion.
  assert.throws(() => buildCommRound(declaration({ planners: ['pm-a', 'pm-a'] })), /two different agents/);
  assert.throws(() => buildCommRound(declaration({ analysts: ['pm-c', 'pm-c'] })), /two different agents/);
  assert.throws(
    () => buildCommRound(declaration({ analysts: ['pm-c'] as unknown as [string, string] })),
    /two distinct agents/,
  );
  // Duplicate worker ids would mint two implement entries for one arm.
  assert.throws(() => buildCommRound(declaration({ workerAgentIds: ['worker-1', 'worker-1'] })), /distinct/);
  // The packet version every hop rides must be a real version.
  assert.throws(() => buildCommRound(declaration({ packetVersion: 0 })), /packetVersion/);
  assert.throws(() => buildCommRound(declaration({ packetVersion: 1.5 })), /packetVersion/);
});

test('malformed analysis declarations throw instead of producing a spec', () => {
  assert.throws(
    () => buildAnalysisRound(analysisDeclaration({ analysts: ['pm-c'] as unknown as [string, string] })),
    /two distinct agents/,
  );
  assert.throws(() => buildAnalysisRound(analysisDeclaration({ analysts: ['pm-c', 'pm-c'] })), /two different agents/);
  assert.throws(() => buildAnalysisRound(analysisDeclaration({ workerAgentId: '' })), /worker arm/);
  assert.throws(() => buildAnalysisRound(analysisDeclaration({ directorAgentId: '' })), /director/);
  assert.throws(() => buildAnalysisRound(analysisDeclaration({ brief: ' ' })), /brief/);
  assert.throws(() => buildAnalysisRound(analysisDeclaration({ projectId: '' })), /office project/);
  assert.throws(() => buildAnalysisRound(analysisDeclaration({ packetVersion: 0 })), /packetVersion/);
  // A plan-round declaration does not stand in for an analysis declaration.
  assert.throws(() => buildAnalysisRound(declaration() as unknown as AnalysisRoundDeclaration), /two distinct agents/);
});
