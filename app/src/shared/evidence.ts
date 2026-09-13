import { z } from 'zod';
import type { JobEvidence } from './types.js';
import { STAGES } from './research.js';

/**
 * The evidence layer: what a stored byte range is, who may look at it, and what a claim about it is
 * allowed to say.
 *
 * The problem this exists to solve is that summaries are cheap and wrong quietly. An agent can read
 * a log, report "no leakage found", and be right about the part it read. So every statement here is
 * anchored to an exact object, an exact range and the bytes that were actually at that range, and
 * every answer carries how much of the requested material it did not cover.
 */

export const HASH = /^[a-f0-9]{64}$/;
const hash = z.string().regex(HASH);
const id = z.string().uuid();

/**
 * Where an object's bytes came from. This is the manifest's whole reason to exist: content addressing
 * makes two identical files one object, and without origin the office would lose the difference
 * between bytes a person imported and bytes a provider returned.
 */
export type EvidenceOrigin = 'IMPORTED_ARTIFACT' | 'INPUT_SNAPSHOT' | 'GENERATED_INPUT' | 'JOB_OUTPUT';

/**
 * One content-addressed object with its permitted provenance.
 *
 * `evidence` is never upgraded here. A user-imported result stays USER_REPORTED however many times it
 * is quoted; an office-staged input stays OFFICE_LOCAL. Reading an object through this layer is not
 * an event that makes it better attested than it was when it was stored.
 */
export interface ObjectManifestEntry {
  snapshotId?:string;
  sha256: string; bytes: number; origin: EvidenceOrigin;
  projectId: string; requestId: string | null; jobId: string | null;
  name: string; mediaType: string; evidence: JobEvidence;
  /** False when the record exists but the bytes do not — legacy snapshots, unstored outputs. */
  stored: boolean;
  /** True when a missing object is a workspace integrity failure rather than a known legacy gap. */
  required: boolean;
  provenance: string;
}

/** Why a read returned what it returned. An empty answer is not the same as a complete empty answer. */
export type Coverage = 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';

export interface ObjectDescription {
  sha256: string; name: string; bytes: number; mediaType: string; origin: EvidenceOrigin;
  evidence: JobEvidence; provenance: string;
  /** Null when the bytes are absent, so a caller cannot mistake "unknown length" for "empty". */
  lines: number | null; rows: number | null; text: boolean; coverage: Coverage; detail: string;
}

export interface ReadResult {
  sha256: string; name: string; from: number; to: number; lines: string[];
  returned: number; omitted: number; total: number | null;
  nextCursor: string | null; coverage: Coverage; detail: string; receiptId: string;
}

export interface SearchMatch { sha256: string; name: string; line: number; text: string; truncated?: boolean }
export interface SearchResult {
  matches: SearchMatch[]; returned: number; omitted: number;
  /** Objects that were in scope but could not be read. Their absence is why coverage may be PARTIAL. */
  unreadableObjects: string[]; searchedObjects: number;
  nextCursor: string | null; coverage: Coverage; detail: string; receiptId: string;
}

/**
 * A durable record of one answer this layer gave.
 *
 * Receipts exist so a later reviewer can ask what an agent was actually shown, and so a reused cache
 * entry is visibly a reuse rather than a fresh look at the evidence.
 */
export interface QueryReceipt {
  id: string; kind: 'DESCRIBE' | 'READ' | 'SEARCH' | 'PACKET';
  agentId: string; projectId: string; objectHashes: string[]; parameters: string;
  dependencyKey: string; returned: number; omitted: number; coverage: Coverage;
  /** Set when this answer came from the computation cache instead of the objects. */
  reusedFromReceiptId: string | null;
  createdAt: string;
  contextHash: string | null;
}

/** A quotation bound to bytes: the range and the hash of exactly what was at that range. */
export const evidenceRefSchema = z.object({
  objectHash: hash, fromLine: z.number().int().min(1), toLine: z.number().int().min(1), quoteHash: hash,
}).strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/**
 * A short statement of findings whose every claim carries its sources, plus what it could not see.
 *
 * `missingCoverage` is mandatory and may be empty only when the brief's receipts all reported COMPLETE.
 * A brief that quietly drops the objects it failed to read is the exact failure this slice is for.
 */
export const evidenceBriefSchema = z.object({
  id, projectId: id, subjectKind: z.enum(['REQUEST', 'BRANCH', 'JOB', 'STAGE_ATTEMPT']), subjectId: id,
  stage: z.enum(STAGES).nullable(),
  claims: z.array(z.object({ text: z.string().trim().min(1).max(4000), refs: z.array(evidenceRefSchema).min(1).max(64) }).strict()).min(1).max(64),
  missingCoverage: z.array(z.string().trim().min(1).max(1000)).max(64),
  receiptIds: z.array(id).max(256), dependencyKey: hash, createdAt: z.string().datetime(),
}).strict();
export type EvidenceBrief = z.infer<typeof evidenceBriefSchema>;

/** The raw answer is stored before any brief is validated, so a rejected brief loses nothing. */
export interface RawEvidenceOutput {
  id: string; projectId: string; agentId: string; subjectId: string;
  body: string; receiptIds: string[]; createdAt: string;
  /** Set when a brief was parsed out of this body; null while the body is all that survived. */
  briefId: string | null; briefError: string | null;
  contextHash: string | null;
}

export const queryReceiptSchema = z.object({
  id, kind: z.enum(['DESCRIBE', 'READ', 'SEARCH', 'PACKET']), agentId: id, projectId: id,
  objectHashes: z.array(hash), parameters: z.string(), dependencyKey: z.string().min(1),
  returned: z.number().int().nonnegative(), omitted: z.number().int().nonnegative(),
  coverage: z.enum(['COMPLETE', 'PARTIAL', 'UNKNOWN']), reusedFromReceiptId: id.nullable(),
  createdAt: z.string().datetime(), contextHash: hash.nullable(),
}).strict();
export const rawEvidenceOutputSchema = z.object({
  id, projectId: id, agentId: id, subjectId: id,
  body: z.string().max(1024 * 1024).refine(value => new TextEncoder().encode(value).length <= 1024 * 1024, 'Raw evidence exceeds 1 MiB.'),
  receiptIds: z.array(id).max(256), createdAt: z.string().datetime(), briefId: id.nullable(),
  briefError: z.string().max(4000).nullable(), contextHash: hash.nullable(),
}).strict();
const envelope = { id, projectId: id, agentId: id };
export const evidenceRecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...envelope, kind: z.literal('RECEIPT'), value: queryReceiptSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('RAW'), value: rawEvidenceOutputSchema }).strict(),
  z.object({ ...envelope, kind: z.literal('BRIEF'), value: evidenceBriefSchema }).strict(),
]).superRefine((record, ctx) => {
  if (record.projectId !== record.value.projectId ||
      ('agentId' in record.value && record.agentId !== record.value.agentId))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Evidence envelope attribution mismatch.' });
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

/** A compact stage packet: the assignment's evidence surface without its bytes. */
export interface StagePacket {
  projectId: string; subjectId: string; stage: string; agentId: string;
  objects: { sha256: string; name: string; bytes: number; origin: EvidenceOrigin; evidence: JobEvidence; lines: number | null }[];
  excludedObjects: number; totalBytes: number; receiptId: string;
  /** Text the packet builder must not silently omit: what the agent is not allowed to see, and why. */
  notes: string[];
}

export const describeRequestSchema = z.object({ agentId: id, objectHash: hash }).strict();
export const readRequestSchema = z.object({
  agentId: id, objectHash: hash, from: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2000).optional(), cursor: z.string().max(300).optional(),
}).strict();
export const searchRequestSchema = z.object({
  agentId: id, projectId: id, pattern: z.string().trim().min(1).max(400),
  objectHashes: z.array(hash).max(256).optional(),
  limit: z.number().int().min(1).max(500).optional(), cursor: z.string().max(300).optional(),
}).strict();
export const packetRequestSchema = z.object({
  agentId: id, projectId: id, subjectId: id, stage: z.enum(STAGES), maxObjects: z.number().int().min(1).max(256).optional(),
}).strict();

/**
 * The routes evidence may be retrieved through. Only a supported adapter route reaches a provider.
 *
 * A local HTTP endpoint is the easy way to make a hosted retrieval demo work, and it is exactly the
 * thing that must never be counted as one: the whole point of a hosted handle is that the provider,
 * not this machine, is holding the object. So a loopback address is refused by name rather than left
 * to a reviewer to notice in a URL.
 */
export type EvidenceRoute = 'LOCAL_WORKSPACE' | 'OFFICIAL_ADAPTER';
const LOOPBACK = /^(?:https?:\/\/)?(?:localhost|127(?:\.[0-9]{1,3}){3}|\[?::1\]?|0\.0\.0\.0)(?:[:/]|$)/i;
export function assertHostedRetrievalHandle(handle: string, route: EvidenceRoute): void {
  if (route !== 'OFFICIAL_ADAPTER')
    throw new Error('Evidence served from this workspace is local. It is not a hosted retrieval handle and must not be labelled as one.');
  if (LOOPBACK.test(handle.trim()) || !/^https:\/\//i.test(handle.trim()))
    throw new Error('A hosted retrieval handle must be a provider https address. A local or loopback path is not hosted retrieval.');
}
