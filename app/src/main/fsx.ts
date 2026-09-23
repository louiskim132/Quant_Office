import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const isGone = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * fs.rmSync({recursive:true}) can fail permanently with EPERM on Windows: the recursive walker keeps
 * directory handles open while deleting children, and rmdir on a directory with an open handle is
 * refused. Deleting bottom-up and closing each listing before touching entries avoids the problem.
 * force semantics match fs.rmSync: anything already gone is skipped rather than reported.
 */
export function removeTreeSync(target: string): void {
  let stats;
  try { stats = lstatSync(target); } catch (error) {
    if (isGone(error)) return;
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    let entries: string[] = [];
    try { entries = readdirSync(target); } catch (error) {
      if (!isGone(error)) throw error;
    }
    for (const entry of entries) removeTreeSync(path.join(target, entry));
    try { rmdirSync(target); } catch (error) {
      if (!isGone(error)) throw error;
    }
  } else {
    try { unlinkSync(target); } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
}

export async function removeTree(target: string): Promise<void> {
  let stats;
  try { stats = await lstat(target); } catch (error) {
    if (isGone(error)) return;
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    let entries: string[] = [];
    try { entries = await readdir(target); } catch (error) {
      if (!isGone(error)) throw error;
    }
    for (const entry of entries) await removeTree(path.join(target, entry));
    try { await rmdir(target); } catch (error) {
      if (!isGone(error)) throw error;
    }
  } else {
    try { await unlink(target); } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
}

