import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { AssignmentController, type ProviderAdapter } from '../src/main/controller';
import { prepareInputSnapshot } from '../src/main/locations';
import { OutputService } from '../src/main/outputs';
import { removeTreeSync } from '../src/main/fsx';
import { agentDispatchReadiness, providerReadiness, scopeMismatches, type RequestedScope } from '../src/shared/readiness';
import type { AdapterRoute, Agent, CapabilityEvidence, CapabilityOperation, ProviderJob } from '../src/shared/types';

/**
 * C9 local-agent contract coverage (roadmap section 10): the dispatch evidence family follows the
 * recorded route and never the other one, the per-route adapter resolver fails closed instead of
 * falling back or fabricating an outcome, a pre-C9 agent record keeps its hosted meaning through
 * the store schema default, and a reopened store can never dispatch recorded work a second time.
 * Everything runs against the real store and controller; only the provider adapters are doubles.
 */

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const ms = (minutes: number) => Date.parse(at(minutes));
const CLOUD: CapabilityOperation[] = ['CLOUD_SUBMIT', 'CLOUD_OBSERVE', 'CLOUD_OUTPUT_FETCH', 'CLOUD_CANCEL_REQUEST', 'CLOUD_CANCEL_ACK', 'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'ENVIRONMENT_IDENTITY', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT'];
const LOCAL: CapabilityOperation[] = ['LOCAL_SUBMIT', 'LOCAL_OBSERVE', 'LOCAL_OUTPUT_FETCH', 'LOCAL_CANCEL', 'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT'];
const CLOUD_ROUTES = ['FAKE_ADAPTER', 'OFFICIAL_TERMINAL_HANDOFF', 'OFFICIAL_CLI_PTY'] as const;
const CONFINED = { tools: 'Only the read-only fixture tools were offered.', filesystem: 'Confined to the staged snapshot directory.', network: 'No outbound network was reachable from the session.', environment: 'anthropic-managed' };
const LOCAL_CONFINED = { tools: 'The office wrote only the declared packet.', filesystem: 'The scoped workspace folder only.', network: 'No outbound network was reachable from the session.', environment: 'office-local' };
const seen = (operation: CapabilityOperation, minutes: number, extra: Partial<CapabilityEvidence> = {}): CapabilityEvidence =>
  ({ operation, level: 'ACCOUNT_VERIFIED', detail: 'Exercised.', evidence: 'OBSERVED', verifiedAt: at(minutes), source: 'fixture', ...extra });

/** The exact conditions one piece of work would run under, as the readiness layer asks them. */
const requestedScope = (route: AdapterRoute, environment: string): RequestedScope => ({
  provider: 'claude', identity: 'researcher@example.com', credentialContext: 'claude-code-cli',
  toolVersion: '2.1.236', route, environment, model: 'opus', effort: 'default', delegation: false,
});

/** Every hosted operation exercised through every cloud route, as a transport check would record. */
const cloudObservation = (minutes: number) => ({
  provider: 'claude' as const, identity: 'researcher@example.com', credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const, allowance: [], note: '', toolVersion: '2.1.236',
  transport: 'OFFICIAL_CLI_TERMINAL' as const, environment: 'anthropic-managed', models: [{ id: 'opus', name: 'Opus' }],
  operations: [seen('ACCOUNT_STATUS', minutes), seen('MODEL_CATALOG', minutes),
    ...CLOUD.flatMap(o => CLOUD_ROUTES.flatMap(route => o === 'DELEGATION_CONTROL'
      ? [seen(o, minutes, { model: 'opus', route, delegation: false }), seen(o, minutes, { model: 'opus', route, delegation: true })]
      : o === 'EFFORT_APPLICATION' ? [seen(o, minutes, { model: 'opus', route, effort: 'default' })]
      : o === 'TOOL_CONFINEMENT' ? [seen(o, minutes, { model: 'opus', route, confinement: CONFINED })]
      : [seen(o, minutes, { model: 'opus', route })]))],
  source: 'transport fixture', observedAt: at(minutes),
});

/**
 * An office-observed local session check. Local evidence is TOOL_SUPPORTED/OBSERVED by contract —
 * the office saw its own transport work — never an ACCOUNT_VERIFIED provider attestation. The
 * `level` override exists so tests can isolate the hosted-execution guard from the evidence gate.
 */
const localObservation = (minutes: number, level: CapabilityEvidence['level'] = 'TOOL_SUPPORTED') => ({
  provider: 'claude' as const, identity: 'researcher@example.com', credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const, allowance: [], note: '', toolVersion: '2.1.236',
  transport: 'LOCAL_MAILBOX' as const, environment: 'office-local', models: [{ id: 'opus', name: 'Opus' }],
  operations: [seen('ACCOUNT_STATUS', minutes), seen('MODEL_CATALOG', minutes),
    ...LOCAL.flatMap(o => o === 'DELEGATION_CONTROL'
      ? [seen(o, minutes, { level, model: 'opus', route: 'LOCAL_MAILBOX' as const, delegation: false })]
      : o === 'EFFORT_APPLICATION' ? [seen(o, minutes, { level, model: 'opus', route: 'LOCAL_MAILBOX' as const, effort: 'default' })]
      : o === 'TOOL_CONFINEMENT' ? [seen(o, minutes, { level, model: 'opus', route: 'LOCAL_MAILBOX' as const, confinement: LOCAL_CONFINED })]
      : [seen(o, minutes, { level, model: 'opus', route: 'LOCAL_MAILBOX' as const })])],
  source: 'local session fixture', observedAt: at(minutes),
});

/** A test double bound to one route; the counters show which adapter each call actually landed on. */
class FakeAdapter implements ProviderAdapter {
  submits = 0; observes = 0; cancels = 0;
  constructor(readonly route: AdapterRoute) {}
  async submit() { this.submits++; return { externalId: 'session_fixture_1', externalUrl: 'https://example.invalid/session_fixture_1', detail: 'Accepted by the fixture provider.' }; }
  async observe(_job: ProviderJob) { this.observes++; return { state: 'RUNNING' as const, detail: 'Working.' }; }
  async cancel(_job: ProviderJob) { this.cancels++; return { acknowledged: true, detail: 'Provider acknowledged the cancellation.' }; }
}

type Resolver = (ref: { agent?: Agent; route?: AdapterRoute }) => ProviderAdapter | undefined;

async function fixture(t: any, options: { adapter?: FakeAdapter; resolver?: Resolver; observation?: unknown } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-agents-'));
  const file = path.join(root, 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => { try { store.close(); } catch { /* reopened or already closed */ } removeTreeSync(root); });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'input.csv'), 'a,b\n1,2\n');
  store.execute({ type: 'location.save', idempotencyKey: key(), projectId: project.id, expectedRevision: 0, localFolder: source, inputPaths: ['input.csv'], outputFolder: '' });
  const agent: Agent = { id: randomUUID(), name: 'Sole worker', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER',
    instructions: '', effort: 'default', account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'HOSTED_SETUP_REQUIRED' };
  store.confirmAgentBinding({ observation: options.observation ?? cloudObservation(0), agent });
  const request = store.execute({ type: 'request.create', idempotencyKey: key(), projectId: project.id, name: 'Tiny question',
    hypothesis: 'Explain the fixture', workType: 'QUESTION', mode: 'SINGLE', leadAgentId: agent.id, participantIds: [] }).requests![0];
  const snapshot = await prepareInputSnapshot({ store, objectRoot: root, stagingRoot: path.join(root, 'staging'), projectId: project.id, requestId: request.id, requestRevision: request.revision });
  // One injected clock, held inside the account-freshness window, so results never depend on the
  // calendar date the suite happens to run on.
  let tick = 0;
  const clock = () => at(++tick / 60);
  const adapter = options.adapter ?? new FakeAdapter('FAKE_ADAPTER');
  let controller = new AssignmentController(store, adapter, clock, undefined, undefined, undefined, undefined, new OutputService(store, root).storeBytes, undefined, options.resolver);
  return {
    root, project, agent, request, snapshot, adapter,
    get store() { return store; }, get controller() { return controller; },
    storedAgent: (id: string) => store.snapshot({ history: false }).agents.find(item => item.id === id)!,
    job: (assignmentId?: string): ProviderJob => {
      const jobs = store.snapshot({ history: false }).jobs ?? [];
      return assignmentId ? jobs.find(item => item.assignmentId === assignmentId)! : jobs[0];
    },
    /** A second request with its own prepared inputs, so a second agent can hold an assignment. */
    async addWork(assignee: Agent) {
      const known = new Set((store.snapshot({ history: false }).requests ?? []).map(item => item.id));
      const second = store.execute({ type: 'request.create', idempotencyKey: key(), projectId: project.id, name: 'Second question',
        hypothesis: 'Explain the fixture', workType: 'QUESTION', mode: 'SINGLE', leadAgentId: assignee.id, participantIds: [] }).requests!.find(item => !known.has(item.id))!;
      const inputs = await prepareInputSnapshot({ store, objectRoot: root, stagingRoot: path.join(root, 'staging'), projectId: project.id, requestId: second.id, requestRevision: second.revision });
      return { request: second, snapshot: inputs };
    },
    restart(nextAdapter?: FakeAdapter, nextResolver?: Resolver) {
      store.close();
      store = new OfficeStore(file);
      controller = new AssignmentController(store, nextAdapter ?? adapter, clock, undefined, undefined, undefined, undefined, new OutputService(store, root).storeBytes, undefined, nextResolver ?? options.resolver);
      return { store, controller };
    },
  };
}

test('a local-mailbox assignment is gated on local-session evidence; hosted evidence never substitutes', async t => {
  const local = new FakeAdapter('LOCAL_MAILBOX');
  const f = await fixture(t, {
    resolver: ref => ref.agent ? local : ref.route === 'LOCAL_MAILBOX' ? local : undefined,
  });
  const prepared = f.controller.prepare({ requestId: f.request.id, agentId: f.agent.id, snapshotId: f.snapshot.id });
  assert.equal(prepared.assignment.route, 'LOCAL_MAILBOX');
  assert.equal(f.job(prepared.assignment.id).route, 'LOCAL_MAILBOX', 'the recorded route is the durable fact');

  // Under cloud-only evidence the local family has nothing, and the exact-scope check refuses.
  await assert.rejects(f.controller.dispatch(prepared.assignment.id), /not verified for the exact conditions it would run under.*Unverified local session submission/s);
  assert.equal(f.job(prepared.assignment.id).state, 'INTENT');
  assert.equal(local.submits, 0);
  let state = f.store.snapshot({ history: false });
  assert.equal(providerReadiness(state, 'claude', { now: ms(1), route: 'LOCAL_MAILBOX', model: 'opus' }).dispatchChecked, false);
  assert.equal(providerReadiness(state, 'claude', { now: ms(1), route: 'OFFICIAL_TERMINAL_HANDOFF', model: 'opus' }).dispatchChecked, true,
    'the same account is verified for the hosted family at the same moment');

  // A local observation is recorded at the strongest level — yet the frozen scope still names the
  // hosted environment, so evidence taken under 'office-local' cannot answer for it.
  f.store.recordAccountObservation(localObservation(0, 'ACCOUNT_VERIFIED'));
  await assert.rejects(f.controller.dispatch(prepared.assignment.id), /not verified for the exact conditions it would run under.*Unverified local session submission/s);
  assert.equal(local.submits, 0);

  // Re-preparing freezes the local capability, so the local scope is then fully satisfied — and
  // dispatch still stops, at the hosted-execution guard. The boundary is the execution environment
  // itself: no volume of local-session evidence turns a recorded route into a provider-hosted launch.
  f.controller.discardPreparation(prepared.assignment.id);
  const relaunched = f.controller.prepare({ requestId: f.request.id, agentId: f.agent.id, snapshotId: f.snapshot.id });
  assert.equal(relaunched.assignment.route, 'LOCAL_MAILBOX');
  assert.notEqual(relaunched.assignment.capabilitySnapshotId, prepared.assignment.capabilitySnapshotId);
  state = f.store.snapshot({ history: false });
  assert.deepEqual(scopeMismatches(state, requestedScope('LOCAL_MAILBOX', 'office-local'), { now: ms(1) }), []);
  await assert.rejects(f.controller.dispatch(relaunched.assignment.id), /provider-hosted execution is allowed; no local/);
  assert.equal(local.submits, 0);
  assert.equal(f.job(relaunched.assignment.id).state, 'INTENT');
});

test('local-session evidence satisfies only the local scope; a hosted route still requires the cloud family', async t => {
  const local = new FakeAdapter('LOCAL_MAILBOX');
  const handoff = new FakeAdapter('OFFICIAL_TERMINAL_HANDOFF');
  let localAgentId = '';
  const f = await fixture(t, {
    observation: localObservation(0),
    resolver: ref => ref.agent
      ? (ref.agent.id === localAgentId ? local : handoff)
      : ref.route === 'LOCAL_MAILBOX' ? local : ref.route === 'OFFICIAL_TERMINAL_HANDOFF' ? handoff : undefined,
  });
  const state = f.store.snapshot({ history: false });
  // The office's own local evidence is visible to the check and still unverified at its honest
  // level, so even the local scope reports it rather than treating it as proof.
  const localProblems = scopeMismatches(state, requestedScope('LOCAL_MAILBOX', 'office-local'), { now: ms(1) });
  assert.ok(localProblems.length > 0);
  assert.ok(localProblems.every(problem => /tool supported, observed/.test(problem)));
  // The hosted route's family holds nothing at all — the local records are not consulted for it.
  const handoffProblems = scopeMismatches(state, requestedScope('OFFICIAL_TERMINAL_HANDOFF', 'office-local'), { now: ms(1) });
  assert.ok(handoffProblems.length > 0);
  assert.ok(handoffProblems.every(problem => /no evidence recorded for these conditions/.test(problem)));
  assert.equal(providerReadiness(state, 'claude', { now: ms(1), route: 'LOCAL_MAILBOX', model: 'opus' }).dispatchChecked, false);
  assert.equal(providerReadiness(state, 'claude', { now: ms(1), route: 'OFFICIAL_TERMINAL_HANDOFF', model: 'opus' }).dispatchChecked, false);

  // A hosted-route assignment under local-only evidence cannot start: the cloud family is unverified.
  const prepared = f.controller.prepare({ requestId: f.request.id, agentId: f.agent.id, snapshotId: f.snapshot.id });
  assert.equal(prepared.assignment.route, 'OFFICIAL_TERMINAL_HANDOFF');
  const hostedGate = agentDispatchReadiness(f.store.snapshot({ history: false }), f.storedAgent(f.agent.id), { now: ms(1) });
  assert.equal(hostedGate.canStart, false);
  assert.ok(hostedGate.blockers.some(blocker => /Unverified cloud submission/.test(blocker)));
  await assert.rejects(f.controller.dispatch(prepared.assignment.id), /Automatic start is blocked/);
  assert.equal(handoff.submits, 0);
  assert.equal(f.job(prepared.assignment.id).state, 'INTENT');

  // A LOCAL agent under the same records is gated on the office-observed local transport evidence,
  // which at TOOL_SUPPORTED never verifies — so a local launch is honestly blocked too.
  const localAgent: Agent = { id: randomUUID(), name: 'Local worker', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER',
    instructions: '', effort: 'default', account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL' };
  f.store.confirmAgentBinding({ observation: localObservation(0), agent: localAgent });
  localAgentId = localAgent.id;
  const work = await f.addWork(localAgent);
  const preparedLocal = f.controller.prepare({ requestId: work.request.id, agentId: localAgent.id, snapshotId: work.snapshot.id });
  assert.equal(preparedLocal.assignment.route, 'LOCAL_MAILBOX');
  const localGate = agentDispatchReadiness(f.store.snapshot({ history: false }), f.storedAgent(localAgent.id), { now: ms(1) });
  assert.equal(localGate.canStart, false);
  assert.ok(localGate.blockers.some(blocker => /local session submission/.test(blocker)));
  await assert.rejects(f.controller.dispatch(preparedLocal.assignment.id), /Automatic start is blocked/);
  assert.equal(local.submits, 0);
});

test('a resolver miss is a hard failure at every use; nothing falls back or fabricates an outcome', async t => {
  // No adapter configured for the agent's work: preparation itself refuses.
  const unconfigured = await fixture(t, { resolver: () => undefined });
  assert.throws(
    () => unconfigured.controller.prepare({ requestId: unconfigured.request.id, agentId: unconfigured.agent.id, snapshotId: unconfigured.snapshot.id }),
    /No adapter is configured for claude work/);
  assert.equal(unconfigured.store.snapshot({ history: false }).assignments, undefined);

  // The agent resolves but the recorded route does not: every later use fails closed.
  const fake = new FakeAdapter('FAKE_ADAPTER');
  const g = await fixture(t, { adapter: fake, resolver: ref => ref.agent ? fake : undefined });
  const prepared = g.controller.prepare({ requestId: g.request.id, agentId: g.agent.id, snapshotId: g.snapshot.id });
  assert.equal(prepared.assignment.route, 'FAKE_ADAPTER');
  await assert.rejects(g.controller.dispatch(prepared.assignment.id), /No adapter is configured for the fake adapter route/);
  assert.equal(g.job(prepared.assignment.id).state, 'INTENT');
  assert.equal(fake.submits, 0);
  await assert.rejects(g.controller.observe(prepared.assignment.id), /No adapter is configured for the fake adapter route/);

  // The resolver disappears after dispatch: the recorded cancellation request stays durable and
  // honest — pending, never a fabricated acknowledgement.
  let live = true;
  const routed = new FakeAdapter('FAKE_ADAPTER');
  const h = await fixture(t, { adapter: routed, resolver: () => live ? routed : undefined });
  const work = h.controller.prepare({ requestId: h.request.id, agentId: h.agent.id, snapshotId: h.snapshot.id });
  await h.controller.dispatch(work.assignment.id);
  assert.equal(h.job(work.assignment.id).state, 'ACCEPTED');
  assert.equal(routed.submits, 1);
  live = false;
  await assert.rejects(h.controller.observe(work.assignment.id), /No adapter is configured for the fake adapter route/);
  await assert.rejects(h.controller.cancel(work.assignment.id), /No adapter is configured for the fake adapter route/);
  assert.equal(routed.cancels, 0, 'the provider was never asked');
  assert.equal(h.job(work.assignment.id).state, 'CANCEL_REQUESTED', 'the request stays durable and pending');
});

test('dispatch, observe and cancel resolve through the adapter that owns the recorded route', async t => {
  const positional = new FakeAdapter('FAKE_ADAPTER');
  const routed = new FakeAdapter('FAKE_ADAPTER');
  const refs: { agent?: Agent; route?: AdapterRoute }[] = [];
  const f = await fixture(t, {
    adapter: positional,
    resolver: ref => { refs.push(ref); return ref.agent ? routed : ref.route === 'FAKE_ADAPTER' ? routed : undefined; },
  });
  const prepared = f.controller.prepare({ requestId: f.request.id, agentId: f.agent.id, snapshotId: f.snapshot.id });
  // The agent is asked once, at preparation; everything after resolves by the recorded route.
  assert.equal(refs.length, 1);
  assert.equal(refs[0].agent?.id, f.agent.id);
  assert.equal(refs[0].route, undefined);
  await f.controller.dispatch(prepared.assignment.id);
  await f.controller.observe(prepared.assignment.id);
  await f.controller.cancel(prepared.assignment.id);
  assert.ok(refs.slice(1).every(ref => ref.route === 'FAKE_ADAPTER' && ref.agent === undefined));
  assert.equal(routed.submits, 1);
  assert.equal(routed.observes, 1);
  assert.equal(routed.cancels, 1);
  assert.equal(positional.submits + positional.observes + positional.cancels, 0, 'the positional adapter was never used once a resolver was configured');
  assert.equal(f.job(prepared.assignment.id).state, 'CANCEL_ACKNOWLEDGED');

  // A controller without a resolver keeps the single-adapter behavior every existing call site has.
  const plain = await fixture(t);
  const work = plain.controller.prepare({ requestId: plain.request.id, agentId: plain.agent.id, snapshotId: plain.snapshot.id });
  await plain.controller.dispatch(work.assignment.id);
  assert.equal(plain.adapter.submits, 1);
});

test('a pre-C9 agent record parses through the store schema as hosted execution, unchanged and unrelocated', async t => {
  const f = await fixture(t);
  // What a pre-C9 workspace stored: the same profile with no execution field at all.
  const legacy = JSON.parse(JSON.stringify({
    id: randomUUID(), name: 'Pre-C9 worker', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER',
    instructions: 'migrated', effort: 'default', account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0),
  })) as Agent;
  f.store.addAgent(legacy);
  const saved = f.storedAgent(legacy.id);
  assert.equal(saved.execution, 'HOSTED_SETUP_REQUIRED');
  for (const [field, value] of Object.entries(legacy)) assert.deepEqual(saved[field as keyof Agent], value);
  assert.equal(saved.connectionId, undefined, 'no account context was invented for the record');

  // The binding path agents were created by applies the same default.
  const rebound = JSON.parse(JSON.stringify({
    id: randomUUID(), name: 'Bound pre-C9 worker', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER',
    instructions: '', effort: 'default', account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0),
  })) as Agent;
  f.store.confirmAgentBinding({ observation: cloudObservation(0), agent: rebound });
  const stored = f.storedAgent(rebound.id);
  assert.equal(stored.execution, 'HOSTED_SETUP_REQUIRED');
  assert.ok(stored.connectionId, 'the binding still lands');

  // Readiness gates the migrated record on the hosted family, never the local one: under verified
  // cloud evidence it can start, while an explicit LOCAL sibling is blocked on local evidence.
  const state = f.store.snapshot({ history: false });
  assert.equal(agentDispatchReadiness(state, stored, { now: ms(1) }).canStart, true);
  const localSibling: Agent = { id: randomUUID(), name: 'Local sibling', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER',
    instructions: '', effort: 'default', account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL' };
  f.store.confirmAgentBinding({ observation: cloudObservation(0), agent: localSibling });
  const localGate = agentDispatchReadiness(f.store.snapshot({ history: false }), f.storedAgent(localSibling.id), { now: ms(1) });
  assert.equal(localGate.canStart, false);
  assert.ok(localGate.blockers.some(blocker => /local session submission/.test(blocker)));

  // The default is durable: it survives a close and reopen of the same store.
  const again = f.restart();
  assert.equal(again.store.snapshot({ history: false }).agents.find(item => item.id === legacy.id)!.execution, 'HOSTED_SETUP_REQUIRED');
});

test('a prepared assignment survives a store reopen and can never dispatch twice', async t => {
  const f = await fixture(t);
  const prepared = f.controller.prepare({ requestId: f.request.id, agentId: f.agent.id, snapshotId: f.snapshot.id });
  const first = f.restart();
  // An undispatched intent needs no provider contact; the preparation is durable.
  assert.deepEqual(await first.controller.reconcile(), []);
  assert.equal(f.job(prepared.assignment.id).state, 'INTENT');
  await first.controller.dispatch(prepared.assignment.id);
  assert.equal(f.job(prepared.assignment.id).state, 'ACCEPTED');
  assert.equal(f.adapter.submits, 1);
  const externalId = f.job(prepared.assignment.id).externalId;
  await assert.rejects(first.controller.dispatch(prepared.assignment.id), /cannot move from ACCEPTED to SUBMITTING/);
  assert.equal(f.adapter.submits, 1);

  // Across another reopen the recorded dispatch still stands: reconciliation observes the open
  // job rather than resubmitting it, and a third dispatch attempt is refused before any call.
  const second = f.restart();
  const results = await second.controller.reconcile();
  assert.equal(results[0].action, 'OBSERVE');
  assert.equal(f.job(prepared.assignment.id).state, 'RUNNING');
  assert.equal(f.job(prepared.assignment.id).externalId, externalId);
  await assert.rejects(second.controller.dispatch(prepared.assignment.id), /cannot move from RUNNING to SUBMITTING/);
  assert.equal(f.adapter.submits, 1, 'a reopened office reconciles; it never resubmits recorded work');
});
