import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store.js';
import { ArtifactService } from '../src/main/artifacts.js';
import { prepareRestore, commitRestore, recoverInterruptedRestore, workspaceDirectory } from '../src/main/recovery.js';

test('verified backup restores records and objects while retaining the previous workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qro-recovery-')),
    live = workspaceDirectory(root);
  await mkdir(live);
  const store = new OfficeStore(path.join(live, 'workspace.sqlite'));
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Original',
    mandate: '',
    budgetCents: 0,
  }).projects[0];
  const service = new ArtifactService(store, live),
    input = path.join(root, 'reference.txt');
  await writeFile(input, 'inert reference');
  const artifact = await service.importFile(input, project.id, null, 'REFERENCE');
  const archive = path.join(root, 'backup.zip');
  await service.backup(archive);
  store.execute({ type: 'project.create', idempotencyKey: randomUUID(), name: 'Later', mandate: '', budgetCents: 0 });
  const prepared = await prepareRestore(archive, root);
  store.close();
  await commitRestore(root, prepared.transactionId);
  const restored = new OfficeStore(path.join(live, 'workspace.sqlite'));
  try {
    assert.equal(restored.snapshot().projects.length, 1);
    assert.equal(restored.snapshot().events.at(-1)?.kind, 'WORKSPACE_RESTORED');
    assert.equal(
      await readFile(path.join(live, 'objects', artifact.sha256.slice(0, 2), artifact.sha256), 'utf8'),
      'inert reference',
    );
  } finally {
    restored.close();
  }
  assert.ok((await stat(path.join(root, 'recovery', 'workspace-' + prepared.transactionId))).isDirectory());
});

test('interrupted directory replacement recovers the retained workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qro-interrupted-')),
    live = workspaceDirectory(root),
    id = randomUUID();
  await mkdir(live);
  await writeFile(path.join(live, 'sentinel'), 'original');
  await mkdir(path.join(root, 'recovery'));
  await rename(live, path.join(root, 'recovery', 'workspace-' + id));
  await writeFile(path.join(root, 'restore-journal.json'), JSON.stringify({ schemaVersion: 1, transactionId: id }));
  await recoverInterruptedRestore(root);
  assert.equal(await readFile(path.join(live, 'sentinel'), 'utf8'), 'original');
});

test('non-backup bytes cannot replace a workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qro-invalid-'));
  const file = path.join(root, 'bad.zip');
  await writeFile(file, 'not a backup');
  await assert.rejects(prepareRestore(file, root));
});
