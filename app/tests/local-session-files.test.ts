import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../src/main/fsx';
import { FakeLocalFileIO, GuardedLocalFileIO, RESIDUAL_RACE_WINDOW } from '../src/main/local-session-files';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const CANARY = 'CANARY-OUTSIDE-ROOT';

function fixture(t: test.TestContext) {
  const base = mkdtempSync(path.join(tmpdir(), 'qro-local-files-'));
  t.after(() => removeTreeSync(base));
  const root = path.join(base, 'session-root');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'outputs'), { recursive: true });
  mkdirSync(path.join(root, 'data'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, 'data', 'input.csv'), 'a,b\n1,2\n');
  writeFileSync(path.join(root, 'outputs', 'result.json'), '{"ok":true}');
  writeFileSync(path.join(outside, 'canary.txt'), CANARY);
  const io = new GuardedLocalFileIO();
  return { base, root, outside, io };
}

test('a control read returns exactly the bytes on disk, hashed from the same handle', t => {
  const { root, io } = fixture(t);
  const file = io.read(root, 'data/input.csv', 1024);
  assert.equal(file.byteLength, Buffer.byteLength('a,b\n1,2\n'));
  assert.equal(file.sha256, sha('a,b\n1,2\n'));
  assert.equal(file.resolvedRelativePath, 'data/input.csv');
  assert.equal(Buffer.from(file.bytes).toString(), 'a,b\n1,2\n');
});

test('a linked packet root is refused before any read happens', t => {
  const { base, root, outside, io } = fixture(t);
  const linked = path.join(base, 'linked-root');
  symlinkSync(root, linked, 'junction');
  assert.throws(() => io.inspectRoot(linked), /link/);
  assert.throws(() => io.read(linked, 'data/input.csv', 1024));
  assert.throws(() => io.inspectRoot(path.join(outside, 'canary.txt')), /directory/);
  assert.throws(() => io.inspectRoot(path.join(base, 'missing')), /present/);
  assert.equal(io.inspectRoot(root), realpathSync(root));
});

test('a junctioned intermediate directory can never smuggle outside bytes', t => {
  const { root, outside, io } = fixture(t);
  removeTreeSync(path.join(root, 'outputs'));
  symlinkSync(outside, path.join(root, 'outputs'), 'junction');
  assert.throws(() => io.read(root, 'outputs/canary.txt', 1024), /link|reparse/);
});

test('a linked file is refused — the canary is never returned', t => {
  const { root, outside, io } = fixture(t);
  const link = path.join(root, 'linked.txt');
  try {
    symlinkSync(path.join(outside, 'canary.txt'), link, 'file');
  } catch (error) {
    // File symlinks need privilege this machine does not grant; the junction cases cover the
    // same lstat check. Record honestly that this platform could not express the fixture.
    assert.equal((error as NodeJS.ErrnoException).code, 'EPERM');
    t.skip('file symlinks are not creatable without privilege on this machine');
    return;
  }
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.throws(() => io.read(root, 'linked.txt', 1024), /link|reparse/);
});

test('a swap between calls is caught: every read re-walks the path', t => {
  const { root, outside, io } = fixture(t);
  const first = io.read(root, 'data/input.csv', 1024);
  assert.equal(first.sha256, sha('a,b\n1,2\n'));
  removeTreeSync(path.join(root, 'data'));
  symlinkSync(outside, path.join(root, 'data'), 'junction');
  assert.throws(() => io.read(root, 'data/canary.txt', 1024), /link|reparse/);
});

test('a file larger than the declared limit is refused before any bytes are allocated', t => {
  const { root, io } = fixture(t);
  writeFileSync(path.join(root, 'outputs', 'big.bin'), Buffer.alloc(4096, 7));
  assert.throws(() => io.read(root, 'outputs/big.bin', 1024), /4096 bytes|limit/);
});

test('a directory named as a file is refused at the open handle', t => {
  const { root, io } = fixture(t);
  assert.throws(() => io.read(root, 'data', 1024), /not a regular file|EISDIR|illegal operation/i);
});

test('case aliases resolve inside the root or not at all — never outside', t => {
  const { root, io } = fixture(t);
  // A case variant of a real in-root file resolves to that same in-root file on this filesystem.
  const file = io.read(root, 'DATA/INPUT.CSV', 1024);
  assert.equal(Buffer.from(file.bytes).toString(), 'a,b\n1,2\n');
  assert.notEqual(Buffer.from(file.bytes).toString(), CANARY);
});

test('mixed separators resolve inside the root; absolute, device and ADS forms are refused', t => {
  const { root, outside, io } = fixture(t);
  assert.equal(io.read(root, 'data\\input.csv', 1024).sha256, sha('a,b\n1,2\n'));
  assert.equal(io.read(root, 'data/input.csv', 1024).sha256, sha('a,b\n1,2\n'));
  for (const hostile of [
    '..', '../outside/canary.txt', 'data/../outside/canary.txt', 'data/../../etc/passwd',
    path.join(outside, 'canary.txt'), 'C:/outside/canary.txt', 'C:canary.txt',
    '\\\\?\\C:\\outside\\canary.txt', '\\\\.\\C:\\outside\\canary.txt',
    'NUL', 'con.txt', 'com1', 'lpt9.dat',
    'input.csv:canary', 'outputs:canary.txt',
    'data/input.csv ', 'data /input.csv', 'trailing.',
    '', '/data/input.csv', '\\\\server\\share\\canary.txt',
  ]) {
    assert.throws(() => io.read(root, hostile, 1024), Error, `${JSON.stringify(hostile)} must be refused`);
  }
});

test('writeNew refuses to overwrite anything that exists and creates otherwise', t => {
  const { root, outside, io } = fixture(t);
  io.writeNew(root, 'outputs/fresh.json', new TextEncoder().encode('{"a":1}'));
  assert.equal(readFileSync(path.join(root, 'outputs', 'fresh.json'), 'utf8'), '{"a":1}');
  assert.throws(() => io.writeNew(root, 'outputs/fresh.json', new Uint8Array([1, 2])), /exist|EEXIST/i);
  assert.throws(() => io.writeNew(root, 'outputs/result.json', new Uint8Array([1])), /exist|EEXIST/i);
  const linked = path.join(root, 'victim');
  symlinkSync(path.join(outside, 'canary.txt'), linked, 'junction');
  assert.throws(() => io.writeNew(root, 'victim', new Uint8Array([1])), /link|exist/i);
  assert.equal(readFileSync(path.join(outside, 'canary.txt'), 'utf8'), CANARY, 'the outside file is untouched');
  assert.throws(() => io.writeNew(root, 'missing-dir/fresh.json', new Uint8Array([1])), /present|ENOENT/);
});

test('the module states the residual race window honestly', () => {
  assert.match(RESIDUAL_RACE_WINDOW, /walk-to-open/);
  assert.match(RESIDUAL_RACE_WINDOW, /no fd-realpath\/openat equivalent/);
  assert.doesNotMatch(RESIDUAL_RACE_WINDOW, /race-proof|atomic path/i);
});

test('FakeLocalFileIO honors the same contract and records every call', () => {
  const io = new FakeLocalFileIO();
  io.writeNew('root', 'a/b.txt', new TextEncoder().encode('payload'));
  const file = io.read('root', 'a/b.txt', 1024);
  assert.equal(Buffer.from(file.bytes).toString(), 'payload');
  assert.equal(file.sha256, sha('payload'));
  assert.equal(file.byteLength, 7);
  assert.equal(file.resolvedRelativePath, 'a/b.txt');
  assert.throws(() => io.writeNew('root', 'a/b.txt', new Uint8Array([0])), /never replaces|exists/);
  assert.throws(() => io.read('root', 'missing.txt', 1024), /not present/);
  assert.throws(() => io.read('root', 'a/b.txt', 3), /limit/);
  assert.deepEqual(io.calls.map(c => c.method), ['writeNew', 'read', 'writeNew', 'read', 'read']);
});
