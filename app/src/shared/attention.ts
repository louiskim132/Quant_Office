import type { AppState } from './types.js';
import type { OfficeActivity } from './activity.js';
import { requestQueue } from './queue.js';
import { summarizeRequest } from './request-summary.js';

/**
 * Everything that is waiting on the user, in one list. Built only from recorded requests, hops and the
 * derived office activity — it invents no urgency. The same list feeds the bell, the sidebar badge, the
 * status bar and the taskbar badge, so they can never disagree.
 */
export interface AttentionItem {
  id: string;
  kind: 'request' | 'agent';
  /** Status vocabulary key: `needs` for a decision or failed step, `stalled` for a quiet process. */
  status: 'needs' | 'stalled';
  title: string;
  detail: string;
  targetId: string;
}

export function attentionItems(
  state: Pick<
    AppState,
    'tasks' | 'experiments' | 'projects' | 'requests' | 'assignments' | 'jobs' | 'localSessions' | 'agents'
  >,
  activity: OfficeActivity[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const entry of requestQueue(state)) {
    if (!entry.request || entry.request.removedAt) continue;
    const summary = summarizeRequest(state, entry);
    if (summary.bucket !== 'needs') continue;
    items.push({
      id: `request:${entry.id}`,
      kind: 'request',
      status: 'needs',
      title: entry.request.name,
      detail: `${summary.label}${summary.reason ? ` — ${summary.reason}` : ''}`,
      targetId: entry.id,
    });
  }
  for (const seat of activity) {
    if (!seat.stalled) continue;
    const agent = state.agents.find(a => a.id === seat.agentId);
    if (!agent) continue;
    items.push({
      id: `agent:${agent.id}`,
      kind: 'agent',
      status: 'stalled',
      title: `${agent.name} has gone quiet`,
      detail: 'Its process is still running but has written nothing for 10 minutes. Some CLIs stay silent until they finish.',
      targetId: agent.id,
    });
  }
  return items;
}
