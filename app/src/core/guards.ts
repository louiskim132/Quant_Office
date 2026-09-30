/** Upper bound for any stored budget amount, in cents. The store validates budgets against it. */
export const MAX_BUDGET_CENTS = 100_000_000;

export function assertHostedExecution(capability: {
  provider: string;
  location: string;
  constrainedTools: boolean;
  colabAccess: boolean;
  localExecution: boolean;
}): void {
  if (
    !['OPENAI', 'ANTHROPIC'].includes(capability.provider) ||
    capability.location !== 'PROVIDER_HOSTED' ||
    !capability.constrainedTools ||
    capability.colabAccess ||
    capability.localExecution
  )
    throw new Error('Only constrained provider-hosted execution is allowed; no local or Colab access');
}

/**
 * The local counterpart of the hosted check: a local route may carry work only under confinement
 * the office itself observed and described — scoped delivery, honestly labeled, never a claim of
 * enforced isolation. Colab access stays impossible whatever the route.
 */
export function assertLocalExecution(capability: { constrainedTools: boolean; colabAccess: boolean }): void {
  if (capability.colabAccess || !capability.constrainedTools)
    throw new Error('Only office-observed confined local execution is allowed; no Colab access');
}

export interface WorkerInvocation {
  id: string;
  state:
    | 'RESERVED'
    | 'SUBMITTED'
    | 'RUNNING'
    | 'UNKNOWN'
    | 'CANCEL_REQUESTED'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELED_ACKNOWLEDGED';
}
/** Call with the complete global set, including nested worker invocations. Unknown jobs retain their slots. */
export function assertWorkerCapacity(
  globalInvocations: readonly WorkerInvocation[],
  requestedSlots = 1,
  providerLimit?: number,
): void {
  if (
    !Number.isSafeInteger(requestedSlots) ||
    requestedSlots < 1 ||
    (providerLimit !== undefined && (!Number.isSafeInteger(providerLimit) || providerLimit < 1))
  )
    throw new Error('Invalid worker slot request');
  const active = new Set(['RESERVED', 'SUBMITTED', 'RUNNING', 'UNKNOWN', 'CANCEL_REQUESTED']);
  const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED_ACKNOWLEDGED']);
  const identities = new Set<string>();
  for (const invocation of globalInvocations) {
    if (
      !invocation.id ||
      identities.has(invocation.id) ||
      (!active.has(invocation.state) && !terminal.has(invocation.state))
    )
      throw new Error('Invalid or duplicate global worker invocation');
    identities.add(invocation.id);
  }
  if (
    providerLimit !== undefined &&
    globalInvocations.filter(invocation => active.has(invocation.state)).length + requestedSlots > providerLimit
  )
    throw new Error('Provider concurrency capacity exceeded');
}
