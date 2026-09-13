import type { PredictionRecord, ResearchBranch, ResearchRecords, TrialLedgerEntry } from '../shared/research.js';

/**
 * Reading the ledger back: what has already been tried, what was retired and why, and how well the
 * director's predictions have actually held up.
 *
 * All of this exists to make a negative result findable. A study whose failures are recorded but
 * unsearchable is a study that will be repeated, and the repetition will eventually produce a
 * positive by chance — which is the exact failure the ledger was built to prevent.
 */

export interface LedgerMatch {
  entry: TrialLedgerEntry; branch: ResearchBranch | undefined;
  /** Why this is worth reading before starting again. */
  relevance: string;
}

/**
 * Searches settled trials, including the ones that failed.
 *
 * Failures rank first. Not as a display preference: the reason to search this ledger before starting
 * is usually to find out that the idea has already been tried and did not work, and burying that
 * under the successes defeats the search.
 */
export function searchLedger(records: ResearchRecords, query: { text?: string; lineageId?: string; includePending?: boolean }): LedgerMatch[] {
  const text = (query.text ?? '').trim().toLowerCase();
  const branches = records.branches ?? [];
  return (records.trials ?? [])
    .filter(entry => (!query.lineageId || entry.lineageId === query.lineageId)
      && (query.includePending || entry.outcome !== 'PENDING')
      && (!text || entry.description.toLowerCase().includes(text)
        || (branches.find(branch => branch.id === entry.branchId)?.name ?? '').toLowerCase().includes(text)))
    .map(entry => {
      const branch = branches.find(item => item.id === entry.branchId);
      const relevance = entry.outcome === 'FAILED' ? 'This attempt failed. Read it before spending another trial on the same idea.'
        : entry.outcome === 'CANCELED' ? 'This attempt was abandoned before it settled; its reason may still apply.'
          : entry.outcome === 'PRUNED' ? 'This variant was pruned during the registered search.'
            : branch?.outcome === 'VALID_NEGATIVE' ? 'This lineage concluded a valid negative, which is a result and not an absence of one.'
              : branch?.outcome==='RETIRED'?'This lineage was retired: '+(branch.retiredReason??'Read the recorded retirement before re-entry.')
              : 'A completed attempt in this lineage.';
      return { entry, branch, relevance };
    })
    .sort((a, b) => rank(a.entry) - rank(b.entry) || b.entry.settledAt.localeCompare(a.entry.settledAt));
}
const rank = (entry: TrialLedgerEntry) => entry.outcome === 'FAILED' ? 0 : entry.outcome === 'CANCELED' ? 1 : entry.outcome === 'PRUNED' ? 2 : 3;

export interface AncestryNode { branch: ResearchBranch; depth: number; retiredReason: string | null }

/**
 * The full ancestry of one lineage, retirements included.
 *
 * A retired branch is not removed from the line. Re-entering an idea that was retired is a decision
 * somebody should make knowingly, and that requires the retirement to still be visible from the
 * descendant that is about to repeat it.
 */
export function lineageAncestry(records: ResearchRecords, branchId: string): AncestryNode[] {
  const branches = records.branches ?? [];
  const nodes: AncestryNode[] = [];
  let current = branches.find(item => item.id === branchId);
  let depth = 0;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    nodes.push({ branch: current, depth, retiredReason: current.retiredAt ? current.retiredReason ?? 'Retired without a recorded reason.' : null });
    current = current.parentBranchId ? branches.find(item => item.id === current!.parentBranchId) : undefined;
    depth++;
  }
  return nodes;
}

/** Whether a retired idea may be re-entered, and what the person doing it has to have seen. */
export function reEntryBlockers(records: ResearchRecords, branchId: string): string[] {
  return lineageAncestry(records, branchId)
    .filter(node => node.retiredReason !== null)
    .map(node => `${node.branch.name} was retired: ${node.retiredReason} Re-entering this line repeats an idea that was already stopped.`);
}

export interface CalibrationReport {
  predictions: number; scored: number;
  /** Share of scored predictions whose realised value fell inside the registered interval. */
  hitRate: number | null;
  /** A binomial standard error on that share, so a run of four is not read as a calibration. */
  standardError: number | null;
  retrospectiveExcluded: number; detail: string;
}

/**
 * How often the director's registered intervals actually contained the outcome.
 *
 * Retrospective predictions are counted and excluded rather than silently dropped: a calibration
 * computed over descriptions written after the fact is not a calibration, and the count is how a
 * reader knows how much of the record was like that.
 */
export function calibration(predictions: PredictionRecord[], realised: Record<string, number | null>): CalibrationReport {
  const retrospective = predictions.filter(item => item.retrospective);
  const eligible = predictions.filter(item => !item.retrospective);
  const scored = eligible.filter(item => typeof realised[item.id] === 'number');
  if (!scored.length)
    return { predictions: predictions.length, scored: 0, hitRate: null, standardError: null, retrospectiveExcluded: retrospective.length,
      detail: `No registered prediction has a realised value yet. ${retrospective.length} retrospective record${retrospective.length === 1 ? ' was' : 's were'} excluded, as they describe outcomes rather than forecast them.` };
  const hits = scored.filter(item => {
    const value = realised[item.id] as number;
    return value >= item.expectedLow && value <= item.expectedHigh;
  }).length;
  const hitRate = hits / scored.length;
  const standardError = Math.sqrt(hitRate * (1 - hitRate) / scored.length);
  return { predictions: predictions.length, scored: scored.length, hitRate, standardError, retrospectiveExcluded: retrospective.length,
    detail: `${hits} of ${scored.length} registered intervals contained the outcome (${(hitRate * 100).toFixed(1)}% ± ${(standardError * 100).toFixed(1)} points, one standard error). ${retrospective.length} retrospective record${retrospective.length === 1 ? ' was' : 's were'} excluded.` };
}

/**
 * Compares two methods or versions on the trials each actually ran.
 *
 * Reported as counts with the sample size attached rather than as a winner. Two methods separated by
 * three trials are not separated.
 */
export function compareMethods(records: ResearchRecords, groups: { name: string; lineageIds: string[] }[]): { name: string; trials: number; completed: number; failed: number; distinctVariants: number; detail: string }[] {
  return groups.map(group => {
    const entries = (records.trials ?? []).filter(entry => group.lineageIds.includes(entry.lineageId));
    const completed = entries.filter(entry => entry.outcome === 'COMPLETED').length;
    const failed = entries.filter(entry => entry.outcome === 'FAILED').length;
    const distinctVariants = new Set(entries.filter(entry => entry.kind === 'VARIANT').map(entry => entry.variantHash)).size;
    return { name: group.name, trials: entries.length, completed, failed, distinctVariants,
      detail: entries.length < 10
        ? `${entries.length} trial${entries.length === 1 ? '' : 's'} is too few to compare methods on. This is a count, not a comparison.`
        : `${completed} completed and ${failed} failed across ${entries.length} trials and ${distinctVariants} distinct variants.` };
  });
}
