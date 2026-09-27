import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
const sections = {
  estimand: 'e',
  splitPlan: 's',
  searchPlan: 's',
  costContract: 'c',
  portfolioContract: 'p',
  metricsAndGates: 'm',
  holdoutPolicy: 'h',
};
test('draft compare-and-swap and project scope survive indexed reads without event history', () => {
  const s = new OfficeStore(':memory:', { includeHistoryInResults: false });
  try {
    const p = s.execute({
      type: 'project.create',
      idempotencyKey: randomUUID(),
      name: 'P',
      mandate: 'm',
      budgetCents: 0,
    }).projects[0];
    const draft = {
      type: 'research.draftSpec',
      idempotencyKey: randomUUID(),
      projectId: p.id,
      name: 'Branch',
      sections,
      thresholds: [],
      notApplicable: [],
      maxSelectionTrials: 5,
    };
    s.execute(draft);
    const b = s.snapshot().branches![0];
    assert.equal(
      s.execute({ ...draft, idempotencyKey: randomUUID(), branchId: b.id, expectedRevision: b.revision }).events.length,
      0,
    );
    assert.throws(
      () => s.execute({ ...draft, idempotencyKey: randomUUID(), branchId: b.id, expectedRevision: b.revision }),
      /changed/,
    );
    assert.throws(() => s.execute({ ...draft, idempotencyKey: randomUUID(), branchId: b.id }), /changed/);
    assert.equal(s.snapshot().branches![0].revision, 1);
    assert.ok(s.snapshot().events.length > 0);
    const publicState = OfficeStore.publicState(s.snapshot());
    assert.deepEqual(publicState.events, []);
    assert.deepEqual(publicState.pipeline, []);
  } finally {
    s.close();
  }
});
test('research cursor holds a high-water mark and refuses cross-scope replay', () => {
  const s = new OfficeStore(':memory:');
  try {
    const p = s.execute({
      type: 'project.create',
      idempotencyKey: randomUUID(),
      name: 'P',
      mandate: 'm',
      budgetCents: 0,
    }).projects[0];
    s.execute({
      type: 'research.draftSpec',
      idempotencyKey: randomUUID(),
      projectId: p.id,
      name: 'B',
      sections,
      thresholds: [],
      notApplicable: [],
      maxSelectionTrials: 5,
    });
    const b = s.snapshot().branches![0];
    for (let i = 0; i < 4; i++)
      s.recordPipeline({
        id: randomUUID(),
        kind: 'SHADOW_POLICY',
        projectId: p.id,
        branchId: b.id,
        createdAt: new Date().toISOString(),
        specId: b.specId!,
        policy: makePolicy(i),
      });
    const page = s.researchPage({ projectId: p.id, kind: 'pipeline', limit: 2 });
    s.recordPipeline({
      id: randomUUID(),
      kind: 'SHADOW_POLICY',
      projectId: p.id,
      branchId: b.id,
      createdAt: new Date().toISOString(),
      specId: b.specId!,
      policy: makePolicy(9),
    });
    const next = s.researchPage({ projectId: p.id, kind: 'pipeline', limit: 2, cursor: page.nextCursor! });
    assert.equal(next.total, 4);
    assert.equal(new Set([...page.entries, ...next.entries].map(r => r.id)).size, 4);
    assert.equal(next.nextCursor, null);
    assert.throws(
      () => s.researchPage({ projectId: p.id, branchId: b.id, kind: 'pipeline', cursor: page.nextCursor! }),
      /scope/,
    );
  } finally {
    s.close();
  }
});
import { canonicalHash } from '../src/core/canonical';
function makePolicy(i: number) {
  const p = {
    minimumSamples: 1 + i,
    maximumMissingShare: 0.1,
    retireBelowMetric: -1,
    qualifyAtOrAboveMetric: 1,
    driftAlarmMetric: 0,
    killBelowMetric: -2,
  };
  return { ...p, thresholdHash: canonicalHash(p) };
}
