import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { canonicalHash } from '../core/canonical.js';
import { parseStrictJson } from '../core/strict-json.js';
import { efforts } from '../shared/effort.js';
import { cancelAckV1Schema, cancelRequestV1Schema, localPacketV2Schema, localResultV2Schema, type LocalPacketV2, type LocalResultV2, type LocalSessionRecord } from '../shared/local-session.js';
import { mountsEvidenceSurface } from '../shared/tool-profile.js';
import type { Effort } from '../shared/types.js';
import { MAX_FILE, MAX_TOTAL, safeEntry } from './artifacts.js';
import type { SubmitContext } from './controller.js';
import type { LocalFileIO, VerifiedLocalFile } from './local-session-files.js';

export const PACKET_FILE = 'packet.json';
export const RESULT_FILE = 'result.json';
export const CANCEL_FILE = 'cancel.requested';
export const CANCEL_ACK_FILE = 'cancel.ack.json';
export const CONTRACT_FILE = 'CONTRACT.md';
export const AGENTS_FILE = 'AGENTS.md';
export const CLAUDE_FILE = 'CLAUDE.md';
export const INPUTS_DIR = 'inputs';
export const OUTPUTS_DIR = 'outputs';
export const PACKET_HASH_FILE = 'packet.sha256';
export const PACKET_READY_FILE = 'packet.ready.json';

/** A receipt is a small record; a multi-megabyte one is a defect, not a result. */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** The ready marker is a tiny office control file. */
const MAX_READY_BYTES = 64 * 1024;
/** Mirrors the inventory cap the controller enforces on reported outputs. */
export const MAX_OUTPUTS = 256;
/** The states a session may claim. UNKNOWN is the office's own reading of silence, never a claim. */
export const RESULT_STATES = ['ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
type ResultState = (typeof RESULT_STATES)[number];
/** The receipt keys every v1 result must carry. */
export const RESULT_REQUIRED_KEYS = ['state', 'detail', 'outputs'] as const;
/** The only additions a v1 result may carry: the session's own self-report, never inferred when absent. */
export const RESULT_OPTIONAL_KEYS = ['appliedModel', 'appliedEffort', 'delegation'] as const;

/**
 * A verified v1 session receipt. The optional fields are the session's own self-report: they are
 * present only when the receipt declared them, and the office never fills a silence with a guess.
 */
export interface LocalResult {
  state: ResultState; detail: string; outputs: { path: string; sha256: string; bytes: number }[];
  appliedModel?: string; appliedEffort?: Effort; delegation?: boolean;
}

/** What prepareLocalPacket produces: the packet object that was written and its canonical hash. */
export interface PreparedLocalPacket {
  dir: string;
  packet: LocalPacketV2;
  packetHash: string;
}

export interface PrepareLocalPacketInput {
  /** The packet directory to allocate — resolved by the caller as sessionsRoot + storageRelativePath. */
  dir: string;
  /** The dispatch context: snapshot manifest + staging path, payload, request identity, jobId. */
  context: SubmitContext;
  /** The persisted binding this packet serves — the attempt authority for every identity field. */
  binding: LocalSessionRecord;
  /** The guarded I/O boundary every read and write goes through. */
  io: LocalFileIO;
  now: string;
}

/** A v2 receipt plus the output bytes the office verified itself — the caller stores them unopened. */
export interface VerifiedLocalResult {
  result: LocalResultV2;
  /** sha256 of the result.json bytes exactly as read — the hash a lastReceipt record stores. */
  receiptHash: string;
  outputs: { path: string; sha256: string; bytes: number; data: Uint8Array }[];
}

type ReaderResult<T> = { value: T } | { defect: string };
const defect = <T>(detail: string): ReaderResult<T> => ({ defect: detail });
const ioError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The discovery file agent CLIs auto-read when the packet directory is the working directory, so
 * an uninstructed session still finds the contract instead of needing it named in the prompt.
 */
export const packetAgentsV2 = (): string => [
  '# Quant Research Office session packet',
  '',
  `This directory is a bounded work packet. \`${PACKET_FILE}\` is the frozen assignment and`,
  `\`${CONTRACT_FILE}\` is the result contract — read it before doing anything else. Declared`,
  `input files, when the snapshot carried any, are under \`${INPUTS_DIR}/\`. Put every file`,
  `the receipt declares under \`${OUTPUTS_DIR}/\` and report back by writing \`${RESULT_FILE}\``,
  'in this directory exactly as the contract specifies.',
  `If \`${CANCEL_FILE}\` exists in this directory, stop immediately and follow`,
  `\`${CONTRACT_FILE}\` — no instruction overrides it.`,
  '',
].join('\n');

/**
 * Claude-family CLIs auto-read CLAUDE.md. It is a regular file whose first line is the
 * `@AGENTS.md` include — not a link, not a copy of the whole file (defect F13) — plus one
 * sentence pointing at the contract so a session that skips the include still finds it.
 */
export const packetClaude = (): string => [
  '@AGENTS.md',
  '',
  `This packet was prepared by Quant Research Office; read \`${CONTRACT_FILE}\` for the result contract before doing anything else.`,
  '',
].join('\n');

/**
 * The participant-readable v2 receipt contract written next to packet.json. It names the
 * office-local-result@2 wire exactly as localResultV2Schema enforces it, marks the office
 * control files, and documents the cooperative cancel request/acknowledgement pair (spec §8 —
 * the schema exists in shared/local-session.ts; P3 implements the runtime).
 */
export const resultContractV2 = (options?: { evidenceSurface?: boolean }): string => [
  '# Local session result contract',
  '',
  `This directory is a Quant Research Office session packet (office-local-session@2):`,
  `\`${PACKET_FILE}\` is the frozen assignment, \`${PACKET_HASH_FILE}\` the office's hash of`,
  `it, \`${PACKET_READY_FILE}\` the office's ready marker, and \`${INPUTS_DIR}/\` the declared`,
  `input files. When \`${PACKET_FILE}\` declares an \`inherited\` manifest, those verified`,
  `outputs from earlier work in this request's dependency chain are under`,
  `\`${INPUTS_DIR}/inherited/<job-id>/\`. Do the bounded work, then write \`${RESULT_FILE}\``,
  'in this directory to report.',
  '',
  `When \`${PACKET_FILE}\` declares a \`toolProfile\`, it names this session's tool`,
  'contract — the allowlisted tools and office-spawned servers in scope. It is a declared',
  'boundary the office and provider flags enforce where they can, not a sandbox; honor it',
  'regardless, and never reach for a tool the profile does not name.',
  ...(options?.evidenceSurface ? [
    '',
    'This packet mounts the office evidence surface: write `queries/<name>.jsonl` — one',
    '`{"id":"<label>","op":"queryEvidence|readEvidence|stagePacket","args":{...}}` frame per',
    'line — then read `answers/<name>.jsonl` for `{id,result}` or `{id,refused}` lines. Every',
    'frame is grant-checked against this session\'s identity before any evidence bytes move.',
  ] : []),
  '',
  `## ${RESULT_FILE}`,
  '',
  `A single JSON object of at most ${MAX_RESULT_BYTES} bytes satisfying office-local-result@2:`,
  '',
  '- `schema` — the literal string `office-local-result@2`',
  `- \`jobId\`, \`assignmentId\`, \`attemptId\` — copied exactly from \`${PACKET_FILE}\``,
  `- \`packetHash\` — copy the trimmed contents of \`${PACKET_HASH_FILE}\` (also present`,
  `  in \`${PACKET_READY_FILE}\`). This field is NOT in \`${PACKET_FILE}\`. Do not use`,
  '  `snapshotManifestHash` or hash the formatted packet.json file: those are different',
  '  identities. A receipt for any other packet is refused even when its output hashes match.',
  '- `sequence` — a positive integer, strictly greater than the last receipt the office',
  '  verified for this attempt (start at 1)',
  `- \`state\` — one of ${RESULT_STATES.join(', ')}`,
  '- `detail` — a string of at most 4000 characters',
  `- \`outputs\` — an array of at most ${MAX_OUTPUTS} entries, each exactly`,
  `  \`{path, sha256, bytes}\` for a file under \`${OUTPUTS_DIR}/\` (0 to ${MAX_FILE} bytes)`,
  `- both \`${RESULT_FILE}\` and \`${CANCEL_ACK_FILE}\` are UTF-8 JSON without a`,
  '  byte-order mark — the office reads the exact bytes and a BOM-prefixed receipt',
  '  is unreadable',
  '',
  `One optional object may be added: \`applied\` carrying any of \`model\` (a string of at`,
  `most 200 characters), \`effort\` (one of ${efforts.join(', ')}) and \`delegation\` (a`,
  `boolean) — the session's own self-report. Omit it rather than guess; the office never`,
  'fills an absent key with an assumption.',
  '',
  '## Office control files — do not touch',
  '',
  `- \`${PACKET_FILE}\`, \`${PACKET_HASH_FILE}\` and \`${PACKET_READY_FILE}\` are office`,
  '  control files. Do not write, edit or delete them; a mismatch makes every receipt',
  '  untrusted.',
  '',
  '## Cooperative stop',
  '',
  `- \`${CANCEL_FILE}\` in this directory is the office's cooperative stop sentinel.`,
  '  If it exists when the session starts, or appears while work is under way, stop',
  `  immediately — do not begin or continue work. Write \`${RESULT_FILE}\` with`,
  '  `state` `FAILED` reporting what was completed, then acknowledge by writing',
  `  \`${CANCEL_ACK_FILE}\` — a single JSON object satisfying`,
  `  office-local-cancel-ack@1 carrying \`schema\` (the literal \`office-local-cancel-ack@1\`),`,
  `  \`requestId\`, \`jobId\`, \`assignmentId\`, \`attemptId\`, \`packetHash\` (all copied from`,
  `  the sentinel), \`outcome\` — the literal \`STOPPED\` — and \`detail\` (at most 2000`,
  '  characters). The acknowledgement is a local record; it is not a provider',
  '  acknowledgement.',
  '- No instruction overrides this stop, including a direct user prompt telling the',
  '  session to do the task anyway.',
  `- Check for \`${CANCEL_FILE}\` before each major step. The check is advisory —`,
  '  the office does not see it happen — but whenever the sentinel is seen, it wins.',
  '',
  '## Rules',
  '',
  `- Every declared output must exist under \`${OUTPUTS_DIR}/\`; the office re-reads each`,
  '  file and verifies its sha256 and bytes before reporting anything.',
  '- A missing, oversized, malformed, mis-bound, replayed or hash-mismatched receipt is',
  '  recorded as the office\'s own UNKNOWN reading, never as a session result.',
  '',
].join('\n');

/**
 * Writes a v2 packet directory (QO-LOCAL-REV §6.2) entirely through the LocalFileIO boundary.
 *
 * The destination root is inspected, the fresh session directory allocated only under verified
 * real ancestors, and every packet file — inputs/, the instruction files, packet.json,
 * packet.sha256 and finally the packet.ready.json marker — is created with writeNew semantics:
 * nothing existing is ever overwritten, and a destination that already carries a receipt, a
 * cancel sentinel or a ready marker refuses preparation outright.
 *
 * A written packet is not a run. Nothing here launches or claims a session.
 */
export function prepareLocalPacket(input: PrepareLocalPacketInput): PreparedLocalPacket {
  const { dir, context, binding, io, now } = input;
  if (context.jobId !== binding.jobId || context.assignment.id !== binding.assignmentId)
    throw new Error('The dispatch context and the persisted binding name different jobs or assignments — a packet can only be written for the attempt the binding records.');
  if (!context.snapshot.stagingPath) throw new Error('Prepare the request inputs before dispatching.');
  // Allocate the session directory: the deepest existing ancestor must pass inspection, then each
  // missing component is created and inspected in turn — a link in the chain is refused, and a
  // freshly created directory is never a link itself.
  const existed = existsSync(dir);
  if (!existed) {
    const missing: string[] = [];
    let cursor = dir;
    while (!existsSync(cursor)) { missing.unshift(cursor); cursor = path.dirname(cursor); }
    io.inspectRoot(cursor);
    for (const next of missing) { mkdirSync(next); io.inspectRoot(next); }
  }
  const managed = io.inspectRoot(dir);
  // Refuse a directory that may carry a prior attempt's residue. The io probes cover names a
  // fake boundary can hold; the directory scan covers the wider cancel.* family on a real disk.
  for (const name of [RESULT_FILE, PACKET_READY_FILE, CANCEL_FILE, CANCEL_ACK_FILE]) {
    try {
      io.read(managed, name, MAX_READY_BYTES);
    } catch (error) {
      if (/not present/.test(ioError(error))) continue;
      throw new Error(`The packet destination cannot be verified clean: reading ${name} failed — ${ioError(error)}`);
    }
    throw new Error(`The packet destination already contains ${name} — preparation refuses to touch a directory that may carry a prior attempt's residue.`);
  }
  if (existed) {
    for (const entry of readdirSync(managed)) {
      const name = entry.toLowerCase();
      if (name.startsWith('cancel.') && name !== CANCEL_FILE && name !== CANCEL_ACK_FILE)
        throw new Error(`The packet destination already contains ${entry} — preparation refuses to touch a directory that may carry a prior attempt's residue.`);
    }
  }
  // Copy every declared snapshot file into inputs/ — read through the boundary, re-verified
  // against the frozen manifest. A staged file that drifted fails the export loudly, and bytes
  // that failed verification are never written.
  const files: LocalPacketV2['files'] = [];
  for (const file of context.snapshot.files) {
    const staged = io.read(context.snapshot.stagingPath, file.path, MAX_FILE);
    if (staged.byteLength !== file.bytes || staged.sha256 !== file.sha256)
      throw new Error(`The staged input ${file.path} no longer matches the bytes that were frozen; prepare the request inputs again.`);
    const relativePath = `${INPUTS_DIR}/${file.path}`;
    const target = path.join(managed, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    io.writeNew(managed, relativePath, staged.bytes);
    files.push({ path: relativePath, sha256: staged.sha256, bytes: staged.byteLength });
  }
  // Verified predecessor outputs ride as ordinary inputs, under a path that names the producing
  // job. The bytes are re-hashed against the recorded object identity before anything is written —
  // a dependent never inherits an output it cannot prove byte-for-byte.
  const inherited: NonNullable<LocalPacketV2['inherited']> = [];
  for (const item of context.inherited ?? []) {
    const rel = item.name.startsWith(`${OUTPUTS_DIR}/`) ? item.name.slice(OUTPUTS_DIR.length + 1) : item.name;
    const relativePath = `${INPUTS_DIR}/inherited/${item.sourceJobId}/${rel}`;
    if (!safeEntry(rel) || !safeEntry(relativePath))
      throw new Error(`A predecessor output path is unsafe for inheritance: ${item.name}.`);
    const digest = createHash('sha256').update(item.bytes).digest('hex');
    if (digest !== item.objectHash || item.bytes.byteLength > MAX_FILE)
      throw new Error(`The predecessor output ${item.name} failed byte verification before it could be inherited.`);
    const target = path.join(managed, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    io.writeNew(managed, relativePath, item.bytes);
    inherited.push({ path: relativePath, sha256: digest, bytes: item.bytes.byteLength, sourceJobId: item.sourceJobId, objectHash: item.objectHash });
  }
  // Instruction files are ordinary packet members: written once, declared in the manifest.
  const instructions: LocalPacketV2['instructions'] = [];
  for (const [name, text] of [[AGENTS_FILE, packetAgentsV2()], [CLAUDE_FILE, packetClaude()], [CONTRACT_FILE, resultContractV2({ evidenceSurface: mountsEvidenceSurface(binding.toolProfile) })]] as const) {
    const content = Buffer.from(text, 'utf8');
    io.writeNew(managed, name, content);
    instructions.push({ path: name, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength });
  }
  const packet: LocalPacketV2 = localPacketV2Schema.parse({
    schema: 'office-local-session@2',
    jobId: binding.jobId,
    assignmentId: binding.assignmentId,
    attemptId: binding.attemptId,
    projectId: binding.projectId,
    createdAt: now,
    requestName: context.requestName,
    objective: context.objective,
    requested: { model: context.payload.model, effort: context.payload.effort, delegation: context.payload.delegation ?? false },
    payload: context.payload.text,
    snapshotManifestHash: context.snapshot.manifestHash,
    files,
    ...(inherited.length ? { inherited } : {}),
    instructions,
    ...(binding.toolProfile ? { toolProfile: binding.toolProfile } : {}),
    contract: CONTRACT_FILE,
  });
  io.writeNew(managed, PACKET_FILE, Buffer.from(`${JSON.stringify(packet, null, 2)}\n`, 'utf8'));
  const packetHash = canonicalHash(packet);
  io.writeNew(managed, PACKET_HASH_FILE, Buffer.from(`${packetHash}\n`, 'utf8'));
  // The ready marker is written last: a packet without it is unfinished preparation, and a
  // receipt can only be bound once the marker names this attempt and this packet hash.
  io.writeNew(managed, PACKET_READY_FILE, Buffer.from(`${JSON.stringify({ attemptId: binding.attemptId, packetHash }, null, 2)}\n`, 'utf8'));
  return { dir: managed, packet, packetHash };
}

/**
 * Reads a v2 receipt (QO-LOCAL-REV §6.3): every byte arrives through the LocalFileIO boundary.
 *
 * Order of proof, and none of it is optional: the ready marker must exist and name this attempt
 * and packet hash; the receipt must strictly satisfy office-local-result@2 (a v1-shaped receipt
 * on a v2 binding is a defect — PACKET-05); its jobId/assignmentId/attemptId/packetHash must equal
 * the binding's (a cross-attempt receipt is refused even with matching output hashes — PACKET-03);
 * its sequence must advance past the last verified receipt; and every declared output is re-read
 * and re-hashed under a per-file and aggregate byte cap. Verified output bytes are returned beside
 * the parsed result so the caller stores them without reopening the file.
 */
export function readLocalResult(dir: string, binding: LocalSessionRecord, io: LocalFileIO): ReaderResult<VerifiedLocalResult> {
  let readyFile: VerifiedLocalFile;
  try {
    readyFile = io.read(dir, PACKET_READY_FILE, MAX_READY_BYTES);
  } catch (error) {
    return defect(`the ready marker ${PACKET_READY_FILE} is not present — the packet never finished preparing, or the marker was removed (${ioError(error)}).`);
  }
  let ready: unknown;
  try {
    ready = parseStrictJson(Buffer.from(readyFile.bytes).toString('utf8'));
  } catch (error) {
    return defect(`the ready marker ${PACKET_READY_FILE} is not valid JSON (${ioError(error)}).`);
  }
  const marker = ready as Record<string, unknown>;
  if (!marker || typeof marker !== 'object' || marker.attemptId !== binding.attemptId || marker.packetHash !== binding.packetHash)
    return defect(`the ready marker ${PACKET_READY_FILE} does not name attempt ${binding.attemptId} and packet ${binding.packetHash} — a receipt cannot be bound to it.`);
  let resultFile: VerifiedLocalFile;
  try {
    resultFile = io.read(dir, RESULT_FILE, MAX_RESULT_BYTES);
  } catch (error) {
    return defect(`no ${RESULT_FILE} is present — the packet is still waiting for the user-launched local session to report (${ioError(error)}).`);
  }
  let raw: unknown;
  try {
    raw = parseStrictJson(Buffer.from(resultFile.bytes).toString('utf8'));
  } catch (error) {
    return defect(`${RESULT_FILE} cannot be trusted: it is not valid JSON (${ioError(error)}).`);
  }
  const parsed = localResultV2Schema.safeParse(raw);
  if (!parsed.success)
    return defect(`${RESULT_FILE} cannot be trusted: it does not satisfy office-local-result@2 (${parsed.error.issues.map(issue => `${issue.path.join('.') || 'receipt'}: ${issue.message}`).join('; ')}).`);
  const result = parsed.data;
  const mismatches = (['jobId', 'assignmentId', 'attemptId', 'packetHash'] as const).filter(key => result[key] !== binding[key]);
  if (mismatches.length)
    return defect(`${RESULT_FILE} cannot be trusted: it is bound to ${mismatches.map(key => `${key} ${JSON.stringify(result[key])}`).join(', ')} — this attempt expects ${mismatches.map(key => `${key} ${JSON.stringify(binding[key])}`).join(', ')}; a receipt for another attempt is refused even when its output hashes match.`);
  const priorSequence = binding.lastReceipt?.sequence ?? 0;
  if (result.sequence <= priorSequence)
    return defect(`${RESULT_FILE} cannot be trusted: it repeats or rewinds sequence ${result.sequence} — the last verified receipt for this attempt was sequence ${priorSequence} (hash ${binding.lastReceipt!.hash}); a receipt must advance.`);
  const outputs: VerifiedLocalResult['outputs'] = [];
  let total = 0;
  for (const output of result.outputs) {
    let file: VerifiedLocalFile;
    try {
      file = io.read(dir, output.path, MAX_FILE);
    } catch (error) {
      return defect(`${RESULT_FILE} declares ${output.path}, but that file cannot be read inside the session directory (${ioError(error)}).`);
    }
    if (file.byteLength !== output.bytes)
      return defect(`${RESULT_FILE} declares ${output.path} at ${output.bytes} bytes; the file on disk is ${file.byteLength} bytes.`);
    if (file.sha256 !== output.sha256)
      return defect(`${RESULT_FILE} declares ${output.path} as ${output.sha256}, but the file on disk hashes to ${file.sha256}.`);
    total += file.byteLength;
    if (total > MAX_TOTAL)
      return defect(`${RESULT_FILE} declares outputs totalling more than the ${MAX_TOTAL}-byte aggregate limit.`);
    outputs.push({ path: output.path, sha256: output.sha256, bytes: output.bytes, data: file.bytes });
  }
  return { value: { result, receiptHash: createHash('sha256').update(resultFile.bytes).digest('hex'), outputs } };
}

/**
 * The strict v1 receipt reader, moved verbatim from the mailbox adapter: a malformed, oversized
 * or mis-shaped result never becomes a reported outcome. Legacy packets keep this exact parser.
 */
export function readLocalResultV1(resultPath: string): ReaderResult<LocalResult> {
  const fail = (detail: string): ReaderResult<LocalResult> => defect(`${RESULT_FILE} cannot be trusted: ${detail}`);
  let raw: unknown;
  try {
    const bytes = statSync(resultPath).size;
    if (bytes > MAX_RESULT_BYTES) return fail(`it is ${bytes} bytes, over the ${MAX_RESULT_BYTES}-byte receipt limit.`);
    raw = parseStrictJson(readFileSync(resultPath, 'utf8'));
  } catch (error) {
    return fail(`it is not valid JSON (${error instanceof Error ? error.message : 'unknown parse failure'}).`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('it is not a JSON object.');
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = [...RESULT_REQUIRED_KEYS, ...RESULT_OPTIONAL_KEYS] as readonly string[];
  const extras = keys.filter(key => !allowed.includes(key));
  if (extras.length || !RESULT_REQUIRED_KEYS.every(key => key in record))
    return fail(`it must carry exactly state, detail and outputs (appliedModel, appliedEffort and delegation are the only permitted additions); found ${keys.sort().join(',') || 'no keys'}.`);
  if (typeof record.state !== 'string' || !(RESULT_STATES as readonly string[]).includes(record.state))
    return fail(`state ${JSON.stringify(record.state)} is not one of ${RESULT_STATES.join(', ')}.`);
  if (typeof record.detail !== 'string' || record.detail.length > 4000) return fail('detail must be a string of at most 4000 characters.');
  if (!Array.isArray(record.outputs) || record.outputs.length > MAX_OUTPUTS)
    return fail(`outputs must be an array of at most ${MAX_OUTPUTS} declared files.`);
  const outputs: LocalResult['outputs'] = [];
  const seen = new Set<string>();
  for (const item of record.outputs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('an output entry is not an object.');
    const output = item as Record<string, unknown>;
    if (Object.keys(output).sort().join(',') !== 'bytes,path,sha256') return fail('an output entry must carry exactly path, sha256 and bytes.');
    if (typeof output.path !== 'string' || !safeEntry(output.path)) return fail(`an output path is missing or unsafe: ${JSON.stringify(output.path)}.`);
    if (typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.sha256)) return fail(`an output sha256 is not a lowercase hex digest: ${JSON.stringify(output.sha256)}.`);
    if (typeof output.bytes !== 'number' || !Number.isSafeInteger(output.bytes) || output.bytes < 0 || output.bytes > MAX_FILE)
      return fail(`an output byte count is out of range: ${JSON.stringify(output.bytes)}.`);
    const key = output.path.toLowerCase();
    if (seen.has(key)) return fail(`the output path ${output.path} is declared twice.`);
    seen.add(key);
    outputs.push({ path: output.path, sha256: output.sha256, bytes: output.bytes });
  }
  // Optional self-reports are validated like everything else: a malformed claim is a defect in
  // the whole receipt, never a value to be silently dropped or carried anyway.
  if ('appliedModel' in record && (typeof record.appliedModel !== 'string' || record.appliedModel.length > 160))
    return fail('appliedModel must be a string of at most 160 characters.');
  if ('appliedEffort' in record && (typeof record.appliedEffort !== 'string' || !(efforts as readonly string[]).includes(record.appliedEffort)))
    return fail(`appliedEffort ${JSON.stringify(record.appliedEffort)} is not one of ${efforts.join(', ')}.`);
  if ('delegation' in record && typeof record.delegation !== 'boolean')
    return fail('delegation must be a boolean.');
  const value: LocalResult = { state: record.state as ResultState, detail: record.detail, outputs };
  if (typeof record.appliedModel === 'string') value.appliedModel = record.appliedModel;
  if (typeof record.appliedEffort === 'string') value.appliedEffort = record.appliedEffort as Effort;
  if (typeof record.delegation === 'boolean') value.delegation = record.delegation;
  return { value };
}

/** The cancel request/ack pair are tiny office control files. */
const MAX_CONTROL_BYTES = 64 * 1024;

/**
 * Reads and validates the cooperative-stop acknowledgement on a bound packet. An absent file is
 * not an observation at all; a present one must satisfy office-local-cancel-ack@1 and name the
 * exact request this binding recorded — anything less is a defect, never an ignored file. Shared
 * by every local adapter that reads v2 packets (mailbox, office-spawned exec).
 */
export function readLocalCancelAck(dir: string, binding: LocalSessionRecord, io: LocalFileIO): { ack?: { requestId: string; outcome: 'STOPPED'; detail: string } } | { defect: string } {
  const defect = (detail: string): { defect: string } => ({ defect: detail });
  let file;
  try {
    file = io.read(dir, CANCEL_ACK_FILE, MAX_CONTROL_BYTES);
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

/**
 * Delivers the cooperative-stop sentinel to a bound packet (QO-LOCAL-REV §8), shared by every
 * local adapter: the office writes cancel.requested bound to this attempt's identity. A returned
 * `acknowledged` means the office DELIVERED a request — never that anything stopped; the session
 * acknowledges by writing cancel.ack.json. Read-first idempotency: a request file that already
 * exists is either this exact request or a defect — the office never overwrites one.
 */
export function writeLocalCancelRequest(input: { dir: string; binding: LocalSessionRecord; io: LocalFileIO; now: string }): { acknowledged: boolean; detail: string; requestId?: string } {
  const { dir, binding: local, io, now } = input;
  if (local.packetHash === null)
    return { acknowledged: false, detail: 'This binding records no verified packet hash, so a cancel request cannot be bound to an attempt. Nothing was written; nothing has stopped.' };
  if (!existsSync(dir))
    return { acknowledged: false, detail: 'The recorded session directory is gone, so no session can be signalled. The cancellation stays requested; nothing has stopped.' };
  try {
    const existing = io.read(dir, CANCEL_FILE, MAX_CONTROL_BYTES);
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
    packetHash: local.packetHash, requestedAt: now,
  });
  try {
    io.writeNew(dir, CANCEL_FILE, Buffer.from(`${JSON.stringify(request, null, 2)}\n`, 'utf8'));
  } catch (error) {
    return { acknowledged: false, detail: `The cancel request could not be written: ${error instanceof Error ? error.message : 'unknown error'}. Nothing has stopped.` };
  }
  return { acknowledged: true, requestId: request.requestId, detail: `Cooperative cancel request ${request.requestId} delivered to ${dir}. The office delivered a request only — nothing has stopped; the session acknowledges by writing ${CANCEL_ACK_FILE} (office-local-cancel-ack@1). It is a local record, not a provider acknowledgement.` };
}
