/**
 * 3D office acceptance on synthetic data: the real window, the real WebGL scene, a scratch data
 * folder and fixture agents that are never dispatched. Run with QRO_EXECUTABLE for a packaged build.
 */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';

const data = await mkdtemp(path.join(tmpdir(), 'qro-office3d-'));
await mkdir(path.join(data, 'workspace'));
await mkdir('test-output', { recursive: true });
const store = new OfficeStore(path.join(data, 'workspace', 'workspace.sqlite'));
const now = new Date().toISOString();
const roster = [
  ['DIRECTOR', 'Test dir 1'],
  ['PM_A', 'Test PM A'],
  ['PM_B', 'Test PM B'],
  ['PM_C', 'Test PM C'],
  ['PM_D', 'Test PM D'],
  ['WORKER', 'Test worker 1'],
] as const;
for (const [role, name] of roster)
  store.addAgent({
    id: randomUUID(),
    name,
    role,
    team: 'Synthetic acceptance',
    provider: 'openai',
    model: 'fixture-unverified',
    effort: 'default',
    account: 'fixture@example.test',
    execution: 'HOSTED_SETUP_REQUIRED',
    createdAt: now,
    connectionVerifiedAt: now,
    instructions: 'Synthetic 3D office fixture; never dispatch.',
  });
store.close();
const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env;
const app = await electron.launch({
  args: process.env.QRO_EXECUTABLE ? [] : [process.cwd()],
  ...(process.env.QRO_EXECUTABLE ? { executablePath: process.env.QRO_EXECUTABLE } : {}),
  env: { ...env, QRO_USER_DATA_DIR: data },
});
const checks: string[] = [];
try {
  const page = await app.firstWindow(),
    errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  await page.evaluate(() => localStorage.setItem('qro.pref.office-view', '3d'));

  // The floor: a WebGL canvas, six people, each with a labelled, focusable name tag.
  const stage = page.locator('.office3d');
  const webgl = await stage
    .locator('canvas[data-engine="webgl"]')
    .waitFor({ timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  if (!webgl) {
    // No usable GPU in this environment: the flat floor must have taken over, never a blank box.
    await page.locator('.sky-office').waitFor();
    assert.equal(await page.locator('[data-office-agent]').count(), 6);
    checks.push('WebGL unavailable here: the classic floor took over with six people (3D steps not run)');
  } else {
    const canvas = stage.locator('canvas');
    await page.waitForFunction(() => document.querySelector('.office3d canvas')?.getAttribute('data-people') === '6');
    assert.equal(await page.locator('[data-office-agent]').count(), 6);
    for (const [, name] of roster) await page.getByRole('button', { name: new RegExp(`^${name} — `) }).waitFor();
    checks.push('3D floor: six seated people, each a labelled name-tag button');

    // Names switch: hide and show every name without touching a record.
    assert.equal(await stage.getAttribute('data-names'), 'on');
    await stage.getByRole('button', { name: 'Show names', exact: true }).click();
    assert.equal(await stage.getAttribute('data-names'), 'off');
    assert.equal(await page.locator('.office3d .tag-name:visible').count(), 0, 'no name is drawn while names are off');
    await stage.getByRole('button', { name: 'Show names', exact: true }).click();
    assert.equal(await stage.getAttribute('data-names'), 'on');
    checks.push('Names switch hides and restores every name tag');

    // Camera: rotate, zoom, reset — read back from the canvas.
    const read = async () => ({
      az: Number(await canvas.getAttribute('data-azimuth')),
      zoom: Number(await canvas.getAttribute('data-zoom')),
    });
    const start = await read();
    await stage.getByRole('button', { name: 'Rotate right', exact: true }).click();
    await page.waitForFunction(
      az => Number(document.querySelector('.office3d canvas')?.getAttribute('data-azimuth')) !== az,
      start.az,
    );
    await stage.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(
      zoom => Number(document.querySelector('.office3d canvas')?.getAttribute('data-zoom')) > zoom,
      start.zoom,
    );
    await stage.getByRole('button', { name: 'Reset view', exact: true }).click();
    await page.waitForFunction(
      ([az, zoom]) =>
        Number(document.querySelector('.office3d canvas')?.getAttribute('data-azimuth')) === az &&
        Math.abs(Number(document.querySelector('.office3d canvas')?.getAttribute('data-zoom')) - zoom) < 0.2,
      [start.az, start.zoom],
    );
    // Wheel zoom and keyboard rotation on the focused stage.
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(
      zoom => Number(document.querySelector('.office3d canvas')?.getAttribute('data-zoom')) > zoom,
      start.zoom,
    );
    await stage.getByRole('button', { name: 'Reset view', exact: true }).click();
    await stage.locator('.office3d-host').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(
      az => Number(document.querySelector('.office3d canvas')?.getAttribute('data-azimuth')) !== az,
      start.az,
    );
    await page.keyboard.press('0');
    checks.push('Rotate, zoom (buttons and wheel), keyboard rotate and reset change and restore the camera');

    // A person's chip locks the camera on them and opens their drawer; Escape closes it and returns focus.
    const zoomBefore = (await read()).zoom;
    await stage.locator('.stage-chip', { hasText: 'Test PM B' }).click();
    await page.getByRole('complementary', { name: 'Test PM B details' }).waitFor();
    await page.waitForFunction(
      zoom => Number(document.querySelector('.office3d canvas')?.getAttribute('data-zoom')) > zoom,
      zoomBefore,
    );
    await page.keyboard.press('Escape');
    await page.getByRole('complementary', { name: 'Test PM B details' }).waitFor({ state: 'hidden' });
    await stage.getByRole('button', { name: 'Reset view', exact: true }).click();

    // Hover card on a name tag, and the tag opens the same drawer.
    const tag = page.getByRole('button', { name: /^Test dir 1 — / });
    await tag.hover();
    await tag.locator('.tag-card').waitFor({ state: 'visible' });
    await tag.click();
    await page.getByRole('complementary', { name: 'Test dir 1 details' }).waitFor();
    await page.keyboard.press('Escape');
    checks.push('Chips focus the camera, name tags show a hover card and open the agent drawer');

    // Nobody walks without a location change: a settings write must not start a walk.
    const walks = await page.evaluate(async () => {
      let count = 0;
      new MutationObserver(records => {
        for (const r of records) if ((r.target as HTMLElement).getAttribute('data-motion') === 'walking') count++;
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-motion'] });
      const state = await window.office.getState();
      await window.office.command({
        type: 'settings.update',
        idempotencyKey: crypto.randomUUID(),
        settings: { ...state.settings, reducedMotion: !state.settings.reducedMotion },
      });
      await new Promise(resolve => setTimeout(resolve, 800));
      return count;
    });
    assert.equal(walks, 0);
    checks.push('A state change with no location change starts no walk');

    // Chat toggle: the CHAT button shows and hides the office chat without resizing the people away.
    const chatOpen = (await page.locator('.office-chat').count()) > 0;
    await stage.getByRole('button', { name: chatOpen ? 'Hide office chat' : 'Show office chat' }).click();
    assert.equal((await page.locator('.office-chat').count()) > 0, !chatOpen);
    await stage.getByRole('button', { name: chatOpen ? 'Show office chat' : 'Hide office chat' }).click();
    checks.push('CHAT toggles the office chat');
    await page.screenshot({ path: 'test-output/office3d-3d.png' });

    // Settings → Appearance → Classic: the flat floor returns; back to 3D restores the canvas.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const rail = page.getByRole('navigation', { name: 'Settings sections' });
    await rail.getByRole('button', { name: /^Appearance/ }).click();
    await page
      .getByRole('radiogroup', { name: 'Office view', exact: true })
      .getByRole('radio', { name: 'Classic' })
      .click();
    await page.getByRole('button', { name: 'Office', exact: true }).first().click();
    await page.locator('.sky-office').waitFor();
    assert.equal(await page.locator('.office3d').count(), 0);
    await page.screenshot({ path: 'test-output/office3d-classic.png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('radiogroup', { name: 'Office view', exact: true })
      .getByRole('radio', { name: '3D floor' })
      .click();
    await page.getByRole('button', { name: 'Office', exact: true }).first().click();
    await page.locator('.office3d canvas[data-engine="webgl"]').waitFor();
    checks.push('Classic view setting swaps the floor and 3D restores it');
  }
  assert.deepEqual(errors, []);
  await writeFile(
    'test-output/office3d-acceptance-report.json',
    JSON.stringify(
      {
        status: 'PASS',
        data,
        packaged: !!process.env.QRO_EXECUTABLE,
        webgl,
        providerCalls: 0,
        roster: 'Test dir 1, Test PM A–D, Test worker 1 — fixture-unverified/default; no agents executed',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`3D office acceptance passed (webgl=${webgl}).`);
} catch (e) {
  const page = await app.firstWindow();
  await page.screenshot({ path: 'test-output/office3d-failure.png' });
  throw e;
} finally {
  await app.close();
}
