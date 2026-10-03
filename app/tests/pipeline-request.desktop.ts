import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store.js';

// The request form's three-way work type: PLANNING and RESULT_ANALYSIS pick a director and record
// briefing pipeline state; OTHER keeps the generic single/group/team controls. Seeded agents are
// inert fixtures — no provider is contacted anywhere in this check.
const root = process.cwd();
const data = await mkdtemp(path.join(tmpdir(), 'qro-pipeline-request-'));
await mkdir(path.join(data, 'workspace'));
const seed = new OfficeStore(path.join(data, 'workspace', 'workspace.sqlite'));
try {
  for (const agent of [
    { name: 'Director Ada', role: 'DIRECTOR' },
    { name: 'Worker Will', role: 'WORKER' },
  ] as const)
    seed.addAgent({
      id: randomUUID(),
      ...agent,
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      instructions: '',
      account: `${agent.role.toLowerCase()}@example.invalid`,
      createdAt: new Date().toISOString(),
      connectionVerifiedAt: new Date().toISOString(),
      execution: 'HOSTED_SETUP_REQUIRED',
    });
} finally {
  seed.close();
}
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const application = await electron.launch({
  args: process.env.QRO_EXECUTABLE ? [] : [root],
  ...(process.env.QRO_EXECUTABLE ? { executablePath: process.env.QRO_EXECUTABLE } : {}),
  env: { ...launchEnvironment, QRO_USER_DATA_DIR: data },
  timeout: 30000,
});
const page = await application.firstWindow();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const projectDialog = page.getByRole('dialog', { name: 'Create a project' });
  await projectDialog.getByLabel('Project name').fill('Pipeline office');
  await projectDialog.getByLabel('Research mandate').fill('Exercise the pipeline request flow.');
  const projectFolder = await mkdtemp(path.join(tmpdir(), 'qro-pipeline-project-'));
  await application.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, projectFolder);
  await projectDialog.locator('.browse-field').click();
  await projectDialog.getByText(projectFolder, { exact: true }).waitFor();
  await projectDialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await projectDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Office', exact: true }).click();
  await page.getByRole('button', { name: 'New request', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New request' });
  const workType = dialog.getByLabel('Work type');
  await workType.waitFor();
  assert.deepEqual(
    await workType
      .locator('option')
      .evaluateAll(items => items.map(item => ({ value: (item as HTMLOptionElement).value, label: item.textContent }))),
    [
      { value: 'PLANNING', label: 'Planning' },
      { value: 'RESULT_ANALYSIS', label: 'Result analysis' },
      { value: 'OTHER', label: 'Other' },
    ],
    'the form offers exactly the three work types',
  );
  // A pipeline work type shows the director seat and the briefing hint, never the generic controls.
  assert.equal(await dialog.getByLabel('Execution mode').count(), 0);
  assert.equal(await dialog.getByLabel('Responsible agent').count(), 0);
  assert.equal(await dialog.getByLabel('Collaborators').count(), 0);
  const director = dialog.getByLabel('Director');
  await director.waitFor();
  assert.match(await dialog.innerText(), /director shapes the brief first/i);
  const directorOptions = await director.locator('option').evaluateAll(items => items.map(item => item.textContent));
  assert.ok(
    directorOptions.some(label => label?.includes('Director Ada')),
    'the DIRECTOR-role agent is offered',
  );
  assert.ok(
    !directorOptions.some(label => label?.includes('Worker Will')),
    'non-director agents stay out of the director list while one exists',
  );
  await workType.selectOption('RESULT_ANALYSIS');
  assert.equal(await dialog.getByLabel('Execution mode').count(), 0);
  assert.equal(await dialog.getByLabel('Responsible agent').count(), 0);
  assert.equal(await dialog.getByLabel('Director').count(), 1);
  // Other restores the generic request controls unchanged.
  await workType.selectOption('OTHER');
  await dialog.getByLabel('Execution mode').waitFor();
  await dialog.getByLabel('Responsible agent').waitFor();
  assert.deepEqual(
    await dialog
      .getByLabel('Execution mode')
      .locator('option')
      .evaluateAll(items => items.map(item => (item as HTMLOptionElement).value)),
    ['SINGLE', 'GROUP', 'TEAM'],
  );
  assert.equal(await dialog.getByLabel('Collaborators').count(), 0, 'collaborators stay hidden in single mode');
  await dialog.getByLabel('Execution mode').selectOption('GROUP');
  await dialog.getByLabel('Collaborators').waitFor();
  await workType.selectOption('PLANNING');
  await dialog.getByLabel('Request name').fill('Plan the volatility baseline');
  await dialog.getByLabel('Objective').fill('Shape the baseline plan before arming the pipeline.');
  await director.selectOption({ label: 'Director Ada · DIRECTOR' });
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const state = await page.evaluate(() => window.office.getState());
  const request = state.requests![0];
  assert.equal(request.workType, 'PLANNING');
  assert.equal(request.mode, 'SINGLE', 'pipeline requests record a single seat; arms are minted separately');
  assert.deepEqual(request.participantIds, []);
  assert.equal(request.pipeline?.kind, 'PLANNING');
  assert.equal(request.pipeline?.phase, 'BRIEFING');
  assert.equal(request.pipeline?.briefAssignmentId, null);
  assert.equal(request.leadAgentId, state.agents.find(agent => agent.name === 'Director Ada')!.id);
  await page.locator('.queue-row').first().click();
  const card = page
    .getByRole('complementary', { name: `Request: ${request.name}` })
    .locator('.task-card')
    .first();
  await card.getByText(/Director brief/).waitFor();
  assert.match(await card.innerText(), /Director brief/, 'the briefing surface shows while the request is briefing');
  const launch = card.getByRole('button', { name: 'Launch pipeline', exact: true });
  assert.equal(await launch.isDisabled(), true, 'launch stays gated until the director brief completes');
  // Manual dispatch is never offered on a pipeline request: the card renders pipeline status text.
  await card.getByText('Participants and acceptance criteria').click();
  assert.match(await card.innerText(), /Manual preparation is not offered on pipeline requests/);
  assert.equal(await card.getByRole('button', { name: /Prepare/ }).count(), 0);
  assert.equal(await card.getByRole('button', { name: /handoff/i }).count(), 0);
  assert.deepEqual(errors, []);
  await mkdir('test-output', { recursive: true });
  await writeFile(
    path.join('test-output', 'pipeline-request-desktop-report.json'),
    JSON.stringify(
      {
        status: 'PASS',
        at: new Date().toISOString(),
        checks: [
          'three work type options',
          'pipeline director seat and hint',
          'other restores generic controls',
          'planning request records briefing pipeline',
          'queue card briefing surface',
          'no manual dispatch on pipeline requests',
        ],
        workspace: data,
      },
      null,
      2,
    ),
  );
  console.log('Pipeline request desktop checks passed.');
} finally {
  await application.close();
}
