import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LocalSessionRouter } from '../src/main/local-session-router';
import type { ProviderAdapter, SubmitContext, SubmitResult } from '../src/main/controller';
import type { LocalSessionRecord } from '../src/shared/local-session';
import type { ProviderJob } from '../src/shared/types';

const at = (n = 0) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + n * 60000).toISOString();

const job = (externalId = 'session-x'): ProviderJob => ({
  id: randomUUID(), assignmentId: randomUUID(), projectId: randomUUID(), requestId: randomUUID(),
  provider: 'devin', route: 'LOCAL_MAILBOX', state: 'ACCEPTED', evidence: 'PROVIDER_REPORTED',
  detail: '', externalId, externalUrl: '', outputs: [], revision: 0,
  createdAt: at(), updatedAt: at(), dispatchedAt: at(), settledAt: '',
});

const binding = (jobId: string, layout: LocalSessionRecord['layout']): LocalSessionRecord => ({
  schemaVersion: 1, id: randomUUID(), jobId, assignmentId: randomUUID(), projectId: randomUUID(), attemptId: randomUUID(),
  revision: 0, provider: 'devin', surface: 'UNKNOWN', layout, packetVersion: 2, packetHash: 'a'.repeat(64),
  storageRelativePath: layout === 'FLAT_PACKET' ? 'sessions/session-x' : 'repo/worktrees/session-x',
  originalCwd: null,
  repoRelativePath: layout === 'PROJECT_WORKTREE' ? 'repo' : null,
  seedCommit: layout === 'PROJECT_WORKTREE' ? 'a'.repeat(40) : null,
  worktreeOwner: layout === 'PROJECT_WORKTREE' ? 'OFFICE' : 'NONE',
  providerSessionId: null, providerProjectId: null, bindingEvidence: 'UNBOUND', groupingStatus: 'UNKNOWN',
  requirement: 'SCOPED_DELIVERY', confinementStatus: 'UNVERIFIED', confinementEvidenceId: null,
  lifecycle: 'READY', archiveRelativePath: null, lastReceipt: null, cancelRequestId: null,
  stopStatus: 'NOT_REQUESTED', createdAt: at(), updatedAt: at(),
});

class Stub implements ProviderAdapter {
  readonly route = 'LOCAL_MAILBOX' as const;
  observed: ProviderJob[] = [];
  observedLocal: (LocalSessionRecord | null | undefined)[] = [];
  cancelledLocal: (LocalSessionRecord | null | undefined)[] = [];
  fetchedLocal: (LocalSessionRecord | null | undefined)[] = [];
  constructor(private tag: string, private result: SubmitResult | null = null) {}
  async submit(_ctx: SubmitContext): Promise<SubmitResult> { return this.result ?? { externalId: this.tag, externalUrl: '', detail: `${this.tag} wrote the packet` }; }
  async observe(j: ProviderJob, local?: LocalSessionRecord | null) { this.observed.push(j); this.observedLocal.push(local); return { state: 'RUNNING' as const, detail: `${this.tag} observing` }; }
  async cancel(_j: ProviderJob, local?: LocalSessionRecord | null) { this.cancelledLocal.push(local); return { acknowledged: true, detail: `${this.tag} cancelled` }; }
  async fetch(_j: ProviderJob, _o: { path: string; sha256: string; bytes: number }, local?: LocalSessionRecord | null) { this.fetchedLocal.push(local); return new Uint8Array(0); }
}

test('a bound job routes every operation to its recorded layout, never the other one', async () => {
  const flat = new Stub('flat'), tree = new Stub('worktree');
  const j = job();
  const bound = binding(j.id, 'PROJECT_WORKTREE');
  const router = new LocalSessionRouter(id => id === j.id ? bound : null, { FLAT_PACKET: flat, PROJECT_WORKTREE: tree });
  const observed = await router.observe(j);
  assert.equal(observed.detail, 'worktree observing');
  assert.deepEqual(flat.observed, [], 'the flat adapter must not touch a worktree-bound job');
  assert.deepEqual(tree.observedLocal, [bound], 'the resolved binding must ride with the job');
  await router.cancel(j);
  assert.deepEqual(tree.cancelledLocal, [bound]);
  await router.fetch(j, { path: 'outputs/a.txt', sha256: 'a'.repeat(64), bytes: 1 });
  assert.deepEqual(tree.fetchedLocal, [bound], 'fetch validates bytes against the bound storage path');
});

test('an unbound legacy job resolves to the flat adapter with the rule named in the observation', async () => {
  const flat = new Stub('flat'), tree = new Stub('worktree');
  const router = new LocalSessionRouter(() => null, { FLAT_PACKET: flat, PROJECT_WORKTREE: tree });
  const observed = await router.observe(job());
  assert.match(observed.detail, /legacy binding.*flat packet/i);
  assert.equal(tree.observed.length, 0);
  assert.deepEqual(flat.observedLocal, [null], 'a legacy job arrives explicitly unbound');
});

test('submit without a binding refuses rather than guessing a layout', async () => {
  const router = new LocalSessionRouter(() => null, { FLAT_PACKET: new Stub('flat'), PROJECT_WORKTREE: new Stub('tree') });
  await assert.rejects(router.submit({} as SubmitContext), /persisted local-session binding/);
});

test('submit delegates to the layout the binding declares', async () => {
  const flat = new Stub('flat'), tree = new Stub('worktree');
  const router = new LocalSessionRouter(() => null, { FLAT_PACKET: flat, PROJECT_WORKTREE: tree });
  const ctx = { localSession: binding(randomUUID(), 'PROJECT_WORKTREE') } as SubmitContext;
  const result = await router.submit(ctx);
  assert.equal(result.externalId, 'worktree');
});

test('retire resolves through the job binding and refuses cleanly when the layout cannot', async () => {
  const flat = new Stub('flat'), tree = new Stub('worktree');
  const j = job('session-x');
  const router = new LocalSessionRouter(id => id === j.id ? binding(id, 'FLAT_PACKET') : null, { FLAT_PACKET: flat, PROJECT_WORKTREE: tree });
  const refused = await router.retire(j);
  assert.equal(refused.retired, false, 'stubs carry no retire operation');
  const jobless = await router.retire({ ...j, externalId: '' });
  assert.equal(jobless.retired, false);
});
