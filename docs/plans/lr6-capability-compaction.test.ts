import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore } from '../src/core/store';
import { canonical } from '../src/core/canonical';
import { currentConnection, latestCapability } from '../src/shared/readiness';
import type { Provider } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 7, 12, 0, 0) + minutes * 60000).toISOString();
const models = Array.from({ length: 400 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i} with a long display name for size` }));
function observation(i: number) {
  return {
    provider: 'claude' as Provider, identity: 'researcher@example.com', credentialContext: 'claude-code-cli', state: 'SIGNED_IN' as const,
    allowance: [], note: 'Account sign-in verified.', toolVersion: '2.1.236', transport: 'NONE' as const, environment: '', models,
    operations: [
      { operation: 'ACCOUNT_STATUS' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Signed in.', evidence: 'OBSERVED' as const, verifiedAt: at(i * 10) },
      { operation: 'CLOUD_SUBMIT' as const, level: 'DOCUMENTED' as const, detail: 'Not verified for this account.', evidence: 'DOCUMENTED' as const, verifiedAt: at(i * 10) },
    ],
    // Alternating sources change the content hash, so every observation records a new snapshot.
    source: i % 2 ? 'claude auth status' : 'claude auth status (recheck)', observedAt: at(i * 10),
  };
}
const projectionBytes = (file: string) => {
  const db = new DatabaseSync(file);
  try { return Number((db.prepare('SELECT length(state) AS n FROM projection').get() as { n: number }).n); } finally { db.close(); }
};

test('repeated capability snapshots keep one model catalog per connection in the projection', t => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'qro-capability-compaction-')), 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  for (let i = 0; i < 200; i++) store.recordAccountObservation(observation(i));
  const state = store.snapshot({ history: false });
  const connection = currentConnection(state, 'claude')!;
  const snapshots = (state.capabilities ?? []).filter(item => item.connectionId === connection.id);
  assert.equal(snapshots.length, 200, 'every snapshot is still recorded');
  assert.equal(latestCapability(state, connection.id)!.models.length, 400, 'the latest snapshot keeps its catalog');
  assert.equal(snapshots.filter(item => item.models.length > 0).length, 1, 'older snapshots drop their catalog from the projection');
  const bytes = projectionBytes(file);
  assert.ok(bytes < 1_000_000, `projection is ${bytes} bytes`);
  store.close();
  store = new OfficeStore(file); // reopening replays the event log through the same reducer
  assert.equal(latestCapability(store.snapshot({ history: false }), connection.id)!.models.length, 400);
});

test('a version-3 workspace whose projection still carries every catalog migrates to version 4 on open', t => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'qro-capability-migration-')), 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  for (let i = 0; i < 3; i++) store.recordAccountObservation(observation(i));
  store.close();
  // Recreate what a version-3 build wrote: the full catalog on every snapshot.
  const db = new DatabaseSync(file);
  const state = JSON.parse(String((db.prepare('SELECT state FROM projection WHERE singleton=1').get() as { state: string }).state));
  for (const snapshot of state.capabilities) snapshot.models = models;
  db.prepare('UPDATE projection SET state=? WHERE singleton=1').run(canonical(state));
  db.exec('PRAGMA user_version=3');
  db.close();
  store = new OfficeStore(file);
  const migrated = store.snapshot({ history: false });
  assert.equal((migrated.capabilities ?? []).filter(item => item.models.length > 0).length, 1, 'the migration compacted the old projection');
  store.close();
  const check = new DatabaseSync(file);
  assert.equal(Number((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 4);
  check.close();
});
