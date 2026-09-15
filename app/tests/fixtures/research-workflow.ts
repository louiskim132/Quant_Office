import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import type {TestContext} from 'node:test';
import {fixture,declared,sha256,key,at} from './pipeline';
import {canonical,canonicalHash} from '../../src/core/canonical';
import {PipelineService,type ResearchRuntime,type PipelineIO} from '../../src/main/pipeline';
import {STAGE_FUNCTIONS_REQUIRED} from '../../src/main/research-controller';
import {STAGE_GATES,STAGES,type Stage} from '../../src/shared/research';
import {STAGE_DELIVERY,runPackageHash,runPackageId,runReturnManifestSchema,type RunPackageManifest} from '../../src/shared/run-package';
import type {SignedResearchClaim,ResearchTrustPin} from '../../src/shared/research-admission';
import type {OfficeStore} from '../../src/core/store';
import {snapshotObjectPath} from '../../src/main/locations';
import {HoldoutCustody} from '../../src/main/holdout';

/** Synthetic independent authority, separate from the provider double and its authored gates. */
export async function researchFixture(t:Pick<TestContext,'after'>){
 const keys=generateKeyPairSync('ed25519'),harnessHash=sha256('synthetic-known-answer-harness-v1');
 const pin:ResearchTrustPin={keyId:'local-test-authority',harnessHash,publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),environment:'LOCAL_FIXTURE',route:'FAKE_ADAPTER'};
 let now=Date.now();
 const f=await fixture(t,undefined,false,{researchTrust:[pin],clock:()=>new Date(now).toISOString(),shadowPolicy:true});
 const third=f.makeAgent('Skeptic',at(2));
 // A frozen request roster must include both independent reviewers before linking.
 f.store.execute({type:'request.update',idempotencyKey:key(),requestId:f.request.id,expectedRevision:f.request.revision,objective:f.request.objective,leadAgentId:f.principal.id,participantIds:[f.second.id,third.id],acceptanceCriteria:f.request.acceptanceCriteria});
 for(const stage of STAGES)for(const role of STAGE_FUNCTIONS_REQUIRED[stage]){
  const agent=role==='CORRECTNESS_REVIEWER'||role==='ADVOCATE'?f.second:role==='SKEPTIC'?third:f.principal;
  f.store.appendFunctionAssignment({id:key(),projectId:f.project.id,stage,function:role,agentId:agent.id,agentRevision:0,appendedAt:new Date(now).toISOString(),supersededById:null,origin:'EXPLICIT',note:'Synthetic acceptance appointment'});
 }
 const seal=(claim:SignedResearchClaim['claim']):SignedResearchClaim=>({claim,signature:sign(null,Buffer.from(canonical(claim)),keys.privateKey).toString('base64')});
 const common=()=>{const state=f.store.snapshot({history:false}),b=f.branch(),link=state.pipeline!.find(r=>r.kind==='LINK')!;assert.equal(link.kind,'LINK');return {version:1 as const,keyId:pin.keyId,harnessHash,issuedAt:new Date().toISOString(),projectId:f.project.id,branchId:b.id,branchRevision:b.revision,requestId:f.request.id,requestRevision:link.requestRevision,specId:f.specId(),specHash:state.specs!.find(s=>s.id===f.specId())!.contentHash,subjectHash:f.subjectHash,stage:b.stage};};
 const writes=new Map<string,Uint8Array>();
 const io:PipelineIO={selectHoldout:async()=>Buffer.from('rowId,target\nr1,0.5\n'),exportHoldout:async bytes=>{writes.set('export',bytes);},writeObject:async bytes=>{const hash=sha256(bytes),file=snapshotObjectPath(f.root,hash);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,bytes);return {sha256:hash,bytes:bytes.byteLength};}};
 const reviews=new Map<string,Awaited<ReturnType<ResearchRuntime['prepareReview']>>>(),receipts=new Map<string,SignedResearchClaim>(),responses=new Map<string,{proof:SignedResearchClaim;bytes:Uint8Array}>();
 const counters={reviews:0,harness:0,rebuttals:0,custody:0};
 let defect=false,opposes=false,loseHarness=false;
 const runtime:ResearchRuntime={
  async prepareReview(input){
   counters.reviews++;
   const body={kind:'SYNTHETIC_KNOWN_ANSWER',timing:'strictly lagged',split:'purged',subject:f.subjectHash};
   const bytes=Buffer.from(JSON.stringify(body)),object=await io.writeObject(bytes);
   const ordinary=await f.stageInputs({projectId:f.project.id,requestId:f.request.id,requestRevision:common().requestRevision,objective:'Synthetic isolated review'});
   const snapshots=input.tasks.map(()=>({...ordinary,id:key(),files:[{path:'evidence.json',sha256:object.sha256,bytes:object.bytes}],generated:[],totalBytes:object.bytes}));
   const previous=f.store.snapshot({history:false}).pipeline!.filter(r=>r.kind==='STAGE_COMPLETION'&&r.stage===(f.branch().stage==='S2'?'S1':'S6')).at(-1)!;assert.equal(previous.kind,'STAGE_COMPLETION');
   const proof=seal({...common(),kind:'ISOLATION',operationId:input.operationId,roundId:key(),subjectAssignmentId:previous.assignmentId,evidenceHash:sha256(JSON.stringify({subjectId:f.subjectHash,hashes:[object.sha256],body})),objectHashes:[object.sha256],contexts:input.tasks.map((task,index)=>({agentId:task.agentId,contextId:'isolated-'+key(),snapshotId:snapshots[index].id})),access:'EXACT_OBJECTS_ONLY',cache:'NO_INTERPRETATION_CACHE',firstReports:'SEALED',correctnessBlinded:f.branch().stage==='S2',route:'FAKE_ADAPTER',expiresAt:new Date(Date.now()+3600000).toISOString()});
   const result={proof,snapshots,body};reviews.set(input.operationId,result);return result;
  },
  async reconcileReview(id){return reviews.get(id)??null;},
  async evaluate(input){
   counters.harness++;
   assert.equal(sha256(input.reportBytes),input.reportHash);
   const context=input.assignment.research!,state=f.store.snapshot({history:false});
   // This authority evaluates a fixed synthetic known-answer contract, never provider PASS fields.
   assert.equal(JSON.parse(Buffer.from(input.reportBytes).toString()).contextHash,context.contextHash);
   for(const hash of context.objectHashes)assert.ok(await f.readObject(hash));
   const custody=state.pipeline?.find(r=>r.kind==='HOLDOUT_RESULT'),policy=state.pipeline?.find(r=>r.kind==='SHADOW_POLICY');
   const proof=seal({...common(),kind:'HARNESS',operationId:input.operationId,assignmentId:input.assignment.id,jobId:input.job.id,contextHash:context.contextHash,externalRunId:input.job.externalId!,reportHash:input.reportHash,inputHashes:context.objectHashes,outputHashes:input.job.outputs.filter(o=>o.stored).map(o=>o.sha256),gates:STAGE_GATES[context.stage].map(gate=>({gate,outcome:'PASS',detail:'Independent synthetic known-answer fixture passed.',rationale:'LOCAL_FIXTURE only; no hosted or scientific claim.'})),...(custody?.kind==='HOLDOUT_RESULT'?{custodyReportHash:custody.reportHash}:{}),...(['S9','S10'].includes(context.stage)&&policy?.kind==='SHADOW_POLICY'?{thresholdHash:policy.policy.thresholdHash,shadowEvidenceHash:canonicalHash(state.pipeline!.filter(r=>r.kind==='SHADOW_BATCH').map(r=>r.kind==='SHADOW_BATCH'?[r.sourceHash,r.createdAt]:[]))}: {})});
   receipts.set(input.operationId,proof);if(loseHarness){loseHarness=false;throw new Error('Synthetic lost response');}return proof;
  },
  async reconcileHarness(id){return receipts.get(id)??null;},
  async rebuttal(input){counters.rebuttals++;assert.equal(input.firstReports.length,2);const bytes=Buffer.from(JSON.stringify({phase:'REBUTTAL',contextHash:input.assignment.research!.contextHash,detail:'Synthetic post-disclosure response.'}));const proof=seal({...common(),kind:'REBUTTAL',operationId:input.operationId,roundId:input.assignment.research!.reviewRoundId!,assignmentId:input.assignment.id,contextId:input.assignment.research!.isolatedContextId!,firstReportHashes:input.firstReports.map(r=>r.hash).sort(),reportHash:sha256(bytes)});const result={bytes,proof};responses.set(input.operationId,result);return result;},
  async reconcileRebuttal(id){return responses.get(id)??null;}
 };
 const custody=new HoldoutCustody({sealedRoot:path.join(f.root,'custodian','sealed'),journalFile:path.join(f.root,'custodian','journal.jsonl')},{verification:'LOCAL_FIXTURE',sealedStorageSupported:true,isolatedEvaluatorSupported:true,detail:'Synthetic isolated evaluator only'}, {isolated:true,async evaluate(input){counters.custody++;assert.deepEqual(Object.keys(input).sort(),['candidateHash','predictions','sealedBytes','sealedHash']);return {reportHash:sha256('synthetic-result'),metric:'synthetic',value:0.5,samples:input.predictions.length,detail:'LOCAL_FIXTURE'};}},()=>new Date(now).toISOString());
 // The manual-run seams as test doubles: a JSON envelope stands in for the production zip codec,
 // while the store and pipeline admission paths under test run exactly as shipped.
 const packages={
  build:{async build(input:{state:ReturnType<OfficeStore['snapshot']>;branch:ReturnType<typeof f.branch>;link:Extract<import('../../src/shared/pipeline').PipelineRecord,{kind:'LINK'}>;spec:NonNullable<ReturnType<OfficeStore['snapshot']>['specs']>[number]}){
   const base:Omit<RunPackageManifest,'packageId'|'packageHash'|'exportedAt'>={schemaVersion:1,kind:'RUN_PACKAGE',projectId:input.branch.projectId,branchId:input.branch.id,branchRevision:input.branch.revision,
    specId:input.spec.id,specHash:input.spec.contentHash,subjectHash:input.link.subjectHash,requestId:input.link.requestId,requestRevision:input.link.requestRevision,
    entries:[{path:'main.py',sha256:sha256('synthetic-launcher'),bytes:18}],environment:{runtime:'COLAB_USER_RUN',detail:'Synthetic package; user runs it in Colab.'},
    expectedReturn:{files:['result.json'],requiredGates:['G-PORTFOLIO','G-COST','G-ECON']},instructions:'Open Colab, upload this package, run the launcher, return the produced bundle.'};
   const packageHash=runPackageHash(base),manifest:RunPackageManifest={...base,packageId:runPackageId(packageHash),packageHash,exportedAt:new Date(now).toISOString()};
   return {manifest,bytes:Buffer.from(JSON.stringify({kind:'QRO_RUN_PACKAGE',manifest}))};
  }},
  inspect:{inspect(input:{bytes:Uint8Array;expect:{packageId:string;packageHash:string}}){
   const manifest=runReturnManifestSchema.parse(JSON.parse(Buffer.from(input.bytes).toString('utf8')));
   if(manifest.packageId!==input.expect.packageId||manifest.packageHash!==input.expect.packageHash)throw new Error('Returned bundle names a different package.');
   return {manifest,objects:manifest.artifacts.map(a=>({path:a.path,sha256:a.sha256,bytes:Buffer.alloc(a.bytes,a.sha256.slice(0,2))})),manifestHash:sha256(input.bytes),summary:'Bound return admitted for package '+manifest.packageId+'.'};
  }},
 };
 const service=()=>new PipelineService(f.store,f.controller,custody,f.stageInputs,f.readObject,()=>new Date(now).toISOString(),runtime,io,packages);
 f.adapter.behaviour.observe=async job=>{const c=f.store.snapshot({history:false}).assignments!.find(a=>a.id===job.assignmentId)!.research!;return {state:'COMPLETED',detail:'Synthetic provider completion',outputs:[declared(JSON.stringify({schemaVersion:1,branchId:c.branchId,specId:c.specId,subjectHash:c.subjectHash,stage:c.stage,contextHash:c.contextHash,gates:[],detail:'Synthetic raw report; no self-approval.',...(['S2','S7'].includes(c.stage)?{verdict:opposes&&c.function==='SKEPTIC'?'OPPOSES':'SUPPORTS',defectFound:defect}:{})}))]};};
 await service().run({type:'link',branchId:f.branch().id,expectedRevision:f.branch().revision,requestId:f.request.id,subjectHash:f.subjectHash});
 await service().run({type:'verifySpec',branchId:f.branch().id,expectedRevision:f.branch().revision});
 await service().run({type:'advance',branchId:f.branch().id,expectedRevision:f.branch().revision});
 const returnBundle=async()=>{
  const record=f.store.snapshot().pipeline!.filter(r=>r.kind==='RUN_PACKAGE'&&r.branchId===f.branch().id&&r.branchRevision===f.branch().revision).at(-1);
  assert.ok(record&&record.kind==='RUN_PACKAGE','a run package must be exported before a return can be imported');
  const manifest={schemaVersion:1,kind:'RUN_RETURN',packageId:record.packageId,packageHash:record.packageHash,branchId:record.branchId,specId:record.specId,specHash:record.specHash,subjectHash:record.subjectHash,
   runId:'synthetic-run-'+randomUUID().slice(0,8),startedAt:new Date(now).toISOString(),finishedAt:new Date(now).toISOString(),status:'COMPLETED',
   artifacts:[{path:'result.json',sha256:sha256('synthetic-result-bytes'),bytes:22}],
   gates:[{gate:'G-PORTFOLIO',stage:'S5',outcome:'PASS',detail:'Synthetic portfolio gate passed.',rationale:'fixture'},
    {gate:'G-COST',stage:'S6',outcome:'PASS',detail:'Synthetic cost gate passed.',rationale:'fixture'},
    {gate:'G-ECON',stage:'S6',outcome:'PASS',detail:'Synthetic economics gate passed.',rationale:'fixture'}],
   failedRuns:[],detail:'Synthetic user-run return.'};
  return artifact(manifest,'return.zip');
 };
 const stage=async(advance=true)=>{
  const branch=f.branch(),delivery=STAGE_DELIVERY[branch.stage];
  if(delivery==='AGENT'){
   const result=await service().run({type:'prepare',branchId:branch.id,expectedRevision:branch.revision});
   for(const a of result.assignments!){await f.controller.dispatch(a.id);await f.controller.observe(a.id);await service().run({type:'collect',assignmentId:a.id});}
   if(advance)await service().run({type:'advance',branchId:branch.id,expectedRevision:branch.revision});
   return result.assignments!;
  }
  if(delivery==='USER_RUN'){
   await service().run({type:'exportRunPackage',branchId:branch.id,expectedRevision:branch.revision});
   const artifactId=await returnBundle();
   await service().run({type:'importRunReturn',branchId:branch.id,expectedRevision:branch.revision,artifactId});
   if(advance)await service().run({type:'advance',branchId:branch.id,expectedRevision:branch.revision});
   return [];
  }
  await service().run({type:'validateReturn',branchId:branch.id,expectedRevision:branch.revision});
  if(advance)await service().run({type:'advance',branchId:branch.id,expectedRevision:branch.revision});
  return [];
 };
 const through=async(target:Stage)=>{while(STAGES.indexOf(f.branch().stage)<STAGES.indexOf(target))await stage();};
 const artifact=async(body:unknown,name='fixture.json')=>{const object=await io.writeObject(Buffer.from(JSON.stringify(body))),id=randomUUID();f.store.addArtifact({id,projectId:f.project.id,experimentId:null,name,sha256:object.sha256,size:object.bytes,kind:'RESULT',classification:'USER_ATTESTED',status:'QUARANTINED',createdAt:new Date(now).toISOString(),mediaType:'application/json',note:'Synthetic test artifact'});return id;};
 return {...f,third,pin,seal,common,runtime,service,custody,counters,stage,through,artifact,io,writes,advanceTime:(ms:number)=>{now+=ms;},now:()=>new Date(now).toISOString(),setDefect:(v:boolean)=>{defect=v;},setOpposes:(v:boolean)=>{opposes=v;},loseHarness:()=>{loseHarness=true;}};
}
