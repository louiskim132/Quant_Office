#!/usr/bin/env node
/**
 * Memory-engine evaluation harness.
 *
 *   node app/scripts/memory-eval.mjs [--adapter <path-to-module>]...
 *
 * Runs the Office-native baseline over the deterministic fixture corpus and prints a JSON report.
 * `--adapter` loads a caller-supplied adapter module (dynamic import; the module must export
 * `create()`). An adapter that fails to load or evaluate reports {status:'UNAVAILABLE', reason} —
 * it never fails the run. No engine is installed or fetched here; the harness proves the harness.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

// The harness lives in TypeScript under src/main; tsx's programmatic loader imports it under plain node.
const { tsImport } = await import('tsx/esm/api');
const { OfficeStore } = await tsImport('../src/core/store.ts', import.meta.url);
const { fixtureCorpus, fixtureQueries, officeBaselineAdapter, evaluateAdapter, loadExternalAdapter } =
  await tsImport('../src/main/memory-eval.ts', import.meta.url);

const adapterPaths = [];
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--adapter' && argv[index + 1]) adapterPaths.push(argv[++index]);
  else {
    process.stderr.write(`usage: node scripts/memory-eval.mjs [--adapter <module-path>]...\n`);
    process.exitCode = 2;
    break;
  }
}

if (!process.exitCode) {
  const corpus = fixtureCorpus();
  const queries = fixtureQueries();
  const engines = [];

  const evaluate = async (adapter) => {
    try {
      const report = evaluateAdapter(adapter, corpus, queries);
      return { engine: report.engine, status: 'EVALUATED', queries: report.queries.length,
        meanReciprocalRank: report.meanReciprocalRank, recallAt5: report.recallAt5, perQuery: report.queries };
    } catch (error) {
      return { engine: adapter?.name ?? 'unknown', status: 'UNAVAILABLE', queries: 0,
        meanReciprocalRank: 0, recallAt5: 0, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  // The baseline runs against a throwaway in-memory store — it touches no real workspace.
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({ type: 'project.create', idempotencyKey: randomUUID(),
      name: 'memory-eval', mandate: 'Evaluation fixture', budgetCents: 0 }).projects[0];
    engines.push(await evaluate(officeBaselineAdapter(store, project.id)));

    for (const specifier of adapterPaths) {
      const loaded = await loadExternalAdapter(specifier);
      if ('unavailable' in loaded) {
        engines.push({ engine: path.basename(specifier), status: 'UNAVAILABLE', queries: 0,
          meanReciprocalRank: 0, recallAt5: 0, reason: loaded.unavailable });
      } else {
        engines.push(await evaluate(loaded.adapter));
      }
    }
  } finally {
    try { store.close(); } catch { /* best effort */ }
  }

  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), engines }, null, 2) + '\n');
}
