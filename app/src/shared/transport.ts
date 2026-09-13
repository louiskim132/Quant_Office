/**
 * Containment for the session-creating transport verification action (roadmap R1-A).
 *
 * The local probe tracking and receipt repairs are implemented. Creating another provider session
 * remains contained until the historical session is reconciled and R5 supplies the required live
 * route evidence. Passing local tests cannot establish those provider facts.
 *
 * This contains the session-creating action only. Account checks, provider usage links, stored
 * capability evidence and the local module diagnostic keep working, because none of them creates
 * anything. A module that loads is still not a verified cloud transport.
 */
export interface TransportProbeContainment { contained: boolean; reason: string; status: string }

export const TRANSPORT_PROBE_CONTAINMENT: TransportProbeContainment = {
  contained: true,
  /** Returned by the main handler. True only because the rejection happens before any effect. */
  reason: 'Cloud transport verification is temporarily unavailable pending hosted verification and session reconciliation. '
    + 'No probe was started by this action.',
  /** Shown in Settings in place of the removed live-create flow. */
  status: 'Cloud transport verification unavailable — hosted verification and session reconciliation required.',
};

/**
 * Call in the trusted main process before tool-path lookup, account observation, adapter
 * construction, directory creation or any provider process. A renderer-side check is not
 * containment: a stale window or a direct bridge call must be refused here too.
 */
export function assertTransportProbeAllowed(containment: TransportProbeContainment = TRANSPORT_PROBE_CONTAINMENT): void {
  if (containment.contained) throw new Error(containment.reason);
}
