/** Read-only audit of the exact packaged artifact. No signing identity or update host is configured. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
const require = createRequire(import.meta.url);
const asar = createRequire(require.resolve('@electron/packager'))('@electron/asar');
const root = path.resolve(process.argv[2] || 'release/Quant Research Office-win32-x64');
const archive = path.join(root, 'resources', 'app.asar');
const findings = [];
const inventory = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry),
      stat = lstatSync(file);
    const name = path.relative(root, file).replaceAll('\\', '/');
    if (stat.isSymbolicLink()) {
      findings.push({ file: name, reason: 'unexpected link' });
      continue;
    }
    if (stat.isDirectory()) {
      walk(file);
      continue;
    }
    const bytes = readFileSync(file);
    inventory.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    if (/(?:^|\/)(?:secrets\.dat|provider-tools\.json|workspace\.sqlite|.*\.sqlite(?:-wal|-shm)?|.*\.env)$/i.test(name))
      findings.push({ file: name, reason: 'workspace/credential filename' });
  }
}
walk(root);
let archiveFiles = 0;
for (const entry of asar.listPackage(archive)) {
  const name = entry.replace(/^[/\\]/, '').replaceAll('\\', '/');
  const member = entry.replace(/^[/\\]/, '');
  const stat = asar.statFile(archive, member);
  if (stat.files) continue;
  archiveFiles++;
  if (
    /(?:^|\/)(?:test-output|records|\.git|workspace|secrets\.dat|provider-tools\.json|.*\.sqlite)(?:\/|$)/i.test(name)
  )
    findings.push({ file: 'app.asar/' + name, reason: 'workspace/history filename' });
  if (!/\.(?:cjs|js|json|html|css|md|ps1|py|txt|yml)$/i.test(name)) continue;
  const text = asar.extractFile(archive, member).toString('utf8');
  if (
    /C:(?:\\\\?|\/)Users(?:\\\\?|\/)louis\b/i.test(text) ||
    /Desktop(?:\\\\?|\/)AI(?:\\\\?|\/)Quant Office/i.test(text)
  )
    findings.push({ file: 'app.asar/' + name, reason: 'developer absolute path' });
  if (
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      text,
    )
  )
    findings.push({ file: 'app.asar/' + name, reason: 'possible secret; inspect locally without publishing value' });
}
const fuses = await getCurrentFuseWire(path.join(root, 'Quant Research Office.exe'));
const report = {
  status: findings.length ? 'FAIL' : 'PASS',
  scope: 'PACKAGE_INVENTORY_AND_HEURISTIC_PRIVACY_SCAN',
  artifact: inventory.find(file => file.path === 'resources/app.asar'),
  files: inventory.length,
  archiveFiles,
  fuses: {
    runAsNode: fuses[FuseV1Options.RunAsNode],
    nodeOptions: fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable],
    inspector: fuses[FuseV1Options.EnableNodeCliInspectArguments],
    cookieEncryption: fuses[FuseV1Options.EnableCookieEncryption],
  },
  limitations: [
    'Heuristic scan; not a proof that no secret exists.',
    'No signing, installer, update, clean-machine or legal acceptance.',
  ],
  findings,
  inventory,
};
if (process.argv[3]) writeFileSync(path.resolve(process.argv[3]), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, inventory: undefined }, null, 2));
if (findings.length) process.exitCode = 1;
