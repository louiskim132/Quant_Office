import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * What a guarded read returns: the exact bytes that came off the pinned handle, the sha256 of those
 * bytes, their count, and the resolved relative path inside the managed root.
 */
export interface VerifiedLocalFile {
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
  resolvedRelativePath: string;
}

/**
 * File I/O inside a managed local-session root. The contract is verification, not convenience:
 * every call re-proves that the named path is a real, contained, unlinked file before bytes move.
 */
export interface LocalFileIO {
  read(root: string, relativePath: string, maxBytes: number): VerifiedLocalFile;
  /** Refuses to overwrite: an existing path of any kind fails rather than being replaced. */
  writeNew(root: string, relativePath: string, bytes: Uint8Array): void;
  /** Validates root ownership — must exist, be a real directory, and not be a link — and returns its canonical path. */
  inspectRoot(root: string): string;
}

/**
 * Honest capability boundary — not a claim of race-proofing. The per-component lstat walk and the
 * open() are not atomic, and Node on Windows has no fd-realpath/openat equivalent to close that gap:
 * a reparse point swapped in between the last lstat and the open can still redirect the open outside
 * the managed root. What this module does guarantee is that the open handle pins the file object —
 * the fstat size gate and the read act on the opened object itself, so a post-open swap cannot change
 * which bytes are read or hashed — and that no path component was a link at walk time. The residual
 * window is walk→open on the final path, and it is stated, not papered over.
 */
export const RESIDUAL_RACE_WINDOW =
  'walk-to-open: a reparse point swapped between the component lstat walk and open() can still redirect the read; Node on Windows has no fd-realpath/openat equivalent to close it. The open handle pins the file object, so fstat and the read are pinned — but the path resolution is not atomic.';

/** Characters that can never appear in one honest path segment — drive refs, ADS, wildcards, controls. */
const ILLEGAL_SEGMENT = /[<>:"|?*\x00-\x1f]/;
/** Windows reserved device names — still reserved with an extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/** Trailing dot or space is silently stripped by the filesystem, which would alias a different name. */
const TRAILING_ALIAS = /[ .]$/;

const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class GuardedLocalFileIO implements LocalFileIO {
  /**
   * The managed root must be a real directory that is itself not a link. realpathSync gives the
   * canonical casing so containment checks compare like with like.
   */
  inspectRoot(root: string): string {
    let stats;
    try {
      stats = lstatSync(root);
    } catch (error) {
      throw new Error(
        `The managed root is not present: ${gone(error) ? 'nothing exists at that path' : (error as Error).message}`,
      );
    }
    if (stats.isSymbolicLink())
      throw new Error('The managed root is a link — it must be a real directory this office owns.');
    if (!stats.isDirectory()) throw new Error('The managed root is not a directory.');
    const resolved = realpathSync(root);
    const canonical = lstatSync(resolved);
    if (canonical.isSymbolicLink() || !canonical.isDirectory())
      throw new Error('The managed root does not resolve to a real directory.');
    return resolved;
  }

  read(root: string, relativePath: string, maxBytes: number): VerifiedLocalFile {
    const managed = this.inspectRoot(root);
    // Step one — the pre-open walk: every component of the resolved path must exist, must be a real
    // filesystem object, and must not be a link. The walk ends at the target's lstat.
    const { target, resolvedRelativePath } = resolveManaged(managed, relativePath);
    // Step two — the handle-bound read: open once, fstat the OPEN HANDLE, gate on regular-file and
    // size before allocating, then read exactly those bytes off that same handle. The handle pins
    // the file object: a post-open path swap cannot redirect what is read or hashed.
    const handle = openSync(target, 'r');
    try {
      const stats = fstatSync(handle);
      if (!stats.isFile()) throw new Error(`${relativePath} resolves to something that is not a regular file.`);
      if (!Number.isSafeInteger(stats.size) || stats.size < 0)
        throw new Error(`${relativePath} has no trustworthy size.`);
      if (stats.size > maxBytes)
        throw new Error(
          `${relativePath} is ${stats.size} bytes — larger than the ${maxBytes}-byte limit; nothing was allocated or read.`,
        );
      const bytes = Buffer.alloc(stats.size);
      let offset = 0;
      while (offset < stats.size) {
        const read = readSync(handle, bytes, offset, stats.size - offset, offset);
        if (read <= 0)
          throw new Error(`${relativePath} changed while being read — the file is not stable, so nothing is trusted.`);
        offset += read;
      }
      return {
        bytes: new Uint8Array(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
        resolvedRelativePath,
      };
    } finally {
      closeSync(handle);
    }
  }

  writeNew(root: string, relativePath: string, bytes: Uint8Array): void {
    const managed = this.inspectRoot(root);
    const { target } = resolveManaged(managed, relativePath, true);
    // 'wx' is the refusal itself: an existing path of any kind — file, link, directory — fails with
    // EEXIST rather than being replaced or followed.
    const handle = openSync(target, 'wx');
    try {
      let offset = 0;
      while (offset < bytes.byteLength) offset += writeSync(handle, bytes, offset);
    } finally {
      closeSync(handle);
    }
  }
}

/**
 * Walks each component of a caller-supplied relative path under an already-inspected managed root.
 * Every component is lstat'd — a link, junction or reparse point at any level is refused — and the
 * accumulated path is re-checked for containment after every step. When `missingLeafOk` is set the
 * final component may be absent (writeNew's case); every earlier component must still exist.
 */
function resolveManaged(
  managedRoot: string,
  relativePath: string,
  missingLeafOk = false,
): { target: string; resolvedRelativePath: string } {
  if (typeof relativePath !== 'string' || !relativePath.length)
    throw new Error('A managed path must name a file inside the root.');
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath))
    throw new Error(`${relativePath} is not a relative path inside the managed root.`);
  const parts = relativePath.split(/[\\/]+/).filter(part => part.length > 0);
  if (!parts.length) throw new Error('A managed path must name a file inside the root.');
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`${relativePath} contains '${part}' — traversal is refused.`);
    if (ILLEGAL_SEGMENT.test(part))
      throw new Error(`${relativePath} contains a segment with characters a managed path cannot carry.`);
    if (DEVICE_NAME.test(part)) throw new Error(`${relativePath} names a reserved device, not a managed file.`);
    if (TRAILING_ALIAS.test(part))
      throw new Error(
        `${relativePath} ends a segment in a character the filesystem would silently strip — that aliases a different name.`,
      );
  }
  let current = managedRoot;
  const walked: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(current, parts[i]);
    const leaf = i === parts.length - 1;
    let stats;
    try {
      stats = lstatSync(next);
    } catch (error) {
      if (leaf && missingLeafOk && gone(error)) {
        walked.push(parts[i]);
        return { target: next, resolvedRelativePath: walked.join('/') };
      }
      throw new Error(
        `${relativePath} is not present inside the managed root at '${parts.slice(0, i + 1).join('/')}'.`,
      );
    }
    if (stats.isSymbolicLink())
      throw new Error(
        `${relativePath} crosses '${parts.slice(0, i + 1).join('/')}', which is a link or reparse point — managed paths never follow one.`,
      );
    if (!leaf && !stats.isDirectory())
      throw new Error(`${relativePath} crosses '${parts.slice(0, i + 1).join('/')}', which is not a directory.`);
    current = next;
    walked.push(parts[i]);
    // Defense in depth: the accumulated path must stay strictly inside the inspected root.
    const inside = path.relative(managedRoot, current);
    if (inside.startsWith('..') || path.isAbsolute(inside))
      throw new Error(`${relativePath} resolves outside the managed root.`);
  }
  return { target: current, resolvedRelativePath: walked.join('/') };
}

/**
 * Deterministic in-memory LocalFileIO for tests and for callers that never touch a disk. Same
 * contract — read returns hashed bytes, writeNew refuses an existing name — and records every call.
 */
export class FakeLocalFileIO implements LocalFileIO {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: { method: 'inspectRoot' | 'read' | 'writeNew'; root: string; relativePath?: string }[] = [];
  private key(root: string, relativePath: string): string {
    return `${root}\n${relativePath}`;
  }
  inspectRoot(root: string): string {
    this.calls.push({ method: 'inspectRoot', root });
    return root;
  }
  read(root: string, relativePath: string, maxBytes: number): VerifiedLocalFile {
    this.calls.push({ method: 'read', root, relativePath });
    const bytes = this.files.get(this.key(root, relativePath));
    if (bytes === undefined) throw new Error(`${relativePath} is not present inside the managed root.`);
    if (bytes.byteLength > maxBytes)
      throw new Error(`${relativePath} is ${bytes.byteLength} bytes — larger than the ${maxBytes}-byte limit.`);
    return {
      bytes: bytes.slice(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      resolvedRelativePath: relativePath,
    };
  }
  writeNew(root: string, relativePath: string, bytes: Uint8Array): void {
    this.calls.push({ method: 'writeNew', root, relativePath });
    const key = this.key(root, relativePath);
    if (this.files.has(key))
      throw new Error(`${relativePath} already exists — writeNew never replaces an existing path.`);
    this.files.set(key, bytes.slice());
  }
}
