/** Packaged user-level B4 acceptance on synthetic data, with no provider dispatch. */
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, key } from './fixtures/pipeline';

const f = await fixture({ after: () => {} }, undefined, false, { clock: () => new Date().toISOString() });
const input = await f.stageInputs({
  projectId: f.project.id,
  requestId: f.request.id,
  requestRevision: f.request.revision,
  objective: f.request.objective,
});
const { assignment } = f.controller.prepare({ requestId: f.request.id, agentId: f.principal.id, snapshotId: input.id });
const job = f.store.snapshot({ history: false }).jobs!.find(j => j.assignmentId === assignment.id)!;
const started = Date.now();
f.store.recordJobEvents(
  job.id,
  Array.from({ length: 125 }, (_, i) => ({
    externalId: `paging-${i}`,
    cursor: String(i),
    kind: 'MESSAGE' as const,
    text: `Synthetic provider event ${String(i).padStart(3, '0')}`,
    occurredAt: new Date(started + i * 1000).toISOString(),
    receivedAt: new Date(started + i * 1000).toISOString(),
    evidence: 'PROVIDER_REPORTED' as const,
  })),
);
f.store.execute({
  type: 'settings.update',
  idempotencyKey: key(),
  settings: { ...f.store.snapshot().settings, reducedMotion: true },
});
f.store.close();
const data = mkdtempSync(path.join(tmpdir(), 'qro-profile-paging-'));
mkdirSync(path.join(data, 'workspace'));
cpSync(path.join(f.root, 'workspace.sqlite'), path.join(data, 'workspace/workspace.sqlite'));
const { ELECTRON_RUN_AS_NODE: ignored, ...env } = process.env;
const app = await electron.launch({
  args: [],
  executablePath: process.env.QRO_EXECUTABLE!,
  env: { ...env, QRO_USER_DATA_DIR: data },
});
const evidence = path.resolve('test-output/profile-paging');
mkdirSync(evidence, { recursive: true });
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('heading', { name: 'The office', exact: true }).waitFor();
  await page.getByLabel('Current project', { exact: true }).selectOption(f.project.id);
  // Open the profile from the office's agent tile, then use the actual Assignments controls.
  await page
    .getByRole('button', { name: /Principal/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Full profile & logs', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Principal', exact: true });
  await dialog.getByRole('tab', { name: 'Assignments', exact: true }).click();
  await dialog.getByText('Provider events (50, oldest first)', { exact: true }).click();
  assert.equal(await dialog.locator('.evidence-list li').count(), 50);
  await dialog.getByRole('button', { name: 'More provider events', exact: true }).click();
  await dialog.getByText('Provider events (100, oldest first)', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'More provider events', exact: true }).click();
  await dialog.getByText('Provider events (125, oldest first)', { exact: true }).waitFor();
  const texts = await dialog.locator('.evidence-list li').allTextContents();
  assert.equal(texts.length, 125);
  assert.equal(new Set(texts).size, 125);
  for (const [i, text] of texts.entries())
    assert.ok(text.includes(`Synthetic provider event ${String(i).padStart(3, '0')}`));
  assert.equal(await dialog.getByRole('button', { name: 'More provider events', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(evidence, 'all-125.png') });
  await dialog.getByRole('tab', { name: 'Profile', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Assignments', exact: true }).click();
  await dialog.getByText('Provider events (50, oldest first)', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(evidence, 'acceptance.json'),
    JSON.stringify(
      {
        status: 'PASS',
        rows: [50, 100, 125],
        oldestFirst: true,
        unique: true,
        resetOnTabChange: true,
        scratchData: data,
        providerSubmissions: 0,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('PASS packaged profile: 50 → 100 → 125 unique ordered events; tab reset');
} finally {
  await app.close();
}
