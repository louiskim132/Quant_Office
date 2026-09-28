// Store scalability benchmark (launch-readiness L2). Builds a throwaway workspace in the OS temp
// folder, records N account observations whose capability snapshots alternate (the pattern the
// live app produces), then times reopen and snapshot(). Never point it at a real workspace.
// Usage from app/: pnpm exec tsx scripts/bench-store.ts [observations=500]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OfficeStore } from '../src/core/store';

const count = Number(process.argv[2] ?? 500);
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 7, 12, 0, 0) + minutes * 60000).toISOString();
const models = Array.from({ length: 400 }, (_, i) => ({
  id: `model-${i}`,
  name: `Model ${i} with a long display name for size`,
}));
const observation = (i: number) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: 'Account sign-in verified.',
  toolVersion: '2.1.236',
  transport: 'NONE' as const,
  environment: '',
  models,
  operations: [
    {
      operation: 'ACCOUNT_STATUS' as const,
      level: 'ACCOUNT_VERIFIED' as const,
      detail: 'Signed in.',
      evidence: 'OBSERVED' as const,
      verifiedAt: at(i * 10),
    },
    {
      operation: 'CLOUD_SUBMIT' as const,
      level: 'DOCUMENTED' as const,
      detail: 'Not verified for this account.',
      evidence: 'DOCUMENTED' as const,
      verifiedAt: at(i * 10),
    },
  ],
  source: i % 2 ? 'claude auth status' : 'claude auth status (recheck)',
  observedAt: at(i * 10),
});

const root = mkdtempSync(path.join(tmpdir(), 'qro-bench-'));
const file = path.join(root, 'workspace.sqlite');
let store = new OfficeStore(file);
let started = Date.now();
for (let i = 0; i < count; i++) store.recordAccountObservation(observation(i));
const writeMs = Date.now() - started;
// LR-17: a real session ends with the integrity checkpoint advanced, so the reopen below replays
// a zero-length tail — the background verification the app schedules must have completed first.
await store.verifyInBackground();
store.close();
started = Date.now();
store = new OfficeStore(file);
const openMs = Date.now() - started;
const probe = new DatabaseSync(file);
const maxSequence = Number((probe.prepare('SELECT MAX(sequence) AS s FROM events').get() as { s: number }).s);
const checkpointSequence = Number(
  (probe.prepare('SELECT sequence FROM integrity_checkpoint WHERE singleton=1').get() as { sequence: number }).sequence,
);
probe.close();
const tailEvents = maxSequence - checkpointSequence;
started = Date.now();
for (let i = 0; i < 20; i++) store.snapshot({ history: false });
const snapshotMs = (Date.now() - started) / 20;
store.close();
const db = new DatabaseSync(file);
const projectionBytes = Number((db.prepare('SELECT length(state) AS n FROM projection').get() as { n: number }).n);
db.close();
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ observations: count, projectionBytes, writeMs, openMs, snapshotMs, tailEvents }));
