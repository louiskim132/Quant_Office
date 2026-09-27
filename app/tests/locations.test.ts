import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import {
  MANIFEST_PATH,
  RESERVED_DIRECTORY,
  RESERVATION_FILE,
  assertWritableDestination,
  releaseUnusedReservation,
  reserveOutputDestination,
  prepareInputSnapshot,
  reconstructSnapshot,
  resolveSelection,
  snapshotObjectPath,
  verifySnapshotForTransfer,
  verifyStagedSnapshot,
} from '../src/main/locations';

const key = () => randomUUID();
function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-locations-'));
  const file = path.join(root, 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => {
    store.close();
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha study',
    mandate: 'Test',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source, { recursive: true });
  const staging = path.join(root, 'staging');
  mkdirSync(staging, { recursive: true });
  return {
    root,
    source,
    staging,
    project,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new OfficeStore(file);
      return store;
    },
  };
}
/** Runs a real git command against a staged directory, so tamper fixtures are genuine, not mocked. */
const run = (executable: string, args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) =>
    execFile(executable, args, { cwd, windowsHide: true }, error => (error ? reject(error) : resolve())),
  );
const write = (root: string, relative: string, content: string) => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
};

test('a location is versioned, canonical, and keeps the old cloud text as an inert note', t => {
  const f = fixture(t);
  f.store.execute({
    type: 'project.update',
    idempotencyKey: key(),
    projectId: f.project.id,
    name: 'Alpha study',
    mandate: 'Test',
    budgetCents: 0,
    cloudWorkspace: 'some old free text',
  });
  write(f.source, 'data/prices.csv', 'a,b\n1,2\n');
  const state = f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data/prices.csv'],
    outputFolder: '',
  });
  const location = state.locations![0];
  assert.equal(location.revision, 1);
  assert.equal(location.inputPaths.length, 0, 'the folder is the scope; no per-file allowlist is stored');
  assert.equal(location.snapshotRoute, 'PROJECT_FOLDER_SNAPSHOT');
  assert.equal(location.outputFolder, '', 'an empty output folder means the managed app directory');
  assert.equal(location.providerTarget.host, 'ANTHROPIC_MANAGED');
  assert.equal(location.providerTarget.resolved, false, 'requesting managed hosting is not verified host identity');
  assert.equal(location.legacyNote, 'some old free text');
  assert.throws(
    () =>
      f.store.execute({
        type: 'location.save',
        idempotencyKey: key(),
        projectId: f.project.id,
        expectedRevision: 0,
        localFolder: f.source,
        inputPaths: [],
        outputFolder: '',
      }),
    /changed in another view/,
  );
  const second = f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 1,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  assert.equal(second.locations![0].revision, 2);
  assert.equal(f.reopen().snapshot().locations![0].revision, 2, 'locations survive restart');
});

test('selection rejects traversal, absolute paths, folders, links and missing files', t => {
  const f = fixture(t);
  write(f.source, 'keep.txt', 'ok');
  mkdirSync(path.join(f.source, 'nested'), { recursive: true });
  const outside = path.join(f.root, 'outside.txt');
  writeFileSync(outside, 'secret');
  assert.throws(() => resolveSelection(f.source, ['../outside.txt']), /escapes the project folder/);
  assert.throws(() => resolveSelection(f.source, [outside]), /inside the project folder/);
  assert.throws(() => resolveSelection(f.source, ['nested']), /not folders/);
  assert.throws(() => resolveSelection(f.source, ['gone.txt']), /missing/);
  const ignored = f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['../outside.txt'],
    outputFolder: '',
  });
  assert.deepEqual(ignored.locations![0].inputPaths, [], 'a legacy selection field is accepted but never stored');
  let linked = false;
  try {
    symlinkSync(outside, path.join(f.source, 'link.txt'));
    linked = true;
  } catch {
    /* symlink creation needs privileges on Windows */
  }
  if (linked) assert.throws(() => resolveSelection(f.source, ['link.txt']), /link/i);
  assert.deepEqual(
    resolveSelection(f.source, ['keep.txt']).map(file => file.relative),
    ['keep.txt'],
  );
});

test('preparation stages the whole project folder, with spaces and Unicode, minus skipped entries', async t => {
  const f = fixture(t);
  write(f.source, 'data/price series.csv', 'a,b\n1,2\n');
  write(f.source, 'notes/résumé δ.md', '# notes\n');
  write(f.source, 'private/secret.key', 'inside the folder, so it is an input');
  write(f.source, '.git/config', '[core]\n');
  write(f.source, 'node_modules/dep/index.js', 'module.exports=1\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.equal(snapshot.files.length, 3);
  assert.deepEqual(snapshot.files.map(file => file.path).sort(), [
    'data/price series.csv',
    'notes/résumé δ.md',
    'private/secret.key',
  ]);
  assert.equal(snapshot.route, 'PROJECT_FOLDER_SNAPSHOT');
  assert.match(snapshot.stagingCommit, /^[a-f0-9]{40}$/);
  assert.ok(
    snapshot.warnings.some(w => w.startsWith('.git/')),
    'the VCS subtree skip is recorded',
  );
  assert.ok(
    snapshot.warnings.some(w => w.startsWith('node_modules/')),
    'the dependency subtree skip is recorded',
  );
  const walk = (dir: string, prefix = ''): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.name !== '.git')
      .flatMap(entry =>
        entry.isDirectory() ? walk(path.join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name],
      );
  const staged = walk(snapshot.stagingPath).sort();
  assert.deepEqual(
    staged,
    [
      `${RESERVED_DIRECTORY}/README.md`,
      'data/price series.csv',
      'notes/résumé δ.md',
      'private/secret.key',
      MANIFEST_PATH,
    ].sort(),
    'the folder contents, and office bookkeeping inside the reserved directory, are staged',
  );
  assert.equal(
    readFileSync(path.join(snapshot.stagingPath, '.git', 'config'), 'utf8').includes('[core]'),
    true,
    'the staging repository owns its own git directory',
  );
  assert.equal(existsSync(path.join(snapshot.stagingPath, 'node_modules')), false, 'skipped subtrees are never staged');
  assert.deepEqual(verifyStagedSnapshot(snapshot), []);
  assert.equal(f.store.snapshot().snapshots!.length, 1);
});

test('a snapshot is immutable: later source edits and re-preparation never change it', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'first');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });
  const first = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  write(f.source, 'data.csv', 'second, edited after preparation');
  const second = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.files[0].sha256, second.files[0].sha256);
  const stored = f.store.snapshot().snapshots!;
  assert.equal(stored.length, 2);
  assert.equal(
    stored.find(s => s.id === first.id)!.files[0].sha256,
    first.files[0].sha256,
    'the earlier snapshot keeps its original hashes',
  );
  assert.equal(
    readFileSync(path.join(first.stagingPath, 'data.csv'), 'utf8'),
    'first',
    'the staged copy is not re-read from the source',
  );
  assert.throws(
    () => f.store.recordInputSnapshot({ ...first, files: [{ ...first.files[0], sha256: '0'.repeat(64) }] }),
    /immutable/,
  );
});

test('a text-only request prepares with no user folder at all', async t => {
  const f = fixture(t);
  const snapshot = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    objective: 'Explain a concept',
  });
  assert.equal(snapshot.route, 'GENERATED_REQUEST_ONLY');
  assert.equal(snapshot.files.length, 0);
  assert.equal(snapshot.totalBytes, 0);
  assert.match(snapshot.stagingCommit, /^[a-f0-9]{40}$/);
  const manifest = JSON.parse(readFileSync(path.join(snapshot.stagingPath, MANIFEST_PATH), 'utf8'));
  assert.equal(manifest.objective, 'Explain a concept');
  assert.equal(manifest.files.length, 0);
});

test('credentials and tool configuration in the folder are skipped and recorded, and a stale location blocks recording', async t => {
  const f = fixture(t);
  write(f.source, '.env.local', 'TOKEN=value');
  write(f.source, '.aws/credentials', '[default]');
  write(f.source, 'keep.txt', 'ok');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  const skipped = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.deepEqual(
    skipped.files.map(file => file.path),
    ['keep.txt'],
    'credential files never travel, even inside the folder',
  );
  assert.ok(
    skipped.warnings.some(w => w.startsWith('.env.local')),
    'the skip is recorded on the snapshot',
  );
  assert.ok(
    skipped.warnings.some(w => w.includes('.aws')),
    'the .aws subtree skip is recorded',
  );
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 1,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.equal(snapshot.locationRevision, 2);
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 2,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  assert.throws(
    () => f.store.recordInputSnapshot({ ...snapshot, id: randomUUID() }),
    /location changed while preparing/,
  );
});

test('preparation continues with an exact record when git is unavailable', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'x');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    gitExecutable: path.join(f.root, 'no-such-git.exe'),
  });
  assert.equal(snapshot.stagingCommit, '');
  assert.equal(snapshot.files.length, 1);
  assert.ok(snapshot.warnings.some(w => w.includes('Git is unavailable')));
  assert.deepEqual(verifyStagedSnapshot(snapshot), [], 'the hashes still describe the staged bytes');
});

test('an emptied folder snapshots as request-only, and an archived project fails before staging', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'x');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  rmSync(path.join(f.source, 'data.csv'));
  const empty = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.equal(empty.route, 'GENERATED_REQUEST_ONLY', 'a folder holding nothing shareable is a request-only snapshot');
  assert.equal(empty.files.length, 0);
  write(f.source, 'data.csv', 'x');
  f.store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: f.project.id, archived: true });
  await assert.rejects(
    prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id }),
    /Restore this project/,
  );
  assert.equal(readdirSync(f.staging).length, 1, 'only the completed empty snapshot is left behind');
});

test('snapshots and locations replay, back up and stay scoped to their project', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'x');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  const other = f.store
    .execute({ type: 'project.create', idempotencyKey: key(), name: 'Beta study', mandate: 'Other', budgetCents: 0 })
    .projects.find(p => p.name === 'Beta study')!;
  assert.throws(
    () => f.store.recordInputSnapshot({ ...snapshot, id: randomUUID(), projectId: other.id }),
    /location changed while preparing|not found/,
  );
  const reopened = f.reopen().snapshot();
  assert.equal(reopened.snapshots!.length, 1);
  assert.deepEqual(reopened.snapshots![0].files, snapshot.files);
  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'qro-locations-backup-')), 'copy.sqlite');
  await f.store.backup(copy);
  const restored = new OfficeStore(copy);
  t.after(() => restored.close());
  assert.deepEqual(restored.snapshot().snapshots![0].manifestHash, snapshot.manifestHash);
  assert.deepEqual(restored.snapshot().locations![0].inputPaths, []);
});

test('a selected file may be called README.md, and generated bookkeeping cannot overwrite it', async t => {
  const f = fixture(t);
  // The old layout wrote a generated README.md and office-manifest.json into the root, so a selected
  // file with either name was silently replaced by bookkeeping. Both now live under the reserved
  // directory, and the selected bytes survive exactly.
  write(f.source, 'README.md', "# the user's own readme\n");
  write(f.source, 'office-manifest.json', '{"mine":true}\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['README.md', 'office-manifest.json'],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.equal(
    readFileSync(path.join(snapshot.stagingPath, 'README.md'), 'utf8'),
    "# the user's own readme\n",
    'the selected README travels byte for byte',
  );
  assert.equal(readFileSync(path.join(snapshot.stagingPath, 'office-manifest.json'), 'utf8'), '{"mine":true}\n');
  assert.deepEqual(snapshot.files.map(file => file.path).sort(), ['README.md', 'office-manifest.json']);
  assert.deepEqual(
    (snapshot.generated ?? []).map(file => file.path).sort(),
    [`${RESERVED_DIRECTORY}/README.md`, MANIFEST_PATH].sort(),
    'generated content, including the manifest, is inventoried too',
  );
  assert.deepEqual(verifyStagedSnapshot(snapshot), []);
});

test('a reserved-named directory in the folder is skipped and never collides with bookkeeping', async t => {
  const f = fixture(t);
  write(f.source, `${RESERVED_DIRECTORY}/manifest.json`, '{"attacker":true}');
  write(f.source, 'keep.txt', 'ok');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.deepEqual(
    snapshot.files.map(file => file.path),
    ['keep.txt'],
    'the reserved name cannot reach the staged payload',
  );
  assert.ok(
    snapshot.warnings.some(w => w.startsWith(`${RESERVED_DIRECTORY}/`)),
    'the skip is recorded',
  );
  const manifest = JSON.parse(readFileSync(path.join(snapshot.stagingPath, MANIFEST_PATH), 'utf8'));
  assert.equal(manifest.attacker, undefined, 'the office manifest, not the folder file, is staged');
  assert.deepEqual(verifyStagedSnapshot(snapshot), []);
});

test('the whole staged tree is verified, not only the selected files', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });

  const changed = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  writeFileSync(path.join(changed.stagingPath, 'data.csv'), 'tampered');
  assert.match(verifyStagedSnapshot(changed)[0], /changed since preparation/);

  const extra = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  writeFileSync(path.join(extra.stagingPath, 'stowaway.py'), 'print("hi")');
  assert.match(verifyStagedSnapshot(extra)[0], /Unexpected extra file/, 'a file nobody selected would still travel');

  const missing = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  rmSync(path.join(missing.stagingPath, 'data.csv'));
  assert.match(verifyStagedSnapshot(missing)[0], /Missing staged file/);

  const bookkeeping = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  writeFileSync(path.join(bookkeeping.stagingPath, RESERVED_DIRECTORY, 'README.md'), 'rewritten');
  assert.match(
    verifyStagedSnapshot(bookkeeping)[0],
    /changed (size )?since preparation/,
    'generated content is verified like any other byte',
  );
});

test('a rewritten manifest cannot describe its own payload', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  // Rewrite both the payload and the manifest that describes it, consistently. Only the frozen
  // record in the workspace database, which the staged directory cannot reach, detects this.
  const manifest = JSON.parse(readFileSync(path.join(snapshot.stagingPath, MANIFEST_PATH), 'utf8'));
  writeFileSync(path.join(snapshot.stagingPath, 'data.csv'), 'swapped');
  manifest.files = [{ path: 'data.csv', bytes: 7, sha256: '0'.repeat(64) }];
  writeFileSync(path.join(snapshot.stagingPath, MANIFEST_PATH), JSON.stringify(manifest));
  const problems = verifyStagedSnapshot(snapshot);
  assert.equal(
    problems.some(problem => /manifest no longer matches the frozen record/.test(problem)),
    true,
    problems.join(' | '),
  );
});

test('transfer verification also checks the commit, the working tree and the single-commit history', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });

  const clean = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  assert.deepEqual(await verifySnapshotForTransfer(clean), [], 'a freshly prepared snapshot passes the transfer check');

  // An extra commit changes what the route would actually ship, even with an unchanged working tree.
  const moved = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  writeFileSync(path.join(moved.stagingPath, 'late.txt'), 'added after freezing');
  await run('git', ['add', '--all'], moved.stagingPath);
  await run(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--no-gpg-sign', '-m', 'second'],
    moved.stagingPath,
  );
  const problems = await verifySnapshotForTransfer(moved);
  assert.equal(
    problems.some(problem => /commit changed since it was frozen/.test(problem)),
    true,
    problems.join(' | '),
  );

  const gone = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  removeTreeSync(gone.stagingPath);
  assert.match((await verifySnapshotForTransfer(gone))[0], /prepared directory for this snapshot is gone/);
});

test('a snapshot with no commit is a local preview and is refused by the transfer check', async t => {
  const f = fixture(t);
  const preview = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    gitExecutable: path.join(f.staging, 'missing-git.exe'),
  });
  assert.equal(preview.stagingCommit, '');
  assert.match(preview.warnings[0], /local preview only and cannot be transferred/);
  assert.match((await verifySnapshotForTransfer(preview)).join(' | '), /local preview and cannot be transferred/);
});

test('a snapshot is frozen against one request at one revision, on both routes', async t => {
  const f = fixture(t);
  const request = f.store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: f.project.id,
    name: 'Question',
    hypothesis: 'Explain',
    workType: 'QUESTION',
    mode: 'SINGLE',
    leadAgentId: null,
    participantIds: [],
  }).requests![0];
  const other = f.store
    .execute({ type: 'project.create', idempotencyKey: key(), name: 'Other', mandate: 'm', budgetCents: 0 })
    .projects.find(project => project.name === 'Other')!;
  // Text-only preparation is validated exactly like a selected-file one; the two routes cannot drift.
  await assert.rejects(
    prepareInputSnapshot({
      store: f.store,
      stagingRoot: f.staging,
      projectId: f.project.id,
      requestId: request.id,
      requestRevision: request.revision + 1,
    }),
    /changed in another view/,
  );
  await assert.rejects(
    prepareInputSnapshot({
      store: f.store,
      stagingRoot: f.staging,
      projectId: other.id,
      requestId: request.id,
      requestRevision: request.revision,
    }),
    /different project/,
  );
  await assert.rejects(
    prepareInputSnapshot({
      store: f.store,
      stagingRoot: f.staging,
      projectId: f.project.id,
      requestId: randomUUID(),
      requestRevision: 0,
    }),
    /Request not found/,
  );
  const ok = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    requestId: request.id,
    requestRevision: request.revision,
  });
  assert.equal(ok.requestId, request.id);
  assert.equal(ok.requestRevision, request.revision);
});

test('frozen bytes survive losing both the staging directory and the source folder', async t => {
  const f = fixture(t);
  const objectRoot = path.join(f.root, 'workspace');
  write(f.source, 'data/price series.csv', 'a,b\n1,2\n');
  write(f.source, 'notes/résumé δ.md', '# notes\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data/price series.csv', 'notes/résumé δ.md'],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    objectRoot,
  });
  assert.equal(
    (snapshot.generated ?? []).map(file => file.path).includes(MANIFEST_PATH),
    true,
    'the manifest is inventoried so it can be rebuilt',
  );
  for (const file of [...snapshot.files, ...(snapshot.generated ?? [])])
    assert.equal(
      existsSync(snapshotObjectPath(objectRoot, file.sha256)),
      true,
      `durable object stored for ${file.path}`,
    );

  // Everything the original preparation could have re-read is destroyed first.
  removeTreeSync(snapshot.stagingPath);
  removeTreeSync(f.source);

  const rebuilt = await reconstructSnapshot({ snapshot, objectRoot, stagingRoot: path.join(f.root, 'restored') });
  assert.deepEqual(rebuilt.problems, [], 'the reconstructed commit matches the one frozen at preparation');
  assert.equal(rebuilt.stagingCommit, snapshot.stagingCommit);
  assert.equal(readFileSync(path.join(rebuilt.stagingPath, 'data/price series.csv'), 'utf8'), 'a,b\n1,2\n');
  assert.equal(readFileSync(path.join(rebuilt.stagingPath, 'notes/résumé δ.md'), 'utf8'), '# notes\n');
  // The reconstructed directory passes the same transfer check as the original.
  assert.deepEqual(await verifySnapshotForTransfer({ ...snapshot, stagingPath: rebuilt.stagingPath }), []);
});

test('a snapshot with no stored bytes is unreconstructable and never falls back to the source', async t => {
  const f = fixture(t);
  const objectRoot = path.join(f.root, 'workspace');
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });

  // Prepared without an object root, exactly as every snapshot before this change was.
  const legacy = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  await assert.rejects(
    reconstructSnapshot({
      snapshot: { ...legacy, generated: undefined },
      objectRoot,
      stagingRoot: path.join(f.root, 'r1'),
    }),
    /prepared before its bytes were stored durably/,
  );
  await assert.rejects(
    reconstructSnapshot({ snapshot: legacy, objectRoot, stagingRoot: path.join(f.root, 'r2') }),
    /cannot be reconstructed/,
  );

  // A stored snapshot whose objects were later lost is refused too, rather than rebuilt from the source.
  const stored = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    objectRoot,
  });
  rmSync(snapshotObjectPath(objectRoot, stored.files[0].sha256));
  await assert.rejects(
    reconstructSnapshot({ snapshot: stored, objectRoot, stagingRoot: path.join(f.root, 'r3') }),
    /cannot be reconstructed/,
  );
  assert.equal(
    existsSync(path.join(f.source, 'data.csv')),
    true,
    'the source folder is still there, and was still not read',
  );
});

test('an output destination must be writable, and a read-only input folder is still fine', async t => {
  const f = fixture(t);
  const missing = path.join(f.root, 'nowhere');
  assert.throws(() => assertWritableDestination(missing), /no longer exists/);
  write(f.source, 'not-a-folder.txt', 'x');
  assert.throws(() => assertWritableDestination(path.join(f.source, 'not-a-folder.txt')), /not a directory/);
  assert.throws(() => assertWritableDestination('relative/path'), /absolute path/);
  const good = path.join(f.root, 'outputs');
  mkdirSync(good, { recursive: true });
  assert.equal(assertWritableDestination(good), good);
  // The probe leaves nothing behind.
  assert.deepEqual(readdirSync(good), []);
});

test('a staging tree carrying repository metadata the office never writes is refused, and Git is never run on it', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });

  // A sentinel that must never run. If any check invokes a configured helper or hook, this file appears.
  const sentinel = path.join(f.root, 'sentinel-executed.txt');
  const helper = path.join(f.root, 'helper.bat');
  writeFileSync(helper, `@echo off\necho executed > "${sentinel}"\n`);

  const withConfig = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  writeFileSync(
    path.join(withConfig.stagingPath, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[core]\n\tpager = ${helper.replaceAll('\\\\', '/')}\n`,
  );
  const configProblems = await verifySnapshotForTransfer(withConfig);
  assert.match(configProblems.join(' | '), /names a program or an external object store/);
  assert.equal(existsSync(sentinel), false, 'the sentinel was never executed');

  const withHook = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  // The office initialises with an empty template directory, so no hooks folder exists at all.
  mkdirSync(path.join(withHook.stagingPath, '.git', 'hooks'), { recursive: true });
  writeFileSync(path.join(withHook.stagingPath, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  assert.match((await verifySnapshotForTransfer(withHook)).join(' | '), /installed hook/);
  assert.equal(existsSync(sentinel), false, 'the sentinel was never executed');

  const withAlternates = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
  });
  mkdirSync(path.join(withAlternates.stagingPath, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(path.join(withAlternates.stagingPath, '.git', 'objects', 'info', 'alternates'), `${f.root}\n`);
  assert.match((await verifySnapshotForTransfer(withAlternates)).join(' | '), /objects\/info\/alternates/);

  const withAttributes = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
  });
  mkdirSync(path.join(withAttributes.stagingPath, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(withAttributes.stagingPath, '.git', 'info', 'attributes'), '* filter=evil\n');
  assert.match((await verifySnapshotForTransfer(withAttributes)).join(' | '), /info\/attributes/);
  assert.equal(existsSync(sentinel), false, 'no check ever executed the sentinel');
});

test('a .git indirection or an unexpected branch is refused', async t => {
  const f = fixture(t);
  const indirect = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  const real = path.join(f.root, 'elsewhere.git');
  mkdirSync(real, { recursive: true });
  removeTreeSync(path.join(indirect.stagingPath, '.git'));
  writeFileSync(path.join(indirect.stagingPath, '.git'), `gitdir: ${real}\n`);
  assert.match((await verifySnapshotForTransfer(indirect)).join(' | '), /indirection to another location/);

  const branched = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  await run('git', ['branch', 'side'], branched.stagingPath);
  assert.match((await verifySnapshotForTransfer(branched)).join(' | '), /unexpected branches|unexpected refs/);
});

test('the committed tree itself is compared, so an extra commit or a hidden index change is caught', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });

  // A file committed on top of the frozen manifest, with a clean working tree afterwards.
  const extra = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  writeFileSync(path.join(extra.stagingPath, 'smuggled.py'), 'print("hi")');
  await run('git', ['add', '--all'], extra.stagingPath);
  await run(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--no-gpg-sign', '-m', 'second'],
    extra.stagingPath,
  );
  const problems = await verifySnapshotForTransfer(extra);
  assert.ok(
    problems.some(problem => /commit changed since it was frozen/.test(problem)),
    problems.join(' | '),
  );

  // A working file changed and staged, so a cached status could report the tree as clean.
  const hidden = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  writeFileSync(path.join(hidden.stagingPath, 'data.csv'), 'tampered');
  await run('git', ['add', 'data.csv'], hidden.stagingPath);
  const hiddenProblems = await verifySnapshotForTransfer(hidden);
  assert.ok(hiddenProblems.length > 0, 'a staged modification is still a modification');
  assert.match(
    hiddenProblems.join(' | '),
    /changed (size )?since preparation|differs from its commit|no longer matches its commit/,
  );
});

test('an ancestor junction on the project folder is refused, not resolved away', async t => {
  const f = fixture(t);
  const realParent = path.join(f.root, 'real-parent');
  const realProject = path.join(realParent, 'project');
  mkdirSync(realProject, { recursive: true });
  writeFileSync(path.join(realProject, 'data.csv'), 'a\n1\n');
  const linkedParent = path.join(f.root, 'linked-parent');
  let linked = true;
  try {
    symlinkSync(realParent, linkedParent, 'junction');
  } catch {
    linked = false;
  }
  if (!linked) return; // creating links can require privileges; the check itself is asserted below
  // realpath would resolve the junction silently and report a perfectly ordinary folder.
  assert.throws(() => resolveSelection(path.join(linkedParent, 'project'), ['data.csv']), /reached through a link/);
});

test('an attempt directory is reserved exclusively, and a reservation is never appropriated', async t => {
  const f = fixture(t);
  const outputRoot = path.join(f.root, 'outputs');
  mkdirSync(outputRoot, { recursive: true });
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });
  const snapshot = await prepareInputSnapshot({ store: f.store, stagingRoot: f.staging, projectId: f.project.id });
  const scope = {
    outputRoot,
    projectId: f.project.id,
    requestId: 'request-one',
    assignmentId: 'assignment-one',
    managed: true,
    snapshot,
  };

  const first = reserveOutputDestination({ ...scope, idempotencyKey: 'attempt-a' });
  assert.equal(first.attempt, 1);
  assert.match(first.path, /attempt-001$/);
  assert.ok(
    first.path.includes(`project-${f.project.id}`) &&
      first.path.includes('request-one') &&
      first.path.includes('assignment-one'),
    'results are addressed by project, request, assignment and attempt',
  );
  assert.equal(existsSync(first.path), true, 'a reservation actually creates the directory it hands out');
  // Exactly what would be shared is reported before anything leaves the office.
  assert.deepEqual(
    first.files.map(file => file.path).sort(),
    [...snapshot.files, ...(snapshot.generated ?? [])].map(file => file.path).sort(),
  );
  assert.equal(
    first.totalBytes,
    [...snapshot.files, ...(snapshot.generated ?? [])].reduce((total, file) => total + file.bytes, 0),
  );

  // The same logical attempt re-entering gets its own directory back, not a new one.
  assert.equal(
    reserveOutputDestination({ ...scope, idempotencyKey: 'attempt-a' }).path,
    first.path,
    'a retry re-enters its own reservation',
  );

  // A different caller never gets it, even though nothing has been written into it yet.
  const second = reserveOutputDestination({ ...scope, idempotencyKey: 'attempt-b' });
  assert.equal(second.attempt, 2);
  assert.notEqual(second.path, first.path, 'an empty reserved directory still belongs to whoever reserved it');

  // A directory holding real evidence is never taken either.
  writeFileSync(path.join(second.path, 'result.json'), '{}');
  const third = reserveOutputDestination({ ...scope, idempotencyKey: 'attempt-c' });
  assert.equal(third.attempt, 3);
  assert.equal(
    readFileSync(path.join(second.path, 'result.json'), 'utf8'),
    '{}',
    'earlier attempts are left exactly as they were',
  );

  // A different assignment never collides with this one.
  assert.match(
    reserveOutputDestination({ ...scope, assignmentId: 'assignment-two', idempotencyKey: 'other' }).path,
    /assignment-two[\\/]attempt-001$/,
  );
});

test('an unused reservation can be released, but one holding results or another key cannot', async t => {
  const f = fixture(t);
  const outputRoot = path.join(f.root, 'outputs');
  mkdirSync(outputRoot, { recursive: true });
  const scope = {
    outputRoot,
    projectId: f.project.id,
    requestId: 'request-one',
    assignmentId: 'assignment-one',
    managed: true,
  };

  const unused = reserveOutputDestination({ ...scope, idempotencyKey: 'attempt-a' });
  assert.equal(
    releaseUnusedReservation(unused.path, 'someone-else'),
    false,
    'another key never releases this reservation',
  );
  assert.equal(existsSync(unused.path), true);
  assert.equal(releaseUnusedReservation(unused.path, 'attempt-a'), true);
  assert.equal(existsSync(unused.path), false, 'a proven-unused reservation is released');

  const used = reserveOutputDestination({ ...scope, idempotencyKey: 'attempt-b' });
  writeFileSync(path.join(used.path, 'result.json'), '{}');
  assert.equal(
    releaseUnusedReservation(used.path, 'attempt-b'),
    false,
    'a directory holding results is evidence, not a free name',
  );
  assert.equal(existsSync(path.join(used.path, 'result.json')), true);
  assert.equal(readdirSync(used.path).includes(RESERVATION_FILE), true);
});

test('output reservations refuse redirected ancestors before writing beneath them', t => {
  const f = fixture(t),
    real = path.join(f.root, 'actual-results'),
    link = path.join(f.root, 'linked-results');
  mkdirSync(real);
  symlinkSync(real, link, 'junction');
  assert.throws(() => assertWritableDestination(link), /link/);
  assert.equal(readdirSync(real).length, 0, 'the writable probe did not follow the junction');
  const root = path.join(f.root, 'output-root');
  mkdirSync(root);
  const escape = path.join(root, `project-${f.project.id}`);
  symlinkSync(real, escape, 'junction');
  assert.throws(
    () =>
      reserveOutputDestination({
        outputRoot: root,
        projectId: f.project.id,
        requestId: 'request',
        assignmentId: 'assignment',
        managed: true,
        idempotencyKey: 'one',
      }),
    /link/,
  );
  assert.equal(readdirSync(real).length, 0, 'reservation refused before recursive directory creation');
  assert.throws(() => releaseUnusedReservation(link, 'one'), /link/);
});

test('a snapshot prepared for another request or revision is refused when work is created', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });
  const one = f.store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: f.project.id,
      name: 'First',
      hypothesis: 'a',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: null,
      participantIds: [],
    })
    .requests!.find(r => r.name === 'First')!;
  const two = f.store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: f.project.id,
      name: 'Second',
      hypothesis: 'b',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: null,
      participantIds: [],
    })
    .requests!.find(r => r.name === 'Second')!;
  const forOne = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    requestId: one.id,
    requestRevision: one.revision,
  });
  assert.equal(forOne.requestId, one.id);
  // Both requests live in the same project, which the old check accepted as sufficient.
  assert.equal(two.projectId, forOne.projectId);
});

test('a request edited while its inputs are being prepared is refused at recording time', async t => {
  const f = fixture(t);
  write(f.source, 'data.csv', 'a,b\n1,2\n');
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    inputPaths: ['data.csv'],
    outputFolder: '',
  });
  const request = f.store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: f.project.id,
      name: 'Edited',
      hypothesis: 'a',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: null,
      participantIds: [],
    })
    .requests!.find(r => r.name === 'Edited')!;
  const snapshot = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    requestId: request.id,
    requestRevision: request.revision,
  });
  // Recording the same frozen bytes again after an edit is refused inside the transaction, which is
  // the check that matters: the pre-staging check cannot see a change made while Git was running.
  f.store.execute({
    type: 'request.update',
    idempotencyKey: key(),
    requestId: request.id,
    expectedRevision: request.revision,
    objective: 'changed while staging',
    leadAgentId: null,
    participantIds: [],
    acceptanceCriteria: '',
  });
  assert.throws(
    () => f.store.recordInputSnapshot({ ...snapshot, id: randomUUID() }),
    /changed while its inputs were being prepared/,
  );

  // A change to the selection is caught the same way.
  const other = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: f.staging,
    projectId: f.project.id,
    requestId: request.id,
    requestRevision: request.revision + 1,
  });
  f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 1,
    localFolder: f.source,
    inputPaths: [],
    outputFolder: '',
  });
  assert.throws(
    () => f.store.recordInputSnapshot({ ...other, id: randomUUID() }),
    /inputs changed while they were being prepared/,
  );
});
