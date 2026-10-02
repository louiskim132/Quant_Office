/**
 * Smoke check for a hardened release build (the inspector fuse is off, so Playwright cannot launch
 * it; this attaches over the Chromium debugging port instead). Opens the build twice on a new,
 * empty scratch data folder: the office heading and the first 3D frame must render, no agent may
 * exist, and the second launch must show its window at once in the remembered theme.
 * usage (from app/): pnpm exec tsx tests/installed-smoke.desktop.ts "<path to Quant Research Office.exe>"
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';

const exe = process.argv[2];
assert.ok(exe, 'usage: tsx tests/installed-smoke.desktop.ts "<path to Quant Research Office.exe>"');
const data = await mkdtemp(path.join(tmpdir(), 'qro-installed-smoke-'));
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function open(label: string) {
  const port = await freePort();
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    env: { ...env, QRO_USER_DATA_DIR: data },
    windowsHide: true,
    stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let browser: Browser | undefined;
  try {
    for (let i = 0; i < 80 && !browser; i++)
      browser = await chromium
        .connectOverCDP(`http://127.0.0.1:${port}`)
        .catch(() => new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 250)));
    assert.ok(browser, `${label}: the build opens`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    await page.getByRole('heading', { name: 'The office', exact: true }).waitFor({ timeout: 60000 });
    await page.waitForFunction(
      () => document.querySelector('.office3d-host')?.getAttribute('data-ready') === 'true',
      null,
      {
        timeout: 60000,
      },
    );
    assert.equal(await page.locator('[data-office-agent]').count(), 0, `${label}: an empty workspace has no agents`);
    await page.evaluate(() => window.close());
  } finally {
    await browser?.close();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill();
  }
}

await open('first launch');
await open('second launch');
const log = await readFile(path.join(data, 'logs', 'main.log'), 'utf8');
const lines = log
  .split(/\r?\n/)
  .filter(l => / startup window=/.test(l))
  .map(l => l.replace(/^.*?startup /, ''));
assert.equal(lines.length, 2, 'one startup line per launch');
assert.match(lines[1], /theme=light shown=0ms/, 'the second launch shows at once in the remembered theme');
assert.equal((await readFile(path.join(data, 'window-theme'), 'utf8')).trim(), 'light');
console.log(`PASS installed smoke: ${exe}\nscratch ${data}\n${lines.map(l => `startup ${l}`).join('\n')}`);
