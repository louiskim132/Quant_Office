import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { strToU8 } from 'fflate';
import { OfficeStore } from '../src/core/store.js';
import { EvidenceService } from '../src/main/evidence.js';
import {
  buildAdversarialPackets,
  buildBlindedPacket,
  independenceLabel,
  openSealedRound,
  sealReport,
} from '../src/main/context-policy.js';
import { independenceClaimBlocker } from '../src/shared/cooperation.js';
import type { Agent, EffectiveEvidence, ProviderCapabilitySnapshot } from '../src/shared/types.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2024, 0, 1, 0, minutes)).toISOString();
const SUBJECT = randomUUID();

const confinement = (route: string, overrides: Partial<EffectiveEvidence> = {}): EffectiveEvidence => ({
  operation: 'TOOL_CONFINEMENT',
  level: 'ACCOUNT_VERIFIED',
  evidence: 'OBSERVED',
  verifiedAt: at(0),
  model: 'opus',
  environment: 'anthropic-managed',
  route: route as EffectiveEvidence['route'],
  transport: 'OFFICIAL_CLI_TERMINAL',
  detail: 'Confined to the staged snapshot directory.',
  source: 'fixture',
  snapshotId: randomUUID(),
  expired: false,
  impossible: false,
  ...overrides,
});

test('a correctness packet carrying performance is refused, not quietly redacted', () => {
  const clean = {
    specification: 'estimand and split plan',
    artifacts: ['run.log'],
    fitScopes: [{ foldId: 'fold-1', rowsFitted: 4000 }],
  };
  const packet = buildBlindedPacket({
    stage: 'S2',
    subjectId: SUBJECT,
    reviewerAgentId: randomUUID(),
    objectHashes: [sha256('a')],
    body: clean,
  });
  assert.equal(packet.performanceWithheld, true);
  assert.deepEqual(packet.objectHashes, [sha256('a')]);

  for (const leak of [
    { specification: 'x', summary: { sharpe: 1.8 } },
    { specification: 'x', folds: [{ id: 'fold-1', rank_ic: 0.03 }] },
    { specification: 'x', evaluation: { net_return: 0.11 } },
  ])
    assert.throws(
      () =>
        buildBlindedPacket({
          stage: 'S2',
          subjectId: SUBJECT,
          reviewerAgentId: randomUUID(),
          objectHashes: [sha256('a')],
          body: leak,
        }),
      /carries performance information/,
      JSON.stringify(leak),
    );

  // A packet with no objects is a review of nothing.
  assert.throws(
    () =>
      buildBlindedPacket({
        stage: 'S2',
        subjectId: SUBJECT,
        reviewerAgentId: randomUUID(),
        objectHashes: [],
        body: clean,
      }),
    /must name the objects it is a review of/,
  );
});

test('two subjects cannot be combined into one review packet', () => {
  assert.throws(
    () =>
      buildBlindedPacket({
        stage: 'S2',
        subjectId: SUBJECT,
        reviewerAgentId: randomUUID(),
        objectHashes: [sha256('a')],
        body: { specification: 'x' },
        subjectIds: [SUBJECT, randomUUID()],
      }),
    /covers exactly one subject/,
  );
  assert.doesNotThrow(() =>
    buildBlindedPacket({
      stage: 'S2',
      subjectId: SUBJECT,
      reviewerAgentId: randomUUID(),
      objectHashes: [sha256('a')],
      body: { specification: 'x' },
      subjectIds: [SUBJECT],
    }),
  );
});

test('the advocate and the skeptic argue from byte-identical evidence', () => {
  const advocateAgentId = randomUUID(),
    skepticAgentId = randomUUID();
  const hashes = [sha256('b'), sha256('a')];
  const built = buildAdversarialPackets({
    subjectId: SUBJECT,
    objectHashes: hashes,
    advocateAgentId,
    skepticAgentId,
    body: { netReturn: 0.02 },
  });
  assert.deepEqual(built.advocate.objectHashes, built.skeptic.objectHashes);
  assert.deepEqual(built.advocate.body, built.skeptic.body);
  assert.match(built.evidenceHash, /^[a-f0-9]{64}$/);

  // A different evidence set is a different argument, and the receipt hash says so.
  const narrowed = buildAdversarialPackets({
    subjectId: SUBJECT,
    objectHashes: [sha256('a')],
    advocateAgentId,
    skepticAgentId,
    body: { netReturn: 0.02 },
  });
  assert.notEqual(narrowed.evidenceHash, built.evidenceHash);

  assert.throws(
    () =>
      buildAdversarialPackets({
        subjectId: SUBJECT,
        objectHashes: hashes,
        advocateAgentId,
        skepticAgentId: advocateAgentId,
        body: {},
      }),
    /cannot be the same profile/,
  );
});

test('a first report cannot be read until every first report in the round is filed', () => {
  const one = randomUUID(),
    two = randomUUID();
  const first = sealReport({
    reviewerAgentId: one,
    subjectId: SUBJECT,
    body: 'The split plan does not purge the label horizon.',
    sealedAt: at(1),
  });
  assert.equal(first.contentHash, sha256('The split plan does not purge the label horizon.'));

  assert.throws(
    () => openSealedRound({ subjectId: SUBJECT, expectedReviewerIds: [one, two], reports: [first] }),
    /1 of 2 first reports have not been filed/,
  );

  const second = sealReport({
    reviewerAgentId: two,
    subjectId: SUBJECT,
    body: 'The fit scope overruns fold one.',
    sealedAt: at(2),
  });
  const opened = openSealedRound({ subjectId: SUBJECT, expectedReviewerIds: [one, two], reports: [first, second] });
  assert.deepEqual(opened.map(report => report.reviewerAgentId).sort(), [one, two].sort());
  // Sealing recorded the identity before opening, so a report cannot be edited between the two.
  assert.equal(
    opened.find(report => report.reviewerAgentId === two)!.contentHash,
    sha256('The fit scope overruns fold one.'),
  );
});

test('independence is labelled from what was observed, never from a flag', () => {
  const subjectAgentId = randomUUID(),
    reviewerAgentId = randomUUID();
  const base = {
    subjectExternalId: 'session_subject',
    reviewerExternalId: 'session_reviewer',
    subjectAgentId,
    reviewerAgentId,
    route: 'CLI_PTY',
  };

  assert.equal(independenceLabel({ ...base, evidence: [confinement('CLI_PTY')] }).label, 'VERIFIED_INDEPENDENT');

  // A separate session with no observed confinement for that route is honest but weaker.
  const unverified = independenceLabel({ ...base, evidence: [] });
  assert.equal(unverified.label, 'SEPARATE_SESSION_UNVERIFIED');
  assert.match(unverified.detail, /cannot be labelled verified independent/);

  // Evidence for a different route, expired evidence, and impossible evidence all fail to qualify.
  assert.equal(
    independenceLabel({ ...base, evidence: [confinement('TERMINAL_HANDOFF')] }).label,
    'SEPARATE_SESSION_UNVERIFIED',
  );
  assert.equal(
    independenceLabel({ ...base, evidence: [confinement('CLI_PTY', { expired: true })] }).label,
    'SEPARATE_SESSION_UNVERIFIED',
  );
  assert.equal(
    independenceLabel({ ...base, evidence: [confinement('CLI_PTY', { impossible: true })] }).label,
    'SEPARATE_SESSION_UNVERIFIED',
  );
  assert.equal(
    independenceLabel({ ...base, evidence: [confinement('CLI_PTY', { evidence: 'DOCUMENTED' })] }).label,
    'SEPARATE_SESSION_UNVERIFIED',
  );

  // Same profile, or the same provider session, is not independent at all.
  assert.equal(
    independenceLabel({ ...base, reviewerAgentId: subjectAgentId, evidence: [confinement('CLI_PTY')] }).label,
    'NOT_INDEPENDENT',
  );
  assert.equal(
    independenceLabel({ ...base, reviewerExternalId: 'session_subject', evidence: [confinement('CLI_PTY')] }).label,
    'NOT_INDEPENDENT',
  );
  assert.equal(
    independenceLabel({ ...base, reviewerExternalId: '', evidence: [confinement('CLI_PTY')] }).label,
    'NOT_INDEPENDENT',
  );
});

/** A workspace where one reviewer holds a grant and another does not, to test the read path itself. */
function evidenceFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-blinded-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const add = (name: string): Agent => {
    const value: Agent = {
      id: randomUUID(),
      name,
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      account: 'researcher@example.com',
      createdAt: at(0),
      connectionVerifiedAt: at(0),
      execution: 'HOSTED_SETUP_REQUIRED',
    };
    store.addAgent(value);
    return value;
  };
  const author = add('Author'),
    reviewer = add('Reviewer'),
    outsider = add('Outsider');
  const request = store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: project.id,
    name: 'Audit',
    hypothesis: 'Check',
    workType: 'ANALYSIS',
    mode: 'GROUP',
    leadAgentId: author.id,
    participantIds: [reviewer.id],
  }).requests![0];
  store.execute({
    type: 'request.grant',
    idempotencyKey: key(),
    requestId: request.id,
    agentId: reviewer.id,
    capacity: 'REVIEW',
    granted: true,
  });
  const body = 'row 0 sharpe 1.8\nrow 1 fitted\n';
  const hash = sha256(body);
  const file = path.join(workspace, 'objects', hash.slice(0, 2), hash);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, strToU8(body));
  store.addArtifact({
    id: randomUUID(),
    projectId: project.id,
    experimentId: null,
    name: 'evaluation.log',
    sha256: hash,
    size: body.length,
    kind: 'RESULT',
    classification: 'USER_ATTESTED',
    status: 'QUARANTINED',
    createdAt: at(0),
    mediaType: 'text/plain',
    note: 'fixture',
  });
  return { store, workspace, project, request, author, reviewer, outsider, hash };
}

test('grants are enforced on the read path itself, so a warmed cache cannot serve an ungranted reviewer', async t => {
  const f = evidenceFixture(t);
  const evidence = new EvidenceService(f.store, f.workspace);

  const granted = await evidence.read({ agentId: f.reviewer.id, objectHash: f.hash });
  assert.deepEqual(granted.lines, ['row 0 sharpe 1.8', 'row 1 fitted']);

  // The interpretation cache is now warm for exactly this object and range.
  await assert.rejects(evidence.read({ agentId: f.outsider.id, objectHash: f.hash }), /not available to this agent/);
  await assert.rejects(
    evidence.query({ agentId: f.outsider.id, projectId: f.project.id, pattern: 'sharpe' }),
    /No stored object in this project is available to this agent/,
  );
  assert.equal(evidence.receiptsFor(f.outsider.id).length, 0);

  // Revoking the reviewer's grant closes the same warmed entry to them as well.
  f.store.execute({
    type: 'request.grant',
    idempotencyKey: key(),
    requestId: f.request.id,
    agentId: f.reviewer.id,
    capacity: 'REVIEW',
    granted: false,
  });
  await assert.rejects(evidence.read({ agentId: f.reviewer.id, objectHash: f.hash }), /not available to this agent/);
});

test('a blinded packet built from a real evidence read is refused when that evidence carries performance', async t => {
  const f = evidenceFixture(t);
  const evidence = new EvidenceService(f.store, f.workspace);
  const read = await evidence.read({ agentId: f.reviewer.id, objectHash: f.hash });

  // Handing the correctness reviewer the evaluation log verbatim is the ordinary mistake: the lines
  // are strings, so nothing about them looks like a performance field until it is summarised.
  assert.doesNotThrow(
    () =>
      buildBlindedPacket({
        stage: 'S2',
        subjectId: SUBJECT,
        reviewerAgentId: f.reviewer.id,
        objectHashes: [f.hash],
        body: { lines: read.lines },
      }),
    'raw lines are not structured performance',
  );

  // A summary built from the same read is caught, which is where the leak actually becomes usable.
  assert.throws(
    () =>
      buildBlindedPacket({
        stage: 'S2',
        subjectId: SUBJECT,
        reviewerAgentId: f.reviewer.id,
        objectHashes: [f.hash],
        body: { summary: { sharpe: 1.8 }, coverage: read.coverage },
      }),
    /carries performance information/,
  );
});

test('a verified-independent claim needs observed confinement for the route the review ran on', () => {
  const snapshotId = randomUUID();
  const snapshot = (
    route: string | null,
    evidenceKind: 'OBSERVED' | 'DOCUMENTED' = 'OBSERVED',
  ): ProviderCapabilitySnapshot => ({
    id: snapshotId,
    provider: 'claude',
    connectionId: randomUUID(),
    identity: 'researcher@example.com',
    toolVersion: '2.1.236',
    transport: 'OFFICIAL_CLI_TERMINAL',
    environment: 'anthropic-managed',
    models: [{ id: 'opus', name: 'Opus' }],
    operations: route
      ? [
          {
            operation: 'TOOL_CONFINEMENT',
            level: 'ACCOUNT_VERIFIED',
            detail: 'confined',
            evidence: evidenceKind,
            route: route as ProviderCapabilitySnapshot['operations'][number]['route'],
          },
        ]
      : [],
    source: 'fixture',
    contentHash: sha256('snapshot'),
    observedAt: at(0),
  });
  const reviewer = { route: 'OFFICIAL_CLI_PTY' as const, capabilitySnapshotId: snapshotId };

  assert.equal(
    independenceClaimBlocker({ capabilities: [snapshot('OFFICIAL_CLI_PTY')], reviewer, claim: 'VERIFIED_INDEPENDENT' }),
    null,
  );
  // The weaker label needs nothing, and omitting the claim entirely is also fine.
  assert.equal(independenceClaimBlocker({ capabilities: [], reviewer, claim: 'SEPARATE_SESSION_UNVERIFIED' }), null);
  assert.equal(independenceClaimBlocker({ capabilities: [], reviewer, claim: undefined }), null);

  for (const capabilities of [
    [],
    [snapshot(null)],
    [snapshot('OFFICIAL_TERMINAL_HANDOFF')],
    [snapshot('OFFICIAL_CLI_PTY', 'DOCUMENTED')],
  ])
    assert.match(
      independenceClaimBlocker({ capabilities, reviewer, claim: 'VERIFIED_INDEPENDENT' }) ?? '',
      /no observed context-isolation evidence/,
    );
});
