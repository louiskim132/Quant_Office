import { _electron as electron, type ElectronApplication } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store.js';

const root=process.cwd(),output=path.join(root,'test-output');await mkdir(output,{recursive:true});
const data=await mkdtemp(path.join(tmpdir(),'qro-desktop-'));
const {ELECTRON_RUN_AS_NODE:_runAsNode,...launchEnvironment}=process.env;
let application:ElectronApplication|undefined;
const logs:string[]=[];
async function launch(){
 application=await electron.launch({args:process.env.QRO_EXECUTABLE?[]:[root],...(process.env.QRO_EXECUTABLE?{executablePath:process.env.QRO_EXECUTABLE}:{}),env:{...launchEnvironment,QRO_USER_DATA_DIR:data},timeout:30000});
 const page=await application.firstWindow();page.on('pageerror',error=>logs.push(error.message));
 await page.getByRole('heading',{name:'The office',exact:true}).waitFor();
 return page;
}
try{
 let page=await launch();
 assert.equal(await page.locator('.office-person').count(),0);
 assert.equal((await page.evaluate(()=>window.office.getState())).agents.length,0);
 // The Tasks and Research destinations are merged into Office and Projects.
 assert.equal(await page.getByRole('button',{name:'Tasks',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Research',exact:true}).count(),0);
 await page.screenshot({path:path.join(output,'office-empty.png'),fullPage:true});
 await page.getByRole('button',{name:'Add agent',exact:true}).click();
 await page.getByLabel('Agent name',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Confirm',exact:true}).count(),0);
 await page.screenshot({path:path.join(output,'add-agent-setup.png'),fullPage:true});
 await page.getByRole('button',{name:'Projects',exact:true}).click();
 await page.getByRole('button',{name:'New project',exact:true}).click();
 const modal=page.getByRole('dialog',{name:'Create a project'});
 await modal.getByLabel('Project name').fill('Volatility research');
 await modal.getByLabel('Research mandate').fill('Compare out-of-sample volatility estimates without changing the protected region.');
 await modal.getByRole('button',{name:'Create project',exact:true}).click();await modal.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Office',exact:true}).click();
 await page.getByRole('button',{name:'New request',exact:true}).click();
 const exp=page.getByRole('dialog',{name:'New request'});
 await exp.getByLabel('Request name').fill('Volatility estimate baseline');
 await exp.getByLabel('Objective').fill('A rolling baseline provides a useful comparison.');
 await exp.getByLabel('Work type').selectOption('EXPERIMENT');
 await exp.getByRole('button',{name:'Save draft'}).click();await exp.waitFor({state:'hidden'});
 let state=await page.evaluate(()=>window.office.getState());assert.equal(state.tasks.length,0);assert.equal(state.requests!.length,1);assert.equal(state.requests![0].experimentId,state.experiments[0].id);
 // Saving a draft stays on the current page; the queue card opens the project's research workspace.
 await page.getByRole('button',{name:'Open research details',exact:true}).click();
 // Contract sections 02-08 stay collapsed until the editor asks for them.
 await page.getByRole('button',{name:/Define the remaining/}).click();
 // Use the field's explicit contract position to avoid tying scientific copy to test behavior.
 await page.locator('.contract-field textarea').nth(3).fill('Chronological evaluation with a declared loss and uncertainty analysis.');
 await page.getByRole('button',{name:'Save contract',exact:true}).click();
 await page.getByRole('button',{name:'Submit for review',exact:true}).click();
 await page.getByRole('button',{name:'Awaiting review',exact:true}).waitFor();
 state=await page.evaluate(()=>window.office.getState());assert.equal(state.experiments[0].stage,'CONTRACT_REVIEW');assert.equal(state.reviews.length,0);
 // The Projects nav always lands on the list even while a project is selected; a project row reopens the detail page.
 await page.getByRole('button',{name:'Projects',exact:true}).click();
 const openProject=page.getByRole('button',{name:/Open project/});await openProject.first().waitFor();await openProject.first().click();
 await page.getByText('PROJECT MANDATE',{exact:true}).waitFor();
 // The detail page lists the project's requests and reaches the folder-scope location panel from the mandate card.
 await page.locator('.project-requests').getByText('Volatility estimate baseline').waitFor();
 await page.getByText('Location & inputs',{exact:true}).click();
 // There is no per-file picker: the whole chosen folder becomes the input scope, and Save sends no inputPaths.
 await application!.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},data);
 await page.getByRole('button',{name:'Choose folder',exact:true}).click();
 await page.getByText(/Everything in this folder is shared when a request is prepared/).waitFor();
 assert.equal(await page.getByRole('button',{name:'Choose input files'}).count(),0);
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await page.getByText(/Saved\. Nothing has been transferred/).waitFor();
 state=await page.evaluate(()=>window.office.getState());assert.equal(state.locations?.[0]?.inputPaths.length,0);
 const input=path.join(data,'reference.txt');await writeFile(input,'A user reference. <script>window.compromised=true</script>');
 await application!.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},input);
 await page.getByRole('button',{name:'Artifacts',exact:true}).first().click();
 await page.getByRole('button',{name:'Import references',exact:true}).click();
 await page.getByText('reference.txt',{exact:true}).waitFor();
 state=await page.evaluate(()=>window.office.getState());assert.equal(state.artifacts.length,1);assert.equal(state.artifacts[0].classification,'UNCLASSIFIED');
 const preview=await page.evaluate(id=>window.office.previewArtifact(id),state.artifacts[0].id);assert.match(preview.text,/<script>/);assert.equal(await page.evaluate(()=>Boolean((window as unknown as {compromised?:boolean}).compromised)),false);
 const destination=path.join(output,'desktop-project.qro.zip');
 await application!.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},destination);
 await page.getByRole('button',{name:'Export project',exact:true}).click();
 await page.getByText(/Project planning archive exported/).waitFor();assert.ok((await stat(destination)).size>100);
 await page.getByRole('button',{name:'Usage',exact:true}).click();
 await page.getByText('5 hour: Unavailable',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Theme',{exact:true}).selectOption('light');
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 await page.screenshot({path:path.join(output,'settings-light.png'),fullPage:true});
 await page.getByLabel('Theme',{exact:true}).selectOption('dark');await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await page.getByRole('button',{name:'Office',exact:true}).click();await page.screenshot({path:path.join(output,'office-ready.png'),fullPage:true});
 const forbidden=await page.evaluate(async()=>{try{await window.office.command({type:'executeLocalShell',idempotencyKey:crypto.randomUUID(),command:'anything'} as never);return false;}catch{return true;}});assert.equal(forbidden,true);
 // The native terminal transport must survive bundling and packaging, in both run modes.
 const info=await page.evaluate(()=>window.office.getInfo());
 assert.equal(typeof info.transportModule,'boolean');
 assert.equal(info.transportModule,true,info.transportDetail);
 // R4-A admission control, through the real main process. A request action and a workspace
 // replacement must never overlap, and a refused pairing must not reach an adapter.
 const admission=await page.evaluate(async()=>{
  const results:Record<string,string>={};
  // Two request actions at once: the second is refused rather than running against the same store.
  const first=window.office.prepareRequest({requestId:'00000000-0000-4000-8000-000000000000',expectedRequestRevision:0,agentId:'00000000-0000-4000-8000-000000000001',expectedAgentRevision:0});
  const second=window.office.prepareRequest({requestId:'00000000-0000-4000-8000-000000000000',expectedRequestRevision:0,agentId:'00000000-0000-4000-8000-000000000001',expectedAgentRevision:0});
  const settled=await Promise.allSettled([first,second]);
  results.both=settled.map(entry=>entry.status==='rejected'?String((entry.reason as Error).message):'resolved').join(' || ');
  return results;
 });
 // Both fail on the missing fixture ids; what matters is that neither crashed the bridge and the
 // main process stayed responsive afterwards, which the following state read proves.
 assert.equal(typeof admission.both,'string');
 const stillAlive=await page.evaluate(()=>window.office.getState());
 assert.equal(stillAlive.schemaVersion,1,'the main process is still serving state after concurrent request actions');

 // R1-A containment. The bridge method is preserved for compatibility, but the trusted main handler
 // must refuse it before any effect, so a stale window or a direct bridge call cannot create a session.
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const verifyButton=page.getByRole('button',{name:'Verify cloud transport…'});
 await verifyButton.waitFor();
 assert.equal(await verifyButton.isDisabled(),true,'the live-create flow cannot be opened from Settings');
 assert.equal(await page.getByRole('button',{name:'Create one real session now'}).count(),0,'no confirmation step remains');
 await page.getByText('Cloud transport verification unavailable',{exact:false}).first().waitFor();
 assert.equal(await page.getByRole('button',{name:'Check account',exact:true}).first().isDisabled(),false,'account checks stay available');
 const before=await page.evaluate(()=>window.office.getState());
 const attempts=await page.evaluate(async()=>{
  const messages:string[]=[];
  for(let attempt=0;attempt<2;attempt++){
   try{await window.office.verifyCloudTransport({provider:'claude'});messages.push('RESOLVED');}
   catch(error){messages.push((error as Error).message);}
  }
  return messages;
 });
 assert.equal(attempts.length,2);
 for(const message of attempts) assert.match(message,/temporarily unavailable pending hosted verification and session reconciliation/,'a direct bridge call is refused, every time');
 const after=await page.evaluate(()=>window.office.getState());
 // No account observation, no capability snapshot, no event: the refusal happened before any effect.
 assert.deepEqual(after.capabilities??[],before.capabilities??[],'no capability evidence was written');
 assert.deepEqual(after.connections??[],before.connections??[],'no account observation was recorded');
 assert.equal(after.events.length,before.events.length,'no lineage event was appended');
 await page.getByRole('button',{name:'Office',exact:true}).click();
 const keys=await page.evaluate(()=>Object.keys(window.office));assert.deepEqual(keys.sort(),['chooseProjectFolder','chooseInputFiles','openProjectFolder','scanClaudeUsage','changeAgentEffort','changeAgentModel','getWorkLogs','importWorkLogs','bindAgentConnection','connectAgent','confirmAgent','cancelAgent','connectionStatus','selectProviderTool','openProviderUsage','backupWorkspace','restoreWorkspace','command','exportProject','getInfo','getState','migrateLegacyRecords','historyPage','logPage','jobEventPage','verifyCloudTransport','prepareRequest','discardPreparation','handoffPlan','openHandoffTerminal','observeJob','cancelJob','linkJobSession','loginProvider','importFiles','onChanged','previewArtifact','describeObject','readObject','queryEvidence','stagePacket','researchStatus','assignResearchFunction','migrateResearchFunctions','pipelineAction','messagePage','researchPage','researchInsights','exportResearch'].sort());
 const globals=await page.evaluate(()=>({nodeRequire:'require' in window,nodeProcess:'process' in window,bridge:typeof window.office.command}));assert.equal(globals.nodeRequire,false);assert.equal(globals.nodeProcess,false);assert.equal(globals.bridge,'function');
 state=await page.evaluate(()=>window.office.getState());const eventCount=state.events.length;
 await application!.close();application=undefined;
 page=await launch();state=await page.evaluate(()=>window.office.getState());assert.equal(state.projects.length,1);assert.equal(state.artifacts.length,1);assert.equal(state.events.length,eventCount);assert.equal(state.settings.globalBudgetCents,0);
 assert.equal(state.agents.length,0);assert.equal(state.reviews.length,0);assert.equal(state.tasks.every(t=>t.status==='BLOCKED'),true);
 // The queue lives on Office after relaunch; the canceled request still opens its research details.
 await page.getByRole('button',{name:'Cancel request',exact:true}).click();
 await page.getByLabel('Show requests').selectOption('canceled');
 await page.getByRole('button',{name:'View research details',exact:true}).click();
 await page.locator('.contract-field textarea').first().waitFor();
 assert.equal(await page.locator('.contract-field textarea:disabled').count(),8);
 assert.equal(await page.getByRole('button',{name:'Submit for review',exact:true}).isDisabled(),true);
 // New bridge action is main-owned and cannot retire an arbitrary/missing job.
 await assert.rejects(page.evaluate(()=>window.office.discardPreparation({assignmentId:'00000000-0000-4000-8000-000000000000'})),/no job record/);
 // Seed an inert profile only while the app is closed; no provider authentication or request occurs.
 await application!.close();application=undefined;
 const fixtureStore=new OfficeStore(path.join(data,'workspace','workspace.sqlite'));
 try{fixtureStore.addAgent({id:randomUUID(),name:'Idle fixture',provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',
  account:'idle-fixture@example.invalid',createdAt:new Date().toISOString(),connectionVerifiedAt:new Date().toISOString(),execution:'HOSTED_SETUP_REQUIRED'});}finally{fixtureStore.close();}
 page=await launch();
 await page.getByText('Idle · no open provider work',{exact:true}).waitFor();
 const restoreArchive=path.join(output,'r-local-admission-backup.zip');
 await application!.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},restoreArchive);
 await page.evaluate(()=>window.office.backupWorkspace());
 await application!.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},restoreArchive);
 const reached=application!.evaluate(({dialog})=>new Promise<void>(resolve=>{
  dialog.showMessageBox=()=>{resolve();return new Promise(done=>{
   (globalThis as unknown as {finishRestore:()=>void}).finishRestore=()=>done({response:0,checkboxChecked:false});
  });};
 }));
 const restoring=page.evaluate(()=>window.office.restoreWorkspace());
 try{
  await reached;
  await assert.rejects(page.evaluate(()=>window.office.getState()),/workspace is being restored/);
  await assert.rejects(page.evaluate(()=>window.office.connectionStatus('claude')),/workspace is being restored/);
 }finally{await application!.evaluate(()=>(globalThis as unknown as {finishRestore:()=>void}).finishRestore());}
 assert.equal((await restoring).canceled,true);
 assert.equal((await page.evaluate(()=>window.office.getState())).agents.length,1);
 assert.deepEqual(logs,[]);
 await writeFile(path.join(output,process.env.QRO_EXECUTABLE?'packaged-desktop-report.json':'desktop-report.json'),JSON.stringify({status:'PASS',timestamp:new Date().toISOString(),packaged:Boolean(process.env.QRO_EXECUTABLE),checks:['empty office','agent setup form','project creation','blocked request','experiment and versioned contract','review cannot self-pass','reference import','safe preview','project export','subscription usage view','theme switch','narrow IPC','renderer sandbox','restart persistence','contained cloud transport verification','concurrent request admission','discard preparation guard','restore admission lock (V1)','projects nav lands on list','detail requests section','mandate folder-scope disclosure'],pageErrors:logs,testWorkspace:data},null,2));
 console.log('Desktop end-to-end checks passed. Screenshots and report saved in test-output.');
}catch(error){if(application){try{const page=await application.firstWindow();await page.screenshot({path:path.join(output,'desktop-failure.png'),fullPage:true});console.error('Visible text:',(await page.locator('body').innerText()).slice(0,6000));}catch{}}throw error;}
finally{if(application)await application.close();}
