import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityEvidence, Effort, Provider, ProviderJob } from '../shared/types.js';
import { parseStrictJson } from '../core/strict-json.js';
import { efforts } from '../shared/effort.js';
import { MAX_FILE, safeEntry } from './artifacts.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';

export const PACKET_FILE = 'packet.json';
export const RESULT_FILE = 'result.json';
export const CANCEL_FILE = 'cancel.requested';
export const CONTRACT_FILE = 'CONTRACT.md';
export const INPUTS_DIR = 'inputs';

/** A receipt is a small record; a multi-megabyte one is a defect, not a result. */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** Mirrors the inventory cap the controller enforces on reported outputs. */
const MAX_OUTPUTS = 256;
/** The states a session may claim. UNKNOWN is the office's own reading of silence, never a claim. */
export const RESULT_STATES = ['ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
type ResultState = (typeof RESULT_STATES)[number];
/** Session directories are single safe names under the sessions root — never paths, never traversal. */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;
/** The receipt keys every result must carry. */
export const RESULT_REQUIRED_KEYS = ['state', 'detail', 'outputs'] as const;
/** The only additions a result may carry: the session's own self-report, never inferred when absent. */
export const RESULT_OPTIONAL_KEYS = ['appliedModel', 'appliedEffort', 'delegation'] as const;
/** The recorded source of every observation this adapter produces. */
const EVIDENCE_SOURCE = 'office-local-mailbox@1';

/**
 * A verified session receipt. The optional fields are the session's own self-report: they are
 * present only when the receipt declared them, and the office never fills a silence with a guess.
 */
export interface LocalResult {
  state: ResultState; detail: string; outputs: { path: string; sha256: string; bytes: number }[];
  appliedModel?: string; appliedEffort?: Effort; delegation?: boolean;
}

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
  readonly providers: readonly Provider[] = ['devin'];
  constructor(private readonly sessionsRoot: () => string, private readonly now: () => string = () => new Date().toISOString()) {}

  /** The recorded identity is a directory name only, so a stored job can never point outside the root. */
  private sessionDir(externalId: string): string | null {
    if (!SESSION_NAME.test(externalId) || externalId === '.' || externalId === '..') return null;
    return path.join(this.sessionsRoot(), externalId);
  }

  async submit(context: SubmitContext): Promise<SubmitResult> {
    if (!context.snapshot.stagingPath) throw new Error('Prepare the request inputs before dispatching.');
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
    return {
      externalId: name,
      externalUrl: '',
      detail: `Packet written to ${dir}. It awaits a local session you launch against that folder; the office reads ${RESULT_FILE} back when the session reports. Nothing has run yet.`,
    };
  }

  async observe(job: ProviderJob): Promise<ObserveResult> {
    const unknown = (detail: string): ObserveResult => ({ state: 'UNKNOWN', detail, provenance: 'OFFICE_LOCAL' });
    const dir = job.externalId ? this.sessionDir(job.externalId) : null;
    if (!dir || !existsSync(dir)) return unknown(job.externalId
      ? 'The session directory for this job is not a session folder under the workspace sessions root; nothing has been heard from a local session.'
      : 'No session directory is recorded for this job.');
    const resultPath = path.join(dir, RESULT_FILE);
    if (!existsSync(resultPath))
      return unknown(`No ${RESULT_FILE} yet. The packet is still waiting for the user-launched local session to report.`);
    const result = this.readResult(resultPath);
    if ('defect' in result) return unknown(result.defect);
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
    return observed;
  }

  /** Strict shape validation: a malformed or over-sized result never becomes a reported outcome. */
  private readResult(resultPath: string): { value: LocalResult } | { defect: string } {
    const defect = (detail: string): { defect: string } => ({ defect: `${RESULT_FILE} cannot be trusted: ${detail}` });
    let raw: unknown;
    try {
      const bytes = statSync(resultPath).size;
      if (bytes > MAX_RESULT_BYTES) return defect(`it is ${bytes} bytes, over the ${MAX_RESULT_BYTES}-byte receipt limit.`);
      raw = parseStrictJson(readFileSync(resultPath, 'utf8'));
    } catch (error) {
      return defect(`it is not valid JSON (${error instanceof Error ? error.message : 'unknown parse failure'}).`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defect('it is not a JSON object.');
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record);
    const allowed = [...RESULT_REQUIRED_KEYS, ...RESULT_OPTIONAL_KEYS] as readonly string[];
    const extras = keys.filter(key => !allowed.includes(key));
    if (extras.length || !RESULT_REQUIRED_KEYS.every(key => key in record))
      return defect(`it must carry exactly state, detail and outputs (appliedModel, appliedEffort and delegation are the only permitted additions); found ${keys.sort().join(',') || 'no keys'}.`);
    if (typeof record.state !== 'string' || !(RESULT_STATES as readonly string[]).includes(record.state))
      return defect(`state ${JSON.stringify(record.state)} is not one of ${RESULT_STATES.join(', ')}.`);
    if (typeof record.detail !== 'string' || record.detail.length > 4000) return defect('detail must be a string of at most 4000 characters.');
    if (!Array.isArray(record.outputs) || record.outputs.length > MAX_OUTPUTS)
      return defect(`outputs must be an array of at most ${MAX_OUTPUTS} declared files.`);
    const outputs: LocalResult['outputs'] = [];
    const seen = new Set<string>();
    for (const item of record.outputs) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return defect('an output entry is not an object.');
      const output = item as Record<string, unknown>;
      if (Object.keys(output).sort().join(',') !== 'bytes,path,sha256') return defect('an output entry must carry exactly path, sha256 and bytes.');
      if (typeof output.path !== 'string' || !safeEntry(output.path)) return defect(`an output path is missing or unsafe: ${JSON.stringify(output.path)}.`);
      if (typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.sha256)) return defect(`an output sha256 is not a lowercase hex digest: ${JSON.stringify(output.sha256)}.`);
      if (typeof output.bytes !== 'number' || !Number.isSafeInteger(output.bytes) || output.bytes < 0 || output.bytes > MAX_FILE)
        return defect(`an output byte count is out of range: ${JSON.stringify(output.bytes)}.`);
      const key = output.path.toLowerCase();
      if (seen.has(key)) return defect(`the output path ${output.path} is declared twice.`);
      seen.add(key);
      outputs.push({ path: output.path, sha256: output.sha256, bytes: output.bytes });
    }
    // Optional self-reports are validated like everything else: a malformed claim is a defect in
    // the whole receipt, never a value to be silently dropped or carried anyway.
    if ('appliedModel' in record && (typeof record.appliedModel !== 'string' || record.appliedModel.length > 160))
      return defect('appliedModel must be a string of at most 160 characters.');
    if ('appliedEffort' in record && (typeof record.appliedEffort !== 'string' || !(efforts as readonly string[]).includes(record.appliedEffort)))
      return defect(`appliedEffort ${JSON.stringify(record.appliedEffort)} is not one of ${efforts.join(', ')}.`);
    if ('delegation' in record && typeof record.delegation !== 'boolean')
      return defect('delegation must be a boolean.');
    const value: LocalResult = { state: record.state as ResultState, detail: record.detail, outputs };
    if (typeof record.appliedModel === 'string') value.appliedModel = record.appliedModel;
    if (typeof record.appliedEffort === 'string') value.appliedEffort = record.appliedEffort as Effort;
    if (typeof record.delegation === 'boolean') value.delegation = record.delegation;
    return { value };
  }

  async cancel(job: ProviderJob): Promise<{ acknowledged: boolean; detail: string }> {
    const dir = job.externalId ? this.sessionDir(job.externalId) : null;
    if (!dir || !existsSync(dir))
      return { acknowledged: false, detail: 'No local session directory exists for this job, so no session can be signalled. The cancellation stays requested.' };
    try {
      writeFileSync(path.join(dir, CANCEL_FILE), `${JSON.stringify({ jobId: job.id, requestedAt: this.now() })}\n`);
    } catch (error) {
      return { acknowledged: false, detail: `The cancel sentinel could not be written: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
    return { acknowledged: true, detail: 'Local session ended by the office. A local cancel stops this session; it is not a provider acknowledgement.' };
  }

  /** Reads one declared output back from the session directory; the caller re-verifies its identity. */
  async fetch(job: ProviderJob, output: { path: string; sha256: string; bytes: number }): Promise<Uint8Array> {
    const dir = job.externalId ? this.sessionDir(job.externalId) : null;
    if (!dir) throw new Error('No session directory is recorded for this job.');
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
  submitEvidence(_context: SubmitContext, result: SubmitResult): CapabilityEvidence[] {
    const dir = this.sessionDir(result.externalId);
    if (!dir || !existsSync(path.join(dir, PACKET_FILE))) return [];
    const scope = this.evidenceScope(this.now());
    return [
      {
        ...scope, operation: 'LOCAL_SUBMIT',
        detail: 'The office wrote a hash-manifested session packet to a dedicated workspace session directory. Office-observed, not provider attestation.',
      },
      {
        ...scope, operation: 'TOOL_CONFINEMENT',
        detail: 'Scoped workspace delivery: the session received only the packet directory.',
        confinement: {
          tools: 'packet contents only: packet.json, the result contract and declared snapshot inputs',
          filesystem: 'one dedicated session directory under the workspace sessions root',
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
}
