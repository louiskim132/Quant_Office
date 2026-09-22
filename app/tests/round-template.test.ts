import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../src/core/canonical';
import {
  ANALYST_TOOL_PROFILE, DIRECTOR_TOOL_PROFILE, PLANNER_TOOL_PROFILE, WORKER_TOOL_PROFILE,
  buildCommRound, type CommRoundDeclaration, type CommRoundEntry,
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

const byKey = (entries: CommRoundEntry[]) => new Map(entries.map(item => [item.key, item]));

test('one declaration yields the full phase-1 DAG: drafts ∥ → critiques ∥ → synthesis → implement/verify/gate', () => {
  const declared = declaration();
  const spec = buildCommRound(declared);
  assert.equal(spec.schema, 'office-comm-round@1');
  assert.equal(spec.projectId, declared.projectId);
  assert.equal(spec.packetVersion, declared.packetVersion);
  const entries = spec.entries;
  // 5 phase-1 entries + 2 implement + verify + user-gate, in topological order.
  assert.deepEqual(entries.map(item => item.key),
    ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a', 'plan-synthesis',
     'implement-1', 'implement-2', 'verify', 'user-gate']);
  const map = byKey(entries);
  assert.equal(map.get('plan-draft-a')!.phase, 'PLAN_DRAFT');
  assert.equal(map.get('plan-draft-a')!.agentId, 'pm-a');
  assert.equal(map.get('plan-draft-b')!.agentId, 'pm-b');
  assert.deepEqual(map.get('plan-draft-a')!.dependsOnKeys, []);
  assert.deepEqual(map.get('plan-draft-b')!.dependsOnKeys, []);
  assert.deepEqual(map.get('plan-synthesis')!.dependsOnKeys,
    ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a']);
  assert.equal(map.get('plan-synthesis')!.agentId, 'director-1');
  assert.deepEqual(map.get('implement-1')!.dependsOnKeys, ['plan-synthesis']);
  assert.deepEqual(map.get('implement-2')!.dependsOnKeys, ['plan-synthesis']);
  assert.equal(map.get('implement-1')!.phase, 'IMPLEMENT');
  assert.deepEqual(map.get('verify')!.dependsOnKeys, ['implement-1', 'implement-2']);
  assert.deepEqual(map.get('user-gate')!.dependsOnKeys, ['verify']);
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
  assert.equal(canonicalHash(map.get('plan-draft-a')!.inputManifestNote), canonicalHash(map.get('plan-draft-b')!.inputManifestNote));
  const withAnalysts = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const mirror = byKey(withAnalysts);
  assert.equal(mirror.get('analysis-interpret')!.inputManifestNote, mirror.get('analysis-falsify')!.inputManifestNote);
});

test('critique entries name only the opposite draft artifact; the spec carries no transcript fields', () => {
  const entries = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const map = byKey(entries);
  assert.deepEqual(map.get('plan-critique-a-on-b')!.dependsOnKeys, ['plan-draft-b'],
    'planner A responds to the named items of draft B, never the whole transcript');
  assert.deepEqual(map.get('plan-critique-b-on-a')!.dependsOnKeys, ['plan-draft-a']);
  assert.deepEqual(map.get('analysis-response-interpret')!.dependsOnKeys, ['analysis-falsify']);
  assert.deepEqual(map.get('analysis-response-falsify')!.dependsOnKeys, ['analysis-interpret']);
  // No free-text carryover: every entry carries exactly the six declared fields.
  for (const item of entries)
    assert.deepEqual(Object.keys(item).sort(), ['agentId', 'dependsOnKeys', 'inputManifestNote', 'key', 'phase', 'toolProfile']);
  // And no field anywhere holds the brief prose or any transcript.
  for (const item of entries) {
    assert.ok(!JSON.stringify(item).includes('Plan the next evidence review'), `${item.key} must not carry the brief text`);
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
  assert.deepEqual(map.get('analysis-finalize')!.dependsOnKeys,
    ['analysis-interpret', 'analysis-falsify', 'analysis-response-interpret', 'analysis-response-falsify']);
  // With analysts present the implement hops ride the finalized analysis, not the plan alone.
  assert.deepEqual(map.get('implement-1')!.dependsOnKeys, ['analysis-finalize']);
  assert.deepEqual(entries.map(item => item.phase).filter(phase => phase === 'PLAN_SYNTHESIS'), ['PLAN_SYNTHESIS', 'PLAN_SYNTHESIS']);
});

test('per-arm tool profiles match the plugin table', () => {
  const entries = buildCommRound(declaration({ analysts: ['pm-c', 'pm-d'] })).entries;
  const map = byKey(entries);
  for (const key of ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a'])
    assert.deepEqual(map.get(key)!.toolProfile, PLANNER_TOOL_PROFILE, `${key} is a planner arm`);
  assert.equal(PLANNER_TOOL_PROFILE.mcpServers?.[0]?.id, 'serena');
  assert.equal(PLANNER_TOOL_PROFILE.mcpServers?.[0]?.readOnly, true);
  for (const key of ['analysis-interpret', 'analysis-falsify', 'analysis-response-interpret', 'analysis-response-falsify'])
    assert.deepEqual(map.get(key)!.toolProfile, ANALYST_TOOL_PROFILE, `${key} is an analyst arm`);
  assert.equal(ANALYST_TOOL_PROFILE.mcpServers?.[0]?.id, 'evidence-surface');
  assert.equal(ANALYST_TOOL_PROFILE.mcpServers?.[0]?.readOnly, true);
  assert.equal(ANALYST_TOOL_PROFILE.canWrite, false);
  for (const key of ['implement-1', 'implement-2'])
    assert.deepEqual(map.get(key)!.toolProfile, WORKER_TOOL_PROFILE);
  assert.equal(WORKER_TOOL_PROFILE.canWrite, true);
  for (const key of ['plan-synthesis', 'analysis-finalize', 'verify', 'user-gate'])
    assert.deepEqual(map.get(key)!.toolProfile, DIRECTOR_TOOL_PROFILE, `${key} is a director hop`);
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
});

test('malformed declarations throw instead of producing a spec', () => {
  // Missing arms.
  assert.throws(() => buildCommRound(declaration({ planners: ['pm-a'] as unknown as [string, string] })), /two distinct agents/);
  assert.throws(() => buildCommRound(declaration({ planners: [] as unknown as [string, string] })), /two distinct agents/);
  assert.throws(() => buildCommRound(declaration({ workerAgentIds: [] })), /at least one worker/);
  assert.throws(() => buildCommRound(declaration({ directorAgentId: '' })), /director/);
  assert.throws(() => buildCommRound(declaration({ brief: '  ' })), /brief/);
  assert.throws(() => buildCommRound(declaration({ projectId: '' })), /office project/);
  // A diverge pair cannot be one agent twice — that would be a duplicate arm, not a second opinion.
  assert.throws(() => buildCommRound(declaration({ planners: ['pm-a', 'pm-a'] })), /two different agents/);
  assert.throws(() => buildCommRound(declaration({ analysts: ['pm-c', 'pm-c'] })), /two different agents/);
  assert.throws(() => buildCommRound(declaration({ analysts: ['pm-c'] as unknown as [string, string] })), /two distinct agents/);
  // Duplicate worker ids would mint two implement entries for one arm.
  assert.throws(() => buildCommRound(declaration({ workerAgentIds: ['worker-1', 'worker-1'] })), /distinct/);
  // The packet version every hop rides must be a real version.
  assert.throws(() => buildCommRound(declaration({ packetVersion: 0 })), /packetVersion/);
  assert.throws(() => buildCommRound(declaration({ packetVersion: 1.5 })), /packetVersion/);
});
