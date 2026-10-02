import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { downgradeWorkspaceToV3, OfficeStore, sha256 } from '../src/core/store.js';

/** Same account-observation shape bench-store.ts drives the event log with. */
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 7, 12, 0, 0) + minutes * 60000).toISOString();
const observation = (i: number) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: 'Account sign-in verified.',
  toolVersion: '2.1.236',
  transport: 'NONE' as const,
  environment: '',
  models: [{ id: 'model-0', name: 'Model 0' }],
  operations: [
    {
      operation: 'ACCOUNT_STATUS' as const,
      level: 'ACCOUNT_VERIFIED' as const,
      detail: 'Signed in.',
      evidence: 'OBSERVED' as const,
      verifiedAt: at(i * 10),
    },
    {
      operation: 'CLOUD_SUBMIT' as const,
      level: 'DOCUMENTED' as const,
      detail: 'Not verified for this account.',
      evidence: 'DOCUMENTED' as const,
      verifiedAt: at(i * 10),
    },
  ],
  // Alternating source keeps each poll non-redundant, so every call appends one event.
  source: i % 2 ? 'claude auth status' : 'claude auth status (recheck)',
  observedAt: at(i * 10),
});

/**
 * `holder.store` tracks whichever store the test currently has open so the single after-hook can
 * close it before the directory is removed — on Windows an open handle fails the unlink with EBUSY.
 */
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'qro-lr17-'));
  const holder: { store?: OfficeStore } = {};
  t.after(() => {
    try {
      holder.store?.close();
    } catch {
      /* already closed */
    }
    removeTreeSync(directory);
  });
  return { directory, file: join(directory, 'workspace.sqlite'), holder };
}

type CheckpointRow = { sequence: number; event_hash: string; projection_state: string };
function checkpoint(file: string): CheckpointRow | undefined {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare('SELECT sequence,event_hash,projection_state FROM integrity_checkpoint WHERE singleton=1')
      .get() as CheckpointRow | undefined;
  } finally {
    db.close();
  }
}
function tip(file: string): { sequence: number; hash: string } | null {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('SELECT sequence,record FROM events ORDER BY sequence DESC LIMIT 1').get() as
      { sequence: number; record: string } | undefined;
    return row ? { sequence: Number(row.sequence), hash: JSON.parse(row.record).hash as string } : null;
  } finally {
    db.close();
  }
}
/** Tamper precedent from core.test.ts: the append-only trigger is dropped, mutated, then recreated. */
function mutateEvent(file: string, sequence: number, mutate: (record: Record<string, unknown>) => void) {
  const db = new DatabaseSync(file);
  try {
    db.exec('DROP TRIGGER events_no_update');
    const row = db.prepare('SELECT record FROM events WHERE sequence=?').get(sequence) as { record: string };
    const record = JSON.parse(String(row.record)) as Record<string, unknown>;
    mutate(record);
    db.prepare('UPDATE events SET record=? WHERE sequence=?').run(JSON.stringify(record), sequence);
    db.exec(
      "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are immutable'); END",
    );
  } finally {
    db.close();
  }
}

test('checkpoint is written after the first full verification', async t => {
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  holder.store.recordAccountObservation(observation(0));
  holder.store.recordAccountObservation(observation(1));
  holder.store.close();
  // The migration's full verification already recorded a checkpoint (at tip 0).
  assert.ok(checkpoint(file));
  holder.store = new OfficeStore(file);
  await holder.store.verifyInBackground();
  const tipRow = tip(file);
  const cp = checkpoint(file)!;
  assert.equal(cp.sequence, tipRow!.sequence);
  assert.equal(cp.event_hash, tipRow!.hash);
});

test('open succeeds on the fast path and a completed background verify advances the checkpoint', async t => {
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  holder.store.recordAccountObservation(observation(0));
  holder.store.recordAccountObservation(observation(1));
  holder.store.close();
  holder.store = new OfficeStore(file);
  await holder.store.verifyInBackground();
  const verified = checkpoint(file)!;
  assert.equal(verified.sequence, tip(file)!.sequence);
  // One more event lands after the checkpoint; the store closes without a verification.
  holder.store.recordAccountObservation(observation(2));
  holder.store.close();
  holder.store = new OfficeStore(file);
  // Read synchronously: the scheduled background verify has not run yet, so the checkpoint still
  // certifies only the older tip.
  assert.equal(checkpoint(file)!.sequence, verified.sequence);
  await holder.store.verifyInBackground();
  assert.equal(checkpoint(file)!.sequence, tip(file)!.sequence);
});

test('a tampered tail event fails open', async t => {
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  holder.store.recordAccountObservation(observation(0));
  holder.store.recordAccountObservation(observation(1));
  await holder.store.verifyInBackground();
  holder.store.close();
  const latest = tip(file)!;
  mutateEvent(file, latest.sequence, record => {
    record.hash = sha256('tampered record bytes');
  });
  assert.throws(() => new OfficeStore(file), /integrity/i);
});

test('a tampered prefix row passes the fast open but fails the background verify', async t => {
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  holder.store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Checkpoint scope',
    mandate: 'm',
    budgetCents: 0,
  });
  holder.store.recordAccountObservation(observation(0));
  await holder.store.verifyInBackground();
  holder.store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec('DELETE FROM commands WHERE event_sequence=(SELECT MIN(event_sequence) FROM commands)');
  } finally {
    db.close();
  }
  // The prefix event's missing receipt is only found by a full scan: the tail replay opens cleanly.
  holder.store = new OfficeStore(file);
  await assert.rejects(holder.store.verifyInBackground(), /receipt integrity/);
});

test('downgrade accepts a v6 workspace', async t => {
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  holder.store.recordAccountObservation(observation(0));
  await holder.store.verifyInBackground();
  holder.store.close();
  const backup = downgradeWorkspaceToV3(file);
  assert.ok(backup.length > 0);
  const db = new DatabaseSync(file);
  try {
    assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 3);
    assert.equal(
      Number(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='integrity_checkpoint'")
            .get() as { n: number }
        ).n,
      ),
      0,
    );
  } finally {
    db.close();
  }
});

test('the background verification pages through the history and advances the checkpoint at every page boundary', async t => {
  // A page is 25 events, so check the lengths on both sides of each boundary.
  for (const events of [1, 24, 25, 26, 50, 51]) {
    const { file, holder } = fixture(t);
    holder.store = new OfficeStore(file);
    for (let i = 0; i < events; i++) holder.store.recordAccountObservation(observation(i));
    holder.store.close();
    assert.equal(tip(file)!.sequence, events, `${events} events were recorded`);
    holder.store = new OfficeStore(file);
    await holder.store.verifyInBackground();
    assert.equal(checkpoint(file)!.sequence, events, `checkpoint after ${events} events`);
  }
});

test('a tampered event on a later page is reported at its own sequence', async t => {
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  for (let i = 0; i < 60; i++) holder.store.recordAccountObservation(observation(i));
  await holder.store.verifyInBackground();
  holder.store.close();
  mutateEvent(file, 40, record => {
    record.hash = sha256('tampered record bytes');
  });
  // The checkpoint already covers sequence 40, so the tail replay opens cleanly; only the full scan finds it.
  holder.store = new OfficeStore(file);
  await assert.rejects(holder.store.verifyInBackground(), /hash chain integrity failure at sequence 40/);
});

test('an event that lands mid-scan no longer leaves the checkpoint behind: the pass reads it and finishes', async t => {
  // Opening the office records account checks while the background verification runs. A pass that
  // gave up on a moved tip left the checkpoint behind on every launch, so each open replayed more.
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  for (let i = 0; i < 60; i++) holder.store.recordAccountObservation(observation(i));
  holder.store.close();
  holder.store = new OfficeStore(file);
  // The pass reads its first page synchronously and then yields; the new event lands in that yield.
  const pass = holder.store.verifyInBackground();
  holder.store.recordAccountObservation(observation(60));
  await pass;
  assert.equal(tip(file)!.sequence, 61);
  assert.equal(checkpoint(file)!.sequence, 61);
  // The next open replays nothing past the checkpoint.
  holder.store.close();
  holder.store = new OfficeStore(file);
  assert.equal(checkpoint(file)!.sequence, 61);
});

test('a delayed background verification starts later and still advances the checkpoint', async t => {
  const { file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  for (let i = 0; i < 3; i++) holder.store.recordAccountObservation(observation(i));
  holder.store.close();
  const before = checkpoint(file)!.sequence;
  holder.store = new OfficeStore(file, { backgroundVerifyDelayMs: 150 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(checkpoint(file)!.sequence, before, 'nothing has run yet');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(checkpoint(file)!.sequence, 3);
});
