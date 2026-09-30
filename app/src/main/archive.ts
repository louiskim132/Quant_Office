import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInflateRaw, crc32 } from 'node:zlib';
import { AsyncZipDeflate, Zip } from 'fflate';
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

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const DATA_DESCRIPTOR = 0x08074b50;
const END_OF_CENTRAL = 0x06054b50;
/** Compressed bytes fed to the inflater per step; bounds what one step can expand to (deflate is at most 1032:1). */
const INFLATE_STEP = 64 * 1024;
const ZIP32 = 2 ** 32;

interface LocalRecord {
  name: string;
  offset: number;
  crc: number;
  compressed: number;
  size: number;
}

/** Exact positional read; a short read means the archive ends early. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) throw new Error('unexpected end of archive');
    done += bytesRead;
  }
  return buffer;
}

/**
 * Extracts a ZIP entry by entry, enforcing the limits as it goes rather than after expansion, and
 * hashing what it writes. Returns what was actually written, not what the archive claimed.
 *
 * The archives are written with data descriptors, so a local header does not say how long its entry
 * is. An entry ends where its deflate stream ends — the inflater reports how many bytes it consumed —
 * never at a ZIP signature found by searching, which incompressible data can contain by chance
 * (roadmap C12, N3b). The descriptor's CRC and sizes and the central directory are then checked
 * against what was read. fflate writes no ZIP64 records, so sizes and offsets are compared modulo
 * 2^32; the lengths themselves always come from the deflate streams.
 */
export async function extractStreamedArchive(
  source: string,
  directory: string,
  limits: ArchiveLimits = LARGE_ARCHIVE,
): Promise<ExtractResult> {
  await mkdir(directory, { recursive: true });
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const records: LocalRecord[] = [];
  let totalBytes = 0;
  const handle = await open(source, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    let position = 0;
    for (;;) {
      const signature = (await readAt(handle, position, 4)).readUInt32LE(0);
      if (signature === CENTRAL_HEADER || signature === END_OF_CENTRAL) break;
      if (signature !== LOCAL_HEADER) throw new Error('invalid zip data');
      const header = await readAt(handle, position, 30);
      const flags = header.readUInt16LE(6),
        method = header.readUInt16LE(8),
        nameLength = header.readUInt16LE(26),
        extraLength = header.readUInt16LE(28);
      if (flags & 1) throw new Error('Encrypted archive entries are not supported.');
      const name = (await readAt(handle, position + 30, nameLength)).toString(flags & 0x800 ? 'utf8' : 'latin1');
      assertPath(name, seen, limits);
      const dataStart = position + 30 + nameLength + extraLength;
      const target = path.join(directory, name);
      await mkdir(path.dirname(target), { recursive: true });
      const output = createWriteStream(target);
      const closed = new Promise<void>((resolve, reject) => {
        output.once('close', resolve);
        output.once('error', reject);
      });
      const hash = createHash('sha256');
      let size = 0;
      let crc = 0;
      let failure: Error | null = null;
      let drained: Promise<void> | null = null;
      const accept = (chunk: Buffer) => {
        if (failure) return;
        size += chunk.length;
        totalBytes += chunk.length;
        if (size > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
          failure = new Error('The archive expands beyond the supported size.');
          return;
        }
        hash.update(chunk);
        crc = crc32(chunk, crc);
        if (!output.write(chunk))
          drained ??= once(output, 'drain').then(() => {
            drained = null;
          });
      };
      let consumed = 0;
      try {
        if (method === 8) {
          const inflater = createInflateRaw();
          const ended = new Promise<void>((resolve, reject) => {
            inflater.once('end', resolve);
            inflater.once('error', reject);
          });
          ended.catch(() => {});
          inflater.on('data', accept);
          inflater.on('error', error => {
            failure ??= error;
          });
          let fed = 0;
          try {
            // Feed until the inflater stops consuming: that is where this entry's deflate stream ends.
            while (!failure) {
              const length = Math.min(INFLATE_STEP, fileSize - dataStart - fed);
              if (length <= 0) throw new Error('unexpected end of archive');
              const chunk = await readAt(handle, dataStart + fed, length);
              fed += length;
              await new Promise<void>(resolve => inflater.write(chunk, () => resolve()));
              if (drained) await drained;
              if (inflater.bytesWritten < fed) break;
            }
            if (!failure) await ended;
            if (failure) throw failure;
            consumed = inflater.bytesWritten;
          } finally {
            inflater.destroy();
          }
        } else if (method === 0 && !(flags & 8)) {
          consumed = header.readUInt32LE(18);
          for (let at = 0; at < consumed && !failure; at += INFLATE_STEP) {
            accept(await readAt(handle, dataStart + at, Math.min(INFLATE_STEP, consumed - at)));
            if (drained) await drained;
          }
          if (failure) throw failure;
        } else {
          throw new Error(`Unsupported archive entry format: ${name}`);
        }
        output.end();
        await closed;
      } catch (error) {
        output.destroy();
        await closed.catch(() => {});
        throw error;
      }
      let end = dataStart + consumed;
      let recorded = {
        crc: header.readUInt32LE(14),
        compressed: header.readUInt32LE(18),
        size: header.readUInt32LE(22),
      };
      if (flags & 8) {
        const descriptor = await readAt(handle, end, 16);
        const skip = descriptor.readUInt32LE(0) === DATA_DESCRIPTOR ? 4 : 0;
        recorded = {
          crc: descriptor.readUInt32LE(skip),
          compressed: descriptor.readUInt32LE(skip + 4),
          size: descriptor.readUInt32LE(skip + 8),
        };
        end += skip + 12;
      }
      if (recorded.crc !== crc >>> 0 || recorded.compressed !== consumed % ZIP32 || recorded.size !== size % ZIP32)
        throw new Error(`The archive entry ${name} does not match its recorded checksum or sizes`);
      records.push({ name, offset: position, crc: recorded.crc, compressed: consumed, size });
      entries.push({ path: name, size, sha256: hash.digest('hex') });
      position = end;
    }
    // The central directory must list exactly the entries read, in order, at the offsets they were found.
    const central = await readAt(handle, position, fileSize - position);
    let at = 0;
    for (const record of records) {
      if (central.length < at + 46 || central.readUInt32LE(at) !== CENTRAL_HEADER)
        throw new Error('The archive directory does not list every entry');
      const flags = central.readUInt16LE(at + 8),
        nameLength = central.readUInt16LE(at + 28),
        extraLength = central.readUInt16LE(at + 30),
        commentLength = central.readUInt16LE(at + 32);
      const name = central.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
      if (
        name !== record.name ||
        central.readUInt32LE(at + 16) !== record.crc ||
        central.readUInt32LE(at + 20) !== record.compressed % ZIP32 ||
        central.readUInt32LE(at + 24) !== record.size % ZIP32 ||
        central.readUInt32LE(at + 42) !== record.offset % ZIP32
      )
        throw new Error(`The archive directory does not match the entry ${record.name}`);
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (central.length < at + 22 || central.readUInt32LE(at) !== END_OF_CENTRAL)
      throw new Error('The archive directory lists entries that were not found');
  } catch (error) {
    await handle.close().catch(() => {});
    await removeTree(directory);
    throw error;
  }
  await handle.close();
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
