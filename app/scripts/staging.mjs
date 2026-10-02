import { lstat, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Only generated trees explicitly named by the caller may be replaced. Never traverse a
// junction/symlink supplied in place of the application root or a generated parent.
export async function resetGeneratedDirectory(root, target) {
  root = resolve(root);
  target = resolve(target);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('Generated directory escaped application workspace.');
  let current = root;
  for (const part of ['', ...rel.split(sep)]) {
    current = part ? resolve(current, part) : current;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Generated directory must not traverse links or files.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}
