import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { OfficeStore } from '../src/core/store';
import { EvidenceService } from '../src/main/evidence';
import { removeTreeSync } from '../src/main/fsx';
import type { Agent } from '../src/shared/types';

test('section 8.4 measured retrieval experiment preserves all planted findings and explicit expansion', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-measured-')),
    store = new OfficeStore(path.join(root, 'workspace.sqlite'), { includeHistoryInResults: false });
  t.after(() => {
    store.close();
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Synthetic measurement',
    mandate: 'Known answers only',
    budgetCents: 0,
  }).projects[0];
  const other = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Private control',
    mandate: 'No disclosure',
    budgetCents: 0,
  }).projects[1];
  const now = new Date().toISOString(),
    agent: Agent = {
      id: randomUUID(),
      name: 'Fixture reader',
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      account: 'fixture',
      createdAt: now,
      connectionVerifiedAt: now,
      execution: 'HOSTED_SETUP_REQUIRED',
    };
  store.addAgent(agent);
  const request = store.execute({
    type: 'request.create',
    idempotencyKey: randomUUID(),
    projectId: project.id,
    name: 'Known-answer audit',
    hypothesis: 'Read exact evidence',
    workType: 'ANALYSIS',
    mode: 'GROUP',
    leadAgentId: agent.id,
    participantIds: [],
  }).requests![0];
  store.execute({
    type: 'request.grant',
    idempotencyKey: randomUUID(),
    requestId: request.id,
    agentId: agent.id,
    capacity: 'WORKER',
    granted: true,
  });
  const put = (projectId: string, name: string, body: string) => {
    const bytes = Buffer.from(body),
      hash = createHash('sha256').update(bytes).digest('hex'),
      file = path.join(root, 'objects', hash.slice(0, 2), hash);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    store.addArtifact({
      id: randomUUID(),
      projectId,
      experimentId: null,
      name,
      sha256: hash,
      size: bytes.length,
      kind: 'RESULT',
      classification: 'USER_ATTESTED',
      status: 'QUARANTINED',
      createdAt: now,
      mediaType: 'text/plain',
      note: 'Planted synthetic fixture',
    });
    return hash;
  };
  const defects = [
    'LEAKAGE',
    'OMITTED_FAILED_FOLD',
    'COST_SIGN_UNIT',
    'RARE_SEGMENT_LOSS',
    'CONTRADICTORY_OUTPUT',
    'STALE_CACHE',
    'WRONG_SOURCE_INDEX',
  ];
  const hashes = defects.map((defect, i) =>
    put(
      project.id,
      'diagnostic-' + i + '.txt',
      Array.from({ length: 2000 }, (_, row) =>
        row === 1500
          ? 'AUDIT_DEFECT ' + defect + ' exact_source=' + i
          : 'synthetic record ' + row + ' verified neutral control',
      ).join('\n'),
    ),
  );
  const privateHash = put(other.id, 'private.txt', 'AUDIT_DEFECT PRIVATE_CONTROL');
  for (let i = 0; i < 128; i++) put(project.id, 'inventory-' + i + '.txt', 'neutral inventory ' + i);
  const evidence = new EvidenceService(store, root);
  const measure = async (mode: 'FULL_CONTEXT' | 'ON_DEMAND') => {
    const start = performance.now();
    let bytes = 0,
      retrievals = 0,
      expansions = 0;
    const findings = new Set<string>();
    const inspect = (text: string) => {
      for (const defect of defects) if (text.includes('AUDIT_DEFECT ' + defect)) findings.add(defect);
    };
    for (const hash of hashes) {
      const result = await evidence.read({
        agentId: agent.id,
        objectHash: hash,
        limit: mode === 'FULL_CONTEXT' ? 2000 : 20,
      });
      bytes += Buffer.byteLength(JSON.stringify(result));
      retrievals++;
      inspect(result.lines.join('\n'));
      if (mode === 'ON_DEMAND') assert.equal(result.coverage, 'PARTIAL');
    }
    if (mode === 'ON_DEMAND') {
      const search = await evidence.query({
        agentId: agent.id,
        projectId: project.id,
        pattern: 'AUDIT_DEFECT',
        limit: 500,
      });
      retrievals++;
      bytes += Buffer.byteLength(JSON.stringify(search));
      inspect(JSON.stringify(search));
      assert.equal(search.coverage, 'COMPLETE');
      assert.ok(!JSON.stringify(search).includes('PRIVATE_CONTROL'));
      // Expansion must recover a critical fact omitted from the initial 20-line brief.
      const expanded = await evidence.read({ agentId: agent.id, objectHash: hashes[3], from: 1498, limit: 8 });
      retrievals++;
      expansions++;
      bytes += Buffer.byteLength(JSON.stringify(expanded));
      assert.match(expanded.lines.join('\n'), /RARE_SEGMENT_LOSS/);
    }
    return {
      mode,
      elapsedMs: performance.now() - start,
      returnedBytes: bytes,
      retrievals,
      expansions,
      findings: [...findings].sort(),
      inputTokens: null,
      outputTokens: null,
      cacheTokens: null,
      retries: 0,
      userInterventions: 0,
    };
  };
  const baseline = await measure('FULL_CONTEXT'),
    onDemand = await measure('ON_DEMAND');
  assert.deepEqual(baseline.findings, defects.slice().sort());
  assert.deepEqual(onDemand.findings, baseline.findings);
  await assert.rejects(evidence.read({ agentId: agent.id, objectHash: privateHash }));
  const changed = put(project.id, 'new-source.txt', 'AUDIT_DEFECT NEW_SOURCE');
  const refreshed = await evidence.query({
    agentId: agent.id,
    projectId: project.id,
    pattern: 'AUDIT_DEFECT',
    limit: 500,
  });
  assert.match(JSON.stringify(refreshed), /NEW_SOURCE/);
  store.execute({
    type: 'request.grant',
    idempotencyKey: randomUUID(),
    requestId: request.id,
    agentId: agent.id,
    capacity: 'WORKER',
    granted: false,
  });
  await assert.rejects(evidence.read({ agentId: agent.id, objectHash: hashes[0], limit: 20 }));
  mkdirSync('test-output', { recursive: true });
  writeFileSync(
    'test-output/evidence-experiment.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: 'VERIFIED_LOCAL_RETRIEVAL',
        inventoryObjects: 137,
        diagnosticFixtureGeneration: 'synthetic deterministic',
        model: null,
        modelSettings: null,
        taskBudget: 'same seven known-answer defects; deterministic reader',
        baseline,
        onDemand,
        criticalCoverage: 7,
        failures: [],
        unknownCounters: ['provider input/output/cache tokens', 'model quality', 'hosted latency'],
        externalRemaining:
          'Same-model stochastic provider comparison requires authorized verified provider execution. No token or model-quality savings claimed.',
        optionalOptimizer: 'Not installed: correctness does not establish a routing benefit.',
      },
      null,
      2,
    ),
  );
});
