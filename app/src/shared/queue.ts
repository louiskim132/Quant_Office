import type {AppState, ProviderJob, ResearchTask, Request} from './types.js';

export interface QueueEntry {
 id: string;
 root: ResearchTask;
 tasks: ResearchTask[];
 status: ResearchTask['status'] | 'DRAFT' | 'READY';
 request?: Request;
 active: boolean;
 canCancel: boolean;
 /** Removal from the queue is a view change on a terminal record; the record itself is retained. */
 deletable: boolean;
 /** Every job on this request, in record order. A request can carry several authorized jobs. */
 jobs?: RequestJobSummary[];
 /** What the interface may offer, derived once here so buttons and store guards cannot disagree. */
 actions?: RequestActions;
}

/** One job's canonical standing on a request, independent of any other job's outcome. */
export interface RequestJobSummary {
 jobId: string; assignmentId: string; agentId: string;
 state: ProviderJob['state']; evidence: ProviderJob['evidence'];
 externalId: string; settled: boolean; unresolved: boolean;
}

/**
 * The single allowed-actions projection.
 *
 * Every one of these mirrors a guard the main process enforces. The interface reads them so a
 * control is never offered for something that would be refused, and never hidden for something that
 * would be allowed; it is not the authority, and enabling one here authorizes nothing.
 */
export interface RequestActions {
 prepare: boolean; cancel: boolean;
 /** A preflight-blocked attempt never reached a provider, so preparing it again is safe. */
 retryPreparation: boolean;
 /** True while any job's outcome is not established, whatever a later job did. */
 awaitingReconciliation: boolean;
}

const SETTLED: ProviderJob['state'][] = ['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'];
const UNRESOLVED: ProviderJob['state'][] = ['SUBMITTING', 'ACCEPTED', 'RUNNING', 'UNKNOWN', 'CANCEL_REQUESTED'];

/**
 * Aggregates every job on a request rather than reporting the latest assignment.
 *
 * The latest assignment is not the request's state: a completed job recorded after an unknown one
 * would otherwise hide it, and an unresolved attempt is exactly what must not disappear from view.
 */
export function requestJobs(state: Pick<AppState, 'assignments' | 'jobs'>, requestId: string): RequestJobSummary[] {
 const assignments = new Map((state.assignments ?? []).filter(item => item.requestId === requestId).map(item => [item.id, item]));
 return (state.jobs ?? []).filter(job => assignments.has(job.assignmentId)).map(job => ({
  jobId: job.id, assignmentId: job.assignmentId, agentId: assignments.get(job.assignmentId)!.agentId,
  state: job.state, evidence: job.evidence, externalId: job.externalId,
  settled: SETTLED.includes(job.state), unresolved: UNRESOLVED.includes(job.state),
 }));
}

function requestActions(request: Request | undefined, jobs: RequestJobSummary[], archived: boolean): RequestActions {
 const open = request ? request.status !== 'CANCELED' : false;
 const awaitingReconciliation = jobs.some(job => job.unresolved);
 return {
  prepare: open && !archived,
  cancel: open && !archived,
  // A job still at INTENT was never dispatched, so nothing external needs reconciling before a
  // fresh attempt. Anything that reached a provider does, and is excluded here.
  retryPreparation: open && !archived && jobs.some(job => job.state === 'INTENT') && !awaitingReconciliation,
  awaitingReconciliation,
 };
}

/** One compatibility projection for legacy research groups and standalone tasks.
 * Review children never determine the lifecycle of their parent. */
export function requestQueue(state: Pick<AppState, 'tasks' | 'experiments' | 'projects' | 'requests' | 'assignments' | 'jobs'>): QueueEntry[] {
 const groups = new Map<string, ResearchTask[]>();
 for (const task of state.tasks) {
  if(task.experimentId && state.requests?.some(r=>r.experimentId===task.experimentId))continue;
  const key = task.experimentId ?? task.id;
  const group = groups.get(key) ?? [];
  group.push(task); groups.set(key, group);
 }
 const legacy:QueueEntry[] = [...groups.values()].filter(tasks=>!tasks.every(t=>t.removedAt)).map(tasks => {
  const root = tasks[0];
  const experiment = state.experiments.find(e => e.id === root.experimentId);
  const status = experiment?.stage === 'CANCELED' ? 'CANCELED' : root.status;
  const active = !['CANCELED', 'ACCEPTED', 'SUPERSEDED'].includes(status);
  return {id: root.id, root, tasks, status, active,
   canCancel: active && !state.projects.find(p => p.id === root.projectId)?.archived,
   deletable: status === 'ACCEPTED' || status === 'CANCELED'};
 });
 const current:QueueEntry[]=(state.requests??[]).filter(request=>!request.removedAt).map(request=>{
  const archived=Boolean(state.projects.find(p=>p.id===request.projectId)?.archived);
  const jobs=requestJobs(state,request.id);
  return {
   id:request.id,request,tasks:[],status:request.blockers.length?'BLOCKED':request.status,
   root:{id:request.id,projectId:request.projectId,experimentId:request.experimentId,prompt:request.objective,recipient:'WORKER',status:request.status==='CANCELED'?'CANCELED':'BLOCKED',blocker:null,createdAt:request.createdAt,updatedAt:request.updatedAt},
   // Active while the request is open or any job is still unresolved: an unknown outcome keeps the
   // work in view rather than letting a later completed job settle the whole request.
   active:request.status!=='CANCELED'||jobs.some(job=>job.unresolved),
   canCancel:request.status!=='CANCELED'&&!archived,
   // Only a terminal record leaves the queue, and an unresolved provider job outcome never does:
   // an unknown attempt is exactly what must stay in view until it is reconciled.
   deletable:request.status==='CANCELED'&&!jobs.some(job=>job.unresolved),
   jobs,actions:requestActions(request,jobs,archived),
  };
 });
 return [...legacy,...current].sort((a,b)=>a.root.createdAt.localeCompare(b.root.createdAt));
}

export interface QueueFilter {
 projectId?: string; agentId?: string; teamId?: string; search?: string;
 lifecycle?: 'ACTIVE' | 'COMPLETED' | 'CANCELED' | 'ALL';
}
export interface QueueScope { entries: QueueEntry[]; counts: { active: number; completed: number; canceled: number; all: number } }

/** Which agents a queue entry actually involves: lead, participants, and anyone assigned to it. */
export function entryAgentIds(state: Pick<AppState,'assignments'>, entry: QueueEntry): string[] {
 const request = entry.request;
 const assigned = (state.assignments ?? []).filter(item => item.requestId === entry.id).map(item => item.agentId);
 return [...new Set([...(request ? [request.leadAgentId, ...request.participantIds] : []), ...assigned].filter((id): id is string => Boolean(id)))];
}

/**
 * One filtered projection for every view. The counts describe the same scope as the rows, so a badge
 * can never disagree with the list it labels.
 */
export function queueScope(state: Pick<AppState,'tasks'|'experiments'|'projects'|'requests'|'assignments'|'agents'|'memberships'>, filter: QueueFilter = {}): QueueScope {
 const search = (filter.search ?? '').trim().toLowerCase();
 const teamAgents = filter.teamId
  ? new Set((state.memberships ?? []).filter(item => item.teamId === filter.teamId && !item.removedAt).map(item => item.agentId))
  : null;
 const scoped = requestQueue(state).filter(entry => {
  if (filter.projectId && entry.root.projectId !== filter.projectId) return false;
  const agents = entryAgentIds(state, entry);
  if (filter.agentId && !agents.includes(filter.agentId)) return false;
  if (teamAgents && !agents.some(id => teamAgents.has(id))) return false;
  if (search) {
   const haystack = [entry.request?.name, entry.request?.objective, entry.root.prompt,
    ...agents.map(id => (state.agents ?? []).find(agent => agent.id === id)?.name)].filter(Boolean).join(' ').toLowerCase();
   if (!haystack.includes(search)) return false;
  }
  return true;
 });
 const completed = (entry: QueueEntry) => entry.status === 'ACCEPTED';
 const canceled = (entry: QueueEntry) => entry.status === 'CANCELED';
 const counts = {
  active: scoped.filter(entry => entry.active).length,
  completed: scoped.filter(completed).length,
  canceled: scoped.filter(canceled).length,
  all: scoped.length,
 };
 const lifecycle = filter.lifecycle ?? 'ALL';
 const entries = scoped.filter(entry => lifecycle === 'ALL' || (lifecycle === 'ACTIVE' ? entry.active : lifecycle === 'COMPLETED' ? completed(entry) : canceled(entry)));
 return { entries, counts };
}
