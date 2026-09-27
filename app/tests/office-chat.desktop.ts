import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
import type { Agent, Message } from '../src/shared/types';

const data = await mkdtemp(path.join(tmpdir(), 'qro-office-chat-'));
await mkdir(path.join(data, 'workspace'));
await mkdir('test-output', { recursive: true });
const store = new OfficeStore(path.join(data, 'workspace', 'workspace.sqlite'));
const now = new Date().toISOString();
const agents: Agent[] = ['DIRECTOR', 'PM_A', 'WORKER'].map((role, i) => ({
  id: randomUUID(),
  name: ['Avery · Director', 'Morgan · PM', 'Riley · Worker'][i],
  role: role as Agent['role'],
  provider: 'claude',
  model: 'fixture',
  team: 'Research',
  instructions: '',
  account: 'fixture@example.test',
  execution: 'LOCAL',
  createdAt: now,
  connectionVerifiedAt: now,
}));
agents.forEach(agent => store.addAgent(agent));
const project = store.execute({
  type: 'project.create',
  idempotencyKey: randomUUID(),
  name: 'Research workspace',
  mandate: 'Synthetic office chat acceptance',
  budgetCents: 0,
}).projects[0];
const empty = store
  .execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Quiet project',
    mandate: 'Empty scope',
    budgetCents: 0,
  })
  .projects.find(p => p.name === 'Quiet project')!;
const request = store.execute({
  type: 'request.create',
  idempotencyKey: randomUUID(),
  projectId: project.id,
  name: 'Prepare the next handoff',
  hypothesis: 'Synthetic office acceptance',
  workType: 'QUESTION',
  mode: 'SINGLE',
  leadAgentId: agents[0].id,
  participantIds: [],
}).requests![0];
for (let i = 0; i < 65; i++) {
  const text =
    i === 62
      ? 'Let’s keep this focused: review the plan, then prepare a small worker task. Share any blockers here.'
      : i === 63
        ? 'I’ve reviewed the director’s plan. Riley, please prepare the handoff and include the source references.'
        : i === 64
          ? 'The handoff is ready. I checked the references and documented the remaining question. <img src=x onerror=alert(1)>'
          : `Planning update ${i + 1}: checking the scope and keeping the team informed.`;
  const sender = i >= 62 ? i - 62 : i % 3;
  const message: Message = {
    id: randomUUID(),
    projectId: project.id,
    requestId: request.id,
    assignmentId: null,
    fromAgentId: agents[sender].id,
    toAgentId: agents[(sender + 1) % 3].id,
    kind: 'HANDOFF',
    body: text,
    scopeSnapshotId: null,
    scopeOutputHashes: [],
    sentAt: new Date(Date.now() - (65 - i) * 60000).toISOString(),
    deliveredAt: '',
    receipt: '',
    evidence: 'PROVIDER_REPORTED',
  };
  store.recordMessage(message);
}
store.close();
const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
const application = await electron.launch({ args: [process.cwd()], env: { ...env, QRO_USER_DATA_DIR: data } });
try {
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1050));
  const chat = page.getByRole('region', { name: 'Office group chat' });
  await chat.getByText(/The handoff is ready/).waitFor();
  assert.equal(await chat.locator('.office-chat-message').count(), 50);
  assert.equal(await chat.locator('img').count(), 0, 'agent text is not rendered as HTML');
  assert.ok(await chat.getByText('view only', { exact: false }).isVisible());
  const bounds = await page.evaluate(() => ({
    scene: document.querySelector('.sky-office')!.getBoundingClientRect().toJSON(),
    chat: document.querySelector('.office-chat')!.getBoundingClientRect().toJSON(),
  }));
  assert.ok(bounds.chat.x >= bounds.scene.right, 'chat sits next to the agents at desktop width');
  await page.screenshot({ path: 'test-output/office-group-chat.png', fullPage: true });
  await chat.getByRole('button', { name: 'Load earlier updates' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.office-chat-message').length === 65);
  assert.equal(await chat.getByRole('button', { name: 'Load earlier updates' }).count(), 0);
  await chat.getByRole('button', { name: 'Refresh office chat' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.office-chat-message').length === 50);
  await chat.getByLabel('Chat participant').selectOption(agents[0].id);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.office-chat-message').length > 0 &&
      document.querySelectorAll('.office-chat-message').length < 50,
  );
  assert.ok(
    (await page.evaluate(id => window.office.officeChatPage({ agentId: id }), agents[0].id)).entries.every(
      e => e.agentId === agents[0].id || e.toAgentId === agents[0].id,
    ),
  );
  await chat.getByLabel('Chat project').selectOption(empty.id);
  await chat.getByText('No recorded updates match these filters.').waitFor();
  assert.equal(await chat.locator('.office-chat-message').count(), 0);
  await chat.getByLabel('Chat participant').selectOption('');
  await chat.getByLabel('Chat project').selectOption(project.id);
  await chat.getByText(/The handoff is ready/).waitFor();
  await assert.rejects(
    page.evaluate(() => window.office.officeChatPage({ limit: 1000 })),
    /Invalid desktop request/,
  );
  await assert.rejects(page.evaluate(() => window.office.officeChatPage({ execute: 'anything' } as never)));
  await assert.rejects(
    page.evaluate(() => window.office.officeChatPage({ cursor: '{invalid' })),
    /cursor/i,
  );
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800));
  await page.waitForFunction(
    () =>
      document.querySelector('.office-chat')!.getBoundingClientRect().top >=
      document.querySelector('.sky-office')!.getBoundingClientRect().bottom,
  );
  assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await writeFile(
    'test-output/office-chat-desktop-report.json',
    JSON.stringify(
      {
        status: 'PASS',
        fixtureOnly: true,
        checks: [
          'adjacent desktop layout',
          'chronological agent bubbles',
          'safe text rendering',
          'older-page retrieval',
          'refresh deduplication',
          'project and participant filters',
          'empty scope',
          'IPC validation',
          'responsive stacked layout',
        ],
        data,
      },
      null,
      2,
    ),
  );
  console.log('Office group chat desktop checks passed.');
} catch (e) {
  try {
    await (await application.firstWindow()).screenshot({ path: 'test-output/office-chat-failure.png', fullPage: true });
  } catch {}
  throw e;
} finally {
  await application.close();
}
