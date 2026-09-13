import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {scopeMismatches,supplyingSnapshotIds,providerReadiness,effectiveEvidence,currentConnection,CAPABILITY_EXPIRY_MS} from '../src/shared/readiness';
import type {CapabilityEvidence,CapabilityOperation,Provider} from '../src/shared/types';

function store(t:any){const s=new OfficeStore(path.join(mkdtempSync(path.join(tmpdir(),'qro-readiness-')),'workspace.sqlite'));t.after(()=>s.close());return s;}
const at=(minutes:number)=>new Date(Date.UTC(2026,8,7,12,0,0)+minutes*60000).toISOString();
const ms=(minutes:number)=>Date.parse(at(minutes));
const CLOUD:CapabilityOperation[]=['CLOUD_SUBMIT','CLOUD_OBSERVE','CLOUD_OUTPUT_FETCH','CLOUD_CANCEL_REQUEST','CLOUD_CANCEL_ACK','MODEL_APPLICATION','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY','DELEGATION_CONTROL','TOOL_CONFINEMENT'];
const seen=(operation:CapabilityOperation,minutes:number,extra:Partial<CapabilityEvidence>={}):CapabilityEvidence=>
 ({operation,level:'ACCOUNT_VERIFIED',detail:'Exercised.',evidence:'OBSERVED',verifiedAt:at(minutes),source:'fixture adapter',...extra});
const read=(operation:CapabilityOperation,minutes:number,level:CapabilityEvidence['level']='DOCUMENTED'):CapabilityEvidence=>
 ({operation,level,detail:'Reference material only.',evidence:'DOCUMENTED',verifiedAt:at(minutes),source:'docs'});
/** A metadata-only account check: it exercises sign-in and nothing else. */
function metadata(minutes:number,overrides:Record<string,unknown>={}){
 return {provider:'claude' as Provider,identity:'researcher@example.com',credentialContext:'claude-code-cli',state:'SIGNED_IN' as const,allowance:[],note:'',
  toolVersion:'2.1.236',transport:'NONE' as const,environment:'',models:[{id:'opus',name:'Opus'}],
  operations:[seen('ACCOUNT_STATUS',minutes),read('MODEL_CATALOG',minutes,'TOOL_SUPPORTED'),...CLOUD.map(operation=>read(operation,minutes,'UNKNOWN'))],
  source:'claude auth status',observedAt:at(minutes),...overrides};
}
/** A transport check that actually exercised every hosted operation for one model. */
function verifiedCloud(minutes:number,model='opus',overrides:Record<string,unknown>={}){
 return metadata(minutes,{transport:'OFFICIAL_CLI_TERMINAL',environment:'anthropic-managed',
  operations:[seen('ACCOUNT_STATUS',minutes),seen('MODEL_CATALOG',minutes),...CLOUD.map(operation=>seen(operation,minutes,{model}))],
  source:'claude --cloud transport fixture',...overrides});
}

test('submission evidence alone never enables automatic start',t=>{
 const s=store(t);
 const state=s.recordAccountObservation(metadata(0,{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),seen('CLOUD_SUBMIT',0),...CLOUD.filter(o=>o!=='CLOUD_SUBMIT').map(o=>read(o,0,'UNKNOWN'))]}));
 const readiness=providerReadiness(state,'claude',{now:ms(0)});
 assert.equal(readiness.signedIn,true);
 assert.equal(readiness.modelChecked,true,'the catalog was actually read here');
 assert.equal(readiness.cloudChecked,false);
 assert.equal(readiness.actions.automaticStart,false);
 assert.equal(readiness.actions.observe,false);
 assert.equal(readiness.actions.requestCancellation,false);
 assert.ok(readiness.blockers.some(b=>b.startsWith('Unverified cancellation acknowledgement')));
});

test('a fully verified transport enables start, and each action still reports separately',t=>{
 const s=store(t);
 const state=s.recordAccountObservation(verifiedCloud(0));
 const readiness=providerReadiness(state,'claude',{now:ms(1),model:'opus'});
 assert.equal(readiness.cloudChecked,true);
 assert.equal(readiness.modelChecked,true);
 assert.equal(readiness.ready,true);
 assert.deepEqual(readiness.actions,{prepare:true,duplicate:true,viewTerminalHistory:true,handoff:true,automaticStart:true,observe:true,requestCancellation:true});
 assert.deepEqual(readiness.blockers,[]);
});

test('evidence for one model does not make another model runnable',t=>{
 const s=store(t);
 const state=s.recordAccountObservation(verifiedCloud(0,'opus'));
 const other=providerReadiness(state,'claude',{now:ms(1),model:'sonnet'});
 assert.equal(other.modelChecked,false);
 assert.equal(other.cloudChecked,false,'model-scoped transport evidence does not carry to a different model');
 assert.equal(other.actions.automaticStart,false);
 assert.ok(other.blockers.some(b=>b.includes('sonnet')));
 assert.equal(providerReadiness(state,'claude',{now:ms(1),model:'opus'}).ready,true);
});

test('a metadata refresh after a cloud check neither erases nor renews the transport evidence',t=>{
 const s=store(t);
 s.recordAccountObservation(verifiedCloud(0));
 const state=s.recordAccountObservation(metadata(30));
 const connection=currentConnection(state,'claude')!;
 const submit=effectiveEvidence(state,connection,'CLOUD_SUBMIT',{now:ms(30),model:'opus'})!;
 assert.equal(submit.evidence,'OBSERVED','a documented poll must not replace an observed result');
 assert.equal(submit.verifiedAt,at(0),'the original verification time is retained');
 assert.equal(providerReadiness(state,'claude',{now:ms(30),model:'opus'}).ready,true);
 // Expiry is measured from the real check, so the poll cannot extend eligibility.
 const expired=providerReadiness(state,'claude',{now:ms(0)+CAPABILITY_EXPIRY_MS+1000,model:'opus'});
 assert.equal(expired.cloudChecked,false);
 assert.equal(expired.actions.automaticStart,false);
 assert.ok(expired.blockers.some(b=>b.includes('evidence expired')));
 assert.equal(effectiveEvidence(state,connection,'CLOUD_SUBMIT',{now:ms(0)+CAPABILITY_EXPIRY_MS+1000})!.level,'ACCOUNT_VERIFIED','history stays readable after expiry');
});

test('a later observed result invalidates an earlier one; a tool upgrade discards evidence entirely',t=>{
 const s=store(t);
 s.recordAccountObservation(verifiedCloud(0));
 const revoked=s.recordAccountObservation(verifiedCloud(10,'opus',{operations:[seen('ACCOUNT_STATUS',10),seen('MODEL_CATALOG',10),
  {operation:'CLOUD_SUBMIT',level:'UNAVAILABLE',detail:'The route stopped working for this account.',evidence:'OBSERVED',verifiedAt:at(10),model:'opus',source:'fixture adapter'},
  ...CLOUD.filter(o=>o!=='CLOUD_SUBMIT').map(o=>seen(o,10,{model:'opus'}))]}));
 assert.equal(providerReadiness(revoked,'claude',{now:ms(11),model:'opus'}).cloudChecked,false);
 const upgraded=s.recordAccountObservation(verifiedCloud(20,'opus',{toolVersion:'2.3.0'}));
 const evidence=providerReadiness(upgraded,'claude',{now:ms(21),model:'opus'});
 assert.equal(evidence.cloudChecked,true,'the new tool re-verified everything itself');
 const stale=s.recordAccountObservation(metadata(40,{toolVersion:'2.4.0'}));
 const after=providerReadiness(stale,'claude',{now:ms(41),model:'opus'});
 assert.equal(after.cloudChecked,false,'evidence from an older tool version does not apply to a new one');
 assert.ok(after.blockers.some(b=>/^Unverified cloud submission( for these exact conditions)?: unknown, documented/.test(b)),'only the new tool version speaks for itself');
});

test('out-of-order and A-B-A account checks resolve to the real active context',t=>{
 const s=store(t);
 s.recordAccountObservation(metadata(0));
 s.recordAccountObservation(metadata(1,{identity:'second@example.com'}));
 assert.throws(()=>s.recordAccountObservation(metadata(0.5,{identity:'researcher@example.com'})),/superseded/i,'a result from a check that finished late is discarded');
 // A -> B -> A inside the deduplication window must still make A active again.
 const back=s.recordAccountObservation(metadata(2));
 assert.equal(currentConnection(back,'claude')!.identity,'researcher@example.com');
 assert.equal(back.connections!.length,2,'switching back reuses the original connection record');
 assert.equal(currentConnection(back,'claude')!.sequence,3);
 assert.equal(providerReadiness(back,'claude',{now:ms(2)}).identity,'researcher@example.com');
});

test('a stale account check blocks external actions but not local preparation',t=>{
 const s=store(t);
 const state=s.recordAccountObservation(verifiedCloud(0));
 const stale=providerReadiness(state,'claude',{now:ms(6),model:'opus'});
 assert.equal(stale.accountFresh,false);
 assert.equal(stale.ready,false);
 assert.equal(stale.actions.handoff,false);
 assert.equal(stale.actions.automaticStart,false);
 assert.equal(stale.actions.prepare,true);
 assert.equal(stale.actions.duplicate,true);
 assert.ok(stale.blockers.some(b=>b.includes('stale')));
});

test('unsupported delegation or applied-settings control keeps automatic start blocked',t=>{
 const s=store(t);
 for(const missing of ['DELEGATION_CONTROL','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY'] as CapabilityOperation[]){
  const one=store(t);
  const state=one.recordAccountObservation(verifiedCloud(0,'opus',{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),
   ...CLOUD.map(operation=>operation===missing?read(operation,0,'UNKNOWN'):seen(operation,0,{model:'opus'}))]}));
  const readiness=providerReadiness(state,'claude',{now:ms(1),model:'opus'});
  assert.equal(readiness.actions.automaticStart,false,`${missing} must gate automatic start`);
  assert.equal(readiness.actions.handoff,true,'a labeled handoff stays available');
 }
 assert.ok(s);
});

test('readiness is derived only from persisted records, so an unsaved check authorizes nothing',t=>{
 const s=store(t);
 assert.throws(()=>s.recordAccountObservation(verifiedCloud(0,'opus',{note:'sk-ant-api03-notpersistable'})),/credential/i);
 const readiness=providerReadiness(s.snapshot(),'claude',{now:ms(0),model:'opus'});
 assert.equal(readiness.signedIn,false);
 assert.equal(readiness.actions.automaticStart,false);
 assert.equal(readiness.connectionId,'');
 assert.equal(readiness.blockers[0],'No account check has been recorded for this provider yet.');
});

test('a skewed or future clock never resurrects transport verification',t=>{
 const s2=store(t);
 s2.recordAccountObservation(verifiedCloud(0));
 // Later, the route is observed to be gone. That is the newest observation and it stands.
 const revoked=s2.recordAccountObservation(verifiedCloud(10,'opus',{operations:[seen('ACCOUNT_STATUS',10),seen('MODEL_CATALOG',10),
  {operation:'CLOUD_SUBMIT',level:'UNAVAILABLE',detail:'The route stopped working for this account.',evidence:'OBSERVED',verifiedAt:at(10),model:'opus',source:'fixture adapter'},
  ...CLOUD.filter(o=>o!=='CLOUD_SUBMIT').flatMap(o=>o==='DELEGATION_CONTROL'
   ?[seen(o,10,{model:'opus',delegation:false}),seen(o,10,{model:'opus',delegation:true})]
   :o==='EFFORT_APPLICATION'?[seen(o,10,{model:'opus',effort:'default'})]
   :[seen(o,10,{model:'opus'})])]}));
 assert.equal(providerReadiness(revoked,'claude',{now:ms(11),model:'opus'}).cloudChecked,false);

 // A machine whose clock is behind still reads the record in recorded order, not wall-clock order.
 assert.equal(providerReadiness(revoked,'claude',{now:ms(-600),model:'opus'}).cloudChecked,false,
  'a clock set before the observations does not undo the newest one');
 // And a check stamped in the future does not make an old, superseded success current again.
 assert.equal(providerReadiness(revoked,'claude',{now:ms(60*24*365),model:'opus'}).cloudChecked,false,
  'a far-future clock expires evidence rather than reviving it');
 const expired=providerReadiness(revoked,'claude',{now:ms(60*25),model:'opus'});
 assert.equal(expired.cloudChecked,false);
 assert.ok(expired.blockers.some(b=>/expired/.test(b)),'expiry is reported, not silently treated as unverified');
});

/** Evidence exercised through one named route, so route provenance can be asserted directly. */
const routed=(operation:CapabilityOperation,minutes:number,route:'FAKE_ADAPTER'|'OFFICIAL_TERMINAL_HANDOFF'|'OFFICIAL_CLI_PTY',extra:Partial<CapabilityEvidence>={}):CapabilityEvidence=>
 ({operation,level:'ACCOUNT_VERIFIED',detail:'Exercised.',evidence:'OBSERVED',verifiedAt:at(minutes),source:'fixture adapter',model:'opus',route,...extra});
const CONFINED={tools:'Read-only fixture tools.',filesystem:'Staged directory only.',network:'No outbound network.',environment:'anthropic-managed'};
const fullScope=(route:'FAKE_ADAPTER'|'OFFICIAL_TERMINAL_HANDOFF'|'OFFICIAL_CLI_PTY',minutes:number)=>
 CLOUD.map(operation=>routed(operation,minutes,route,
  operation==='EFFORT_APPLICATION'?{effort:'default' as const}
  :operation==='DELEGATION_CONTROL'?{delegation:false}
  :operation==='TOOL_CONFINEMENT'?{confinement:CONFINED}:{}));
const scopeFor=(route:'FAKE_ADAPTER'|'OFFICIAL_TERMINAL_HANDOFF'|'OFFICIAL_CLI_PTY')=>({
 provider:'claude' as const,identity:'researcher@example.com',credentialContext:'claude-code-cli',
 toolVersion:'2.1.236',route,environment:'anthropic-managed',model:'opus',effort:'default' as const,delegation:false});

test('exercising one route does not verify another that happens to share a transport',t=>{
 const s2=store(t);
 // A terminal handoff and an automated PTY session both record OFFICIAL_CLI_TERMINAL. Doing one has
 // never established that the other works, and the recorded transport alone cannot tell them apart.
 s2.recordAccountObservation(verifiedCloud(0,'opus',{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),
  ...fullScope('OFFICIAL_TERMINAL_HANDOFF',0)]}));
 const state=s2.snapshot();
 assert.deepEqual(scopeMismatches(state,scopeFor('OFFICIAL_TERMINAL_HANDOFF'),{now:ms(1)}),[],'the route actually exercised is verified');
 const other=scopeMismatches(state,scopeFor('OFFICIAL_CLI_PTY'),{now:ms(1)});
 assert.ok(other.length>0,'the route never exercised is not');
 assert.match(other.join(' | '),/no evidence recorded for these conditions/);
});

test('a metadata-only refresh cannot redefine the environment work would run in',t=>{
 const s2=store(t);
 s2.recordAccountObservation(verifiedCloud(0,'opus',{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),
  ...fullScope('OFFICIAL_CLI_PTY',0)]}));
 // A bare sign-in check records transport NONE and an empty environment. Reading the execution scope
 // from the newest snapshot would let it silently redefine where work runs.
 const refreshed=s2.recordAccountObservation(metadata(2));
 assert.deepEqual(scopeMismatches(refreshed,scopeFor('OFFICIAL_CLI_PTY'),{now:ms(3)}),[],
  'the transport check that authorized the work still speaks for it');
 assert.equal(providerReadiness(refreshed,'claude',{now:ms(3),model:'opus'}).cloudChecked,true,
  'a metadata refresh neither erases nor renews the real transport evidence');
});

test('a future-dated observation cannot defeat the invalidation that superseded it',t=>{
 const s2=store(t);
 s2.recordAccountObservation(verifiedCloud(0,'opus',{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),
  ...fullScope('OFFICIAL_CLI_PTY',0)]}));
 // Recorded later, but stamped far in the future. Resolving by timestamp would let it outrank the
 // invalidation below and never expire, because its age is negative.
 s2.recordAccountObservation(verifiedCloud(10,'opus',{operations:[seen('ACCOUNT_STATUS',10),seen('MODEL_CATALOG',10),
  ...fullScope('OFFICIAL_CLI_PTY',60*24*365)]}));
 const revoked=s2.recordAccountObservation(verifiedCloud(20,'opus',{operations:[seen('ACCOUNT_STATUS',20),seen('MODEL_CATALOG',20),
  ...fullScope('OFFICIAL_CLI_PTY',20).map(entry=>entry.operation==='CLOUD_SUBMIT'
   ?{...entry,level:'UNAVAILABLE' as const,detail:'The route stopped working for this account.'}:entry)]}));
 const problems=scopeMismatches(revoked,scopeFor('OFFICIAL_CLI_PTY'),{now:ms(21)});
 assert.ok(problems.some(problem=>/cloud submission/.test(problem)),problems.join(' | '));
 assert.equal(providerReadiness(revoked,'claude',{now:ms(21),model:'opus'}).cloudChecked,false);
});

test('delegation policy alone never certifies that tools were actually confined',t=>{
 const s2=store(t);
 // Everything verified except the content of the confinement record. Delegation control says
 // delegation was controllable; it says nothing about tools, the filesystem or the network.
 const hollow=fullScope('OFFICIAL_CLI_PTY',0).map(entry=>entry.operation==='TOOL_CONFINEMENT'
  ?{...entry,confinement:{tools:'',filesystem:'',network:'',environment:''}}:entry);
 s2.recordAccountObservation(verifiedCloud(0,'opus',{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),...hollow]}));
 const problems=scopeMismatches(s2.snapshot(),scopeFor('OFFICIAL_CLI_PTY'),{now:ms(1)});
 assert.match(problems.join(' | '),/enforced confinement is unproven/);

 // Removing the record entirely is refused too, rather than falling back to the delegation boolean.
 const s3=store(t);
 s3.recordAccountObservation(verifiedCloud(0,'opus',{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),
  ...fullScope('OFFICIAL_CLI_PTY',0).filter(entry=>entry.operation!=='TOOL_CONFINEMENT')]}));
 assert.match(scopeMismatches(s3.snapshot(),scopeFor('OFFICIAL_CLI_PTY'),{now:ms(1)}).join(' | '),
  /Unverified tool, filesystem and network confinement/);
});

test('the exact snapshots that supplied the evidence are identifiable and survive a restart',t=>{
 const s2=store(t);
 s2.recordAccountObservation(verifiedCloud(0,'opus',{operations:[seen('ACCOUNT_STATUS',0),seen('MODEL_CATALOG',0),
  ...fullScope('OFFICIAL_CLI_PTY',0)]}));
 const first=supplyingSnapshotIds(s2.snapshot(),scopeFor('OFFICIAL_CLI_PTY'),{now:ms(1)});
 assert.equal(first.length,1,'one observation supplied every operation here');
 // A metadata refresh adds a snapshot that supplies nothing for this scope, so the set is unchanged.
 const refreshed=s2.recordAccountObservation(metadata(2));
 assert.deepEqual(supplyingSnapshotIds(refreshed,scopeFor('OFFICIAL_CLI_PTY'),{now:ms(3)}),first,
  'the set names the evidence that actually authorized the work, not merely the newest record');
 assert.equal(refreshed.capabilities!.length,2);
});
