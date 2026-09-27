// Packaging runs under Electron's embedded Node (there is no standalone node on this machine), where
// fs is patched to treat .asar paths as virtual archive roots: rm of the extracted default_app.asar
// then walks phantom entries and rmdir fails EBUSY forever. Disabling asar support restores the
// plain-Node view the packager expects.
process.noAsar = true;
import { packager } from '@electron/packager';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = resolve(import.meta.dirname, '..');
const stage = resolve(root, 'dist/package-input'),
  out = resolve(root, 'release');
for (const target of [stage, out]) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Packaging target escaped application workspace.');
}
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(stage, { recursive: true });
await cp(resolve(root, 'dist/main'), resolve(stage, 'dist/main'), { recursive: true });
await cp(resolve(root, 'dist/renderer'), resolve(stage, 'dist/renderer'), { recursive: true });
await cp(resolve(root, 'dist/assets'), resolve(stage, 'dist/assets'), { recursive: true });
await writeFile(
  resolve(stage, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version,
      main: pkg.main,
      description: pkg.description,
      author: pkg.author,
      license: pkg.license,
    },
    null,
    2,
  ),
);
await cp(resolve(root, 'research-templates'), resolve(stage, 'research-templates'), { recursive: true });
// The PTY transport is a real native package: copy it, symlinks dereferenced, and keep its
// binaries outside the asar so Electron can load them.
const ptyEntry = (() => {
  try {
    return require.resolve('node-pty/package.json', { paths: [root] });
  } catch {
    return null;
  }
})();
if (ptyEntry) {
  const ptyDir = resolve(ptyEntry, '..');
  await cp(ptyDir, resolve(stage, 'node_modules/node-pty'), { recursive: true, dereference: true });
  console.log('Included native transport module from ' + ptyDir);
} else console.log('node-pty is not installed; packaging without the PTY transport.');
const output = await packager({
  dir: stage,
  out,
  name: pkg.productName,
  executableName: 'Quant Research Office',
  platform: 'win32',
  arch: 'x64',
  electronVersion: pkg.devDependencies.electron,
  asar: { unpack: '**/*.{node,dll,exe}' },
  overwrite: true,
  prune: false,
  icon: resolve(root, 'dist/assets/icon.ico'),
  appVersion: pkg.version,
  win32metadata: {
    CompanyName: 'Quant Research Office',
    FileDescription: 'Quant Research Office',
    ProductName: pkg.productName,
  },
});
for (const path of output) console.log(`Packaged: ${path}`);
