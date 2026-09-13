import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {researchFixture} from './fixtures/research-workflow';
import {EvidenceService} from '../src/main/evidence';
import {OfficeStore} from '../src/core/store';
import {ArtifactService} from '../src/main/artifacts';
import {canonicalHash} from '../src/core/canonical';
import {lineageCounters} from '../src/shared/research';

async function s8(f:Awaited<ReturnType<typeof researchFixture>>){await f.through('S7');await f.stage(false);await f.service().run({type:'adjudicate',branchId:f.branch().id,expectedRevision:f.branch().revision,followUp:false});await f.service().run({type:'advance',branchId:f.branch().id,expectedRevision:f.branch().revision});}
async function reserve(f:Awaited<ReturnType<typeof researchFixture>>){
 await f.service().run({type:'holdoutRegister',branchId:f.branch().id,name:'Synthetic sealed bytes',timezoneOffsetMinutes:0,allowancePerPeriod:1});
 const state=f.store.snapshot(),holdout=state.pipeline!.find(r=>r.kind==='HOLDOUT')!;assert.equal(holdout.kind,'HOLDOUT');
 const refit=state.pipeline!.find(r=>r.kind==='HARNESS_RECEIPT')!;assert.equal(refit.kind,'HARNESS_RECEIPT');assert.equal(refit.proof.claim.kind,'HARNESS');
 const queryArtifactId=await f.artifact([{rowId:'r1',prediction:0.5}]);
 const result=await f.service().run({type:'holdoutReserve',branchId:f.branch().id,holdoutId:holdout.holdout.id,refitHash:refit.proof.claim.outputHashes[0],queryArtifactId});
 return {reservation:result.reservation!,queryArtifactId,holdout:holdout.holdout};
}

test('independent S2 isolation, sealed S7 reports, rebuttal and S8–S10 complete through application services',async t=>{
 const f=await researchFixture(t);await f.through('S2');
 const prepared=await f.service().run({type:'prepare',branchId:f.branch().id,expectedRevision:f.branch().revision});
 const reviewer=prepared.assignments![0],evidence=new EvidenceService(f.store,f.root);
 const allowed=reviewer.research!.objectHashes[0];
 const read=await evidence.read({agentId:reviewer.agentId,objectHash:allowed,limit:5});assert.match(read.lines.join(' '),/SYNTHETIC_KNOWN_ANSWER/);
 const forbidden=f.store.snapshot().assignments!.find(a=>a.research?.stage==='S1')!.research!.objectHashes[0];
 await assert.rejects(evidence.read({agentId:reviewer.agentId,objectHash:forbidden}),/scope|grant|available|permitted/i);
 await assert.rejects(evidence.query({agentId:reviewer.agentId,projectId:f.project.id,pattern:'input',objectHashes:[forbidden]}));
 const resumed=await f.service().run({type:'prepare',branchId:f.branch().id,expectedRevision:f.branch().revision});assert.equal(resumed.assignments![0].id,reviewer.id);assert.equal(f.counters.reviews,1);
 await f.through('S7');
 const round=await f.service().run({type:'prepare',branchId:f.branch().id,expectedRevision:f.branch().revision});
 assert.notEqual(round.assignments![0].research!.isolatedContextId,round.assignments![1].research!.isolatedContextId);
 assert.deepEqual(round.assignments![0].research!.objectHashes,round.assignments![1].research!.objectHashes);
 const [a,b]=round.assignments!;
 await f.controller.dispatch(a.id);await f.controller.observe(a.id);await f.service().run({type:'collect',assignmentId:a.id});
 assert.equal(f.store.snapshot().pipeline!.filter(r=>r.kind==='REVIEW_REPORT'&&r.stage==='S7'&&r.opened).length,0);
 await assert.rejects(f.service().run({type:'rebuttal',assignmentId:a.id}),/both first reports/i);
 await assert.rejects(f.service().run({type:'adjudicate',branchId:f.branch().id,expectedRevision:f.branch().revision,followUp:false}));
 await f.controller.dispatch(b.id);await f.controller.observe(b.id);await f.service().run({type:'collect',assignmentId:b.id});
 await f.service().run({type:'rebuttal',assignmentId:a.id});await f.service().run({type:'rebuttal',assignmentId:a.id});assert.equal(f.counters.rebuttals,1);
 await f.service().run({type:'adjudicate',branchId:f.branch().id,expectedRevision:f.branch().revision,followUp:false});
 await f.service().run({type:'advance',branchId:f.branch().id,expectedRevision:f.branch().revision});
 const r=await reserve(f),before=f.custody.journal().length;
 const action={type:'holdoutEvaluate',branchId:f.branch().id,reservationId:r.reservation.id,queryArtifactId:r.queryArtifactId};
 await f.service().run(action);await f.service().run(action);assert.equal(f.counters.custody,1);assert.ok(f.custody.journal().length>before);
 await f.custody.evaluate(r.reservation,r.holdout,[{rowId:'r1',prediction:0.5}]);assert.equal(f.counters.custody,1);
 await f.stage();assert.equal(f.branch().stage,'S9');
 const predictionId=randomUUID(),forecastFor=new Date(Date.parse(f.now())+10000).toISOString();
 const scope={schemaVersion:1,branchId:f.branch().id,specId:f.specId(),candidateHash:f.subjectHash};
 const pred=await f.artifact({...scope,kind:'PREDICTIONS',predictions:[{id:predictionId,branchId:f.branch().id,specId:f.specId(),candidateHash:f.subjectHash,symbol:'SYNTH',recordedAt:f.now(),forecastFor,prediction:1,horizonSeconds:10}]});
 await f.service().run({type:'shadowIngest',branchId:f.branch().id,expectedRevision:f.branch().revision,artifactId:pred});
 assert.equal(f.store.snapshot().pipeline!.filter(r=>r.kind==='MONITOR_VERDICT').at(-1)!.outcome,'INCONCLUSIVE');
 f.advanceTime(11000);
 const obs=await f.artifact({...scope,kind:'OBSERVATIONS',quotes:[{symbol:'SYNTH',at:forecastFor,bid:1,ask:1.01,source:'synthetic'}],fills:[{predictionId,symbol:'SYNTH',at:forecastFor,quantity:1,price:1.01,kind:'SIMULATED',provenance:'synthetic'}],outcomes:{[predictionId]:0.5}});
 await f.service().run({type:'shadowIngest',branchId:f.branch().id,expectedRevision:f.branch().revision,artifactId:obs});
 const count=f.store.snapshot().pipeline!.length;await f.service().run({type:'shadowIngest',branchId:f.branch().id,expectedRevision:f.branch().revision,artifactId:obs});assert.equal(f.store.snapshot().pipeline!.length,count);
 await f.stage();assert.equal(f.branch().stage,'S10');await f.stage(false);
 const output=path.join(f.root,'research.zip');await new ArtifactService(f.store,f.root).exportResearch(f.branch().id,output);assert.ok(readFileSync(output).length>100);
 const state=f.store.snapshot();assert.ok(state.pipeline!.some(r=>r.kind==='HARNESS_RECEIPT'&&r.verification==='LOCAL_FIXTURE'));assert.equal(state.pipeline!.some(r=>r.kind==='HARNESS_RECEIPT'&&r.verification==='HOSTED'),false);
 const tip=f.store.lineageTip();f.store.close();const reopened=new OfficeStore(path.join(f.root,'workspace.sqlite'),{researchTrust:[f.pin]});try{assert.deepEqual(reopened.lineageTip(),tip);assert.equal(reopened.snapshot().branches![0].stage,'S10');assert.ok(reopened.researchPage({projectId:f.project.id,kind:'pipeline',limit:2}).nextCursor);}finally{reopened.close();}
});

test('lost independent response reconciles once, while signatures and operation scope cannot be forged',async t=>{
 const f=await researchFixture(t);f.loseHarness();
 await assert.rejects(f.stage(false),/lost response/);assert.equal(f.counters.harness,1);
 const a=f.store.snapshot().assignments![0];
 await f.service().run({type:'collect',assignmentId:a.id});await f.service().run({type:'collect',assignmentId:a.id});assert.equal(f.counters.harness,1);
 const receipt=f.store.snapshot().pipeline!.find(r=>r.kind==='HARNESS_RECEIPT')!;assert.equal(receipt.kind,'HARNESS_RECEIPT');
 assert.throws(()=>f.store.verifyResearchClaim({...receipt.proof,claim:{...receipt.proof.claim,subjectHash:'a'.repeat(64)}}),/signature/);
 assert.throws(()=>f.store.verifyResearchClaim({...receipt.proof,claim:{...receipt.proof.claim,harnessHash:'b'.repeat(64)}}),/pinned/);
 const page=f.store.researchPage({projectId:f.project.id,kind:'pipeline',limit:1});assert.ok(page.nextCursor);
 assert.throws(()=>f.store.researchPage({projectId:randomUUID(),kind:'pipeline',cursor:page.nextCursor!}),/scope/);
 assert.throws(()=>f.store.recordPipeline({...receipt,id:randomUUID()}),/atomic/);
});

test('a correctness defect suspends the lineage and disagreement consumes one follow-up durably',async t=>{
 const f=await researchFixture(t);await f.through('S7');f.setDefect(true);await f.stage(false);
 await f.service().run({type:'adjudicate',branchId:f.branch().id,expectedRevision:f.branch().revision,followUp:false});assert.equal(f.branch().outcome,'SUSPENDED');
 await assert.rejects(f.service().run({type:'advance',branchId:f.branch().id,expectedRevision:f.branch().revision}));
 const g=await researchFixture(t);await g.through('S7');g.setOpposes(true);await g.stage(false);
 await g.service().run({type:'adjudicate',branchId:g.branch().id,expectedRevision:g.branch().revision,followUp:true});
 assert.equal(lineageCounters(g.store.snapshot(),g.branch().lineageId).followUpAllowanceRemaining,0);
 const before=g.store.lineageTip();await assert.rejects(g.service().run({type:'adjudicate',branchId:g.branch().id,expectedRevision:g.branch().revision-1,followUp:true}));assert.deepEqual(g.store.lineageTip(),before);
});

test('manual custody return remains user-attested and cannot satisfy independent S8',async t=>{
 const f=await researchFixture(t);await s8(f);const r=await reserve(f);
 await f.service().run({type:'holdoutExport',branchId:f.branch().id,reservationId:r.reservation.id});assert.ok(f.writes.has('export'));
 const artifactId=await f.artifact({reservationId:r.reservation.id,candidateHash:f.subjectHash,refitHash:r.reservation.refitHash,queryHash:r.reservation.queryHash,result:{metric:'synthetic',value:0.5,samples:1,detail:'Manual synthetic return'}});
 await f.service().run({type:'holdoutImport',branchId:f.branch().id,reservationId:r.reservation.id,artifactId});
 await f.service().run({type:'holdoutImport',branchId:f.branch().id,reservationId:r.reservation.id,artifactId});
 await assert.rejects(f.stage(false),/isolated custody report/);
 const journal=path.join(f.root,'custodian','journal.jsonl'),lines=readFileSync(journal,'utf8').trim().split('\n');writeFileSync(journal,lines.slice(0,-1).join('\n')+'\n');assert.throws(()=>f.custody.journal(),/truncated/);
});
