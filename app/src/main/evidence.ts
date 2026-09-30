import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { removeTree } from './fsx.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalHash } from '../core/canonical.js';
import { parseStrictJson } from '../core/strict-json.js';
import type { OfficeStore } from '../core/store.js';
import { isTerminalJob } from '../core/jobs.js';
import { extractStreamedArchive } from './archive.js';
import type { AppState } from '../shared/types.js';
import {
  describeRequestSchema,
  evidenceBriefSchema,
  evidenceRecordSchema,
  packetRequestSchema,
  readRequestSchema,
  searchRequestSchema,
  type EvidenceRecord,
  type Coverage,
  type EvidenceBrief,
  type ObjectDescription,
  type ObjectManifestEntry,
  type QueryReceipt,
  type RawEvidenceOutput,
  type ReadResult,
  type SearchMatch,
  type SearchResult,
  type StagePacket,
} from '../shared/evidence.js';

const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);
const MAX_TEXT_OBJECT = 32 * 1024 * 1024;
const DEFAULT_READ_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;

function mediaType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return (
    (
      {
        '.json': 'application/json',
        '.csv': 'text/csv',
        '.md': 'text/markdown',
        '.txt': 'text/plain',
        '.py': 'text/plain',
        '.log': 'text/plain',
        '.jsonl': 'text/plain',
      } as Record<string, string>
    )[extension] || 'application/octet-stream'
  );
}
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Reads, searches and quotes stored objects under an explicit permission check.
 *
 * Two rules shape everything below. Grants are checked in main before an index lookup or a cache hit,
 * because a cache that answers first is a cache that leaks; and every answer reports what it omitted,
 * because "no matches" and "could not read four of the six logs" must never render as the same result.
 */
export class EvidenceService {
  private receipts: QueryReceipt[] = [];
  private briefs: EvidenceBrief[] = [];
  private raw: RawEvidenceOutput[] = [];
  /** Dependency-keyed answers. The key includes the object bytes and the current gate/review state. */
  private cache = new Map<string, { receiptId: string; payload: unknown }>();

  /** `backups` are archives consulted only when a local object is missing; they are never written to. */
  constructor(
    private readonly store: OfficeStore,
    private readonly root: string,
    private readonly backups: string[] = [],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    for (const input of store.evidenceRecords()) {
      const record = evidenceRecordSchema.parse(input);
      if (record.kind === 'RECEIPT') this.receipts.push(record.value);
      else if (record.kind === 'BRIEF') this.briefs.push(record.value);
      else this.raw = [...this.raw.filter(item => item.id !== record.value.id), record.value];
    }
  }

  /**
   * Office-authorized memory retrieval — bounded full-text search over the project's finding
   * ledger. The caller must carry its assignment identity, and only the director's synthesis
   * seats (plan-synthesis, analysis-finalize) are authorized: memory never silently enters an
   * independent research-review arm's context. Throws on an unauthorized caller — the tool
   * layer records the denial.
   */
  async memorySearch(
    caller: { agentId: string; projectId: string; assignmentId?: string },
    args: { text: string; limit?: number },
  ): Promise<{
    returned: number;
    total: number;
    findings: {
      id: string;
      kind: string;
      title: string;
      body: string;
      evidenceRefs: unknown[];
      createdAt: string;
      superseded: boolean;
    }[];
  }> {
    if (!caller.assignmentId)
      throw new Error(
        'Memory search requires an assignment-scoped caller — the office authorizes retrieval per hop, not per agent.',
      );
    const auth = this.store.authorizeMemorySearch(caller.assignmentId);
    if (!auth.ok) throw new Error(auth.reason);
    const findings = this.store.searchMemoryFindings(caller.projectId, args.text, Math.min(25, args.limit ?? 10));
    return {
      returned: findings.length,
      total: findings.length,
      findings: findings.map(item => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        body: item.body,
        evidenceRefs: item.evidenceRefs,
        createdAt: item.createdAt,
        superseded: !!item.supersededById,
      })),
    };
  }

  private researchScope(agentId: string, state = this.store.snapshot({ history: false })) {
    const assignments = (state.assignments ?? []).filter(a => a.agentId === agentId && a.research);
    if (!assignments.length) return null; // Legacy grants are not verified blinded access.
    // The scope is the live appointment: an agent serving consecutive stages is bound to the one
    // whose job is still open. Two different live contexts is a leak, not a choice — refuse. With
    // nothing live, the most recent appointment still says what this agent was last scoped to.
    const open = assignments.filter(a => {
      const job = (state.jobs ?? []).find(item => item.assignmentId === a.id);
      return job !== undefined && !isTerminalJob(job.state);
    });
    const pool = open.length ? open : assignments.slice(-1);
    if (new Set(pool.map(a => a.research!.contextHash)).size !== 1)
      throw new Error('This object is not available to this agent.');
    return pool[0];
  }

  private persist(record: EvidenceRecord): void {
    this.store.recordEvidence(evidenceRecordSchema.parse(record));
  }

  private objectPath(hash: string): string {
    return path.join(this.root, 'objects', hash.slice(0, 2), hash);
  }

  // ---- manifest -------------------------------------------------------------------------------

  /**
   * Every object the workspace owns, with the provenance it is permitted to claim.
   *
   * Content addressing means one hash can be reached from several records, so entries are kept per
   * record rather than merged: a file that is both a staged input and a returned output must not have
   * the stronger of the two attestations quietly applied to the other.
   */
  manifest(state: AppState = this.store.snapshot({ history: false })): Map<string, ObjectManifestEntry[]> {
    const cached = this.manifestCache.get(state);
    if (cached) return cached;
    const manifest = new Map<string, ObjectManifestEntry[]>();
    const add = (entry: ObjectManifestEntry) => {
      const list = manifest.get(entry.sha256) ?? [];
      list.push({ ...entry, stored: existsSync(this.objectPath(entry.sha256)) });
      manifest.set(entry.sha256, list);
    };
    for (const artifact of state.artifacts)
      add({
        sha256: artifact.sha256,
        bytes: artifact.size,
        origin: 'IMPORTED_ARTIFACT',
        projectId: artifact.projectId,
        requestId: null,
        jobId: null,
        name: artifact.name,
        mediaType: artifact.mediaType,
        evidence: 'USER_REPORTED',
        stored: false,
        required: true,
        provenance: `User-imported ${artifact.kind.toLowerCase()} (${artifact.classification}, ${artifact.status}). Not provider-verified.`,
      });
    for (const snapshot of state.snapshots ?? []) {
      const required = snapshot.objectsStored === true;
      for (const file of snapshot.files)
        add({
          sha256: file.sha256,
          bytes: file.bytes,
          origin: 'INPUT_SNAPSHOT',
          snapshotId: snapshot.id,
          projectId: snapshot.projectId,
          requestId: snapshot.requestId,
          jobId: null,
          name: file.path,
          mediaType: mediaType(file.path),
          evidence: 'OFFICE_LOCAL',
          stored: false,
          required,
          provenance: `Frozen request input from snapshot ${snapshot.id}, staged by the office.`,
        });
      for (const file of snapshot.generated ?? [])
        add({
          sha256: file.sha256,
          bytes: file.bytes,
          origin: 'GENERATED_INPUT',
          snapshotId: snapshot.id,
          projectId: snapshot.projectId,
          requestId: snapshot.requestId,
          jobId: null,
          name: file.path,
          mediaType: mediaType(file.path),
          evidence: 'OFFICE_LOCAL',
          stored: false,
          required,
          provenance: `Office-written bookkeeping in snapshot ${snapshot.id}.`,
        });
    }
    for (const job of state.jobs ?? [])
      for (const output of job.outputs)
        add({
          sha256: output.sha256,
          bytes: output.bytes,
          origin: 'JOB_OUTPUT',
          projectId: job.projectId,
          requestId: job.requestId,
          jobId: job.id,
          name: output.path,
          mediaType: mediaType(output.path),
          evidence: job.evidence,
          stored: false,
          required: output.stored === true,
          provenance: `Output of job ${job.id} (${job.state}); attested ${job.evidence}.`,
        });
    this.manifestCache.set(state, manifest);
    return manifest;
  }
  private readonly manifestCache = new WeakMap<AppState, Map<string, ObjectManifestEntry[]>>();

  // ---- grants ---------------------------------------------------------------------------------

  /**
   * The entries of one object this agent may see, or an error naming nothing about the object.
   *
   * A denial must not become a probe. Reporting "you lack a grant for request X" would confirm that X
   * holds these bytes, which is exactly what a reviewer blinded to another subject must not learn, so
   * every refusal below says the same thing.
   */
  private permitted(
    agentId: string,
    hash: string,
    state: AppState = this.store.snapshot({ history: false }),
  ): ObjectManifestEntry[] {
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent || agent.removedAt) throw new Error('This object is not available to this agent.');
    const grants = (state.grants ?? []).filter(g => g.agentId === agentId && !g.revokedAt);
    const assignment = this.researchScope(agentId, state);
    if (assignment?.research?.reviewRoundId)
      this.store.assertIsolatedLaunch(
        assignment.id,
        (state.jobs ?? []).find(j => j.assignmentId === assignment.id)?.route ?? '',
      );
    const entries = this.manifest(state).get(hash) ?? [];
    const allowed = entries.filter(entry =>
      assignment
        ? entry.projectId === assignment.projectId &&
          assignment.research!.objectHashes.includes(hash) &&
          entry.snapshotId === assignment.snapshotId &&
          (entry.requestId === null || entry.requestId === assignment.requestId) &&
          grants.some(g => g.projectId === assignment.projectId && g.requestId === assignment.requestId)
        : entry.requestId === null
          ? grants.some(g => g.projectId === entry.projectId)
          : grants.some(g => g.requestId === entry.requestId && g.projectId === entry.projectId),
    );
    if (!allowed.length) throw new Error('This object is not available to this agent.');
    return allowed;
  }

  /** Every object this agent may read in one project, ordered so cursors and cache keys are stable. */
  private accessible(
    agentId: string,
    projectId: string,
    state: AppState = this.store.snapshot({ history: false }),
  ): ObjectManifestEntry[] {
    const chosen: ObjectManifestEntry[] = [];
    for (const [hash] of this.manifest(state)) {
      let allowed: ObjectManifestEntry[];
      try {
        allowed = this.permitted(agentId, hash, state);
      } catch {
        continue;
      }
      const entry = allowed.find(item => item.projectId === projectId);
      if (entry) chosen.push(entry);
    }
    return chosen.sort((a, b) => a.sha256.localeCompare(b.sha256));
  }

  // ---- bytes ----------------------------------------------------------------------------------

  /**
   * The bytes of one object, from the workspace or, failing that, from a backup.
   *
   * Selected archives provide bounded, hash-checked byte recovery only. This does not verify a
   * workspace backup's manifest, lineage or provenance; full restore owns those checks.
   */
  async bytes(hash: string): Promise<Uint8Array | null> {
    const local = this.objectPath(hash);
    if (existsSync(local)) {
      const data = await readFile(local);
      if (sha256(data) === hash) return data;
      throw new Error(`A stored object no longer matches its identity: ${hash}`);
    }
    for (const backup of this.backups) {
      const recovered = await this.fromBackup(backup, hash);
      if (recovered) return recovered;
    }
    return null;
  }

  private async fromBackup(backup: string, hash: string): Promise<Uint8Array | null> {
    if (!existsSync(backup)) return null;
    const entry = 'objects/' + hash;
    const metadata = await stat(backup);
    if (!metadata.isFile() || metadata.size > 256 * 1024 * 1024)
      throw new Error('Evidence archive exceeds the bounded retrieval limit; use verified workspace restore.');
    const directory = await mkdtemp(path.join(tmpdir(), 'quant-office-evidence-'));
    try {
      const extracted = await extractStreamedArchive(backup, directory, {
        maxEntries: 4096,
        maxEntryBytes: 64 * 1024 * 1024,
        maxTotalBytes: 256 * 1024 * 1024,
      });
      if (!extracted.entries.some(item => item.path === entry)) return null;
      const data = await readFile(path.join(directory, ...entry.split('/')));
      if (sha256(data) !== hash) throw new Error(`A backup object does not match its identity: ${hash}`);
      return data;
    } finally {
      await removeTree(directory);
    }
  }

  private async lines(entry: ObjectManifestEntry): Promise<string[] | null> {
    if (!TEXT_TYPES.has(entry.mediaType) || entry.bytes > MAX_TEXT_OBJECT) return null;
    const data = await this.bytes(entry.sha256);
    if (!data) return null;
    const text = Buffer.from(data).toString('utf8');
    return text.length === 0 ? [] : text.replace(/\n$/, '').split(/\r?\n/);
  }

  // ---- cache ----------------------------------------------------------------------------------

  /**
   * The identity of an answer: its inputs' bytes and the review state that decides what they mean.
   *
   * Deliberately not the filenames or the question's wording. A file can be replaced under its name,
   * and two differently worded questions about the same range deserve the same evidence; keying on
   * either would reuse an interpretation of material that is no longer there.
   */
  private dependencyKey(
    kind: string,
    objects: ObjectManifestEntry[],
    parameters: unknown,
    state: AppState,
    agentId: string,
  ): string {
    if (!objects.length) throw new Error('An evidence answer must be keyed to at least one stored object.');
    const assignment = this.researchScope(agentId, state);
    const projects = new Set(objects.map(o => o.projectId));
    const branches = new Set((state.branches ?? []).filter(b => projects.has(b.projectId)).map(b => b.id));
    const gates = (state.receipts ?? [])
      .filter(r =>
        assignment
          ? r.subjectHash === assignment.research!.subjectHash && r.specId === assignment.research!.specId
          : branches.has(r.branchId),
      )
      .map(r => [r.id, r.gate, r.outcome, r.subjectHash] as const)
      .sort();
    const reviews = (state.decisions ?? [])
      .filter(d => (assignment ? d.requestId === assignment.requestId : projects.has(d.projectId)))
      .map(d => [d.id, d.verdict, d.phase, d.bundleHash] as const)
      .sort();
    return canonicalHash({
      kind,
      parameters,
      agentId,
      context: assignment?.research ?? null,
      objects: objects.slice().sort((a, b) => a.sha256.localeCompare(b.sha256)),
      gates,
      reviews,
    });
  }

  private async receipt(input: Omit<QueryReceipt, 'id' | 'createdAt' | 'contextHash'>): Promise<QueryReceipt> {
    const receipt: QueryReceipt = {
      ...input,
      id: randomUUID(),
      createdAt: this.now(),
      contextHash: this.researchScope(input.agentId)?.research?.contextHash ?? null,
    };
    this.persist({
      id: randomUUID(),
      projectId: receipt.projectId,
      agentId: receipt.agentId,
      kind: 'RECEIPT',
      value: receipt,
    });
    this.receipts.push(receipt);
    return receipt;
  }

  /** Answers from the cache still cost a receipt, so a reused interpretation is visible as reuse. */
  private async cached<T extends object>(
    key: string,
    kind: QueryReceipt['kind'],
    agentId: string,
    projectId: string,
    objects: ObjectManifestEntry[],
    parameters: unknown,
    compute: () => Promise<{ value: T; returned: number; omitted: number; coverage: Coverage }>,
  ): Promise<T & { receiptId: string }> {
    const context = this.researchScope(agentId)?.research?.contextHash;
    const recheck = () => {
      const current = this.store.snapshot({ history: false });
      for (const object of objects) this.permitted(agentId, object.sha256, current);
      if (this.researchScope(agentId, current)?.research?.contextHash !== context)
        throw new Error('This object is not available to this agent.');
    };
    recheck();
    const hit = this.cache.get(key);
    if (hit) {
      const previous = this.receipts.find(r => r.id === hit.receiptId);
      const receipt = await this.receipt({
        kind,
        agentId,
        projectId,
        objectHashes: objects.map(o => o.sha256),
        parameters: JSON.stringify(parameters),
        dependencyKey: key,
        returned: previous?.returned ?? 0,
        omitted: previous?.omitted ?? 0,
        coverage: previous?.coverage ?? 'UNKNOWN',
        reusedFromReceiptId: hit.receiptId,
      });
      return { ...(hit.payload as T), receiptId: receipt.id };
    }
    const computed = await compute();
    recheck();
    const receipt = await this.receipt({
      kind,
      agentId,
      projectId,
      objectHashes: objects.map(o => o.sha256),
      parameters: JSON.stringify(parameters),
      dependencyKey: key,
      returned: computed.returned,
      omitted: computed.omitted,
      coverage: computed.coverage,
      reusedFromReceiptId: null,
    });
    this.cache.set(key, { receiptId: receipt.id, payload: computed.value });
    return { ...computed.value, receiptId: receipt.id };
  }

  /**
   * A refused call is recorded as its own receipt: the attempt is evidence even when no bytes moved.
   *
   * The record names the caller, the operation and the refusal — never an object, because a denied
   * caller must not learn what it could not reach. Returns null when the caller's identity cannot
   * even form a valid record, so the refusing surface can still answer honestly.
   */
  async recordDenial(input: {
    kind: QueryReceipt['kind'];
    agentId: string;
    projectId: string;
    parameters: unknown;
  }): Promise<QueryReceipt | null> {
    try {
      let contextHash: string | null = null;
      try {
        contextHash = this.researchScope(input.agentId)?.research?.contextHash ?? null;
      } catch {
        contextHash = null;
      }
      const receipt: QueryReceipt = {
        id: randomUUID(),
        kind: input.kind,
        agentId: input.agentId,
        projectId: input.projectId,
        objectHashes: [],
        parameters: JSON.stringify(input.parameters),
        dependencyKey:
          'denied:' +
          canonicalHash({
            kind: input.kind,
            agentId: input.agentId,
            projectId: input.projectId,
            parameters: input.parameters,
          }),
        returned: 0,
        omitted: 0,
        coverage: 'UNKNOWN',
        reusedFromReceiptId: null,
        createdAt: this.now(),
        contextHash,
      };
      this.persist({
        id: randomUUID(),
        projectId: receipt.projectId,
        agentId: receipt.agentId,
        kind: 'RECEIPT',
        value: receipt,
      });
      this.receipts.push(receipt);
      return receipt;
    } catch {
      return null;
    } // Recording is best-effort; a denial it cannot record must still refuse cleanly.
  }

  // ---- describe / read / query ----------------------------------------------------------------

  async describe(input: unknown): Promise<ObjectDescription> {
    const request = describeRequestSchema.parse(input);
    const state = this.store.snapshot({ history: false });
    const entry = this.permitted(request.agentId, request.objectHash, state)[0];
    const lines = await this.lines(entry);
    const stored = lines !== null || (await this.bytes(entry.sha256)) !== null;
    this.permitted(request.agentId, request.objectHash);
    const text = TEXT_TYPES.has(entry.mediaType);
    return {
      sha256: entry.sha256,
      name: entry.name,
      bytes: entry.bytes,
      mediaType: entry.mediaType,
      origin: entry.origin,
      evidence: entry.evidence,
      provenance: entry.provenance,
      text,
      lines: lines ? lines.length : null,
      rows: lines && entry.mediaType === 'text/csv' ? Math.max(lines.length - 1, 0) : null,
      coverage: stored ? 'COMPLETE' : 'UNKNOWN',
      detail: stored
        ? text
          ? 'Readable as text.'
          : 'Stored; not read as text.'
        : entry.required
          ? 'The bytes of this object are missing from the workspace and every consulted backup. This is an integrity failure, not an empty object.'
          : 'This record was created before its bytes were stored durably, so its content is unavailable. Prepare the request again to store it.',
    };
  }

  /** One line range, with a cursor that names the object it belongs to so it cannot be replayed onto another. */
  async read(input: unknown): Promise<ReadResult> {
    const request = readRequestSchema.parse(input);
    const state = this.store.snapshot({ history: false });
    const entry = this.permitted(request.agentId, request.objectHash, state)[0];
    let from = request.from ?? 1;
    if (request.cursor) {
      const [cursorHash, cursorLine] = request.cursor.split(':');
      if (cursorHash !== request.objectHash || !/^[1-9][0-9]{0,9}$/.test(cursorLine ?? ''))
        throw new Error('This cursor does not belong to this object.');
      from = Number(cursorLine);
    }
    const limit = request.limit ?? DEFAULT_READ_LIMIT;
    const parameters = { from, limit };
    const key = this.dependencyKey('READ', [entry], parameters, state, request.agentId);
    return this.cached<Omit<ReadResult, 'receiptId'>>(
      'read:' + key,
      'READ',
      request.agentId,
      entry.projectId,
      [entry],
      parameters,
      async () => {
        const lines = await this.lines(entry);
        if (!lines) {
          const missing: Omit<ReadResult, 'receiptId'> = {
            sha256: entry.sha256,
            name: entry.name,
            from,
            to: from - 1,
            lines: [],
            returned: 0,
            omitted: 0,
            total: null,
            nextCursor: null,
            coverage: 'UNKNOWN',
            detail: TEXT_TYPES.has(entry.mediaType)
              ? 'The bytes of this object could not be read, so this empty result does not mean the object is empty.'
              : 'This object is not text and is not decoded here.',
          };
          return { value: missing, returned: 0, omitted: 0, coverage: 'UNKNOWN' as Coverage };
        }
        const slice = lines.slice(from - 1, from - 1 + limit);
        const omitted = Math.max(lines.length - (from - 1) - slice.length, 0);
        const value: Omit<ReadResult, 'receiptId'> = {
          sha256: entry.sha256,
          name: entry.name,
          from,
          to: from - 1 + slice.length,
          lines: slice,
          returned: slice.length,
          omitted,
          total: lines.length,
          nextCursor: omitted > 0 ? `${entry.sha256}:${from + slice.length}` : null,
          coverage: from === 1 && omitted === 0 ? 'COMPLETE' : 'PARTIAL',
          detail:
            omitted > 0
              ? `${omitted} further line${omitted === 1 ? '' : 's'} were not returned.`
              : 'The requested range reached the end of the object.',
        };
        return { value, returned: slice.length, omitted, coverage: value.coverage };
      },
    ) as Promise<ReadResult>;
  }

  /**
   * A literal substring search across the objects this agent may read.
   *
   * Objects whose bytes are missing are counted and named rather than skipped, because a search that
   * silently omits the one unreadable log is how a critical finding disappears into a clean result.
   */
  async query(input: unknown): Promise<SearchResult> {
    const request = searchRequestSchema.parse(input);
    const state = this.store.snapshot({ history: false });
    let scope = this.accessible(request.agentId, request.projectId, state);
    if (request.objectHashes) {
      const wanted = new Set(request.objectHashes);
      for (const hash of wanted) this.permitted(request.agentId, hash, state);
      scope = scope.filter(entry => wanted.has(entry.sha256));
    }
    if (!scope.length) throw new Error('No stored object in this project is available to this agent.');
    const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
    const parameters = { pattern: request.pattern, limit, cursor: request.cursor ?? null };
    const key = this.dependencyKey('SEARCH', scope, parameters, state, request.agentId);
    return this.cached<Omit<SearchResult, 'receiptId'>>(
      'search:' + key,
      'SEARCH',
      request.agentId,
      request.projectId,
      scope,
      parameters,
      async () => {
        let startHash = '',
          startLine = 1;
        if (request.cursor) {
          const [cursorHash, cursorLine] = request.cursor.split(':');
          if (!scope.some(entry => entry.sha256 === cursorHash) || !/^[1-9][0-9]{0,9}$/.test(cursorLine ?? ''))
            throw new Error('This cursor does not belong to this search.');
          startHash = cursorHash;
          startLine = Number(cursorLine);
        }
        const matches: SearchMatch[] = [];
        const unreadable: string[] = [];
        let omitted = 0,
          nextCursor: string | null = null,
          reached = !startHash;
        for (const entry of scope) {
          if (!reached) {
            if (entry.sha256 !== startHash) continue;
            reached = true;
          }
          const lines = await this.lines(entry);
          if (!lines) {
            unreadable.push(entry.name);
            continue;
          }
          const begin = entry.sha256 === startHash ? startLine : 1;
          for (let number = begin; number <= lines.length; number++) {
            if (!lines[number - 1].includes(request.pattern)) continue;
            if (matches.length >= limit) {
              omitted++;
              nextCursor ??= `${entry.sha256}:${number}`;
              continue;
            }
            matches.push({
              sha256: entry.sha256,
              name: entry.name,
              line: number,
              text: lines[number - 1].slice(0, 2000),
            });
          }
        }
        const coverage: Coverage = unreadable.length || omitted ? 'PARTIAL' : 'COMPLETE';
        const value: Omit<SearchResult, 'receiptId'> = {
          matches,
          returned: matches.length,
          omitted,
          unreadableObjects: unreadable,
          searchedObjects: scope.length - unreadable.length,
          nextCursor,
          coverage,
          detail: unreadable.length
            ? `${unreadable.length} of ${scope.length} objects could not be read (${unreadable.slice(0, 5).join(', ')}), so this result does not establish that no match exists.`
            : omitted
              ? `${omitted} further match${omitted === 1 ? '' : 'es'} were not returned.`
              : `Searched all ${scope.length} available objects in full${matches.length ? '' : ' and found no match'}.`,
        };
        return { value, returned: matches.length, omitted, coverage };
      },
    ) as Promise<SearchResult>;
  }

  // ---- packets, raw output and briefs ----------------------------------------------------------

  /** The evidence surface for one stage assignment: names and identities, never bytes. */
  async stagePacket(input: unknown): Promise<StagePacket> {
    const request = packetRequestSchema.parse(input);
    const state = this.store.snapshot({ history: false });
    const assignment = this.researchScope(request.agentId, state);
    if (
      assignment &&
      (request.stage !== assignment.research!.stage || request.subjectId !== assignment.research!.subjectHash)
    )
      throw new Error('This object is not available to this agent.');
    const scope = this.accessible(request.agentId, request.projectId, state);
    if (!scope.length) throw new Error('No stored object in this project is available to this agent.');
    const max = request.maxObjects ?? 64;
    const included = scope.slice(0, max);
    const parameters = { subjectId: request.subjectId, stage: request.stage, max };
    const key = this.dependencyKey('PACKET', included, parameters, state, request.agentId);
    return this.cached<Omit<StagePacket, 'receiptId'>>(
      'packet:' + key,
      'PACKET',
      request.agentId,
      request.projectId,
      included,
      parameters,
      async () => {
        const objects = [];
        for (const entry of included) {
          const lines = await this.lines(entry);
          objects.push({
            sha256: entry.sha256,
            name: entry.name,
            bytes: entry.bytes,
            origin: entry.origin,
            evidence: entry.evidence,
            lines: lines ? lines.length : null,
          });
        }
        const excluded = scope.length - included.length;
        const notes = [
          `${scope.length} object${scope.length === 1 ? '' : 's'} are available to this function; bytes are fetched by read or query, not carried here.`,
        ];
        notes.push("Objects outside this function's grants are not disclosed.");
        if (excluded)
          notes.push(
            `${excluded} further available object${excluded === 1 ? ' is' : 's are'} not listed in this packet and must be requested explicitly.`,
          );
        const value: Omit<StagePacket, 'receiptId'> = {
          projectId: request.projectId,
          subjectId: request.subjectId,
          stage: request.stage,
          agentId: request.agentId,
          objects,
          excludedObjects: excluded,
          totalBytes: objects.reduce((sum, item) => sum + item.bytes, 0),
          notes,
        };
        return {
          value,
          returned: objects.length,
          omitted: excluded,
          coverage: (excluded ? 'PARTIAL' : 'COMPLETE') as Coverage,
        };
      },
    ) as Promise<StagePacket>;
  }

  /**
   * Stores an answer's raw text before anything is asked of its structure.
   *
   * A malformed brief is a formatting failure, not a reason to lose the reasoning that produced it.
   * The raw record is written first and kept whatever happens next.
   */
  async recordRawOutput(input: {
    projectId: string;
    agentId: string;
    subjectId: string;
    body: string;
    receiptIds?: string[];
  }): Promise<RawEvidenceOutput> {
    const record: RawEvidenceOutput = {
      id: randomUUID(),
      projectId: input.projectId,
      agentId: input.agentId,
      subjectId: input.subjectId,
      body: input.body,
      receiptIds: input.receiptIds ?? [],
      createdAt: this.now(),
      briefId: null,
      briefError: null,
      contextHash: this.researchScope(input.agentId)?.research?.contextHash ?? null,
    };
    this.persist({
      id: randomUUID(),
      projectId: record.projectId,
      agentId: record.agentId,
      kind: 'RAW',
      value: record,
    });
    this.raw.push(record);
    return record;
  }

  /**
   * Accepts a brief only if every quotation still matches the bytes it names.
   *
   * A reference whose quote hash no longer resolves is not a small formatting problem: it means the
   * claim is about material that is not there, which is precisely the sentence a brief must not be
   * able to make. Rejection is recorded against the raw output, which is retained either way.
   */
  async submitBrief(rawId: string, candidate: unknown): Promise<EvidenceBrief> {
    const record = this.raw.find(item => item.id === rawId);
    if (!record) throw new Error('No raw output with that identifier was stored.');
    try {
      const brief = evidenceBriefSchema.parse(typeof candidate === 'string' ? parseStrictJson(candidate) : candidate);
      if (brief.projectId !== record.projectId)
        throw new Error('A brief cannot be filed against a different project than its raw output.');
      const state = this.store.snapshot({ history: false });
      const incomplete = brief.receiptIds.filter(
        receiptId => (this.receipts.find(r => r.id === receiptId)?.coverage ?? 'UNKNOWN') !== 'COMPLETE',
      );
      if (incomplete.length && !brief.missingCoverage.length)
        throw new Error(
          `${incomplete.length} of this brief's queries did not cover their material completely, so missingCoverage cannot be empty.`,
        );
      for (const claim of brief.claims)
        for (const ref of claim.refs) {
          const entry = this.permitted(record.agentId, ref.objectHash, state)[0];
          if (ref.toLine < ref.fromLine) throw new Error('An evidence range ends before it begins.');
          const lines = await this.lines(entry);
          if (!lines) throw new Error(`A claim quotes ${entry.name}, whose bytes could not be read.`);
          if (ref.toLine > lines.length)
            throw new Error(
              `A claim quotes lines ${ref.fromLine}-${ref.toLine} of ${entry.name}, which has ${lines.length}.`,
            );
          if (sha256(lines.slice(ref.fromLine - 1, ref.toLine).join('\n')) !== ref.quoteHash)
            throw new Error(
              `A quotation of ${entry.name} lines ${ref.fromLine}-${ref.toLine} does not match the stored bytes.`,
            );
        }
      this.briefs.push(brief);
      record.briefId = brief.id;
      record.briefError = null;
      this.persist({
        id: randomUUID(),
        projectId: brief.projectId,
        agentId: record.agentId,
        kind: 'BRIEF',
        value: brief,
      });
      // A raw update is a new envelope over the same output id: earlier versions stay in the log.
      this.persist({
        id: randomUUID(),
        projectId: record.projectId,
        agentId: record.agentId,
        kind: 'RAW',
        value: record,
      });
      return brief;
    } catch (error) {
      record.briefError = error instanceof Error ? error.message : 'Invalid brief.';
      this.persist({
        id: randomUUID(),
        projectId: record.projectId,
        agentId: record.agentId,
        kind: 'RAW',
        value: record,
      });
      throw error;
    }
  }

  rawOutput(id: string): RawEvidenceOutput | undefined {
    return this.raw.find(item => item.id === id);
  }
  receiptsFor(agentId: string): QueryReceipt[] {
    return this.receipts.filter(item => item.agentId === agentId);
  }
  allReceipts(): QueryReceipt[] {
    return [...this.receipts];
  }
  brief(id: string): EvidenceBrief | undefined {
    return this.briefs.find(item => item.id === id);
  }

  /** Quote hashes are computed the same way on both sides, so a caller never has to guess the encoding. */
  static quoteHash(lines: string[]): string {
    return sha256(lines.join('\n'));
  }
}
