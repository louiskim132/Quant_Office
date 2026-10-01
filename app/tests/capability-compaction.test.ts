import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore, SCHEMA_VERSION, downgradeWorkspaceToV3 } from '../src/core/store';
import { canonical } from '../src/core/canonical';
import { currentConnection, latestCapability } from '../src/shared/readiness';
import type { Provider } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 7, 12, 0, 0) + minutes * 60000).toISOString();
const models = Array.from({ length: 400 }, (_, i) => ({
  id: `model-${i}`,
  name: `Model ${i} with a long display name for size`,
}));
function observation(i: number, catalog: { id: string; name: string }[] = models) {
  return {
    provider: 'claude' as Provider,
    identity: 'researcher@example.com',
    credentialContext: 'claude-code-cli',
    state: 'SIGNED_IN' as const,
    allowance: [],
    note: 'Account sign-in verified.',
    toolVersion: '2.1.236',
    transport: 'NONE' as const,
    environment: '',
    models: catalog,
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
    // Alternating sources change the content hash, so every observation records a new snapshot.
    source: i % 2 ? 'claude auth status' : 'claude auth status (recheck)',
    observedAt: at(i * 10),
  };
}
const read = <T>(file: string, sql: string): T => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).get() as T;
  } finally {
    db.close();
  }
};
const projectionBytes = (file: string) =>
  Number(read<{ n: number }>(file, 'SELECT length(state) AS n FROM projection').n);
const userVersion = (file: string) => Number(read<{ user_version: number }>(file, 'PRAGMA user_version').user_version);
/** One hash over every event record, in order — proves the permanent history is byte-identical. */
const historyHash = (file: string) => {
  const db = new DatabaseSync(file);
  try {
    const hash = createHash('sha256');
    for (const row of db.prepare('SELECT record FROM events ORDER BY sequence').all()) hash.update(String(row.record));
    return hash.digest('hex');
  } finally {
    db.close();
  }
};
const workspace = (name: string) => path.join(mkdtempSync(path.join(tmpdir(), `qro-lr6-${name}-`)), 'workspace.sqlite');

test('LR-6: the projection keeps one model catalog per connection and marks older snapshots', t => {
  const file = workspace('compact');
  let store = new OfficeStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  });
  for (let i = 0; i < 200; i++) store.recordAccountObservation(observation(i));
  const state = store.snapshot({ history: false });
  const connection = currentConnection(state, 'claude')!;
  const snapshots = (state.capabilities ?? []).filter(item => item.connectionId === connection.id);
  assert.equal(snapshots.length, 200, 'every snapshot is still recorded');
  assert.equal(latestCapability(state, connection.id)!.models.length, 400, 'the newest snapshot keeps its catalog');
  assert.equal(latestCapability(state, connection.id)!.modelsOmitted, undefined, 'the newest snapshot is not marked');
  assert.equal(
    snapshots.filter(item => item.modelsOmitted === true && item.models.length === 0).length,
    199,
    'older snapshots are marked omitted',
  );
  assert.ok(projectionBytes(file) < 1_000_000, `projection is ${projectionBytes(file)} bytes`);
  assert.equal(userVersion(file), SCHEMA_VERSION);
  store.close();
  store = new OfficeStore(file); // reopening replays and verifies the whole event log
  assert.equal(latestCapability(store.snapshot({ history: false }), connection.id)!.models.length, 400);
});

test('LR-6: a genuinely empty catalog on the newest snapshot is not marked omitted', t => {
  const file = workspace('empty');
  const store = new OfficeStore(file);
  t.after(() => store.close());
  store.recordAccountObservation(observation(0));
  const state = store.recordAccountObservation(observation(1, []));
  const latest = latestCapability(state, currentConnection(state, 'claude')!.id)!;
  assert.deepEqual(latest.models, []);
  assert.equal(latest.modelsOmitted, undefined, 'an empty list the provider reported is not an omission');
});

test('LR-6: a version-3 workspace migrates once, keeps its history byte-identical and leaves a backup', t => {
  const file = workspace('migrate');
  let store = new OfficeStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  });
  for (let i = 0; i < 3; i++) store.recordAccountObservation(observation(i));
  store.close();
  // Recreate what a version-3 build wrote: the full catalog on every snapshot, no markers.
  const db = new DatabaseSync(file);
  const state = JSON.parse(
    String((db.prepare('SELECT state FROM projection WHERE singleton=1').get() as { state: string }).state),
  );
  for (const snapshot of state.capabilities) {
    snapshot.models = models;
    delete snapshot.modelsOmitted;
  }
  db.prepare('UPDATE projection SET state=? WHERE singleton=1').run(canonical(state));
  db.exec('PRAGMA user_version=3');
  db.close();
  const before = historyHash(file);
  store = new OfficeStore(file);
  assert.equal(
    (store.snapshot({ history: false }).capabilities ?? []).filter(item => item.modelsOmitted).length,
    2,
    'the migration compacted the old projection',
  );
  store.close();
  assert.equal(userVersion(file), SCHEMA_VERSION);
  assert.equal(historyHash(file), before, 'the permanent history is byte-identical');
  const backups = readdirSync(path.dirname(file)).filter(name => name.includes(`.before-v${SCHEMA_VERSION}-`));
  assert.equal(backups.length, 1, 'one pre-migration copy was written');
  assert.equal(userVersion(path.join(path.dirname(file), backups[0])), 3, 'the copy is the untouched version-3 file');
  store = new OfficeStore(file); // a second open does not migrate again
  store.close();
  assert.equal(
    readdirSync(path.dirname(file)).filter(name => name.includes('.before-v')).length,
    1,
    'running twice does not migrate or back up again',
  );
  assert.equal(historyHash(file), before);
});

test('LR-6: downgradeWorkspaceToV3 restores the old format losslessly, including records made after the upgrade', t => {
  const file = workspace('downgrade');
  let store = new OfficeStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  });
  for (let i = 0; i < 4; i++) store.recordAccountObservation(observation(i));
  store.close();
  const before = historyHash(file);
  const backup = downgradeWorkspaceToV3(file);
  assert.ok(existsSync(backup), 'the downgrade copied the file first');
  assert.equal(userVersion(file), 3);
  assert.equal(historyHash(file), before, 'the permanent history is untouched');
  const state = JSON.parse(
    String(read<{ state: string }>(file, 'SELECT state FROM projection WHERE singleton=1').state),
  );
  assert.ok(
    state.capabilities.every(
      (item: { models: unknown[]; modelsOmitted?: true }) =>
        item.models.length === 400 && item.modelsOmitted === undefined,
    ),
    'every snapshot has its catalog again',
  );
  store = new OfficeStore(file); // the current build upgrades it again
  assert.equal(userVersion(file), SCHEMA_VERSION);
  assert.equal(historyHash(file), before);
});

test('B2b: the window-facing projection retains current-version evidence and assignment-cited snapshots', t => {
  const file = workspace('window-capabilities');
  const store = new OfficeStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  });
  for (let i = 0; i < 5; i++) store.recordAccountObservation(observation(i));
  const state = store.snapshot({ history: false });
  assert.equal((state.capabilities ?? []).length, 5, 'the store still holds the full history');

  const windowed = OfficeStore.publicState(state);
  assert.equal((windowed.capabilities ?? []).length, 1, 'superseded entries of the same scope and rank can be omitted');
  const connection = currentConnection(state, 'claude')!;
  assert.equal(
    windowed.capabilities!.at(-1)!.id,
    latestCapability(state, connection.id)!.id,
    'the window snapshot is the newest',
  );

  const cited = state.capabilities![1];
  const assignment = {
    id: 'assign-1',
    projectId: 'proj-1',
    requestId: 'req-1',
    requestRevision: 1,
    agentId: 'agent-1',
    agentRevision: 1,
    connectionId: connection.id,
    capabilitySnapshotId: cited.id,
    snapshotId: 'snap-1',
    route: 'LOCAL_MAILBOX',
    requestedModel: 'model-1',
    resolvedModel: 'model-1',
    requestedEffort: 'default',
    appliedEffort: 'default',
    delegation: false,
    objectiveHash: 'hash-1',
    createdAt: at(0),
  } as import('../src/shared/types').Assignment;
  const withCited = OfficeStore.publicState({ ...state, assignments: [assignment] });
  assert.equal((withCited.capabilities ?? []).length, 2, 'a cited snapshot survives the trim');
  assert.ok(
    withCited.capabilities!.some(item => item.id === cited.id),
    'the cited snapshot is the one retained',
  );

  const internal = store.snapshot({ history: false });
  assert.equal((internal.capabilities ?? []).length, 5, 'the internal projection is unchanged');
});
