import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { strToU8 } from 'fflate';
import { HoldoutCustody, type CustodyPaths } from '../src/main/holdout.js';
import { custodyBlocker, quarterOf, unsealBlockers, UNSEAL_REQUIRED_GATES,
  type CustodyCapability, type EvaluatorInput, type Holdout, type IsolatedEvaluator } from '../src/shared/holdout.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const at = (minutes: number) => new Date(Date.UTC(2024, 0, 15, 0, minutes)).toISOString();

const SUPPORTED: CustodyCapability = { sealedStorageSupported: true, isolatedEvaluatorSupported: true, detail: 'fake isolated custody' };

/** An evaluator that records exactly what it was handed, so isolation is asserted, not assumed. */
class FakeEvaluator implements IsolatedEvaluator {
  readonly isolated = true as const;
  seen: EvaluatorInput[] = [];
  async evaluate(input: EvaluatorInput) {
    this.seen.push(input);
    return { reportHash: sha256('report:' + input.candidateHash), metric: 'RANK_IC', value: 0.01,
      samples: input.predictions.length, detail: 'fixture evaluation' };
  }
}

/** Passing gates for every check the unseal policy requires, so a test can fail exactly one. */
const passingGates = () => UNSEAL_REQUIRED_GATES.map(gate => ({ gate, outcome: 'PASS' as const }));

function fixture(t: TestContext, capability: CustodyCapability = SUPPORTED, evaluator: IsolatedEvaluator | null = new FakeEvaluator()) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-holdout-'));
  // Custody lives beside the workspace, never inside it: that is what keeps it out of backups.
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const paths: CustodyPaths = { sealedRoot: path.join(root, 'holdout-sealed'), journalFile: path.join(root, 'exposure-journal.jsonl') };
  t.after(() => removeTreeSync(root));
  let tick = 0;
  const custody = new HoldoutCustody(paths, capability, evaluator, () => at(++tick));
  const bytes = strToU8('rowId,target\nh1,0.02\nh2,-0.01\n');
  const sealed = capability.sealedStorageSupported ? custody.seal(bytes) : { sealedHash: sha256(bytes), sealedBytes: bytes.length };
  const holdout: Holdout = { id: randomUUID(), projectId: randomUUID(), name: 'Final holdout 2024H2',
    sealedHash: sealed.sealedHash, sealedBytes: sealed.sealedBytes, periodPolicy: 'CALENDAR_QUARTER',
    timezoneOffsetMinutes: 0, allowancePerPeriod: 1, createdAt: at(0) };
  return { root, workspace, paths, custody, holdout, bytes, evaluator: evaluator as FakeEvaluator };
}

const reserveRequest = (holdout: Holdout, overrides: Record<string, unknown> = {}) => ({
  holdout, lineageId: randomUUID(), branchId: randomUUID(), candidateHash: sha256('candidate'),
  refitHash: sha256('refit'), gates: passingGates(), adjudication: 'UPHELD' as const, ...overrides,
});

test('custody must be genuinely outside the workspace, not marked as separate', () => {
  const workspace = path.join('/office', 'workspace');
  assert.equal(HoldoutCustody.separationBlocker({ sealedRoot: path.join('/office', 'holdout-sealed'), journalFile: path.join('/office', 'journal.jsonl') }, workspace), null);
  assert.match(HoldoutCustody.separationBlocker({ sealedRoot: path.join(workspace, 'holdout'), journalFile: path.join('/office', 'journal.jsonl') }, workspace) ?? '',
    /backups and the evidence index would reach it/);
  assert.match(HoldoutCustody.separationBlocker({ sealedRoot: path.join('/office', 'sealed'), journalFile: path.join(workspace, 'journal.jsonl') }, workspace) ?? '',
    /restoring a backup would forget what has been spent/);
});

test('unsupported custody leaves S8 blocked, with no local substitute', t => {
  for (const capability of [
    { sealedStorageSupported: false, isolatedEvaluatorSupported: true, detail: 'no sealed store' },
    { sealedStorageSupported: true, isolatedEvaluatorSupported: false, detail: 'no isolated evaluator' },
  ] as CustodyCapability[]) {
    assert.match(custodyBlocker(capability) ?? '', /S8 stays blocked/);
    const f = fixture(t, capability, null);
    assert.throws(() => f.custody.reserve(reserveRequest(f.holdout)), /S8 stays blocked/);
    assert.equal(f.custody.journal().length, 0, 'a blocked reservation writes nothing');
  }
  assert.match(custodyBlocker({ sealedStorageSupported: false, isolatedEvaluatorSupported: true, detail: 'x' }) ?? '',
    /no local file or token that substitutes for custody/);
});

test('a candidate with any failed or missing S2, S6 or S7 outcome cannot unseal a holdout', t => {
  const f = fixture(t);
  for (const gate of ['G-CORRECT', 'G-COST', 'G-PORTFOLIO'] as const) {
    const gates = passingGates().map(item => item.gate === gate ? { gate, outcome: 'FAIL' as const } : item);
    assert.throws(() => f.custody.reserve(reserveRequest(f.holdout, { gates })), /may not be evaluated against a final holdout/);
  }
  const missing = passingGates().filter(item => item.gate !== 'G-FIT');
  assert.throws(() => f.custody.reserve(reserveRequest(f.holdout, { gates: missing })), /may not be evaluated against a final holdout/);
  const blockedGate = passingGates().map(item => item.gate === 'G-ECON' ? { gate: item.gate, outcome: 'BLOCKED' as const } : item);
  assert.throws(() => f.custody.reserve(reserveRequest(f.holdout, { gates: blockedGate })), /may not be evaluated against a final holdout/);

  for (const adjudication of [null, 'REVISION_REQUIRED', 'FOLLOW_UP_GRANTED', 'LINEAGE_SUSPENDED'] as const)
    assert.throws(() => f.custody.reserve(reserveRequest(f.holdout, { adjudication })), /may not be evaluated against a final holdout/);

  assert.equal(f.custody.journal().length, 0, 'no refused admission touches the journal');
  assert.deepEqual(unsealBlockers({ gates: passingGates(), adjudication: 'UPHELD' }), []);
});

test('two admissions racing for the last slot cannot both spend it', t => {
  const f = fixture(t);
  const first = f.custody.reserve(reserveRequest(f.holdout));
  assert.equal(first.reservation.state, 'RESERVED');
  assert.equal(f.custody.spent(f.holdout.id, first.reservation.period).used, 1);

  assert.throws(() => f.custody.reserve(reserveRequest(f.holdout)), /allowance of 1 is already spent/);
  // A wider allowance admits the second, and no more.
  const wider = { ...f.holdout, allowancePerPeriod: 2 };
  const second = f.custody.reserve(reserveRequest(wider));
  assert.equal(f.custody.spent(wider.id, second.reservation.period).used, 2);
  assert.throws(() => f.custody.reserve(reserveRequest(wider)), /allowance of 2 is already spent/);
});

test('the allowance renews on the quarter boundary in the holdout own zone, not the machine zone', () => {
  // 31 March 23:30 UTC is Q1 at UTC and Q2 an hour ahead. Whichever is right, it is the holdout's
  // declared zone that decides, so the answer cannot change with where the office is running.
  const boundary = '2024-03-31T23:30:00.000Z';
  assert.equal(quarterOf(boundary, 0), '2024Q1');
  assert.equal(quarterOf(boundary, 60), '2024Q2');
  assert.equal(quarterOf(boundary, -300), '2024Q1');
  assert.equal(quarterOf('2024-01-01T00:00:00.000Z', 0), '2024Q1');
  assert.equal(quarterOf('2024-01-01T00:00:00.000Z', -60), '2023Q4');
  assert.equal(quarterOf('2024-12-31T23:59:59.000Z', 0), '2024Q4');
});

test('a renamed lineage does not get a fresh allowance', t => {
  const f = fixture(t);
  const lineageId = randomUUID();
  f.custody.reserve(reserveRequest(f.holdout, { lineageId }));
  // A new branch id and a new candidate under the same holdout still meet the same spent allowance:
  // the budget belongs to the holdout's period, and renaming the work does not renew it.
  assert.throws(() => f.custody.reserve(reserveRequest(f.holdout, { lineageId: randomUUID(), branchId: randomUUID(), candidateHash: sha256('candidate-2') })),
    /allowance of 1 is already spent/);
});

test('the isolated evaluator receives only the sealed bytes, and exposure is journalled first', async t => {
  const f = fixture(t);
  const { reservation } = f.custody.reserve(reserveRequest(f.holdout));
  const { reservation: settled, result } = await f.custody.evaluate(reservation, f.holdout, [{ rowId: 'h1', prediction: 0.4 }, { rowId: 'h2', prediction: -0.2 }]);

  assert.equal(settled.state, 'EXPOSED');
  assert.equal(result.samples, 2);
  // Exposure is on record before the evaluator ran, so a crash inside it still counts as a look.
  const kinds = f.custody.journal().map(entry => entry.kind);
  assert.deepEqual(kinds, ['RESERVED', 'EXPOSED']);

  // What the evaluator was handed: the sealed bytes and the predictions, and nothing that would let
  // it read the workspace, its index or another project.
  assert.equal(f.evaluator.seen.length, 1);
  assert.deepEqual(Object.keys(f.evaluator.seen[0]).sort(), ['candidateHash', 'predictions', 'sealedBytes', 'sealedHash']);
  const leaked = JSON.stringify(Object.keys(f.evaluator.seen[0]));
  for (const forbidden of ['store', 'root', 'workspace', 'query', 'cache', 'evidence']) assert.equal(leaked.includes(forbidden), false);

  // A second evaluation on the same reservation is refused: the look has been taken.
  await assert.rejects(f.custody.evaluate(settled, f.holdout, []), /cannot be evaluated again|exact query/);
});

test('re-fetching the same report is free; a changed candidate or a new query is another look', async t => {
  const f = fixture(t);
  const request = reserveRequest(f.holdout);
  const { reservation } = f.custody.reserve(request);
  const { reservation: settled, result } = await f.custody.evaluate(reservation, f.holdout, [{ rowId: 'h1', prediction: 0.4 }]);

  const replay = f.custody.fetchReport(settled, { reportHash: result.reportHash, candidateHash: request.candidateHash });
  assert.equal(replay.replay, true);
  assert.deepEqual(f.custody.journal().map(entry => entry.kind), ['RESERVED', 'EXPOSED'], 'a replay is not a new exposure');

  assert.throws(() => f.custody.fetchReport(settled, { reportHash: result.reportHash, candidateHash: sha256('candidate-2') }),
    /needs its own reservation and its own allowance/);
  assert.throws(() => f.custody.fetchReport(settled, { reportHash: sha256('another query'), candidateHash: request.candidateHash }),
    /a new look, not a re-fetch/);
});

test('a manual export is exposure before the bytes leave, and its evidence is classified honestly', t => {
  const f = fixture(t);
  const { reservation } = f.custody.reserve(reserveRequest(f.holdout));
  const exported = f.custody.exportPackage(reservation, f.holdout);
  assert.deepEqual(Buffer.from(exported.bytes), Buffer.from(f.bytes));
  assert.match(exported.classification, /user-attested.*not an isolated evaluation/s);
  assert.deepEqual(f.custody.journal().map(entry => entry.kind), ['RESERVED', 'EXPORTED']);
  assert.match(f.custody.journal()[1].detail, /before the handover/);
  assert.throws(() => f.custody.exportPackage(exported.reservation, f.holdout), /cannot be exported again/);
});

test('only verified non-exposure releases an allowance', t => {
  const f = fixture(t);
  const { reservation } = f.custody.reserve(reserveRequest(f.holdout));
  assert.throws(() => f.custody.release(reservation, { verifiedNonExposure: false, detail: 'the run failed' }),
    /A reservation is released only on verified non-exposure/);
  assert.equal(f.custody.spent(f.holdout.id, reservation.period).used, 1);

  const released = f.custody.release(reservation, { verifiedNonExposure: true, detail: 'Withdrawn before any export; the sealed bytes were never opened.' });
  assert.equal(released.state, 'RELEASED');
  assert.equal(f.custody.spent(f.holdout.id, reservation.period).used, 0, 'a verified withdrawal returns the allowance');

  // Once the bytes have moved there is nothing left to release.
  const { reservation: second } = f.custody.reserve(reserveRequest(f.holdout));
  const exported = f.custody.exportPackage(second, f.holdout);
  assert.throws(() => f.custody.release(exported.reservation, { verifiedNonExposure: true, detail: 'we think nobody looked' }),
    /the bytes have already moved and the allowance is spent/);
});

test('an edited or truncated journal makes every holdout it covers unusable', t => {
  const f = fixture(t);
  const { reservation } = f.custody.reserve(reserveRequest(f.holdout));
  f.custody.exportPackage(reservation, f.holdout);

  const lines = readFileSync(f.paths.journalFile, 'utf8').trim().split('\n');
  // Removing the exposure entry is the exact edit that would return a spent allowance.
  writeFileSync(f.paths.journalFile, lines[0] + '\n' + lines[1].replace('EXPORTED', 'RELEASED') + '\n');
  assert.throws(() => f.custody.journal(), /does not match its own hash/);
  assert.throws(() => f.custody.spent(f.holdout.id, reservation.period), /does not match its own hash/);

  writeFileSync(f.paths.journalFile, lines[1] + '\n');
  assert.throws(() => f.custody.journal(), /out of order|chain breaks/);
});
