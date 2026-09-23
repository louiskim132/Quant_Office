/**
 * Shared record contracts for the C10-A plugin-evaluation harness (roadmap section 3.2).
 *
 * Dependency-free by design: harness modules must run in the disposable, no-secret/no-network
 * evaluator environment, so nothing here imports app/src or node_modules. Validators return a
 * problem list; an empty list is the only pass. Missing usage counters stay null and surface as
 * UNKNOWN downstream — never zero.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Every arm the protocol names. Track membership is fixed; an arm never crosses tracks. */
export const ARMS = ['A0', 'AS', 'AP', 'AG', 'B0', 'BG', 'BL'];
export const TRACK_OF_ARM = { A0: 'A', AS: 'A', AP: 'A', AG: 'A', B0: 'B', BG: 'B', BL: 'B' };
/** The scored phases. INITIAL is the cold run; FRESHNESS re-asks after the catalog.md correction. */
export const PHASES = ['INITIAL', 'FRESHNESS'];
/** Roadmap-frozen task timebox. Setup/indexing is separately recorded, never inside this. */
export const TIMEBOX_MS = 10 * 60 * 1000;

/** The six evidence findings every report is scored against, in EVALUATOR.md order. */
export const EVIDENCE_FINDINGS = [
  'v2-supersedes-v1',
  'amber-harbor-publication-chain',
  'amber-v1-manifest-recheck',
  'birch-completion-is-metadata-only',
  'a02-failed-omitted-from-inventory',
  'profitability-unsupported',
];

export const FINDING_VERDICTS = ['PRESENT', 'MISSING', 'WRONG_SOURCE', 'INVENTED', 'UNSUPPORTED'];

const SHA = /^[a-f0-9]{64}$/;
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;
const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isCount = v => v === null || (Number.isSafeInteger(v) && v >= 0);

/** Deterministic content hash for manifests and ledger dedupe — a JSON canonical form, not a signature. */
export function contentHash(value) {
  const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : isObj(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v);
  return createHash('sha256').update(canon(value)).digest('hex');
}
export const fileHash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * What one attempt froze before anything ran. files is the exact copied task/ inventory; config
 * records only what was actually chosen — tools is the declared addition list ('none' for baseline
 * arms is written as []).
 */
export function validateManifest(m) {
  const p = [];
  if (!isObj(m)) return ['manifest is not an object'];
  if (typeof m.schema !== 'string' || m.schema !== 'plugin-eval-attempt@1') p.push('schema must be plugin-eval-attempt@1');
  if (typeof m.attemptId !== 'string' || !safeName.test(m.attemptId)) p.push('attemptId must be a safe single name');
  if (!ARMS.includes(m.arm)) p.push(`arm must be one of ${ARMS.join(', ')}`);
  if (!PHASES.includes(m.phase)) p.push(`phase must be one of ${PHASES.join(', ')}`);
  if (typeof m.promptSha256 !== 'string' || !SHA.test(m.promptSha256)) p.push('promptSha256 must be a sha256 of the exact prompt bytes');
  if (typeof m.taskHash !== 'string' || !SHA.test(m.taskHash)) p.push('taskHash must hash the copied task inventory');
  if (!Array.isArray(m.files) || !m.files.length) p.push('files must list every copied task member');
  else for (const f of m.files) {
    if (!isObj(f) || typeof f.path !== 'string' || !f.path.length || f.path.includes('..') || path_isAbs(f.path)) { p.push(`unsafe or missing file path ${JSON.stringify(f?.path)}`); continue; }
    if (typeof f.sha256 !== 'string' || !SHA.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0) p.push(`file ${f.path} needs sha256 and a safe byte count`);
  }
  if (!isObj(m.config)) p.push('config must record provider, model, effort, clientVersion and tools');
  else {
    for (const key of ['provider', 'model', 'effort', 'clientVersion']) if (typeof m.config[key] !== 'string' || !m.config[key]) p.push(`config.${key} must be a non-empty string`);
    if (!Array.isArray(m.config.tools)) p.push('config.tools must be an array, [] for a baseline arm');
  }
  if (m.timeboxMs !== TIMEBOX_MS) p.push(`timeboxMs must be the frozen ${TIMEBOX_MS}`);
  if (!Number.isSafeInteger(m.setupMs) || m.setupMs < 0) p.push('setupMs must be a safe non-negative integer (0 when nothing was set up)');
  if (typeof m.createdAt !== 'string' || !Date.parse(m.createdAt)) p.push('createdAt must be an ISO timestamp');
  return p;
}
const path_isAbs = p => p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('\\');

/** Usage is recorded, never estimated: null means the counter was not observable, read as UNKNOWN. */
export function validateUsage(u) {
  const p = [];
  if (!isObj(u)) return ['usage record is not an object'];
  if (typeof u.schema !== 'string' || u.schema !== 'plugin-eval-usage@1') p.push('schema must be plugin-eval-usage@1');
  if (typeof u.attemptId !== 'string' || !safeName.test(u.attemptId)) p.push('attemptId must be a safe single name');
  if (!isObj(u.agent)) p.push('agent counters are required');
  else for (const key of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'])
    if (!isCount(u.agent[key])) p.push(`agent.${key} must be a non-negative integer or null (UNKNOWN)`);
  if (!Array.isArray(u.helperModels)) p.push('helperModels must be an array')
  else for (const h of u.helperModels) {
    if (!isObj(h) || typeof h.name !== 'string' || !h.name) { p.push('each helper model needs a name'); continue; }
    for (const key of ['input', 'output']) if (!isCount(h[key])) p.push(`helper ${h.name}.${key} must be an integer or null`);
  }
  for (const key of ['setupWallMs', 'taskWallMs', 'toolBytes'])
    if (!isCount(u[key])) p.push(`${key} must be a non-negative integer or null (UNKNOWN)`);
  if (u.note !== undefined && typeof u.note !== 'string') p.push('note must be a string when present');
  return p;
}

/**
 * The score an evaluator records per attempt. codeGate is null on track B; findings always carries
 * all six ids in EVIDENCE_FINDINGS order. blind must be true — a reviewer who saw the arm identity
 * cannot produce this record.
 */
export function validateScore(s) {
  const p = [];
  if (!isObj(s)) return ['score record is not an object'];
  if (typeof s.schema !== 'string' || s.schema !== 'plugin-eval-score@1') p.push('schema must be plugin-eval-score@1');
  if (typeof s.attemptId !== 'string' || !safeName.test(s.attemptId)) p.push('attemptId must be a safe single name');
  if (s.codeGate !== null && !(isObj(s.codeGate) && typeof s.codeGate.ran === 'boolean'
    && Number.isSafeInteger(s.codeGate.exitCode) && Number.isSafeInteger(s.codeGate.passed) && Number.isSafeInteger(s.codeGate.total)))
    p.push('codeGate is null or {ran, exitCode, passed, total}');
  if (!Array.isArray(s.findings) || s.findings.length !== EVIDENCE_FINDINGS.length) p.push('findings must carry all six evidence findings');
  else s.findings.forEach((f, i) => {
    if (!isObj(f) || f.id !== EVIDENCE_FINDINGS[i]) { p.push(`findings[${i}] must name ${EVIDENCE_FINDINGS[i]}`); return; }
    if (!FINDING_VERDICTS.includes(f.verdict)) p.push(`findings[${i}].verdict must be one of ${FINDING_VERDICTS.join(', ')}`);
    if (f.verdict === 'PRESENT' && (typeof f.source !== 'string' || !f.source || typeof f.heading !== 'string' || !f.heading))
      p.push(`findings[${i}] PRESENT requires the cited source filename and section heading`);
  });
  if (s.freshness !== undefined && s.freshness !== null && !(isObj(s.freshness)
    && typeof s.freshness.newSourceCited === 'boolean' && typeof s.freshness.birchRecheck === 'boolean' && typeof s.freshness.unknownPreserved === 'boolean'))
    p.push('freshness is {newSourceCited, birchRecheck, unknownPreserved} or absent');
  if (!Array.isArray(s.defects)) p.push('defects must be an array of strings')
  else if (s.defects.some(d => typeof d !== 'string')) p.push('defects entries must be strings');
  if (s.blind !== true) p.push('blind must be true — the reviewer must not have seen the arm identity');
  return p;
}
