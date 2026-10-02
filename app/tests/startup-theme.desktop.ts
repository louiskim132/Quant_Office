/**
 * First-launch theme check on an empty scratch data folder with a dark workspace and no
 * `window-theme` file (the first launch after this update). Samples the window from the main
 * process every few ms: the first visible sample must already be dark, and the page's first
 * `data-theme` must be dark before the page has stored a theme of its own. Then relaunches
 * (remembered: visible at once, dark), switches to Light, relaunches (light from the start).
 * usage (from app/): pnpm exec tsx tests/startup-theme.desktop.ts [packaged exe]; without one it runs the dev build in dist/
 */
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';

const exe = process.argv[2];
const data = await mkdtemp(path.join(tmpdir(), 'qro-firstlaunch-'));
await mkdir(path.join(data, 'workspace'));
const store = new OfficeStore(path.join(data, 'workspace', 'workspace.sqlite'));
const now = new Date().toISOString();
store.addAgent({
  id: randomUUID(),
  name: 'Test dir 1',
  role: 'DIRECTOR',
  team: 'Theme check',
  provider: 'devin',
  model: 'swe-2-max',
  effort: 'default',
  account: 'fixture@example.test',
  execution: 'HOSTED_SETUP_REQUIRED',
  createdAt: now,
  connectionVerifiedAt: now,
  instructions: 'Theme check fixture; never dispatch.',
});
store.execute({
  type: 'settings.update',
  idempotencyKey: randomUUID(),
  settings: { ...store.snapshot().settings, theme: 'dark' },
} as never);
store.close();
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const themeFile = () => readFile(path.join(data, 'window-theme'), 'utf8').catch(() => '(none)');
const result: Record<string, unknown> = { data };
type Sample = { t: number; visible: boolean; bg: string; url: string };

async function launch(label: string) {
  const t0 = Date.now();
  const app = await electron.launch(
    exe
      ? { executablePath: exe, env: { ...env, QRO_USER_DATA_DIR: data } }
      : { args: [process.cwd()], env: { ...env, QRO_USER_DATA_DIR: data } },
  );
  const samples: Sample[] = [];
  let firstVisible: Sample | undefined;
  for (;;) {
    const s = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w
        ? { visible: w.isVisible(), bg: w.getBackgroundColor(), url: w.webContents.getURL().split('/').pop() ?? '' }
        : null;
    });
    if (s) {
      const sample = { t: Date.now() - t0, ...s };
      samples.push(sample);
      if (s.visible && !firstVisible) firstVisible = sample;
      if (firstVisible && /^index/.test(s.url)) break;
    }
    if (Date.now() - t0 > 60000) throw new Error(`${label}: window never reached the page`);
    await new Promise(r => setTimeout(r, 5));
  }
  const page = (await app.windows())[0];
  await page.waitForLoadState('domcontentloaded');
  const firstTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('.office3d')?.getAttribute('data-ready') === 'true', null, {
    timeout: 60000,
  });
  const visibleWhileHidden = samples.filter(s => !s.visible).map(s => s.url);
  result[label] = {
    firstVisible,
    hiddenSamplesUrls: [...new Set(visibleWhileHidden)],
    visibleBackgrounds: [...new Set(samples.filter(s => s.visible).map(s => s.bg))],
    visibleUrls: [...new Set(samples.filter(s => s.visible).map(s => s.url))],
    pageFirstTheme: firstTheme,
    themeFile: await themeFile(),
  };
  return { app, page };
}

// 1. First launch: dark workspace, nothing remembered.
let { app, page } = await launch('first');
result['first.storedPageTheme'] = await page.evaluate(() => localStorage.getItem('qro.theme'));
await app.close();
// 2. Relaunch: remembered dark, visible at once.
({ app, page } = await launch('second'));
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page
  .getByRole('button', { name: /^Appearance/ })
  .click()
  .catch(() => {});
await page
  .getByRole('radio', { name: 'Light' })
  .or(page.getByRole('button', { name: 'Light', exact: true }))
  .first()
  .click();
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
await page.waitForTimeout(400);
result['second.themeFileAfterSwitch'] = await themeFile();
await app.close();
// 3. Relaunch: light from the start.
({ app, page } = await launch('third'));
await app.close();
const log = await readFile(path.join(data, 'logs', 'main.log'), 'utf8').catch(() => '');
result.startupLines = log
  .split(/\r?\n/)
  .filter(l => / startup window=/.test(l))
  .map(l => l.replace(/^.*?startup /, ''));
const DARK = '#171614',
  LIGHT = '#f1f0e9';
const view = (label: string) =>
  result[label] as {
    firstVisible: Sample;
    hiddenSamplesUrls: string[];
    visibleBackgrounds: string[];
    pageFirstTheme: string;
    themeFile: string;
  };
const lower = (list: string[]) => list.map(c => c.toLowerCase());
try {
  // First launch: hidden until the workspace's theme is known, then dark from the first visible frame.
  assert.deepEqual(lower(view('first').visibleBackgrounds), [DARK]);
  assert.equal(view('first').pageFirstTheme, 'dark');
  assert.equal(view('first').themeFile, 'dark');
  // Remembered: visible from the first sample, dark throughout.
  assert.deepEqual(view('second').hiddenSamplesUrls, []);
  assert.deepEqual(lower(view('second').visibleBackgrounds), [DARK]);
  assert.equal(result['second.themeFileAfterSwitch'], 'light');
  // After switching: light from the start.
  assert.deepEqual(view('third').hiddenSamplesUrls, []);
  assert.deepEqual(lower(view('third').visibleBackgrounds), [LIGHT]);
  assert.equal(view('third').pageFirstTheme, 'light');
  // The log says when each window was shown: the first launch waited for the workspace (the sampler
  // above can start too late to see the hidden phase), the later ones showed at once.
  const lines = result.startupLines as string[];
  assert.equal(lines.length, 3);
  assert.match(lines[0], /theme=dark shown=(page|[1-9]\d*ms)$/);
  assert.match(lines[1], /theme=dark shown=0ms$/);
  assert.match(lines[2], /theme=light shown=0ms$/);
} finally {
  console.log(JSON.stringify(result, null, 1));
}
console.log(
  `PASS ${exe ? 'packaged' : 'dev'}: first launch waits for the workspace theme (dark), later launches show at once in the remembered theme.`,
);
