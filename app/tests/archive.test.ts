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

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x07, 0x08], // data descriptor
  [0x50, 0x4b, 0x01, 0x02], // central directory
  [0x50, 0x4b, 0x03, 0x04], // local file header
].map(bytes => Buffer.from(bytes));

/**
 * Random bytes that contain no ZIP record signature. Random data is incompressible, so it reaches the
 * archive verbatim and holds a signature by chance about 0.07% of the time per MiB. fflate's streaming
 * unzip ended a data-descriptor entry at the first one ("unexpected EOF", the flake in the main run for
 * PR #41); the extractor no longer searches for signatures (N3b), and the test below plants them on
 * purpose. The other fixtures stay signature-free so each test exercises one thing.
 */
function randomBytesWithoutZipSignatures(size: number): Buffer {
  const bytes = randomBytes(size);
  // Flipping the first byte of a match cannot create another one, so each pass removes an occurrence.
  for (const signature of ZIP_SIGNATURES)
    for (let at = bytes.indexOf(signature); at >= 0; at = bytes.indexOf(signature)) bytes[at] ^= 0xff;
  return bytes;
}

test('a streamed archive round-trips exactly, with hashes taken from the bytes written', async t => {
  const root = workspace(t);
  const source = path.join(root, 'source');
  mkdirSync(source);
  const small = path.join(source, 'small.txt');
  writeFileSync(small, 'hello archive');
  const nested = path.join(source, 'objects');
  mkdirSync(nested);
  const binary = randomBytesWithoutZipSignatures(3 * 1024 * 1024);
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
  const chunk = randomBytesWithoutZipSignatures(4 * 1024 * 1024);
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

test('entries whose compressed bytes contain ZIP signatures extract exactly (N3b)', { timeout: 60_000 }, async t => {
  const root = workspace(t);
  const sources = ZIP_SIGNATURES.map((signature, index) => {
    const data = randomBytesWithoutZipSignatures(1024 * 1024);
    signature.copy(data, 400_000);
    signature.copy(data, 900_000);
    const file = path.join(root, `payload-${index}.bin`);
    writeFileSync(file, data);
    return { path: `objects/payload-${index}.bin`, file };
  });
  const zeros = path.join(root, 'zeros.bin');
  writeFileSync(zeros, Buffer.alloc(8 * 1024 * 1024));
  const destination = path.join(root, 'payload.zip');
  const written = await writeStreamedArchive(destination, [
    ...sources,
    { path: 'objects/zeros.bin', file: zeros },
    { path: 'empty.txt', bytes: new Uint8Array(0) },
  ]);
  const archive = readFileSync(destination);
  for (const signature of ZIP_SIGNATURES) {
    let found = 0;
    for (let at = archive.indexOf(signature); at >= 0; at = archive.indexOf(signature, at + 1)) found++;
    assert.ok(found >= 3, 'the embedded signatures reach the archive next to the real records');
  }
  const out = path.join(root, 'extracted');
  const extracted = await extractStreamedArchive(destination, out);
  assert.deepEqual(
    extracted.entries,
    [...written.entries].sort((a, b) => a.path.localeCompare(b.path)),
  );
  await verifyExtracted(out, written.entries);
});

test('a truncated or corrupted archive is refused and leaves nothing extracted', async t => {
  const root = workspace(t);
  const file = path.join(root, 'a.bin');
  writeFileSync(file, randomBytesWithoutZipSignatures(256 * 1024));
  const destination = path.join(root, 'a.zip');
  await writeStreamedArchive(destination, [
    { path: 'a.bin', file },
    { path: 'b.txt', bytes: new TextEncoder().encode('second entry') },
  ]);
  const archive = readFileSync(destination);
  const truncated = path.join(root, 'truncated.zip');
  writeFileSync(truncated, archive.subarray(0, archive.length - 30));
  const out = path.join(root, 'extracted');
  await assert.rejects(extractStreamedArchive(truncated, out), /archive/);
  assert.equal(existsSync(out), false);
  const cut = path.join(root, 'cut.zip');
  writeFileSync(cut, archive.subarray(0, 100_000));
  await assert.rejects(extractStreamedArchive(cut, out), /unexpected end of archive/);
  assert.equal(existsSync(out), false);
  // A changed byte inside a stored (incompressible) block leaves the deflate stream valid, so the CRC catches it.
  const corrupted = Buffer.from(archive);
  corrupted[120_000] ^= 0x01;
  const bad = path.join(root, 'bad.zip');
  writeFileSync(bad, corrupted);
  await assert.rejects(extractStreamedArchive(bad, out), /does not match its recorded checksum or sizes/);
  assert.equal(existsSync(out), false);
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
