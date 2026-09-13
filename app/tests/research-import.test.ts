import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { inspectResearchPackage } from '../src/main/artifacts.js';
import { authoredTemplates, parseReceipt } from '../src/main/research-templates.js';
import type { CatBoostPackage, PredictionRow, TemplateReceipt } from '../src/shared/research-contracts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDirectory = path.join(here, '..', 'research-templates');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const HOUR = 3600;
const iso = (day: number, hour = 0) => new Date(Date.UTC(2024, 0, day, hour)).toISOString();
const PROJECT = randomUUID();
const SPEC = { id: '00000000-0000-4000-8000-000000000001', hash: sha256('frozen spec'), frozenAt: iso(2) };

function predictions(): PredictionRow[] {
  return [
    { rowId: 'r1', foldId: 'fold-1', timestamp: iso(23), decisionAt: iso(23, 1), tradeAt: iso(23, 2), scope: 'OOF', prediction: 0.4, target: 0.01 },
    { rowId: 'r2', foldId: 'fold-1', timestamp: iso(24), decisionAt: iso(24, 1), tradeAt: iso(24, 2), scope: 'OOF', prediction: -0.2, target: -0.02 },
  ];
}
const predictionBytes = (rows: PredictionRow[]) => strToU8(rows.map(row => JSON.stringify(row)).join('\n') + '\n');

function packageDocument(rows: PredictionRow[], overrides: Partial<CatBoostPackage> = {}): CatBoostPackage {
  const bytes = predictionBytes(rows);
  return {
    schemaVersion: 1, runId: randomUUID(), projectId: PROJECT, registration: 'PROSPECTIVE',
    specId: SPEC.id, specHash: SPEC.hash, registeredAt: iso(2),
    source: { repository: 'research', commit: 'abc123', sourceHash: sha256('source') },
    model: { library: 'catboost', version: '1.2.5', lossFunction: 'RMSE', iterations: 500, configHash: sha256('config'), seed: 7 },
    dataset: {
      schemaVersion: 1, datasetId: randomUUID(), sourceHash: sha256('data'), rows: 10_000, timezone: 'UTC',
      timestampColumn: 'ts', targetColumn: 'forward_return', firstTimestamp: iso(1), lastTimestamp: iso(60),
      columns: [
        { name: 'ts', dtype: 'TIMESTAMP', role: 'TIMESTAMP', availableAfterSeconds: 0, group: 'index' },
        { name: 'momentum_20', dtype: 'FLOAT', role: 'FEATURE', availableAfterSeconds: 0, group: 'price' },
        { name: 'forward_return', dtype: 'FLOAT', role: 'TARGET', availableAfterSeconds: 24 * HOUR, group: 'target' },
      ],
    },
    split: {
      schemaVersion: 1, scheme: 'PURGED_WALK_FORWARD', labelHorizonSeconds: 24 * HOUR, purgeSeconds: 24 * HOUR, embargoSeconds: 12 * HOUR,
      folds: [{ id: 'fold-1', trainStart: iso(1), trainEnd: iso(20), testStart: iso(22), testEnd: iso(30) }],
    },
    fitScopes: [{ foldId: 'fold-1', fittedFrom: iso(1), fittedTo: iso(20), rowsFitted: 4000, earlyStoppingOn: 'INNER_VALIDATION', selectionOn: 'TRAIN_ONLY' }],
    predictionInventory: [{ path: 'predictions/oof.jsonl', sha256: sha256(bytes), rows: rows.length }],
    failedRuns: [{ runId: randomUUID(), reason: 'The first configuration diverged.', failedAt: iso(3) }],
    receipts: [],
    ...overrides,
  };
}

function archive(document: CatBoostPackage, rows: PredictionRow[], extra: Record<string, Uint8Array> = {}) {
  return zipSync({ 'research-package.json': strToU8(JSON.stringify(document)), 'predictions/oof.jsonl': predictionBytes(rows), ...extra });
}

test('a prospective package is imported with its gate verdicts and its failed-run ledger intact', () => {
  const rows = predictions();
  const result = inspectResearchPackage(archive(packageDocument(rows), rows), PROJECT, SPEC);
  assert.equal(result.package.registration, 'PROSPECTIVE');
  assert.equal(result.package.failedRuns.length, 1);
  assert.match(result.summary, /1 failed attempt is recorded in the ledger/);
  assert.match(result.summary, /No approved run package or provider verification is implied/);
  // The economic gates have no evidence at import time, so the package is not advanceable yet.
  assert.equal(result.canAdvance, false);
  assert.deepEqual(result.evaluations.filter(item => item.outcome === 'FAIL'), []);
  assert.deepEqual(result.evaluations.filter(item => item.outcome === 'BLOCKED').map(item => item.gate).sort(), ['G-COST', 'G-PORTFOLIO']);
});

test('an exploratory submission is kept and searchable but cannot claim a preregistration', () => {
  const rows = predictions();
  const document = packageDocument(rows, { registration: 'EXPLORATORY', specId: null, specHash: null, registeredAt: null });
  const result = inspectResearchPackage(archive(document, rows), PROJECT, SPEC);
  assert.equal(result.package.registration, 'EXPLORATORY');
  assert.match(result.summary, /cannot satisfy S0 registration or an S8 holdout evaluation/);
  const spec = result.evaluations.find(item => item.gate === 'G-SPEC')!;
  assert.equal(spec.outcome, 'BLOCKED');
  assert.equal(result.canAdvance, false);
});

test('a prospective claim without a registration, or against a different project, is refused', () => {
  const rows = predictions();
  const unregistered = packageDocument(rows, { specId: null, specHash: null, registeredAt: null });
  const result = inspectResearchPackage(archive(unregistered, rows), PROJECT, SPEC);
  assert.equal(result.evaluations.find(item => item.gate === 'G-SPEC')!.outcome, 'FAIL');

  assert.throws(() => inspectResearchPackage(archive(packageDocument(rows), rows), randomUUID(), SPEC),
    /belongs to a different project/);
});

test('a malformed or undeclared archive is refused rather than partially trusted', () => {
  const rows = predictions();
  assert.throws(() => inspectResearchPackage(zipSync({ 'notes.txt': strToU8('hello') }), PROJECT, SPEC),
    /needs a research-package.json/);
  assert.throws(() => inspectResearchPackage(zipSync({ 'research-package.json': strToU8('{"schemaVersion":1}') }), PROJECT, SPEC));
  assert.throws(() => inspectResearchPackage(archive(packageDocument(rows), rows, { 'extra.csv': strToU8('a,b\n') }), PROJECT, SPEC),
    /contains files it does not declare/);

  // A manifest whose declared bytes do not match what was delivered fails the artifact gate rather
  // than being repaired from what happens to be in the archive.
  const document = packageDocument(rows);
  document.predictionInventory[0].sha256 = sha256('a different file');
  const mismatched = inspectResearchPackage(archive(document, rows), PROJECT, SPEC);
  assert.equal(mismatched.evaluations.find(item => item.gate === 'G-ARTIFACT')!.outcome, 'FAIL');
});

test('defects in the delivered predictions are found in the delivered rows, not in the description of them', () => {
  const duplicated = [...predictions(), predictions()[0]];
  const document = packageDocument(duplicated);
  const result = inspectResearchPackage(archive(document, duplicated), PROJECT, SPEC);
  const integrity = result.evaluations.find(item => item.gate === 'G-INTEGRITY')!;
  assert.equal(integrity.outcome, 'FAIL');
  assert.equal(integrity.measurements.duplicateRows, 1);
  assert.match(result.summary, /Blocked or failed gates: G-INTEGRITY/);
});

test('a receipt is checked against the authored template versions this build actually ships', () => {
  const templates = authoredTemplates(templateDirectory);
  assert.deepEqual(templates.map(item => item.id).sort(), ['cost', 'data', 'diagnostics', 'portfolio']);
  const diagnostics = templates.find(item => item.id === 'diagnostics')!;

  const receipt: TemplateReceipt = { schemaVersion: 1, templateId: 'diagnostics', templateVersion: diagnostics.version,
    templateHash: diagnostics.sha256, dependencies: [{ name: 'catboost', version: '1.2.5' }], kind: 'DIAGNOSTIC', seed: 7,
    environment: 'anthropic-managed', startedAt: iso(5), finishedAt: iso(5, 1), inputHashes: [sha256('data')], outputHashes: [],
    provenance: 'HOSTED_TEMPLATE_RUN' };
  const parsed = parseReceipt(receipt, templates, [sha256('data')]);
  assert.equal(parsed.hosted, true);

  // A version this build does not author cannot be interpreted at all.
  assert.throws(() => parseReceipt({ ...receipt, templateVersion: '9.9.9' }, templates), /this build does not author/);
  // The right version naming the wrong bytes is a different script under a familiar name.
  assert.throws(() => parseReceipt({ ...receipt, templateHash: sha256('other') }, templates), /names different bytes/);
  // An input the run was supposed to read but does not name.
  assert.throws(() => parseReceipt(receipt, templates, [sha256('data'), sha256('other input')]), /does not name 1 of the inputs/);
  // A user-supplied receipt is a document about a run, never evidence the office arranged one.
  const supplied = parseReceipt({ ...receipt, provenance: 'USER_SUPPLIED' }, templates);
  assert.equal(supplied.hosted, false);
  assert.match(supplied.note, /not as evidence that the office arranged one/);
});

test('the authored templates are versioned consistently and none of them is executed here', () => {
  const templates = authoredTemplates(templateDirectory);
  for (const template of templates) {
    assert.match(template.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
    assert.equal(template.file.startsWith(template.id + '.v' + template.version.split('.')[0]), true);
  }
  assert.throws(() => authoredTemplates(path.join(templateDirectory, 'nowhere')), /template directory is missing/);
  // The golden fixture directory holds data, not code, so it contributes no templates.
  assert.throws(() => authoredTemplates(path.join(templateDirectory, 'golden')), /No authored research templates/);
});
