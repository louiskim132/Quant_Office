import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
  mkdirSync,
} from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStreamedArchive, extractStreamedArchive, verifyExtracted, LARGE_ARCHIVE } from '../src/main/archive';

function workspace(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-archive-'));
  t.after(() => removeTreeSync(root));
  return root;
}

test('a streamed archive round-trips exactly, with hashes taken from the bytes written', async t => {
  const root = workspace(t);
  const source = path.join(root, 'source');
  mkdirSync(source);
  const small = path.join(source, 'small.txt');
  writeFileSync(small, 'hello archive');
  const nested = path.join(source, 'objects');
  mkdirSync(nested);
  const binary = randomBytes(3 * 1024 * 1024);
  const object = path.join(nested, 'blob.bin');
  writeFileSync(object, binary);
  const destination = path.join(root, 'workspace.zip');
  const written = await writeStreamedArchive(destination, [
    { path: 'small.txt', file: small },
    { path: 'objects/blob.bin', file: object },
    { path: 'manifest.json', bytes: new TextEncoder().encode('{"schemaVersion":2}') },
  ]);
  assert.equal(written.entries.length, 3);
  assert.equal(written.entries.find(entry => entry.path === 'objects/blob.bin')!.size, binary.length);
  assert.ok(statSync(destination).size > 0);
  const out = path.join(root, 'extracted');
  const extracted = await extractStreamedArchive(destination, out);
  assert.deepEqual(
    extracted.entries.map(entry => entry.path),
    ['manifest.json', 'objects/blob.bin', 'small.txt'],
  );
  assert.equal(readFileSync(path.join(out, 'small.txt'), 'utf8'), 'hello archive');
  assert.deepEqual(readFileSync(path.join(out, 'objects/blob.bin')), binary);
  await verifyExtracted(out, written.entries);
});

test('a large workspace streams past the in-memory format limits', async t => {
  const root = workspace(t);
  const source = path.join(root, 'big.bin');
  // Larger than the 256 MiB in-memory archive would ever hold comfortably, written in chunks.
  const chunk = randomBytes(4 * 1024 * 1024);
  const handle = openSync(source, 'w');
  for (let index = 0; index < 66; index++) writeSync(handle, chunk);
  closeSync(handle);
  assert.ok(statSync(source).size > 256 * 1024 * 1024, 'the fixture exceeds the in-memory total limit');
  const destination = path.join(root, 'big.zip');
  const written = await writeStreamedArchive(destination, [{ path: 'objects/big.bin', file: source }]);
  assert.equal(written.entries[0].size, statSync(source).size);
  const out = path.join(root, 'extracted');
  const extracted = await extractStreamedArchive(destination, out);
  assert.equal(extracted.entries[0].size, written.entries[0].size);
  assert.equal(extracted.entries[0].sha256, written.entries[0].sha256);
  await verifyExtracted(out, written.entries);
});

test('limits are enforced while extracting, not after expansion', async t => {
  const root = workspace(t);
  const source = path.join(root, 'payload.bin');
  writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 7));
  const destination = path.join(root, 'payload.zip');
  await writeStreamedArchive(destination, [{ path: 'objects/payload.bin', file: source }]);
  const out = path.join(root, 'extracted');
  await assert.rejects(
    extractStreamedArchive(destination, out, { ...LARGE_ARCHIVE, maxTotalBytes: 1024 }),
    /expands beyond the supported size/,
  );
  await assert.rejects(
    extractStreamedArchive(destination, out, { ...LARGE_ARCHIVE, maxEntries: 0 }),
    /more than 0 archive entries/,
  );
});

test('unsafe and duplicate entry names are refused on the way in', async t => {
  const root = workspace(t);
  const file = path.join(root, 'a.txt');
  writeFileSync(file, 'a');
  await assert.rejects(
    writeStreamedArchive(path.join(root, 'bad.zip'), [{ path: '../escape.txt', file }]),
    /Unsafe archive entry/,
  );
  await assert.rejects(
    writeStreamedArchive(path.join(root, 'bad2.zip'), [
      { path: 'a.txt', file },
      { path: 'A.TXT', file },
    ]),
    /Duplicate archive entry/,
  );
  await assert.rejects(
    writeStreamedArchive(path.join(root, 'bad3.zip'), [{ path: 'a.txt', file }], {
      ...LARGE_ARCHIVE,
      maxEntryBytes: 0,
    }),
    /larger than the supported entry size/,
  );
  assert.equal(existsSync(path.join(root, 'bad.zip')), false, 'a refused archive leaves no partial file behind');
});

test('verification fails when extracted bytes do not match the manifest', async t => {
  const root = workspace(t);
  const file = path.join(root, 'a.txt');
  writeFileSync(file, 'original');
  const destination = path.join(root, 'a.zip');
  const written = await writeStreamedArchive(destination, [{ path: 'a.txt', file }]);
  const out = path.join(root, 'extracted');
  await extractStreamedArchive(destination, out);
  writeFileSync(path.join(out, 'a.txt'), 'tampered');
  await assert.rejects(verifyExtracted(out, written.entries), /does not match its recorded (bytes|size)/);
});
