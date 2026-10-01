import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobEvent } from '../src/shared/types';
import { shouldRefreshJobDetail, mergeJobEvents } from '../src/renderer/dispatch';

const at = (minute: number) => `2026-09-25T12:${String(minute).padStart(2, '0')}:00.000Z`;
const ev = (id: string, occurredAt: string): JobEvent => ({
  id,
  jobId: 'j1',
  externalId: `ext-${id}`,
  cursor: '',
  kind: 'STATUS',
  text: `event ${id}`,
  occurredAt,
  receivedAt: occurredAt,
  evidence: 'PROVIDER_REPORTED',
});

test('a live job re-reads its record on every change signal; a settled one does not', () => {
  for (const state of ['INTENT', 'SUBMITTING', 'ACCEPTED', 'RUNNING', 'UNKNOWN', 'CANCEL_REQUESTED'] as const)
    assert.equal(shouldRefreshJobDetail(state), true, `${state} can still gain recorded events`);
  for (const state of ['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'] as const)
    assert.equal(shouldRefreshJobDetail(state), false, `${state} panels are already the final record`);
  assert.equal(shouldRefreshJobDetail(null), false);
  assert.equal(shouldRefreshJobDetail(undefined), false);
});

test('a refresh merges the re-paged prefix without duplicating rows', () => {
  const current = [ev('e1', at(1)), ev('e2', at(2)), ev('e3', at(3))];
  // The store kept the first three and recorded two more while the panel was open.
  const fresh = [ev('e1', at(1)), ev('e2', at(2)), ev('e3', at(3)), ev('e4', at(4)), ev('e5', at(5))];
  const merged = mergeJobEvents(current, fresh);
  assert.deepEqual(
    merged.map(e => e.id),
    ['e1', 'e2', 'e3', 'e4', 'e5'],
    'newly recorded entries appear once — the running job updates without re-selection',
  );
  // The identical refresh a second time is a no-op, not a second copy.
  assert.deepEqual(
    mergeJobEvents(merged, fresh).map(e => e.id),
    ['e1', 'e2', 'e3', 'e4', 'e5'],
  );
});

test('a late event carrying an earlier occurred_at lands at its recorded position', () => {
  const current = [ev('e1', at(1)), ev('e3', at(3))];
  const fresh = [ev('e1', at(1)), ev('e2', at(2)), ev('e3', at(3))];
  assert.deepEqual(
    mergeJobEvents(current, fresh).map(e => e.id),
    ['e1', 'e2', 'e3'],
    'occurred_at order decides placement — refresh never appends a backdated record at the tail',
  );
});

test('rows the user already paged beyond the refetch window survive a refresh', () => {
  const current = [ev('e1', at(1)), ev('e2', at(2)), ev('e3', at(3)), ev('e4', at(4))];
  // A prefix refresh only re-fetched the first two rows; the rest of the loaded list stays.
  const fresh = [ev('e1', at(1)), ev('e2', at(2))];
  assert.deepEqual(
    mergeJobEvents(current, fresh).map(e => e.id),
    ['e1', 'e2', 'e3', 'e4'],
  );
  assert.deepEqual(
    mergeJobEvents([], fresh).map(e => e.id),
    ['e1', 'e2'],
  );
});
