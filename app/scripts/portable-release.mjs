/** Free offline portable artifact tooling; hashes prove bytes, never publisher trust. */
import { createHash } from 'node:crypto';
import { readdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const manifestName = 'qro-release.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function inventory(root) {
  root = resolve(root);
  const files = [];
  async function walk(dir) {
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Portable artifacts must not contain links.');
    for (const name of (await readdir(dir)).sort()) {
      const file = join(dir, name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Portable artifacts must not contain links.');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) {
        const path = relative(root, file).replaceAll('\\', '/');
        if (path === manifestName) continue;
        const bytes = await readFile(file);
        files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error('Portable artifacts must contain regular files only.');
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function verifyPortable(root) {
  const manifest = JSON.parse(await readFile(join(root, manifestName), 'utf8'));
  if (manifest.format !== 'QRO_PORTABLE_V1' || manifest.signed !== false || !Array.isArray(manifest.files))
    throw new Error('Unsupported portable manifest.');
  const actual = await inventory(root);
  // Compare exact closed inventory: an added harmless file fails too.
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error('Portable inventory mismatch (missing, extra or changed file).');
  return manifest;
}

export async function createPortable(root, output, commit) {
  root = resolve(root);
  output = resolve(output);
  const rel = relative(root, output);
  if (!(isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)))
    throw new Error('Write the portable ZIP outside its input directory.');
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Supply the exact 40-character source commit.');
  const files = await inventory(root);
  if (
    !files.some(file => file.path === 'Quant Research Office.exe') ||
    !files.some(file => file.path === 'resources/app.asar')
  )
    throw new Error('A packaged Windows app is required.');
  const manifest = { format: 'QRO_PORTABLE_V1', signed: false, sourceCommit: commit, files };
  const zipFiles = {};
  for (const file of files) zipFiles[file.path] = new Uint8Array(await readFile(join(root, file.path)));
  zipFiles[manifestName] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
  const bytes = zipSync(zipFiles, { level: 0 });
  // Exclusive writes preserve earlier versions and prevent silently replacing published bytes.
  await writeFile(output, bytes, { flag: 'wx' });
  await writeFile(output + '.sha256', `${sha256(bytes)}  ${output.split(/[\\/]/).at(-1)}\n`, { flag: 'wx' });
  return { sourceCommit: commit, signed: false, files: files.length, bytes: bytes.length, sha256: sha256(bytes) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root, output, commit] = process.argv.slice(2);
  if (command === 'create' && root && output && commit)
    console.log(JSON.stringify(await createPortable(root, output, commit), null, 2));
  else if (command === 'verify' && root)
    console.log(JSON.stringify({ status: 'PASS', ...(await verifyPortable(root)), files: undefined }, null, 2));
  else
    throw new Error(
      'Usage: portable-release.mjs create <package-dir> <new.zip> <source-commit> | verify <extracted-dir>',
    );
}
