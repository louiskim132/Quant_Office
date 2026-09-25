import type {AppState, ProviderJob, ResearchTask, Request} from './types.js';
import { latestJobFor } from '../core/jobs.js';

export interface QueueEntry {
 id: string;
 root: ResearchTask;
 tasks: ResearchTask[];
 status: ResearchTask['status'] | 'DRAFT' | 'READY';
 request?: Request;
 active: boolean;
 /** Every recorded provider job reached a terminal outcome. Failed and canceled jobs count — a
  * settled row is finished work with a recorded outcome, not a claim of success. */
 settled: boolean;
 canCancel: boolean;
 /** Removal from the queue is a view change on a terminal record; the record itself is retained. */
 deletable: boolean;
 /** Every job on this request, in record order. A request can carry several authorized jobs. */
 jobs?: RequestJobSummary[];
 /** What the interface may offer, derived once here so buttons and store guards cannot disagree. */
 actions?: RequestActions;
}

/** One assignment's canonical standing on a request — the latest attempt's job, not any attempt's. */
export interface RequestJobSummary {
 jobId: string; assignmentId: string; agentId: string;
 state: ProviderJob['state']; evidence: ProviderJob['evidence'];
 externalId: string; settled: boolean; unresolved: boolean;
 attempt: number; lastObservation?: string;
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
export const UNRESOLVED: ProviderJob['state'][] = ['SUBMITTING', 'ACCEPTED', 'RUNNING', 'UNKNOWN', 'CANCEL_REQUESTED'];

/**
 * Aggregates the latest job of every assignment on a request rather than reporting the latest
 * assignment or every attempt.
 *
 * The latest assignment is not the request's state: a completed job recorded after an unknown one
 * would otherwise hide it, and an unresolved attempt is exactly what must not disappear from view.
 * A superseded attempt is resolved by the retry that replaced it, so only the newest attempt
 * counts toward the request's standing.
 */
export function requestJobs(state: Pick<AppState, 'assignments' | 'jobs'>, requestId: string): RequestJobSummary[] {
 return (state.assignments ?? []).filter(item => item.requestId === requestId).map((item): RequestJobSummary | undefined => {
  const job = latestJobFor(state.jobs, item.id);
  if (!job) return undefined;
  return {
   jobId: job.id, assignmentId: job.assignmentId, agentId: item.agentId,
   state: job.state, evidence: job.evidence, externalId: job.externalId,
   settled: SETTLED.includes(job.state), unresolved: UNRESOLVED.includes(job.state),
   attempt: job.attempt ?? 1, lastObservation: job.lastObservation,
  };
 }).filter((job): job is RequestJobSummary => job !== undefined);
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
  return {id: root.id, root, tasks, status, active, settled: status === 'ACCEPTED',
   canCancel: active && !state.projects.find(p => p.id === root.projectId)?.archived,
   deletable: status === 'ACCEPTED' || status === 'CANCELED'};
 });
 const current:QueueEntry[]=(state.requests??[]).filter(request=>!request.removedAt).map(request=>{
  const archived=Boolean(state.projects.find(p=>p.id===request.projectId)?.archived);
  const jobs=requestJobs(state,request.id);
  // A pipeline mints its hops in stages (brief first, arms only after confirmation), so a settled
  // job list is not the end of the work until the pipeline itself is decided.
  const workDone=jobs.length>0&&jobs.every(job=>job.settled)&&(!request.pipeline||request.pipeline.phase==='DECIDED');
  return {
   id:request.id,request,tasks:[],status:request.blockers.length?'BLOCKED':request.status,
   root:{id:request.id,projectId:request.projectId,experimentId:request.experimentId,prompt:request.objective,recipient:'WORKER',status:request.status==='CANCELED'?'CANCELED':'BLOCKED',blocker:null,createdAt:request.createdAt,updatedAt:request.updatedAt},
   // Active while the request is open and its recorded work has not all reached a terminal outcome:
   // an unknown attempt is exactly what must stay in view until it is reconciled. A canceled request
   // with an unresolved job stays in view too — the outcome is not established yet.
   settled:request.status!=='CANCELED'&&workDone,
   active:request.status==='CANCELED'?jobs.some(job=>job.unresolved):!workDone,
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
 // Completed means the recorded work finished: a legacy group at ACCEPTED, or a request whose
 // provider jobs all reached a terminal outcome. The job list, not provider self-report, is the
 // evidence — an unresolved attempt never counts as completed.
 const completed = (entry: QueueEntry) => entry.status === 'ACCEPTED' || (entry.request !== undefined && entry.settled);
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
