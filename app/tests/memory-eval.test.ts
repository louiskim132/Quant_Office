import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { OfficeStore } from '../src/core/store';
import {
  evaluateAdapter, fixtureCorpus, fixtureQueries, loadExternalAdapter, officeBaselineAdapter,
} from '../src/main/memory-eval';

const key = () => randomUUID();

/** In-memory store + one project — the baseline adapter only needs a project scope. */
function light(t: TestContext) {
  const store = new OfficeStore(':memory:');
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  return { store, project };
}

test('the adapter contract, fixture corpus and query set exist exactly as specified', () => {
  const corpus = fixtureCorpus();
  const queries = fixtureQueries();
  assert.equal(corpus.findings.length, 12);
  assert.equal(new Set(corpus.findings.map(f => f.kind)).size, 6, 'all six finding kinds covered');
  assert.equal(corpus.links.length, 10);
  assert.ok(corpus.links.every(l => corpus.findings.some(f => f.id === l.from)
    && corpus.findings.some(f => f.id === l.to)), 'every link endpoint exists in the corpus');
  assert.ok(queries.length >= 8, 'at least 8 queries with known gold findings');
  assert.ok(queries.every(q => q.expectedIds.every(id => corpus.findings.some(f => f.id === id))),
    'every gold id resolves to a corpus finding');
});

test('the baseline evaluates the fixture deterministically', t => {
  const { store, project } = light(t);
  const baseline = officeBaselineAdapter(store, project.id);
  const corpus = fixtureCorpus();
  const queries = fixtureQueries();

  const one = evaluateAdapter(baseline, corpus, queries);
  const two = evaluateAdapter(baseline, corpus, queries);
  assert.deepEqual(two, one, 'the same corpus over the same store must score identically');
  assert.equal(one.engine, 'office-baseline');
  assert.equal(one.queries.length, 10);
});

test('gold answers score correctly — expected findings rank present at the designed positions', t => {
  const { store, project } = light(t);
  const report = evaluateAdapter(officeBaselineAdapter(store, project.id), fixtureCorpus(), fixtureQueries());

  const leakage = report.queries.find(q => q.query === 'look-ahead leakage audit')!;
  assert.equal(leakage.hits[0], 'mem-obs-1');
  assert.equal(leakage.reciprocalRank, 1);
  assert.equal(leakage.recallAt5, 1);

  const equalWeight = report.queries.find(q => q.query === 'equal-weight benchmark control')!;
  assert.deepEqual(new Set(equalWeight.expectedIds), new Set(['mem-res-1', 'mem-dec-2']));
  assert.equal(equalWeight.recallAt5, 1, 'both gold findings land inside the top five');
  assert.ok(equalWeight.hitRanks.every(r => r.rank !== null && r.rank <= 5));

  assert.ok(report.queries.every(q => q.hitRanks.every(r => r.rank !== null)),
    'every gold finding is retrievable by the baseline — the fixture must not ship an unreachable gold');
  assert.equal(report.recallAt5, 1);
  assert.ok(report.meanReciprocalRank > 0.9);
});

test('a missing or broken adapter module reports UNAVAILABLE instead of crashing', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-mem-eval-'));
  t.after(() => removeTreeSync(root));

  const missing = await loadExternalAdapter(path.join(root, 'no-such-module.mjs'));
  assert.ok('unavailable' in missing);
  assert.match(missing.unavailable, /could not be loaded/);

  const throwing = path.join(root, 'throwing.mjs');
  writeFileSync(throwing, 'export function create() { throw new Error("engine offline"); }\n');
  const thrown = await loadExternalAdapter(throwing);
  assert.ok('unavailable' in thrown);
  assert.match(thrown.unavailable, /engine offline/);

  const flat = path.join(root, 'flat.mjs');
  writeFileSync(flat, 'export const answer = 42;\n');
  const noCreate = await loadExternalAdapter(flat);
  assert.ok('unavailable' in noCreate);
  assert.match(noCreate.unavailable, /create\(\)/);

  const malformed = path.join(root, 'malformed.mjs');
  writeFileSync(malformed, 'export function create() { return { name: "half-adapter" }; }\n');
  const malformedResult = await loadExternalAdapter(malformed);
  assert.ok('unavailable' in malformedResult);
});

test('a caller-supplied adapter evaluates through the same scoring path', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-mem-eval-'));
  t.after(() => removeTreeSync(root));
  const adapterFile = path.join(root, 'echo-adapter.mjs');
  writeFileSync(adapterFile, `
    export function create() {
      const docs = new Map();
      return {
        name: 'echo-fixture',
        ingest(f) { docs.set(f.id, (f.title + ' ' + f.body).toLowerCase()); },
        search(query, limit) {
          const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 2);
          return [...docs.entries()]
            .filter(([, text]) => terms.every(t => text.includes(t)))
            .slice(0, limit)
            .map(([id]) => ({ id }));
        },
      };
    }
  `);
  const loaded = await loadExternalAdapter(adapterFile);
  assert.ok('adapter' in loaded);
  if (!('adapter' in loaded)) return;
  const report = evaluateAdapter(loaded.adapter, fixtureCorpus(), fixtureQueries());
  assert.equal(report.engine, 'echo-fixture');
  assert.ok(report.queries.every(q => q.hitRanks.every(r => r.rank !== null)),
    'the exact-match fixture adapter finds every gold id');
});

test('the report is JSON-safe end to end', t => {
  const { store, project } = light(t);
  const report = evaluateAdapter(officeBaselineAdapter(store, project.id), fixtureCorpus(), fixtureQueries());
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('the store-backed baseline returns real findings recorded outside ingest', t => {
  const { store, project } = light(t);
  const { finding } = store.recordMemoryFinding({
    projectId: project.id, requestId: null, assignmentId: null, kind: 'RESULT',
    title: 'alpha beats beta', body: 'under the fixture', evidenceRefs: [], createdBy: { surface: 'OFFICE' },
  });
  const adapter = officeBaselineAdapter(store, project.id);
  const hits = adapter.search('alpha beats', 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, finding.id, 'a finding recorded outside ingest still surfaces by its real id');
  assert.equal(adapter.search('zzzzz', 5).length, 0);
});

test('node scripts/memory-eval.mjs prints the baseline EVALUATED and never fails on a broken adapter', t => {
  const script = fileURLToPath(new URL('../scripts/memory-eval.mjs', import.meta.url));
  const appDir = path.dirname(path.dirname(script));

  const out = execFileSync(process.execPath, [script], { cwd: appDir }).toString();
  const report = JSON.parse(out);
  assert.ok(report.generatedAt);
  assert.equal(report.engines.length, 1);
  const baseline = report.engines[0];
  assert.equal(baseline.engine, 'office-baseline');
  assert.equal(baseline.status, 'EVALUATED');
  assert.equal(baseline.queries, 10);
  assert.ok(baseline.meanReciprocalRank > 0);
  assert.ok(baseline.recallAt5 > 0);
  assert.ok(!out.includes('Graphiti'), 'no external engine claim without an adapter');

  const root = mkdtempSync(path.join(tmpdir(), 'qro-mem-eval-cli-'));
  t.after(() => removeTreeSync(root));
  const bad = path.join(root, 'broken-engine.mjs');
  writeFileSync(bad, 'export function create() { throw new Error("engine offline"); }\n');
  const out2 = execFileSync(process.execPath, [script, '--adapter', bad], { cwd: appDir }).toString();
  const withBad = JSON.parse(out2);
  assert.equal(withBad.engines.length, 2);
  assert.equal(withBad.engines[0].status, 'EVALUATED', 'baseline still evaluates when an adapter fails');
  const unavailable = withBad.engines.find((e: { status: string }) => e.status === 'UNAVAILABLE');
  assert.ok(unavailable);
  assert.match(unavailable.reason, /engine offline/);
});
