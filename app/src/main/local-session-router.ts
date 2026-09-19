import type { ProviderJob, Provider } from '../shared/types.js';
import type { LocalSessionRecord, WorkspaceLayout } from '../shared/local-session.js';
import type { ProviderAdapter, SubmitContext, SubmitResult, ObserveResult } from './controller.js';

/**
 * LOCAL_MAILBOX layout router (QO-LOCAL-REV-20260919 §5.3, defect F07).
 *
 * Both mailbox layouts share one route string — the route names the *delivery protocol*, not the
 * storage layout. After a restart the only honest way to know whether a job's packet is a flat
 * directory or a project worktree is the persisted LocalSessionRecord. This adapter resolves that
 * record and delegates every operation to the layout's own implementation. Two registered
 * indistinguishable adapters and registration-order luck are exactly what this replaces.
 *
 * Legacy jobs — dispatched before bindings existed — have no record. They are all flat packets by
 * construction (the flat adapter was the only implementation), so resolution is explicit and
 * named, not a silent fallback. A job whose record says worktree never lands on the flat adapter.
 */

export type LocalSessionLookup = (jobId: string) => LocalSessionRecord | null;
export type LayoutAdapters = Record<WorkspaceLayout, ProviderAdapter>;

export class LocalSessionRouter implements ProviderAdapter {
  readonly route = 'LOCAL_MAILBOX' as const;
  readonly providers: readonly Provider[] = ['devin', 'claude', 'openai'];

  constructor(
    private readonly lookup: LocalSessionLookup,
    private readonly adapters: LayoutAdapters,
  ) {}

  /** Which layout implementation owns this job, and how the decision was reached. */
  private resolve(job: ProviderJob): { adapter: ProviderAdapter; binding: LocalSessionRecord | null } {
    const binding = this.lookup(job.id);
    if (!binding) {
      // Explicit legacy rule, not a default: pre-binding local jobs only ever existed as flat
      // packets. Anything the caller needs to reconcile is named in the observation detail.
      return { adapter: this.adapters.FLAT_PACKET, binding: null };
    }
    return { adapter: this.adapters[binding.layout], binding };
  }

  async submit(context: SubmitContext): Promise<SubmitResult> {
    // The binding is created in the durable intent transaction before submit — a submit without
    // one means the wiring, not the worker, is wrong.
    if (!context.localSession)
      throw new Error('Local submissions require a persisted local-session binding; the dispatch path must create it before calling submit.');
    return this.adapters[context.localSession.layout].submit(context);
  }

  async observe(job: ProviderJob): Promise<ObserveResult> {
    const { adapter, binding } = this.resolve(job);
    const result = await adapter.observe(job);
    if (!binding) return { ...result, detail: `[legacy binding: no local-session record — resolved as flat packet by rule, reconcile to bind] ${result.detail}` };
    return result;
  }

  async cancel(job: ProviderJob) { return this.resolve(job).adapter.cancel(job); }

  submitEvidence(context: SubmitContext, result: SubmitResult) {
    return (context.localSession ? this.adapters[context.localSession.layout] : this.adapters.FLAT_PACKET).submitEvidence?.(context, result) ?? [];
  }
  observeEvidence(job: ProviderJob, result: ObserveResult) { return this.resolve(job).adapter.observeEvidence?.(job, result) ?? []; }
  cancelEvidence(job: ProviderJob) { return this.resolve(job).adapter.cancelEvidence?.(job) ?? []; }

  async fetch(job: ProviderJob, output: { path: string; sha256: string; bytes: number }) {
    const { adapter } = this.resolve(job);
    if (!adapter.fetch) throw new Error('This layout carries no fetch operation.');
    return adapter.fetch(job, output);
  }

  /**
   * Packet archival delegates through the job's persisted binding — a bare directory name never
   * decides which layout owns it. Absent on a layout is an honest refusal.
   */
  async retire(job: ProviderJob): Promise<{ retired: boolean; detail: string }> {
    const { adapter, binding } = this.resolve(job);
    const retiring = adapter as ProviderAdapter & { retire?: (id: string) => Promise<{ retired: boolean; detail: string }> };
    if (typeof retiring.retire !== 'function') return { retired: false, detail: `The ${binding?.layout ?? 'legacy flat'} layout carries no retire operation.` };
    if (!job.externalId) return { retired: false, detail: 'The job records no packet directory name; nothing can be moved.' };
    return retiring.retire(job.externalId);
  }
}
