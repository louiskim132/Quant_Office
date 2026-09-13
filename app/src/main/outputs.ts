import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Assignment, InputSnapshot, JobOutput, ProviderJob } from '../shared/types.js';
import type { OfficeStore } from '../core/store.js';
import { safeEntry, MAX_FILE } from './artifacts.js';
import { assertNoLinkedAncestor, reserveOutputDestination, snapshotObjectPath } from './locations.js';

/** Local storage only. The service cannot fetch output or contact a provider. */
export class OutputService {
  constructor(private readonly store: OfficeStore, private readonly workspace: string) {}

  prepare = (assignment: Assignment, snapshot: InputSnapshot) => {
    const selected = assignment.frozen?.outputFolder;
    if (selected === undefined) throw new Error('This assignment predates frozen output destinations. Prepare it again.');
    const root = selected || path.join(this.workspace, 'results');
    assertNoLinkedAncestor(root, p => `The output root is reached through a link: ${p}`);
    if (!selected) mkdirSync(root, { recursive: true });
    return reserveOutputDestination({ outputRoot: root, managed: !selected, projectId: assignment.projectId,
      requestId: assignment.requestId, assignmentId: assignment.id, idempotencyKey: assignment.id, snapshot });
  };

  /** Exclusive writes and content-addressed versions preserve earlier bytes, including after restart. */
  storeBytes = async (hash: string, bytes: Uint8Array, job: ProviderJob, output: JobOutput): Promise<void> => {
    if (!safeEntry(output.path) || bytes.byteLength > MAX_FILE || bytes.byteLength !== output.bytes
      || createHash('sha256').update(bytes).digest('hex') !== hash || hash !== output.sha256)
      throw new Error('Output path, size or byte identity is invalid.');
    const state = this.store.snapshot({history:false});
    const assignment = state.assignments?.find(item => item.id === job.assignmentId);
    const snapshot = state.snapshots?.find(item => item.id === assignment?.snapshotId);
    if (!assignment || !snapshot) throw new Error('Output has no recorded assignment and snapshot.');
    const destination = this.prepare(assignment, snapshot);
    const targets = [snapshotObjectPath(this.workspace, hash), path.join(destination.path, 'files', hash, ...output.path.split('/'))];
    for (const target of targets) {
      assertNoLinkedAncestor(target, p => `Output storage is reached through a link: ${p}`);
      mkdirSync(path.dirname(target), { recursive: true });
      if (existsSync(target)) {
        const stored = readFileSync(target);
        if (stored.byteLength !== bytes.byteLength || createHash('sha256').update(stored).digest('hex') !== hash)
          throw new Error('Existing output bytes failed integrity verification.');
      } else writeFileSync(target, bytes, { flag: 'wx' });
    }
  };
}
