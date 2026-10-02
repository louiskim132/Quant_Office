import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const data = await mkdtemp(path.join(tmpdir(), 'qro-isolation-acp-ui-'));
const output = path.resolve(process.argv[2] || 'test-output/isolation-acp-ui');
await mkdir(output, { recursive: true });
const { ELECTRON_RUN_AS_NODE: _node, ...env } = process.env;
const app = await electron.launch({
  executablePath: process.env.QRO_EXECUTABLE!,
  args: [],
  env: { ...env, QRO_USER_DATA_DIR: data, QRO_AGENT_ISOLATION: 'off' },
});
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByLabel('Provider', { exact: true }).selectOption('devin');
  await page.getByLabel('Local transport').selectOption('LOCAL_ACP');
  assert.equal(await page.getByLabel('Local transport').inputValue(), 'LOCAL_ACP');
  await page.getByText(/I understand that this agent runs unattended/).waitFor();
  await page.getByLabel('Provider', { exact: true }).selectOption('claude');
  assert.equal(await page.getByLabel('Local transport').inputValue(), 'LOCAL_CLI_EXEC');
  assert.equal(await page.getByLabel('Local transport').locator('option[value="LOCAL_ACP"]').count(), 0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const rail = page.getByRole('navigation', { name: 'Settings sections' });
  await rail.getByRole('button', { name: /^Agent isolation/ }).click();
  await page.getByText('Needs the QRO-Agent account first', { exact: true }).waitFor();
  assert.equal(await page.getByText(/needs saved API keys/).count(), 0);
  const refused = await page.evaluate(async () => {
    try {
      await window.office.agentIsolationLogin('devin');
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(refused, true, 'real main handler refuses a login without configured credentials');
  // UI fixture only: no account, password, ACL, login or provider acceptance is manufactured.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('office:agent-isolation-status');
    ipcMain.handle('office:agent-isolation-status', () => ({ ok: true, value: { configured: true } }));
  });
  // Settings reads the status once; reload so it reads the fixture.
  await page.reload();
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await rail.getByRole('button', { name: /^Agent isolation/ }).click();
  await page
    .getByText('Agent isolation is set up. New agent launches now run as the QRO-Agent account.', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.iso-providers').getByText('Not checked', { exact: true }).count(), 3);
  for (const provider of ['devin', 'claude', 'openai']) {
    await page.getByRole('button', { name: `Sign in ${provider} for agent account`, exact: true }).waitFor();
    await page.getByRole('button', { name: `Check ${provider} agent subscription`, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'Sign in devin for agent account', exact: true }).click();
  await page.getByText(/Set up agent isolation first/).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'configured-ui-fixture.png'), fullPage: true });
  await writeFile(
    path.join(output, 'acceptance.json'),
    JSON.stringify(
      {
        status: 'PASS',
        data,
        scope: 'PACKAGED_UI_AND_UNCONFIGURED_IPC_REFUSAL',
        configuredView: 'UI_FIXTURE_ONLY',
        realAccountAcceptance: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
  console.log('PASS isolation/ACP packaged UI');
} finally {
  await app.close();
}
