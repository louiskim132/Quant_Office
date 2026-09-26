import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { removeTreeSync } from '../src/main/fsx';
import type { Agent } from '../src/shared/types';

const key = () => randomUUID();

test('a result-analysis request may follow a planning request of its own project', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-analysis-link-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch { /* already closed */ } removeTreeSync(root); });
  const alpha = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects.find(p => p.name === 'Alpha')!;
  const beta = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Beta', mandate: 'm', budgetCents: 0 }).projects.find(p => p.name === 'Beta')!;
  const director: Agent = { id: randomUUID(), name: 'Director', provider: 'claude', model: 'opus', team: 'Research', role: 'DIRECTOR', instructions: '',
    account: 'director@example.com', createdAt: new Date().toISOString(), connectionVerifiedAt: new Date().toISOString(), execution: 'LOCAL' };
  store.addAgent(director);
  const create = (projectId: string, name: string, workType: 'PLANNING' | 'RESULT_ANALYSIS', analysisOfRequestId?: string) =>
    store.execute({ type: 'request.create', idempotencyKey: key(), projectId, name, hypothesis: 'h', workType, mode: 'SINGLE', leadAgentId: director.id, participantIds: [], ...(analysisOfRequestId ? { analysisOfRequestId } : {}) })
      .requests!.find(item => item.name === name)!;
  const plan = create(alpha.id, 'Plan ema5', 'PLANNING');
  const analysis = create(alpha.id, 'Analyze ema5', 'RESULT_ANALYSIS', plan.id);
  assert.deepEqual(analysis.analysisOf, { requestId: plan.id });
  assert.equal(create(alpha.id, 'Analyze free', 'RESULT_ANALYSIS').analysisOf, undefined, 'the link is optional');
  assert.throws(() => create(alpha.id, 'Plan follows plan', 'PLANNING', plan.id), /Only a result-analysis request/);
  assert.throws(() => create(beta.id, 'Cross-project', 'RESULT_ANALYSIS', plan.id), /planning request in this project/);
  assert.throws(() => create(alpha.id, 'Follows analysis', 'RESULT_ANALYSIS', analysis.id), /planning request in this project/);
});

test('a canceled plan or a request without a planning pipeline cannot be linked as analysisOf', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-analysis-link-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch { /* already closed */ } removeTreeSync(root); });
  const alpha = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects.find(p => p.name === 'Alpha')!;
  const director: Agent = { id: randomUUID(), name: 'Director', provider: 'claude', model: 'opus', team: 'Research', role: 'DIRECTOR', instructions: '',
    account: 'director@example.com', createdAt: new Date().toISOString(), connectionVerifiedAt: new Date().toISOString(), execution: 'LOCAL' };
  store.addAgent(director);
  const create = (projectId: string, name: string, workType: 'QUESTION' | 'PLANNING' | 'RESULT_ANALYSIS', analysisOfRequestId?: string) =>
    store.execute({ type: 'request.create', idempotencyKey: key(), projectId, name, hypothesis: 'h', workType, mode: 'SINGLE', leadAgentId: director.id, participantIds: [], ...(analysisOfRequestId ? { analysisOfRequestId } : {}) })
      .requests!.find(item => item.name === name)!;
  const live = create(alpha.id, 'Live plan', 'PLANNING');
  const canceled = create(alpha.id, 'Canceled plan', 'PLANNING');
  store.execute({ type: 'request.cancel', idempotencyKey: key(), requestId: canceled.id, expectedRevision: canceled.revision });
  assert.throws(() => create(alpha.id, 'Analyze canceled plan', 'RESULT_ANALYSIS', canceled.id), /live planning request/, 'a canceled plan is not a live planning target');
  const question = create(alpha.id, 'Plain question', 'QUESTION');
  assert.throws(() => create(alpha.id, 'Analyze question', 'RESULT_ANALYSIS', question.id), /live planning request/, 'a request with no planning pipeline is not a target');
  assert.throws(() => create(alpha.id, 'Question follows plan', 'QUESTION', live.id), /Only a result-analysis request/, 'the link is refused on workTypes other than RESULT_ANALYSIS');
  assert.equal(create(alpha.id, 'Analyze live plan', 'RESULT_ANALYSIS', live.id).analysisOf?.requestId, live.id, 'a live plan in this project still links');
});
