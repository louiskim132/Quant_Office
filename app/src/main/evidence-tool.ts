import { z } from 'zod';
import { canonicalHash } from '../core/canonical.js';
import type { EvidenceService } from './evidence.js';
import {
  HASH,
  type QueryReceipt, type ReadResult, type SearchResult, type StagePacket,
} from '../shared/evidence.js';
import { STAGES } from '../shared/research.js';

/**
 * The agent-facing evidence query surface: a bounded, receipted view over EvidenceService.
 *
 * Grants are enforced inside the service before any bytes are read, so a denied call can never
 * return object content — this layer's job is to turn that denial into a structured, recorded
 * refusal instead of an exception, to cap how much one call can return, and to bind every
 * continuation cursor to the exact call scope it was issued under. A cursor minted for one agent,
 * project, request or query cannot be replayed onto another.
 */

const MAX_LIMIT = 100;
const callerSchema = z.object({
  agentId: z.string().uuid(), projectId: z.string().uuid(), requestId: z.string().uuid(),
  /** The minted hop the query rides on — memory.search authorization resolves it to a seat. */
  assignmentId: z.string().uuid().optional(),
}).strict();
export type EvidenceCaller = z.infer<typeof callerSchema>;

const cursorField = z.string().min(1).max(4000);
const queryEvidenceArgs = z.object({
  pattern: z.string().trim().min(1).max(400),
  objectHashes: z.array(z.string().regex(HASH)).max(256).optional(),
  limit: z.number().int().min(1).optional(),
  cursor: cursorField.optional(),
}).strict();
const readEvidenceArgs = z.object({
  objectHash: z.string().regex(HASH),
  limit: z.number().int().min(1).optional(),
  cursor: cursorField.optional(),
}).strict();
const stagePacketArgs = z.object({
  subjectId: z.string().uuid(),
  stage: z.enum(STAGES),
  maxObjects: z.number().int().min(1).optional(),
}).strict();
const memorySearchArgs = z.object({
  text: z.string().trim().min(1).max(400),
  limit: z.number().int().min(1).max(25).optional(),
}).strict();

/**
 * The args shape per op, as agents are told it in the packet contract and in every MALFORMED
 * refusal — a guessed key is corrected by the very next frame instead of by trial and error.
 */
export const EVIDENCE_ARGS: Record<'queryEvidence' | 'readEvidence' | 'stagePacket' | 'memorySearch', string> = {
  queryEvidence: '{"pattern":"<literal text, matched per line>","objectHashes"?:["<64-hex>"],"limit"?:<n>,"cursor"?:"<nextCursor>"}',
  readEvidence: '{"objectHash":"<64-hex from a queryEvidence hit>","limit"?:<lines>,"cursor"?:"<nextCursor>"}',
  stagePacket: `{"subjectId":"<uuid>","stage":"S0".."S10","maxObjects"?:<n>}`,
  memorySearch: '{"text":"<words to find>","limit"?:<1-25>}',
};
const malformed = (op: keyof typeof EVIDENCE_ARGS): string => `${op} arguments are malformed; expected args ${EVIDENCE_ARGS[op]} and no other keys.`;

const callSchema = z.object({
  op: z.enum(['queryEvidence', 'readEvidence', 'stagePacket', 'memorySearch']),
  args: z.unknown(),
}).strict();
export type EvidenceOp = z.infer<typeof callSchema>['op'];
export interface EvidenceCall { op: EvidenceOp; args: unknown }

const RECEIPT_KIND: Record<EvidenceOp, QueryReceipt['kind']> = {
  queryEvidence: 'SEARCH', readEvidence: 'READ', stagePacket: 'PACKET', memorySearch: 'SEARCH',
};

export interface EvidenceQueryResult extends Omit<SearchResult, 'nextCursor'> {
  total: number | 'UNKNOWN_TOTAL'; nextCursor: string | null;
}
export interface EvidenceReadResult extends Omit<ReadResult, 'total' | 'nextCursor'> {
  total: number | 'UNKNOWN_TOTAL'; nextCursor: string | null;
}
export interface EvidencePacketResult extends StagePacket { returned: number; total: number; nextCursor: null }
export interface MemorySearchResult { returned: number; total: number; findings: { id: string; kind: string; title: string; body: string; evidenceRefs: unknown[]; createdAt: string; superseded: boolean }[]; nextCursor: null }
export type EvidenceToolResult = EvidenceQueryResult | EvidenceReadResult | EvidencePacketResult | MemorySearchResult;

export interface EvidenceRefusal {
  reason: 'MALFORMED' | 'OUT_OF_SCOPE' | 'CURSOR_MISMATCH' | 'FAILED';
  detail: string;
  /** Receipt id when the refusal could be recorded against a well-formed caller; null otherwise. */
  denialReceiptId: string | null;
}
export type EvidenceToolResponse = { result: EvidenceToolResult } | { refused: EvidenceRefusal };

/**
 * The opaque cursor carries the position plus the total declared when the page sequence began — a
 * continuation reports the whole query's count, not just the slice it returned. The scope it is
 * bound to is a hash, never the query text.
 */
interface ToolCursor { scope: string; at: string; total?: number | 'UNKNOWN_TOTAL' }
const INNER_CURSOR = /^[a-f0-9]{64}:[1-9][0-9]{0,9}$/;

const scopeKey = (caller: EvidenceCaller, op: EvidenceOp, bind: unknown): string =>
  canonicalHash({ surface: 'evidence-tool', op, agentId: caller.agentId, projectId: caller.projectId, requestId: caller.requestId, bind });

const encodeCursor = (scope: string, at: string, total: number | 'UNKNOWN_TOTAL'): string =>
  Buffer.from(JSON.stringify({ scope, at, total }), 'utf8').toString('base64url');

const decodeCursor = (raw: string): ToolCursor | 'MALFORMED' => {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || typeof (value as ToolCursor).scope !== 'string'
      || !INNER_CURSOR.test((value as ToolCursor).at)) return 'MALFORMED';
    const total = (value as ToolCursor).total;
    if (total !== undefined && total !== 'UNKNOWN_TOTAL' && !(typeof total === 'number' && Number.isInteger(total) && total >= 0)) return 'MALFORMED';
    return value as ToolCursor;
  } catch { return 'MALFORMED'; }
};

const classify = (error: unknown): EvidenceRefusal['reason'] => {
  const message = error instanceof Error ? error.message : '';
  if (message === 'This object is not available to this agent.'
    || message === 'No stored object in this project is available to this agent.') return 'OUT_OF_SCOPE';
  if (message.startsWith('This cursor does not belong')) return 'CURSOR_MISMATCH';
  return 'FAILED';
};

async function deny(service: EvidenceService, caller: EvidenceCaller | null, op: EvidenceOp | null,
  parameters: unknown, reason: EvidenceRefusal['reason'], detail: string): Promise<EvidenceToolResponse> {
  const receipt = caller && op
    ? await service.recordDenial({ kind: RECEIPT_KIND[op], agentId: caller.agentId, projectId: caller.projectId, parameters: { denied: true, reason, op, parameters } })
    : null;
  return { refused: { reason, detail, denialReceiptId: receipt?.id ?? null } };
}

/** Decodes and scope-checks a cursor, or returns the refusal to send. */
function resume(cursor: string | undefined, scope: string): { at?: string; total?: number | 'UNKNOWN_TOTAL'; refusal?: 'MALFORMED' | 'CURSOR_MISMATCH' } {
  if (!cursor) return {};
  const decoded = decodeCursor(cursor);
  if (decoded === 'MALFORMED') return { refusal: 'MALFORMED' };
  if (decoded.scope !== scope) return { refusal: 'CURSOR_MISMATCH' };
  return { at: decoded.at, total: decoded.total };
}

const cursorDetail: Record<'MALFORMED' | 'CURSOR_MISMATCH', string> = {
  MALFORMED: 'The cursor is malformed; issue the call without a cursor to start over.',
  CURSOR_MISMATCH: 'The cursor belongs to a different call scope and cannot continue this call.',
};

/**
 * One bounded evidence call. Whatever the outcome, the response is a plain object — either
 * `{result}` with a declared total or `{refused}` with a recorded denial — never a thrown exception
 * carrying data.
 */
export async function handleEvidenceCall(service: EvidenceService, caller: unknown, call: unknown): Promise<EvidenceToolResponse> {
  const who = callerSchema.safeParse(caller);
  if (!who.success) return {
    refused: { reason: 'MALFORMED', detail: 'The caller identity is malformed; nothing was queried and nothing could be recorded.', denialReceiptId: null },
  };
  const me = who.data;
  const parsedCall = callSchema.safeParse(call);
  if (!parsedCall.success)
    return deny(service, me, null, call, 'MALFORMED', 'The call is not a known evidence operation (queryEvidence, readEvidence, stagePacket, memorySearch).');
  const { op, args } = parsedCall.data;

  if (op === 'queryEvidence') {
    const parsed = queryEvidenceArgs.safeParse(args);
    if (!parsed.success) return deny(service, me, op, args, 'MALFORMED', malformed('queryEvidence'));
    const bind = { pattern: parsed.data.pattern, objectHashes: parsed.data.objectHashes?.slice().sort() ?? null };
    const scope = scopeKey(me, op, bind);
    const resumed = resume(parsed.data.cursor, scope);
    if (resumed.refusal) return deny(service, me, op, parsed.data, resumed.refusal, cursorDetail[resumed.refusal]);
    try {
      const result = await service.query({
        agentId: me.agentId, projectId: me.projectId, pattern: parsed.data.pattern,
        ...(parsed.data.objectHashes ? { objectHashes: parsed.data.objectHashes } : {}),
        limit: Math.min(MAX_LIMIT, parsed.data.limit ?? MAX_LIMIT),
        ...(resumed.at ? { cursor: resumed.at } : {}),
      });
      const { nextCursor, ...rest } = result;
      const total = result.unreadableObjects.length ? 'UNKNOWN_TOTAL' as const
        : resumed.total ?? result.returned + result.omitted;
      return { result: { ...rest, total,
        nextCursor: nextCursor ? encodeCursor(scope, nextCursor, total) : null } };
    } catch (error) {
      return deny(service, me, op, parsed.data, classify(error), error instanceof Error ? error.message : 'The query failed.');
    }
  }

  if (op === 'readEvidence') {
    const parsed = readEvidenceArgs.safeParse(args);
    if (!parsed.success) return deny(service, me, op, args, 'MALFORMED', malformed('readEvidence'));
    const scope = scopeKey(me, op, { objectHash: parsed.data.objectHash });
    const resumed = resume(parsed.data.cursor, scope);
    if (resumed.refusal) return deny(service, me, op, parsed.data, resumed.refusal, cursorDetail[resumed.refusal]);
    try {
      const result = await service.read({
        agentId: me.agentId, objectHash: parsed.data.objectHash,
        limit: Math.min(MAX_LIMIT, parsed.data.limit ?? MAX_LIMIT),
        ...(resumed.at ? { cursor: resumed.at } : {}),
      });
      const { nextCursor, total, ...rest } = result;
      const declared = total ?? 'UNKNOWN_TOTAL';
      return { result: { ...rest, total: declared,
        nextCursor: nextCursor ? encodeCursor(scope, nextCursor, declared) : null } };
    } catch (error) {
      return deny(service, me, op, parsed.data, classify(error), error instanceof Error ? error.message : 'The read failed.');
    }
  }

  if (op === 'memorySearch') {
    const parsed = memorySearchArgs.safeParse(args);
    if (!parsed.success) return deny(service, me, op, args, 'MALFORMED', malformed('memorySearch'));
    try {
      const result = await service.memorySearch(me, parsed.data);
      return { result: { ...result, nextCursor: null } };
    } catch (error) {
      return deny(service, me, op, parsed.data, classify(error), error instanceof Error ? error.message : 'The memory search failed.');
    }
  }

  const parsed = stagePacketArgs.safeParse(args);
  if (!parsed.success) return deny(service, me, op, args, 'MALFORMED', malformed('stagePacket'));
  try {
    const packet = await service.stagePacket({
      agentId: me.agentId, projectId: me.projectId, subjectId: parsed.data.subjectId, stage: parsed.data.stage,
      maxObjects: Math.min(MAX_LIMIT, parsed.data.maxObjects ?? MAX_LIMIT),
    });
    return { result: { ...packet, returned: packet.objects.length, total: packet.objects.length + packet.excludedObjects, nextCursor: null } };
  } catch (error) {
    return deny(service, me, op, parsed.data, classify(error), error instanceof Error ? error.message : 'The packet build failed.');
  }
}

/**
 * One JSONL frame `{id, op, args}` in, one JSON line `{id, result}` or `{id, refused}` out — the
 * transport-agnostic edge the organizer mounts over a packet-dir channel.
 */
export async function handleEvidenceFrame(service: EvidenceService, caller: unknown, line: string): Promise<string> {
  let frame: unknown = null;
  try { frame = JSON.parse(line); } catch { /* malformed below */ }
  const id = frame && typeof frame === 'object' && typeof (frame as { id?: unknown }).id === 'string'
    ? (frame as { id: string }).id : null;
  if (!frame || typeof frame !== 'object' || id === null)
    return JSON.stringify({ id, refused: { reason: 'MALFORMED', detail: 'A frame is one JSON object carrying a string id, an op and args.', denialReceiptId: null } });
  const response = await handleEvidenceCall(service, caller,
    { op: (frame as { op?: unknown }).op, args: (frame as { args?: unknown }).args });
  return JSON.stringify({ id, ...response });
}
