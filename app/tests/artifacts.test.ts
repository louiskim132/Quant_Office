import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { OfficeStore, canonicalHash, sha256 } from '../src/core/store.js';
import { ArtifactService, inspectResultArchive, MAX_FILE, safeEntry } from '../src/main/artifacts.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'quant-office-artifacts-'));
  const root = path.join(directory, 'workspace');
  // SQLite requires its parent directory before opening.
  const store = new OfficeStore(path.join(directory, 'workspace.sqlite'));
  const service = new ArtifactService(store, root);
  t.after(() => {
    store.close();
    removeTreeSync(directory);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'General research',
    mandate: 'Evaluate a research hypothesis',
    budgetCents: 0,
  }).projects[0];
  const experiment = store.execute({
    type: 'experiment.create',
    idempotencyKey: randomUUID(),
    projectId: project.id,
    name: 'Forecast experiment',
    hypothesis: 'Evaluate calibration',
  }).experiments[0];
  return { directory, root, store, service, project, experiment };
}
const objectPath = (root: string, hash: string) => path.join(root, 'objects', hash.slice(0, 2), hash);
function resultPackage(
  projectId: string,
  experimentId: string,
  files: Record<string, Uint8Array> = { 'results.json': strToU8('{"score":null,"valid":false}') },
) {
  const manifest = {
    schemaVersion: 1,
    runId: randomUUID(),
    projectId,
    experimentId,
    sourceHash: sha256('final source'),
    terminal: true,
    status: 'INCONCLUSIVE',
    artifacts: Object.entries(files).map(([name, bytes]) => ({
      path: name,
      size: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  return { manifest, files, zip: () => zipSync({ ...files, 'run-manifest.json': strToU8(JSON.stringify(manifest)) }) };
}

test('user imports deduplicate by bytes, scope and kind without inventing evidence or spend', async t => {
  const { directory, root, store, service, project, experiment } = fixture(t);
  const first = path.join(directory, 'baseline.py'),
    copy = path.join(directory, 'renamed.py');
  const source = 'raise RuntimeError("This source must never execute locally")\n';
  await writeFile(first, source);
  await writeFile(copy, source);
  const reference = await service.importFile(first, project.id, experiment.id, 'REFERENCE');
  const before = store.snapshot();
  assert.deepEqual(await service.importFile(copy, project.id, experiment.id, 'REFERENCE'), reference);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(reference.classification, 'UNCLASSIFIED');
  assert.equal(reference.status, 'STORED');
  assert.equal(await readFile(objectPath(root, reference.sha256), 'utf8'), source);
  const result = await service.importFile(first, project.id, experiment.id, 'RESULT');
  assert.notEqual(result.id, reference.id);
  assert.equal(result.classification, 'USER_ATTESTED');
  assert.equal(result.status, 'QUARANTINED');
  assert.deepEqual(store.snapshot().reviews, []);
  assert.deepEqual(store.snapshot().spend, { actualCents: 0, reservedCents: 0 });
});

test('matching bytes in another project receive distinct scoped metadata', async t => {
  const { directory, store, service, project } = fixture(t);
  const second = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Risk research',
    mandate: '',
    budgetCents: 0,
  }).projects[1];
  const file = path.join(directory, 'input.csv');
  await writeFile(file, 'timestamp,value\n2026-01-01,1\n');
  const first = await service.importFile(file, project.id, null, 'REFERENCE');
  const other = await service.importFile(file, second.id, null, 'REFERENCE');
  assert.equal(first.sha256, other.sha256);
  assert.notEqual(first.id, other.id);
  assert.equal(other.projectId, second.id);
});

test('scope and archived-project checks happen before storing any import', async t => {
  const { directory, store, service, project, experiment } = fixture(t);
  const file = path.join(directory, 'data.txt');
  await writeFile(file, 'ordinary data');
  const other = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Other',
    mandate: '',
    budgetCents: 0,
  }).projects[1];
  const before = store.snapshot();
  await assert.rejects(service.importFile(file, other.id, experiment.id, 'REFERENCE'), /does not belong/);
  await assert.rejects(service.importFile(file, randomUUID(), null, 'REFERENCE'), /active project/);
  assert.deepEqual(store.snapshot(), before);
  store.execute({ type: 'project.archive', idempotencyKey: randomUUID(), projectId: project.id, archived: true });
  await assert.rejects(service.importFile(file, project.id, experiment.id, 'RESULT'), /active project/);
  assert.equal(store.snapshot().artifacts.length, 0);
});

test('text previews remain inert, respect a byte limit, and identify binary files', async t => {
  const { directory, service, project } = fixture(t);
  const text = '<script>globalThis.untrusted = true</script>\n' + 'x'.repeat(70000);
  const textFile = path.join(directory, 'findings.md');
  await writeFile(textFile, text);
  const reference = await service.importFile(textFile, project.id, null, 'REFERENCE');
  const preview = await service.preview(reference.id);
  assert.equal(preview.binary, false);
  assert.equal(preview.truncated, true);
  assert.equal(Buffer.byteLength(preview.text), 65536);
  assert.ok(preview.text.startsWith('<script>'));
  assert.equal((globalThis as Record<string, unknown>).untrusted, undefined);
  const binaryFile = path.join(directory, 'model.pkl');
  await writeFile(binaryFile, Buffer.from([0x80, 0x04, 0x00, 0xff]));
  const binary = await service.importFile(binaryFile, project.id, null, 'REFERENCE');
  const info = await service.preview(binary.id);
  assert.equal(info.binary, true);
  assert.equal(info.truncated, false);
  assert.match(info.text, /without executing or deserializing/);
});

test('changed stored bytes block preview, export, backup and repeated import', async t => {
  const { directory, root, store, service, project } = fixture(t);
  const file = path.join(directory, 'reference.txt');
  await writeFile(file, 'original bytes');
  const imported = await service.importFile(file, project.id, null, 'REFERENCE');
  await writeFile(objectPath(root, imported.sha256), 'tampered bytes');
  const before = store.snapshot();
  await assert.rejects(service.preview(imported.id), /identity/);
  await assert.rejects(service.exportProject(project.id, path.join(directory, 'bad-export.zip')), /integrity/);
  await assert.rejects(service.backup(path.join(directory, 'bad-backup.zip')), /integrity/);
  await assert.rejects(service.importFile(file, project.id, null, 'REFERENCE'), /integrity|identity/);
  assert.deepEqual(store.snapshot(), before);
});

test('result archives validate exact inventory without claiming an observed or approved run', () => {
  const projectId = randomUUID(),
    experimentId = randomUUID();
  const pkg = resultPackage(projectId, experimentId);
  const report = inspectResultArchive(pkg.zip(), projectId, experimentId);
  assert.equal(report.manifestValid, true);
  assert.match(report.summary, /INCONCLUSIVE/);
  assert.match(report.summary, /No approved run package or provider verification/);
  assert.throws(() => inspectResultArchive(pkg.zip(), randomUUID(), experimentId), /identity/);
  assert.throws(() => inspectResultArchive(pkg.zip(), projectId, null), /identity/);
});

test('valid and malformed result ZIP imports both stay quarantined with distinct explanatory notes', async t => {
  const { directory, store, service, project, experiment } = fixture(t);
  const validFile = path.join(directory, 'valid-results.zip');
  await writeFile(validFile, resultPackage(project.id, experiment.id).zip());
  const valid = await service.importFile(validFile, project.id, experiment.id, 'RESULT');
  assert.equal(valid.status, 'QUARANTINED');
  assert.match(valid.note, /byte identities match/);
  const malformedFile = path.join(directory, 'malformed-results.zip');
  await writeFile(malformedFile, 'not a ZIP');
  const malformed = await service.importFile(malformedFile, project.id, experiment.id, 'RESULT');
  assert.equal(malformed.status, 'QUARANTINED');
  assert.match(malformed.note, /^Quarantined:/);
  assert.equal(store.snapshot().artifacts.length, 2);
  assert.deepEqual(store.snapshot().reviews, []);
});

test('ZIP manifest rejects missing terminal state, unknown fields and incompatible versions', () => {
  const projectId = randomUUID(),
    experimentId = randomUUID();
  const pkg = resultPackage(projectId, experimentId);
  for (const manifest of [
    { ...pkg.manifest, terminal: false },
    { ...pkg.manifest, schemaVersion: 2 },
    { ...pkg.manifest, providerVerified: true },
    { ...pkg.manifest, sourceHash: 'unknown' },
    { ...pkg.manifest, status: 'PASSED' },
  ])
    assert.throws(() =>
      inspectResultArchive(
        zipSync({ ...pkg.files, 'run-manifest.json': strToU8(JSON.stringify(manifest)) }),
        projectId,
        experimentId,
      ),
    );
  assert.throws(() => inspectResultArchive(zipSync(pkg.files), projectId, experimentId), /run-manifest/);
});

test('ZIP inventory rejects altered bytes, absent declared files, extra files and duplicate inventory paths', () => {
  const projectId = randomUUID(),
    experimentId = randomUUID();
  const pkg = resultPackage(projectId, experimentId);
  const manifestBytes = strToU8(JSON.stringify(pkg.manifest));
  for (const files of [
    { 'run-manifest.json': manifestBytes, 'results.json': strToU8('changed') },
    { 'run-manifest.json': manifestBytes },
    { ...pkg.files, 'run-manifest.json': manifestBytes, 'unexpected.json': strToU8('{}') },
    {
      ...pkg.files,
      'run-manifest.json': strToU8(
        JSON.stringify({ ...pkg.manifest, artifacts: [...pkg.manifest.artifacts, pkg.manifest.artifacts[0]] }),
      ),
    },
  ] as Zippable[])
    assert.throws(() => inspectResultArchive(zipSync(files), projectId, experimentId), /inventory|declared/);
});

test('unsafe entry names, case-colliding names, and Unix symlinks are rejected', () => {
  const projectId = randomUUID(),
    experimentId = randomUUID();
  for (const name of [
    '../outside.txt',
    '/absolute.txt',
    'nested/../outside.txt',
    'C:/windows.txt',
    'nested\\bad.txt',
    'dir//file.txt',
    './file.txt',
    'trailing./file.txt',
    'nul.txt',
    'CON',
  ]) {
    assert.equal(safeEntry(name), false, name);
    const pkg = resultPackage(projectId, experimentId, { [name]: strToU8('bad') });
    assert.throws(() => inspectResultArchive(pkg.zip(), projectId, experimentId), /unsafe|invalid/i, name);
  }
  assert.equal(safeEntry('nested/ordinary.json'), true);
  const colliding = resultPackage(projectId, experimentId, {
    'data.json': strToU8('one'),
    'DATA.json': strToU8('two'),
  });
  assert.throws(() => inspectResultArchive(colliding.zip(), projectId, experimentId), /duplicate|unsafe/i);
  const link = resultPackage(projectId, experimentId, { 'link.txt': strToU8('../../external') });
  const files: Zippable = {
    'run-manifest.json': strToU8(JSON.stringify(link.manifest)),
    'link.txt': [link.files['link.txt'], { os: 3, attrs: 0o120777 << 16 }],
  };
  assert.throws(
    () => inspectResultArchive(zipSync(files), projectId, experimentId),
    /symlink|symbolic|unsafe|special/i,
  );
});

test('ZIP expansion and entry limits reject hostile metadata before decompression', () => {
  const projectId = randomUUID(),
    experimentId = randomUUID();
  const pkg = resultPackage(projectId, experimentId);
  const bytes = Buffer.from(pkg.zip());
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  bytes.writeUInt32LE(MAX_FILE + 1, central + 24);
  assert.throws(() => inspectResultArchive(bytes, projectId, experimentId), /size|limit|permitted|header/i);
  const many: Record<string, Uint8Array> = {};
  for (let i = 0; i < 513; i++) many[`entry-${i}.txt`] = strToU8('');
  assert.throws(() => inspectResultArchive(zipSync(many), projectId, experimentId), /many|limit|oversized/i);
});

test('draft export isolates project data and carries independently checkable byte inventory', async t => {
  const { directory, store, service, project, experiment } = fixture(t);
  const other = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Private other project',
    mandate: 'Do not leak',
    budgetCents: 0,
  }).projects[1];
  const file = path.join(directory, 'reference.json');
  await writeFile(file, '{"schema":"forecast"}');
  const reference = await service.importFile(file, project.id, experiment.id, 'REFERENCE');
  const secretFile = path.join(directory, 'other.txt');
  await writeFile(secretFile, 'Other project confidential reference');
  const secret = await service.importFile(secretFile, other.id, null, 'REFERENCE');
  // The project's memory ledger: an agent-session finding, a user note superseding it,
  // and a settled relationship — the other project's records must not export.
  const sessionAuthor = { surface: 'AGENT_SESSION' as const, receiptHash: sha256('receipt-1') };
  const first = store.recordMemoryFinding({
    projectId: project.id,
    requestId: null,
    assignmentId: null,
    kind: 'OBSERVATION',
    title: 'alpha holds',
    body: 'seen twice',
    evidenceRefs: [],
    createdBy: sessionAuthor,
  }).finding;
  const corrected = store
    .execute({
      type: 'memory.finding.note',
      idempotencyKey: randomUUID(),
      projectId: project.id,
      kind: 'NOTE',
      title: 'alpha corrected',
      body: 'user correction',
      supersedesFindingId: first.id,
    })
    .findings!.find(item => item.title === 'alpha corrected')!;
  const link = store.proposeMemoryRelationship({
    projectId: project.id,
    fromFindingId: corrected.id,
    toFindingId: first.id,
    kind: 'REFINES',
    createdBy: { surface: 'USER' },
  }).relationship;
  store.settleMemoryRelationship({ relationshipId: link.id, status: 'CONFIRMED' });
  const foreign = store.recordMemoryFinding({
    projectId: other.id,
    requestId: null,
    assignmentId: null,
    kind: 'NOTE',
    title: 'other project note',
    body: 'must not export',
    evidenceRefs: [],
    createdBy: sessionAuthor,
  }).finding;
  const foreignTwo = store.recordMemoryFinding({
    projectId: other.id,
    requestId: null,
    assignmentId: null,
    kind: 'RESULT',
    title: 'other result',
    body: 'must not export either',
    evidenceRefs: [],
    createdBy: sessionAuthor,
  }).finding;
  const foreignLink = store.proposeMemoryRelationship({
    projectId: other.id,
    fromFindingId: foreignTwo.id,
    toFindingId: foreign.id,
    kind: 'SUPPORTS',
    createdBy: { surface: 'USER' },
  }).relationship;
  const destination = path.join(directory, 'export.qro.zip');
  await service.exportProject(project.id, destination);
  const files = unzipSync(await readFile(destination));
  const exported = JSON.parse(strFromU8(files['project.json']));
  assert.equal(exported.kind, 'PROJECT_DRAFT_EXPORT');
  assert.equal(exported.project.id, project.id);
  assert.equal(exported.experiments.length, 1);
  assert.ok(exported.events.every((event: { projectId: string }) => event.projectId === project.id));
  assert.deepEqual(exported.approvals, []);
  assert.deepEqual(exported.agents, []);
  assert.match(exported.warning, /Not an approved/);
  assert.equal(files[`objects/${secret.sha256}`], undefined);
  // The exported ledger carries exactly this project's records, provenance intact.
  assert.equal(exported.findings.length, 2);
  const exportedFirst = exported.findings.find((item: { id: string }) => item.id === first.id)!;
  assert.deepEqual(exportedFirst.createdBy, sessionAuthor);
  assert.equal(exportedFirst.supersededById, corrected.id);
  const exportedCorrected = exported.findings.find((item: { id: string }) => item.id === corrected.id)!;
  assert.equal(exportedCorrected.createdBy.surface, 'USER');
  const exportedLink = exported.relationships.find((item: { id: string }) => item.id === link.id)!;
  assert.equal(exportedLink.status, 'CONFIRMED');
  assert.ok(exportedLink.decidedAt, 'the settled relationship carries its decidedAt');
  assert.equal(
    exported.findings.every((item: { projectId: string }) => item.projectId === project.id),
    true,
  );
  assert.equal(
    exported.relationships.every((item: { projectId: string }) => item.projectId === project.id),
    true,
  );
  assert.equal(
    exported.findings.some((item: { id: string }) => item.id === foreign.id || item.id === foreignTwo.id),
    false,
    "the other project's findings must not export",
  );
  assert.equal(
    exported.relationships.some((item: { id: string }) => item.id === foreignLink.id),
    false,
    "the other project's relationship must not export",
  );
  assert.ok(exported.provenance.includes.includes('memory findings'));
  assert.ok(exported.provenance.includes.includes('memory relationships'));
  assert.match(exported.reviewMeaning, /self-reports recorded by the office, not verified facts/);
  assert.equal(sha256(files[`objects/${reference.sha256}`]), reference.sha256);
  const inventory = JSON.parse(strFromU8(files['inventory.json']));
  assert.equal(inventory.inventoryHash, canonicalHash(inventory.entries));
  assert.equal(inventory.entries.length, Object.keys(files).length - 1);
  for (const entry of inventory.entries) {
    assert.equal(files[entry.path].length, entry.size);
    assert.equal(sha256(files[entry.path]), entry.sha256);
  }
  assert.equal(store.snapshot().events.at(-1)?.kind, 'PROJECT_EXPORTED');
});

test('a draft export of a project with no memory records stays well-formed', async t => {
  const { directory, store, service, project } = fixture(t);
  const destination = path.join(directory, 'export-empty.qro.zip');
  await service.exportProject(project.id, destination);
  const exported = JSON.parse(strFromU8(unzipSync(await readFile(destination))['project.json']));
  assert.equal(exported.kind, 'PROJECT_DRAFT_EXPORT');
  assert.deepEqual(exported.findings, []);
  assert.deepEqual(exported.relationships, []);
  assert.ok(exported.provenance.includes.includes('memory findings'));
  assert.ok(exported.provenance.includes.includes('memory relationships'));
});

test('workspace backup verifies every object and reopens the exact recorded state', async t => {
  const { directory, root, store, service, project } = fixture(t);
  const file = path.join(directory, 'evidence.txt');
  await writeFile(file, 'User-selected external evidence');
  const artifact = await service.importFile(file, project.id, null, 'REFERENCE');
  const before = store.snapshot();
  const destination = path.join(directory, 'backup.zip');
  await service.backup(destination);
  const files = unzipSync(await readFile(destination));
  const manifest = JSON.parse(strFromU8(files['backup.json']));
  assert.equal(manifest.kind, 'WORKSPACE_BACKUP');
  assert.equal(manifest.lastEvent, before.events.at(-1)?.hash);
  assert.equal(manifest.files.length, Object.keys(files).length - 1);
  for (const entry of manifest.files) {
    assert.equal(files[entry.path].length, entry.size);
    assert.equal(sha256(files[entry.path]), entry.sha256);
  }
  const restoredRoot = path.join(directory, 'restored');
  await mkdir(restoredRoot);
  await writeFile(path.join(restoredRoot, 'workspace.sqlite'), files['workspace.sqlite']);
  const restoredObject = objectPath(restoredRoot, artifact.sha256);
  await mkdir(path.dirname(restoredObject), { recursive: true });
  await writeFile(restoredObject, files[`objects/${artifact.sha256}`]);
  const restored = new OfficeStore(path.join(restoredRoot, 'workspace.sqlite'));
  try {
    assert.deepEqual(restored.snapshot(), before);
    const preview = await new ArtifactService(restored, restoredRoot).preview(artifact.id);
    assert.equal(preview.text, 'User-selected external evidence');
  } finally {
    restored.close();
  }
  assert.equal(store.snapshot().events.at(-1)?.kind, 'WORKSPACE_BACKED_UP');
  assert.deepEqual(await readdir(path.join(root, 'staging')), []);
});

test('failed export writes no transfer receipt and cleans temporary output', async t => {
  const { directory, store, service, project } = fixture(t);
  const before = store.snapshot();
  const destination = path.join(directory, 'missing-parent', 'export.zip');
  await assert.rejects(service.exportProject(project.id, destination), /ENOENT/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(
    (await readdir(directory)).some(name => name.endsWith('.tmp')),
    false,
  );
});
