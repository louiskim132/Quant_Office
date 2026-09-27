import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { removeTree } from './fsx.js';
import { z } from 'zod';
import { OfficeStore } from '../core/store.js';
import { parseStrictJson } from '../core/strict-json.js';
import { MAX_TOTAL, validateZipHeaders, safeEntry, atomicWrite } from './artifacts.js';
import { extractStreamedArchive } from './archive.js';
import { objectInventory } from '../core/object-inventory.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const streamedSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('WORKSPACE_BACKUP'),
    format: z.literal('STREAMED'),
    createdAt: z.string().datetime(),
    lastEvent: hash.nullable(),
    files: z
      .array(z.object({ path: z.string().min(1).max(240), size: z.number().int().min(0), sha256: hash }).strict())
      .max(100000),
  })
  .strict();
const backupSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('WORKSPACE_BACKUP'),
    createdAt: z.string().datetime(),
    lastEvent: hash.nullable(),
    files: z
      .array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: hash }).strict())
      .max(511),
  })
  .strict();
const journalSchema = z.object({ schemaVersion: z.literal(1), transactionId: z.string().uuid() }).strict();
async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export function workspaceDirectory(root: string): string {
  return path.join(root, 'workspace');
}
export async function recoverInterruptedRestore(root: string): Promise<void> {
  const file = path.join(root, 'restore-journal.json');
  if (!(await exists(file))) return;
  const journal = journalSchema.parse(parseStrictJson(await readFile(file, 'utf8')));
  const live = workspaceDirectory(root),
    previous = path.join(root, 'recovery', 'workspace-' + journal.transactionId);
  if (!(await exists(live))) {
    if (!(await exists(previous)))
      throw new Error('Interrupted restore has no recoverable workspace. Preserve the data folder.');
    await rename(previous, live);
  }
  // A whole workspace directory is either old or new; neither is an incomplete per-file replacement.
  await rm(file);
}
/**
 * Restores a streamed archive: extract entry by entry, verify every byte against the manifest, then
 * open the candidate and compare its lineage tip. Nothing replaces the live workspace here.
 */
async function prepareStreamedRestore(
  file: string,
  root: string,
  transactionId: string,
  candidate: string,
): Promise<{ transactionId: string; candidate: string; summary: string }> {
  const extracted = await extractStreamedArchive(file, candidate);
  const manifestPath = path.join(candidate, 'backup.json');
  const manifestBytes = await readFile(manifestPath).catch(() => null);
  if (!manifestBytes || manifestBytes.length > 1024 * 1024)
    throw new Error('This is not a Quant Research Office workspace backup.');
  const parsed = streamedSchema.parse(parseStrictJson(manifestBytes.toString('utf8')));
  const declared = new Map(parsed.files.map(item => [item.path, item]));
  for (const item of parsed.files)
    if (!safeEntry(item.path) || !(item.path === 'workspace.sqlite' || /^objects\/[a-f0-9]{64}$/.test(item.path)))
      throw new Error('Unexpected backup entry.');
  for (const entry of extracted.entries) {
    if (entry.path === 'backup.json') continue;
    const expected = declared.get(entry.path);
    if (!expected) throw new Error('Backup includes undeclared files.');
    if (expected.size !== entry.size || expected.sha256 !== entry.sha256)
      throw new Error(`${entry.path} does not match the backup manifest.`);
  }
  if (!extracted.entries.some(entry => entry.path === 'workspace.sqlite'))
    throw new Error('Backup inventory is incomplete or includes undeclared files.');
  const candidateStore = new OfficeStore(path.join(candidate, 'workspace.sqlite'), { repairLegacy: false });
  try {
    const state = candidateStore.snapshot({ history: false });
    if (candidateStore.lineageTip().hash !== parsed.lastEvent)
      throw new Error('Backup lineage tip does not match its manifest.');
    const inventory = objectInventory(state);
    if (declared.size !== parsed.files.length) throw new Error('Duplicate backup inventory entries.');
    for (const item of parsed.files)
      if (!extracted.entries.some(entry => entry.path === item.path))
        throw new Error('Backup inventory is incomplete.');
    for (const [hash, item] of inventory) {
      const entry = extracted.entries.find(entry => entry.path === 'objects/' + hash);
      if (!entry) {
        if (item.required) throw new Error('Backup is missing a required stored object.');
        continue;
      }
      if (entry.size !== item.bytes || entry.sha256 !== hash) throw new Error('Backup corrupts a stored object.');
      const folder = path.join(candidate, 'objects', hash.slice(0, 2));
      await mkdir(folder, { recursive: true });
      await rename(path.join(candidate, 'objects', hash), path.join(folder, hash));
    }
    if (extracted.entries.some(entry => entry.path.startsWith('objects/') && !inventory.has(entry.path.slice(8))))
      throw new Error('Backup has unregistered objects.');
    await rm(manifestPath, { force: true });
    return {
      transactionId,
      candidate,
      summary: `${state.projects.length} projects, ${state.experiments.length} experiments, ${state.artifacts.length} artifacts and ${candidateStore.lineageTip().count} lineage events, restored from a streamed archive.`,
    };
  } finally {
    candidateStore.close();
  }
}
export async function prepareRestore(
  file: string,
  root: string,
): Promise<{ transactionId: string; candidate: string; summary: string }> {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error('Select a workspace backup file.');
  if (metadata.size > MAX_TOTAL) {
    // Too large for the in-memory reader: the streamed format is the supported path for big workspaces.
    const transactionId = randomUUID(),
      candidate = path.join(root, 'restore-candidates', transactionId);
    await mkdir(candidate, { recursive: true });
    try {
      return await prepareStreamedRestore(file, root, transactionId, candidate);
    } catch (error) {
      await discardCandidate(candidate, root);
      throw error;
    }
  }
  const bytes = await readFile(file);
  if (bytes.length > MAX_TOTAL) throw new Error('Backup exceeds the import limit.');
  validateZipHeaders(bytes);
  let total = 0;
  const unpacked = unzipSync(bytes, {
    filter: entry => {
      total += entry.originalSize;
      if (total > MAX_TOTAL) throw new Error('Backup expansion limit exceeded.');
      return true;
    },
  });
  const manifest = unpacked['backup.json'];
  if (!manifest || manifest.length > 1024 * 1024)
    throw new Error('This is not a Quant Research Office workspace backup.');
  const manifestText = strFromU8(manifest);
  if ((parseStrictJson(manifestText) as { schemaVersion?: number }).schemaVersion === 2) {
    const transactionId = randomUUID(),
      candidate = path.join(root, 'restore-candidates', transactionId);
    await mkdir(candidate, { recursive: true });
    try {
      return await prepareStreamedRestore(file, root, transactionId, candidate);
    } catch (error) {
      await discardCandidate(candidate, root);
      throw error;
    }
  }
  const parsed = backupSchema.parse(parseStrictJson(manifestText));
  const expected = new Set(['backup.json']);
  for (const item of parsed.files) {
    if (
      !safeEntry(item.path) ||
      expected.has(item.path) ||
      !(item.path === 'workspace.sqlite' || /^objects\/[a-f0-9]{64}$/.test(item.path))
    )
      throw new Error('Unexpected backup entry.');
    expected.add(item.path);
    const b = unpacked[item.path];
    if (!b || b.length !== item.size || createHash('sha256').update(b).digest('hex') !== item.sha256)
      throw new Error('Backup byte identity mismatch.');
  }
  if (!unpacked['workspace.sqlite'] || Object.keys(unpacked).some(p => !expected.has(p)))
    throw new Error('Backup inventory is incomplete or includes undeclared files.');
  const transactionId = randomUUID(),
    candidate = path.join(root, 'restore-candidates', transactionId);
  await mkdir(candidate, { recursive: true });
  try {
    await writeFile(path.join(candidate, 'workspace.sqlite'), unpacked['workspace.sqlite'], { flag: 'wx' });
    const candidateStore = new OfficeStore(path.join(candidate, 'workspace.sqlite'), { repairLegacy: false });
    try {
      const state = candidateStore.snapshot({ history: false });
      if (candidateStore.lineageTip().hash !== parsed.lastEvent)
        throw new Error('Backup lineage tip does not match its manifest.');
      const inventory = objectInventory(state);
      for (const [hash, item] of inventory) {
        const data = unpacked['objects/' + hash];
        if (!data) {
          if (item.required) throw new Error('Backup is missing a required stored object.');
          continue;
        }
        if (data.length !== item.bytes || createHash('sha256').update(data).digest('hex') !== hash)
          throw new Error('Backup corrupts a stored object.');
        const folder = path.join(candidate, 'objects', hash.slice(0, 2));
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, hash), data, { flag: 'wx' });
      }
      if (Object.keys(unpacked).some(p => p.startsWith('objects/') && !inventory.has(p.slice(8))))
        throw new Error('Backup has unregistered objects.');
      return {
        transactionId,
        candidate,
        summary: `${state.projects.length} projects, ${state.experiments.length} experiments, ${state.artifacts.length} artifacts and ${candidateStore.lineageTip().count} lineage events.`,
      };
    } finally {
      candidateStore.close();
    }
  } catch (error) {
    await discardCandidate(candidate, root);
    throw error;
  }
}
export async function discardCandidate(candidate: string, root: string): Promise<void> {
  const rel = path.relative(path.join(root, 'restore-candidates'), candidate);
  if (path.isAbsolute(rel) || rel.includes(path.sep) || !z.string().uuid().safeParse(rel).success)
    throw new Error('Invalid restore candidate path.');
  await removeTree(candidate);
}
/** Caller closes the live store first. Previous workspace is retained as a reversible recovery copy. */
export async function commitRestore(root: string, transactionId: string): Promise<void> {
  z.string().uuid().parse(transactionId);
  const candidate = path.join(root, 'restore-candidates', transactionId),
    live = workspaceDirectory(root),
    previous = path.join(root, 'recovery', 'workspace-' + transactionId);
  if (!(await exists(candidate)) || (await exists(previous))) throw new Error('Restore transaction is not ready.');
  await mkdir(path.dirname(previous), { recursive: true });
  const staged = new OfficeStore(path.join(candidate, 'workspace.sqlite'));
  try {
    staged.recordTransfer(
      'WORKSPACE_RESTORED',
      null,
      'Restored a user-selected, hash-verified workspace backup; previous workspace retained.',
    );
  } finally {
    staged.close();
  }
  const journal = path.join(root, 'restore-journal.json');
  await atomicWrite(journal, Buffer.from(JSON.stringify({ schemaVersion: 1, transactionId })));
  try {
    await rename(live, previous);
    await rename(candidate, live);
    await rm(journal);
  } catch (error) {
    if (!(await exists(live)) && (await exists(previous))) await rename(previous, live);
    throw error;
  }
}
