import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { strToU8 } from 'fflate';
import { HoldoutCustody, type CustodyPaths } from '../src/main/holdout.js';
import {
  UNSEAL_REQUIRED_GATES,
  type CustodyCapability,
  type EvaluatorInput,
  type Holdout,
  type IsolatedEvaluator,
} from '../src/shared/holdout.js';
import { OfficeStore } from '../src/core/store.js';
import { ArtifactService } from '../src/main/artifacts.js';
import { EvidenceService } from '../src/main/evidence.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const at = (minutes: number) => new Date(Date.UTC(2024, 0, 15, 0, minutes)).toISOString();
const SUPPORTED: CustodyCapability = {
  sealedStorageSupported: true,
  isolatedEvaluatorSupported: true,
  detail: 'fake isolated custody',
};
const passingGates = () => UNSEAL_REQUIRED_GATES.map(gate => ({ gate, outcome: 'PASS' as const }));

class FakeEvaluator implements IsolatedEvaluator {
  readonly isolated = true as const;
  async evaluate(input: EvaluatorInput) {
    return {
      reportHash: sha256('report:' + input.candidateHash),
      metric: 'RANK_IC',
      value: 0.01,
      samples: input.predictions.length,
      detail: 'fixture',
    };
  }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-holdout-recovery-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const paths: CustodyPaths = {
    sealedRoot: path.join(root, 'holdout-sealed'),
    journalFile: path.join(root, 'exposure-journal.jsonl'),
  };
  t.after(() => removeTreeSync(root));
  let tick = 0;
  const custody = () => new HoldoutCustody(paths, SUPPORTED, new FakeEvaluator(), () => at(++tick));
  const first = custody();
  const sealed = first.seal(strToU8('rowId,target\nh1,0.02\n'));
  const holdout: Holdout = {
    id: randomUUID(),
    projectId: randomUUID(),
    name: 'Final holdout',
    sealedHash: sealed.sealedHash,
    sealedBytes: sealed.sealedBytes,
    periodPolicy: 'CALENDAR_QUARTER',
    timezoneOffsetMinutes: 0,
    allowancePerPeriod: 1,
    createdAt: at(0),
  };
  return { root, workspace, paths, custody, first, holdout };
}
const reserveRequest = (holdout: Holdout) => ({
  holdout,
  lineageId: randomUUID(),
  branchId: randomUUID(),
  candidateHash: sha256('candidate'),
  refitHash: sha256('refit'),
  gates: passingGates(),
  adjudication: 'UPHELD' as const,
});

test('restoring an older workspace cannot un-spend a holdout', t => {
  const f = fixture(t);
  const { reservation } = f.first.reserve(reserveRequest(f.holdout));
  f.first.exportPackage(reservation, f.holdout);
  assert.equal(f.first.spent(f.holdout.id, reservation.period).used, 1);

  // The restored database has no idea this reservation ever happened; the journal does, and the
  // journal is what decides. The alternative is handing back an allowance a run already spent.
  const reconciled = f.custody().reconcileAfterRestore([]);
  assert.deepEqual(reconciled.unknown, [reservation.id]);
  assert.match(reconciled.entries[0].detail, /Treated as spent and of unknown exposure/);

  const after = f.custody().spent(f.holdout.id, reservation.period);
  assert.equal(after.used, 1);
  assert.equal(after.unknown, 1);
  assert.throws(
    () => f.custody().reserve(reserveRequest(f.holdout)),
    /unknown exposure after a restore. Reuse is blocked until a person settles them/,
  );
});

test('a workspace that still knows its reservations reconciles to nothing', t => {
  const f = fixture(t);
  const { reservation } = f.first.reserve(reserveRequest(f.holdout));
  const reconciled = f.custody().reconcileAfterRestore([reservation.id]);
  assert.deepEqual(reconciled.unknown, []);
  assert.equal(f.custody().journal().length, 1, 'reconciliation writes nothing when nothing is missing');
});

test('a released reservation stays released across a restore rather than becoming unknown', t => {
  const f = fixture(t);
  const { reservation } = f.first.reserve(reserveRequest(f.holdout));
  f.first.release(reservation, {
    verifiedNonExposure: true,
    detail: 'Withdrawn before export; the sealed bytes were never opened.',
  });
  const reconciled = f.custody().reconcileAfterRestore([]);
  assert.deepEqual(reconciled.unknown, []);
  assert.equal(f.custody().spent(f.holdout.id, reservation.period).used, 0);
});

test('a crash after export is still exposure when the journal is read back by a new process', t => {
  const f = fixture(t);
  const { reservation } = f.first.reserve(reserveRequest(f.holdout));
  f.first.exportPackage(reservation, f.holdout);
  // Nothing in memory survives; a fresh custody object reads only the file on disk.
  const restarted = f.custody();
  assert.deepEqual(
    restarted.journal().map(entry => entry.kind),
    ['RESERVED', 'EXPORTED'],
  );
  assert.equal(restarted.spent(f.holdout.id, reservation.period).used, 1);
  assert.throws(() => restarted.reserve(reserveRequest(f.holdout)), /allowance of 1 is already spent/);
});

test('a journal rolled back to an earlier copy is detected rather than believed', t => {
  const f = fixture(t);
  const { reservation: first } = f.first.reserve(reserveRequest({ ...f.holdout, allowancePerPeriod: 2 }));
  const snapshot = path.join(f.root, 'journal-backup.jsonl');
  copyFileSync(f.paths.journalFile, snapshot);
  f.first.exportPackage(first, f.holdout);

  // Restoring the earlier journal loses the export. The chain still verifies, because a prefix of a
  // valid chain is a valid chain — so the office's protection here is that the sealed bytes and the
  // journal live outside the restore path at all, and reconciliation is what catches the difference.
  copyFileSync(snapshot, f.paths.journalFile);
  const rolledBack = f.custody();
  assert.throws(() => rolledBack.journal(), /truncated|checkpoint/);
  assert.throws(() => rolledBack.reconcileAfterRestore([]), /truncated|checkpoint/);
  assert.throws(() => rolledBack.spent(f.holdout.id, first.period), /truncated|checkpoint/);
});

test('sealed holdout bytes never enter a workspace backup, an export or the evidence index', async t => {
  const f = fixture(t);
  // The database lives in its own directory: the fixture's cleanup runs first, and an open SQLite
  // handle inside it would make that removal fail on Windows.
  const database = mkdtempSync(path.join(tmpdir(), 'qro-holdout-db-'));
  const store = new OfficeStore(path.join(database, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    removeTreeSync(database);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const artifacts = new ArtifactService(store, f.workspace);
  const evidence = new EvidenceService(store, f.workspace);

  // An ordinary artifact so the backup has something to carry, and an agent that could read it.
  const body = 'row 0 ordinary\n';
  const hash = sha256(body);
  const objectFile = path.join(f.workspace, 'objects', hash.slice(0, 2), hash);
  mkdirSync(path.dirname(objectFile), { recursive: true });
  writeFileSync(objectFile, strToU8(body));
  store.addArtifact({
    id: randomUUID(),
    projectId: project.id,
    experimentId: null,
    name: 'notes.log',
    sha256: hash,
    size: body.length,
    kind: 'RESULT',
    classification: 'USER_ATTESTED',
    status: 'QUARANTINED',
    createdAt: at(0),
    mediaType: 'text/plain',
    note: 'fixture',
  });

  const backup = path.join(f.root, 'backup.zip');
  await artifacts.backup(backup);
  const archive = readFileSync(backup).toString('latin1');
  assert.equal(archive.includes(f.holdout.sealedHash), false, 'the sealed holdout is not named anywhere in a backup');
  assert.equal(
    existsSync(path.join(f.workspace, 'objects', f.holdout.sealedHash.slice(0, 2), f.holdout.sealedHash)),
    false,
  );

  // The evidence layer addresses only the workspace object store, so the sealed hash resolves to
  // nothing there however it is asked for.
  assert.equal(await evidence.bytes(f.holdout.sealedHash), null);
  assert.equal([...evidence.manifest().keys()].includes(f.holdout.sealedHash), false);
  assert.equal(HoldoutCustody.separationBlocker(f.paths, f.workspace), null);
});
