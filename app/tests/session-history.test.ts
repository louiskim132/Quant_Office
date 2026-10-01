import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { LocalSessionRecord } from '../src/shared/local-session';
import { formatDateTime } from '../src/renderer/format';

// agents.tsx imports its stylesheet for the bundler; Node can't load .css, so the unit-level
// import stubs it — the same trick request-form.test.ts uses for main.tsx.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { sessionHistoryRows, shortPacketHash, sessionLifecycleLabel, sessionRowCells } =
  await import('../src/renderer/agents');

const record = (over: Partial<LocalSessionRecord> = {}): LocalSessionRecord => ({
  schemaVersion: 1,
  id: crypto.randomUUID(),
  jobId: crypto.randomUUID(),
  assignmentId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  revision: 1,
  provider: 'claude',
  surface: 'CLAUDE_DESKTOP',
  layout: 'FLAT_PACKET',
  packetVersion: 2,
  packetHash: 'a'.repeat(64),
  storageRelativePath: 'sessions/packet',
  originalCwd: null,
  repoRelativePath: null,
  seedCommit: null,
  worktreeOwner: 'NONE',
  providerSessionId: 'sess-abc-123',
  providerProjectId: null,
  bindingEvidence: 'PROVIDER_OBSERVED',
  groupingStatus: 'OBSERVED',
  requirement: 'SCOPED_DELIVERY',
  confinementStatus: 'VERIFIED',
  confinementEvidenceId: null,
  lifecycle: 'READY',
  archiveRelativePath: null,
  lastReceipt: null,
  cancelRequestId: null,
  stopStatus: 'NOT_REQUESTED',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  ...over,
});

test('sessionHistoryRows lists the newest recorded session first and never mutates the page', () => {
  const oldest = record({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-09-28T08:00:00.000Z' }),
    newest = record({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: '2026-09-30T10:00:00.000Z' }),
    middle = record({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', createdAt: '2026-09-29T09:00:00.000Z' });
  const page = [oldest, newest, middle];
  const sorted = sessionHistoryRows(page);
  assert.deepEqual(
    sorted.map(r => r.id),
    [newest.id, middle.id, oldest.id],
  );
  // Paged appends keep collection order — the helper re-sorts the accumulated list.
  assert.deepEqual(
    page.map(r => r.id),
    [oldest.id, newest.id, middle.id],
  );
  // Identical timestamps fall back to id order so paging is stable.
  const a = record({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-09-30T10:00:00.000Z' });
  const b = record({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: '2026-09-30T10:00:00.000Z' });
  assert.deepEqual(
    sessionHistoryRows([b, a]).map(r => r.id),
    [a.id, b.id],
  );
});

test('shortPacketHash truncates to eight hex characters and renders a dash when none is recorded', () => {
  const hash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  assert.equal(shortPacketHash(hash), 'abcdef01');
  assert.equal(shortPacketHash(null), '—');
});

test('sessionLifecycleLabel renders recorded lifecycles as lowercase words', () => {
  assert.equal(sessionLifecycleLabel('READY'), 'ready');
  assert.equal(sessionLifecycleLabel('RECONCILE_REQUIRED'), 'reconcile required');
  assert.equal(sessionLifecycleLabel('PREPARATION_FAILED'), 'preparation failed');
});

test('sessionRowCells restates only record fields — the office-observed row has no usage cells', () => {
  const cells = sessionRowCells(
    record({
      provider: 'devin',
      lifecycle: 'ARCHIVED',
      surface: 'DEVIN_CLI',
      layout: 'PROJECT_WORKTREE',
      createdAt: '2026-09-30T10:00:00.000Z',
      updatedAt: '2026-09-30T18:45:00.000Z',
    }),
  );
  assert.deepEqual(Object.keys(cells).sort(), [
    'layout',
    'lifecycle',
    'packetHash',
    'provenance',
    'provider',
    'providerSessionId',
    'recorded',
    'surface',
  ]);
  assert.equal(cells.provenance, 'office-observed');
  assert.equal(cells.provider, 'devin');
  assert.equal(cells.lifecycle, 'archived');
  assert.equal(cells.surface, 'devin cli');
  assert.equal(cells.layout, 'project worktree');
  // "Recorded" is the record's creation timestamp in the UI locale, not the last update.
  assert.equal(cells.recorded, formatDateTime('2026-09-30T10:00:00.000Z'));
  assert.notEqual(cells.recorded, formatDateTime('2026-09-30T18:45:00.000Z'));
});

test('sessionRowCells marks an absent packet hash and provider session id as dashes', () => {
  const cells = sessionRowCells(record({ packetHash: null, providerSessionId: null }));
  assert.equal(cells.packetHash, '—');
  assert.equal(cells.providerSessionId, '—');
  const bound = sessionRowCells(record({ providerSessionId: 'devin-run-42' }));
  assert.equal(bound.providerSessionId, 'devin-run-42');
});
