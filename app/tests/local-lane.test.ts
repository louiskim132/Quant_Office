import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localRequirementFor } from '../src/main/local-lane';
import type { Assignment } from '../src/shared/types';
import type { StageContext } from '../src/shared/pipeline';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const assignment = (): Assignment => ({
  id: randomUUID(),
  projectId: randomUUID(),
  requestId: randomUUID(),
  requestRevision: 1,
  agentId: randomUUID(),
  agentRevision: 0,
  connectionId: randomUUID(),
  capabilitySnapshotId: randomUUID(),
  snapshotId: randomUUID(),
  route: 'LOCAL_MAILBOX',
  requestedModel: 'devin-local',
  resolvedModel: '',
  requestedEffort: 'default',
  appliedEffort: 'UNVERIFIED',
  delegation: false,
  objectiveHash: sha('objective'),
  createdAt: new Date(Date.UTC(2026, 8, 18, 10, 0, 0)).toISOString(),
});

const stageContext = (stage: StageContext['stage'] = 'S2'): StageContext => ({
  branchId: randomUUID(),
  branchRevision: 0,
  specId: randomUUID(),
  subjectHash: sha('subject'),
  stage,
  function: 'CORRECTNESS_REVIEWER',
  contextHash: sha('context'),
  outputSchema: 'research-stage-report@1',
  objectHashes: [],
  requestRevision: 1,
});

test('a plain request assignment needs only scoped delivery and may use either layout', () => {
  const decision = localRequirementFor(assignment());
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.requirement, 'SCOPED_DELIVERY');
    assert.deepEqual(decision.permittedLayouts, ['FLAT_PACKET', 'PROJECT_WORKTREE']);
  }
});

test('a research-context assignment requires read confinement no layout currently proves', () => {
  for (const stage of ['S2', 'S7', 'S4'] as const) {
    const decision = localRequirementFor({ ...assignment(), research: stageContext(stage) });
    assert.equal(decision.allowed, true, stage);
    if (decision.allowed) {
      assert.equal(decision.requirement, 'READ_CONFINEMENT_REQUIRED', stage);
      assert.deepEqual(
        decision.permittedLayouts,
        [],
        'no layout carries verified read confinement today — dispatch must refuse, not rename the claim',
      );
    }
  }
});

test('a malformed research context is refused rather than routed', () => {
  for (const research of [{}, null, { stage: 'S2' }] as unknown as StageContext[]) {
    const decision = localRequirementFor({ ...assignment(), research });
    assert.equal(decision.allowed, false, JSON.stringify(research));
    if (!decision.allowed) assert.match(decision.reason, /malformed|cannot be routed/i);
  }
});

test('malformed or partial records are refused — unknown requirements never inherit a label', () => {
  for (const bad of [null, undefined, 'assignment', {}] as unknown as Assignment[]) {
    const decision = localRequirementFor(bad);
    assert.equal(decision.allowed, false);
  }
  const missingField: Partial<Assignment> = assignment();
  delete missingField.requestId;
  assert.equal(
    localRequirementFor(missingField as Assignment).allowed,
    false,
    'a record missing a required field is malformed',
  );
  const mistyped = { ...assignment(), requestRevision: '1' as unknown as number };
  assert.equal(localRequirementFor(mistyped).allowed, false, 'a field of the wrong kind is malformed');
});

test('the decision reads the record and never changes it', () => {
  const work = { ...assignment(), research: stageContext() };
  const before = JSON.stringify(work);
  localRequirementFor(work);
  assert.equal(JSON.stringify(work), before);
});
