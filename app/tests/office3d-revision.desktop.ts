import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const out = path.resolve('test-output/office-behavior');
const { PNG } = createRequire(import.meta.url)('pngjs');
await mkdir(out, { recursive: true });
await build({
  entryPoints: ['tests/fixtures/office3d-preview.tsx'],
  outfile: path.join(out, 'preview.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome142',
});
await writeFile(
  path.join(out, 'index.html'),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script src="preview.js"></script></body></html>',
);
const browser = await chromium.launch({
  ...(process.env.QRO_CHROMIUM ? { executablePath: process.env.QRO_CHROMIUM } : {}),
  args: ['--ignore-gpu-blocklist'],
});
const checks: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const canvas = page.locator('canvas[data-engine="webgl"]');
  await page.waitForFunction(() => document.querySelector('.office3d-host')?.getAttribute('data-ready') === 'true');
  const restCount = () => page.locator('[data-office-agent][data-location="rest"]').count();
  const configure = async (changes: Record<string, unknown>) => {
    await page.evaluate(c => (window as any).__fixture(c), changes);
    await page.waitForTimeout(250);
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>('[data-office-agent]')].every(el => {
        const w = (window as any).__engine?.walkers.get(el.dataset.officeAgent);
        const location =
          el.dataset.location === 'rest' ? 'rest' : el.dataset.location?.startsWith('room:') ? 'room' : 'desk';
        return w?.visual.location.kind === location;
      }),
    );
  };
  const settle = async () => {
    await page.evaluate(() => {
      const engine = (window as any).__engine;
      for (let i = 0; i < 1500; i++) engine.advanceWalkers(0.1);
      engine.draw();
    });
  };
  const shot = async (name: string) => {
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const png = PNG.sync.read(await canvas.screenshot());
    const colors = new Set<string>();
    for (let i = 0; i < png.data.length; i += 64) colors.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
    assert.ok(colors.size > 100, `${name} has a rendered scene, not a blank canvas`);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  };
  assert.equal(await restCount(), 7);
  assert.equal(await page.getByText('0% of the allowance left', { exact: false }).count(), 0);
  await shot('idle-desktop');
  for (const tag of await page.locator('[data-office-agent]').all()) {
    await tag.hover();
    await tag.locator('.tag-card').waitFor({ state: 'visible' });
    await page.mouse.move(5, 5);
  }
  await configure({ phase: 'working' });
  assert.equal(await restCount(), 1, 'unrelated agent rests; the six project members attend');
  assert.equal(await page.locator('[data-office-agent][data-status="working"]').count(), 1);
  // Working -> idle -> working during a walk must discard the queued rest destination.
  await configure({ phase: 'idle' });
  await configure({ phase: 'working' });
  await settle();
  const wrong = await page.evaluate(() =>
    [...(window as any).__engine.walkers.values()]
      .filter((w: any) => w.place.kind !== w.visual.location.kind || w.pending || w.route)
      .map((w: any) => ({
        id: w.avatar.id,
        place: w.place.kind,
        wanted: w.visual.location.kind,
        pending: w.pending?.kind,
        route: !!w.route,
      })),
  );
  assert.deepEqual(wrong, [], 'latest location wins rapid transitions');
  await shot('running-desktop');
  checks.push(
    'Idle roster rests; all related project members attend while one works; unrelated agent stays at rest; rapid changes converge',
  );
  await configure({ phase: 'meeting', remaining: 5 });
  await settle();
  assert.equal(await restCount(), 7, '5% overrides both meeting and project attendance');
  await shot('low-allowance');
  await configure({ remaining: 5.1 });
  await settle();
  assert.equal(await restCount(), 1);
  assert.equal(await page.locator('[data-location="room:r1"]').count(), 1);
  await configure({ phase: 'idle', remaining: null });
  await settle();
  assert.equal(await restCount(), 7);
  checks.push(
    'Allowance <=5% forces rest including meeting participants; >5% resumes attendance; project completion returns everyone to rest',
  );

  for (const theme of ['light', 'dark']) {
    const roof = await page.evaluate(t => (window as any).__roofCheck(t), theme);
    assert.equal(roof.samples, 96);
    assert.deepEqual(roof.failures, []);
  }
  checks.push(
    '192 roof ray samples across all six campus buildings and both themes hit white geometry with no coplanar glass',
  );
  const box = (await canvas.boundingBox())!;
  await page.evaluate(() => (window as any).__roofView());
  await shot('white-roof');
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
  await page.waitForTimeout(800);
  const drag = async (button: 'left' | 'right') => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button });
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 20, { steps: 8 });
    await page.mouse.up({ button });
    await page.waitForTimeout(800);
  };
  const az = await canvas.getAttribute('data-azimuth'),
    target = await canvas.getAttribute('data-target');
  await drag('left');
  assert.equal(await canvas.getAttribute('data-azimuth'), az);
  assert.notEqual(await canvas.getAttribute('data-target'), target);
  await drag('right');
  assert.notEqual(await canvas.getAttribute('data-azimuth'), az);
  await page.locator('.office3d-host').focus();
  await page.keyboard.press('Space');
  const nextAz = await canvas.getAttribute('data-azimuth');
  await drag('left');
  assert.equal(await canvas.getAttribute('data-azimuth'), nextAz);
  checks.push('Left hold pans, right hold rotates, Space release preserves mappings');
  await page.getByRole('button', { name: 'Reset view', exact: true }).click();
  await page.waitForTimeout(800);
  await configure({ count: 50, reduced: true });
  await page.waitForFunction(() => document.querySelector('.office3d canvas')?.getAttribute('data-people') === '50');
  assert.equal(await restCount(), 50);
  await shot('large-roster');
  await configure({ count: 7, offset: 43 });
  await page.waitForFunction(() => document.querySelector('.office3d canvas')?.getAttribute('data-people') === '7');
  assert.equal(await restCount(), 7, 'high-numbered lounge slots survive early roster removals');
  await configure({ offset: 0, theme: 'dark' });
  await page.waitForTimeout(1000);
  await shot('idle-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000);
  await shot('idle-mobile');
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(1000);
  await shot('idle-compact');
  checks.push('Nonblank screenshots: 1440px light/dark, 1000px compact, 390px mobile, and a 50-person lounge');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        providerCalls: 0,
        roster:
          'Test dir 1, Test PM A-D, Test worker 1-2 and synthetic overflow workers: Devin SWE-2 / max profiles; no provider dispatched',
      },
      null,
      2,
    ),
  );
  console.log(checks.join('\n'));
} finally {
  await browser.close();
}
