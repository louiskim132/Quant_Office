import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DIAGNOSTIC_POLICY_PREFIX, judgeReturnedAnalysis } from '../src/main/returned-analysis';
import type { FrozenResearchSpec } from '../src/shared/research';
import type { RunReturnInspection } from '../src/shared/run-package';

const policy = { minimumSamples: 30, minimumSliceSamples: 10, requiredSlices: ['time'], requiredCostMultiples: [1, 2] };
const spec = {
  frozen: true,
  sections: { metricsAndGates: DIAGNOSTIC_POLICY_PREFIX + JSON.stringify(policy) },
} as FrozenResearchSpec;
function returned(forecast: Record<string, unknown> = {}, stress: Record<string, unknown> = {}) {
  const diagnostics = {
    schemaVersion: 1,
    signal: { metric: 'RANK_IC', value: -0.2, samples: 40, standardError: null },
    slices: [{ name: 'time', samples: 40, value: -0.2 }],
    featureGroupStability: [],
    note: 'Synthetic negative result',
    ...forecast,
  };
  const economics = {
    stressReport: {
      schemaVersion: 1,
      scenarios: [
        { name: '2x', perturbation: 'costs', magnitude: 2, netReturn: -0.03, maxDrawdown: 0.03, samples: 40 },
      ],
      costMultiples: [1, 2],
      note: 'Synthetic loss',
      ...stress,
    },
  };
  const object = (path: string, body: unknown) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  return {
    manifestHash: 'a'.repeat(64),
    objects: [object('outputs/diagnostics.json', diagnostics), object('outputs/economics.json', economics)],
  } as Pick<RunReturnInspection, 'objects' | 'manifestHash'>;
}
test('bound return analysis uses frozen thresholds, separates economics and permits adequate negative results', () => {
  assert.equal(judgeReturnedAnalysis(spec, returned())!.adequate, true);
  const inadequate = judgeReturnedAnalysis(spec, returned({ slices: [] }, { costMultiples: [1] }))!;
  assert.equal(inadequate.adequate, false);
  assert.equal(inadequate.diagnostic.problems[0].code, 'MISSING_SLICE');
  assert.equal(inadequate.stress.problems[0].code, 'MISSING_STRESS');
  const stricter = {
    ...spec,
    sections: {
      ...spec.sections,
      metricsAndGates: DIAGNOSTIC_POLICY_PREFIX + JSON.stringify({ ...policy, minimumSamples: 50 }),
    },
  };
  assert.equal(judgeReturnedAnalysis(stricter, returned())!.adequate, false);
});
test('unregistered legacy returns make no adequacy claim; malformed and misbound registered reports refuse', () => {
  assert.equal(
    judgeReturnedAnalysis(
      { ...spec, sections: { ...spec.sections, metricsAndGates: 'Metrics described in prose' } },
      returned(),
    ),
    null,
  );
  assert.throws(() => judgeReturnedAnalysis({ ...spec, frozen: false }, returned()), /frozen/);
  assert.throws(() => judgeReturnedAnalysis(spec, returned({ receiptHash: 'b'.repeat(64) })), /different return/);
  assert.throws(() => judgeReturnedAnalysis(spec, returned({ netReturn: 0.1 })), /separately/);
  assert.throws(() => judgeReturnedAnalysis(spec, returned({}, { scenarios: [] })));
});
