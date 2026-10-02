import { build } from 'esbuild';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const out = path.resolve('test-output/settings-reviews');
await mkdir(out, { recursive: true });
await build({
  entryPoints: ['tests/fixtures/settings-reviews-preview.tsx'],
  outfile: path.join(out, 'preview.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
});
await writeFile(
  path.join(out, 'index.html'),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script src="preview.js"></script></body></html>',
);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  assert.equal(await page.getByRole('button', { name: 'Check account', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Check account', exact: true }).click();
  await page.getByRole('alert').getByText('Synthetic unavailable provider').waitFor();
  assert.deepEqual(await page.evaluate(() => (window as any).__checks), ['claude', 'openai', 'devin']);
  await page.screenshot({ path: path.join(out, 'connections.png'), fullPage: true });
  await page.getByRole('button', { name: 'Agent isolation' }).click();
  await page.getByRole('button', { name: 'Check agent isolation' }).waitFor();
  const check = await page.getByRole('button', { name: 'Check agent isolation' }).boundingBox();
  const signin = await page.getByRole('button', { name: 'Sign in claude for agent account' }).boundingBox();
  const table = await page.locator('.iso-providers').boundingBox();
  assert.ok(check && signin && table && check.y < signin.y && signin.y < table.y);
  assert.deepEqual(await page.locator('.iso-providers th').allTextContents(), ['Provider', 'Status']);
  assert.equal(await page.locator('.iso-providers tbody tr').count(), 3);
  await page.getByRole('button', { name: 'Check agent isolation' }).click();
  await page
    .getByRole('status')
    .getByText(/Isolation check passed/)
    .waitFor();
  await page.screenshot({ path: path.join(out, 'isolation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await page.getByLabel('Left drag', { exact: true }).selectOption('rotate');
  assert.equal(await page.getByLabel('Right drag', { exact: true }).inputValue(), 'pan');
  await page.getByLabel('Move left key', { exact: true }).press('k');
  await page.reload();
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  assert.equal(await page.getByLabel('Move left key', { exact: true }).inputValue(), 'k');
  assert.equal(await page.getByLabel('Left drag', { exact: true }).inputValue(), 'rotate');
  await page.screenshot({ path: path.join(out, 'controls.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reset controls' }).click();
  assert.equal(await page.getByLabel('Move left key', { exact: true }).inputValue(), 'a');
  await page.evaluate(() => (window as any).__view('reviews'));
  await page.locator('.review-task > summary').click();
  assert.deepEqual(await page.locator('.review-step-name strong').allTextContents(), [
    'Test worker 1',
    'Test PM A',
    'Test PM B',
    'Test PM A',
    'Test dir 1',
  ]);
  await page.locator('.review-step > summary').nth(3).click();
  await page.getByText('Full review content for j3.').waitFor();
  assert.equal(await page.locator('.review-task[open]').count(), 1);
  assert.equal(await page.locator('.review-step[open]').count(), 1);
  assert.equal(
    await page.locator('.review-step[open] .review-content > :last-child').getAttribute('class'),
    'review-recorded',
  );
  await page.screenshot({ path: path.join(out, 'reviews.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, 'reviews-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.evaluate(() => (window as any).__view('settings'));
  await page.getByRole('button', { name: 'Agent isolation' }).click();
  await page.screenshot({ path: path.join(out, 'isolation-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (window as any).__view('usage'));
  await page.locator('.session-history tbody tr').first().waitFor();
  assert.equal(await page.locator('.session-history tbody tr').count(), 25);
  assert.deepEqual(
    [...new Set(await page.locator('.session-history tbody tr td:nth-child(2)').allTextContents())].sort(),
    ['claude', 'devin', 'openai'],
  );
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  assert.equal(await page.locator('.session-history tbody tr').count(), 30);
  await page.getByRole('button', { name: 'Refresh session history' }).click();
  assert.equal(await page.locator('.session-history tbody tr').count(), 25);
  await page.locator('.session-history').screenshot({ path: path.join(out, 'history.png') });
  await page.evaluate(() => (window as any).__view('model'));
  await page.getByText('devin · swe-2 · max effort', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: global checks, isolation layout, persisted custom controls, nested ordered inline reviews, desktop/mobile overflow, mixed-provider pagination/refresh, model label.',
  );
} finally {
  await browser.close();
}
