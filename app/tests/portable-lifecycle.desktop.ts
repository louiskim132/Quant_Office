/** Current-Windows portable update/rollback/uninstall acceptance. Never opens real user data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { removeTree } from '../src/main/fsx';

const [oldPackage, newPackage] = process.argv.slice(2);
assert.ok(oldPackage && newPackage, 'Provide two hardened package directories.');
const root = await mkdtemp(path.join(tmpdir(), 'qro-portable-lifecycle-'));
const data = path.join(root, 'userData');
const versions = path.join(root, 'versions');
await mkdir(versions);
await cp(oldPackage, path.join(versions, 'old'), { recursive: true });
await cp(newPackage, path.join(versions, 'new'), { recursive: true });
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const report: Record<string, unknown> = { root, scope: 'CURRENT_WINDOWS_SCRATCH_PORTABLE_LIFECYCLE' };
let projectId: string | undefined;
async function open(version: 'old' | 'new', create: boolean) {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(path.join(versions, version, 'Quant Research Office.exe'), [`--remote-debugging-port=${port}`], {
    env: { ...env, QRO_USER_DATA_DIR: data },
    windowsHide: true,
    stdio: 'ignore',
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let browser: Browser | undefined;
  try {
    for (let i = 0; i < 100 && !browser; i++)
      browser = await chromium
        .connectOverCDP(`http://127.0.0.1:${port}`)
        .catch(() => new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 200)));
    assert.ok(browser, 'Portable application starts.');
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    await page.getByRole('heading', { name: 'The office', exact: true }).waitFor({ timeout: 60000 });
    if (create)
      projectId = await page.evaluate(async () => {
        const state = await window.office.command({
          type: 'project.create',
          idempotencyKey: crypto.randomUUID(),
          name: 'Portable lifecycle synthetic fixture',
          mandate: 'No dispatch or research.',
          budgetCents: 0,
        });
        return state.projects[0].id;
      });
    const state = await page.evaluate(() => window.office.getState());
    assert.equal(state.projects.length, 1);
    assert.equal(state.projects[0].id, projectId, 'The same durable project survives the binary switch.');
    assert.equal(state.agents.length, 0);
    assert.equal(state.jobs?.length ?? 0, 0, 'No provider work is launched.');
    await page.evaluate(() => window.close());
  } finally {
    await browser?.close();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) {
      child.kill();
      await closed;
    }
  }
}
await open('old', true);
await open('new', false);
report.update = 'PASS';
await open('old', false);
report.rollback = 'PASS';
const database = path.join(data, 'workspace', 'workspace.sqlite');
const before = createHash('sha256')
  .update(await readFile(database))
  .digest('hex');
// Verify the absolute delete target belongs to this specifically created scratch versions folder.
const absolute = path.resolve(versions);
assert.equal(path.dirname(absolute), path.resolve(root));
assert.equal(path.basename(absolute), 'versions');
await removeTree(absolute);
assert.equal(
  await stat(absolute).then(
    () => true,
    () => false,
  ),
  false,
);
assert.equal(
  createHash('sha256')
    .update(await readFile(database))
    .digest('hex'),
  before,
  'Uninstall preserves user data bytes.',
);
report.uninstall = 'PASS_DATA_PRESERVED';
report.cleanWindowsVM = 'NOT_RUN';
console.log(JSON.stringify(report, null, 2));
