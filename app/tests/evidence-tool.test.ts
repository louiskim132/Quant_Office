import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { strToU8 } from 'fflate';
import { OfficeStore } from '../src/core/store.js';
import { EvidenceService } from '../src/main/evidence.js';
import { EVIDENCE_ARGS, handleEvidenceCall, handleEvidenceFrame } from '../src/main/evidence-tool.js';
import { resultContractV2 } from '../src/main/local-packet.js';
import type { Agent, InputSnapshot } from '../src/shared/types.js';

const key = () => randomUUID();
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * Same workspace shape as evidence.test.ts: one project, one granted agent and one outsider, with
 * objects reachable through a project-level grant and a request-scoped grant.
 */
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-evidence-tool-'));
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

  const putObject = (body: string) => {
    const data = strToU8(body);
    const hash = sha256(data);
    const file = path.join(workspace, 'objects', hash.slice(0, 2), hash);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return { hash, bytes: data.length };
  };
  const artifact = (projectId: string, name: string, body: string) => {
    const object = putObject(body);
    store.addArtifact({ id: randomUUID(), projectId, experimentId: null, name, sha256: object.hash, size: object.bytes, kind: 'RESULT',
      classification: 'USER_ATTESTED', status: 'QUARANTINED', createdAt: new Date().toISOString(), mediaType: 'text/plain', note: 'fixture' });
    return object;
  };
  const snapshotObject = (requestId: string | null, projectId: string, name: string, body: string) => {
    const object = putObject(body);
    const snapshot: InputSnapshot = { objectsStored: true, id: randomUUID(), projectId, requestId, locationRevision: 0, requestRevision: null,
      route: 'GENERATED_REQUEST_ONLY', files: [{ path: name, bytes: object.bytes, sha256: object.hash }], generated: [], totalBytes: object.bytes,
      manifestHash: sha256(name), stagingCommit: '', stagingPath: '', warnings: [], provenance: 'OFFICE_STAGED', createdAt: new Date().toISOString() };
    store.recordInputSnapshot(snapshot);
    return object;
  };
  const caller = { agentId: author.id, projectId: alpha.id, requestId: request.id };
  return { root, workspace, store, alpha, beta, author, outsider, request, artifact, snapshotObject, caller };
}

const service = (f: ReturnType<typeof fixture>) => new EvidenceService(f.store, f.workspace);

test('an in-grant query returns a bounded page, a declared total, and a cursor that continues exactly once', async t => {
  const f = fixture(t);
  f.artifact(f.alpha.id, 'run.log', ['row 0 HIT', 'row 1 clean', 'row 2 HIT', 'row 3 HIT', 'row 4 HIT'].join('\n') + '\n');
  const evidence = service(f);

  const first = await handleEvidenceCall(evidence, f.caller, { op: 'queryEvidence', args: { pattern: 'HIT', limit: 3 } });
  assert.ok('result' in first && 'matches' in first.result);
  assert.equal(first.result.returned, 3);
  assert.equal(first.result.total, 4);
  assert.equal(first.result.coverage, 'PARTIAL');
  assert.ok(first.result.nextCursor);
  assert.ok(!first.result.nextCursor.includes(':'), 'the cursor is opaque, not the raw hash:line form');
  assert.ok(first.result.receiptId);

  const second = await handleEvidenceCall(evidence, f.caller, { op: 'queryEvidence', args: { pattern: 'HIT', limit: 3, cursor: first.result.nextCursor } });
  assert.ok('result' in second && 'matches' in second.result);
  assert.equal(second.result.returned, 1);
  assert.equal(second.result.total, 4);
  assert.equal(second.result.nextCursor, null);
  assert.equal(second.result.coverage, 'COMPLETE');

  const lines = [...first.result.matches, ...second.result.matches].map(m => m.line);
  assert.deepEqual(lines.sort(), [1, 3, 4, 5], 'every match returned exactly once across the pages');

  // The accepted calls are on record as ordinary query receipts.
  const receipts = evidence.receiptsFor(f.author.id);
  assert.equal(receipts.filter(r => r.kind === 'SEARCH').length, 2);
  assert.ok(receipts.every(r => r.returned > 0 && !r.parameters.includes('denied')));
});

test('an out-of-grant call is refused before bytes leave, and the denial is receipted', async t => {
  const f = fixture(t);
  f.artifact(f.alpha.id, 'mine.log', 'alpha secret\n');
  const theirs = f.artifact(f.beta.id, 'theirs.log', 'beta secret\n');
  const evidence = service(f);

  const denied = await handleEvidenceCall(evidence, f.caller, { op: 'readEvidence', args: { objectHash: theirs.hash } });
  assert.ok('refused' in denied);
  assert.equal(denied.refused.reason, 'OUT_OF_SCOPE');
  assert.match(denied.refused.detail, /not available to this agent/);
  assert.ok(!denied.refused.detail.includes(theirs.hash), 'a refusal must not echo back object identity it was asked about');
  assert.ok(!('lines' in denied) && !('result' in denied), 'a refusal carries no result bytes');
  assert.ok(denied.refused.denialReceiptId);

  const denial = evidence.receiptsFor(f.author.id).find(r => r.id === denied.refused.denialReceiptId);
  assert.ok(denial, 'the denial is recorded through the receipt machinery');
  assert.equal(denial.kind, 'READ');
  assert.equal(denial.returned, 0);
  assert.equal(denial.coverage, 'UNKNOWN');
  assert.deepEqual(denial.objectHashes, []);
  assert.match(denial.parameters, /denied/);

  // An empty-scope query is refused the same way rather than answering "no matches".
  const empty = await handleEvidenceCall(evidence, f.caller, { op: 'queryEvidence', args: { pattern: 'x', objectHashes: [theirs.hash] } });
  assert.ok('refused' in empty);
  assert.equal(empty.refused.reason, 'OUT_OF_SCOPE');
  assert.ok(empty.refused.denialReceiptId);

  // And a caller with no grants at all gets the same refusal — no project probing.
  const outsider = await handleEvidenceCall(evidence, { agentId: f.outsider.id, projectId: f.alpha.id, requestId: f.request.id },
    { op: 'queryEvidence', args: { pattern: 'secret' } });
  assert.ok('refused' in outsider);
  assert.equal(outsider.refused.reason, 'OUT_OF_SCOPE');
});

test('malformed and cross-scope cursors are refused before any service call', async t => {
  const f = fixture(t);
  f.artifact(f.alpha.id, 'run.log', 'a HIT\nb HIT\nc HIT\nd HIT\n');
  const evidence = service(f);
  const first = await handleEvidenceCall(evidence, f.caller, { op: 'queryEvidence', args: { pattern: 'HIT', limit: 2 } });
  assert.ok('result' in first && first.result.nextCursor);
  const cursor = first.result.nextCursor;

  const malformed = await handleEvidenceCall(evidence, f.caller, { op: 'queryEvidence', args: { pattern: 'HIT', cursor: '{broken' } });
  assert.ok('refused' in malformed);
  assert.equal(malformed.refused.reason, 'MALFORMED');
  assert.match(malformed.refused.detail, /malformed/);

  // Same caller, different query text: the cursor does not belong to this call.
  const rebound = await handleEvidenceCall(evidence, f.caller, { op: 'queryEvidence', args: { pattern: 'OTHER', cursor } });
  assert.ok('refused' in rebound);
  assert.equal(rebound.refused.reason, 'CURSOR_MISMATCH');

  // Same arguments, different agent: the cursor cannot be carried across callers.
  const stolen = await handleEvidenceCall(evidence, { agentId: f.outsider.id, projectId: f.alpha.id, requestId: f.request.id },
    { op: 'queryEvidence', args: { pattern: 'HIT', cursor } });
  assert.ok('refused' in stolen);
  assert.equal(stolen.refused.reason, 'CURSOR_MISMATCH');

  // A read cursor cannot be replayed onto a different object either.
  const second = f.artifact(f.alpha.id, 'other.log', 'x\ny\nz\n');
  const read = await handleEvidenceCall(evidence, f.caller, { op: 'readEvidence', args: { objectHash: second.hash, limit: 1 } });
  assert.ok('result' in read && read.result.nextCursor);
  const replay = await handleEvidenceCall(evidence, f.caller, { op: 'readEvidence', args: { objectHash: sha256('other'), cursor: read.result.nextCursor } });
  assert.ok('refused' in replay);
  assert.equal(replay.refused.reason, 'CURSOR_MISMATCH');

  // Refusals still land in the denial record.
  assert.ok([malformed, rebound, stolen, replay].every(r => 'refused' in r && r.refused.denialReceiptId));
});

test('a limit above the cap is clamped, and the total still declares the full count', async t => {
  const f = fixture(t);
  const body = Array.from({ length: 150 }, (_, i) => `row ${i} WIDE`).join('\n') + '\n';
  f.artifact(f.alpha.id, 'wide.log', body);
  const evidence = service(f);

  const page = await handleEvidenceCall(evidence, f.caller, { op: 'queryEvidence', args: { pattern: 'WIDE', limit: 200 } });
  assert.ok('result' in page && 'matches' in page.result);
  assert.equal(page.result.returned, 100);
  assert.equal(page.result.total, 150);
  assert.equal(page.result.omitted, 50);
  assert.ok(page.result.nextCursor);
});

test('readEvidence pages one object and reports UNKNOWN_TOTAL when bytes are missing', async t => {
  const f = fixture(t);
  const object = f.artifact(f.alpha.id, 'lines.log', Array.from({ length: 7 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const evidence = service(f);

  const first = await handleEvidenceCall(evidence, f.caller, { op: 'readEvidence', args: { objectHash: object.hash, limit: 5 } });
  assert.ok('result' in first && 'lines' in first.result);
  assert.equal(first.result.returned, 5);
  assert.equal(first.result.total, 7);
  assert.ok(first.result.nextCursor);
  const second = await handleEvidenceCall(evidence, f.caller, { op: 'readEvidence', args: { objectHash: object.hash, cursor: first.result.nextCursor } });
  assert.ok('result' in second && 'lines' in second.result);
  assert.deepEqual(second.result.lines, ['line 5', 'line 6']);
  assert.equal(second.result.nextCursor, null);

  // A recorded object whose bytes are absent declares UNKNOWN_TOTAL rather than pretending zero lines.
  const ghost = f.snapshotObject(f.request.id, f.alpha.id, 'ghost.txt', 'never stored\n');
  rmSync(path.join(f.workspace, 'objects', ghost.hash.slice(0, 2), ghost.hash), { force: true });
  const missing = await handleEvidenceCall(evidence, f.caller, { op: 'readEvidence', args: { objectHash: ghost.hash } });
  assert.ok('result' in missing && 'lines' in missing.result);
  assert.equal(missing.result.total, 'UNKNOWN_TOTAL');
  assert.equal(missing.result.coverage, 'UNKNOWN');
});

test('stagePacket returns identities, a declared total and no bytes', async t => {
  const f = fixture(t);
  f.artifact(f.alpha.id, 'a.log', 'one\ntwo\n');
  f.artifact(f.alpha.id, 'b.log', 'three\n');
  const evidence = service(f);

  const packet = await handleEvidenceCall(evidence, f.caller,
    { op: 'stagePacket', args: { subjectId: randomUUID(), stage: 'S2', maxObjects: 200 } });
  assert.ok('result' in packet && 'objects' in packet.result);
  assert.equal(packet.result.returned, 2, 'maxObjects clamps at the surface cap of 100 but both objects fit');
  assert.equal(packet.result.total, 2);
  assert.equal(packet.result.nextCursor, null);
  assert.equal(JSON.stringify(packet.result).includes('one\ntwo'), false, 'a packet carries identities, never contents');
  assert.ok(packet.result.receiptId);
});

test('handleEvidenceFrame turns one JSONL line into one keyed response line', async t => {
  const f = fixture(t);
  const object = f.artifact(f.alpha.id, 'run.log', 'row 0\nrow 1\n');
  const evidence = service(f);

  const ok = JSON.parse(await handleEvidenceFrame(evidence, f.caller,
    JSON.stringify({ id: 'frame-1', op: 'readEvidence', args: { objectHash: object.hash, limit: 1 } })));
  assert.equal(ok.id, 'frame-1');
  assert.ok(ok.result);
  assert.equal(ok.result.returned, 1);
  assert.equal(ok.result.total, 2);

  const refused = JSON.parse(await handleEvidenceFrame(evidence, f.caller,
    JSON.stringify({ id: 'frame-2', op: 'readEvidence', args: { objectHash: sha256('nope') } })));
  assert.equal(refused.id, 'frame-2');
  assert.ok(refused.refused);
  assert.equal(refused.refused.reason, 'OUT_OF_SCOPE');
  assert.ok(refused.refused.denialReceiptId);

  const broken = JSON.parse(await handleEvidenceFrame(evidence, f.caller, '{not json'));
  assert.equal(broken.id, null);
  assert.equal(broken.refused.reason, 'MALFORMED');

  const noId = JSON.parse(await handleEvidenceFrame(evidence, f.caller, JSON.stringify({ op: 'queryEvidence', args: { pattern: 'x' } })));
  assert.equal(noId.id, null);
  assert.equal(noId.refused.reason, 'MALFORMED');
});

test('a malformed caller or call is refused without inventing a receipt identity', async t => {
  const f = fixture(t);
  const evidence = service(f);

  const badCaller = await handleEvidenceCall(evidence, { agentId: 'not-a-uuid', projectId: f.alpha.id, requestId: f.request.id },
    { op: 'queryEvidence', args: { pattern: 'x' } });
  assert.ok('refused' in badCaller);
  assert.equal(badCaller.refused.reason, 'MALFORMED');
  assert.equal(badCaller.refused.denialReceiptId, null);

  const badOp = await handleEvidenceCall(evidence, f.caller, { op: 'deleteEverything', args: {} });
  assert.ok('refused' in badOp);
  assert.equal(badOp.refused.reason, 'MALFORMED');

  const badArgs = await handleEvidenceCall(evidence, f.caller, { op: 'readEvidence', args: { objectHash: 'short' } });
  assert.ok('refused' in badArgs);
  assert.equal(badArgs.refused.reason, 'MALFORMED');
  // The caller was well-formed, so even the malformed call is recorded as an attempt.
  assert.ok(badArgs.refused.denialReceiptId);
});

test('a frame written exactly as the contract documents each op is served, not refused MALFORMED', async t => {
  const f = fixture(t);
  const object = f.artifact(f.alpha.id, 'run.log', 'row 0 HIT\nrow 1 clean\n');
  const evidence = service(f);
  const contract = resultContractV2({ evidenceSurface: true });
  const documented = [...contract.matchAll(/^- `(\w+)` (\{.*\})$/gm)].map(m => [m[1], m[2]] as const);
  assert.deepEqual(documented.map(([op]) => op).sort(), Object.keys(EVIDENCE_ARGS).sort(), 'every op is documented');
  for (const [op, shape] of documented) {
    // Fill the documented shape the way an agent would: drop the optional keys, then put real values in the placeholders.
    const args = shape
      .replace(/,"\w+"\?:(\[[^\]]*\]|"[^"]*"|<[^>]*>)/g, '')
      .replace(/"<64-hex[^"]*>"/g, `"${object.hash}"`)
      .replace(/"<uuid>"/g, `"${randomUUID()}"`)
      .replace(/"S0"\.\."S10"/g, '"S1"')
      .replace(/"<[^"]*>"/g, '"HIT"');
    const line = await handleEvidenceFrame(evidence, { ...f.caller, assignmentId: randomUUID() }, `{"id":"${op}","op":"${op}","args":${args}}`);
    const response = JSON.parse(line);
    assert.equal(response.id, op);
    assert.notEqual(response.refused?.reason, 'MALFORMED', `${op} as documented (${args}) must parse: ${line}`);
  }
  const hit = JSON.parse(await handleEvidenceFrame(evidence, f.caller, '{"id":"q1","op":"queryEvidence","args":{"pattern":"HIT"}}'));
  assert.equal(hit.result.returned, 1, 'the prompt example returns the match');
});

test('a MALFORMED refusal names the expected args, so the next frame can correct a guessed key', async t => {
  const f = fixture(t);
  const evidence = service(f);
  // The exact frames an analyst seat guessed in the 2026-09-25 live round.
  for (const [line, op] of [
    ['{"id":"a","op":"queryEvidence","args":{"name":"analysis-falsify"}}', 'queryEvidence'],
    ['{"id":"b","op":"queryEvidence","args":{"text":"analysis-falsify"}}', 'queryEvidence'],
    ['{"id":"c","op":"memorySearch","args":{"query":"analysis-falsify"}}', 'memorySearch'],
  ] as const) {
    const response = JSON.parse(await handleEvidenceFrame(evidence, f.caller, line));
    assert.equal(response.refused.reason, 'MALFORMED');
    assert.ok(response.refused.detail.includes(EVIDENCE_ARGS[op]), `the refusal carries ${op}'s args`);
  }
});
