/** Unsigned Inno Setup installer around the packaged app; hashes prove bytes, never publisher trust. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from './portable-release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function findIscc() {
  const candidates = [
    process.env.QRO_ISCC,
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
  ];
  const found = candidates.find(file => file && existsSync(file));
  if (!found) throw new Error('Inno Setup 6 (ISCC.exe) not found; set QRO_ISCC.');
  return found;
}

export async function createInstaller(root, outputDir, commit) {
  root = resolve(root);
  outputDir = resolve(outputDir);
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Supply the exact 40-character source commit.');
  const files = await inventory(root);
  if (
    !files.some(file => file.path === 'Quant Research Office.exe') ||
    !files.some(file => file.path === 'resources/app.asar')
  )
    throw new Error('A packaged Windows app is required.');
  // The installed folder carries the same closed inventory as the portable ZIP, so
  // verify-portable.ps1 can check an installation byte for byte.
  await writeFile(
    join(root, 'qro-release.json'),
    JSON.stringify({ format: 'QRO_PORTABLE_V1', signed: false, sourceCommit: commit, files }, null, 2) + '\n',
  );
  const { version } = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
  const base = `qro-${commit}-win-x64-setup`;
  const output = join(outputDir, `${base}.exe`);
  // Exclusive outputs preserve earlier versions and prevent silently replacing published bytes.
  if (existsSync(output)) throw new Error(`Installer already exists: ${output}`);
  execFileSync(
    findIscc(),
    [
      '/Q',
      `/DSourceDir=${root}`,
      `/DAppVersion=${version}`,
      `/DSourceCommit=${commit}`,
      `/DOutputDir=${outputDir}`,
      `/DOutputBase=${base}`,
      join(here, '..', 'installer', 'qro.iss'),
    ],
    { stdio: 'inherit' },
  );
  const bytes = await readFile(output);
  await writeFile(output + '.sha256', `${sha256(bytes)}  ${basename(output)}\n`, { flag: 'wx' });
  return {
    sourceCommit: commit,
    version,
    signed: false,
    files: files.length,
    bytes: bytes.length,
    sha256: sha256(bytes),
    output,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, outputDir, commit] = process.argv.slice(2);
  if (!root || !outputDir || !commit)
    throw new Error('Usage: installer-release.mjs <package-dir> <output-dir> <source-commit>');
  console.log(JSON.stringify(await createInstaller(root, outputDir, commit), null, 2));
}
