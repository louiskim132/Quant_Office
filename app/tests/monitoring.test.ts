import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { calibration, compareMethods, lineageAncestry } from '../src/core/monitoring.js';
import type { PredictionRecord, ResearchBranch, ResearchRecords, TrialLedgerEntry } from '../src/shared/research.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const at = (day: number) => new Date(Date.UTC(2024, 2, day)).toISOString();
const PROJECT = randomUUID();

function branch(name: string, overrides: Partial<ResearchBranch> = {}): ResearchBranch {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    projectId: PROJECT,
    name,
    parentBranchId: null,
    lineageId: overrides.lineageId ?? id,
    stage: 'S4',
    outcome: 'IN_PROGRESS',
    specId: randomUUID(),
    predictionId: null,
    revision: 1,
    createdAt: at(1),
    updatedAt: at(2),
    ...overrides,
  };
}
const trial = (
  target: ResearchBranch,
  description: string,
  outcome: TrialLedgerEntry['outcome'],
  day: number,
): TrialLedgerEntry => ({
  id: randomUUID(),
  lineageId: target.lineageId,
  branchId: target.id,
  kind: 'VARIANT',
  variantHash: sha256(description),
  description,
  outcome,
  createdAt: at(day),
  settledAt: at(day + 1),
});

test('retirement stays visible in the ancestry of every descendant that might repeat it', () => {
  const root = branch('Order-flow imbalance', {
    retiredAt: at(4),
    retiredReason: 'The signal did not survive costs at any horizon.',
  });
  const child = branch('Order-flow imbalance, restated', { parentBranchId: root.id, lineageId: root.lineageId });
  const grandchild = branch('Order-flow imbalance, third attempt', {
    parentBranchId: child.id,
    lineageId: root.lineageId,
  });
  const records: ResearchRecords = { branches: [root, child, grandchild] };

  const ancestry = lineageAncestry(records, grandchild.id);
  assert.deepEqual(
    ancestry.map(node => node.branch.name),
    [grandchild.name, child.name, root.name],
  );
  assert.deepEqual(
    ancestry.map(node => node.depth),
    [0, 1, 2],
  );
  assert.equal(ancestry[2].retiredReason, 'The signal did not survive costs at any horizon.');

  // A retirement with no recorded reason still shows, and says that the reason is missing.
  const vague: ResearchRecords = { branches: [{ ...root, retiredReason: undefined }, child] };
  assert.equal(lineageAncestry(vague, child.id)[1].retiredReason, 'Retired without a recorded reason.');
});

test('calibration excludes retrospective records and carries its own uncertainty', () => {
  const make = (low: number, high: number, retrospective = false): PredictionRecord => ({
    id: randomUUID(),
    branchId: randomUUID(),
    specId: randomUUID(),
    outcomeName: 'net return',
    sign: 'POSITIVE',
    expectedLow: low,
    expectedHigh: high,
    probability: 0.6,
    falsifiers: ['costs exceed the edge'],
    existingKnowledge: 'prior work',
    retrospective,
    createdAt: at(1),
  });
  const inside = [make(0, 0.1), make(0, 0.1), make(0, 0.1)];
  const outside = [make(0.5, 0.6)];
  const described = make(0, 0.1, true);
  const realised: Record<string, number | null> = Object.fromEntries(
    [...inside, ...outside, described].map(item => [item.id, 0.05]),
  );

  const report = calibration([...inside, ...outside, described], realised);
  assert.equal(report.scored, 4, 'the retrospective record is not scored');
  assert.equal(report.retrospectiveExcluded, 1);
  assert.equal(report.hitRate, 0.75);
  assert.ok(Math.abs(report.standardError! - Math.sqrt((0.75 * 0.25) / 4)) < 1e-12);
  assert.match(report.detail, /3 of 4 registered intervals contained the outcome/);
  assert.match(report.detail, /describe outcomes rather than forecast them|retrospective record was excluded/);

  const unresolved = calibration(inside, {});
  assert.equal(unresolved.hitRate, null);
  assert.equal(unresolved.standardError, null);
  assert.match(unresolved.detail, /No registered prediction has a realised value yet/);
});

test('a method comparison on a handful of trials is reported as a count, not a winner', () => {
  const first = branch('Method A'),
    second = branch('Method B');
  const records: ResearchRecords = {
    branches: [first, second],
    trials: [
      ...Array.from({ length: 12 }, (_, index) =>
        trial(first, `A variant ${index}`, index % 3 === 0 ? 'FAILED' : 'COMPLETED', index),
      ),
      ...Array.from({ length: 3 }, (_, index) => trial(second, `B variant ${index}`, 'COMPLETED', index)),
    ],
  };
  const [a, b] = compareMethods(records, [
    { name: 'Method A', lineageIds: [first.lineageId] },
    { name: 'Method B', lineageIds: [second.lineageId] },
  ]);
  assert.equal(a.trials, 12);
  assert.equal(a.failed, 4);
  assert.equal(a.distinctVariants, 12);
  assert.match(a.detail, /12 trials and 12 distinct variants/);
  assert.match(b.detail, /too few to compare methods on. This is a count, not a comparison/);
});
