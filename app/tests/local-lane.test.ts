import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localLaneFor } from '../src/main/local-lane';
import type { Assignment } from '../src/shared/types';
import type { StageContext } from '../src/shared/pipeline';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const assignment = (): Assignment => ({
  id: randomUUID(), projectId: randomUUID(), requestId: randomUUID(), requestRevision: 1,
  agentId: randomUUID(), agentRevision: 0, connectionId: randomUUID(), capabilitySnapshotId: randomUUID(),
  snapshotId: randomUUID(), route: 'LOCAL_MAILBOX', requestedModel: 'devin-local', resolvedModel: '',
  requestedEffort: 'default', appliedEffort: 'UNVERIFIED', delegation: false, objectiveHash: sha('objective'),
  createdAt: new Date(Date.UTC(2026, 8, 18, 10, 0, 0)).toISOString(),
});

const stageContext = (): StageContext => ({
  branchId: randomUUID(), branchRevision: 0, specId: randomUUID(), subjectHash: sha('subject'),
  stage: 'S2', function: 'CORRECTNESS_REVIEWER', contextHash: sha('context'),
  outputSchema: 'research-stage-report@1', objectHashes: [], requestRevision: 1,
});

test('a plain request assignment takes the routine lane', () => {
  assert.equal(localLaneFor(assignment()), 'ROUTINE_ALLOWED');
});

test('an assignment carrying research pipeline context is isolated unconditionally', () => {
  assert.equal(localLaneFor({ ...assignment(), research: stageContext() }), 'ISOLATED',
    'a sealed review stage promises independence a shared project root cannot keep');
  // The context's own validity is not the lane's question: any defined value is research machinery.
  assert.equal(localLaneFor({ ...assignment(), research: {} as StageContext }), 'ISOLATED');
  assert.equal(localLaneFor({ ...assignment(), research: null as unknown as StageContext }), 'ISOLATED');
});

test('ambiguous or partial records default to the isolated lane', () => {
  assert.equal(localLaneFor(null as unknown as Assignment), 'ISOLATED');
  assert.equal(localLaneFor(undefined as unknown as Assignment), 'ISOLATED');
  assert.equal(localLaneFor('assignment' as unknown as Assignment), 'ISOLATED');
  assert.equal(localLaneFor({} as Assignment), 'ISOLATED', 'an empty record is not a plain request assignment');
  const missingField: Partial<Assignment> = assignment();
  delete missingField.requestId;
  assert.equal(localLaneFor(missingField as Assignment), 'ISOLATED', 'a record missing a required field is ambiguous');
  const mistyped = { ...assignment(), requestRevision: '1' as unknown as number };
  assert.equal(localLaneFor(mistyped), 'ISOLATED', 'a field of the wrong kind is an unknown shape');
});

test('the decision reads the record and never changes it', () => {
  const work = { ...assignment(), research: stageContext() };
  const before = JSON.stringify(work);
  assert.equal(localLaneFor(work), 'ISOLATED');
  assert.equal(JSON.stringify(work), before);
});
