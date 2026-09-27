import type { AppState, JobEvidence, JobEvent } from './types';

export interface OfficeChatQuery {
  projectId?: string;
  requestId?: string;
  agentId?: string;
  cursor?: string;
  limit?: number;
}
export interface OfficeChatEntry {
  id: string;
  timestamp: string;
  agentId: string | null;
  toAgentId: string | null;
  projectId: string;
  requestId: string;
  kind: JobEvent['kind'];
  source: 'AGENT_MESSAGE' | 'PROVIDER_EVENT' | 'OFFICE_STATUS';
  text: string;
  evidence: JobEvidence;
  label: string;
}
export interface OfficeChatPage {
  entries: OfficeChatEntry[];
  nextCursor: string | null;
  total: number;
}

/** Show public speech/tool names from known CLI envelopes, never thinking blocks or raw envelopes. */
export function chatEventText(text: string): string {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return '';
    if (value.type === 'result' && typeof value.result === 'string') return value.result;
    if (value.type === 'assistant' && Array.isArray(value.message?.content)) {
      return value.message.content
        .flatMap((part: { type?: string; text?: unknown; name?: unknown }) =>
          part.type === 'text' && typeof part.text === 'string'
            ? [part.text]
            : part.type === 'tool_use' && typeof part.name === 'string'
              ? [`Using ${part.name}`]
              : [],
        )
        .join('\n');
    }
    if (value.type === 'item.completed' && value.item?.type === 'agent_message' && typeof value.item.text === 'string')
      return value.item.text;
    if (value.type === 'item.completed' && value.item?.type === 'command_execution') return 'Ran a shell command.';
    return ''; // metadata, reasoning and unknown structured events are not conversation messages
  } catch {
    return text.trim().startsWith('{') ? '' : text;
  }
}

/** Read-only projection. Only a bounded page crosses IPC; no sessions or local files are opened. */
export function officeChatPage(state: AppState, query: OfficeChatQuery = {}): OfficeChatPage {
  const scope = JSON.stringify([query.projectId ?? '', query.requestId ?? '', query.agentId ?? '']);
  let before: { scope: string; timestamp: string; id: string } | undefined;
  if (query.cursor) {
    try {
      before = JSON.parse(query.cursor);
      if (
        !before ||
        before.scope !== scope ||
        typeof before.id !== 'string' ||
        typeof before.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(before.timestamp))
      )
        throw new Error();
    } catch {
      throw new Error('Chat cursor is malformed or belongs to another conversation.');
    }
  }
  const assignments = new Map(state.assignments?.map(a => [a.id, a]));
  const jobs = new Map(state.jobs?.map(j => [j.id, j]));
  const entries: OfficeChatEntry[] = [];
  for (const message of state.messages ?? [])
    entries.push({
      id: `message:${message.id}`,
      timestamp: message.sentAt,
      agentId: message.fromAgentId,
      toAgentId: message.toAgentId,
      projectId: message.projectId,
      requestId: message.requestId,
      text: message.body,
      kind: 'MESSAGE',
      source: 'AGENT_MESSAGE',
      evidence: message.evidence,
      label: `${message.kind.toLowerCase().replaceAll('_', ' ')} · ${message.deliveredAt ? 'delivered' : 'delivery unconfirmed'}`,
    });
  for (const event of state.jobEvents ?? []) {
    const job = jobs.get(event.jobId);
    if (!job) continue;
    // Office-internal diagnostics stay in History, not the conversation feed — they are the
    // office's bookkeeping, not anything an agent said.
    if (/^(transport-evidence|observe):/.test(event.externalId)) continue;
    const text = chatEventText(event.text);
    if (!text) continue;
    entries.push({
      id: `event:${event.id}`,
      timestamp: event.receivedAt || event.occurredAt,
      agentId: assignments.get(job.assignmentId)?.agentId ?? null,
      toAgentId: null,
      projectId: job.projectId,
      requestId: job.requestId,
      text,
      kind: event.kind,
      source: 'PROVIDER_EVENT',
      evidence: event.evidence,
      label: event.kind.toLowerCase(),
    });
  }
  for (const job of jobs.values())
    entries.push({
      id: `job:${job.id}`,
      timestamp: job.updatedAt || job.createdAt,
      agentId: assignments.get(job.assignmentId)?.agentId ?? null,
      toAgentId: null,
      projectId: job.projectId,
      requestId: job.requestId,
      kind: 'STATUS',
      source: 'OFFICE_STATUS',
      evidence: job.evidence,
      label: job.state === 'UNKNOWN' ? 'Awaiting a verified update' : job.state.toLowerCase().replaceAll('_', ' '),
      text: job.state === 'INTENT' ? 'Work prepared. Waiting to start.' : job.detail,
    });
  const scoped = entries.filter(
    e =>
      (!query.projectId || e.projectId === query.projectId) &&
      (!query.requestId || e.requestId === query.requestId) &&
      (!query.agentId || e.agentId === query.agentId || e.toAgentId === query.agentId),
  );
  scoped.sort((a, b) =>
    a.timestamp === b.timestamp ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.timestamp < b.timestamp ? 1 : -1,
  );
  const eligible = before
    ? scoped.filter(e => e.timestamp < before!.timestamp || (e.timestamp === before!.timestamp && e.id < before!.id))
    : scoped;
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  const page = eligible.slice(0, limit),
    last = page.at(-1);
  return {
    entries: page,
    total: scoped.length,
    nextCursor:
      eligible.length > limit && last ? JSON.stringify({ scope, timestamp: last.timestamp, id: last.id }) : null,
  };
}
