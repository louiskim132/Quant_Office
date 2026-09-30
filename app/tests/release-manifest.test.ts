import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { releaseManifestSchema, type ReleaseManifest } from '../src/shared/shadow.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const at = (day: number) => new Date(Date.UTC(2024, 6, day)).toISOString();

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return releaseManifestSchema.parse({
    schemaVersion: 1,
    branchId: randomUUID(),
    lineageId: randomUUID(),
    specId: randomUUID(),
    specHash: sha256('spec'),
    candidateHash: sha256('candidate'),
    environment: 'anthropic-managed, catboost 1.2.5, python 3.11',
    codeRefs: [{ repository: 'research', commit: 'abc123', sourceHash: sha256('source') }],
    dataRefs: [{ datasetId: randomUUID(), sourceHash: sha256('data'), description: 'Daily bars, 2015-2023' }],
    gateReceiptHashes: [sha256('G-CORRECT'), sha256('G-COST')],
    reviewDecisionHashes: [sha256('review')],
    costModelHash: sha256('costs'),
    portfolioContractHash: sha256('portfolio'),
    limitations: [
      'The shadow period is not an execution test; no real impact was measured.',
      'The final holdout was evaluated once and cannot be re-used to check a change made after it.',
    ],
    approvedScope: 'Shadow evaluation of one candidate on the registered universe, with no capital.',
    approvalMeaning:
      'The recorded gates and reviews passed for this exact candidate. This is not a decision to commit capital and does not authorise trading.',
    exportedAt: at(1),
    ...overrides,
  });
}

test('a manifest with no limitations, no data reference or no gate receipt is not a research package', () => {
  for (const missing of [{ limitations: [] }, { dataRefs: [] }, { gateReceiptHashes: [] }, { codeRefs: [] }])
    assert.throws(() => releaseManifestSchema.parse({ ...manifest(), ...missing }));
  // Unknown fields are refused too: a package that carries an extra claim carries an unchecked one.
  assert.throws(() => releaseManifestSchema.parse({ ...manifest(), verdict: 'profitable' }));
});
