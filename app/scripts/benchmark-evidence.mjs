// node --import tsx scripts/benchmark-evidence.mjs [--sizes=8,64,256] [--lines=200] [--repeats=3]
// Synthetic deterministic retrieval acceptance, not a model-quality/token experiment.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { OfficeStore } from '../src/core/store.ts';
import { EvidenceService } from '../src/main/evidence.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(sizes|lines|repeats)=(.+)$/.exec(arg);
  if (!match) throw new Error('Unknown argument: ' + arg);
  return [match[1], match[2]];
}));
const sizes = (options.sizes ?? '8,64,256').split(',').map(Number);
const lines = Number(options.lines ?? 200), repeats = Number(options.repeats ?? 3);
assert.ok(sizes.every(n => Number.isSafeInteger(n) && n >= 8 && n <= 4096));
assert.ok(Number.isSafeInteger(lines) && lines >= 10 && lines <= 10000);
assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 20);
const defects = ['LEAKAGE', 'FAILED_FOLD', 'COST_SIGN_UNIT', 'RARE_SEGMENT_LOSS', 'CONTRADICTORY_OUTPUT', 'STALE_CACHE', 'WRONG_SOURCE_INDEX'];
const root = mkdtempSync(path.join(tmpdir(), 'qro-evidence-benchmark-'));
const report = { status: 'FAIL', at: new Date().toISOString(), root, sizes, lines, repeats,
  providerCalls: 0, actualModelTokens: { input: 'UNKNOWN', output: 'UNKNOWN', cache: 'UNKNOWN', allAgents: 'UNKNOWN' },
  limitations: ['No model invoked: deterministic known-answer recovery only, not full section 8.4 model acceptance.',
    'Bytes are UTF-8 serialized service responses, not tokens. Latency includes receipt writes; OS disk cache is uncontrolled.',
    'New EvidenceService per arm; order alternates. Fixture setup excluded from retrieval latency.',
    'Search uses planted CRITICAL marker; does not establish discovery of unlabelled defects or universal recall.',
    'Scale measures EvidenceService only, not renderer responsiveness or full application scale.',
    'Returned/omitted item sums include overlapping pages and mix packet objects, lines and matches; per-call counts retain units via kind.'], runs: [] };

function fixture(count, run) {
  const directory = path.join(root, `${count}-${run}`), workspace = path.join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OfficeStore(path.join(directory, 'workspace.sqlite'));
  const project = store.execute({ type: 'project.create', idempotencyKey: randomUUID(), name: 'Synthetic benchmark', mandate: 'fixture', budgetCents: 0 }).projects[0];
  const agentId = randomUUID();
  store.addAgent({ id: agentId, name: 'Fixture reader', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER', instructions: '',
    account: 'fixture@example.invalid', createdAt: new Date().toISOString(), execution: 'HOSTED_SETUP_REQUIRED' });
  const request = store.execute({ type: 'request.create', idempotencyKey: randomUUID(), projectId: project.id, name: 'Audit', hypothesis: 'Synthetic',
    workType: 'ANALYSIS', mode: 'SINGLE', leadAgentId: agentId }).requests[0];
  store.execute({ type: 'request.grant', idempotencyKey: randomUUID(), requestId: request.id, agentId, capacity: 'WORKER', granted: true });
  const objects = [];
  const put = (name, body, projectId = project.id) => {
    const sha256 = hash(body), file = path.join(workspace, 'objects', sha256.slice(0, 2), sha256);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body);
    store.addArtifact({ id: randomUUID(), projectId, experimentId: null, name, sha256, size: Buffer.byteLength(body), kind: 'RESULT',
      classification: 'USER_ATTESTED', status: 'QUARANTINED', createdAt: new Date().toISOString(), mediaType: 'text/plain', note: 'synthetic benchmark' });
    return { sha256, name, body };
  };
  for (let i = 0; i < count; i++) {
    const rows = Array.from({ length: lines }, (_, j) => `object=${i} row=${j} synthetic observation ${'x'.repeat(80)}`);
    if (i < defects.length) rows[lines - 2] = `CRITICAL ${defects[i]} synthetic known-answer defect`;
    objects.push(put(`source-${i}.log`, rows.join('\n') + '\n'));
  }
  return { store, workspace, project, agentId, objects, put };
}

async function arm(f, mode) {
  const service = new EvidenceService(f.store, f.workspace);
  const metrics = { mode, latencyMs: 0, responseBytes: 0, retrievalCount: 0, returnedItems: 0, reportedOmittedItems: 0,
    retries: 0, userInterventions: 0, calls: [], recovered: [] };
  const recovered = new Set();
  const call = async (kind, input) => {
    const started = performance.now(), value = await service[kind](input);
    const latencyMs = performance.now() - started, responseBytes = Buffer.byteLength(JSON.stringify(value));
    metrics.calls.push({ kind, latencyMs, responseBytes, returned: value.returned ?? value.objects?.length ?? 0,
      omitted: value.omitted ?? value.excludedObjects ?? 0, coverage: value.coverage ?? 'SEE_PACKET_NOTES' });
    metrics.responseBytes += responseBytes; metrics.retrievalCount++;
    metrics.returnedItems += value.returned ?? value.objects?.length ?? 0;
    metrics.reportedOmittedItems += value.omitted ?? value.excludedObjects ?? 0;
    return value;
  };
  const remember = text => { for (const defect of defects) if (text.includes(`CRITICAL ${defect} `)) recovered.add(defect); };
  const started = performance.now(), cpu = process.cpuUsage();
  if (mode === 'full') {
    for (const object of f.objects) {
      let cursor, collected = [];
      do {
        const page = await call('read', { agentId: f.agentId, objectHash: object.sha256, limit: 200, ...(cursor ? { cursor } : {}) });
        assert.notEqual(page.total, null); collected.push(...page.lines); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(collected.join('\n') + '\n', object.body);
      remember(collected.join('\n'));
    }
  } else {
    const packet = await call('stagePacket', { agentId: f.agentId, projectId: f.project.id, subjectId: f.project.id, stage: 'S2', maxObjects: 1 });
    assert.equal(packet.excludedObjects, f.objects.length - 1);
    const brief = await call('read', { agentId: f.agentId, objectHash: packet.objects[0].sha256, limit: 1 });
    assert.ok(brief.omitted > 0); assert.ok(!brief.lines.join('\n').includes('CRITICAL'));
    metrics.initialBriefCriticalRecovery = 0;
    let cursor;
    do {
      const page = await call('query', { agentId: f.agentId, projectId: f.project.id, pattern: 'CRITICAL', limit: 2, ...(cursor ? { cursor } : {}) });
      assert.deepEqual(page.unreadableObjects, []);
      for (const match of page.matches) {
        const expanded = await call('read', { agentId: f.agentId, objectHash: match.sha256, from: match.line, limit: 1 });
        const expected = f.objects.find(o => o.sha256 === match.sha256);
        assert.ok(expected); assert.equal(expanded.lines[0], expected.body.split('\n')[match.line - 1]);
        remember(expanded.lines.join('\n'));
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  metrics.latencyMs = performance.now() - started;
  metrics.cpuMicroseconds = process.cpuUsage(cpu);
  metrics.rssBytesAtEnd = process.memoryUsage().rss;
  metrics.recovered = [...recovered].sort();
  metrics.cacheReuseCount = service.allReceipts().filter(r => r.reusedFromReceiptId !== null).length;
  assert.deepEqual(metrics.recovered, [...defects].sort());
  return metrics;
}

try {
  for (const count of sizes) for (let repeat = 0; repeat < repeats; repeat++) {
    const setup = performance.now(), f = fixture(count, repeat);
    const run = { count, repeat, setupMs: performance.now() - setup, sourceBytes: f.objects.reduce((n, o) => n + Buffer.byteLength(o.body), 0), arms: [] };
    report.runs.push(run);
    try {
      for (const mode of repeat % 2 ? ['compact', 'full'] : ['full', 'compact']) run.arms.push(await arm(f, mode));
      const service = new EvidenceService(f.store, f.workspace);
      const query = { agentId: f.agentId, projectId: f.project.id, pattern: 'CHANGED_DEPENDENCY' };
      const started = performance.now(), before = await service.query(query), warm = await service.query(query);
      assert.equal(before.returned, 0);
      assert.equal(service.allReceipts().find(r => r.id === warm.receiptId).reusedFromReceiptId, before.receiptId);
      const changed = f.put('source-0.log', 'CRITICAL CHANGED_DEPENDENCY new bytes under same filename\n');
      const after = await service.query(query), receipt = service.allReceipts().find(r => r.id === after.receiptId);
      assert.equal(after.returned, 1); assert.equal(after.matches[0].sha256, changed.sha256);
      assert.equal(receipt.reusedFromReceiptId, null);
      assert.notEqual(receipt.dependencyKey, service.allReceipts().find(r => r.id === before.receiptId).dependencyKey);
      await assert.rejects(service.read({ agentId: randomUUID(), objectHash: changed.sha256 }), /not available to this agent/);
      const other = f.store.execute({ type: 'project.create', idempotencyKey: randomUUID(), name: 'Outside scope', mandate: 'fixture', budgetCents: 0 }).projects.find(p => p.id !== f.project.id);
      const secret = f.put('secret.log', 'CRITICAL OUTSIDE_PROJECT\n', other.id);
      await assert.rejects(service.read({ agentId: f.agentId, objectHash: secret.sha256 }), /not available to this agent/);
      const isolated = await service.query({ ...query, pattern: 'OUTSIDE_PROJECT' });
      assert.equal(isolated.returned, 0);
      run.dependencyAndScope = { passed: true, latencyMs: performance.now() - started, queryCount: 4, deniedReadCount: 2,
        responseBytes: [before, warm, after, isolated].reduce((n, v) => n + Buffer.byteLength(JSON.stringify(v)), 0),
        beforeKey: service.allReceipts().find(r => r.id === before.receiptId).dependencyKey, afterKey: receipt.dependencyKey,
        changeSemantics: 'Append new content-addressed artifact with same name; old evidence retained' };
    } finally { f.store.close(); }
  }
  report.status = 'PASS';
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  mkdirSync('test-output', { recursive: true });
  const output = path.resolve('test-output', `benchmark-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${output}`);
}
