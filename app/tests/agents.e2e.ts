import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// Explicit opt-in integration test. Reuses existing Codex subscription login; no prompts or paid calls.
const root = process.cwd(),
  data = await mkdtemp(path.join(tmpdir(), 'qro-agents-ui-'));
await mkdir(path.join(root, 'test-output'), { recursive: true });
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const app = await electron.launch({
  args: process.env.QRO_EXECUTABLE ? [] : [root],
  ...(process.env.QRO_EXECUTABLE ? { executablePath: process.env.QRO_EXECUTABLE } : {}),
  env: { ...launchEnvironment, QRO_USER_DATA_DIR: data },
});
try {
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Add agent', exact: true }).click();
    await page.getByLabel('Provider', { exact: true }).selectOption('openai');
    await page.getByLabel('Execution environment', { exact: true }).selectOption('HOSTED_SETUP_REQUIRED');
    await page.getByLabel('Agent name', { exact: true }).fill('Test Director ' + (i + 1));
    await page.getByLabel('Section / team', { exact: true }).fill(i === 0 ? 'Signals' : 'Risk');
    await page.getByLabel('Role', { exact: true }).selectOption('DIRECTOR');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).waitFor({ timeout: 60000 });
    assert.equal((await page.evaluate(() => window.office.getState())).agents.length, i);
    await page.screenshot({ path: path.join(root, 'test-output', 'agent-confirmation.png') });
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  }
  let state = await page.evaluate(() => window.office.getState());
  assert.equal(state.agents.length, 2);
  assert.equal(
    state.agents.every(a => a.execution === 'HOSTED_SETUP_REQUIRED'),
    true,
  );
  assert.equal(await page.locator('.office-person').count(), 2);
  await page.screenshot({ path: path.join(root, 'test-output', 'agents-office.png') });
  await page.locator('.office-person').first().click();
  await page.getByRole('button', { name: 'Full profile & logs', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Test Director 1', exact: true });
  await detail.waitFor();
  await detail.getByRole('button', { name: 'Refresh effort options', exact: true }).click();
  await detail.getByText('Options read from the provider model catalog.', { exact: true }).waitFor();
  await detail.getByLabel('Agent effort level', { exact: true }).selectOption('high');
  await detail.getByRole('button', { name: 'Save effort', exact: true }).click();
  await detail
    .getByText('Effort saved for the next provider request. Existing work is not restarted.', { exact: true })
    .waitFor({ timeout: 60000 });
  state = await page.evaluate(() => window.office.getState());
  assert.equal(state.agents[0].effort, 'high');
  const logFile = path.join(data, 'exchange.jsonl');
  await writeFile(
    logFile,
    JSON.stringify({
      format: 'qro-log-v1',
      conversationId: 'review-example',
      messageId: 'example-message',
      from: state.agents[0].id,
      to: state.agents[1].id,
      kind: 'MESSAGE',
      text: 'Fixture review request <script>window.injected=true</script>',
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, logFile);
  await detail.getByRole('button', { name: 'Import transcript', exact: true }).click();
  await detail.getByText(/Imported 1 entries/).waitFor();
  await detail.getByLabel('Log view', { exact: true }).selectOption('between');
  await detail.getByText('Fixture review request <script>window.injected=true</script>', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => Boolean((window as any).injected)), false);
  await page.screenshot({ path: path.join(root, 'test-output', 'agent-work-log.png') });
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByLabel('Subject', { exact: true }).selectOption(state.agents[1].id);
  await page.getByLabel('Other participant', { exact: true }).selectOption(state.agents[0].id);
  await page.getByLabel('Record view', { exact: true }).selectOption('between');
  await page
    .getByText('Fixture review request <script>window.injected=true</script>', { exact: true })
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  const transcripts = path.join(data, 'transcripts');
  await mkdir(transcripts);
  const record = {
    type: 'assistant',
    sessionId: 'fixture-session',
    timestamp: new Date().toISOString(),
    message: {
      id: 'fixture-message',
      model: 'fixture-opus',
      usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 6, cache_creation_input_tokens: 7 },
    },
  };
  await writeFile(
    path.join(transcripts, 'session.jsonl'),
    JSON.stringify(record) + '\n' + JSON.stringify(record) + '\n',
  );
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, transcripts);
  await page.getByRole('button', { name: 'Choose transcript folder', exact: true }).click();
  await page
    .getByText(
      '1 files · 1 sessions · 1 duplicate response records consolidated · 0 skipped files/directories · 0 unusable records',
      { exact: true },
    )
    .waitFor();
  await page.getByText('Last 5 hours (rolling)', { exact: true }).waitFor();
  await page.getByText('Last 5 hours (rolling)', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'test-output', 'local-consumption.png') });
  await page.getByRole('button', { name: 'Refresh usage', exact: true }).first().click();
  await page
    .getByText(/% remaining/)
    .first()
    .waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(root, 'test-output', 'subscription-usage.png') });
  await writeFile(
    path.join(root, 'test-output', 'agents-report.json'),
    JSON.stringify(
      {
        status: 'PASS',
        packaged: !!process.env.QRO_EXECUTABLE,
        timestamp: new Date().toISOString(),
        checks: [
          'real Codex metadata',
          'Add does not persist',
          'Confirm persists',
          'multiple Directors',
          'team names',
          'dynamic office desks',
          'real subscription usage',
          'editable effort',
          'desk-click logs',
          'safe transcript import',
          'between-agent conversations',
          'local token reconstruction',
        ],
        researchCalls: 0,
      },
      null,
      2,
    ),
  );
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Archive agent', exact: true }).first().click();
  await page.getByLabel('Membership').selectOption('archived');
  await page.getByRole('button', { name: 'Restore agent', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Office', exact: true }).click();
  assert.equal(await page.locator('.office-person').count(), 1);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByLabel('Membership').selectOption('archived');
  await page.getByRole('button', { name: 'Restore agent', exact: true }).click();
  await page.getByRole('button', { name: 'Office', exact: true }).click();
  assert.equal(await page.locator('.office-person').count(), 2);
  console.log('Agent confirmation, removal/restoration and real Codex usage checks passed. No research calls.');
} finally {
  await app.close();
}
