import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityEvidence, Provider, ProviderJob } from '../shared/types.js';
import type { LocalSessionRecord } from '../shared/local-session.js';
import { safeEntry } from './artifacts.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';
import { GuardedLocalFileIO, type LocalFileIO } from './local-session-files.js';
import { AGENTS_FILE, CONTRACT_FILE, INPUTS_DIR, LocalMailboxAdapter, PACKET_FILE, RESULT_FILE, packetAgents, resultContract } from './local-session.js';
import { prepareLocalPacket } from './local-packet.js';
import { createWorktree, ensureRepo, resolveHeadCommit, worktreesRoot } from './local-worktree-repo.js';

const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
/** The office's project repos are sha1 — a recorded seed is always a full 40-hex commit id. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The shared-root worktree lane for local sessions (one provider project, session per worktree).
 *
 * Bound submissions write the same v2 packet the flat lane writes — through prepareLocalPacket and
 * the guarded I/O boundary — but into a detached git worktree of the office project's session repo
 * instead of a flat directory. The binding's seedCommit is the worktree's seed exactly as recorded:
 * git worktree add receives the explicit 40-hex commit, so a later HEAD move can never drift the
 * session's recorded base (defect F08). An unbound submission still writes the legacy v1 packet;
 * its seed is resolved once via resolveHeadCommit and named in the returned detail — honest about
 * being pinned to a resolved commit while no binding exists to record it.
 *
 * Composition, not duplication: a configured LocalMailboxAdapter per project answers every
 * read-side call (observe, cancel, fetch and the observe/cancel evidence hooks) with the
 * identical session-dir boundary rule — a recorded externalId stays a single safe name under
 * that project's worktrees root and can never point outside it. The resolved binding selects the
 * project repo for bound jobs and rides into the inner adapter, so v2 receipts are validated
 * against the binding's own storage path, attempt identity and packet hash.
 *
 * The scope this lane honestly supports is the routine-work lane: sibling session worktrees of
 * the same office project are readable from one session. Sealed reviews keep the isolated lane.
 * Route stays LOCAL_MAILBOX; which jobs get this lane is decided where the adapter is wired.
 */
export class LocalWorktreeMailboxAdapter implements ProviderAdapter {
 readonly route = 'LOCAL_MAILBOX' as const;
 // The packet contract is provider-agnostic for the same reason the base adapter's is: the user
 // runs whichever local CLI on the directory, and evidence stays office-observed regardless.
 readonly providers: readonly Provider[] = ['devin','claude','openai'];
 // What this adapter writes when a persisted binding is present: v2 packets with attempt binding.
 // An unbound submit still writes the legacy v1 packet and can never produce a v2 binding.
 readonly packetVersion = 2;
 constructor(
  private readonly reposRoot: () => string,
  private readonly now: () => string = () => new Date().toISOString(),
  private readonly io: LocalFileIO = new GuardedLocalFileIO(),
 ) {}

 /** The base adapter configured so its session root IS one project's worktrees root. */
 private inner(projectId: string): LocalMailboxAdapter {
  return new LocalMailboxAdapter(() => worktreesRoot(this.reposRoot(), projectId), this.now, this.io);
 }

 async submit(context: SubmitContext): Promise<SubmitResult> {
  if (!context.snapshot.stagingPath) throw new Error('Prepare the request inputs before dispatching.');
  if (context.localSession) {
   // Bound path (QO-LOCAL-REV §9): the persisted binding is the authority — the packet directory
   // IS a worktree created from the recorded seed, and the v2 write goes through the same
   // prepareLocalPacket the flat lane uses. The caller persists the packet hash on the binding.
   const binding = context.localSession;
   if (binding.layout !== 'PROJECT_WORKTREE')
    throw new Error(`The worktree lane received a ${binding.layout} binding — the router dispatched wrong; bound submits here require a PROJECT_WORKTREE record.`);
   // Worktree creation is name-scoped: the storage path is one directory name under the project's
   // worktrees root, so a nested path fails closed rather than landing somewhere unrecorded.
   const segment = binding.storageRelativePath;
   if (!safeEntry(segment) || segment.includes('/') || segment.includes('\\'))
    throw new Error(`The binding's storage path ${JSON.stringify(segment)} is not a single safe worktree name under the project's worktrees root.`);
   // The seed is recorded intent, never resolved here: a binding without a valid 40-hex commit
   // cannot name what the worktree was seeded from, so preparation refuses it outright.
   if (typeof binding.seedCommit !== 'string' || !COMMIT_SHA.test(binding.seedCommit))
    throw new Error(`The binding's recorded seed commit ${JSON.stringify(binding.seedCommit)} is not a full sha1 commit id — the seed is recorded intent and cannot be created here.`);
   const dir = await createWorktree(this.reposRoot(), binding.projectId, segment, binding.seedCommit);
   const prepared = prepareLocalPacket({ dir, context, binding, io: this.io, now: this.now() });
   return {
    externalId: segment,
    externalUrl: '',
    detail: `Packet written to ${prepared.dir}, a worktree of this office project's shared session repo seeded at commit ${binding.seedCommit}. It awaits a local session you launch against that folder; the office reads ${RESULT_FILE} back when the session reports. Nothing has run yet.`,
    localPacket: { packetHash: prepared.packetHash },
   };
  }
  const name = `session-${this.now().replace(/[^0-9A-Za-z]/g, '')}-${randomUUID()}`;
  // Legacy unbound path: there is no binding to record a seed on, so HEAD is resolved once,
  // pinned explicitly, and named honestly in the returned detail.
  const repo = await ensureRepo(this.reposRoot(), context.assignment.projectId);
  const seed = await resolveHeadCommit(repo);
  // The worktree is created before any input copy: the packet directory IS the worktree, and a
  // zero-input snapshot still gets a real one for packet.json and the result contract.
  const dir = await createWorktree(this.reposRoot(), context.assignment.projectId, name, seed);
  const files: { path: string; sha256: string; bytes: number }[] = [];
  for (const file of context.snapshot.files) {
   if (!safeEntry(file.path)) throw new Error(`The prepared snapshot declares an unsafe member name: ${file.path}`);
   const source = path.join(context.snapshot.stagingPath, file.path);
   if (!existsSync(source)) throw new Error(`The staged input ${file.path} is missing; prepare the request inputs again.`);
   const sha256 = sha256File(source);
   const bytes = statSync(source).size;
   // The packet carries the exact frozen bytes; a staged file that drifted fails the export loudly.
   if (bytes !== file.bytes || sha256 !== file.sha256)
    throw new Error(`The staged input ${file.path} no longer matches the bytes that were frozen; prepare the request inputs again.`);
   const target = path.join(dir, INPUTS_DIR, file.path);
   mkdirSync(path.dirname(target), { recursive: true });
   writeFileSync(target, readFileSync(source));
   files.push({ path: `${INPUTS_DIR}/${file.path}`, sha256, bytes });
  }
  const packet = {
   schema: 'office-local-session@1',
   assignmentId: context.assignment.id,
   requestName: context.requestName,
   objective: context.objective,
   model: context.payload.model,
   effort: context.payload.effort,
   payload: context.payload.text,
   createdAt: this.now(),
   files,
   contract: CONTRACT_FILE,
  };
  writeFileSync(path.join(dir, PACKET_FILE), `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(path.join(dir, CONTRACT_FILE), resultContract());
  writeFileSync(path.join(dir, AGENTS_FILE), packetAgents());
  return {
   externalId: name,
   externalUrl: '',
   detail: `Packet written to ${dir}, a worktree of this office project's shared session repo seeded at the resolved commit ${seed}. It awaits a local session you launch against that folder; the office reads ${RESULT_FILE} back when the session reports. Nothing has run yet.`,
  };
 }

 async observe(job: ProviderJob, local?: LocalSessionRecord | null): Promise<ObserveResult> {
  // The binding selects the project repo — a bound job's packet lives under its own record's
  // project, and the binding rides into the inner adapter for v2 receipt validation.
  return this.inner(local?.projectId ?? job.projectId).observe(job, local);
 }

 async cancel(job: ProviderJob, local?: LocalSessionRecord | null): Promise<{ acknowledged: boolean; detail: string; requestId?: string }> {
  const inner: ProviderAdapter = this.inner(local?.projectId ?? job.projectId);
  return inner.cancel(job, local);
 }

 /** Reads one declared output back from the session worktree; the caller re-verifies its identity. */
 async fetch(job: ProviderJob, output: { path: string; sha256: string; bytes: number }, local?: LocalSessionRecord | null): Promise<Uint8Array> {
  return this.inner(local?.projectId ?? job.projectId).fetch(job, output, local);
 }

 /**
  * Office-observed evidence for one packet delivery, identical to the base adapter's except the
  * confinement scope, which names this lane honestly: the session shares its project root with
  * sibling session worktrees. Everything else — level, evidence, route, environment, source —
  * stays whatever the base adapter recorded. A bound context resolves through the binding's own
  * project and storage path, exactly as the flat adapter does.
  */
 submitEvidence(context: SubmitContext, result: SubmitResult): CapabilityEvidence[] {
  return this.inner(context.localSession?.projectId ?? context.assignment.projectId).submitEvidence(context, result).map(entry =>
   entry.operation === 'TOOL_CONFINEMENT' && entry.confinement
    ? {
       ...entry,
       detail: 'Scoped workspace delivery: the session received only its packet directory, one worktree inside this office project\u2019s shared session repo.',
       confinement: {
        ...entry.confinement,
        filesystem: 'shared project-root worktree — sibling session worktrees of this office project are readable; routine-work lane, sealed reviews use the isolated lane',
       },
      }
    : entry);
 }

 observeEvidence(job: ProviderJob, result: ObserveResult): CapabilityEvidence[] {
  return this.inner(job.projectId).observeEvidence(job, result);
 }

 cancelEvidence(job: ProviderJob): CapabilityEvidence[] {
  return this.inner(job.projectId).cancelEvidence(job);
 }
}
