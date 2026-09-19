import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityEvidence, Provider, ProviderJob } from '../shared/types.js';
import { safeEntry } from './artifacts.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';
import { AGENTS_FILE, CONTRACT_FILE, INPUTS_DIR, LocalMailboxAdapter, PACKET_FILE, RESULT_FILE, packetAgents, resultContract } from './local-session.js';
import { createWorktree, worktreesRoot } from './local-worktree-repo.js';

const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The shared-root worktree lane for local sessions (one provider project, session per worktree).
 *
 * The packet contract is the LocalMailboxAdapter's, unchanged: the same packet.json, the same
 * CONTRACT.md result contract, the same AGENTS.md discovery file, the same hash-verified
 * result.json read-back. The only thing that differs is where the session directory lands —
 * instead of a flat folder under a workspace sessions root, each session directory is created
 * as a detached git worktree of that office project's session repo, so a session's working
 * directory is itself the shared project root's worktree.
 *
 * Composition, not duplication: a configured LocalMailboxAdapter per project answers every
 * read-side call (observe, cancel, fetch and the observe/cancel evidence hooks) with the
 * identical session-dir boundary rule — a recorded externalId stays a single safe name under
 * that project's worktrees root and can never point outside it. submit creates the worktree
 * first, so the packet directory IS the worktree, then performs the identical write.
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
 constructor(private readonly reposRoot: () => string, private readonly now: () => string = () => new Date().toISOString()) {}

 /** The base adapter configured so its session root IS one project's worktrees root. */
 private inner(projectId: string): LocalMailboxAdapter {
  return new LocalMailboxAdapter(() => worktreesRoot(this.reposRoot(), projectId), this.now);
 }

 async submit(context: SubmitContext): Promise<SubmitResult> {
  if (!context.snapshot.stagingPath) throw new Error('Prepare the request inputs before dispatching.');
  const name = `session-${this.now().replace(/[^0-9A-Za-z]/g, '')}-${randomUUID()}`;
  // The worktree is created before any input copy: the packet directory IS the worktree, and a
  // zero-input snapshot still gets a real one for packet.json and the result contract.
  const dir = await createWorktree(this.reposRoot(), context.assignment.projectId, name);
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
   detail: `Packet written to ${dir}, a worktree of this office project's shared session repo. It awaits a local session you launch against that folder; the office reads ${RESULT_FILE} back when the session reports. Nothing has run yet.`,
  };
 }

 async observe(job: ProviderJob): Promise<ObserveResult> {
  return this.inner(job.projectId).observe(job);
 }

 async cancel(job: ProviderJob): Promise<{ acknowledged: boolean; detail: string }> {
  return this.inner(job.projectId).cancel(job);
 }

 /** Reads one declared output back from the session worktree; the caller re-verifies its identity. */
 async fetch(job: ProviderJob, output: { path: string; sha256: string; bytes: number }): Promise<Uint8Array> {
  return this.inner(job.projectId).fetch(job, output);
 }

 /**
  * Office-observed evidence for one packet delivery, identical to the base adapter's except the
  * confinement scope, which names this lane honestly: the session shares its project root with
  * sibling session worktrees. Everything else — level, evidence, route, environment, source —
  * stays whatever the base adapter recorded.
  */
 submitEvidence(context: SubmitContext, result: SubmitResult): CapabilityEvidence[] {
  return this.inner(context.assignment.projectId).submitEvidence(context, result).map(entry =>
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
