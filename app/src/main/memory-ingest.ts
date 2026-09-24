import type { OfficeStore } from '../core/store.js';
import type { LocalResultV2 } from '../shared/local-session.js';
import type { MemoryAuthor } from '../shared/types.js';

/**
 * Receipt-memory ingest: folds a verified v2 receipt's self-reported findings and link
 * proposals into the append-only office memory ledger.
 *
 * Every entry is validated by the store's own mechanical rules — evidence refs must name
 * records this project already holds, relationship endpoints must be real findings, a
 * supersession chain only moves forward. A malformed entry is skipped and counted in the
 * report, never thrown and never allowed to invalidate the verified outputs the same receipt
 * carries: the receipt's byte identity was already proven before its prose was read.
 *
 * `ref` is a session-local handle that exists only inside this one receipt — it resolves
 * against entries recorded from this same receipt (whether freshly created or deduped to an
 * existing finding on replay) and against existing finding ids in the project. It never
 * becomes a durable id and never resolves across receipts.
 */

export interface MemoryIngestReport {
  findings: { ref: string | null; findingId: string; created: boolean }[];
  findingsSkipped: { index: number; reason: string }[];
  links: { index: number; relationshipId: string; created: boolean }[];
  linksSkipped: { index: number; reason: string }[];
}

const reason = (error: unknown) => error instanceof Error ? error.message : 'unknown ingest failure';

export function ingestReceiptMemory(
  store: OfficeStore,
  ctx: { projectId: string; requestId: string | null; assignmentId: string | null; agentId: string; receiptHash: string },
  result: LocalResultV2,
): MemoryIngestReport {
  const report: MemoryIngestReport = { findings: [], findingsSkipped: [], links: [], linksSkipped: [] };
  // Session self-report is labeled for what it is: the agent that ran, riding the verified
  // receipt identity — office-observed provenance, never a truth verdict.
  const author: MemoryAuthor = { surface: 'AGENT_SESSION', agentId: ctx.agentId, receiptHash: ctx.receiptHash };
  /** ref → findingId for entries recorded from this receipt (created or deduped — both map). */
  const refMap = new Map<string, string>();
  /** A finding id that already exists in this project, checked against live state. */
  const existingFindingId = (value: string) =>
    (store.snapshot({ history: false }).findings ?? []).some(item => item.id === value && item.projectId === ctx.projectId) ? value : undefined;
  const resolveEndpoint = (value: string) => refMap.get(value) ?? existingFindingId(value);

  for (const [index, entry] of (result.findings ?? []).entries()) {
    try {
      let supersedesFindingId: string | undefined;
      if (entry.supersedes !== undefined) {
        supersedesFindingId = resolveEndpoint(entry.supersedes);
        if (!supersedesFindingId)
          throw new Error('The supersedes target names neither a ref in this receipt nor an existing finding in this project.');
      }
      const { finding, created } = store.recordMemoryFinding({
        projectId: ctx.projectId,
        requestId: ctx.requestId,
        assignmentId: ctx.assignmentId,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        evidenceRefs: (entry.evidenceRefs ?? []).map(ref => ({ kind: ref.kind, id: ref.id })),
        createdBy: author,
        ...(supersedesFindingId ? { supersedesFindingId } : {}),
      });
      report.findings.push({ ref: entry.ref ?? null, findingId: finding.id, created });
      if (entry.ref) refMap.set(entry.ref, finding.id);
    } catch (error) {
      report.findingsSkipped.push({ index, reason: reason(error) });
    }
  }

  for (const [index, link] of (result.links ?? []).entries()) {
    try {
      const from = resolveEndpoint(link.from);
      if (!from) throw new Error('The link source names neither a ref in this receipt nor an existing finding in this project.');
      const to = resolveEndpoint(link.to);
      if (!to) throw new Error('The link target names neither a ref in this receipt nor an existing finding in this project.');
      const { relationship, created } = store.proposeMemoryRelationship({
        projectId: ctx.projectId,
        fromFindingId: from,
        toFindingId: to,
        kind: link.kind,
        ...(link.note ? { note: link.note } : {}),
        createdBy: author,
      });
      report.links.push({ index, relationshipId: relationship.id, created });
    } catch (error) {
      report.linksSkipped.push({ index, reason: reason(error) });
    }
  }
  return report;
}
