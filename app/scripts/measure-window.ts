/** Read an archived workspace directly, without opening the application or dispatching anything. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OfficeStore } from '../src/core/store';
import { effectiveEvidence, providerReadiness, agentDispatchReadiness, agentBinding } from '../src/shared/readiness';
import type { AppState, ProviderCapabilitySnapshot } from '../src/shared/types';

const source = path.resolve(process.argv[2]);
const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
const before = hash();
const scratch = path.join(mkdtempSync(path.join(tmpdir(), 'qro-window-measure-')), 'workspace.sqlite');
cpSync(source, scratch);
const db = new DatabaseSync(scratch, { readOnly: true });
const full = JSON.parse(String(db.prepare('SELECT state FROM projection WHERE singleton=1').get()!.state)) as AppState;
db.close();
const final = OfficeStore.publicState(full);
const cited = new Set(
  (full.assignments ?? []).flatMap(a => [a.capabilitySnapshotId, ...(a.capabilitySnapshotIds ?? [])]).filter(Boolean),
);
const oldLatest = new Map<string, ProviderCapabilitySnapshot>();
const appended = new Map<string, ProviderCapabilitySnapshot>();
for (const c of full.capabilities ?? []) {
  if (!oldLatest.has(c.connectionId) || c.observedAt > oldLatest.get(c.connectionId)!.observedAt)
    oldLatest.set(c.connectionId, c);
  appended.set(c.connectionId, c);
}
const old = (full.capabilities ?? []).filter(c => oldLatest.get(c.connectionId)?.id === c.id || cited.has(c.id));
const candidates = (full.capabilities ?? []).filter(
  c =>
    appended.get(c.connectionId) === c ||
    cited.has(c.id) ||
    (c.toolVersion === appended.get(c.connectionId)?.toolVersion &&
      c.identity === full.connections?.find(x => x.id === c.connectionId)?.identity),
);
const size = (capabilities: ProviderCapabilitySnapshot[]) =>
  Buffer.byteLength(JSON.stringify({ ...final, capabilities }));
let comparisons = 0;
for (const connection of full.connections ?? []) {
  const scopes = (full.capabilities ?? [])
    .filter(c => c.connectionId === connection.id)
    .flatMap(c =>
      c.operations.map(e => ({
        operation: e.operation,
        options: {
          now: Date.parse('2026-10-01T12:00:00Z'),
          route: e.route,
          model: e.model,
          environment: e.environment ?? c.environment,
          effort: e.effort,
          delegation: e.delegation,
        },
      })),
    );
  for (const { operation, options } of scopes) {
    assert.deepEqual(
      effectiveEvidence(final, connection, operation, options),
      effectiveEvidence(full, connection, operation, options),
    );
    assert.deepEqual(effectiveEvidence(final, connection, operation), effectiveEvidence(full, connection, operation));
    assert.deepEqual(
      providerReadiness(final, connection.provider, options),
      providerReadiness(full, connection.provider, options),
    );
    comparisons += 3;
  }
}
for (const agent of full.agents) {
  assert.deepEqual(agentBinding(final, agent), agentBinding(full, agent));
  assert.deepEqual(agentDispatchReadiness(final, agent), agentDispatchReadiness(full, agent));
  comparisons += 2;
}
assert.equal(hash(), before, 'original archived file is unchanged');
const report = {
  sourceHash: before,
  sourceBytes: readFileSync(source).length,
  readOnly: true,
  comparisons,
  pre56: { snapshots: full.capabilities?.length, bytes: size(full.capabilities ?? []) },
  after56: { snapshots: old.length, bytes: size(old) },
  b2bCandidates: { snapshots: candidates.length, bytes: size(candidates) },
  b2bFinal: { snapshots: final.capabilities?.length, bytes: size(final.capabilities ?? []) },
  originalUnchanged: true,
};
if (process.argv[3]) writeFileSync(path.resolve(process.argv[3]), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
