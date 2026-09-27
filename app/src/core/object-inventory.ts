import type { AppState } from '../shared/types.js';

/** One inventory for both backup formats and restore. Legacy absent bytes remain explicitly optional. */
export function objectInventory(
  state: Pick<AppState, 'artifacts' | 'snapshots' | 'jobs' | 'pipeline'>,
): Map<string, { bytes: number; required: boolean }> {
  const inventory = new Map<string, { bytes: number; required: boolean }>();
  const add = (hash: string, bytes: number, required: boolean) => {
    const old = inventory.get(hash);
    if (old && old.bytes !== bytes) throw new Error('Conflicting stored-object sizes.');
    inventory.set(hash, { bytes, required: required || Boolean(old?.required) });
  };
  for (const artifact of state.artifacts) add(artifact.sha256, artifact.size, true);
  for (const snapshot of state.snapshots ?? [])
    for (const file of [...snapshot.files, ...(snapshot.generated ?? [])])
      add(file.sha256, file.bytes, snapshot.objectsStored === true);
  for (const job of state.jobs ?? [])
    for (const output of job.outputs) add(output.sha256, output.bytes, output.stored === true);
  for (const record of state.pipeline ?? [])
    if (record.kind === 'HOLDOUT_RESULT' || record.kind === 'REBUTTAL')
      add(record.reportHash, record.reportBytes, true);
  return inventory;
}
