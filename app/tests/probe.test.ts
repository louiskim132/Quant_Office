import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { probeCloudTransport } from '../src/main/probe';
import { TRANSPORT_PROBE_CONTAINMENT, assertTransportProbeAllowed } from '../src/shared/transport';
import { providerReadiness, currentConnection } from '../src/shared/readiness';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from '../src/main/controller';
import type { CapabilityEvidence, CapabilityOperation, ProviderJob } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 13, 0, 0) + minutes * 60000).toISOString();
const CLOUD: CapabilityOperation[] = [
  'CLOUD_SUBMIT',
  'CLOUD_OBSERVE',
  'CLOUD_OUTPUT_FETCH',
  'CLOUD_CANCEL_REQUEST',
  'CLOUD_CANCEL_ACK',
  'MODEL_APPLICATION',
  'EFFORT_APPLICATION',
  'ENVIRONMENT_IDENTITY',
  'DELEGATION_CONTROL',
  'TOOL_CONFINEMENT',
];
const seen = (operation: CapabilityOperation, minutes: number): CapabilityEvidence => ({
  operation,
  level: 'ACCOUNT_VERIFIED',
  detail: 'Exercised.',
  evidence: 'OBSERVED',
  verifiedAt: at(minutes),
  source: 'fixture',
});
const unknown = (operation: CapabilityOperation, minutes: number): CapabilityEvidence => ({
  operation,
  level: 'UNKNOWN',
  detail: 'No supported route established.',
  evidence: 'DOCUMENTED',
  verifiedAt: at(minutes),
  source: 'docs',
});
const observation = (minutes: number, overrides: Record<string, unknown> = {}) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '2.1.236',
  transport: 'NONE' as const,
  environment: '',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [seen('ACCOUNT_STATUS', minutes), ...CLOUD.map(o => unknown(o, minutes))],
  source: 'claude auth status',
  observedAt: at(minutes),
  ...overrides,
});

class ProbeAdapter implements ProviderAdapter {
  readonly route = 'OFFICIAL_CLI_PTY' as const;
  public contexts: SubmitContext[] = [];
  constructor(private readonly behaviour: () => Promise<SubmitResult>) {}
  async submit(context: SubmitContext) {
    this.contexts.push(context);
    return this.behaviour();
  }
  async observe(_job: ProviderJob): Promise<ObserveResult> {
    return { state: 'UNKNOWN', detail: 'not supported' };
  }
  async cancel(_job: ProviderJob) {
    return { acknowledged: false, detail: 'not supported' };
  }
}

function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-probe-'));
  const file = path.join(root, 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
  store.recordAccountObservation(observation(0));
  return {
    root,
    get store() {
      return store;
    },
    staging: path.join(root, 'staging'),
    reopen() {
      store.close();
      store = new OfficeStore(file);
      return store;
    },
  };
}

test('a successful probe records observed submission evidence and nothing else', async t => {
  const f = fixture(t);
  const adapter = new ProbeAdapter(async () => ({
    externalId: 'session_probe0123456789',
    externalUrl: 'https://claude.ai/code/session_probe0123456789',
    detail: 'created',
  }));
  const result = await probeCloudTransport({
    store: f.store,
    adapter,
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  assert.equal(result.verified, true);
  assert.equal(result.externalId, 'session_probe0123456789');
  const state = f.store.snapshot();
  const readiness = providerReadiness(state, 'claude', { now: Date.parse(at(11)) });
  const submit = readiness.evidence.find(item => item.operation === 'CLOUD_SUBMIT')!;
  assert.equal(submit.level, 'ACCOUNT_VERIFIED');
  assert.equal(submit.evidence, 'OBSERVED');
  assert.equal(submit.model, '', 'the route selects no model, so submission evidence claims no model scope');
  assert.match(submit.detail, /selected no model/);
  assert.match(submit.source, /transport probe/);
  assert.equal(readiness.dispatchChecked, false, 'one verified operation is not a verified transport');
  assert.equal(readiness.actions.automaticStart, false);
  assert.equal(readiness.actions.observe, false);
  assert.equal(readiness.actions.requestCancellation, false);
});

test('a failed probe records the exact failure as observed evidence, not silence', async t => {
  const f = fixture(t);
  const adapter = new ProbeAdapter(async () => {
    throw new Error('error: --cloud requires an interactive terminal');
  });
  const result = await probeCloudTransport({
    store: f.store,
    adapter,
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  assert.equal(result.verified, false);
  assert.match(result.detail, /INTERACTIVE_TERMINAL_REQUIRED/);
  const readiness = providerReadiness(f.store.snapshot(), 'claude', { now: Date.parse(at(11)) });
  const submit = readiness.evidence.find(item => item.operation === 'CLOUD_SUBMIT')!;
  assert.equal(submit.level, 'UNAVAILABLE');
  assert.equal(submit.evidence, 'OBSERVED');
  assert.match(submit.detail, /INTERACTIVE_TERMINAL_REQUIRED/);
  assert.match(submit.detail, /interactive terminal/);
  assert.equal(readiness.actions.automaticStart, false);
});

test('the probe sends a generated fixture only, and cleans it up afterwards', async t => {
  const f = fixture(t);
  let stagingSeen = '';
  const adapter = new ProbeAdapter(async () => ({
    externalId: 'session_probe0123456789',
    externalUrl: '',
    detail: 'created',
  }));
  await probeCloudTransport({
    store: f.store,
    adapter,
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  stagingSeen = adapter.contexts[0].snapshot.stagingPath;
  assert.equal(adapter.contexts[0].snapshot.files.length, 0, 'no user files are ever part of a probe');
  assert.equal(adapter.contexts[0].snapshot.route, 'GENERATED_REQUEST_ONLY');
  assert.match(adapter.contexts[0].objective, /Do not delegate/);
  // A resolved attempt has nothing left to reconcile, so its fixture is removed. An unresolved one
  // keeps it deliberately; that case is asserted in the durable-intent test.
  assert.equal(existsSync(stagingSeen), false, 'the probe directory is removed once the attempt is settled');
});

test('a probe requires a signed-in account', async t => {
  const f = fixture(t);
  const adapter = new ProbeAdapter(async () => ({
    externalId: 'session_probe0123456789',
    externalUrl: '',
    detail: 'created',
  }));
  await assert.rejects(
    probeCloudTransport({
      store: f.store,
      adapter,
      stagingRoot: f.staging,
      model: 'opus',
      observation: observation(10, { state: 'SIGNED_OUT' }),
      now: () => at(10),
    }),
    /Sign in/,
  );
  assert.equal(adapter.contexts.length, 0, 'nothing is submitted without an account');
});

test('a later successful probe supersedes an earlier failed one', async t => {
  const f = fixture(t);
  await probeCloudTransport({
    store: f.store,
    adapter: new ProbeAdapter(async () => {
      throw new Error('no terminal');
    }),
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  // The failed attempt is unresolved and blocks another, so it is reconciled first: the user checked
  // with the provider and reported no session. That closes the attempt and verifies nothing.
  const unresolved = (f.store.snapshot().probes ?? []).find(item => item.state === 'UNKNOWN')!;
  f.store.recordProbeReconciliation({
    attemptId: unresolved.id,
    found: false,
    detail: 'No session of that name exists in the provider UI.',
    at: at(15),
  });
  await probeCloudTransport({
    store: f.store,
    adapter: new ProbeAdapter(async () => ({
      externalId: 'session_probe0123456789',
      externalUrl: '',
      detail: 'created',
    })),
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(20),
    now: () => at(20),
  });
  const submit = providerReadiness(f.store.snapshot(), 'claude', { now: Date.parse(at(21)) }).evidence.find(
    item => item.operation === 'CLOUD_SUBMIT',
  )!;
  assert.equal(submit.level, 'ACCOUNT_VERIFIED');
  assert.equal(submit.verifiedAt, at(20));
  assert.equal(currentConnection(f.store.snapshot(), 'claude')!.identity, 'researcher@example.com');
});

test('the session-creating probe action is contained until its intent and snapshot defects are repaired', () => {
  // R1 step 1. The office may still report what it knows; it may not create a session to find out.
  assert.equal(TRANSPORT_PROBE_CONTAINMENT.contained, true);
  assert.throws(
    () => assertTransportProbeAllowed(),
    /temporarily unavailable pending hosted verification and session reconciliation/,
  );
  assert.match(
    TRANSPORT_PROBE_CONTAINMENT.reason,
    /No probe was started by this action/,
    'the rejection may claim this only because it happens before any effect',
  );
  assert.match(TRANSPORT_PROBE_CONTAINMENT.status, /hosted verification and session reconciliation required/);
  // The guard is a real gate, not a constant a caller can read past.
  assert.doesNotThrow(() => assertTransportProbeAllowed({ contained: false, reason: '', status: '' }));
});

test('a probe writes a durable intent before contacting the provider, and one unresolved attempt blocks another', async t => {
  const f = fixture(t);
  let sawIntentDuringSubmit = false;
  const adapter = new ProbeAdapter(async () => {
    // While the provider call is in flight, the attempt must already exist durably.
    const probes = f.store.snapshot().probes ?? [];
    sawIntentDuringSubmit = probes.length === 1 && probes[0].state === 'INTENT';
    throw new Error('error: --cloud requires an interactive terminal');
  });
  const result = await probeCloudTransport({
    store: f.store,
    adapter,
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  assert.equal(sawIntentDuringSubmit, true, 'the intent is committed before the provider is contacted');
  assert.equal(result.verified, false);

  const settled = (f.store.snapshot().probes ?? []).find(item => item.state !== 'INTENT')!;
  // The call started, so the provider's view is unknown. It is never recorded as "not submitted".
  assert.equal(settled.state, 'UNKNOWN');
  assert.equal(settled.failureCode, 'INTERACTIVE_TERMINAL_REQUIRED');
  assert.equal(settled.identity, 'researcher@example.com');
  assert.equal(settled.route, 'OFFICIAL_CLI_PTY');
  assert.equal(existsSync(settled.stagingPath), true, 'the fixture is retained so the attempt can be reconciled');

  // A second attempt is refused while the first is unresolved, and nothing new is submitted.
  const second = new ProbeAdapter(async () => ({
    externalId: 'session_probe0123456789',
    externalUrl: '',
    detail: 'created',
  }));
  await assert.rejects(
    probeCloudTransport({
      store: f.store,
      adapter: second,
      stagingRoot: f.staging,
      model: 'opus',
      observation: observation(20),
      now: () => at(20),
    }),
    /has not been resolved/,
  );
  assert.equal(second.contexts.length, 0, 'nothing is submitted while an earlier attempt is unresolved');
});

test('an unresolved attempt still blocks after a restart', async t => {
  const f = fixture(t);
  await probeCloudTransport({
    store: f.store,
    adapter: new ProbeAdapter(async () => {
      throw new Error('no terminal');
    }),
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  const reopened = f.reopen();
  const adapter = new ProbeAdapter(async () => ({
    externalId: 'session_probe0123456789',
    externalUrl: '',
    detail: 'created',
  }));
  await assert.rejects(
    probeCloudTransport({
      store: reopened,
      adapter,
      stagingRoot: f.staging,
      model: 'opus',
      observation: observation(20),
      now: () => at(20),
    }),
    /has not been resolved/,
  );
  assert.equal(adapter.contexts.length, 0, 'a restart does not forget an unresolved attempt');
});

test('the probe fixture is a real one-commit snapshot, not a fabricated one', async t => {
  const f = fixture(t);
  const adapter = new ProbeAdapter(async () => ({
    externalId: 'session_probe0123456789',
    externalUrl: '',
    detail: 'created',
  }));
  await probeCloudTransport({
    store: f.store,
    adapter,
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  const context = adapter.contexts[0];
  assert.match(context.snapshot.stagingCommit, /^[a-f0-9]{40}$/, 'a real commit, not forty f characters');
  assert.notEqual(context.snapshot.manifestHash, '0'.repeat(64), 'a real manifest hash, not sixty-four zeros');
  assert.equal(context.snapshot.route, 'GENERATED_REQUEST_ONLY');
  assert.equal(context.snapshot.files.length, 0, 'no user files are ever part of a probe');
  // The snapshot is a recorded one that the ordinary verification path accepts.
  const recorded = f.store.snapshot().snapshots!.find(item => item.id === context.snapshot.id);
  assert.ok(recorded, 'the probe fixture is recorded like any other snapshot');
});

test('a probe failure is recorded as a classified code, never as raw tool output', async t => {
  const f = fixture(t);
  // A real CLI exception can carry a path, a prompt or an account detail. Capability evidence is
  // long-lived, so none of that text may be persisted with it.
  const secret = 'C:\\Users\\louis\\AppData\\Roaming\\claude\\token-9f3a2b oauth_secret=abc123';
  const adapter = new ProbeAdapter(async () => {
    throw new Error(`spawn failed reading ${secret}`);
  });
  const result = await probeCloudTransport({
    store: f.store,
    adapter,
    stagingRoot: f.staging,
    model: 'opus',
    observation: observation(10),
    now: () => at(10),
  });
  assert.equal(result.verified, false);
  const submit = providerReadiness(f.store.snapshot(), 'claude', { now: Date.parse(at(11)) }).evidence.find(
    item => item.operation === 'CLOUD_SUBMIT',
  )!;
  assert.equal(submit.level, 'UNAVAILABLE');
  assert.match(submit.detail, /UNCLASSIFIED/);
  assert.equal(submit.detail.includes('oauth_secret'), false, 'the raw exception text is not persisted');
  assert.equal(submit.detail.includes('AppData'), false, 'a path from the exception is not persisted');
  assert.equal(result.detail.includes('oauth_secret'), false, 'nor returned to the interface');
  const settled = (f.store.snapshot().probes ?? []).find(item => item.state !== 'INTENT')!;
  assert.equal(settled.detail.includes('oauth_secret'), false, 'nor stored on the attempt');
});
