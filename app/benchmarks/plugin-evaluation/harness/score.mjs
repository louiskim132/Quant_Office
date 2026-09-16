/**
 * Blind scoring support for the C10-A plugin-evaluation harness (roadmap section 3.2).
 *
 * Report quality is reviewed blind to tool identity: blindPacket copies each attempt's
 * REPORT into a review dir under a seeded blind name and keeps the blind->attempt
 * mapping on the evaluator side only. This strips identity bytes from the packet; it
 * does not prove the reviewer stayed blind — that remains a process property the
 * evaluator attests to via `blind: true` in the score record (docs/workflow.md:
 * scoped delivery is not enforced isolation or blinding).
 *
 * Dependency-free: imports node:* and harness/records.mjs only.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_FINDINGS, validateScore } from './records.mjs';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;
const MAPPING_FILE = 'blind-map.json';

/** Deterministic PRNG pinned by the packet contract so tests reproduce a packet from its seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy of list, consuming the seeded stream. */
function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const hex8 = rng => Math.floor(rng() * 0x100000000).toString(16).padStart(8, '0');
const sha256hex = bytes => createHash('sha256').update(bytes).digest('hex');
const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** True when child resolves to parent itself or somewhere beneath it. */
function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Keys that only ever appear in a run/attempt metadata preamble — never in report prose.
 * Normalized form: lowercase, spaces/dashes/underscores/dots removed.
 */
const META_KEYS = new Set([
  'arm', 'attempt', 'attemptid', 'config', 'configuration', 'provider', 'model', 'effort',
  'client', 'clientversion', 'tool', 'tools', 'toolprofile', 'phase', 'track', 'session',
  'sessionid', 'run', 'runid', 'seed', 'agent', 'workspace', 'profile', 'benchmark',
  'plugin', 'date', 'time', 'timestamp', 'host', 'user', 'name', 'eval', 'evaluation', 'score',
]);
const KEY_VALUE = /^([A-Za-z][A-Za-z0-9_. -]{0,40})[ \t]*[:=][ \t]*\S/;
const metaLine = line => {
  const m = KEY_VALUE.exec(line);
  return Boolean(m) && META_KEYS.has(m[1].toLowerCase().replace(/[ ._-]+/g, ''));
};

/**
 * Remove a leading metadata block from a report copy. Participants are told not to write
 * one; this strips it defensively so the blind packet carries no arm/config bytes.
 * Recognized shapes at byte zero: YAML-style front matter (`---` ... `---`), an HTML
 * comment (`<!--` ... `-->`; an unterminated comment consumes the file), and a run of
 * `Key: value` / `Key = value` lines whose keys are all attempt-metadata vocabulary.
 * Blank lines left behind by a removed block are dropped. Body text is untouched.
 */
export function stripPreamble(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  } else if (lines[0] !== undefined && lines[0].trimStart().startsWith('<!--')) {
    let end = 0;
    while (end < lines.length && !lines[end].includes('-->')) end++;
    i = end < lines.length ? end + 1 : lines.length;
  }
  while (i < lines.length && metaLine(lines[i])) i++;
  while (i < lines.length && !lines[i].trim()) i++;
  return lines.slice(i).join('\n');
}

/**
 * Copy each attempt's report into reviewDir under a blind name. Entries are a seeded
 * shuffle of attemptReports (mulberry32(seed), Fisher-Yates); blind names are drawn
 * from the same stream afterwards, so the same seed reproduces the same packet.
 * The blind->attempt mapping is written to evaluatorDir/blind-map.json with 'wx' —
 * it is never overwritten and never lands inside an attempt dir or reviewDir.
 */
export function blindPacket({ attemptReports, reviewDir, evaluatorDir, seed, now }) {
  if (!Array.isArray(attemptReports) || !attemptReports.length) {
    throw new Error('attemptReports must be a non-empty array of {attemptId, reportPath}');
  }
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be an integer');
  const review = path.resolve(reviewDir);
  const evaluator = path.resolve(evaluatorDir);
  if (within(review, evaluator)) {
    throw new Error('evaluatorDir must not resolve inside reviewDir — the mapping would reach the reviewer');
  }
  const items = attemptReports.map(r => {
    if (!isObj(r) || typeof r.attemptId !== 'string' || !SAFE_NAME.test(r.attemptId)) {
      throw new Error(`attemptReports entry needs a safe attemptId, got ${JSON.stringify(r?.attemptId)}`);
    }
    if (typeof r.reportPath !== 'string' || !r.reportPath) {
      throw new Error(`attempt ${r.attemptId} needs a reportPath`);
    }
    const reportPath = path.resolve(r.reportPath);
    if (!existsSync(reportPath) || !statSync(reportPath).isFile()) {
      throw new Error(`report for attempt ${r.attemptId} is not a file: ${r.reportPath}`);
    }
    const attemptDir = path.dirname(reportPath);
    if (within(attemptDir, evaluator)) {
      throw new Error(`evaluatorDir must not resolve inside attempt dir ${attemptDir}`);
    }
    if (within(attemptDir, review)) {
      throw new Error(`reviewDir must not resolve inside attempt dir ${attemptDir}`);
    }
    if (within(review, attemptDir)) {
      throw new Error(`attempt dir ${attemptDir} must not resolve inside reviewDir`);
    }
    return { attemptId: r.attemptId, reportPath };
  });
  if (new Set(items.map(i => i.attemptId)).size !== items.length) {
    throw new Error('attemptIds must be unique — the blind mapping is a bijection');
  }
  mkdirSync(review, { recursive: true });
  if (readdirSync(review).length) {
    throw new Error('reviewDir must be empty — a blind packet never mixes with other files');
  }
  mkdirSync(evaluator, { recursive: true });

  const rng = mulberry32(seed);
  const used = new Set();
  const entries = shuffled(items, rng).map(item => {
    let blindName;
    do { blindName = `report-${hex8(rng)}.md`; } while (used.has(blindName));
    used.add(blindName);
    const source = readFileSync(item.reportPath);
    const blinded = Buffer.from(stripPreamble(source.toString('utf8')), 'utf8');
    writeFileSync(path.join(review, blindName), blinded);
    return {
      blindName,
      attemptId: item.attemptId,
      reviewPath: path.join(review, blindName),
      sourceSha256: sha256hex(source),
      blindSha256: sha256hex(blinded),
      bytes: blinded.length,
    };
  });

  const mapping = {
    schema: 'plugin-eval-blind-map@1',
    seed,
    createdAt: now === undefined ? new Date().toISOString() : new Date(now).toISOString(),
    entries: entries.map(({ blindName, attemptId, sourceSha256, blindSha256 }) => (
      { blindName, attemptId, sourceSha256, blindSha256 })),
  };
  if (Number.isNaN(Date.parse(mapping.createdAt))) throw new Error('now must be a parseable timestamp');
  const mappingPath = path.join(evaluator, MAPPING_FILE);
  writeFileSync(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, { flag: 'wx' });
  return { entries, mapping, mappingPath };
}

/**
 * Assemble a plugin-eval-score@1 record for a blinded report. attemptId is resolved
 * through the blindPacket mapping — a score cannot be constructed for an attempt that
 * was never blinded. Findings are normalized to all six EVIDENCE_FINDINGS in order;
 * any the reviewer did not supply is recorded MISSING (an omission is a verdict, not
 * an error). The assembled record must pass validateScore or this throws — a score
 * record is never emitted dirty. Note the schema cannot carry unknown code-gate
 * counts: codeGate is null or integer {passed,total}, so an unparseable grader run
 * must be re-run before scoring.
 */
export function recordScore({ mapping, blindName, codeGate = null, findings = [], freshness = null, defects = [] }) {
  const entries = isObj(mapping) ? mapping.entries : undefined;
  if (!Array.isArray(entries)) throw new Error('mapping must be a blindPacket mapping ({entries})');
  const entry = entries.find(e => e.blindName === blindName);
  if (!entry) {
    throw new Error(`no blinded attempt named ${JSON.stringify(blindName)} — scores need a blindPacket mapping entry`);
  }
  const supplied = new Map();
  for (const f of findings ?? []) {
    if (!isObj(f) || !EVIDENCE_FINDINGS.includes(f.id)) {
      throw new Error(`unknown finding id ${JSON.stringify(f?.id)} — expected one of ${EVIDENCE_FINDINGS.join(', ')}`);
    }
    if (supplied.has(f.id)) throw new Error(`finding ${f.id} supplied twice`);
    supplied.set(f.id, f);
  }
  const record = {
    schema: 'plugin-eval-score@1',
    attemptId: entry.attemptId,
    codeGate,
    findings: EVIDENCE_FINDINGS.map(id => {
      const f = supplied.get(id);
      if (!f) return { id, verdict: 'MISSING' };
      const out = { id, verdict: f.verdict };
      if (f.source !== undefined) out.source = f.source;
      if (f.heading !== undefined) out.heading = f.heading;
      return out;
    }),
    ...(freshness === undefined || freshness === null ? {} : { freshness }),
    defects: defects ?? [],
    blind: true,
  };
  const problems = validateScore(record);
  if (problems.length) throw new Error(`score record is not schema-clean: ${problems.join('; ')}`);
  return record;
}

/**
 * Run the real grader: `node <verifyPath> <attemptDir>` in a child process. Returns
 * {ran:true, exitCode, passed, total} parsed from the grader's JSON stdout; a run that
 * exits non-zero without parseable JSON is recorded as {passed:null, total:null} —
 * an unparseable result is recorded, never guessed. A spawn/signal/timeout yields
 * exitCode -1 (no normal exit observed) rather than a fabricated status.
 */
export function runCodeGate(attemptDir, verifyPath) {
  const r = spawnSync(process.execPath, [path.resolve(verifyPath), path.resolve(attemptDir)], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const exitCode = typeof r.status === 'number' ? r.status : -1;
  let parsed = null;
  try { parsed = JSON.parse(String(r.stdout ?? '').trim()); } catch { /* grader did not emit JSON */ }
  if (!isObj(parsed) || !Number.isSafeInteger(parsed.passed) || !Number.isSafeInteger(parsed.total)) {
    return { ran: true, exitCode, passed: null, total: null };
  }
  return { ran: true, exitCode, passed: parsed.passed, total: parsed.total };
}
