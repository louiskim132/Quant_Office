/**
 * Scorecard rollup for the C10-A plugin-evaluation harness (roadmap section 3.2).
 *
 * Pure by design: scorecard(entries) consumes already-parsed ledger entries and does no IO —
 * the ledger module owns the file. Entries may be bundled per attempt ({manifest, usage, score})
 * or bare records (each carrying its own schema/attemptId); records are merged by attemptId and
 * grouped by manifest.arm. Anything unrecognized is listed under `ignored`, never guessed at.
 *
 * Accounting conventions (§3.2 "Record per attempt"): usage counters are observed, never
 * estimated; a missing counter is reported as 'UNKNOWN', never zero, and any sum/median/range
 * that depends on it is likewise 'UNKNOWN'. totalTokens sums the raw recorded categories
 * (agent input/output/reasoning/cacheRead/cacheWrite plus every helper model's input/output);
 * it is finite only when every one of those counters was observed. Tokens are not subscription
 * allowance or money.
 *
 * Ordering: the quality gate precedes efficiency. Track A attempts require codeGate
 * passed === total AND all six findings PRESENT; track B requires all six PRESENT; a FRESHNESS
 * attempt additionally requires newSourceCited && birchRecheck && unknownPreserved. An arm with
 * at least one successful attempt is gate-PASSED; otherwise GATE_FAILED and never promoted
 * regardless of token counts. Failed attempts still charge their usage to the arm total.
 *
 * Cold vs reuse is reported separately: an attempt that recorded first-use setup
 * (manifest.setupMs > 0 or usage.setupWallMs > 0) is cold; zero recorded setup is reuse.
 *
 * verdict(baseline, candidate) returns a label only — it never recommends combinations;
 * §3.2 makes combination selection a human decision over individually useful additions.
 *   'PROMISING'     candidate passed the same gate as the baseline AND its per-successful-task
 *                   totalTokens reduction exceeds both arms' observed per-attempt variation.
 *   'INCONCLUSIVE'  counters are missing, either arm has no finite score, the baseline itself
 *                   failed its gate, tracks differ, or the difference sits within variation.
 *   'NO_BENEFIT'    candidate quality holds but its usage is not reduced.
 *   'GATE_FAILED'   the candidate arm failed its quality gate.
 */
import { ARMS, TRACK_OF_ARM, PHASES, EVIDENCE_FINDINGS } from './records.mjs';

const UNKNOWN = 'UNKNOWN';
const KIND_OF_SCHEMA = {
  'plugin-eval-attempt@1': 'manifest',
  'plugin-eval-usage@1': 'usage',
  'plugin-eval-score@1': 'score',
};
/** Flat per-attempt usage metrics. Token categories roll into totalTokens; the rest stay raw. */
export const TOKEN_COUNTERS = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'helperInput', 'helperOutput'];
export const METRICS = [...TOKEN_COUNTERS, 'setupWallMs', 'taskWallMs', 'toolBytes', 'totalTokens'];

const isInt = v => Number.isSafeInteger(v) && v >= 0;
const num = v => isInt(v) ? v : null; // anything unobserved or malformed stays null → UNKNOWN

/** Merge arbitrary ledger entry shapes into per-attempt {manifest, usage, score} by attemptId. */
function collectAttempts(entries) {
  const byId = new Map();
  const ignored = [];
  const slot = id => {
    if (!byId.has(id)) byId.set(id, { attemptId: id, manifest: null, usage: null, score: null });
    return byId.get(id);
  };
  const add = (kind, record) => {
    if (!record || typeof record !== 'object') return ignored.push(`${kind} record is not an object`);
    const id = typeof record.attemptId === 'string' ? record.attemptId : null;
    if (!id) return ignored.push(`${kind} record without an attemptId`);
    const attempt = slot(id);
    if (attempt[kind]) return ignored.push(`duplicate ${kind} for attempt ${id}`);
    attempt[kind] = record;
  };
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') { ignored.push('entry is not an object'); continue; }
    if (KIND_OF_SCHEMA[entry.schema]) { add(KIND_OF_SCHEMA[entry.schema], entry); continue; }
    let saw = false;
    for (const kind of ['manifest', 'usage', 'score']) {
      if (entry[kind]) { add(kind, entry[kind]); saw = true; }
    }
    if (!saw) ignored.push('entry has no recognized manifest/usage/score record');
  }
  return { attempts: [...byId.values()], ignored };
}

/** Per-attempt flat usage; null when no usage record exists. Missing counters stay null. */
function flatUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const agent = usage.agent && typeof usage.agent === 'object' ? usage.agent : {};
  const helpers = Array.isArray(usage.helperModels) ? usage.helperModels : [];
  const m = {
    input: num(agent.input), output: num(agent.output), reasoning: num(agent.reasoning),
    cacheRead: num(agent.cacheRead), cacheWrite: num(agent.cacheWrite),
    setupWallMs: num(usage.setupWallMs), taskWallMs: num(usage.taskWallMs), toolBytes: num(usage.toolBytes),
  };
  m.helperInput = helpers.every(h => h && isInt(h.input)) ? helpers.reduce((s, h) => s + h.input, 0) : null;
  m.helperOutput = helpers.every(h => h && isInt(h.output)) ? helpers.reduce((s, h) => s + h.output, 0) : null;
  m.totalTokens = TOKEN_COUNTERS.every(k => m[k] !== null) ? TOKEN_COUNTERS.reduce((s, k) => s + m[k], 0) : null;
  return m;
}

/** §3.2 quality requirements for one scored attempt. An empty problem list means success. */
function attemptProblems(track, attempt) {
  const { manifest, score } = attempt;
  if (!score || typeof score !== 'object') return ['no score record'];
  const problems = [];
  const findings = Array.isArray(score.findings) ? score.findings : [];
  for (let i = 0; i < EVIDENCE_FINDINGS.length; i++) {
    const f = findings[i];
    if (!f || f.id !== EVIDENCE_FINDINGS[i] || f.verdict !== 'PRESENT') {
      problems.push(`finding ${EVIDENCE_FINDINGS[i]} is not PRESENT`);
    }
  }
  if (track === 'A') {
    const g = score.codeGate;
    if (!g || g.ran !== true || !isInt(g.passed) || !isInt(g.total) || g.total === 0 || g.passed !== g.total) {
      problems.push('code gate is not a full pass');
    }
  }
  if (manifest?.phase === 'FRESHNESS') {
    const f = score.freshness;
    if (!f || f.newSourceCited !== true || f.birchRecheck !== true || f.unknownPreserved !== true) {
      problems.push('freshness response is incomplete');
    }
  }
  return problems;
}

/** Usage rollup over a set of attempts. UNKNOWN propagates through every derived number. */
function rollup(attempts) {
  const ran = attempts.filter(a => a.usage);
  const succeeded = attempts.filter(a => a.success);
  const total = {}, perSuccessfulTask = {}, median = {}, range = {};
  for (const k of METRICS) {
    const values = ran.map(a => a.usage[k]);
    const observed = ran.length > 0 && values.every(v => v !== null);
    const sum = observed ? values.reduce((s, v) => s + v, 0) : null;
    total[k] = sum === null ? UNKNOWN : sum;
    perSuccessfulTask[k] = sum !== null && succeeded.length ? sum / succeeded.length : UNKNOWN;
    if (!observed) {
      median[k] = UNKNOWN;
      range[k] = UNKNOWN;
      continue;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    median[k] = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    range[k] = { min: sorted[0], max: sorted[sorted.length - 1] };
  }
  return {
    attempts: attempts.length,
    ranAttempts: ran.length,
    successfulTasks: succeeded.length,
    total,
    perSuccessfulTask: succeeded.length ? perSuccessfulTask : 'NO_FINITE_SCORE',
    median,
    range,
  };
}

const bucket = attempts => attempts.length ? rollup(attempts) : 'NO_ATTEMPTS';

/**
 * Roll parsed ledger entries into per-arm gate and efficiency reports.
 * @param {Array<object>} entries bundled {manifest,usage,score} entries or bare records
 * @returns {{schema:string, entries:number, arms:object, ignored:string[]}}
 */
export function scorecard(entries) {
  const { attempts, ignored } = collectAttempts(entries);
  for (const a of attempts) {
    if (!a.manifest) ignored.push(`attempt ${a.attemptId} has no manifest and cannot be grouped to an arm`);
  }
  const arms = {};
  for (const arm of ARMS) {
    const members = attempts.filter(a => a.manifest?.arm === arm);
    if (!members.length) continue;
    const track = TRACK_OF_ARM[arm];
    const scored = members.map(a => {
      const ran = Boolean(a.usage || a.score);
      const problems = ran
        ? attemptProblems(track, a)
        : ['attempt never ran: manifest only, no usage or score'];
      return {
        attemptId: a.attemptId,
        phase: a.manifest.phase ?? null,
        cold: (isInt(a.manifest.setupMs) && a.manifest.setupMs > 0) || (isInt(a.usage?.setupWallMs) && a.usage.setupWallMs > 0),
        ran,
        success: ran && problems.length === 0,
        problems,
        usage: flatUsage(a.usage),
        defects: Array.isArray(a.score?.defects) ? a.score.defects.length : 0,
      };
    });
    const successful = scored.filter(a => a.success);
    const failed = scored.filter(a => a.ran && !a.success);
    const overall = rollup(scored);
    arms[arm] = {
      arm,
      track,
      attempts: scored,
      gate: {
        status: successful.length ? 'PASSED' : 'GATE_FAILED',
        successfulAttempts: successful.length,
        failedAttempts: failed.length,
        failures: failed.map(a => ({ attemptId: a.attemptId, phase: a.phase, problems: a.problems })),
      },
      efficiency: successful.length ? {
        ...overall,
        cold: bucket(scored.filter(a => a.cold)),
        reuse: bucket(scored.filter(a => a.ran && !a.cold)),
        phases: Object.fromEntries(PHASES.map(p => [p, bucket(scored.filter(a => a.phase === p))])),
      } : 'NO_FINITE_SCORE',
    };
  }
  return { schema: 'plugin-eval-scorecard@1', entries: Array.isArray(entries) ? entries.length : 0, arms, ignored };
}

/**
 * §3.2 comparison of one candidate arm against its baseline. Labels only — never a
 * combination recommendation; combinations are selected by humans from individually
 * useful additions.
 * @returns {'PROMISING'|'INCONCLUSIVE'|'NO_BENEFIT'|'GATE_FAILED'}
 */
export function verdict(baseline, candidate) {
  if (!baseline || !candidate) return 'INCONCLUSIVE';
  if (candidate.gate?.status !== 'PASSED') return 'GATE_FAILED';
  if (baseline.gate?.status !== 'PASSED') return 'INCONCLUSIVE';
  if (baseline.track !== candidate.track) return 'INCONCLUSIVE';
  const ea = baseline.efficiency, eb = candidate.efficiency;
  if (!ea || !eb || ea === 'NO_FINITE_SCORE' || eb === 'NO_FINITE_SCORE') return 'INCONCLUSIVE';
  const perA = ea.perSuccessfulTask?.totalTokens, perB = eb.perSuccessfulTask?.totalTokens;
  if (typeof perA !== 'number' || typeof perB !== 'number') return 'INCONCLUSIVE';
  if (perB >= perA) return 'NO_BENEFIT';
  const width = r => (r && typeof r === 'object') ? r.max - r.min : null;
  const wA = width(ea.range?.totalTokens), wB = width(eb.range?.totalTokens);
  if (wA === null || wB === null) return 'INCONCLUSIVE';
  return perA - perB > wA + wB ? 'PROMISING' : 'INCONCLUSIVE';
}
