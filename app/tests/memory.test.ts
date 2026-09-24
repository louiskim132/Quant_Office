import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync as removeTreeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { LocalCliExecAdapter, type CliSpawn } from '../src/main/local-cli-exec';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot } from '../src/main/locations';
import { mintPipelineBrief, mintPipelineRound, type PipelineMintContext } from '../src/main/pipeline-runner';
import { RESULT_FILE } from '../src/main/local-packet';
import { EvidenceService } from '../src/main/evidence';
import { handleEvidenceCall } from '../src/main/evidence-tool';
import type { Agent, ProviderJob, Request } from '../src/shared/types';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const key = () => randomUUID();
const at = (m: number) => new Date(Date.UTC(2026, 8, 23, 10, 0, 0) + m * 60000).toISOString();
const clock = () => at(5);

const LOCAL_DISPATCH_OPS = [
  'LOCAL_SUBMIT', 'LOCAL_OBSERVE', 'LOCAL_OUTPUT_FETCH', 'LOCAL_CANCEL',
  'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT',
] as const;
const localObservation = (route: 'LOCAL_CLI_EXEC', minutes: number) => ({
  provider: 'claude' as const, identity: 'researcher@example.com', credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const, allowance: [], note: '',
  toolVersion: '2.1.236', transport: route, environment: 'LOCAL_MACHINE',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [
    { operation: 'ACCOUNT_STATUS' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Signed in.', evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture' },
    { operation: 'MODEL_CATALOG' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Catalog read.', evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture' },
    ...LOCAL_DISPATCH_OPS.map(operation => ({
      operation, level: 'TOOL_SUPPORTED' as const, detail: 'Exercised by the fixture.',
      evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture',
      model: 'opus', route,
      ...(operation === 'EFFORT_APPLICATION' ? { effort: 'default' as const } : {}),
      ...(operation === 'DELEGATION_CONTROL' ? { delegation: false } : {}),
      ...(operation === 'TOOL_CONFINEMENT' ? {
        confinement: {
          tools: 'only the fixture packet tools', filesystem: 'the staged snapshot directory',
          network: 'no outbound network', environment: 'a user-launched session on this machine',
        },
      } : {}),
    })),
  ],
  source: 'transport fixture', observedAt: at(minutes),
});

class FakeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly listeners = { exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[], error: [] as ((error: Error) => void)[] };
  constructor(readonly pid: number | undefined = 4321) {}
  kill() { return true; }
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'error', listener: unknown) {
    if (event === 'exit') this.listeners.exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    else this.listeners.error.push(listener as (error: Error) => void);
    return this;
  }
  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) { for (const listener of this.listeners.exit) listener(code, signal); }
}

/** Answers the MCP initialize handshake so declared serena tool surfaces pass the office probe. */
class FakeSerenaChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  constructor(readonly pid = 7777) {
    this.stdin.on('data', () => {
      this.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"serena","version":"1.7.0"}}}\n');
    });
  }
  kill() { return true; }
  on(event: string, listener: (...args: never[]) => void) { return this; }
}

/** Store + one project + one ordinary request — enough for the ledger contract tests. */
function light(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-memory-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch {} removeTreeSync(root, { recursive: true, force: true }); });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const request = store.execute({ type: 'request.create', idempotencyKey: key(), projectId: project.id, name: 'Study it', hypothesis: 'Study the thing.', workType: 'OTHER', mode: 'SINGLE', leadAgentId: null, participantIds: [] }).requests![0];
  return { root, store, project, request };
}

interface Heavy {
  root: string; store: OfficeStore; project: { id: string };
  agents: Record<string, Agent>;
  ctx: PipelineMintContext; controller: AssignmentController; sessionsRoot: string;
}

/** The pipeline fixture — mints real hop assignments so seat authorization binds to records. */
async function heavy(t: any): Promise<Heavy> {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-memory-pipe-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  const execAdapter: { current?: LocalCliExecAdapter } = {};
  t.after(() => { execAdapter.current?.disposeAll(); try { store.close(); } catch {} removeTreeSync(root, { recursive: true, force: true }); });
  const sessionsRoot = path.join(root, 'local-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const agents: Record<string, Agent> = {};
  for (const role of ['DIRECTOR', 'PM_A', 'PM_B', 'PM_C', 'PM_D', 'WORKER'] as const) {
    const agent: Agent = { id: randomUUID(), name: `${role} agent`, provider: 'claude', model: 'opus', team: 'Research', role, instructions: '', effort: 'default',
      account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL', localRoute: 'LOCAL_CLI_EXEC' };
    store.confirmAgentBinding({ observation: localObservation('LOCAL_CLI_EXEC', 0), agent });
    agents[role] = agent;
  }
  const spawn: CliSpawn = () => new FakeChild() as never;
  const exec = new LocalCliExecAdapter(() => sessionsRoot, provider => `${provider}.exe`, clock, undefined, spawn,
    () => ({ TEST_ENV: 'scrubbed' }), undefined, undefined, agentId => store.snapshot().agents.find(a => a.id === agentId)?.provider,
    undefined, () => new FakeSerenaChild() as never, 60);
  execAdapter.current = exec;
  const local = new LocalSessionRouter(id => store.localSessionForJob(id), { FLAT_PACKET: exec, PROJECT_WORKTREE: exec }, 'LOCAL_CLI_EXEC');
  const outputs = new OutputService(store, root);
  const controller = new AssignmentController(store, local, clock, () => Promise.resolve([]), undefined, undefined, undefined,
    outputs.storeBytes, undefined,
    ref => ref.route ? (ref.route === 'LOCAL_CLI_EXEC' ? local : undefined)
      : ref.agent?.execution === 'LOCAL' ? local : undefined,
    undefined, outputs.readBytes);
  const ctx: PipelineMintContext = {
    store,
    snapshotFor: req => prepareInputSnapshot({ store, objectRoot: root, stagingRoot: path.join(root, 'staging'), projectId: req.projectId, requestId: req.id, requestRevision: req.revision, objective: req.objective }),
    prepare: input => controller.prepare(input),
  };
  return { root, store, project, agents, ctx, controller, sessionsRoot };
}

const jobFor = (f: Heavy, assignmentId: string): ProviderJob => f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignmentId)!;
const requestOf = (f: Heavy, requestId: string): Request => f.store.snapshot({ history: false }).requests!.find(item => item.id === requestId)!;

/** Completes one hop's job through the real launch + receipt path. */
async function completeHop(f: Heavy, assignmentId: string, outputName: string): Promise<void> {
  await f.controller.handoff(assignmentId);
  const job = jobFor(f, assignmentId);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: `outputs/${outputName}`, sha256: sha(`${outputName} bytes`), bytes: Buffer.byteLength(`${outputName} bytes`) };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, `outputs/${outputName}`), `${outputName} bytes`);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ schema: 'office-local-result@2', jobId: job.id, assignmentId, attemptId: bound.attemptId, packetHash: bound.packetHash, sequence: 1, state: 'COMPLETED', detail: 'Done.', outputs: [output] }));
  await f.controller.observe(assignmentId);
  assert.equal(jobFor(f, assignmentId).state, 'COMPLETED', jobFor(f, assignmentId).detail);
}

/** Mints the full planning round — returns the request and every hop assignment. */
async function mintedRound(f: Heavy) {
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Plan it', hypothesis: 'Plan the thing.', workType: 'PLANNING', mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] });
  let request = f.store.snapshot({ history: false }).requests!.find(item => item.name === 'Plan it')!;
  request = f.store.execute({ type: 'request.start', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  await mintPipelineBrief(f.ctx, request);
  request = requestOf(f, request.id);
  await completeHop(f, request.pipeline!.briefAssignmentId!, 'brief.txt');
  request = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  await mintPipelineRound(f.ctx, request);
  request = requestOf(f, request.id);
  const hops = f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === request.id && item.pipelineKey);
  return { request, hops };
}

const note = (projectId: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'memory.finding.note' as const, idempotencyKey: key(), projectId, kind: 'NOTE' as const, title, body: `body for ${title}`, ...extra });

test('user notes land append-only, validate evidence refs, and supersede forward', async t => {
  const { store, project, request } = light(t);
  const state = store.execute(note(project.id, 'first note', { requestId: request.id, evidenceRefs: [{ kind: 'REQUEST', id: request.id }] }));
  const finding = state.findings![0];
  assert.equal(finding.kind, 'NOTE');
  assert.equal(finding.createdBy.surface, 'USER');
  assert.equal(finding.requestId, request.id);
  // A ref outside this project is refused — memory anchors to stored evidence only.
  assert.throws(() => store.execute(note(project.id, 'bad ref', { evidenceRefs: [{ kind: 'REQUEST', id: randomUUID() }] })), /does not exist in this project/);
  assert.throws(() => store.execute(note(project.id, 'foreign', { requestId: randomUUID() })), /outside this project/);
  // Supersession marks the old record; the original row is never rewritten.
  const after = store.execute(note(project.id, 'corrected note', { requestId: request.id, supersedesFindingId: finding.id }));
  const prior = after.findings!.find(item => item.id === finding.id)!;
  const next = after.findings!.find(item => item.title === 'corrected note')!;
  assert.equal(prior.supersededById, next.id);
  assert.equal(prior.body, 'body for first note');
  // Sideways supersession is refused — the chain only moves forward.
  assert.throws(() => store.execute(note(project.id, 'third', { supersedesFindingId: finding.id })), /already superseded/);
});

test('recordMemoryFinding dedups identical re-ingest and relationships settle append-only', async t => {
  const { store, project, request } = light(t);
  const author = { surface: 'AGENT_SESSION' as const, receiptHash: sha('receipt-1') };
  const one = store.recordMemoryFinding({ projectId: project.id, requestId: request.id, assignmentId: null, kind: 'RESULT', title: 'alpha beats beta', body: 'under the fixture', evidenceRefs: [], createdBy: author });
  assert.equal(one.created, true);
  // Receipt replay cannot duplicate — the same surface + receipt + title resolves to the row.
  const replay = store.recordMemoryFinding({ projectId: project.id, requestId: request.id, assignmentId: null, kind: 'RESULT', title: 'alpha beats beta', body: 'under the fixture', evidenceRefs: [], createdBy: author });
  assert.equal(replay.created, false);
  assert.equal(replay.finding.id, one.finding.id);
  const two = store.recordMemoryFinding({ projectId: project.id, requestId: request.id, assignmentId: null, kind: 'OBSERVATION', title: 'beta lags', body: 'x', evidenceRefs: [], createdBy: author });
  // Endpoints must exist in this project; self-links and duplicates are refused.
  assert.throws(() => store.proposeMemoryRelationship({ projectId: project.id, fromFindingId: one.finding.id, toFindingId: one.finding.id, kind: 'SUPPORTS', createdBy: author }), /relate to itself/);
  assert.throws(() => store.proposeMemoryRelationship({ projectId: project.id, fromFindingId: one.finding.id, toFindingId: randomUUID(), kind: 'SUPPORTS', createdBy: author }), /findings that exist in this project/);
  const link = store.proposeMemoryRelationship({ projectId: project.id, fromFindingId: two.finding.id, toFindingId: one.finding.id, kind: 'SUPPORTS', createdBy: author });
  assert.equal(link.relationship.status, 'PROPOSED');
  const dup = store.proposeMemoryRelationship({ projectId: project.id, fromFindingId: two.finding.id, toFindingId: one.finding.id, kind: 'SUPPORTS', createdBy: author });
  assert.equal(dup.created, false);
  store.settleMemoryRelationship({ relationshipId: link.relationship.id, status: 'CONFIRMED' });
  const settled = store.snapshot({ history: false }).relationships!.find(item => item.id === link.relationship.id)!;
  assert.equal(settled.status, 'CONFIRMED');
  assert.throws(() => store.settleMemoryRelationship({ relationshipId: link.relationship.id, status: 'REFUTED' }), /append-only/);
});

test('search is bounded, project-scoped, and ranks live findings above superseded ones', async t => {
  const { store, project } = light(t);
  const other = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Beta', mandate: 'm', budgetCents: 0 }).projects.find(item => item.id !== project.id)!;
  const mk = (title: string, extra: Record<string, unknown> = {}) => store.execute(note(project.id, title, extra));
  mk('momentum decays');
  const old = store.snapshot({ history: false }).findings!.find(item => item.title === 'momentum decays')!;
  mk('momentum persists', { supersedesFindingId: old.id });
  store.execute(note(other.id, 'momentum in beta'));
  const hits = store.searchMemoryFindings(project.id, 'momentum');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, 'momentum persists');
  assert.equal(hits[1].title, 'momentum decays');
  assert.equal(store.searchMemoryFindings(project.id, 'zzzzz').length, 0);
  assert.equal(store.searchMemoryFindings(project.id, 'x').length, 0); // sub-2-char terms query nothing
  // The hard ceiling caps a flood of results.
  for (let index = 0; index < 30; index++) mk(`overflow finding ${index}`);
  assert.equal(store.searchMemoryFindings(project.id, 'overflow', 25).length, 25);
  assert.equal(store.searchMemoryFindings(project.id, 'overflow', 99).length, 25);
});

test('a COMPLETED receipt’s findings/links ingest into the ledger through the observe path', async t => {
  const f = await heavy(t);
  const { request, hops } = await mintedRound(f);
  // The brief hop already ran inside mintedRound — pick the first minted hop whose
  // declared predecessors are all COMPLETED (the same Kahn rule completeRound uses).
  const done = new Set(hops.filter(item => jobFor(f, item.id).state === 'COMPLETED').map(item => item.id));
  const hop = hops.find(item => !done.has(item.id) && (item.dependsOn ?? []).every(dep => done.has(dep)))!;
  assert.ok(hop, 'a minted round always has a dependency-ready hop after the brief');
  // Complete the hop with a receipt carrying the memory sections — one good finding citing its
  // own output artifact, one malformed entry, and a link chaining through the receipt ref.
  await f.controller.handoff(hop.id);
  const job = jobFor(f, hop.id);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: 'outputs/brief.txt', sha256: sha('brief bytes'), bytes: Buffer.byteLength('brief bytes') };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs/brief.txt'), 'brief bytes');
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({
    schema: 'office-local-result@2', jobId: job.id, assignmentId: hop.id, attemptId: bound.attemptId,
    packetHash: bound.packetHash, sequence: 1, state: 'COMPLETED', detail: 'Done.', outputs: [output],
    findings: [
      { ref: 'f1', kind: 'OBSERVATION', title: 'brief noted a constraint', body: 'the packet bound the scope', evidenceRefs: [{ kind: 'ASSIGNMENT', id: hop.id }] },
      { ref: 'f2', kind: 'RESULT', title: 'brief kept it bounded', body: 'scope held' },
      { kind: 'RESULT', title: 'ghost evidence', body: 'x', evidenceRefs: [{ kind: 'REQUEST', id: randomUUID() }] },
    ],
    links: [{ from: 'f2', to: 'f1', kind: 'SUPPORTS' }],
  }));
  await f.controller.observe(hop.id);
  assert.equal(jobFor(f, hop.id).state, 'COMPLETED', jobFor(f, hop.id).detail);
  const findings = f.store.snapshot({ history: false }).findings ?? [];
  const recorded = findings.filter(item => item.assignmentId === hop.id);
  assert.equal(recorded.length, 2);
  const f1 = recorded.find(item => item.title === 'brief noted a constraint')!;
  const f2 = recorded.find(item => item.title === 'brief kept it bounded')!;
  assert.equal(f1.createdBy.surface, 'AGENT_SESSION');
  assert.equal(f1.createdBy.receiptHash, f.store.localSessionForJob(job.id)!.lastReceipt!.hash);
  // The link proposal resolved both refs to the minted findings and landed PROPOSED;
  // the ghost-evidence entry was skipped, not stored.
  const links = (f.store.snapshot({ history: false }).relationships ?? []).filter(item => item.createdBy.surface === 'AGENT_SESSION');
  assert.equal(links.length, 1);
  assert.equal(links[0].fromFindingId, f2.id);
  assert.equal(links[0].toFindingId, f1.id);
  assert.equal(links[0].status, 'PROPOSED');
  const journal = f.store.snapshot({ history: false }).jobEvents!.filter(item => item.jobId === job.id);
  assert.ok(journal.some(item => item.text.includes('2 findings recorded') && item.text.includes('1 malformed')));
});

test('memoryGraph derives nodes and edges from durable records only', async t => {
  const { store, project } = light(t);
  const author = { surface: 'OFFICE' as const };
  const a = store.recordMemoryFinding({ projectId: project.id, requestId: null, assignmentId: null, kind: 'HYPOTHESIS', title: 'h1', body: 'x', evidenceRefs: [], createdBy: author });
  const b = store.recordMemoryFinding({ projectId: project.id, requestId: null, assignmentId: null, kind: 'RESULT', title: 'r1', body: 'x', evidenceRefs: [], createdBy: author });
  const link = store.proposeMemoryRelationship({ projectId: project.id, fromFindingId: b.finding.id, toFindingId: a.finding.id, kind: 'SUPPORTS', createdBy: author });
  const graph = store.memoryGraph(project.id);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].relationshipId, link.relationship.id);
  assert.equal(graph.edges[0].status, 'PROPOSED');
  assert.equal(graph.nodes.every(node => !node.superseded), true);
});

test('user-proposed links, FINDING refs and the bounded digest projection', async t => {
  const { store, project, request } = light(t);
  store.execute(note(project.id, 'anchor finding', { requestId: request.id }));
  const anchor = store.snapshot({ history: false }).findings![0];
  // A finding may cite another finding — FINDING refs resolve against the same project.
  store.execute(note(project.id, 'cites the anchor', { evidenceRefs: [{ kind: 'FINDING', id: anchor.id }] }));
  assert.throws(() => store.execute(note(project.id, 'foreign finding ref', { evidenceRefs: [{ kind: 'FINDING', id: randomUUID() }] })), /finding that does not exist in this project/);
  const citer = store.snapshot({ history: false }).findings!.find(item => item.title === 'cites the anchor')!;
  // The user proposes a link through the command surface — PROPOSED, USER provenance.
  store.execute({ type: 'memory.relationship.propose', idempotencyKey: key(), projectId: project.id, fromFindingId: citer.id, toFindingId: anchor.id, kind: 'REFINES', note: 'sharpens it' });
  const link = store.snapshot({ history: false }).relationships![0];
  assert.equal(link.status, 'PROPOSED');
  assert.equal(link.createdBy.surface, 'USER');
  assert.throws(() => store.execute({ type: 'memory.relationship.propose', idempotencyKey: key(), projectId: project.id, fromFindingId: citer.id, toFindingId: anchor.id, kind: 'REFINES' }), /already exists/);
  assert.throws(() => store.execute({ type: 'memory.relationship.propose', idempotencyKey: key(), projectId: project.id, fromFindingId: citer.id, toFindingId: citer.id, kind: 'RELATES' }), /relate to itself/);
  // The digest projects the ledger deterministically — superseded marked, counts bounded.
  const digest = store.memoryDigest(project.id);
  assert.equal(digest.findings.length, 2);
  assert.equal(digest.links.length, 1);
  assert.equal(digest.links[0].from, citer.id);
  assert.equal(digest.findings.every(f => !f.superseded), true);
  store.execute(note(project.id, 'anchor corrected', { supersedesFindingId: anchor.id }));
  assert.equal(store.memoryDigest(project.id).findings.find(f => f.id === anchor.id)!.superseded, true);
});

test('memorySearch is authorized only at the director’s synthesis seats', async t => {
  const f = await heavy(t);
  const { request, hops } = await mintedRound(f);
  const brief = hops.find(item => item.pipelineKey === 'plan-brief')!;
  const synthesis = hops.find(item => item.pipelineKey === 'plan-synthesis')!;
  // Non-pipeline and non-synthesis seats are refused; only plan-synthesis is authorized.
  assert.equal(f.store.authorizeMemorySearch(randomUUID()).ok, false);
  const briefAuth = f.store.authorizeMemorySearch(brief.id);
  assert.equal(briefAuth.ok, false);
  assert.match((briefAuth as { reason: string }).reason, /plan-brief/);
  assert.equal(f.store.authorizeMemorySearch(synthesis.id).ok, true);
  // End-to-end through the evidence drop-box frame: a caller on the brief seat is refused
  // with a recorded denial; the synthesis seat reads the bounded result set.
  const service = new EvidenceService(f.store, f.root);
  const caller = (assignmentId?: string) => ({ agentId: f.agents.DIRECTOR.id, projectId: f.project.id, requestId: request.id, ...(assignmentId ? { assignmentId } : {}) });
  f.store.execute(note(f.project.id, 'momentum caveat'));
  const denied = await handleEvidenceCall(service, caller(brief.id), { op: 'memorySearch', args: { text: 'momentum' } });
  assert.ok('refused' in denied);
  assert.ok(denied.refused!.denialReceiptId);
  const noSeat = await handleEvidenceCall(service, caller(), { op: 'memorySearch', args: { text: 'momentum' } });
  assert.ok('refused' in noSeat);
  const allowed = await handleEvidenceCall(service, caller(synthesis.id), { op: 'memorySearch', args: { text: 'momentum' } });
  assert.ok('result' in allowed);
  const result = (allowed as { result: { returned: number; findings: { title: string }[] } }).result;
  assert.equal(result.returned, 1);
  assert.equal(result.findings[0].title, 'momentum caveat');
  // Malformed calls and unknown ops refuse without throwing.
  assert.ok('refused' in await handleEvidenceCall(service, caller(synthesis.id), { op: 'memorySearch', args: { text: '' } }));
  assert.ok('refused' in await handleEvidenceCall(service, caller(synthesis.id), { op: 'wipeLedger', args: {} }));
});
