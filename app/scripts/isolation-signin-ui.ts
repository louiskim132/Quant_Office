/** User-assisted real-account acceptance. Provider authentication stays in official windows. */
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
mkdirSync(root, { recursive: true });
const data = path.join(root, 'userData'),
  action = path.join(root, 'action.json');
const { ELECTRON_RUN_AS_NODE: _node, QRO_AGENT_ISOLATION: _isolation, ...env } = process.env;
const app = await electron.launch({
  executablePath: path.join(root, 'app', 'Quant Research Office.exe'),
  args: [],
  env: { ...env, QRO_USER_DATA_DIR: data },
});
const page = await app.firstWindow();
await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
    if (input.op === 'close') await app.close();
  })()
    .catch(error => writeFileSync(path.join(root, 'action-error.txt'), String(error)))
    .finally(() => {
      processing = false;
    });
}, 500);
app.on('close', () => clearInterval(timer));
await new Promise<void>(resolve => app.on('close', () => resolve()));
