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
