import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import {
  effectiveEvidence,
  latestCapability,
  providerReadiness,
  agentDispatchReadiness,
  agentBinding,
} from '../src/shared/readiness';
import type { Agent, CapabilityOperation, ProviderCapabilitySnapshot } from '../src/shared/types';

test('B2b: append-order selection and earlier local evidence survive window projection', t => {
  const store = new OfficeStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'qro-window-readiness-')), 'workspace.sqlite'),
  );
  t.after(() => store.close());
  const at = '2026-10-01T12:00:00.000Z';
  store.recordAccountObservation({
    provider: 'claude',
    identity: 'synthetic@example.invalid',
    credentialContext: 'fixture',
    state: 'SIGNED_IN',
    allowance: [],
    note: '',
    toolVersion: 'v2',
    transport: 'NONE',
    environment: '',
    models: [{ id: 'opus', name: 'Opus' }],
    operations: [],
    source: 'synthetic',
    observedAt: at,
  });
  const state = store.snapshot({ history: false });
  const connection = state.connections![0];
  const base = state.capabilities![0];
  const operations: CapabilityOperation[] = [
    'LOCAL_SUBMIT',
    'LOCAL_OBSERVE',
    'LOCAL_OUTPUT_FETCH',
    'LOCAL_CANCEL',
    'MODEL_APPLICATION',
    'EFFORT_APPLICATION',
    'DELEGATION_CONTROL',
    'TOOL_CONFINEMENT',
  ];
  const history: ProviderCapabilitySnapshot[] = [
    { ...base, id: 'old-version', toolVersion: 'v1' },
    { ...base, id: 'other-identity', identity: 'other@example.invalid' },
    {
      ...base,
      id: 'transport',
      transport: 'LOCAL_CLI_EXEC',
      environment: 'LOCAL_MACHINE',
      operations: operations.map(operation => ({
        operation,
        level: 'TOOL_SUPPORTED',
        evidence: 'OBSERVED',
        detail: 'Synthetic transport observation',
        route: 'LOCAL_CLI_EXEC',
        model: 'opus',
        environment: 'LOCAL_MACHINE',
        effort: 'default',
        delegation: false,
        verifiedAt: at,
        confinement: { tools: 'fixture', filesystem: 'scratch', network: 'none', environment: 'scratch' },
      })),
    },
    { ...base, id: 'future-clock', observedAt: '2027-01-01T00:00:00.000Z' },
    { ...base, id: 'last-appended', observedAt: at },
  ];
  const full = { ...state, capabilities: history };
  const windowed = OfficeStore.publicState(full);
  assert.deepEqual(latestCapability(windowed, connection.id), latestCapability(full, connection.id));
  const agent = {
    provider: 'claude',
    model: 'opus',
    effort: 'default',
    account: connection.identity,
    connectionId: connection.id,
    execution: 'LOCAL',
    localRoute: 'LOCAL_CLI_EXEC',
  } as Agent;
  const now = Date.parse(at) + 1000;
  for (const route of ['LOCAL_CLI_EXEC', 'LOCAL_MAILBOX', 'OFFICIAL_TERMINAL_HANDOFF'] as const)
    for (const model of ['opus', 'unavailable'])
      for (const operation of operations)
        for (const effort of ['default', 'high'] as const) {
          const options = { now, route, model, effort, environment: 'LOCAL_MACHINE', delegation: false };
          assert.deepEqual(
            effectiveEvidence(windowed, connection, operation, options),
            effectiveEvidence(full, connection, operation, options),
          );
          assert.deepEqual(
            providerReadiness(windowed, connection.provider, options),
            providerReadiness(full, connection.provider, options),
          );
          assert.deepEqual(
            agentDispatchReadiness(windowed, agent, options),
            agentDispatchReadiness(full, agent, options),
          );
        }
  assert.deepEqual(agentBinding(windowed, agent), agentBinding(full, agent));
  assert.deepEqual(
    windowed.capabilities!.map(c => c.id),
    ['transport', 'last-appended'],
  );
});
