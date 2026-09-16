import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Provider, ProviderJob } from '../shared/types.js';
import { parseStrictJson } from '../core/strict-json.js';
import { MAX_FILE, safeEntry } from './artifacts.js';
import type { ObserveResult, ProviderAdapter, SubmitContext, SubmitResult } from './controller.js';

export const PACKET_FILE = 'packet.json';
export const RESULT_FILE = 'result.json';
export const CANCEL_FILE = 'cancel.requested';
export const INPUTS_DIR = 'inputs';

/** A receipt is a small record; a multi-megabyte one is a defect, not a result. */
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** Mirrors the inventory cap the controller enforces on reported outputs. */
const MAX_OUTPUTS = 256;
/** The states a session may claim. UNKNOWN is the office's own reading of silence, never a claim. */
const RESULT_STATES = ['ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
type ResultState = (typeof RESULT_STATES)[number];
/** Session directories are single safe names under the sessions root — never paths, never traversal. */
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;

interface LocalResult { state: ResultState; detail: string; outputs: { path: string; sha256: string; bytes: number }[] }

const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The local mailbox transport (roadmap local-sessions milestone): the office writes a scoped packet
 * — packet.json plus the snapshot's declared input files, each hashed — into a dedicated session
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
    };
    writeFileSync(path.join(dir, PACKET_FILE), `${JSON.stringify(packet, null, 2)}\n`);
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
    return { state: result.value.state, detail: result.value.detail, outputs: result.value.outputs, provenance: 'PROVIDER_REPORTED' };
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
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'detail,outputs,state') return defect(`it must carry exactly state, detail and outputs; found ${keys || 'no keys'}.`);
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
    return { value: { state: record.state as ResultState, detail: record.detail, outputs } };
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
}
