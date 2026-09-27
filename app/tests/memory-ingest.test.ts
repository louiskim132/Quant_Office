import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
import { ingestReceiptMemory } from '../src/main/memory-ingest';
import { removeTreeSync } from '../src/main/fsx';
import type { LocalResultV2 } from '../src/shared/local-session';
import type { MemoryFinding } from '../src/shared/types';

const key = () => randomUUID();
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Store + one project + one ordinary request — enough for the ingest contract. */
function light(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-memory-ingest-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const request = store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: project.id,
    name: 'Study it',
    hypothesis: 'Study the thing.',
    workType: 'OTHER',
    mode: 'SINGLE',
    leadAgentId: null,
    participantIds: [],
  }).requests![0];
  return { root, store, project, request };
}

const receipt = (overrides: Partial<LocalResultV2> = {}): LocalResultV2 => ({
  schema: 'office-local-result@2',
  jobId: key(),
  assignmentId: key(),
  attemptId: key(),
  packetHash: sha('packet'),
  sequence: 1,
  state: 'COMPLETED',
  detail: 'Done.',
  outputs: [],
  ...overrides,
});

const ctxOf = (projectId: string, requestId: string | null, receiptText = 'receipt-1') => ({
  projectId,
  requestId,
  assignmentId: null,
  agentId: key(),
  receiptHash: sha(receiptText),
});

const findings = (f: ReturnType<typeof light>) => f.store.snapshot({ history: false }).findings ?? [];
const links = (f: ReturnType<typeof light>) => f.store.snapshot({ history: false }).relationships ?? [];

test("a receipt's findings land with session provenance; links resolve same-receipt refs and existing ids", async t => {
  const f = light(t);
  const ctx = ctxOf(f.project.id, f.request.id);
  const prior = f.store.recordMemoryFinding({
    projectId: f.project.id,
    requestId: f.request.id,
    assignmentId: null,
    kind: 'NOTE',
    title: 'pre-existing',
    body: 'already in the ledger',
    evidenceRefs: [],
    createdBy: { surface: 'OFFICE' },
  }).finding;
  const report = ingestReceiptMemory(
    f.store,
    ctx,
    receipt({
      findings: [
        {
          ref: 'f1',
          kind: 'OBSERVATION',
          title: 'alpha outruns beta',
          body: 'under the fixture threshold',
          evidenceRefs: [{ kind: 'REQUEST', id: f.request.id }],
        },
        { ref: 'f2', kind: 'RESULT', title: 'run settled', body: 'the fixture result', evidenceRefs: [] },
      ],
      links: [
        { from: 'f1', to: 'f2', kind: 'SUPPORTS', note: 'the observation backs the result' },
        { from: prior.id, to: 'f1', kind: 'RELATES' },
      ],
    }),
  );
  assert.equal(report.findingsSkipped.length, 0);
  assert.equal(report.linksSkipped.length, 0);
  assert.equal(report.findings.length, 2);
  assert.deepEqual(
    report.findings.map(item => item.ref),
    ['f1', 'f2'],
  );
  assert.ok(report.findings.every(item => item.created));
  // Session self-report is labeled: agent surface, the running agent, the verified receipt hash.
  const stored = findings(f).filter(item => item.createdBy.surface === 'AGENT_SESSION');
  assert.equal(stored.length, 2);
  for (const row of stored) {
    assert.equal(row.createdBy.agentId, ctx.agentId);
    assert.equal(row.createdBy.receiptHash, ctx.receiptHash);
    assert.equal(row.requestId, f.request.id);
    assert.equal(row.assignmentId, null);
    assert.equal(row.projectId, f.project.id);
  }
  const first = stored.find(item => item.title === 'alpha outruns beta')!;
  assert.equal(first.kind, 'OBSERVATION');
  assert.equal(first.body, 'under the fixture threshold');
  assert.deepEqual(first.evidenceRefs, [{ kind: 'REQUEST', id: f.request.id }], 'evidence refs map 1:1');
  // Links land PROPOSED with the same session author — validated links, never established truth.
  assert.equal(report.links.length, 2);
  assert.ok(report.links.every(item => item.created));
  const rels = links(f);
  assert.equal(rels.length, 2);
  const byRef = new Map(report.findings.map(item => [item.ref, item.findingId]));
  const supports = rels.find(item => item.kind === 'SUPPORTS')!;
  assert.equal(supports.fromFindingId, byRef.get('f1'));
  assert.equal(supports.toFindingId, byRef.get('f2'));
  assert.equal(supports.status, 'PROPOSED');
  assert.equal(supports.note, 'the observation backs the result');
  assert.equal(supports.createdBy.surface, 'AGENT_SESSION');
  assert.equal(supports.createdBy.receiptHash, ctx.receiptHash);
  const relates = rels.find(item => item.kind === 'RELATES')!;
  assert.equal(relates.fromFindingId, prior.id, 'an endpoint may name an existing finding id directly');
  assert.equal(relates.toFindingId, byRef.get('f1'));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, 'the report is plain JSON-safe data');
});

test('supersedes resolves a same-receipt ref and an existing finding id, marking each prior row', async t => {
  const f = light(t);
  const ctx = ctxOf(f.project.id, f.request.id);
  const prior = f.store.recordMemoryFinding({
    projectId: f.project.id,
    requestId: null,
    assignmentId: null,
    kind: 'HYPOTHESIS',
    title: 'early guess',
    body: 'before the run',
    evidenceRefs: [],
    createdBy: { surface: 'USER' },
  }).finding;
  // `supersedes` is uuid-typed on the receipt contract, so a ref it names must be uuid-shaped.
  const refA = key();
  const report = ingestReceiptMemory(
    f.store,
    ctx,
    receipt({
      findings: [
        { ref: refA, kind: 'OBSERVATION', title: 'first pass', body: 'v1' },
        { kind: 'OBSERVATION', title: 'second pass', body: 'v2', supersedes: refA },
        { kind: 'RESULT', title: 'final answer', body: 'v3', supersedes: prior.id },
      ],
    }),
  );
  assert.equal(report.findingsSkipped.length, 0);
  assert.equal(report.findings.length, 3);
  const rows = findings(f);
  const firstPass = rows.find(item => item.title === 'first pass')!;
  const secondPass = rows.find(item => item.title === 'second pass')!;
  const final = rows.find(item => item.title === 'final answer')!;
  assert.equal(firstPass.supersededById, secondPass.id, 'the ref resolved to the finding recorded from it');
  assert.equal(
    rows.find(item => item.id === prior.id)!.supersededById,
    final.id,
    'an existing finding id supersedes directly',
  );
  assert.equal(firstPass.body, 'v1', 'the prior row is never rewritten — only marked');
});

test('malformed entries are skipped and counted — never thrown, never blocking valid siblings', async t => {
  const f = light(t);
  // `project.create` returns the full project list — the new one is the last entry.
  const foreignProject = f.store
    .execute({ type: 'project.create', idempotencyKey: key(), name: 'Beta', mandate: 'm', budgetCents: 0 })
    .projects.at(-1)!;
  const foreign = f.store.recordMemoryFinding({
    projectId: foreignProject.id,
    requestId: null,
    assignmentId: null,
    kind: 'NOTE',
    title: 'other project note',
    body: 'x',
    evidenceRefs: [],
    createdBy: { surface: 'OFFICE' },
  }).finding;
  const ctx = ctxOf(f.project.id, f.request.id);
  const report = ingestReceiptMemory(
    f.store,
    ctx,
    receipt({
      findings: [
        { ref: 'good', kind: 'NOTE', title: 'lands fine', body: 'ok' },
        { kind: 'NOTE', title: 'bad ref', body: 'x', evidenceRefs: [{ kind: 'REQUEST', id: key() }] },
        { kind: 'NOTE', title: 'ghost supersedes', body: 'x', supersedes: key() },
        { kind: 'NOTE', title: 'foreign supersedes', body: 'x', supersedes: foreign.id },
        { ref: 'also-good', kind: 'DEFECT', title: 'lands too', body: 'ok' },
      ],
      links: [
        { from: 'good', to: 'also-good', kind: 'RELATES' },
        { from: 'no-such-ref', to: 'good', kind: 'SUPPORTS' },
        { from: 'good', to: foreign.id, kind: 'RELATES' },
        { from: 'good', to: 'good', kind: 'SUPPORTS' },
      ],
    }),
  );
  // Every invalid entry is counted with its position; the valid siblings all landed.
  assert.deepEqual(
    report.findingsSkipped.map(item => item.index),
    [1, 2, 3],
  );
  assert.match(report.findingsSkipped[0].reason, /does not hold|does not exist/);
  assert.match(report.findingsSkipped[1].reason, /supersedes target/);
  assert.match(report.findingsSkipped[2].reason, /supersedes target/);
  assert.deepEqual(
    report.linksSkipped.map(item => item.index),
    [1, 2, 3],
  );
  assert.match(report.linksSkipped[1].reason, /target/);
  assert.equal(report.findings.length, 2);
  assert.equal(report.links.length, 1);
  const stored = findings(f).filter(item => item.projectId === f.project.id);
  assert.equal(stored.length, 2);
  assert.equal(links(f).length, 1);
});

test('re-ingesting the same receipt creates no duplicates — refs re-map to the deduped rows', async t => {
  const f = light(t);
  const ctx = ctxOf(f.project.id, f.request.id);
  const result = receipt({
    findings: [
      { ref: 'a', kind: 'RESULT', title: 'alpha wins', body: 'x' },
      { ref: 'b', kind: 'OBSERVATION', title: 'beta lags', body: 'y' },
    ],
    links: [{ from: 'b', to: 'a', kind: 'SUPPORTS' }],
  });
  const first = ingestReceiptMemory(f.store, ctx, result);
  const second = ingestReceiptMemory(f.store, ctx, result);
  assert.equal(findings(f).length, 2);
  assert.equal(links(f).length, 1);
  assert.deepEqual(
    second.findings.map(item => item.findingId),
    first.findings.map(item => item.findingId),
    'the same receipt resolves to the same finding ids',
  );
  assert.ok(
    second.findings.every(item => !item.created),
    'a replay dedups to existing rows',
  );
  assert.equal(second.links.length, 1);
  assert.equal(second.links[0].created, false, 'the link dedups too');
  assert.equal(second.links[0].relationshipId, first.links[0].relationshipId);
  assert.equal(second.findingsSkipped.length + second.linksSkipped.length, 0);
});

test('a receipt with no memory sections yields an empty report', async t => {
  const f = light(t);
  const report = ingestReceiptMemory(f.store, ctxOf(f.project.id, null), receipt());
  assert.deepEqual(report, { findings: [], findingsSkipped: [], links: [], linksSkipped: [] });
  assert.equal(findings(f).length, 0);
  assert.equal(links(f).length, 0);
});
