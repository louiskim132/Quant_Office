import type {AppState, JobOutput, ProviderJob} from '../shared/types';
import {latestJobFor} from '../core/jobs';

/** One stored job output row: the bytes the office fetched, hash-checked and durably stored. */
export interface StoredJobOutputRow {
 jobId:string;
 assignmentId:string;
 path:string;
 bytes:number;
 sha256:string;
}
/** One hop of stored outputs — a minted pipeline hop, or a direct dispatch's assignment. */
export interface JobOutputHop {
 /** The minted pipelineKey for pipeline hops; the assignment id for a direct dispatch. */
 key:string;
 pipelineKey:string|null;
 agentId:string;
 agentName:string;
 outputs:StoredJobOutputRow[];
}
export interface RequestJobOutputs {
 requestId:string;
 requestName:string;
 hops:JobOutputHop[];
}

type JobOutputState = Pick<AppState,'jobs'|'assignments'|'requests'|'agents'>;

const agentName = (state:JobOutputState, agentId:string) =>
 state.agents?.find(a=>a.id===agentId)?.name ?? `profile ${agentId.slice(0,8)}`;

/**
 * Every stored job output in one project, grouped request → hop.
 *
 * Only `stored` outputs appear: the office fetched those bytes, hash-checked them and keeps them
 * durably — an output the adapter merely reported is never listed. Identical bytes at the same
 * path reported by more than one job (a retry storing the same file again) collapse to one row
 * under the first job that carried them.
 */
export function projectJobOutputs(state:JobOutputState, projectId:string):RequestJobOutputs[] {
 const assignments=new Map((state.assignments??[]).map(a=>[a.id,a]));
 const requests=new Map((state.requests??[]).map(r=>[r.id,r]));
 const seen=new Set<string>();
 const groups=new Map<string,RequestJobOutputs>();
 for(const job of state.jobs??[]){
  if(job.projectId!==projectId)continue;
  const assignment=assignments.get(job.assignmentId);
  for(const output of job.outputs??[]){
   if(!output.stored)continue;
   const dedupKey=`${output.sha256} ${output.path}`;
   if(seen.has(dedupKey))continue;
   seen.add(dedupKey);
   const group=groups.get(job.requestId)??{requestId:job.requestId,requestName:requests.get(job.requestId)?.name??'Removed request',hops:[]};
   groups.set(job.requestId,group);
   const hopKey=assignment?.pipelineKey??job.assignmentId;
   let hop=group.hops.find(h=>h.key===hopKey);
   if(!hop){hop={key:hopKey,pipelineKey:assignment?.pipelineKey??null,agentId:assignment?.agentId??'',agentName:agentName(state,assignment?.agentId??''),outputs:[]};group.hops.push(hop);}
   hop.outputs.push({jobId:job.id,assignmentId:job.assignmentId,path:output.path,bytes:output.bytes,sha256:output.sha256});
  }
 }
 const requestOrder=(id:string)=>requests.get(id)?.createdAt??'';
 return [...groups.values()]
  .sort((a,b)=>requestOrder(a.requestId).localeCompare(requestOrder(b.requestId))||a.requestId.localeCompare(b.requestId))
  .map(group=>({...group,hops:group.hops.map(hop=>({...hop,outputs:[...hop.outputs].sort((a,b)=>a.path.localeCompare(b.path))}))}));
}

/** Hop keys that carry review work rather than production: cross-critiques, falsification, bounded responses and verification. */
const REVIEW_HOP=/critique|falsif|response|verif/;

export interface PipelineReviewHop {
 assignmentId:string;
 pipelineKey:string;
 agentId:string;
 agentName:string;
 /** Latest recorded job state; null when the hop was minted but no job is on record yet. */
 jobId:string|null;
 state:ProviderJob['state']|null;
 detail:string;
 outputs:StoredJobOutputRow[];
}
export interface PipelineReviewGroup { requestId:string; requestName:string; hops:PipelineReviewHop[] }

/**
 * The critique, falsify, response and verify hops of a project's pipeline requests — the review
 * work a round actually performed, each with its latest recorded job state and any stored outputs
 * that can be previewed. A minted hop with no job appears as recorded-but-undispatched; nothing
 * about its state is invented.
 */
export function pipelineReviewHops(state:JobOutputState, projectId:string):PipelineReviewGroup[] {
 const requests=new Map((state.requests??[]).map(r=>[r.id,r]));
 const groups=new Map<string,PipelineReviewGroup>();
 const assignments=(state.assignments??[])
  .filter(a=>a.projectId===projectId&&a.pipelineKey&&REVIEW_HOP.test(a.pipelineKey)&&requests.get(a.requestId)?.pipeline);
 for(const assignment of assignments){
  const job=latestJobFor(state.jobs,assignment.id);
  const group=groups.get(assignment.requestId)??{requestId:assignment.requestId,requestName:requests.get(assignment.requestId)?.name??'Removed request',hops:[]};
  groups.set(assignment.requestId,group);
  group.hops.push({assignmentId:assignment.id,pipelineKey:assignment.pipelineKey!,agentId:assignment.agentId,
   agentName:agentName(state,assignment.agentId),jobId:job?.id??null,state:job?.state??null,
   detail:job?.lastObservation??job?.detail??'',
   outputs:(job?.outputs??[]).filter((o):o is JobOutput&{stored:true}=>Boolean(o.stored))
    .map(o=>({jobId:job!.id,assignmentId:assignment.id,path:o.path,bytes:o.bytes,sha256:o.sha256}))});
 }
 const requestOrder=(id:string)=>requests.get(id)?.createdAt??'';
 return [...groups.values()].sort((a,b)=>requestOrder(a.requestId).localeCompare(requestOrder(b.requestId))||a.requestId.localeCompare(b.requestId));
}
