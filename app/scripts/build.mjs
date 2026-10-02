import { build } from 'esbuild';
import { copyFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'dist/renderer'), { recursive: true });
await mkdir(resolve(root, 'dist/main'), { recursive: true });
await mkdir(resolve(root, 'dist/assets'), { recursive: true });
await Promise.all([
  build({
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(root, 'dist/main/main.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron', 'node:*', 'node-pty'],
    sourcemap: false,
  }),
  build({
    entryPoints: [resolve(root, 'src/main/preload.ts')],
    outfile: resolve(root, 'dist/main/preload.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
    sourcemap: false,
  }),
  build({
    entryPoints: [resolve(root, 'src/renderer/main.tsx')],
    outfile: resolve(root, 'dist/renderer/app.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome142',
    format: 'iife',
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
]);
// The agent-isolation host (LR-16) ships unbundled next to main.cjs — it is copied into the
// ACL'd sessions root at runtime and executed by plain node.exe under the QRO-Agent account, so
// it must stay a standalone node-stdlib script rather than part of the esbuild bundle.
await copyFile(resolve(root, 'src/main/agent-host.cjs'), resolve(root, 'dist/main/agent-host.cjs'));
await writeFile(
  resolve(root, 'dist/renderer/index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"><title>Quant Research Office</title><link rel="stylesheet" href="./app.css"></head><body><div id="root"></div><script src="./app.js"></script></body></html>`,
);
// The page shown while the workspace opens, one per theme, in the app's page and muted-text colours.
for (const [file, background, color] of [
  ['loading.html', '#171614', '#a79f90'],
  ['loading-light.html', '#f1f0e9', '#5b6c67'],
])
  await writeFile(
    resolve(root, 'dist/renderer', file),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Quant Research Office</title><style>html,body{height:100%;margin:0;background:${background};color:${color};font:15px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}</style></head><body><p>Loading…</p></body></html>`,
  );
// Original pixel-office application icon; no external artwork or network assets.
const icon = new PNG({ width: 256, height: 256 });
function rect(x, y, w, h, c) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * 256 + xx) * 4;
      icon.data[i] = c[0];
      icon.data[i + 1] = c[1];
      icon.data[i + 2] = c[2];
      icon.data[i + 3] = 255;
    }
}
rect(0, 0, 256, 256, [16, 23, 25]);
rect(24, 24, 208, 208, [30, 43, 45]);
rect(36, 36, 184, 184, [22, 32, 34]);
rect(56, 58, 144, 93, [83, 105, 101]);
rect(64, 66, 128, 77, [11, 27, 30]);
for (const [x, h] of [
  [82, 20],
  [106, 37],
  [130, 29],
  [154, 51],
])
  rect(x, 133 - h, 14, h, [102, 208, 182]);
rect(113, 151, 30, 16, [83, 105, 101]);
rect(92, 167, 72, 8, [83, 105, 101]);
rect(48, 183, 160, 16, [189, 151, 85]);
rect(60, 199, 14, 24, [111, 85, 53]);
rect(182, 199, 14, 24, [111, 85, 53]);
const png = PNG.sync.write(icon);
await writeFile(resolve(root, 'dist/assets/icon.png'), png);
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 0;
ico[7] = 0;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
png.copy(ico, 22);
await writeFile(resolve(root, 'dist/assets/icon.ico'), ico);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
console.log(`Built ${pkg.productName} ${pkg.version}. Renderer, sandboxed preload and controller ready.`);
