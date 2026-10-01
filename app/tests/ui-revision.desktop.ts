import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
const data = await mkdtemp(path.join(tmpdir(), 'qro-ui-revision-'));
await mkdir(path.join(data, 'workspace'));
await mkdir('test-output', { recursive: true });
const store = new OfficeStore(path.join(data, 'workspace', 'workspace.sqlite'));
const now = new Date().toISOString();
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
    provider: 'openai',
    model: 'fixture-unverified',
    effort: 'default',
    account: 'fixture@example.test',
    execution: 'HOSTED_SETUP_REQUIRED',
    createdAt: now,
    connectionVerifiedAt: now,
    instructions: 'Synthetic UI fixture; never dispatch.',
  });
const project = store.execute({
  type: 'project.create',
  idempotencyKey: randomUUID(),
  name: 'UI acceptance',
  mandate: 'Synthetic populated pages; no provider calls',
  budgetCents: 0,
}).projects[0];
for (let i = 0; i < 24; i++)
  store.execute({
    type: 'memory.finding.note',
    idempotencyKey: randomUUID(),
    projectId: project.id,
    kind: i % 3 === 0 ? 'RESULT' : i % 3 === 1 ? 'HYPOTHESIS' : 'NOTE',
    title: `Finding ${i} — bounded research evidence`,
    body: `Synthetic body ${i}. <script>window.injected=true</script>`,
  });
const findings = store.snapshot().findings!;
for (let i = 1; i < findings.length; i++)
  store.execute({
    type: 'memory.relationship.propose',
    idempotencyKey: randomUUID(),
    projectId: project.id,
    fromFindingId: findings[i - 1].id,
    toFindingId: findings[i].id,
    kind: i % 2 ? 'SUPPORTS' : 'CONTRADICTS',
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
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  await page.getByLabel('Current project', { exact: true }).selectOption(project.id);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async theme => {
      const s = await window.office.getState();
      await window.office.command({
        type: 'settings.update',
        idempotencyKey: crypto.randomUUID(),
        settings: { ...s.settings, theme, reducedMotion: true },
      });
    }, theme);
    for (const width of [1440, 1000]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 950), width);
      for (const destination of ['Office', 'Agents', 'Projects', 'Memory', 'History', 'Usage', 'Settings']) {
        await page.getByRole('button', { name: destination, exact: true }).first().click();
        if (destination === 'Projects')
          await page.getByRole('button', { name: 'Open UI acceptance', exact: true }).click();
        if ((await page.getByLabel('Current project', { exact: true }).inputValue()) !== project.id)
          await page.getByLabel('Current project', { exact: true }).selectOption(project.id);
        if (destination === 'Memory') {
          // The brain is a canvas: the host reports what it draws, and the findings list is its text twin.
          const brain = page.locator('.brain-canvas');
          await brain.waitFor();
          await page.waitForFunction(
            () => document.querySelector('.brain-canvas')?.getAttribute('data-nodes') === '24',
          );
          if (!(await page.locator('.memory-list').count()))
            await page.getByRole('button', { name: 'Findings list', exact: true }).click();
          await page.locator('.memory-list-row').first().click();
          await page.getByRole('heading', { name: 'Links & backlinks' }).waitFor();
          await page.getByRole('button', { name: 'Local graph', exact: true }).click();
          await page.waitForFunction(
            () => Number(document.querySelector('.brain-canvas')?.getAttribute('data-nodes')) <= 3,
          );
          await page.getByRole('button', { name: 'Local graph', exact: true }).click();
          await page.waitForFunction(
            () => document.querySelector('.brain-canvas')?.getAttribute('data-nodes') === '24',
          );
          // Names switch: hide and show the names on the graph without touching any record.
          await page.getByRole('button', { name: 'Names', exact: true }).click();
          assert.equal(await brain.getAttribute('data-names'), 'off');
          await page.getByRole('button', { name: 'Names', exact: true }).click();
          assert.equal(await brain.getAttribute('data-names'), 'on');
          // Keyboard: arrows step through the findings.
          await brain.focus();
          const before = await brain.getAttribute('data-selected');
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(
            before => document.querySelector('.brain-canvas')?.getAttribute('data-selected') !== before,
            before,
          );
          const box = await brain.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          const zoom = await brain.getAttribute('data-zoom');
          await page.mouse.wheel(0, -240);
          await page.waitForFunction(
            zoom => document.querySelector('.brain-canvas')?.getAttribute('data-zoom') !== zoom,
            zoom,
          );
          await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
        }
        if (destination === 'Settings') {
          const rail = page.getByRole('navigation', { name: 'Settings sections' });
          await rail.getByRole('button', { name: 'Appearance', exact: true }).click();
          await page.getByRole('radiogroup', { name: 'Theme', exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Create backup', exact: true }).isVisible(), false);
          await rail.getByRole('button', { name: /^Agent isolation/ }).click();
          await page.getByText('Not set up', { exact: true }).first().waitFor();
          await rail.getByRole('button', { name: 'Data & recovery', exact: true }).click();
          await page.getByRole('button', { name: 'Create backup', exact: true }).waitFor();
          await rail.getByRole('button', { name: /^Connections/ }).click();
        }
        assert.equal(
          await page.evaluate(() => document.body.scrollWidth <= innerWidth),
          true,
          `${destination} overflow at ${theme}/${width}`,
        );
        await page.screenshot({ path: `test-output/ui-revision-${destination.toLowerCase()}-${theme}-${width}.png` });
      }
    }
  }
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Go to…' });
  await palette.waitFor();
  await palette.getByLabel('Find a page, project, or request').fill('Memory');
  await palette.getByRole('button', { name: 'Memory', exact: true }).click();
  await palette.waitFor({ state: 'hidden' });
  await page.locator('.memory-layout').waitFor();
  checks.push('Palette keyboard navigation and return');
  await page.getByRole('button', { name: 'Artifacts', exact: true }).first().click();
  const csv = path.join(data, 'fixture.csv');
  await writeFile(csv, 'name,value\n"a,b",42\n<script>,3');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, csv);
  await page.getByRole('button', { name: 'Import references', exact: true }).click();
  await page.getByText('fixture.csv', { exact: true }).waitFor();
  await page.locator('.file-row').first().click();
  await page.getByRole('cell', { name: 'a,b', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => Boolean((window as any).injected)), false);
  await page.screenshot({ path: 'test-output/ui-revision-artifacts-csv.png' });
  await page.getByLabel('Search files or agents').fill('no-such-file');
  await page.getByText('No files match these filters.').waitFor();
  await page.getByLabel('Search files or agents').fill('');
  checks.push(
    '24 linked findings, local graph, keyboard selection, pointer zoom, themed responsive pages, CSV inline preview and source search',
  );
  await page.getByRole('button', { name: 'Office', exact: true }).first().click();
  await page.evaluate(async () => {
    // A walk is either a Web Animation on a flat-floor person or the 3D floor marking a person as
    // walking; neither may start when nobody's location changed.
    const original = Element.prototype.animate;
    (window as any).uiWalks = 0;
    Element.prototype.animate = function (...args: Parameters<Element['animate']>) {
      if (this.hasAttribute('data-office-agent')) (window as any).uiWalks++;
      return original.apply(this, args);
    };
    new MutationObserver(records => {
      for (const r of records)
        if ((r.target as HTMLElement).getAttribute('data-motion') === 'walking') (window as any).uiWalks++;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-motion'] });
    document.querySelector('main')?.scrollTo(0, 350);
    const state = await window.office.getState();
    await window.office.command({
      type: 'settings.update',
      idempotencyKey: crypto.randomUUID(),
      settings: { ...state.settings, reducedMotion: false },
    });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  assert.equal(
    await page.evaluate(() => (window as any).uiWalks),
    0,
    'scroll plus state update never walks agents whose room did not change',
  );
  checks.push('Scroll plus state change does not animate unchanged agent locations');
  await page.locator('[data-office-agent]').first().click();
  const drawer = page.getByRole('complementary', { name: 'Test dir 1 details' });
  await drawer.waitFor();
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .locator('[data-office-agent]')
      .first()
      .evaluate(e => e === document.activeElement),
    true,
  );
  checks.push('Agent drawer Escape and return focus');
  assert.deepEqual(errors, []);
  await writeFile(
    'test-output/ui-revision-acceptance-report.json',
    JSON.stringify(
      {
        status: 'PASS',
        data,
        packaged: !!process.env.QRO_EXECUTABLE,
        providerCalls: 0,
        roster: 'Test dir 1, Test PM A–D, Test worker 1 — fixture-unverified/default; no agents executed',
        checks,
      },
      null,
      2,
    ),
  );
  console.log('UI revision populated desktop acceptance passed.');
} catch (e) {
  const page = await app.firstWindow();
  console.log(await page.locator('body').innerText());
  await page.screenshot({ path: 'test-output/ui-revision-failure.png' });
  throw e;
} finally {
  await app.close();
}
