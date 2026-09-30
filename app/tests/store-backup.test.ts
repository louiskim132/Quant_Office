import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore } from '../src/core/store.js';
import { removeTreeSync } from '../src/main/fsx';

const createProject = (store: OfficeStore, name: string) =>
  store.execute({ type: 'project.create', idempotencyKey: randomUUID(), name, mandate: 'm', budgetCents: 0 });

/** Closes whichever store the test has open before the directory is removed (EBUSY on Windows). */
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'qro-store-backup-'));
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

/** Unrelated pages, so a copy needs many steps and writes issued during it land inside the copy. */
const pad = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE test_padding(bytes BLOB); INSERT INTO test_padding VALUES (zeroblob(4194304))');
  } finally {
    db.close();
  }
};

const projectCount = (file: string) => {
  const store = new OfficeStore(file);
  try {
    return store.snapshot().projects.length;
  } finally {
    store.close();
  }
};

// The race is timing-dependent: on an idle machine it rarely fails, and in run 36527457141 it surfaced
// as `Error: not an error` from node:sqlite's async backup. Stress it with QRO_BACKUP_RACE_ROUNDS=200.
const ROUNDS = Number(process.env.QRO_BACKUP_RACE_ROUNDS ?? 40);
const SEED_PROJECTS = 30;

test('a backup that overlaps a write and the background verification never fails and copies the state it started from', async t => {
  const { directory, file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  for (let i = 0; i < SEED_PROJECTS; i++) createProject(holder.store, `Seed ${i}`);
  holder.store.close();
  pad(file);
  // Opening a checkpointed workspace schedules the background verification, whose closing
  // BEGIN IMMEDIATE … COMMIT is a write on the same connection.
  const store = (holder.store = new OfficeStore(file));
  const failures: string[] = [];
  const wrongState: string[] = [];
  const passes: Promise<void>[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const destination = join(directory, `backup-${round}.sqlite`);
    const pending = store.backup(destination);
    createProject(store, `Concurrent ${round}`);
    passes.push(store.verifyInBackground());
    try {
      await pending;
    } catch (error) {
      failures.push(String(error));
      continue;
    }
    // The copy is taken on the calling thread, so the write issued right after backup() is not in it.
    const projects = projectCount(destination);
    if (projects !== SEED_PROJECTS + round) wrongState.push(`round ${round}: ${projects} projects`);
    rmSync(destination);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${ROUNDS} backups failed`);
  assert.deepEqual(wrongState, [], 'a backup is not the state it started from');
  assert.deepEqual(
    (await Promise.allSettled(passes)).filter(result => result.status === 'rejected'),
    [],
  );
});

test('a backup succeeds while the background verification is between pages', async t => {
  const { directory, file, holder } = fixture(t);
  holder.store = new OfficeStore(file);
  // More than two verification pages of events, so the pass yields with a page still to read.
  for (let i = 0; i < 60; i++) createProject(holder.store, `Seed ${i}`);
  holder.store.close();
  const store = (holder.store = new OfficeStore(file));
  // The pass reads its first page synchronously and then yields. SQLite refuses VACUUM while any
  // statement is mid-step on the connection, so the pass must not hold a cursor across the yield.
  const pass = store.verifyInBackground();
  const destination = join(directory, 'between-pages.sqlite');
  await store.backup(destination);
  await pass;
  assert.equal(projectCount(destination), 60);
});

test('a backup never overwrites an existing file', async t => {
  const { directory, file, holder } = fixture(t);
  const store = (holder.store = new OfficeStore(file));
  createProject(store, 'Existing destination');
  const destination = join(directory, 'taken.sqlite');
  writeFileSync(destination, 'not a workspace');
  await assert.rejects(store.backup(destination), /already exists/);
  assert.equal(readFileSync(destination, 'utf8'), 'not a workspace');
});
