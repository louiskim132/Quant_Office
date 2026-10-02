import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Build tooling is standalone JavaScript.
import { resetGeneratedDirectory } from '../scripts/staging.mjs';

test('generated build and package staging remove obsolete files and preserve unrelated releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qro-staging-'));
  try {
    await mkdir(join(root, 'dist/package-input/dist/main'), { recursive: true });
    await mkdir(join(root, 'release/previous'), { recursive: true });
    await writeFile(join(root, 'release/previous/keep.txt'), 'previous release');
    await writeFile(join(root, 'dist/package-input/obsolete.txt'), 'would pass the heuristic scan');
    await resetGeneratedDirectory(root, join(root, 'dist/package-input'));
    await assert.rejects(readFile(join(root, 'dist/package-input/obsolete.txt')), { code: 'ENOENT' });
    await writeFile(join(root, 'dist/obsolete-module.cjs'), 'obsolete code');
    await resetGeneratedDirectory(root, join(root, 'dist'));
    await assert.rejects(readFile(join(root, 'dist/obsolete-module.cjs')), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'release/previous/keep.txt'), 'utf8'), 'previous release');
    await assert.rejects(resetGeneratedDirectory(root, root), /escaped/);
    await assert.rejects(resetGeneratedDirectory(root, join(root, '../outside')), /escaped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('staging cleanup refuses junctions without deleting their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qro-staging-link-'));
  try {
    await mkdir(join(root, 'preserved'));
    await writeFile(join(root, 'preserved/keep.txt'), 'keep');
    await symlink(join(root, 'preserved'), join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resetGeneratedDirectory(root, join(root, 'dist/package-input')), /links/);
    assert.equal(await readFile(join(root, 'preserved/keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
