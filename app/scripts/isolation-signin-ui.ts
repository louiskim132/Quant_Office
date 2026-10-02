/** User-assisted real-account acceptance. Provider authentication stays in official windows. */
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { OfficeAPI } from '../src/shared/types.js';
import { dispatchAcceptance } from './isolation-dispatch-acceptance.js';
// dispatch requires .qro-isolation-acceptance.json at root:
// {"version":1,"purpose":"SYNTHETIC_ISOLATION_ACCEPTANCE"}. Profiles must already be signed in,
// bound through the official UI, and use the standard Test dir/PM/worker names. A dispatch action
// is explicit authorization for synthetic provider calls: {"op":"dispatch","provider":"openai"}.
// No dispatch runs automatically at startup or while waiting for official sign-ins.
const root = path.resolve(process.argv[2]);
mkdirSync(root, { recursive: true });
const data = path.join(root, 'userData'),
  action = path.join(root, 'action.json');
const { ELECTRON_RUN_AS_NODE: _node, QRO_AGENT_ISOLATION: _isolation, ...env } = process.env;
let app = await electron.launch({
  executablePath: path.join(root, 'app', 'Quant Research Office.exe'),
  args: [],
  env: { ...env, QRO_USER_DATA_DIR: data },
});
let page = await app.firstWindow();
await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page
  .getByRole('navigation', { name: 'Settings sections' })
  .getByRole('button', { name: /^Agent isolation/ })
  .click();
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].show();
  BrowserWindow.getAllWindows()[0].focus();
});
const status = await page.evaluate(() => window.office.agentIsolationStatus());
writeFileSync(
  path.join(root, 'ready.json'),
  JSON.stringify({ data, configured: status.configured, stage: 'USER_SETUP_AND_OFFICIAL_SIGNINS' }),
);
if (!status.configured) await page.getByRole('button', { name: 'Set up agent isolation', exact: true }).click();
let processing = false;
let restarting = false;
let closed: () => void;
const finished = new Promise<void>(resolve => {
  closed = resolve;
});
const onClose = () => {
  if (!restarting) {
    clearInterval(timer);
    closed();
  }
};
const api = () =>
  new Proxy({} as OfficeAPI, {
    get:
      (_target, method: string) =>
      async (...args: unknown[]) =>
        page.evaluate(
          async ({ method, args }) => {
            const bridge = window.office as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
            return bridge[method](...args);
          },
          { method, args },
        ),
  });
const restart = async () => {
  restarting = true;
  try {
    await app.close();
    app = await electron.launch({
      executablePath: path.join(root, 'app', 'Quant Research Office.exe'),
      args: [],
      env: { ...env, QRO_USER_DATA_DIR: data },
    });
    page = await app.firstWindow();
    await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
    app.on('close', onClose);
  } finally {
    restarting = false;
  }
};
const timer = setInterval(() => {
  if (processing || !existsSync(action)) return;
  processing = true;
  void (async () => {
    const input = JSON.parse(readFileSync(action, 'utf8'));
    unlinkSync(action);
    if (input.op === 'check') {
      const status = await page.evaluate(() => window.office.agentIsolationStatus());
      const report: Record<string, unknown> = { status };
      if (status.configured) {
        report.isolation = await page.evaluate(() => window.office.agentIsolationVerify());
        for (const provider of ['devin', 'claude', 'openai'] as const) {
          try {
            report[provider] = await page.evaluate(p => window.office.connectionStatus(p), provider);
          } catch (error) {
            report[provider] = { error: String(error) };
          }
        }
      }
      writeFileSync(path.join(root, 'checks.json'), JSON.stringify(report, null, 2));
    }
    if (input.op === 'login' && ['devin', 'claude', 'openai'].includes(input.provider))
      await page.evaluate(p => window.office.agentIsolationLogin(p), input.provider);
    if (input.op === 'dispatch') {
      if (!['devin', 'claude', 'openai'].includes(input.provider)) throw new Error('Unknown dispatch provider.');
      await dispatchAcceptance({ root, provider: input.provider, agentName: input.agentName, api, restart });
    }
    if (input.op === 'close') await app.close();
  })()
    .catch(error => writeFileSync(path.join(root, 'action-error.txt'), String(error)))
    .finally(() => {
      processing = false;
    });
}, 500);
app.on('close', onClose);
await finished;
