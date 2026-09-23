/**
 * Freshness-phase amendment for the C10-A plugin-evaluation harness (roadmap section 3.2).
 *
 * After the initial scored phase the evaluator amends ONLY the attempt copy's
 * docs/catalog.md Beacon source entry with FRESHNESS_CORRECTION — the verbatim text the
 * evaluator key prescribes — and this module proves afterward that nothing else in the
 * attempt dir moved. A drifted attempt dir fails loudly rather than silently proceeding.
 *
 * Dependency-free like records.mjs: it must run in the disposable, no-secret/no-network
 * evaluator environment.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The exact correction text EVALUATOR.md prescribes for the freshness follow-up. */
export const FRESHNESS_CORRECTION =
  'Correction 2026-01-04: beacon_snapshot is published 30 minutes after observation. ' +
  'The earlier equal-timestamp statement was incorrect. Birch B-01 used that earlier ' +
  'metadata and must be rechecked; no profitability outcome is known.';

const CATALOG = 'docs/catalog.md';
const SHA = /^[a-f0-9]{64}$/;

/** Sorted {path,sha256,bytes} inventory of every regular file under dir, with posix-relative paths. */
export function scanAttempt(dir) {
  const files = [];
  const walk = (base, rel) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const child = path.join(base, entry.name), r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child, r);
      else if (entry.isFile()) {
        const bytes = readFileSync(child);
        files.push({ path: r, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  };
  walk(dir, '');
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Directory diff against the frozen inventory: {changed, unchanged, added, removed} path lists. */
function diffInventory(dir, before) {
  const was = new Map(before.map(f => [f.path, f])), seen = new Set();
  const changed = [], unchanged = [], added = [], removed = [];
  for (const f of scanAttempt(dir)) {
    seen.add(f.path);
    const b = was.get(f.path);
    if (!b) added.push(f.path);
    else (b.sha256 === f.sha256 ? unchanged : changed).push(f.path);
  }
  for (const f of before) if (!seen.has(f.path)) removed.push(f.path);
  const byPath = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return { changed: changed.sort(byPath), unchanged: unchanged.sort(byPath), added: added.sort(byPath), removed: removed.sort(byPath) };
}

/**
 * Appends FRESHNESS_CORRECTION to the "## Beacon source" section of the attempt copy's
 * docs/catalog.md. The superseded equal-timestamp claim is not deleted — the correction
 * text itself states the earlier statement was incorrect.
 *
 * `before` is the {path,sha256,bytes} inventory captured when the attempt copy was created.
 * After writing, the dir is re-scanned and {changed, unchanged, added, removed} is returned;
 * the call throws unless the diff is exactly {changed:['docs/catalog.md']}, so a drifted
 * attempt dir cannot proceed silently.
 *
 * The amendment is applied exactly once per attempt: if the correction text is already
 * present the call is a no-op refusal (throws) rather than appending a duplicate or
 * silently passing.
 */
export function applyFreshnessAmendment(attemptDir, { before } = {}) {
  if (!Array.isArray(before) || !before.length || before.some(f => !f || typeof f.path !== 'string' || !SHA.test(String(f.sha256)) || !Number.isSafeInteger(f.bytes) || f.bytes < 0))
    throw new Error('applyFreshnessAmendment needs the {path,sha256,bytes} inventory captured at attempt creation.');
  const catalogFile = path.join(attemptDir, 'docs', 'catalog.md');
  const text = readFileSync(catalogFile, 'utf8');
  if (text.includes(FRESHNESS_CORRECTION))
    throw new Error('docs/catalog.md already carries the freshness correction; the amendment is applied exactly once per attempt.');
  const heading = /^##[ \t]+Beacon source[ \t]*$/m.exec(text);
  if (!heading) throw new Error('docs/catalog.md has no "## Beacon source" section to amend.');
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^##[ \t]/m.exec(rest);
  const boundary = next ? heading.index + heading[0].length + next.index : text.length;
  const amended = `${text.slice(0, boundary).trimEnd()}\n\n${FRESHNESS_CORRECTION}\n${boundary < text.length ? `\n${text.slice(boundary)}` : ''}`;
  writeFileSync(catalogFile, amended);
  const diff = diffInventory(attemptDir, before);
  if (diff.added.length || diff.removed.length || diff.changed.length !== 1 || diff.changed[0] !== CATALOG)
    throw new Error(`Freshness amendment must change exactly ${CATALOG}; observed changed=${JSON.stringify(diff.changed)} added=${JSON.stringify(diff.added)} removed=${JSON.stringify(diff.removed)}.`);
  return diff;
}

/**
 * Structural signals read from a participant's follow-up REPORT file — hints for the blinded
 * reviewer, never automated verdicts, and they never decide a score on their own:
 *   newSourceCited — the report cites the amended catalog.md in the context of the correction;
 *   birchRecheck — it names Birch B-01 for recheck;
 *   unknownPreserved — it still states that profitability is unknown.
 * These booleans feed the same names on the score record's freshness field; the human
 * reviewer stays responsible for semantic judgment.
 */
export function freshnessChecks(reportPath) {
  const report = readFileSync(reportPath, 'utf8');
  return {
    newSourceCited: /catalog\.md/i.test(report) && /(correction|beacon_snapshot|30\s*minutes|2026-01-04)/i.test(report),
    birchRecheck: /birch/i.test(report) && /b-?01/i.test(report) && /re-?check/i.test(report),
    unknownPreserved: /profitab\w*/i.test(report) && /(unknown|not known|no\b[^.]*outcome|unsupported|not supported)/i.test(report),
  };
}
