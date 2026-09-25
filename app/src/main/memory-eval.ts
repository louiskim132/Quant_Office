import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OfficeStore } from '../core/store.js';
import type { FindingKind } from '../shared/types.js';

/**
 * The memory-engine evaluation harness — a measurement, not an engine.
 *
 * The roadmap holds external memory engines (Graphiti, Hindsight, Basic Memory, LightRAG, Mem0) as
 * OPTIONAL projections that must prove themselves against a labeled corpus before any claim is
 * made. This module supplies the corpus, the gold queries, the scoring and the Office-native
 * baseline. An adapter that cannot load reports UNAVAILABLE; nothing here installs, fetches or
 * assumes an engine exists.
 */

/** The sync adapter contract. Adapters wrapping async engines can buffer and flush later. */
export interface MemoryEngineAdapter {
  name: string;
  /**
   * One finding plus the corpus links whose `from` is this finding — each link is delivered once,
   * with its source node. Targets may arrive earlier or later in corpus order.
   */
  ingest(finding: { id: string; kind: string; title: string; body: string },
    links: { from: string; to: string; kind: string }[]): void;
  search(query: string, limit: number): { id: string }[];
}

export interface EvalFinding { id: string; kind: string; title: string; body: string }
export interface EvalLink { from: string; to: string; kind: string }
export interface EvalCorpus { findings: EvalFinding[]; links: EvalLink[] }
export interface EvalQuery { query: string; expectedIds: string[] }

export interface QueryEval {
  query: string;
  expectedIds: string[];
  /** Ids the adapter returned, in rank order. */
  hits: string[];
  /** Rank position of each expected id (1-based), null when absent from the hits. */
  hitRanks: { id: string; rank: number | null }[];
  reciprocalRank: number;
  /** Fraction of expected ids found inside the top five hits. */
  recallAt5: number | null;
}
export interface AdapterEvalReport {
  engine: string;
  queries: QueryEval[];
  meanReciprocalRank: number;
  recallAt5: number;
}

const EVAL_LIMIT = 10;

/**
 * The Office-native baseline: retrieval through the store's own bounded search. Corpus ids are
 * mapped through the ids the store mints so reports always speak in corpus identities.
 */
export function officeBaselineAdapter(store: OfficeStore, projectId: string): MemoryEngineAdapter {
  const corpusIds = new Map<string, string>();
  return {
    name: 'office-baseline',
    ingest(finding) {
      const { finding: created } = store.recordMemoryFinding({
        projectId, requestId: null, assignmentId: null, kind: finding.kind as FindingKind,
        title: finding.title, body: finding.body, evidenceRefs: [], createdBy: { surface: 'OFFICE' },
      });
      corpusIds.set(created.id, finding.id);
    },
    search(query, limit) {
      return store.searchMemoryFindings(projectId, query, limit)
        .map(item => ({ id: corpusIds.get(item.id) ?? item.id }));
    },
  };
}

/**
 * The deterministic corpus: twelve findings spanning all six kinds, ten links. Titles carry the
 * distinctive vocabulary the gold queries target so the term-based baseline ranks reproducibly.
 */
export function fixtureCorpus(): EvalCorpus {
  return {
    findings: [
      { id: 'mem-obs-1', kind: 'OBSERVATION', title: 'Leakage scan found no look-ahead in momentum run', body: 'All twelve folds passed the leakage audit; no future data reached the feature builder.' },
      { id: 'mem-obs-2', kind: 'OBSERVATION', title: 'Slippage estimate widened during volatile sessions', body: 'The execution cost proxy rose on high-volatility days inside the replay window.' },
      { id: 'mem-hyp-1', kind: 'HYPOTHESIS', title: 'Momentum decays faster in small-cap universes', body: 'The decay half-life is hypothesized shorter below the median market-cap cutoff.' },
      { id: 'mem-hyp-2', kind: 'HYPOTHESIS', title: 'Volatility clustering improves drawdown timing', body: 'Clustered volatility may sharpen entry timing for the drawdown-controlled sleeve.' },
      { id: 'mem-res-1', kind: 'RESULT', title: 'Baseline backtest beat the equal-weight control', body: 'The primary backtest outperformed the equal-weight benchmark after costs.' },
      { id: 'mem-res-2', kind: 'RESULT', title: 'Ablation showed the signal survives fee haircut', body: 'Removing the fee haircut assumption still left positive net returns.' },
      { id: 'mem-def-1', kind: 'DEFECT', title: 'Survivorship bias found in the equity universe', body: 'Delisted tickers were missing from the historical universe snapshot.' },
      { id: 'mem-def-2', kind: 'DEFECT', title: 'Timezone shift misaligned futures settlement', body: 'Settlement timestamps landed a day late for the Asian session contracts.' },
      { id: 'mem-dec-1', kind: 'DECISION', title: 'Holdout fold reserved for final validation', body: 'The 2023 fold is sealed until the director signs the preflight gate.' },
      { id: 'mem-dec-2', kind: 'DECISION', title: 'Equal-weight control kept as the benchmark', body: 'The team kept equal-weighting to stay comparable with the prior study.' },
      { id: 'mem-not-1', kind: 'NOTE', title: 'Replay window extended to cover the rate shock', body: 'Coverage now includes the rate-shock weeks for stress review.' },
      { id: 'mem-not-2', kind: 'NOTE', title: 'Data vendor switched dividend adjustment method', body: 'The vendor changelog notes a new total-return adjustment from March onward.' },
    ],
    links: [
      { from: 'mem-res-1', to: 'mem-hyp-1', kind: 'SUPPORTS' },
      { from: 'mem-res-2', to: 'mem-hyp-1', kind: 'SUPPORTS' },
      { from: 'mem-def-1', to: 'mem-res-1', kind: 'CONTRADICTS' },
      { from: 'mem-def-2', to: 'mem-obs-2', kind: 'RELATES' },
      { from: 'mem-obs-1', to: 'mem-res-1', kind: 'SUPPORTS' },
      { from: 'mem-dec-1', to: 'mem-res-1', kind: 'RELATES' },
      { from: 'mem-dec-2', to: 'mem-res-1', kind: 'RELATES' },
      { from: 'mem-not-1', to: 'mem-obs-2', kind: 'REFINES' },
      { from: 'mem-not-2', to: 'mem-def-1', kind: 'RELATES' },
      { from: 'mem-hyp-2', to: 'mem-obs-2', kind: 'RELATES' },
    ],
  };
}

/**
 * The gold query set: ten queries whose expected findings are declared. 'equal-weight benchmark
 * control' deliberately carries two gold ids so multi-target recall is exercised.
 */
export function fixtureQueries(): EvalQuery[] {
  return [
    { query: 'look-ahead leakage audit', expectedIds: ['mem-obs-1'] },
    { query: 'slippage volatile sessions', expectedIds: ['mem-obs-2'] },
    { query: 'small-cap momentum decay', expectedIds: ['mem-hyp-1'] },
    { query: 'drawdown timing volatility clustering', expectedIds: ['mem-hyp-2'] },
    { query: 'equal-weight benchmark control', expectedIds: ['mem-res-1', 'mem-dec-2'] },
    { query: 'fee haircut ablation', expectedIds: ['mem-res-2'] },
    { query: 'survivorship bias delisted', expectedIds: ['mem-def-1'] },
    { query: 'timezone settlement futures', expectedIds: ['mem-def-2'] },
    { query: 'holdout fold sealed validation', expectedIds: ['mem-dec-1'] },
    { query: 'rate shock replay', expectedIds: ['mem-not-1'] },
  ];
}

/**
 * Ingests the corpus, runs each gold query and scores retrieval: reciprocal rank of the first
 * expected hit, and recall within the top five. A query declaring no expected ids is excluded from
 * the averages — it measures noise, not recall.
 */
export function evaluateAdapter(adapter: MemoryEngineAdapter, corpus: EvalCorpus, queries: EvalQuery[]): AdapterEvalReport {
  for (const finding of corpus.findings)
    adapter.ingest(finding, corpus.links.filter(link => link.from === finding.id));
  const perQuery: QueryEval[] = queries.map(({ query, expectedIds }) => {
    const hits = adapter.search(query, EVAL_LIMIT).map(hit => hit.id);
    const hitRanks = expectedIds.map(id => {
      const index = hits.indexOf(id);
      return { id, rank: index >= 0 ? index + 1 : null };
    });
    const bestRank = hitRanks.reduce<number | null>(
      (best, item) => item.rank !== null && (best === null || item.rank < best) ? item.rank : best, null);
    const recallAt5 = expectedIds.length
      ? expectedIds.filter(id => hits.slice(0, 5).includes(id)).length / expectedIds.length
      : null;
    return { query, expectedIds, hits, hitRanks, reciprocalRank: bestRank ? 1 / bestRank : 0, recallAt5 };
  });
  const scored = perQuery.filter(item => item.expectedIds.length > 0);
  const meanReciprocalRank = scored.length
    ? scored.reduce((sum, item) => sum + item.reciprocalRank, 0) / scored.length : 0;
  const recallAt5 = scored.length
    ? scored.reduce((sum, item) => sum + (item.recallAt5 ?? 0), 0) / scored.length : 0;
  return { engine: adapter.name, queries: perQuery, meanReciprocalRank, recallAt5 };
}

/**
 * Loads a caller-supplied adapter module. The module must export `create()`; anything that throws,
 * fails to load, or returns a malformed adapter reports its reason rather than failing the run.
 */
export async function loadExternalAdapter(specifier: string): Promise<{ adapter: MemoryEngineAdapter } | { unavailable: string }> {
  let loaded: Record<string, unknown>;
  try { loaded = await import(pathToFileURL(resolve(specifier)).href); }
  catch (error) { return { unavailable: `The adapter module could not be loaded: ${error instanceof Error ? error.message : String(error)}` }; }
  if (typeof loaded.create !== 'function')
    return { unavailable: 'The adapter module does not export create().' };
  try {
    const adapter = await (loaded.create as () => unknown)();
    if (!adapter || typeof adapter !== 'object'
      || typeof (adapter as MemoryEngineAdapter).name !== 'string'
      || typeof (adapter as MemoryEngineAdapter).ingest !== 'function'
      || typeof (adapter as MemoryEngineAdapter).search !== 'function')
      return { unavailable: 'create() did not return a memory engine adapter (name, ingest and search are required).' };
    return { adapter: adapter as MemoryEngineAdapter };
  } catch (error) {
    return { unavailable: `create() failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
