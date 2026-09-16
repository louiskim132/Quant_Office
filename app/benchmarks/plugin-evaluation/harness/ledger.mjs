/**
 * The append-only attempt ledger for the C10-A plugin-evaluation harness (roadmap section 3.2
 * 'Record per attempt'). One JSONL file in the evaluator's own directory records every attempt's
 * manifest, usage and score records. Entries are immutable once appended: no update or delete
 * function exists, so append-only is structural rather than conventional.
 *
 * Dependency-free like every harness module — the evaluator runs in a disposable
 * no-secret/no-network environment. The ledger is evaluator-side state: it may never resolve
 * inside an attempt directory or inside the fixture task/ tree that ships to participants.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, validateScore, validateUsage } from './records.mjs';

/** The participant-visible fixture tree; a ledger inside it would leak evaluator state. */
const TASK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'task');
const VALIDATORS = { manifest: validateManifest, usage: validateUsage, score: validateScore };
const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Resolves the ledger path and refuses evaluator-side violations: a ledger inside the supplied
 * attempt directory, or inside the fixture task/ tree, is contamination rather than storage.
 */
function assertLedgerPath(ledgerPath, attemptDir) {
  const target = path.resolve(String(ledgerPath));
  const fold = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  const sameOrInside = dir => {
    const d = fold(path.resolve(String(dir))), t = fold(target);
    return t === d || t.startsWith(d + path.sep);
  };
  if (sameOrInside(TASK_DIR))
    throw new Error('The attempt ledger is evaluator-side state; it cannot live inside the fixture task/ tree.');
  if (attemptDir !== undefined && attemptDir !== null && sameOrInside(attemptDir))
    throw new Error('The attempt ledger is evaluator-side state; it cannot live inside an attempt directory.');
  return target;
}

/**
 * Validates one ledger entry's envelope and record. The record must satisfy the records.mjs
 * validator for its type with an empty problem list, and the envelope's attemptId must equal the
 * record's own — a ledger grouped by attempt cannot tolerate the two naming different attempts.
 */
function entryProblems(entry) {
  if (!isObj(entry)) return ['entry is not an object'];
  const validate = VALIDATORS[entry.type];
  if (!validate) return [`type must be one of ${Object.keys(VALIDATORS).join(', ')}`];
  const problems = [];
  if (typeof entry.attemptId !== 'string' || !entry.attemptId.length) problems.push('attemptId must be a non-empty string');
  if (typeof entry.appendedAt !== 'string' || !Number.isFinite(Date.parse(entry.appendedAt)))
    problems.push('appendedAt must be an ISO timestamp');
  const recordProblems = validate(entry.record);
  if (recordProblems.length) problems.push(...recordProblems.map(p => `record: ${p}`));
  else if (entry.record.attemptId !== entry.attemptId) problems.push('attemptId must equal record.attemptId');
  return problems;
}

/** The minimal shape a parsed line must have to count as a ledger entry rather than corruption. */
function isEntryShape(value) {
  return isObj(value) && typeof value.type === 'string' && Boolean(VALIDATORS[value.type])
    && typeof value.attemptId === 'string' && isObj(value.record) && typeof value.appendedAt === 'string';
}

/**
 * Appends one entry as a single JSON line. The record is validated by the records.mjs validator
 * for the entry's type; an empty problem list is required — a malformed record never lands.
 * options.attemptDir, when supplied, is refused as a ledger location along with the task/ tree.
 */
export function append(ledgerPath, entry, options = {}) {
  const target = assertLedgerPath(ledgerPath, options.attemptDir);
  const problems = entryProblems(entry);
  if (problems.length) throw new Error(`Refusing to append a malformed ledger entry: ${problems.join('; ')}`);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Parses every complete line of the ledger. A trailing partial or otherwise corrupt line is
 * reported by line number in `corrupt` — surfaced, never silently dropped — while the intact
 * entries still come back. A ledger that does not exist yet reads as empty.
 */
export function read(ledgerPath, options = {}) {
  const target = assertLedgerPath(ledgerPath, options.attemptDir);
  if (!existsSync(target)) return { entries: [], corrupt: [] };
  const entries = [];
  const corrupt = [];
  readFileSync(target, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let parsed;
    try { parsed = JSON.parse(line); } catch { corrupt.push(index + 1); return; }
    if (!isEntryShape(parsed)) corrupt.push(index + 1);
    else entries.push(parsed);
  });
  return { entries, corrupt };
}

/**
 * Groups a ledger read by attempt: every manifest, usage and score entry recorded under the
 * supplied attemptId, in append order. An unknown attempt groups to three empty lists.
 */
export function entriesByAttempt(entries, attemptId) {
  const grouped = { attemptId, manifest: [], usage: [], score: [] };
  for (const entry of entries ?? []) {
    if (isEntryShape(entry) && entry.attemptId === attemptId) grouped[entry.type].push(entry);
  }
  return grouped;
}
