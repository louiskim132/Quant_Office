import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
import { effectiveEvidence, providerReadiness, currentConnection } from '../src/shared/readiness';
import type { CapabilityEvidence, CapabilityOperation, Provider } from '../src/shared/types';

function store(t: any) {
  const s = new OfficeStore(path.join(mkdtempSync(path.join(tmpdir(), 'qro-local-evidence-')), 'workspace.sqlite'));
  t.after(() => s.close());
  return s;
}
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 9, 0, 0) + minutes * 60000).toISOString();
const ms = (minutes: number) => Date.parse(at(minutes));

const LOCAL: CapabilityOperation[] = [
  'LOCAL_SUBMIT',
  'LOCAL_OBSERVE',
  'LOCAL_OUTPUT_FETCH',
  'LOCAL_CANCEL',
  'MODEL_APPLICATION',
  'EFFORT_APPLICATION',
  'DELEGATION_CONTROL',
  'TOOL_CONFINEMENT',
];
/** Evidence the official tool itself exercised during a real account check. */
const seen = (
  operation: CapabilityOperation,
  minutes: number,
  extra: Partial<CapabilityEvidence> = {},
): CapabilityEvidence => ({
  operation,
  level: 'ACCOUNT_VERIFIED',
  detail: 'Exercised by the official tool.',
  evidence: 'OBSERVED',
  verifiedAt: at(minutes),
  source: 'fixture account check',
  ...extra,
});
const unread = (operation: CapabilityOperation, minutes: number): CapabilityEvidence => ({
  operation,
  level: 'UNKNOWN',
  detail: 'Not exercised by this check.',
  evidence: 'DOCUMENTED',
  verifiedAt: at(minutes),
  source: 'fixture account check',
});
/** A plain account observation: sign-in and catalog are real; no transport has been exercised. */
function account(minutes: number, overrides: Record<string, unknown> = {}) {
  return {
    provider: 'devin' as Provider,
    identity: 'devin-user@example.com',
    credentialContext: 'devin-cli',
    state: 'SIGNED_IN' as const,
    allowance: [],
    note: '',
    toolVersion: '1.4.2',
    transport: 'NONE' as const,
    environment: '',
    models: [
      { id: 'devin-small', name: 'Devin Small' },
      { id: 'devin-large', name: 'Devin Large' },
    ],
    operations: [
      seen('ACCOUNT_STATUS', minutes),
      seen('MODEL_CATALOG', minutes),
      unread('ALLOWANCE_READ', minutes),
      ...LOCAL.map(operation => unread(operation, minutes)),
    ],
    source: 'devin auth status',
    observedAt: at(minutes),
    ...overrides,
  };
}
/**
 * Evidence the office observed itself on a local route. It is OBSERVED because the office really
 * did the operation, and TOOL_SUPPORTED at most: an office observation is never provider attestation.
 */
const office = (
  operation: CapabilityOperation,
  minutes: number,
  extra: Partial<CapabilityEvidence> = {},
): CapabilityEvidence => ({
  operation,
  level: 'TOOL_SUPPORTED',
  detail: 'Exercised by the office on this machine.',
  evidence: 'OBSERVED',
  verifiedAt: at(minutes),
  source: 'office local-session observation',
  ...extra,
});
function transportEvidence(
  connectionId: string,
  operations: CapabilityEvidence[],
  overrides: Record<string, unknown> = {},
) {
  return {
    connectionId,
    route: 'LOCAL_MAILBOX',
    environment: 'office-local',
    model: 'devin-small',
    operations,
    source: 'office local mailbox transport',
    observedAt: at(5),
    ...overrides,
  };
}

test('a recorded local submission is visible to readiness for its exact scope', t => {
  const s = store(t);
  const observed = s.recordAccountObservation(account(0));
  const connection = currentConnection(observed, 'devin')!;
  const state = s.recordTransportEvidence(transportEvidence(connection.id, [office('LOCAL_SUBMIT', 5)]));
  const submit = effectiveEvidence(state, connection, 'LOCAL_SUBMIT', {
    now: ms(6),
    model: 'devin-small',
    route: 'LOCAL_MAILBOX',
    environment: 'office-local',
  })!;
  assert.equal(submit.level, 'TOOL_SUPPORTED');
  assert.equal(submit.evidence, 'OBSERVED');
  assert.equal(submit.route, 'LOCAL_MAILBOX');
  assert.equal(submit.transport, 'LOCAL_MAILBOX');
  assert.equal(submit.model, 'devin-small');
  const readiness = providerReadiness(state, 'devin', {
    now: ms(6),
    model: 'devin-small',
    route: 'LOCAL_MAILBOX',
    environment: 'office-local',
  });
  assert.ok(readiness.evidence.some(item => item.operation === 'LOCAL_SUBMIT' && item.level === 'TOOL_SUPPORTED'));
  // The exercised operation verifies at its honest level — but the rest of the local family is
  // still unverified, so automatic start stays off until every operation has been exercised.
  assert.equal(readiness.actions.automaticStart, false);
  assert.ok(
    !readiness.blockers.some(b => b.startsWith('Unverified local session submission')),
    'the exercised submission is verified',
  );
  assert.ok(
    readiness.blockers.some(b => b.startsWith('Unverified local session observation')),
    'the unexercised operations still block',
  );
});

test('merging keeps earlier office evidence that a later batch does not supersede', t => {
  const s = store(t);
  const observed = s.recordAccountObservation(account(0));
  const connection = currentConnection(observed, 'devin')!;
  s.recordTransportEvidence(transportEvidence(connection.id, [office('LOCAL_SUBMIT', 5)]));
  const state = s.recordTransportEvidence(
    transportEvidence(connection.id, [office('LOCAL_OBSERVE', 6)], { observedAt: at(6) }),
  );
  const scope = { now: ms(7), model: 'devin-small', route: 'LOCAL_MAILBOX' as const, environment: 'office-local' };
  assert.equal(
    effectiveEvidence(state, connection, 'LOCAL_SUBMIT', scope)?.level,
    'TOOL_SUPPORTED',
    'the earlier entry survived the merge',
  );
  assert.equal(
    effectiveEvidence(state, connection, 'LOCAL_OBSERVE', scope)?.level,
    'TOOL_SUPPORTED',
    'the later batch was appended',
  );
  assert.equal(state.capabilities!.length, 3, 'the account observation plus one snapshot per distinct recording');
  const latest = state.capabilities!.at(-1)!;
  assert.ok(latest.operations.some(entry => entry.operation === 'LOCAL_SUBMIT' && entry.level === 'TOOL_SUPPORTED'));
  assert.ok(latest.operations.some(entry => entry.operation === 'LOCAL_OBSERVE' && entry.level === 'TOOL_SUPPORTED'));
});

test('a newer batch supersedes only the entries sharing its exact scope', t => {
  const s = store(t);
  const observed = s.recordAccountObservation(account(0));
  const connection = currentConnection(observed, 'devin')!;
  s.recordTransportEvidence(transportEvidence(connection.id, [office('LOCAL_SUBMIT', 5), office('LOCAL_OBSERVE', 5)]));
  const state = s.recordTransportEvidence(
    transportEvidence(
      connection.id,
      [{ ...office('LOCAL_SUBMIT', 6), level: 'UNAVAILABLE', detail: 'The route refused the packet.' }],
      { observedAt: at(6) },
    ),
  );
  const scope = { now: ms(7), model: 'devin-small', route: 'LOCAL_MAILBOX' as const, environment: 'office-local' };
  assert.equal(
    effectiveEvidence(state, connection, 'LOCAL_SUBMIT', scope)?.level,
    'UNAVAILABLE',
    'the newer same-scope result supersedes',
  );
  assert.equal(
    effectiveEvidence(state, connection, 'LOCAL_OBSERVE', scope)?.level,
    'TOOL_SUPPORTED',
    'other entries are retained',
  );
  const latest = state.capabilities!.at(-1)!;
  assert.equal(
    latest.operations.filter(entry => entry.operation === 'LOCAL_SUBMIT' && entry.level === 'TOOL_SUPPORTED').length,
    0,
    'the superseded entry is not duplicated',
  );
});

test('an identical re-recording writes only the history event, never a duplicate snapshot', t => {
  const s = store(t);
  const observed = s.recordAccountObservation(account(0));
  const connection = currentConnection(observed, 'devin')!;
  const first = s.recordTransportEvidence(transportEvidence(connection.id, [office('LOCAL_SUBMIT', 5)]));
  assert.equal(first.capabilities!.length, 2);
  const state = s.recordTransportEvidence(transportEvidence(connection.id, [office('LOCAL_SUBMIT', 5)]));
  assert.equal(state.capabilities!.length, 2, 'identical evidence adds no capability row');
  const event = state.events.at(-1)!;
  assert.equal(event.kind, 'TRANSPORT_EVIDENCE_RECORDED');
  assert.match(event.reason, /capabilities unchanged/);
});

test('provider attestation can never be recorded through the office-observed path', t => {
  const s = store(t);
  const observed = s.recordAccountObservation(account(0));
  const connection = currentConnection(observed, 'devin')!;
  assert.throws(
    () =>
      s.recordTransportEvidence(
        transportEvidence(connection.id, [{ ...office('LOCAL_SUBMIT', 5), level: 'ACCOUNT_VERIFIED' }]),
      ),
    /ACCOUNT_VERIFIED cannot be recorded through the office-observed transport path/,
  );
  assert.equal(s.snapshot().capabilities!.length, 1, 'nothing was persisted by the rejected call');
});

test('hosted-route evidence and unknown connections are refused', t => {
  const s = store(t);
  const observed = s.recordAccountObservation(account(0));
  const connection = currentConnection(observed, 'devin')!;
  assert.throws(
    () =>
      s.recordTransportEvidence(
        transportEvidence(connection.id, [office('CLOUD_SUBMIT', 5)], { route: 'OFFICIAL_CLI_PTY' }),
      ),
    /Hosted-route evidence is recorded through provider observation/,
  );
  assert.throws(
    () => s.recordTransportEvidence(transportEvidence(randomUUID(), [office('LOCAL_SUBMIT', 5)])),
    /never recorded/,
  );
  assert.equal(s.snapshot().capabilities!.length, 1, 'nothing was persisted by the rejected calls');
});

test('evidence recorded under one model answers nothing about another', t => {
  const s = store(t);
  const observed = s.recordAccountObservation(account(0));
  const connection = currentConnection(observed, 'devin')!;
  const state = s.recordTransportEvidence(transportEvidence(connection.id, [office('LOCAL_SUBMIT', 5)]));
  const scope = { now: ms(6), route: 'LOCAL_MAILBOX' as const, environment: 'office-local' };
  assert.ok(
    effectiveEvidence(state, connection, 'LOCAL_SUBMIT', { ...scope, model: 'devin-small' }),
    'the observed model is answered for',
  );
  assert.equal(
    effectiveEvidence(state, connection, 'LOCAL_SUBMIT', { ...scope, model: 'devin-large' }),
    undefined,
    'a different model has no evidence',
  );
});
