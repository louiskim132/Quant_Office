import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ACCEPTANCE_MARKER,
  dispatchAcceptance,
  requireScratch,
  sameJobs,
  scratchPath,
  verifyProbe,
} from '../scripts/isolation-dispatch-acceptance.js';
import type { OfficeAPI, ProviderJob } from '../src/shared/types.js';

test('dispatch requires explicit scratch marker before any IPC or provider operation', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let contacted = 0;
  await assert.rejects(
    dispatchAcceptance({
      root,
      provider: 'openai',
      api: () => {
        contacted++;
        return {} as OfficeAPI;
      },
      restart: async () => {},
    }),
  );
  assert.equal(contacted, 0);
  writeFileSync(
    path.join(root, ACCEPTANCE_MARKER),
    JSON.stringify({ version: 1, purpose: 'SYNTHETIC_ISOLATION_ACCEPTANCE' }),
  );
  assert.doesNotThrow(() => requireScratch(root));
  mkdirSync(path.join(root, 'userData', 'workspace'), { recursive: true });
  assert.equal(scratchPath(root, path.join(root, 'userData')), path.join(root, 'userData'));
  assert.throws(() => scratchPath(root, path.dirname(root)), /scratch root/);
});

test('missing isolated setup emits NOT_RUN evidence and never launches a provider', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'userData', 'workspace'), { recursive: true });
  writeFileSync(
    path.join(root, ACCEPTANCE_MARKER),
    JSON.stringify({ version: 1, purpose: 'SYNTHETIC_ISOLATION_ACCEPTANCE' }),
  );
  let launches = 0;
  const api = {
    getInfo: async () => ({ dataDirectory: path.join(root, 'userData', 'workspace') }),
    getState: async () => ({ projects: [] }),
    agentIsolationStatus: async () => ({ configured: false }),
    openHandoffTerminal: async () => {
      launches++;
    },
  } as unknown as OfficeAPI;
  const report = await dispatchAcceptance({ root, provider: 'openai', api: () => api, restart: async () => {} });
  assert.equal(launches, 0);
  for (const check of ['dispatch', 'identityAndDenial', 'durableOutput', 'wholeTreeCancel', 'restartNonduplication'])
    assert.equal(report[check], 'NOT_RUN');
  assert.match(String(report.error), /not configured/);
});

test('probe claims require exact nonce, account and denied flag; restart comparison detects added attempts', () => {
  const good = { nonce: 'test-nonce', whoami: 'machine\\qro-agent', officePathDenied: true };
  assert.equal(verifyProbe(JSON.stringify(good), 'test-nonce'), true);
  assert.equal(verifyProbe(JSON.stringify({ ...good, whoami: 'office' }), 'test-nonce'), false);
  assert.equal(verifyProbe(JSON.stringify({ ...good, officePathDenied: false }), 'test-nonce'), false);
  assert.equal(verifyProbe(JSON.stringify(good), 'wrong-nonce'), false);
  const job = { id: 'job1', assignmentId: 'assignment1', externalId: 'session1' } as ProviderJob;
  assert.equal(sameJobs([job], [{ ...job, state: 'COMPLETED' }]), true);
  assert.equal(sameJobs([job], [job, { ...job, id: 'job2' }]), false);
  assert.equal(sameJobs([job], [{ ...job, externalId: 'session2' }]), false);
});
