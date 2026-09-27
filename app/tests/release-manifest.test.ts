import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { buildResearchPackage } from '../src/main/artifacts.js';
import { assertHonestApproval, releaseManifestSchema, type ReleaseManifest } from '../src/shared/shadow.js';

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

test('a package carries its code, data, gate and review references and its own limitations', () => {
  const release = manifest();
  const bytes = buildResearchPackage(release, { 'predictions/oof.jsonl': strToU8('{"rowId":"r1"}\n') });
  const files = unzipSync(bytes);
  assert.deepEqual(Object.keys(files).sort(), [
    'README.txt',
    'inventory.json',
    'predictions/oof.jsonl',
    'release-manifest.json',
  ]);

  const carried = JSON.parse(strFromU8(files['release-manifest.json']));
  assert.deepEqual(carried, release, 'the manifest travels exactly as it was validated');

  const readme = strFromU8(files['README.txt']);
  assert.match(readme, /not an approved run/);
  assert.match(readme, /not a deployment authorisation/);
  for (const limitation of release.limitations)
    assert.ok(readme.includes(limitation), 'every limitation is in the package, not in a covering note');

  // The inventory hashes what was actually written, so a substituted entry is detectable.
  const inventory = JSON.parse(strFromU8(files['inventory.json']));
  const predictions = inventory.entries.find((entry: { path: string }) => entry.path === 'predictions/oof.jsonl');
  assert.equal(predictions.sha256, sha256('{"rowId":"r1"}\n'));
});

test('a package cannot claim more approval than the office can grant', () => {
  for (const claim of [
    'This candidate is approved for trading on the registered universe.',
    'Cleared for deployment with live capital.',
    'The strategy is authorised to trade at the reviewed size.',
  ])
    assert.throws(
      () => buildResearchPackage(manifest({ approvalMeaning: claim })),
      /it does not authorise capital, and a package must not read as though it does/,
    );

  // An approval statement that only says what was approved reads as authorisation, so it is refused.
  assert.throws(
    () => assertHonestApproval(manifest({ approvalMeaning: 'The gates and reviews passed for this candidate.' })),
    /must say what the approval does not mean/,
  );
  assert.doesNotThrow(() => assertHonestApproval(manifest()));
});

test('a manifest with no limitations, no data reference or no gate receipt is not a research package', () => {
  for (const missing of [{ limitations: [] }, { dataRefs: [] }, { gateReceiptHashes: [] }, { codeRefs: [] }])
    assert.throws(() => releaseManifestSchema.parse({ ...manifest(), ...missing }));
  // Unknown fields are refused too: a package that carries an extra claim carries an unchecked one.
  assert.throws(() => releaseManifestSchema.parse({ ...manifest(), verdict: 'profitable' }));
});

test('the exported scope is exactly the subject it was built for', () => {
  const first = manifest(),
    second = manifest();
  const one = JSON.parse(strFromU8(unzipSync(buildResearchPackage(first))['release-manifest.json']));
  const two = JSON.parse(strFromU8(unzipSync(buildResearchPackage(second))['release-manifest.json']));
  assert.notEqual(one.branchId, two.branchId);
  assert.equal(one.candidateHash, first.candidateHash);
  // Nothing about another branch leaks in: the package contains what it was given and nothing more.
  assert.equal(JSON.stringify(one).includes(second.branchId), false);
});
