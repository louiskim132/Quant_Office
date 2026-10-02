import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
const data = await mkdtemp(path.join(tmpdir(), 'qro-settings-reviews-'));
await mkdir(path.join(data, 'workspace'));
const out = path.resolve('test-output/settings-reviews');
await mkdir(out, { recursive: true });
const store = new OfficeStore(path.join(data, 'workspace', 'workspace.sqlite'));
store.execute({
  type: 'settings.update',
  idempotencyKey: randomUUID(),
  settings: { ...store.snapshot().settings, theme: 'light', reducedMotion: true },
});
for (const [role, name] of [
  ['DIRECTOR', 'Test dir 1'],
  ['PM_A', 'Test PM A'],
  ['PM_B', 'Test PM B'],
  ['PM_C', 'Test PM C'],
  ['PM_D', 'Test PM D'],
  ['WORKER', 'Test worker 1'],
] as const)
  store.addAgent({
    id: randomUUID(),
    name,
    role,
    team: 'Synthetic acceptance',
    provider: 'devin',
    model: 'swe-2-max',
    effort: 'default',
    account: 'fixture@example.test',
    execution: 'HOSTED_SETUP_REQUIRED',
    createdAt: new Date().toISOString(),
    connectionVerifiedAt: new Date().toISOString(),
    instructions: 'Synthetic fixture; never dispatch.',
  });
store.close();
const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env;
const app = await electron.launch({
  executablePath: path.resolve('release/Quant Research Office-win32-x64/Quant Research Office.exe'),
  env: { ...env, QRO_USER_DATA_DIR: data },
});
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // The stand-in handlers replace the app's own, so they go in only once the app has registered them.
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  await app.evaluate('globalThis.__name = value => value');
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 1000);
    const replace = (name: string, fn: (...args: any[]) => any) => {
      ipcMain.removeHandler(name);
      ipcMain.handle(name, (_event, input) => ({ ok: true, value: fn(input) }));
    };
    replace('office:provider-key-state', () => ({ saved: false }));
    replace('office:agent-isolation-status', () => ({ configured: true }));
    replace('office:agent-isolation-verify', () => ({
      passed: true,
      checks: { syntheticCheck: true },
      evidencePath: 'synthetic/evidence.json',
    }));
    replace('office:connection-status', (provider: string) => ({
      provider,
      connected: true,
      account: 'fixture@example.test',
      windows: [],
      models: [],
      checkedAt: new Date().toISOString(),
    }));
    replace('office:local-sessions', () => ({
      total: 3,
      entries: ['claude', 'openai', 'devin'].map((provider, i) => ({
        id: `s${i}`,
        provider,
        createdAt: new Date().toISOString(),
        lifecycle: 'READY',
        surface: 'CLI',
        layout: 'FLAT_PACKET',
        packetHash: null,
        providerSessionId: null,
      })),
    }));
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Check account', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Check account', exact: true }).click();
  await page.getByRole('button', { name: 'Agent isolation' }).click();
  await page.getByRole('button', { name: 'Check agent isolation' }).click();
  await page.getByText(/Isolation check passed/).waitFor();
  assert.equal(await page.locator('.iso-providers tbody tr').count(), 3);
  await page.screenshot({ path: path.join(out, 'packaged-isolation.png') });
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await page.getByLabel('Left drag', { exact: true }).selectOption('rotate');
  await page.getByLabel('Move left key', { exact: true }).press('k');
  await page.getByLabel('Rotate left key', { exact: true }).press('j');
  await page.getByRole('button', { name: 'Office', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.office3d-host')?.getAttribute('data-ready') === 'true',
    undefined,
    { timeout: 60000 },
  );
  const canvas = page.locator('.office3d canvas[data-engine="webgl"]');
  const beforeImage = createHash('sha256')
    .update(await canvas.screenshot())
    .digest('hex');
  const target = await canvas.getAttribute('data-target');
  await page.locator('.office3d-host').focus();
  await page.keyboard.press('k');
  await page.waitForFunction(
    before => document.querySelector('.office3d canvas')?.getAttribute('data-target') !== before,
    target,
  );
  const az = await canvas.getAttribute('data-azimuth');
  await page.keyboard.press('j');
  await page.waitForFunction(
    before => document.querySelector('.office3d canvas')?.getAttribute('data-azimuth') !== before,
    az,
  );
  const afterImage = createHash('sha256')
    .update(await canvas.screenshot())
    .digest('hex');
  assert.notEqual(afterImage, beforeImage);
  const dragAz = await canvas.getAttribute('data-azimuth');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(
    before => document.querySelector('.office3d canvas')?.getAttribute('data-azimuth') !== before,
    dragAz,
  );
  await page.screenshot({ path: path.join(out, 'packaged-custom-controls.png') });
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByText('devin · swe-2 · max effort', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await page.locator('.session-history tbody tr').first().waitFor();
  assert.deepEqual((await page.locator('.session-history tbody tr td:nth-child(2)').allTextContents()).sort(), [
    'claude',
    'devin',
    'openai',
  ]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  assert.equal(await page.getByLabel('Move left key', { exact: true }).inputValue(), 'k');
  await page.getByRole('button', { name: 'Reset controls' }).click();
  assert.deepEqual(errors, []);
  console.log(
    `PASS packaged: scratch ${data}; six synthetic Devin SWE-2 Max seats, no provider launches. Saved key/mouse controls move the rendered canvas, settings/isolation, mixed history and model labels verified.`,
  );
} finally {
  await app.close();
}
