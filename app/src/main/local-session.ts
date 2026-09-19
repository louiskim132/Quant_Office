import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityEvidence, Effort, Provider, ProviderJob } from '../shared/types.js';
import { parseStrictJson } from '../core/strict-json.js';
import { efforts } from '../shared/effort.js';
import { cancelAckV1Schema, cancelRequestV1Schema, type LocalSessionRecord } from '../shared/local-session.js';
import { MAX_FILE, safeEntry } from './artifacts.js';
import { GuardedLocalFileIO, type LocalFileIO } from './local-session-files.js';
import { AGENTS_FILE, CANCEL_ACK_FILE, CANCEL_FILE, CONTRACT_FILE, INPUTS_DIR, MAX_OUTPUTS, MAX_RESULT_BYTES, PACKET_FILE, RESULT_FILE, RESULT_OPTIONAL_KEYS, RESULT_REQUIRED_KEYS, RESULT_STATES, prepareLocalPacket, readLocalResult, readLocalResultV1 } from './local-packet.js';
import { discover, type Discovery } from './local-provider-records.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';

// The packet/receipt contract constants live in local-packet.ts with both readers; they are
// re-exported here so existing consumers keep one import site.
export { AGENTS_FILE, CANCEL_FILE, CONTRACT_FILE, INPUTS_DIR, PACKET_FILE, RESULT_FILE, RESULT_OPTIONAL_KEYS, RESULT_REQUIRED_KEYS, RESULT_STATES } from './local-packet.js';
export type { LocalResult } from './local-packet.js';

/** Session directories are single safe names under the sessions root — never paths, never traversal. */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;
/** The recorded source of every observation this adapter produces. */
const EVIDENCE_SOURCE = 'office-local-mailbox@1';
/** The cancel request/ack pair are tiny office control files. */
const MAX_CONTROL_BYTES = 64 * 1024;

/** What a verified receipt's declared self-report becomes on the office's observation record. */
interface AppliedReport { model?: string; effort?: Effort; delegation?: boolean }

const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The participant-readable receipt contract written next to packet.json in every packet
 * directory. It is generated from the same constants readResult() enforces, so the
 * document a session reads can never drift from the parser the office applies.
 */
export const resultContract = (): string => [
  '# Local session result contract',
  '',
  `This directory is a Quant Research Office session packet: \`${PACKET_FILE}\` is the`,
  `assignment and \`${INPUTS_DIR}/\` holds the declared input files. Do the bounded work,`,
  `then write \`${RESULT_FILE}\` in this directory to report back.`,
  '',
  `## ${RESULT_FILE}`,
  '',
  `A single JSON object of at most ${MAX_RESULT_BYTES} bytes, carrying exactly`,
  `${RESULT_REQUIRED_KEYS.map(key => `\`${key}\``).join(', ')}:`,
  '',
  `- \`state\` — one of ${RESULT_STATES.join(', ')}`,
  '- `detail` — a string of at most 4000 characters',
  `- \`outputs\` — an array of at most ${MAX_OUTPUTS} declared output files`,
  '',
  `The only permitted additional keys are ${RESULT_OPTIONAL_KEYS.map(key => `\`${key}\``).join(', ')}:`,
  "the session's own self-report. Omit them rather than guess; the office never fills",
  'an absent key with an assumption.',
  '',
  '- `appliedModel` — a string of at most 160 characters',
  `- \`appliedEffort\` — one of ${efforts.join(', ')}`,
  '- `delegation` — a boolean',
  '',
  'Each `outputs` entry is an object carrying exactly `path`, `sha256` and `bytes`:',
  '',
  '- `path` — a relative file path inside this session directory',
  "- `sha256` — the lowercase hex SHA-256 digest of the file's bytes",
  `- \`bytes\` — the file's byte count, 0 to ${MAX_FILE}`,
  '',
  '## Rules',
  '',
  '- Every declared output must exist inside this session directory; the office re-reads',
  '  each file and verifies its sha256 and bytes before reporting anything.',
  '- A missing, oversized, malformed or hash-mismatched receipt is recorded as the',
  "  office's own UNKNOWN reading, never as a session result.",
  `- \`${CANCEL_FILE}\` in this directory is the office's end signal: stop work and write`,
  `  \`${RESULT_FILE}\` with what was completed. It ends this local session; it is not a`,
  '  provider acknowledgement.',
  '',
].join('\n');

/**
 * The discovery file agent CLIs auto-read when the packet directory is the working directory, so
 * an uninstructed session still finds the contract instead of needing it named in the prompt.
 */
export const packetAgents = (): string => [
  '# Quant Research Office session packet',
  '',
  `This directory is a bounded work packet. \`${PACKET_FILE}\` is the frozen assignment and`,
  `\`${CONTRACT_FILE}\` is the result contract — read it before doing anything else. Declared`,
  `input files, when the snapshot carried any, are under \`${INPUTS_DIR}/\`. Report back by`,
  `writing \`${RESULT_FILE}\` in this directory exactly as the contract specifies.`,
  '',
].join('\n');

/**
 * The local mailbox transport (roadmap local-sessions milestone): the office writes a scoped packet
 * — packet.json, the CONTRACT.md result contract and the snapshot's declared input files, each
 * hashed — into a dedicated session
 * directory under a workspace-local root. A user-launched local session reads the packet, does its
 * bounded work and writes result.json with a declared output inventory. The office then verifies
 * every declared byte itself before reporting it.
 *
 * Honesty rules mirror the handoff adapters: a written packet is not a submission receipt, an absent
 * or malformed result is UNKNOWN with OFFICE_LOCAL provenance rather than provider testimony, and a
 * cancel sentinel ends the local session — it is not a provider acknowledgement.
 */
export class LocalMailboxAdapter implements ProviderAdapter {
  readonly route = 'LOCAL_MAILBOX' as const;
  // The packet contract is provider-agnostic — packet.json, CONTRACT.md, AGENTS.md and the
  // hash-verified result.json carry no provider semantics; the user runs whichever local CLI
  // on the directory. Evidence stays office-observed regardless of which provider the session used.
  readonly providers: readonly Provider[] = ['devin','claude','openai'];
  // What this adapter writes when a persisted binding is present: v2 packets with attempt binding.
  // An unbound submit still writes the legacy v1 packet and can never produce a v2 binding.
  readonly packetVersion = 2;
  constructor(
    private readonly sessionsRoot: () => string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly io: LocalFileIO = new GuardedLocalFileIO(),
    private readonly discoverRecords: (dir: string, provider: Provider) => Discovery = discover,
  ) {}

  /** The recorded identity is a directory name only, so a stored job can never point outside the root. */
  private sessionDir(externalId: string): string | null {
    if (!SESSION_NAME.test(externalId) || externalId === '.' || externalId === '..') return null;
    return path.join(this.sessionsRoot(), externalId);
  }

  async submit(context: SubmitContext): Promise<SubmitResult> {
    if (!context.snapshot.stagingPath) throw new Error('Prepare the request inputs before dispatching.');
    if (context.localSession) {
      // Bound path (QO-LOCAL-REV §6.2): the binding's storage path is the packet directory, and the
      // whole write goes through the guarded I/O boundary. The caller persists the packet hash on
      // the binding; this adapter only reports what it verified it wrote.
      const binding = context.localSession;
      const dir = path.resolve(this.sessionsRoot(), binding.storageRelativePath);
      const prepared = prepareLocalPacket({ dir, context, binding, io: this.io, now: this.now() });
      return {
        externalId: path.basename(binding.storageRelativePath),
        externalUrl: '',
        detail: `Packet written to ${prepared.dir}. It awaits a local session you launch against that folder; the office reads ${RESULT_FILE} back when the session reports. Nothing has run yet.`,
        localPacket: { packetHash: prepared.packetHash },
      };
    }
    const name = `session-${this.now().replace(/[^0-9A-Za-z]/g, '')}-${randomUUID()}`;
    const dir = path.join(this.sessionsRoot(), name);
    // Create the session directory before any input copy: a zero-input snapshot still gets
    // a real packet directory for packet.json and the result contract.
    mkdirSync(dir, { recursive: true });
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
      detail: `Packet written to ${dir}. It awaits a local session you launch against that folder; the office reads ${RESULT_FILE} back when the session reports. Nothing has run yet.`,
    };
  }

  async observe(job: ProviderJob, local?: LocalSessionRecord | null): Promise<ObserveResult> {
    const unknown = (detail: string): ObserveResult => ({ state: 'UNKNOWN', detail, provenance: 'OFFICE_LOCAL' });
    // A persisted binding names the packet directory by its storage path; a legacy job only has
    // the recorded directory name. Neither is trusted as anything but a location.
    const dir = local
      ? path.resolve(this.sessionsRoot(), local.storageRelativePath)
      : job.externalId ? this.sessionDir(job.externalId) : null;
    if (!dir) return unknown(job.externalId
      ? 'The recorded session identity is not a session directory name under the workspace sessions root; nothing has been heard from a local session.'
      : 'No session directory is recorded for this job.');
    if (!existsSync(dir)) return unknown('The session directory for this job is not present under the workspace sessions root — it may have been retired or removed externally; nothing has been heard from a local session.');
    // Read-only discovery of the provider's own record for this exact directory — an office
    // observation of provider-side grouping, independent of receipt state. Once a record has
    // resolved, OBSERVED is pinned on the binding and rescanning is pointless.
    const grouping = local && local.groupingStatus !== 'OBSERVED' ? this.discoverGrouping(dir, local) : undefined;
    const attach = (result: ObserveResult): ObserveResult => grouping ? { ...result, providerGrouping: grouping } : result;
    if (local?.packetVersion === 2) {
      // A cancel acknowledgement is a control file: it is validated before the receipt is read,
      // and a malformed or misbound one makes the whole observation UNKNOWN — a bad control file
      // is never ignored to reach a good receipt.
      const ack = this.readCancelAck(dir, local);
      if ('defect' in ack) return attach(unknown(ack.defect));
      // The v2 reader proves the ready marker, the attempt binding, the sequence and every
      // declared output byte before anything is reported. A v1-shaped receipt here is a defect.
      const read = readLocalResult(dir, local, this.io);
      if ('defect' in read) return attach(unknown(read.defect));
      const result = read.value.result;
      const observed: ObserveResult & { applied?: AppliedReport } = {
        state: result.state, detail: result.detail,
        outputs: result.outputs.map(output => ({ path: output.path, sha256: output.sha256, bytes: output.bytes })),
        provenance: 'PROVIDER_REPORTED',
      };
      if (result.applied) {
        const applied: AppliedReport = {};
        if (result.applied.model !== undefined) applied.model = result.applied.model;
        if (result.applied.effort !== undefined) applied.effort = result.applied.effort;
        if (result.applied.delegation !== undefined) applied.delegation = result.applied.delegation;
        if (applied.model !== undefined || applied.effort !== undefined || applied.delegation !== undefined) observed.applied = applied;
      }
      if (ack.ack) observed.cancelAck = ack.ack;
      // The verified receipt's identity rides to the caller — the binding persists it as
      // lastReceipt so a replayed or rewound receipt is refused on the next observation.
      observed.receipt = { sequence: result.sequence, hash: read.value.receiptHash };
      return attach(observed);
    }
    const resultPath = path.join(dir, RESULT_FILE);
    if (!existsSync(resultPath))
      return attach(unknown(`No ${RESULT_FILE} yet. The packet is still waiting for the user-launched local session to report.`));
    const result = readLocalResultV1(resultPath);
    if ('defect' in result) return attach(unknown(result.defect));
    for (const output of result.value.outputs) {
      const target = path.join(dir, output.path);
      if (!existsSync(target) || !statSync(target).isFile())
        return unknown(`${RESULT_FILE} declares ${output.path}, but the session directory does not contain that file.`);
      const actual = sha256File(target);
      if (statSync(target).size !== output.bytes)
        return unknown(`${RESULT_FILE} declares ${output.path} at ${output.bytes} bytes; the file on disk is ${statSync(target).size} bytes.`);
      if (actual !== output.sha256)
        return unknown(`${RESULT_FILE} declares ${output.path} as ${output.sha256}, but the file on disk hashes to ${actual}.`);
    }
    // Every declared output now names bytes this office hashed itself; the inventory is reported
    // exactly as declared because the files proved to be those bytes.
    const observed: ObserveResult & { applied?: AppliedReport } = {
      state: result.value.state, detail: result.value.detail, outputs: result.value.outputs, provenance: 'PROVIDER_REPORTED',
    };
    // Self-reported applied facts ride only on a fully verified receipt, and only when the session
    // actually declared them — an absent key is never replaced with an assumption.
    const applied: AppliedReport = {};
    if (result.value.appliedModel !== undefined) applied.model = result.value.appliedModel;
    if (result.value.appliedEffort !== undefined) applied.effort = result.value.appliedEffort;
    if (result.value.delegation !== undefined) applied.delegation = result.value.delegation;
    if (applied.model !== undefined || applied.effort !== undefined || applied.delegation !== undefined) observed.applied = applied;
    return attach(observed);
  }

  /**
   * Read-only discovery of the provider's own record bound to this session's directory. A
   * resolved record is an office observation of provider-side grouping; nothing is inferred
   * from absence, and a discovery failure is not a defect — the binding stays UNKNOWN.
   */
  private discoverGrouping(dir: string, binding: LocalSessionRecord): { key: string; kind: string } | undefined {
    try {
      const found = this.discoverRecords(dir, binding.provider);
      return found.records.length ? { key: found.records[0].id, kind: found.records[0].kind } : undefined;
    } catch { return undefined; }
  }

  /**
   * Reads and validates the cooperative-stop acknowledgement on a bound packet. An absent file is
   * not an observation at all; a present one must satisfy office-local-cancel-ack@1 and name the
   * exact request this binding recorded — anything less is a defect, never an ignored file.
   */
  private readCancelAck(dir: string, binding: LocalSessionRecord): { ack?: { requestId: string; outcome: 'STOPPED'; detail: string } } | { defect: string } {
    const defect = (detail: string): { defect: string } => ({ defect: detail });
    let file;
    try {
      file = this.io.read(dir, CANCEL_ACK_FILE, MAX_CONTROL_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not present/.test(message)) return {};
      return defect(`${CANCEL_ACK_FILE} could not be read (${message}) — a control file that cannot be verified makes the receipt beside it untrusted.`);
    }
    if (!binding.cancelRequestId)
      return defect(`${CANCEL_ACK_FILE} is present, but this binding records no cancel request — an acknowledgement claiming a request the office never recorded is a tamper signal; the receipt beside it is not trusted.`);
    let raw: unknown;
    try {
      raw = parseStrictJson(Buffer.from(file.bytes).toString('utf8'));
    } catch (error) {
      return defect(`${CANCEL_ACK_FILE} is not valid JSON (${error instanceof Error ? error.message : 'unknown parse failure'}) — a malformed control file is a defect, not an acknowledgement.`);
    }
    const parsed = cancelAckV1Schema.safeParse(raw);
    if (!parsed.success)
      return defect(`${CANCEL_ACK_FILE} does not satisfy office-local-cancel-ack@1 (${parsed.error.issues.map(issue => `${issue.path.join('.') || 'ack'}: ${issue.message}`).join('; ')}) — a malformed control file is a defect, not an acknowledgement.`);
    const ack = parsed.data;
    const mismatches = (['requestId', 'jobId', 'assignmentId', 'attemptId', 'packetHash'] as const)
      .filter(key => ack[key] !== (key === 'requestId' ? binding.cancelRequestId : binding[key]));
    if (mismatches.length)
      return defect(`${CANCEL_ACK_FILE} acknowledges ${mismatches.map(key => `${key} ${JSON.stringify(ack[key])}`).join(', ')} — this binding expects ${mismatches.map(key => `${key} ${JSON.stringify(key === 'requestId' ? binding.cancelRequestId : binding[key])}`).join(', ')}; a misbound acknowledgement is a defect, not a stop record.`);
    return { ack: { requestId: ack.requestId, outcome: ack.outcome, detail: ack.detail } };
  }

  async cancel(job: ProviderJob, local?: LocalSessionRecord | null): Promise<{ acknowledged: boolean; detail: string; requestId?: string }> {
    if (local?.packetVersion === 2) {
      // Cooperative stop on a bound packet (QO-LOCAL-REV §8): the office writes cancel.requested
      // bound to this attempt's identity. acknowledged means the office DELIVERED a request —
      // never that anything stopped; the session acknowledges by writing cancel.ack.json.
      if (local.packetHash === null)
        return { acknowledged: false, detail: 'This binding records no verified packet hash, so a cancel request cannot be bound to an attempt. Nothing was written; nothing has stopped.' };
      const dir = path.resolve(this.sessionsRoot(), local.storageRelativePath);
      if (!existsSync(dir))
        return { acknowledged: false, detail: 'The recorded session directory is gone, so no session can be signalled. The cancellation stays requested; nothing has stopped.' };
      // Read-first for idempotency: a request file that already exists is either this exact
      // request or a defect — the office never overwrites one (writeNew would refuse anyway).
      try {
        const existing = this.io.read(dir, CANCEL_FILE, MAX_CONTROL_BYTES);
        let raw: unknown;
        try {
          raw = parseStrictJson(Buffer.from(existing.bytes).toString('utf8'));
        } catch (error) {
          return { acknowledged: false, detail: `The existing ${CANCEL_FILE} is malformed — not valid JSON (${error instanceof Error ? error.message : 'unknown parse failure'}). The office never overwrites a request file; reconcile the directory first. Nothing has stopped.` };
        }
        const parsed = cancelRequestV1Schema.safeParse(raw);
        if (!parsed.success)
          return { acknowledged: false, detail: `The existing ${CANCEL_FILE} is malformed — it does not satisfy office-local-cancel-request@1 (${parsed.error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')}). The office never overwrites a request file; reconcile the directory first. Nothing has stopped.` };
        const request = parsed.data;
        const mismatches = (['jobId', 'assignmentId', 'attemptId', 'packetHash'] as const).filter(key => request[key] !== local[key]);
        if (mismatches.length)
          return { acknowledged: false, detail: `The existing ${CANCEL_FILE} is bound to ${mismatches.map(key => `${key} ${JSON.stringify(request[key])}`).join(', ')} — this attempt expects ${mismatches.map(key => `${key} ${JSON.stringify(local[key])}`).join(', ')}; a request for a different attempt is a defect, never overwritten. Nothing has stopped.` };
        return { acknowledged: true, requestId: request.requestId, detail: `A cooperative cancel request was already delivered to ${dir} (requestId ${request.requestId}). The office delivered a request only — nothing has stopped; the session acknowledges by writing ${CANCEL_ACK_FILE} (office-local-cancel-ack@1).` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not present/.test(message))
          return { acknowledged: false, detail: `The existing ${CANCEL_FILE} could not be read (${message}). The office never overwrites a request file. Nothing has stopped.` };
      }
      const request = cancelRequestV1Schema.parse({
        schema: 'office-local-cancel-request@1', requestId: randomUUID(),
        jobId: local.jobId, assignmentId: local.assignmentId, attemptId: local.attemptId,
        packetHash: local.packetHash, requestedAt: this.now(),
      });
      try {
        this.io.writeNew(dir, CANCEL_FILE, Buffer.from(`${JSON.stringify(request, null, 2)}\n`, 'utf8'));
      } catch (error) {
        return { acknowledged: false, detail: `The cancel request could not be written: ${error instanceof Error ? error.message : 'unknown error'}. Nothing has stopped.` };
      }
      return { acknowledged: true, requestId: request.requestId, detail: `Cooperative cancel request ${request.requestId} delivered to ${dir}. The office delivered a request only — nothing has stopped; the session acknowledges by writing ${CANCEL_ACK_FILE} (office-local-cancel-ack@1). It is a local record, not a provider acknowledgement.` };
    }
    const dir = job.externalId ? this.sessionDir(job.externalId) : null;
    if (!dir)
      // No session identity was ever recorded — a submit that failed before naming a directory
      // left nothing external running. The office is the transport for local sessions, so this
      // acknowledgement is a statement about local state, not a provider receipt.
      return { acknowledged: true, detail: 'No session was ever recorded for this job, so nothing external exists to signal. Acknowledged by the office.' };
    if (!existsSync(dir))
      return { acknowledged: false, detail: 'The recorded session directory is gone, so no session can be signalled. The cancellation stays requested.' };
    try {
      writeFileSync(path.join(dir, CANCEL_FILE), `${JSON.stringify({ jobId: job.id, requestedAt: this.now() })}\n`);
    } catch (error) {
      return { acknowledged: false, detail: `The cancel sentinel could not be written: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
    return { acknowledged: true, detail: 'Local session ended by the office. A local cancel stops this session; it is not a provider acknowledgement.' };
  }

  /**
   * Retires one packet directory by moving it under archive/ inside the sessions root. The archive
   * is a subdirectory of the root itself, so retiring is a rename on one filesystem — never a
   * copy-and-delete; every packet byte survives by construction. Whether a job may be retired is
   * the caller's decision; this operation only moves bytes and reports what it did, and an absent
   * or already-retired directory is reported rather than thrown.
   */
  async retire(externalId: string, local?: LocalSessionRecord | null): Promise<{ retired: boolean; alreadyArchived?: boolean; archivedAs?: string; detail: string }> {
    // A bound retire moves the binding's own storage path — never a caller-supplied name that
    // merely resembles it — and only ever a flat packet: another layout's bytes are not ours.
    if (local && local.layout !== 'FLAT_PACKET')
      return { retired: false, detail: `The binding records the ${local.layout} layout — this adapter only archives flat packets; nothing was moved.` };
    if (local && local.storageRelativePath !== externalId)
      return { retired: false, detail: 'The binding\'s storage path does not match the requested directory; nothing was moved.' };
    const dir = this.sessionDir(externalId);
    if (!dir) return { retired: false, detail: 'Not a session directory name under the workspace sessions root; nothing was moved.' };
    // 'archive' names the archive root itself, never a session directory to move.
    if (externalId === 'archive') return { retired: false, detail: 'The archive root is not a session directory; nothing was moved.' };
    const archivedAs = `archive/${externalId}`;
    const archived = path.join(this.sessionsRoot(), 'archive', externalId);
    if (existsSync(archived)) return { retired: true, alreadyArchived: true, archivedAs, detail: `The session directory is already retired under ${archived}; nothing was moved.` };
    if (!existsSync(dir)) return { retired: false, detail: `No session directory named ${externalId} exists under the sessions root; nothing was moved.` };
    try {
      mkdirSync(path.dirname(archived), { recursive: true });
      renameSync(dir, archived);
    } catch (error) {
      return { retired: false, detail: `The session directory could not be moved into the archive: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
    return { retired: true, archivedAs, detail: `Session directory moved to ${archived}. The packet bytes are retained; provider-side records may still reference it.` };
  }

  /** Reads one declared output back from the session directory; the caller re-verifies its identity. */
  async fetch(job: ProviderJob, output: { path: string; sha256: string; bytes: number }, local?: LocalSessionRecord | null): Promise<Uint8Array> {
    const dir = local
      ? path.resolve(this.sessionsRoot(), local.storageRelativePath)
      : job.externalId ? this.sessionDir(job.externalId) : null;
    if (!dir) throw new Error('No session directory is recorded for this job.');
    if (local?.packetVersion === 2) {
      // The guarded boundary re-proves the path is a real, contained file, and the declared
      // sha256/bytes are re-verified against the bytes actually read before they are returned.
      const file = this.io.read(dir, output.path, MAX_FILE);
      if (file.byteLength !== output.bytes)
        throw new Error(`The declared output ${output.path} is ${file.byteLength} bytes on disk, not the ${output.bytes} the receipt recorded.`);
      if (file.sha256 !== output.sha256)
        throw new Error(`The declared output ${output.path} hashes to ${file.sha256} on disk, not the ${output.sha256} the receipt recorded.`);
      return file.bytes;
    }
    return new Uint8Array(readFileSync(path.join(dir, output.path)));
  }

  /** The scope every observation this adapter records shares: this route, this machine, this source. */
  private evidenceScope(verifiedAt: string): Pick<CapabilityEvidence, 'level' | 'evidence' | 'route' | 'environment' | 'source' | 'verifiedAt'> {
    return { level: 'TOOL_SUPPORTED', evidence: 'OBSERVED', route: this.route, environment: 'LOCAL_MACHINE', source: EVIDENCE_SOURCE, verifiedAt };
  }

  /**
   * Office-observed evidence for one packet delivery. Records only what the office itself did —
   * TOOL_SUPPORTED/OBSERVED at most, never provider attestation — and only while the packet it
   * describes is still on disk to point at. Model and effort are deliberately absent: the packet
   * declares what was requested, and nothing about what a session applied is known at submit time.
   */
  submitEvidence(context: SubmitContext, result: SubmitResult): CapabilityEvidence[] {
    const dir = context.localSession
      ? path.resolve(this.sessionsRoot(), context.localSession.storageRelativePath)
      : this.sessionDir(result.externalId);
    if (!dir || !existsSync(path.join(dir, PACKET_FILE))) return [];
    const scope = this.evidenceScope(this.now());
    return [
      {
        ...scope, operation: 'LOCAL_SUBMIT',
        detail: 'The office wrote a hash-manifested session packet to a dedicated workspace session directory. Office-observed, not provider attestation.',
      },
      {
        ...scope, operation: 'TOOL_CONFINEMENT',
        detail: 'Delivery scope, not an enforced boundary: the office delivered the packet into one dedicated session directory; the session it launches runs under the user\'s own permissions.',
        confinement: {
          tools: 'packet contents delivered: packet.json, the result contract and declared snapshot inputs',
          filesystem: 'the packet was written to one dedicated session directory; the office confines nothing — the session runs under the user\'s filesystem permissions and can read sibling directories',
          network: 'not restricted by the office; the packet declares what the session may read',
          environment: 'user-launched official CLI session on this machine',
        },
      },
      {
        ...scope, operation: 'DELEGATION_CONTROL', delegation: false,
        detail: 'The packet carries only the frozen single-agent payload; the mailbox has no delegation channel.',
      },
    ];
  }

  /**
   * Office-observed evidence for one receipt read. Anything short of a fully hash-verified,
   * session-reported result produces nothing: an UNKNOWN reading is the office describing its own
   * silence, not an observation of the session. Self-reported applied facts appear only when the
   * receipt actually declared them.
   */
  observeEvidence(_job: ProviderJob, result: ObserveResult): CapabilityEvidence[] {
    if (result.provenance !== 'PROVIDER_REPORTED' || !(RESULT_STATES as readonly string[]).includes(result.state)) return [];
    const scope = this.evidenceScope(this.now());
    const entries: CapabilityEvidence[] = [{
      ...scope, operation: 'LOCAL_OBSERVE',
      detail: "The office read the session's own result.json from the packet directory.",
    }];
    if (result.outputs?.length)
      entries.push({
        ...scope, operation: 'LOCAL_OUTPUT_FETCH',
        detail: `The office read back ${result.outputs.length} declared output file${result.outputs.length === 1 ? '' : 's'} and verified every declared sha256 and byte count against the bytes on disk.`,
      });
    // `applied` is declared on ObserveResult by the organizer alongside these hooks.
    const applied = (result as ObserveResult & { applied?: AppliedReport }).applied;
    if (applied?.model !== undefined)
      entries.push({
        ...scope, operation: 'MODEL_APPLICATION', model: applied.model,
        detail: 'The local session reported applying this model. Session self-report observed by the office, not provider attestation.',
      });
    if (applied?.effort !== undefined)
      entries.push({
        ...scope, operation: 'EFFORT_APPLICATION', effort: applied.effort,
        detail: 'The local session reported applying this effort. Session self-report observed by the office, not provider attestation.',
      });
    if (applied?.delegation !== undefined)
      entries.push({
        ...scope, operation: 'DELEGATION_CONTROL', delegation: applied.delegation,
        detail: 'The local session reported this delegation setting in its receipt. Session self-report observed by the office, not provider attestation.',
      });
    return entries;
  }

  /**
   * Office-observed evidence for one cancellation. Only a sentinel that is actually on disk backs
   * this record; without it there is no ended session to report.
   */
  cancelEvidence(job: ProviderJob): CapabilityEvidence[] {
    const dir = job.externalId ? this.sessionDir(job.externalId) : null;
    if (!dir || !existsSync(path.join(dir, CANCEL_FILE))) return [];
    return [{
      ...this.evidenceScope(this.now()), operation: 'LOCAL_CANCEL',
      detail: 'The office ended the local session by writing the cancel sentinel in the packet directory. A real cancellation of that session, not a provider acknowledgement.',
    }];
  }

  /**
   * Office-observed evidence for one directory retirement. A live dir and an archived one each get
   * a single LOCAL_RETIRE entry naming what the office did; a dir that is neither records nothing —
   * there is no move to testify about.
   */
  retireEvidence(externalId: string): CapabilityEvidence[] {
    const dir = this.sessionDir(externalId);
    if (!dir || externalId === 'archive') return [];
    const live = existsSync(dir);
    const archived = existsSync(path.join(this.sessionsRoot(), 'archive', externalId));
    if (!live && !archived) return [];
    return [{
      ...this.evidenceScope(this.now()), operation: 'LOCAL_RETIRE',
      detail: archived
        ? 'The office moved the session packet directory into the archive under the sessions root. The bytes are retained; provider-side records may still reference it.'
        : 'The session packet directory is still live under the sessions root; no retirement move has been recorded for it.',
    }];
  }
}
