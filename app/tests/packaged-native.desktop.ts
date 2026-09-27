import { _electron as electron, type ElectronApplication } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Run from app with QRO_EXECUTABLE pointing at the packaged executable. Never falls
// back to development Electron or the host Node ABI. No provider executable is used.
const workspace = await mkdtemp(path.join(tmpdir(), 'qro-packaged-native-'));
const nonce = randomUUID();
let desktop: ElectronApplication | undefined;
const report: Record<string, unknown> = {
  status: 'FAIL',
  at: new Date().toISOString(),
  workspace,
  fixtureOnly: true,
  providerCalls: 0,
  scope: 'Packaged Electron main-process node-pty I/O and exit; not hosted transport acceptance',
};
try {
  const executablePath = process.env.QRO_EXECUTABLE;
  assert.ok(
    executablePath && path.isAbsolute(executablePath),
    'Set QRO_EXECUTABLE to an absolute packaged executable path',
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  env.QRO_USER_DATA_DIR = workspace;
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath, args: [], env, timeout: 30_000 });
  await desktop.firstWindow();
  const started = performance.now();
  const result = await desktop.evaluate(
    async ({ app }, { nonce, workspace }) => {
      if (!app.isPackaged) throw new Error('Native acceptance requires app.isPackaged');
      // Resolve from the packaged application, never from this test's node_modules. evaluate() has no
      // module scope, so require and import() are unavailable; getBuiltinModule works in any context.
      const { createRequire } = process.getBuiltinModule('node:module') as typeof import('node:module');
      const paths = process.getBuiltinModule('node:path') as typeof import('node:path');
      const packagedRequire = createRequire(paths.join(app.getAppPath(), 'package.json'));
      const modulePath = packagedRequire.resolve('node-pty');
      const relative = paths.relative(app.getAppPath(), modulePath);
      if (relative.startsWith('..') || paths.isAbsolute(relative)) throw new Error('node-pty resolved outside package');
      const pty = packagedRequire('node-pty') as typeof import('node-pty');
      if (process.platform !== 'win32') throw new Error('This release fixture requires Windows ConPTY');
      const shell = paths.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      // read input and transform it: command echo alone cannot satisfy the output assertion.
      const script = "$x=[Console]::ReadLine(); [Console]::WriteLine('QRO_REPLY:' + $x.ToUpperInvariant()); exit 0";
      const terminal = pty.spawn(
        shell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        {
          cwd: workspace,
          cols: 100,
          rows: 30,
          env: { SystemRoot: process.env.SystemRoot!, TEMP: workspace, TMP: workspace },
          useConpty: true,
        },
      );
      let transcript = '';
      return await new Promise<{
        transcript: string;
        exitCode: number;
        modulePath: string;
        electron: string;
        node: string;
        modules: string;
        appPath: string;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          try {
            terminal.kill();
          } finally {
            reject(new Error('Packaged PTY timed out: ' + transcript));
          }
        }, 15_000);
        terminal.onData(chunk => {
          transcript += chunk;
        });
        terminal.onExit(({ exitCode }) => {
          clearTimeout(timeout);
          resolve({
            transcript,
            exitCode,
            modulePath,
            electron: process.versions.electron!,
            node: process.versions.node,
            modules: process.versions.modules,
            appPath: app.getAppPath(),
          });
        });
        terminal.resize(120, 40);
        terminal.write(nonce + '\r');
      });
    },
    { nonce, workspace },
  );
  report.native = result;
  report.latencyMs = performance.now() - started;
  assert.equal(result.exitCode, 0);
  assert.ok(result.transcript.includes('QRO_REPLY:' + nonce.toUpperCase()), 'PTY must return transformed input');
  report.status = 'PASS';
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  try {
    await desktop?.close();
  } catch (error) {
    report.status = 'FAIL';
    report.closeError = String(error);
    process.exitCode = 1;
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/packaged-native-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
