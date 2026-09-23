import { randomUUID } from 'node:crypto';
import { canonicalHash } from '../core/canonical.js';
import type { OfficeStore } from '../core/store.js';
import type { AppState, Assignment, Message, ProviderJob } from '../shared/types.js';

/**
 * The durable record of one launched chain hop: a single HANDOFF message from the predecessor
 * agent to the dependent agent, followed by the office's own delivery receipt.
 *
 * The message is tied to the dependent assignment — it is the dependent's scope, request and
 * packet that the handoff serves. `scopeOutputHashes` names only what the launch's inherited-input
 * pass re-verified byte-for-byte (every stored predecessor output the packet carries); when the
 * hop inherits nothing, the delivered packet's own hash is cited instead, so the message always
 * names a verified identity and never an unexamined one.
 *
 * The receipt is recorded separately and says exactly what the office did: it re-verified the
 * inherited objects by hash and delivered a packet bearing a recorded hash. A receipt is not a
 * reply, not provider acceptance, and not evidence the dependent ran.
 *
 * Returns `recorded: false` with the honest reason when the contract cannot carry the record —
 * the launch itself is unaffected and the caller records the reason on the job.
 */
export function recordChainHandoff(input: {
  store: OfficeStore;
  /** A post-launch snapshot — the dependent job and the settled binding must already exist. */
  state: AppState;
  dependent: Assignment;
  /** The dependency whose completion triggered this hop, when the caller knows it. */
  settledAssignmentId?: string;
  now: () => string;
}): { recorded: true; messageId: string } | { recorded: false; reason: string } {
  const { store, state, dependent, settledAssignmentId, now } = input;
  const job = (state.jobs ?? []).find(item => item.assignmentId === dependent.id);
  if (!job) return { recorded: false, reason: 'the dependent has no job to bind the record to' };
  // A successful local handoff leaves the binding READY with the packet hash on record. Anything
  // else — a failed packet write, a pending reconciliation — means no verified delivery happened,
  // and an unsuccessful launch must never produce a handoff message.
  const binding = store.localSessionForJob(job.id);
  if (!binding || binding.lifecycle !== 'READY')
    return { recorded: false, reason: 'the session packet is not in a delivered state — no verified handoff happened' };
  // The sender is the completed predecessor — the one whose settlement triggered this hop when
  // the caller names it, else the most recently settled one.
  const predecessors = (dependent.dependsOn ?? [])
    .map(id => (state.assignments ?? []).find(item => item.id === id))
    .filter((item): item is Assignment => Boolean(item))
    .map(assignment => ({ assignment, job: (state.jobs ?? []).find(item => item.assignmentId === assignment.id) }))
    .filter((pair): pair is { assignment: Assignment; job: ProviderJob } => pair.job?.state === 'COMPLETED');
  const predecessor = predecessors.find(pair => pair.assignment.id === settledAssignmentId)
    ?? [...predecessors].sort((a, b) => b.job.settledAt.localeCompare(a.job.settledAt))[0];
  if (!predecessor) return { recorded: false, reason: 'no completed predecessor exists to name as the sender' };
  if (predecessor.assignment.agentId === dependent.agentId)
    return { recorded: false, reason: 'the predecessor and the dependent name the same agent — the message contract refuses self-addressed records, and the verified packet delivery stands as the hop record' };
  // Exactly the set the launch re-verified: every stored predecessor output the packet carries.
  const objectHashes = predecessors.flatMap(pair =>
    (pair.job.outputs ?? []).filter(output => output.stored).map(output => output.sha256));
  const packetHash = binding.packetHash;
  const scopeOutputHashes = objectHashes.length ? objectHashes : packetHash ? [packetHash] : [];
  if (!scopeOutputHashes.length)
    return { recorded: false, reason: 'no verified delivery identity exists — neither inherited output objects nor a packet hash' };
  // The receipt must fit its contract: a small set names every hash; a large one names its count
  // and the canonical digest of the whole verified set, which is the same fact in one name.
  const namedHashes = objectHashes.length <= 8
    ? objectHashes.join(', ')
    : `${objectHashes.length} objects, set digest ${canonicalHash([...objectHashes].sort())}`;
  const handoff: Message = {
    id: randomUUID(),
    projectId: dependent.projectId,
    requestId: dependent.requestId,
    assignmentId: dependent.id,
    fromAgentId: predecessor.assignment.agentId,
    toAgentId: dependent.agentId,
    kind: 'HANDOFF',
    body: objectHashes.length
      ? `Chain handoff: the office re-verified ${objectHashes.length} predecessor output object${objectHashes.length === 1 ? '' : 's'} by hash and delivered this work's session packet ${packetHash ?? '(unhashed)'}.`
      : `Chain handoff: this hop inherits no predecessor output; the delivered session packet ${packetHash} is the handoff content.`,
    scopeSnapshotId: dependent.snapshotId,
    scopeOutputHashes,
    sentAt: now(),
    deliveredAt: '',
    receipt: '',
    evidence: 'OFFICE_LOCAL',
  };
  store.recordMessage(handoff);
  store.recordMessageDelivery({
    messageId: handoff.id,
    receipt: objectHashes.length
      ? `The office re-verified the inherited output objects by hash (${namedHashes}) and delivered packet ${packetHash ?? '(unhashed)'} at ${binding.storageRelativePath}.`
      : `The office verified the delivered packet itself by hash ${packetHash} at ${binding.storageRelativePath}; no predecessor output was inherited.`,
    evidence: 'OFFICE_LOCAL',
    at: now(),
  });
  return { recorded: true, messageId: handoff.id };
}
