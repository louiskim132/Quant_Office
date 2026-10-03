import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
// @ts-expect-error Release tooling is standalone JavaScript.
import { createPortable, verifyPortable } from '../scripts/portable-release.mjs';

test('portable archive preserves byte inventory and refuses tampering, extras, missing files and overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qro-portable-'));
  try {
    const source = join(root, 'source');
    const extracted = join(root, 'extracted');
    await mkdir(join(source, 'resources'), { recursive: true });
    await writeFile(join(source, 'Quant Research Office.exe'), 'synthetic executable');
    await writeFile(join(source, 'resources/app.asar'), 'synthetic archive');
    const zip = join(root, 'release.zip');
    await createPortable(source, zip, 'a'.repeat(40));
    await assert.rejects(createPortable(source, zip, 'a'.repeat(40)), { code: 'EEXIST' });
    for (const [name, bytes] of Object.entries(unzipSync(await readFile(zip)))) {
      const file = join(extracted, name);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, bytes);
    }
    assert.equal((await verifyPortable(extracted)).signed, false);
    await writeFile(join(extracted, 'obsolete.txt'), 'harmless extra');
    await assert.rejects(verifyPortable(extracted), /inventory mismatch/);
    await rm(join(extracted, 'obsolete.txt'));
    await writeFile(join(extracted, 'resources/app.asar'), 'tampered');
    await assert.rejects(verifyPortable(extracted), /inventory mismatch/);
    await rm(join(extracted, 'resources/app.asar'));
    await assert.rejects(verifyPortable(extracted), /inventory mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
