import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { agentBinding, agentDispatchReadiness, currentConnection } from '../src/shared/readiness';
import type { Agent, CapabilityEvidence, CapabilityOperation, Provider } from '../src/shared/types';

function fixture(t: any) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'qro-binding-')), 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => store.close());
  return {
    store,
    reopen() {
      store.close();
      store = new OfficeStore(file);
      return store;
    },
  };
}
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 9, 0, 0) + minutes * 60000).toISOString();
const ROUTES = ['FAKE_ADAPTER', 'OFFICIAL_TERMINAL_HANDOFF', 'OFFICIAL_CLI_PTY'] as const;
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
const seen = (
  operation: CapabilityOperation,
  minutes: number,
  extra: Partial<CapabilityEvidence> = {},
): CapabilityEvidence => ({
  operation,
  level: 'ACCOUNT_VERIFIED',
  detail: 'Exercised.',
  evidence: 'OBSERVED',
  verifiedAt: at(minutes),
  source: 'fixture',
  ...extra,
});
const unknown = (operation: CapabilityOperation, minutes: number): CapabilityEvidence => ({
  operation,
  level: 'UNKNOWN',
  detail: 'No supported route established.',
  evidence: 'DOCUMENTED',
  verifiedAt: at(minutes),
  source: 'docs',
});
function observation(minutes: number, identity = 'researcher@example.com', overrides: Record<string, unknown> = {}) {
  return {
    provider: 'claude' as Provider,
    identity,
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
  };
}
const draft = (overrides: Partial<Agent> = {}): Agent => ({
  id: randomUUID(),
  name: 'Sole worker',
  provider: 'claude',
  model: 'opus',
  team: 'Research',
  role: 'WORKER',
  instructions: '',
  account: 'researcher@example.com',
  createdAt: at(0),
  connectionVerifiedAt: at(0),
  execution: 'HOSTED_SETUP_REQUIRED',
  ...overrides,
});

test('Confirm binds one agent to the observation that justified it, in one transaction', t => {
  const f = fixture(t);
  const agent = draft();
  const state = f.store.confirmAgentBinding({ observation: observation(0), agent });
  const saved = state.agents.find(a => a.id === agent.id)!;
  const connection = currentConnection(state, 'claude')!;
  assert.equal(saved.connectionId, connection.id);
  assert.equal(saved.bindingVerifiedAt, at(0));
  assert.equal(state.connections!.length, 1);
  assert.equal(state.capabilities!.length, 1);
  assert.equal(state.events.filter(e => e.kind === 'AGENT_ADDED').length, 1, 'one ticket creates exactly one agent');
  assert.equal(agentBinding(state, saved).available, true);
  const reopened = f.reopen().snapshot();
  assert.equal(
    reopened.agents.find(a => a.id === agent.id)!.connectionId,
    connection.id,
    'the binding survives restart',
  );
});

test('a rejected observation creates no agent and can be retried', t => {
  const f = fixture(t);
  const agent = draft();
  assert.throws(
    () =>
      f.store.confirmAgentBinding({
        observation: observation(0, 'researcher@example.com', { note: 'sk-ant-api03-leakedvalue' }),
        agent,
      }),
    /credential/i,
  );
  assert.equal(f.store.snapshot().agents.length, 0, 'no agent exists when its evidence could not be persisted');
  assert.equal(f.store.snapshot().connections, undefined);
  const state = f.store.confirmAgentBinding({ observation: observation(0), agent });
  assert.equal(state.agents.length, 1, 'the same confirmation can be retried once the evidence is acceptable');
});

test('Confirm refuses a changed account, the wrong provider, a signed-out tool and a duplicate identity', t => {
  const f = fixture(t);
  const agent = draft();
  assert.throws(
    () => f.store.confirmAgentBinding({ observation: observation(0, 'someone-else@example.com'), agent }),
    /account changed/i,
  );
  assert.throws(
    () =>
      f.store.confirmAgentBinding({
        observation: observation(0),
        agent: draft({ provider: 'openai', model: 'gpt-6-astra' }),
      }),
    /provider/i,
  );
  assert.throws(
    () =>
      f.store.confirmAgentBinding({
        observation: observation(0, 'researcher@example.com', { state: 'SIGNED_OUT' }),
        agent,
      }),
    /sign in/i,
  );
  f.store.confirmAgentBinding({ observation: observation(0), agent });
  assert.throws(() => f.store.confirmAgentBinding({ observation: observation(1), agent }), /identity conflict/i);
});

test('an old profile is never bound by merely reading a snapshot, and Verify binds it explicitly', t => {
  const f = fixture(t);
  const legacy = draft({ connectionVerifiedAt: at(0) });
  f.store.addAgent(legacy);
  f.store.recordAccountObservation(observation(1));
  const unbound = agentBinding(f.store.snapshot(), f.store.snapshot().agents[0]);
  assert.equal(unbound.bound, false);
  assert.equal(unbound.available, false);
  assert.match(unbound.blockers[0], /Unverified/);
  const state = f.store.bindAgentConnection({
    agentId: legacy.id,
    expectedRevision: 0,
    intent: 'VERIFY',
    observation: observation(2),
  });
  const bound = state.agents.find(a => a.id === legacy.id)!;
  assert.equal(bound.connectionId, currentConnection(state, 'claude')!.id);
  assert.equal(bound.account, 'researcher@example.com', 'verification never rewrites the setup identity');
  assert.equal(bound.revision, 1);
  assert.equal(agentBinding(state, bound).available, true);
  assert.ok(state.events.some(e => e.kind === 'AGENT_CONNECTION_VERIFIED'));
});

test('Verify refuses a different signed-in account and names both identities', t => {
  const f = fixture(t);
  const agent = draft();
  f.store.addAgent(agent);
  assert.throws(
    () =>
      f.store.bindAgentConnection({
        agentId: agent.id,
        expectedRevision: 0,
        intent: 'VERIFY',
        observation: observation(1, 'second@example.com'),
      }),
    /created for researcher@example.com, but second@example.com is signed in/,
  );
  assert.equal(f.store.snapshot().agents[0].connectionId, undefined);
  assert.equal(f.store.snapshot().agents[0].revision, undefined, 'a refused verification does not advance the profile');
});

test('Change connection is explicit, revision-checked, and never silent', t => {
  const f = fixture(t);
  const agent = draft();
  f.store.confirmAgentBinding({ observation: observation(0), agent });
  const first = currentConnection(f.store.snapshot(), 'claude')!;
  // A background refresh of a different account must not move the profile.
  const switched = f.store.recordAccountObservation(observation(6, 'second@example.com'));
  const stillBound = switched.agents.find(a => a.id === agent.id)!;
  assert.equal(stillBound.connectionId, first.id, 'an account switch never rebinds a profile');
  const binding = agentBinding(switched, stillBound);
  assert.equal(binding.available, false, 'the profile is unavailable in the new context');
  assert.match(binding.blockers[0], /Bound to researcher@example.com, but second@example.com is the current context/);
  assert.throws(
    () =>
      f.store.bindAgentConnection({
        agentId: agent.id,
        expectedRevision: 7,
        intent: 'CHANGE',
        observation: observation(7, 'second@example.com'),
      }),
    /Stale|changed in another view/i,
  );
  const moved = f.store.bindAgentConnection({
    agentId: agent.id,
    expectedRevision: 0,
    intent: 'CHANGE',
    observation: observation(8, 'second@example.com'),
  });
  const after = moved.agents.find(a => a.id === agent.id)!;
  assert.notEqual(after.connectionId, first.id);
  assert.equal(after.account, 'second@example.com');
  assert.equal(after.revision, 1);
  const record = moved.events.find(e => e.kind === 'AGENT_CONNECTION_CHANGED')!;
  assert.match(record.reason, /from researcher@example.com to second@example.com by explicit user action/);
});

test('archived profiles reject binding until restored', t => {
  const f = fixture(t);
  const agent = draft();
  f.store.confirmAgentBinding({ observation: observation(0), agent });
  f.store.execute({ type: 'agent.remove', idempotencyKey: randomUUID(), agentId: agent.id, removed: true });
  const archived = f.store.snapshot().agents.find(a => a.id === agent.id)!;
  assert.throws(
    () =>
      f.store.bindAgentConnection({
        agentId: agent.id,
        expectedRevision: archived.revision ?? 0,
        intent: 'VERIFY',
        observation: observation(6),
      }),
    /Restore this agent/,
  );
  assert.ok(agentBinding(f.store.snapshot(), archived).blockers.some(b => b.includes('Archived')));
});

test('A to B to A keeps two separate bindings and their own histories', t => {
  const f = fixture(t);
  const first = draft(),
    second = draft({ account: 'second@example.com', name: 'Second worker' });
  f.store.confirmAgentBinding({ observation: observation(0), agent: first });
  f.store.confirmAgentBinding({ observation: observation(6, 'second@example.com'), agent: second });
  const back = f.store.recordAccountObservation(observation(12));
  assert.equal(back.connections!.length, 2);
  assert.equal(currentConnection(back, 'claude')!.identity, 'researcher@example.com');
  assert.equal(
    agentBinding(
      back,
      back.agents.find(a => a.id === first.id)!,
    ).available,
    true,
  );
  assert.equal(
    agentBinding(
      back,
      back.agents.find(a => a.id === second.id)!,
    ).available,
    false,
  );
  assert.equal(
    back.agents.find(a => a.id === second.id)!.account,
    'second@example.com',
    'the other profile keeps its own account',
  );
});

test('a profile edit cannot write a binding, and binding survives profile edits and backups', async t => {
  const f = fixture(t);
  const agent = draft();
  f.store.confirmAgentBinding({ observation: observation(0), agent });
  const connectionId = f.store.snapshot().agents[0].connectionId;
  assert.throws(() =>
    f.store.execute({
      type: 'agent.update',
      idempotencyKey: randomUUID(),
      agentId: agent.id,
      expectedRevision: 0,
      name: 'Renamed',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      connectionId: randomUUID(),
    } as never),
  );
  const edited = f.store.execute({
    type: 'agent.update',
    idempotencyKey: randomUUID(),
    agentId: agent.id,
    expectedRevision: 0,
    name: 'Renamed',
    team: 'Research',
    role: 'WORKER',
    instructions: '',
  });
  assert.equal(
    edited.agents[0].connectionId,
    connectionId,
    'an ordinary profile edit preserves the binding it did not set',
  );
  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'qro-binding-backup-')), 'copy.sqlite');
  await f.store.backup(copy);
  const restored = new OfficeStore(copy);
  t.after(() => restored.close());
  assert.equal(restored.snapshot().agents[0].connectionId, connectionId);
});

test('dispatch needs an available binding, a fresh check and verified transport for that model', t => {
  const f = fixture(t);
  const agent = draft();
  f.store.confirmAgentBinding({ observation: observation(0), agent });
  const state = f.store.snapshot();
  const bound = state.agents[0];
  const gate = agentDispatchReadiness(state, bound, { now: Date.parse(at(1)) });
  assert.equal(gate.binding.available, true);
  assert.equal(gate.canPrepare, true);
  assert.equal(gate.canHandoff, true, 'a labeled handoff only needs a live signed-in account');
  assert.equal(gate.canStart, false, 'transport for this model is still unverified');
  assert.ok(gate.blockers.some(b => b.includes('opus')));
  const verified = f.store.recordAccountObservation(
    observation(10, 'researcher@example.com', {
      transport: 'OFFICIAL_CLI_TERMINAL',
      environment: 'anthropic-managed',
      operations: [
        seen('ACCOUNT_STATUS', 10),
        seen('MODEL_CATALOG', 10),
        ...CLOUD.flatMap(o =>
          ROUTES.flatMap(route =>
            o === 'DELEGATION_CONTROL'
              ? [
                  seen(o, 10, { model: 'opus', route, delegation: false }),
                  seen(o, 10, { model: 'opus', route, delegation: true }),
                ]
              : o === 'EFFORT_APPLICATION'
                ? [seen(o, 10, { model: 'opus', route, effort: 'default' })]
                : o === 'TOOL_CONFINEMENT'
                  ? [
                      seen(o, 10, {
                        model: 'opus',
                        route,
                        confinement: {
                          tools: 'Only the read-only fixture tools were offered.',
                          filesystem: 'Confined to the staged snapshot directory.',
                          network: 'No outbound network was reachable from the session.',
                          environment: 'anthropic-managed',
                        },
                      }),
                    ]
                  : [seen(o, 10, { model: 'opus', route })],
          ),
        ),
      ],
    }),
  );
  const ready = agentDispatchReadiness(verified, verified.agents[0], { now: Date.parse(at(11)) });
  assert.equal(ready.canStart, true);
  const stale = agentDispatchReadiness(verified, verified.agents[0], { now: Date.parse(at(20)) });
  assert.equal(stale.canStart, false, 'a stale account check blocks dispatch even with verified transport');
  assert.equal(stale.canPrepare, true);
});

test('a deliberate rebinding moves the account and preserves the identity the profile was created for', t => {
  const f = fixture(t);
  const agent = draft();
  f.store.confirmAgentBinding({ observation: observation(0), agent });
  const before = agentBinding(
    f.store.snapshot(),
    f.store.snapshot().agents.find(a => a.id === agent.id)!,
  );
  assert.equal(before.setupIdentity, 'researcher@example.com');
  assert.equal(before.rebound, false);

  const moved = f.store.bindAgentConnection({
    agentId: agent.id,
    expectedRevision: 0,
    intent: 'CHANGE',
    observation: observation(8, 'second@example.com'),
  });
  const rebound = moved.agents.find(a => a.id === agent.id)!;
  assert.equal(rebound.account, 'second@example.com', 'the current binding moves');
  assert.equal(rebound.setupAccount, 'researcher@example.com', 'the identity it was created for is retained');
  const binding = agentBinding(moved, rebound);
  assert.equal(binding.setupIdentity, 'researcher@example.com');
  assert.equal(binding.boundIdentity, 'second@example.com');
  assert.equal(binding.rebound, true);
  assert.equal(binding.setupIdentityKnown, true);
  // The history says where it came from, not merely where it is now.
  assert.match(
    moved.events.find(e => e.kind === 'AGENT_CONNECTION_CHANGED')!.reason,
    /setup identity researcher@example\.com is retained/,
  );

  // Rebinding again keeps the original setup identity rather than the previous binding.
  const again = f.store.bindAgentConnection({
    agentId: agent.id,
    expectedRevision: 1,
    intent: 'CHANGE',
    observation: observation(12, 'third@example.com'),
  });
  const twice = again.agents.find(a => a.id === agent.id)!;
  assert.equal(twice.account, 'third@example.com');
  assert.equal(twice.setupAccount, 'researcher@example.com', 'the origin is the first account, not the previous one');

  // A profile saved before this distinction existed reports its origin as unknown rather than assuming.
  const legacy = agentBinding(f.store.snapshot(), {
    ...draft({ account: 'legacy@example.com' }),
    connectionId: undefined,
  });
  assert.equal(legacy.setupIdentityKnown, false);
  assert.equal(legacy.setupIdentity, 'legacy@example.com', 'the current account is the only thing recoverable');
});

test('a signed-in but unidentified session is one stable context, never a fake account, and verifies nothing', t => {
  const f = fixture(t);
  const agent = draft();
  f.store.confirmAgentBinding({ observation: observation(0), agent });
  // The tool reports sign-in but cannot name the account: repeated checks update one ''-identity
  // record instead of minting a new "account" each time the output format shifts.
  f.store.recordAccountObservation(observation(1, ''));
  const second = f.store.recordAccountObservation(observation(2, ''));
  assert.equal(
    second.connections!.filter(c => c.provider === 'claude' && c.identity === '').length,
    1,
    'unidentified polls share one record',
  );
  assert.equal(second.connections!.length, 2, 'the identified account record is preserved, not merged');
  const blocker = agentBinding(
    second,
    second.agents.find(a => a.id === agent.id)!,
  ).blockers[0];
  assert.match(blocker, /did not report an account identity/);
  assert.doesNotMatch(blocker, /no account/, 'the tool did report a session — "no account" would misdescribe it');
  // Binding operations refuse an unidentified session outright rather than binding to nobody.
  assert.throws(
    () =>
      f.store.bindAgentConnection({
        agentId: agent.id,
        expectedRevision: 0,
        intent: 'VERIFY',
        observation: observation(3, ''),
      }),
    /unidentified session/,
  );
  assert.throws(
    () =>
      f.store.bindAgentConnection({
        agentId: agent.id,
        expectedRevision: 0,
        intent: 'CHANGE',
        observation: observation(3, ''),
      }),
    /unidentified session/,
  );
  assert.throws(
    () => f.store.confirmAgentBinding({ observation: observation(4, ''), agent: draft() }),
    /unidentified session/,
  );
  // When the tool names the account again, the next check re-verifies the original binding.
  const healed = f.store.recordAccountObservation(observation(5));
  assert.equal(currentConnection(healed, 'claude')!.identity, 'researcher@example.com');
  assert.equal(
    agentBinding(
      healed,
      healed.agents.find(a => a.id === agent.id)!,
    ).available,
    true,
  );
});
