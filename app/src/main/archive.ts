import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { AsyncZipDeflate, AsyncUnzipInflate, Unzip, Zip } from 'fflate';
import { safeEntry } from './artifacts.js';
import { removeTree } from './fsx.js';

/**
 * Limits for the streamed workspace format.
 *
 * The in-memory format stays exactly as it was for small workspaces. This one exists so a workspace
 * that outgrows it still has a supported archive, instead of silently failing to back up.
 */
export interface ArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}
export const LARGE_ARCHIVE: ArchiveLimits = {
  maxEntries: 100_000,
  maxEntryBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024 * 1024,
};

export interface ArchiveSource {
  path: string;
  file?: string;
  bytes?: Uint8Array;
}
export interface ArchiveEntry {
  path: string;
  size: number;
  sha256: string;
}

function assertPath(name: string, seen: Set<string>, limits: ArchiveLimits): void {
  if (!safeEntry(name)) throw new Error(`Unsafe archive entry: ${name}`);
  const key = name.toLowerCase();
  if (seen.has(key)) throw new Error(`Duplicate archive entry: ${name}`);
  if (seen.size >= limits.maxEntries)
    throw new Error(`This workspace has more than ${limits.maxEntries} archive entries.`);
  seen.add(key);
}

/**
 * Writes a ZIP by streaming each file through the compressor, hashing the bytes on the way past.
 * Nothing is held whole in memory, so the size of the workspace is bounded by disk, not by RAM.
 */
export async function writeStreamedArchive(
  destination: string,
  sources: ArchiveSource[],
  limits: ArchiveLimits = LARGE_ARCHIVE,
): Promise<{ entries: ArchiveEntry[]; totalBytes: number }> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  const output = createWriteStream(temporary, { flags: 'wx' });
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  // Async compressors run on worker threads; a refused archive must terminate them, not leave them running.
  const running: AsyncZipDeflate[] = [];
  let totalBytes = 0;
  try {
    const finished = new Promise<void>((resolve, reject) => {
      output.once('error', reject);
      output.once('close', resolve);
    });
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        output.destroy(error);
        return;
      }
      if (chunk.length) output.write(Buffer.from(chunk));
      if (final) output.end();
    });
    for (const source of sources) {
      assertPath(source.path, seen, limits);
      const file = new AsyncZipDeflate(source.path, { level: 6 });
      running.push(file);
      zip.add(file);
      const hash = createHash('sha256');
      let size = 0;
      const push = (chunk: Uint8Array, last: boolean) => {
        size += chunk.length;
        totalBytes += chunk.length;
        if (size > limits.maxEntryBytes) throw new Error(`${source.path} is larger than the supported entry size.`);
        if (totalBytes > limits.maxTotalBytes)
          throw new Error('The workspace is larger than the supported archive size.');
        hash.update(chunk);
        file.push(chunk, last);
        // Keep the write stream from growing without bound while the compressor runs ahead.
        return output.writableLength < 16 * 1024 * 1024
          ? Promise.resolve()
          : new Promise<void>(resolve => output.once('drain', resolve));
      };
      if (source.bytes) await push(source.bytes, true);
      else if (source.file) {
        let wrote = false;
        for await (const chunk of createReadStream(source.file, { highWaterMark: 1024 * 1024 })) {
          await push(chunk as Uint8Array, false);
          wrote = true;
        }
        await push(new Uint8Array(0), true);
        if (!wrote && size !== 0) throw new Error(`Could not read ${source.path}`);
      } else throw new Error(`Archive entry ${source.path} has no content`);
      entries.push({ path: source.path, size, sha256: hash.digest('hex') });
    }
    zip.end();
    await finished;
    await rename(temporary, destination);
    return { entries, totalBytes };
  } catch (error) {
    for (const file of running) {
      try {
        file.terminate?.();
      } catch {
        /* already finished */
      }
    }
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface ExtractResult {
  entries: ArchiveEntry[];
  totalBytes: number;
}

/**
 * Extracts a ZIP entry by entry, enforcing the limits as it goes rather than after expansion, and
 * hashing what it writes. Returns what was actually written, not what the archive claimed.
 */
export async function extractStreamedArchive(
  source: string,
  directory: string,
  limits: ArchiveLimits = LARGE_ARCHIVE,
): Promise<ExtractResult> {
  await mkdir(directory, { recursive: true });
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const writes: Promise<void>[] = [];
  const inflating: { terminate?: () => void }[] = [];
  let failure: Error | null = null;
  const unzip = new Unzip();
  unzip.register(AsyncUnzipInflate);
  unzip.onfile = file => {
    let settle: () => void = () => {};
    writes.push(
      new Promise<void>(resolve => {
        settle = resolve;
      }),
    );
    try {
      assertPath(file.name, seen, limits);
    } catch (error) {
      failure ??= error as Error;
      settle();
      return;
    }
    const target = path.join(directory, file.name);
    const hash = createHash('sha256');
    let size = 0;
    let stream: ReturnType<typeof createWriteStream> | null = null;
    const ready = mkdir(path.dirname(target), { recursive: true }).then(() => {
      stream = createWriteStream(target);
    });
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure ??= error as unknown as Error;
        settle();
        return;
      }
      size += chunk.length;
      totalBytes += chunk.length;
      if (size > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
        failure ??= new Error('The archive expands beyond the supported size.');
        settle();
        return;
      }
      hash.update(chunk);
      void ready.then(() => {
        stream!.write(Buffer.from(chunk));
        if (final)
          stream!.end(() => {
            entries.push({ path: file.name, size, sha256: hash.digest('hex') });
            settle();
          });
      });
    };
    inflating.push(file as unknown as { terminate?: () => void });
    void ready.then(() => file.start());
  };
  await pipeline(
    createReadStream(source, { highWaterMark: 1024 * 1024 }),
    async function* (chunks) {
      for await (const chunk of chunks) {
        unzip.push(chunk as Uint8Array, false);
        yield chunk;
      }
      unzip.push(new Uint8Array(0), true);
    },
    async function* (chunks) {
      for await (const _ of chunks) {
        /* the archive is consumed by the unzipper */
      }
    },
  );
  await Promise.all(writes);
  for (const file of inflating) {
    try {
      file.terminate?.();
    } catch {
      /* already finished */
    }
  }
  if (failure) {
    await removeTree(directory);
    throw failure;
  }
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), totalBytes };
}

/** Confirms an extracted directory matches the identities the manifest recorded. */
export async function verifyExtracted(directory: string, expected: ArchiveEntry[]): Promise<void> {
  for (const entry of expected) {
    const target = path.join(directory, entry.path);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new Error(`The archive is missing ${entry.path}`);
    if (info.size !== entry.size) throw new Error(`${entry.path} does not match its recorded size`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk as Uint8Array);
    if (hash.digest('hex') !== entry.sha256) throw new Error(`${entry.path} does not match its recorded bytes`);
  }
}
