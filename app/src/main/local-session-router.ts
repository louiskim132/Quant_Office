import type { AdapterRoute, CapabilityEvidence, ProviderJob, Provider } from '../shared/types.js';
import type { LocalSessionRecord, WorkspaceLayout } from '../shared/local-session.js';
import type { ProviderAdapter, SubmitContext, SubmitResult, ObserveResult } from './controller.js';
import type { LaunchRequest } from './handoff.js';

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
  readonly providers: readonly Provider[] = ['devin', 'claude', 'openai'];

  constructor(
    private readonly lookup: LocalSessionLookup,
    private readonly adapters: LayoutAdapters,
    /**
     * The route this router serves. LOCAL_MAILBOX resolves two real layout adapters; a
     * single-layout route (LOCAL_CLI_EXEC) fills both slots with its own adapter, so a record
     * misbound to the other layout still lands on that adapter and fails closed on its own
     * layout check instead of silently changing transport.
     */
    readonly route: AdapterRoute = 'LOCAL_MAILBOX',
  ) {}

  /**
   * The packet contract new bindings are minted at — the flat slot's own declaration, because
   * binding creation always selects the flat lane. Without this the minted record would read
   * version 1 while every registered adapter only writes v2, and a route that hard-requires the
   * v2 contract (LOCAL_CLI_EXEC) would refuse its own freshly minted binding.
   */
  get packetVersion(): 1 | 2 | undefined { return this.adapters.FLAT_PACKET.packetVersion; }

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
    // The resolved binding goes with the job: the bound packet version, attempt identity and
    // storage path are what the receipt is validated against — never the receipt's own claims.
    const result = await adapter.observe(job, binding);
    if (!binding) return { ...result, detail: `[legacy binding: no local-session record — resolved as flat packet by rule, reconcile to bind] ${result.detail}` };
    return result;
  }

  async cancel(job: ProviderJob) {
    const { adapter, binding } = this.resolve(job);
    return adapter.cancel(job, binding);
  }

  /** Launch previews resolve through the bound layout when one exists; absent a binding the flat slot answers, and an adapter without plan simply offers none. */
  plan(context: SubmitContext): LaunchRequest | undefined {
    const adapter = context.localSession ? this.adapters[context.localSession.layout] : this.adapters.FLAT_PACKET;
    return (adapter as ProviderAdapter & { plan?: (context: SubmitContext) => LaunchRequest }).plan?.(context);
  }

  submitEvidence(context: SubmitContext, result: SubmitResult) {
    return (context.localSession ? this.adapters[context.localSession.layout] : this.adapters.FLAT_PACKET).submitEvidence?.(context, result) ?? [];
  }
  observeEvidence(job: ProviderJob, result: ObserveResult) { return this.resolve(job).adapter.observeEvidence?.(job, result) ?? []; }
  cancelEvidence(job: ProviderJob) { return this.resolve(job).adapter.cancelEvidence?.(job) ?? []; }

  async fetch(job: ProviderJob, output: { path: string; sha256: string; bytes: number }) {
    const { adapter, binding } = this.resolve(job);
    if (!adapter.fetch) throw new Error('This layout carries no fetch operation.');
    return adapter.fetch(job, output, binding);
  }

  /**
   * Packet archival delegates through the job's persisted binding — a bare directory name never
   * decides which layout owns it, and the binding's storage path (not the external id basename)
   * is what moves. Absent on a layout is an honest refusal.
   */
  async retire(job: ProviderJob): Promise<{ retired: boolean; alreadyArchived?: boolean; archivedAs?: string; detail: string }> {
    const { adapter, binding } = this.resolve(job);
    const retiring = adapter as ProviderAdapter & {
      retire?: (id: string, local?: LocalSessionRecord | null) => Promise<{ retired: boolean; alreadyArchived?: boolean; archivedAs?: string; detail: string }>
    };
    if (typeof retiring.retire !== 'function') return { retired: false, detail: `The ${binding?.layout ?? 'legacy flat'} layout carries no retire operation.` };
    const packetKey = binding?.storageRelativePath ?? job.externalId;
    if (!packetKey) return { retired: false, detail: 'Neither the binding nor the job records a packet directory; nothing can be moved.' };
    return retiring.retire(packetKey, binding);
  }

  /** Retirement evidence names a directory under the flat archive root — the only archive that exists. */
  retireEvidence(externalId: string) {
    return (this.adapters.FLAT_PACKET as { retireEvidence?: (id: string) => CapabilityEvidence[] }).retireEvidence?.(externalId) ?? [];
  }
}
