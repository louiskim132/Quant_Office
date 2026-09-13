import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { OfficeStore } from '../src/core/store.js';
import { EvidenceService } from '../src/main/evidence.js';
import { assertHostedRetrievalHandle } from '../src/shared/evidence.js';
import { writeStreamedArchive } from '../src/main/archive.js';
import type { Agent, InputSnapshot } from '../src/shared/types.js';

const key = () => randomUUID();
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * A workspace holding two projects, two profiles and objects reachable through different grants.
 *
 * Everything the evidence layer decides is a function of stored records plus stored bytes, so the
 * fixture writes both by hand rather than driving a provider path that R5 still blocks.
 */
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-evidence-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch { /* already closed */ } removeTreeSync(root); });

  const alpha = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const beta = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Beta', mandate: 'm', budgetCents: 0 }).projects.find(p => p.name === 'Beta')!;

  const agent = (name: string): Agent => {
    const value: Agent = { id: randomUUID(), name, provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER', instructions: '',
      account: 'researcher@example.com', createdAt: new Date().toISOString(), connectionVerifiedAt: new Date().toISOString(), execution: 'HOSTED_SETUP_REQUIRED' };
    store.addAgent(value); return value;
  };
  const author = agent('Author'), outsider = agent('Outsider');

  const request = store.execute({ type: 'request.create', idempotencyKey: key(), projectId: alpha.id, name: 'Leakage audit',
    hypothesis: 'Check the run logs for look-ahead', workType: 'ANALYSIS', mode: 'GROUP', leadAgentId: author.id, participantIds: [outsider.id] }).requests![0];
  store.execute({ type: 'request.grant', idempotencyKey: key(), requestId: request.id, agentId: author.id, capacity: 'WORKER', granted: true });

  /** Writes an object's bytes where both the artifact store and the evidence layer address them. */
  const putObject = (bytes: Uint8Array | string) => {
    const data = typeof bytes === 'string' ? strToU8(bytes) : bytes;
    const hash = sha256(data);
    const file = path.join(workspace, 'objects', hash.slice(0, 2), hash);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return { hash, bytes: data.length };
  };
  /** A project-scoped imported artifact: reachable by anyone holding a grant anywhere in the project. */
  const artifact = (projectId: string, name: string, body: string, store_ = true) => {
    const object = putObject(body);
    if (!store_) rmSync(path.join(workspace, 'objects', object.hash.slice(0, 2), object.hash), { force: true });
    store.addArtifact({ id: randomUUID(), projectId, experimentId: null, name, sha256: object.hash, size: object.bytes, kind: 'RESULT',
      classification: 'USER_ATTESTED', status: 'QUARANTINED', createdAt: new Date().toISOString(), mediaType: 'text/plain', note: 'fixture' });
    return object;
  };
  /** A request-scoped frozen input: reachable only through a grant on that exact request. */
  const snapshotObject = (requestId: string | null, projectId: string, name: string, body: string) => {
    const object = putObject(body);
    const snapshot: InputSnapshot = { objectsStored: true, id: randomUUID(), projectId, requestId, locationRevision: 0, requestRevision: null,
      route: 'GENERATED_REQUEST_ONLY', files: [{ path: name, bytes: object.bytes, sha256: object.hash }], generated: [], totalBytes: object.bytes,
      manifestHash: sha256(name), stagingCommit: '', stagingPath: '', warnings: [], provenance: 'OFFICE_STAGED', createdAt: new Date().toISOString() };
    store.recordInputSnapshot(snapshot);
    return object;
  };
  return { root, workspace, store, alpha, beta, author, outsider, request, putObject, artifact, snapshotObject };
}

const service = (f: ReturnType<typeof fixture>, backups: string[] = []) => new EvidenceService(f.store, f.workspace, backups);

test('a search that could not read every object never reads as an absence of findings', async t => {
  const f = fixture(t);
  f.artifact(f.alpha.id, 'clean.log', 'row 0 ok\nrow 1 ok\n');
  // The one log holding the finding is recorded but its bytes are gone: the exact case where a
  // convenient "no leakage found" would otherwise be produced from a partial read.
  f.artifact(f.alpha.id, 'missing.log', 'row 2 LOOK_AHEAD detected\n', false);
  const evidence = service(f);

  const result = await evidence.query({ agentId: f.author.id, projectId: f.alpha.id, pattern: 'LOOK_AHEAD' });
  assert.equal(result.matches.length, 0);
  assert.equal(result.coverage, 'PARTIAL');
  assert.deepEqual(result.unreadableObjects, ['missing.log']);
  assert.match(result.detail, /does not establish that no match exists/);

  // The same query over a fully readable scope is a different answer, and says so.
  const clean = await evidence.query({ agentId: f.author.id, projectId: f.beta.id, pattern: 'LOOK_AHEAD' })
    .then(() => 'reached', error => (error as Error).message);
  assert.equal(clean, 'No stored object in this project is available to this agent.');

  const complete = await evidence.query({ agentId: f.author.id, projectId: f.alpha.id, pattern: 'nothing-matches-this' });
  assert.equal(complete.coverage, 'PARTIAL', 'the unreadable object still limits coverage');

  // With the missing bytes restored, the finding is recovered rather than staying lost.
  f.putObject('row 2 LOOK_AHEAD detected\n');
  const recovered = await evidence.query({ agentId: f.author.id, projectId: f.alpha.id, pattern: 'LOOK_AHEAD' });
  assert.equal(recovered.coverage, 'COMPLETE');
  assert.deepEqual(recovered.matches.map(m => [m.name, m.line]), [['missing.log', 1]]);
  assert.match(recovered.detail, /Searched all 2 available objects in full/);
});

test('describe reports missing bytes as unknown rather than as an empty object', async t => {
  const f = fixture(t);
  const object = f.artifact(f.alpha.id, 'partial-upload.log', 'only line\n', false);
  const evidence = service(f);
  const described = await evidence.describe({ agentId: f.author.id, objectHash: object.hash });
  assert.equal(described.lines, null);
  assert.equal(described.coverage, 'UNKNOWN');
  assert.match(described.detail, /integrity failure, not an empty object/);

  const read = await evidence.read({ agentId: f.author.id, objectHash: object.hash });
  assert.deepEqual(read.lines, []);
  assert.equal(read.total, null);
  assert.equal(read.coverage, 'UNKNOWN');
  assert.match(read.detail, /does not mean the object is empty/);
});

test('pagination reaches every match and every line exactly once', async t => {
  const f = fixture(t);
  const lines = Array.from({ length: 25 }, (_, index) => `row ${index} HIT`).join('\n') + '\n';
  const object = f.artifact(f.alpha.id, 'long.log', lines);
  const evidence = service(f);

  const collected: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await evidence.read({ agentId: f.author.id, objectHash: object.hash, limit: 7, ...(cursor ? { cursor } : {}) });
    collected.push(...page.lines.map((_, index) => page.from + index));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(collected, Array.from({ length: 25 }, (_, index) => index + 1));

  const matches: string[] = [];
  let searchCursor: string | undefined;
  do {
    const page: Awaited<ReturnType<typeof evidence.query>> = await evidence.query({ agentId: f.author.id, projectId: f.alpha.id, pattern: 'HIT', limit: 10, ...(searchCursor ? { cursor: searchCursor } : {}) });
    matches.push(...page.matches.map(match => `${match.name}:${match.line}`));
    searchCursor = page.nextCursor ?? undefined;
  } while (searchCursor);
  assert.equal(matches.length, 25);
  assert.equal(new Set(matches).size, 25);

  // A cursor is bound to the object it was issued for; it cannot be replayed onto another.
  const other = f.artifact(f.alpha.id, 'other.log', 'x\n');
  await assert.rejects(evidence.read({ agentId: f.author.id, objectHash: other.hash, cursor: `${object.hash}:3` }),
    /This cursor does not belong to this object/);
});

test('grants are enforced across projects and profiles, and a denial reveals nothing about the object', async t => {
  const f = fixture(t);
  const mine = f.artifact(f.alpha.id, 'alpha.log', 'alpha secret\n');
  const theirs = f.artifact(f.beta.id, 'beta.log', 'beta secret\n');
  const scoped = f.snapshotObject(f.request.id, f.alpha.id, 'frozen.txt', 'request scoped\n');
  const evidence = service(f);

  assert.equal((await evidence.describe({ agentId: f.author.id, objectHash: mine.hash })).name, 'alpha.log');
  assert.equal((await evidence.describe({ agentId: f.author.id, objectHash: scoped.hash })).name, 'frozen.txt');

  // Another project, an ungranted profile and an unknown object all fail the same way.
  const denials = await Promise.all([
    evidence.describe({ agentId: f.author.id, objectHash: theirs.hash }).catch(e => (e as Error).message),
    evidence.describe({ agentId: f.outsider.id, objectHash: mine.hash }).catch(e => (e as Error).message),
    evidence.describe({ agentId: f.outsider.id, objectHash: sha256('never stored') }).catch(e => (e as Error).message),
  ]);
  assert.deepEqual(new Set(denials), new Set(['This object is not available to this agent.']));

  // A search cannot be widened past the grant by naming the hash directly.
  await assert.rejects(evidence.query({ agentId: f.author.id, projectId: f.alpha.id, pattern: 'secret', objectHashes: [theirs.hash] }),
    /not available to this agent/);
  const scopedSearch = await evidence.query({ agentId: f.author.id, projectId: f.alpha.id, pattern: 'secret' });
  assert.deepEqual(scopedSearch.matches.map(m => m.name), ['alpha.log']);

  // Revoking the grant closes the request-scoped object again.
  f.store.execute({ type: 'request.grant', idempotencyKey: key(), requestId: f.request.id, agentId: f.author.id, capacity: 'WORKER', granted: false });
  await assert.rejects(evidence.describe({ agentId: f.author.id, objectHash: scoped.hash }), /not available to this agent/);
});

test('a stage packet carries identities and exclusions, never bytes', async t => {
  const f = fixture(t);
  f.artifact(f.alpha.id, 'a.log', 'one\ntwo\n');
  f.artifact(f.alpha.id, 'b.log', 'three\n');
  f.artifact(f.beta.id, 'elsewhere.log', 'not in scope\n');
  const evidence = service(f);
  const packet = await evidence.stagePacket({ agentId: f.author.id, projectId: f.alpha.id, subjectId: randomUUID(), stage: 'S2', maxObjects: 1 });
  assert.equal(packet.objects.length, 1);
  assert.equal(packet.excludedObjects, 1);
  assert.equal(JSON.stringify(packet).includes('one\ntwo'), false, 'a packet must not carry object contents');
  assert.match(packet.notes.join(' '), /1 further available object is not listed/);
  assert.match(packet.notes.join(' '), /outside this function's grants/);
});

test('the raw answer survives a rejected brief, and a quotation must match the stored bytes', async t => {
  const f = fixture(t);
  const object = f.artifact(f.alpha.id, 'run.log', 'row 0 fitted\nrow 1 LOOK_AHEAD\nrow 2 done\n');
  const evidence = service(f);
  const read = await evidence.read({ agentId: f.author.id, objectHash: object.hash });
  assert.equal(read.coverage, 'COMPLETE');

  const raw = await evidence.recordRawOutput({ projectId: f.alpha.id, agentId: f.author.id, subjectId: f.request.id,
    body: 'Found a look-ahead reference on the second row.', receiptIds: [read.receiptId] });

  const brief = (refs: unknown, missing: string[] = []) => ({ id: randomUUID(), projectId: f.alpha.id, subjectKind: 'REQUEST' as const,
    subjectId: f.request.id, stage: 'S2' as const, claims: [{ text: 'The run log records a look-ahead.', refs }],
    missingCoverage: missing, receiptIds: [read.receiptId], dependencyKey: sha256('k'), createdAt: new Date().toISOString() });

  // A quotation of bytes that are not there is refused, and the reasoning is still on record.
  await assert.rejects(evidence.submitBrief(raw.id, brief([{ objectHash: object.hash, fromLine: 2, toLine: 2, quoteHash: sha256('row 1 SOMETHING ELSE') }])),
    /does not match the stored bytes/);
  const kept = evidence.rawOutput(raw.id)!;
  assert.equal(kept.body, 'Found a look-ahead reference on the second row.');
  assert.equal(kept.briefId, null);
  assert.match(kept.briefError!, /does not match the stored bytes/);

  await assert.rejects(evidence.submitBrief(raw.id, brief([{ objectHash: object.hash, fromLine: 9, toLine: 9, quoteHash: sha256('x') }])),
    /which has 3/);

  const accepted = await evidence.submitBrief(raw.id, brief([{ objectHash: object.hash, fromLine: 2, toLine: 2, quoteHash: EvidenceService.quoteHash(['row 1 LOOK_AHEAD']) }]));
  assert.equal(evidence.rawOutput(raw.id)!.briefId, accepted.id);
  assert.equal(evidence.rawOutput(raw.id)!.briefError, null);
  assert.equal(evidence.brief(accepted.id)!.claims[0].refs[0].fromLine, 2);
});

test('a brief built on incomplete queries cannot claim complete coverage', async t => {
  const f = fixture(t);
  const object = f.artifact(f.alpha.id, 'run.log', Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\n') + '\n');
  const evidence = service(f);
  const partial = await evidence.read({ agentId: f.author.id, objectHash: object.hash, limit: 3 });
  assert.equal(partial.coverage, 'PARTIAL');
  const raw = await evidence.recordRawOutput({ projectId: f.alpha.id, agentId: f.author.id, subjectId: f.request.id, body: 'Looks clean.', receiptIds: [partial.receiptId] });
  const candidate = { id: randomUUID(), projectId: f.alpha.id, subjectKind: 'REQUEST' as const, subjectId: f.request.id, stage: 'S2' as const,
    claims: [{ text: 'Nothing unusual.', refs: [{ objectHash: object.hash, fromLine: 1, toLine: 1, quoteHash: EvidenceService.quoteHash(['row 0']) }] }],
    missingCoverage: [], receiptIds: [partial.receiptId], dependencyKey: sha256('k'), createdAt: new Date().toISOString() };
  await assert.rejects(evidence.submitBrief(raw.id, candidate), /missingCoverage cannot be empty/);
  const honest = await evidence.submitBrief(raw.id, { ...candidate, missingCoverage: ['Rows 4 to 12 of run.log were not read.'] });
  assert.equal(honest.missingCoverage.length, 1);
});

test('objects are recovered from either backup format, and a substituted object is refused', async t => {
  const f = fixture(t);
  const body = 'row 0 recovered from backup\n';
  const object = f.artifact(f.alpha.id, 'archived.log', body, false);
  const small = path.join(f.root, 'small-backup.zip');
  writeFileSync(small, zipSync({ ['objects/' + object.hash]: strToU8(body) }));
  const streamed = path.join(f.root, 'streamed-backup.zip');
  await writeStreamedArchive(streamed, [{ path: 'objects/' + object.hash, bytes: strToU8(body) }]);

  for (const backup of [small, streamed]) {
    const evidence = service(f, [backup]);
    const read = await evidence.read({ agentId: f.author.id, objectHash: object.hash });
    assert.deepEqual(read.lines, ['row 0 recovered from backup'], `recovery failed from ${path.basename(backup)}`);
    assert.equal(read.coverage, 'COMPLETE');
  }

  // An archive whose entry does not hash to the name it is stored under is not a source of evidence.
  const forged = path.join(f.root, 'forged.zip');
  writeFileSync(forged, zipSync({ ['objects/' + object.hash]: strToU8('row 0 substituted\n') }));
  await assert.rejects(service(f, [forged]).read({ agentId: f.author.id, objectHash: object.hash }),
    /backup object does not match its identity/);

  // With no backup at all the answer stays explicitly unknown rather than empty.
  const none = await service(f).read({ agentId: f.author.id, objectHash: object.hash });
  assert.equal(none.coverage, 'UNKNOWN');
});

test('a local evidence path is never accepted as a hosted retrieval handle', () => {
  for (const handle of ['http://localhost:8080/objects/abc', 'https://127.0.0.1/objects/abc', 'file:///C:/workspace/objects/abc', 'http://[::1]:9/x'])
    assert.throws(() => assertHostedRetrievalHandle(handle, 'OFFICIAL_ADAPTER'), /not hosted retrieval|provider https address/);
  assert.throws(() => assertHostedRetrievalHandle('https://provider.example/objects/abc', 'LOCAL_WORKSPACE'), /not a hosted retrieval handle/);
  assert.doesNotThrow(() => assertHostedRetrievalHandle('https://provider.example/objects/abc', 'OFFICIAL_ADAPTER'));
});
