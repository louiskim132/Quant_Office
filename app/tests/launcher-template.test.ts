import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { runPackageHash, runPackageId, runReturnManifestSchema, type RunPackageManifest } from '../src/shared/run-package.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templates = path.join(here, '..', 'research-templates');
const launcher = path.join(templates, 'launcher.v1.py');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const source = () => readFileSync(launcher, 'utf8');

/** The first python binary on PATH, or null — the runnable assertions skip cleanly without one. */
function python(): string | null {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

test('launcher.v1.py exists and declares TEMPLATE_VERSION 1.0.0 matching its filename major', () => {
  assert.ok(existsSync(launcher), 'app/research-templates/launcher.v1.py must exist');
  const declared = /TEMPLATE_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/.exec(source());
  assert.ok(declared, 'the launcher must declare TEMPLATE_VERSION');
  assert.equal(declared![1], '1.0.0');
  assert.equal(declared![1].split('.')[0], '1', 'filename major version must match the declaration');
});

test('the launcher opens no outbound channel: no network, shell, credential or remote-control tokens', () => {
  const forbidden = [
    'http://', 'https://', 'urllib', 'requests', 'socket', 'subprocess', 'os.system', 'popen',
    'eval(', 'exec(', '__import__', 'pickle', 'ctypes', 'paramiko', 'ftplib', 'telnetlib',
    'smtplib', 'websocket', 'grpc', 'xmlrpc', 'boto3', 'googleapiclient', 'curl', 'wget', 'base64',
  ];
  for (const token of forbidden)
    assert.ok(!source().includes(token), `launcher.v1.py must not contain ${JSON.stringify(token)}`);
});

test('the launcher emits every field the RUN_RETURN manifest schema binds', () => {
  const required = [
    'schemaVersion', 'RUN_RETURN', 'packageId', 'packageHash', 'branchId', 'specId', 'specHash',
    'subjectHash', 'runId', 'startedAt', 'finishedAt', 'status', 'COMPLETED', 'EXECUTION_FAILED',
    'INCONCLUSIVE', 'artifacts', 'sha256', 'bytes', 'gates', 'stage', 'outcome', 'detail',
    'rationale', 'failedRuns', 'MANIFEST.json', 'return-manifest.json',
  ];
  for (const field of required)
    assert.ok(source().includes(field), `launcher.v1.py must emit ${field}`);
});

test('python -m py_compile accepts the launcher when a python binary is on PATH', t => {
  const binary = python();
  if (!binary) return t.skip('no python binary on PATH');
  const scratch = mkdtempSync(path.join(tmpdir(), 'qro-launcher-compile-'));
  const compiled = spawnSync(binary, ['-c',
    'import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
    launcher, path.join(scratch, 'launcher.pyc')], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
});

/** A synthetic run package on disk: real hashes, real identity, the authored templates shipped. */
function syntheticPackage() {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-launcher-run-'));
  for (const name of ['launcher.v1.py', 'data.v1.py', 'diagnostics.v1.py', 'portfolio.v1.py', 'cost.v1.py'])
    cpSync(path.join(templates, name), path.join(root, name));
  const spec = {
    id: randomUUID(),
    costs: { schemaVersion: 1, commissionBps: 2, halfSpreadBps: 3, slippageBps: 5, borrowBpsPerPeriod: 4, financingBpsPerPeriod: 1 },
    portfolioContract: { schemaVersion: 1, maxGrossExposure: 2, maxNetExposure: 1, maxPositionWeight: 0.6, maxTurnoverPerPeriod: 2 },
  };
  writeFileSync(path.join(root, 'spec.json'), JSON.stringify(spec));
  writeFileSync(path.join(root, 'INSTRUCTIONS.md'), '# Run\nRun the experiment, then the launcher.\n');
  const entries = ['launcher.v1.py', 'data.v1.py', 'diagnostics.v1.py', 'portfolio.v1.py', 'cost.v1.py', 'spec.json', 'INSTRUCTIONS.md']
    .map(name => {
      const bytes = readFileSync(path.join(root, name));
      return { path: name, sha256: sha256(bytes), bytes: bytes.length };
    });
  const base: Omit<RunPackageManifest, 'packageId' | 'packageHash' | 'exportedAt'> = {
    schemaVersion: 1, kind: 'RUN_PACKAGE', projectId: randomUUID(), branchId: randomUUID(), branchRevision: 0,
    specId: spec.id, specHash: sha256('frozen spec'), subjectHash: sha256('candidate'),
    requestId: randomUUID(), requestRevision: 0, entries,
    environment: { runtime: 'COLAB_USER_RUN', detail: 'Synthetic package assembled by the guard test.' },
    expectedReturn: { files: ['result.json'], requiredGates: ['G-PORTFOLIO', 'G-COST', 'G-ECON'] },
    instructions: 'Run the experiment, then run launcher.v1.py and return run-return.zip.',
  };
  const packageHash = runPackageHash(base);
  const manifest: RunPackageManifest = { ...base, packageId: runPackageId(packageHash), packageHash, exportedAt: new Date().toISOString() };
  writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return { root, manifest };
}

/** The produced side of a synthetic run: the declared output plus the two check inputs. */
function produceRun(root: string) {
  const periods = [
    { period: '2024-01', weightsBefore: { AAA: 0, BBB: 0 }, weightsAfter: { AAA: 0.6, BBB: 0.4 }, assetReturns: { AAA: 0.02, BBB: -0.01 } },
    { period: '2024-02', weightsBefore: { AAA: 0.5, BBB: -0.5 }, weightsAfter: { AAA: 0.5, BBB: -0.5 }, assetReturns: { AAA: 0.04, BBB: 0.01 } },
  ];
  writeFileSync(path.join(root, 'result.json'), JSON.stringify({ periods }));
  writeFileSync(path.join(root, 'portfolio.input.json'), JSON.stringify({ periods }));
  writeFileSync(path.join(root, 'cost.input.json'), JSON.stringify({ periods }));
}

function runLauncher(root: string, binary: string) {
  const run = spawnSync(binary, ['launcher.v1.py'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `launcher exited ${run.status}: ${run.stderr}`);
  const bundle = unzipSync(readFileSync(path.join(root, 'run-return.zip')));
  assert.ok(bundle['return-manifest.json'], 'the return bundle must carry return-manifest.json');
  return { bundle, manifest: runReturnManifestSchema.parse(JSON.parse(strFromU8(bundle['return-manifest.json']))) };
}

test('a verified package with check inputs produces a schema-valid COMPLETED bound return', t => {
  const binary = python();
  if (!binary) return t.skip('no python binary on PATH');
  const { root, manifest } = syntheticPackage();
  produceRun(root);
  const { bundle, manifest: returned } = runLauncher(root, binary);

  // The binding: the return names exactly the package it answers, and nothing else.
  assert.equal(returned.packageId, manifest.packageId);
  assert.equal(returned.packageHash, manifest.packageHash);
  assert.equal(returned.branchId, manifest.branchId);
  assert.equal(returned.specId, manifest.specId);
  assert.equal(returned.specHash, manifest.specHash);
  assert.equal(returned.subjectHash, manifest.subjectHash);
  assert.equal(returned.status, 'COMPLETED');

  // The bundle carries exactly the declared produced file plus the manifest, each hash-verified.
  assert.deepEqual(Object.keys(bundle).sort(), ['result.json', 'return-manifest.json']);
  assert.deepEqual(returned.artifacts, [{ path: 'result.json', sha256: sha256(bundle['result.json']), bytes: bundle['result.json'].length }]);

  // Every required gate is answered at the stage that owns it, plus the launcher's transfer check.
  const byGate = new Map(returned.gates.map(row => [row.gate, row]));
  assert.equal(byGate.get('G-PORTFOLIO')!.stage, 'S5');
  assert.equal(byGate.get('G-PORTFOLIO')!.outcome, 'PASS');
  assert.equal(byGate.get('G-COST')!.stage, 'S6');
  assert.equal(byGate.get('G-ECON')!.stage, 'S6');
  assert.equal(byGate.get('G-ARTIFACT')!.stage, 'S3');
  assert.equal(byGate.get('G-ARTIFACT')!.outcome, 'PASS');
  assert.deepEqual(returned.failedRuns, []);
});

test('a tampered package aborts with EXECUTION_FAILED and a failed artifact check, still schema-valid', t => {
  const binary = python();
  if (!binary) return t.skip('no python binary on PATH');
  const { root, manifest } = syntheticPackage();
  produceRun(root);
  writeFileSync(path.join(root, 'spec.json'), '{"tampered":true}\n');
  const { manifest: returned } = runLauncher(root, binary);
  assert.equal(returned.status, 'EXECUTION_FAILED');
  assert.equal(returned.packageId, manifest.packageId);
  const artifact = returned.gates.find(row => row.gate === 'G-ARTIFACT')!;
  assert.equal(artifact.outcome, 'FAIL');
  assert.equal(artifact.stage, 'S3');
  assert.ok(returned.failedRuns.length >= 1, 'the aborted run is recorded as a failed attempt');
});
