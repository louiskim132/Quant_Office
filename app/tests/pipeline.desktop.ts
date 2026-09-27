import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
import { fixture, completeS1 } from './fixtures/pipeline';
import { SPEC_SECTIONS } from '../src/shared/research';

const cleanups: (() => void)[] = [];
const f = await fixture({
  after: ((fn: () => void) => {
    cleanups.push(fn);
  }) as never,
});
const store = f.store,
  project = f.project,
  subjectHash = f.subjectHash,
  reviewBranch = f.branch();
await f.linked();
store.recordResearchGates({
  branchId: reviewBranch.id,
  expectedRevision: reviewBranch.revision,
  receipts: [
    {
      id: randomUUID(),
      branchId: reviewBranch.id,
      specId: reviewBranch.specId!,
      stage: 'S0',
      gate: 'G-SPEC',
      outcome: 'PASS',
      subjectHash,
      detail: 'Frozen synthetic spec',
      rationale: 'Fixture',
      evidenceRef: store.snapshot().specs![0].contentHash,
      createdAt: new Date().toISOString(),
    },
  ],
});
store.advanceResearch(reviewBranch.id, reviewBranch.revision);
assert.throws(() => store.advanceResearch(reviewBranch.id, f.branch().revision), /completed exact-context/);
await completeS1(f);
store.advanceResearch(reviewBranch.id, f.branch().revision);
store.execute({
  type: 'research.draftSpec',
  idempotencyKey: randomUUID(),
  projectId: project.id,
  name: 'Unreviewed candidate',
  sections: Object.fromEntries(SPEC_SECTIONS.map(section => [section, 'Synthetic contract'])),
  thresholds: [],
  notApplicable: [],
  maxSelectionTrials: 2,
});
const revision = f.branch().revision;
const data = await mkdtemp(path.join(tmpdir(), 'qro-pipeline-desktop-'));
await mkdir(path.join(data, 'workspace'));
store.close();
await copyFile(path.join(f.root, 'workspace.sqlite'), path.join(data, 'workspace', 'workspace.sqlite'));
await cp(path.join(f.root, 'objects'), path.join(data, 'workspace', 'objects'), { recursive: true });
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...launchEnvironment } = process.env;
const app = await electron.launch({
  args: process.env.QRO_EXECUTABLE ? [] : [process.cwd()],
  ...(process.env.QRO_EXECUTABLE ? { executablePath: process.env.QRO_EXECUTABLE } : {}),
  env: { ...launchEnvironment, QRO_USER_DATA_DIR: data },
});
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // Selecting a project opens its detail page; the Projects navigation button resets selection.
  await page.getByLabel('Current project', { exact: true }).selectOption(project.id);
  const panel = page.getByRole('region', { name: 'Research pipeline' });
  await panel.getByRole('heading', { name: 'Research pipeline' }).waitFor();
  await panel.getByLabel('Research branch', { exact: true }).selectOption({ label: 'Unreviewed candidate · S0' });
  assert.match(await panel.innerText(), /No gate receipts identify a subject/);
  assert.equal(await panel.getByRole('button', { name: /promote|dispatch|evaluate holdout/i }).count(), 0);
  assert.equal(await panel.getByLabel('Evidence reader').locator('option').count(), 1);
  await assert.rejects(
    page.evaluate(() =>
      window.office.verifyCloudTransport({ provider: 'claude', model: 'opus', effort: 'default' } as never),
    ),
  );
  await panel.getByLabel('Research branch', { exact: true }).selectOption({ label: 'Lineage A · S2' });
  await panel.getByLabel('Recorded subject', { exact: true }).selectOption(subjectHash);
  await panel
    .getByText(/correctness reviewer function at S2/)
    .first()
    .waitFor();
  assert.match(await panel.innerText(), /Optional · not configured/);
  const before = await page.evaluate(() => window.office.getState());
  await assert.rejects(
    page.evaluate(input => window.office.pipelineAction(input), {
      type: 'prepare' as const,
      branchId: reviewBranch.id,
      expectedRevision: revision,
    }),
    /correctness reviewer/i,
  );
  await assert.rejects(
    page.evaluate(input => window.office.pipelineAction(input), {
      type: 'advance' as const,
      branchId: reviewBranch.id,
      expectedRevision: revision,
    }),
    /completed exact-context|frozen review round|no receipt|passing admitted/i,
  );
  const after = await page.evaluate(() => window.office.getState());
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.assignments, before.assignments);
  await panel.getByText('Search prior results before re-entry', { exact: true }).click();
  await panel.getByLabel('Search all project trials').fill('candidate');
  await panel.getByRole('button', { name: 'Search ledger', exact: true }).click();
  await panel.getByRole('button', { name: 'Read source branch and ancestry' }).first().waitFor();
  await panel.getByRole('button', { name: 'Read source branch and ancestry' }).first().click();
  assert.match(await panel.innerText(), /revision/);
  const compact = await page.evaluate(() => window.office.getState());
  assert.deepEqual(compact.pipeline, []);
  assert.deepEqual(compact.messages, []);
  assert.deepEqual(compact.jobEvents, []);
  const records = await page.evaluate(input => window.office.researchPage(input), {
    projectId: project.id,
    branchId: reviewBranch.id,
    kind: 'pipeline' as const,
    limit: 1,
  });
  assert.equal(records.entries.length, 1);
  assert.ok(records.nextCursor);
  await assert.rejects(
    page.evaluate(input => window.office.researchPage(input), {
      projectId: randomUUID(),
      kind: 'pipeline' as const,
      cursor: records.nextCursor!,
    }),
    /scope/,
  );
  await page.evaluate(async projectId => {
    const state = await window.office.getState();
    for (const r of state.requests ?? [])
      if (r.projectId === projectId && r.status !== 'CANCELED')
        await window.office.command({
          type: 'request.cancel',
          idempotencyKey: crypto.randomUUID(),
          requestId: r.id,
          expectedRevision: r.revision,
        });
  }, project.id);
  await page.evaluate(input => window.office.command(input), {
    type: 'project.archive' as const,
    idempotencyKey: randomUUID(),
    projectId: project.id,
    archived: true,
  });
  await panel.getByText('Archived project · research is read-only.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Prepare stage', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('button', { name: 'Export research evidence', exact: true }).count(), 1);
  await assert.rejects(
    page.evaluate(input => window.office.pipelineAction(input), {
      type: 'verifySpec' as const,
      branchId: reviewBranch.id,
      expectedRevision: revision,
    }),
    /archived/i,
  );
  assert.deepEqual(errors, []);
  await mkdir('test-output', { recursive: true });
  await writeFile(
    'test-output/pipeline-desktop-report.json',
    JSON.stringify(
      {
        status: 'PASS',
        at: new Date().toISOString(),
        checks: [
          'project branch visibility',
          'missing exact subject blocks',
          'holdout limitation visible',
          'ungranted evidence unavailable',
          'probe refused',
          'S2 unappointed-reviewer blocker visible',
          'S2 prepare and advance refused through IPC without state changes',
        ],
        workspace: data,
      },
      null,
      2,
    ),
  );
  console.log('Pipeline desktop checks passed.');
} finally {
  await app.close();
  for (const cleanup of cleanups) cleanup();
}
