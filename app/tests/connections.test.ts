import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { providerReadiness, currentConnection, latestCapability } from '../src/shared/readiness';
import type { Provider } from '../src/shared/types';

function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-connections-')),
    file = path.join(root, 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => store.close());
  return {
    file,
    store,
    reopen() {
      store.close();
      store = new OfficeStore(file);
      return store;
    },
  };
}
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 7, 12, 0, 0) + minutes * 60000).toISOString();
function observation(overrides: Record<string, unknown> = {}) {
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
    models: [{ id: 'opus', name: 'Opus (Claude Code alias)' }],
    operations: [
      {
        operation: 'ACCOUNT_STATUS' as const,
        level: 'ACCOUNT_VERIFIED' as const,
        detail: 'Signed in.',
        evidence: 'OBSERVED' as const,
        verifiedAt: at(0),
      },
      {
        operation: 'CLOUD_SUBMIT' as const,
        level: 'DOCUMENTED' as const,
        detail: 'Not verified for this account.',
        evidence: 'DOCUMENTED' as const,
        verifiedAt: at(0),
      },
    ],
    source: 'claude auth status',
    observedAt: at(0),
    ...overrides,
  };
}

test('an account observation is durable, survives restart, and keeps its source', t => {
  const f = fixture(t);
  const state = f.store.recordAccountObservation(observation());
  const connection = currentConnection(state, 'claude')!;
  assert.equal(connection.identity, 'researcher@example.com');
  assert.equal(connection.revision, 1);
  assert.equal(connection.firstSeenAt, at(0));
  const snapshot = latestCapability(state, connection.id)!;
  assert.equal(snapshot.toolVersion, '2.1.236');
  assert.equal(snapshot.source, 'claude auth status');
  const reopened = f.reopen().snapshot();
  assert.deepEqual(currentConnection(reopened, 'claude'), connection);
  assert.deepEqual(latestCapability(reopened, connection.id), snapshot);
});

test('sign-in and usage success alone never make a provider ready', t => {
  const f = fixture(t);
  const state = f.store.recordAccountObservation(
    observation({
      allowance: [{ label: 'Weekly', remainingPercent: 80, resetsAt: 1 }],
      operations: [
        {
          operation: 'ACCOUNT_STATUS',
          level: 'ACCOUNT_VERIFIED',
          detail: 'Signed in.',
          evidence: 'OBSERVED',
          verifiedAt: at(0),
        },
        {
          operation: 'ALLOWANCE_READ',
          level: 'ACCOUNT_VERIFIED',
          detail: 'Windows read.',
          evidence: 'OBSERVED',
          verifiedAt: at(0),
        },
        {
          operation: 'MODEL_CATALOG',
          level: 'TOOL_SUPPORTED',
          detail: 'Aliases only.',
          evidence: 'DOCUMENTED',
          verifiedAt: at(0),
        },
        {
          operation: 'CLOUD_SUBMIT',
          level: 'DOCUMENTED',
          detail: 'Unverified.',
          evidence: 'DOCUMENTED',
          verifiedAt: at(0),
        },
      ],
    }),
  );
  const readiness = providerReadiness(state, 'claude', { now: Date.parse(at(0)) });
  assert.equal(readiness.signedIn, true);
  assert.equal(readiness.modelChecked, false);
  assert.equal(readiness.dispatchChecked, false);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some(b => b.includes('Unverified cloud submission')));
  assert.equal(readiness.actions.automaticStart, false);
  assert.equal(readiness.actions.prepare, true, 'local preparation never depends on cloud evidence');
  assert.equal(
    providerReadiness(state, 'openai', { now: Date.parse(at(0)) }).blockers[0],
    'No account check has been recorded for this provider yet.',
  );
});

test('unchanged refreshes do not grow history; a changed catalog adds a new immutable snapshot', t => {
  const f = fixture(t);
  f.store.recordAccountObservation(observation());
  const before = f.store.snapshot().events.length;
  f.store.recordAccountObservation(observation({ observedAt: at(1) }));
  assert.equal(f.store.snapshot().events.length, before, 'an identical poll must not append an event');
  const later = f.store.recordAccountObservation(observation({ observedAt: at(10) }));
  assert.equal(later.events.length, before + 1, 'a stale check is refreshed after the quiet window');
  assert.equal(later.capabilities!.length, 1, 'unchanged capabilities are not duplicated');
  const changed = f.store.recordAccountObservation(
    observation({
      observedAt: at(20),
      models: [
        { id: 'opus', name: 'Opus (Claude Code alias)' },
        { id: 'sonnet', name: 'Sonnet (Claude Code alias)' },
      ],
    }),
  );
  assert.equal(changed.capabilities!.length, 2);
  assert.notEqual(changed.capabilities![0].contentHash, changed.capabilities![1].contentHash);
  assert.equal(changed.capabilities![0].models.length, 1, 'earlier evidence is never rewritten');
  assert.equal(
    currentConnection(changed, 'claude')!.revision,
    1,
    'identity did not change, so the connection revision holds',
  );
});

test('an account switch keeps the previous connection and its evidence', t => {
  const f = fixture(t);
  f.store.recordAccountObservation(observation());
  const state = f.store.recordAccountObservation(observation({ identity: 'second@example.com', observedAt: at(30) }));
  assert.equal(state.connections!.length, 2);
  assert.equal(state.capabilities!.length, 2);
  assert.equal(currentConnection(state, 'claude')!.identity, 'second@example.com');
  const first = state.connections!.find(c => c.identity === 'researcher@example.com')!;
  assert.equal(first.lastCheckedAt, at(0), 'the earlier account keeps its own last check');
  assert.equal(latestCapability(state, first.id)!.identity, 'researcher@example.com');
});

test('expired authentication is recorded as signed out without discarding the account history', t => {
  const f = fixture(t);
  f.store.recordAccountObservation(observation());
  const state = f.store.recordAccountObservation(
    observation({
      state: 'SIGNED_OUT',
      note: 'Sign in through Claude Code with a Claude subscription.',
      observedAt: at(2),
    }),
  );
  const connection = currentConnection(state, 'claude')!;
  assert.equal(connection.state, 'SIGNED_OUT');
  assert.equal(connection.revision, 2);
  assert.equal(connection.firstSeenAt, at(0));
  assert.equal(providerReadiness(state, 'claude', { now: Date.parse(at(2)) }).ready, false);
  assert.equal(state.capabilities!.length, 1, 'a sign-out does not invent new capability evidence');
});

test('observations reject secrets, unknown fields and impossible values', t => {
  const f = fixture(t);
  assert.throws(
    () => f.store.recordAccountObservation(observation({ note: 'token sk-ant-api03-abcdefghijklmnop' })),
    /credential/i,
  );
  assert.throws(
    () => f.store.recordAccountObservation(observation({ source: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload' })),
    /credential/i,
  );
  assert.throws(() => f.store.recordAccountObservation(observation({ refreshToken: 'abc' })));
  assert.throws(() => f.store.recordAccountObservation(observation({ provider: 'anthropic-api' })));
  assert.throws(() =>
    f.store.recordAccountObservation(
      observation({ operations: [{ operation: 'CLOUD_SUBMIT', level: 'PROBABLY', detail: '' }] }),
    ),
  );
  assert.throws(
    () =>
      f.store.recordAccountObservation(
        observation({
          operations: [
            {
              operation: 'CLOUD_SUBMIT',
              level: 'ACCOUNT_VERIFIED',
              detail: 'Claimed without exercising it.',
              evidence: 'DOCUMENTED',
              verifiedAt: at(0),
            },
          ],
        }),
      ),
    /observed/i,
  );
  assert.throws(() =>
    f.store.recordAccountObservation(
      observation({ allowance: [{ label: 'Weekly', remainingPercent: 140, resetsAt: 1 }] }),
    ),
  );
  assert.equal(f.store.snapshot().connections, undefined, 'a rejected observation records nothing');
});

test('recorded connections replay from events and pass integrity checking', t => {
  const f = fixture(t);
  f.store.recordAccountObservation(observation());
  f.store.recordAccountObservation(observation({ observedAt: at(20), toolVersion: '2.2.0' }));
  const before = f.store.snapshot();
  const reopened = f.reopen().snapshot();
  assert.deepEqual(reopened.connections, before.connections);
  assert.deepEqual(reopened.capabilities, before.capabilities);
  assert.ok(reopened.events.some(e => e.kind === 'PROVIDER_CAPABILITY_OBSERVED'));
  for (const event of reopened.events) assert.equal(typeof event.hash, 'string');
});

test('a workspace backup carries the durable account records', async t => {
  const f = fixture(t);
  f.store.recordAccountObservation(observation());
  const destination = path.join(mkdtempSync(path.join(tmpdir(), 'qro-connections-backup-')), 'copy.sqlite');
  await f.store.backup(destination);
  const copy = new OfficeStore(destination);
  t.after(() => copy.close());
  assert.deepEqual(copy.snapshot().capabilities, f.store.snapshot().capabilities);
  assert.equal(randomUUID().length, 36);
});
