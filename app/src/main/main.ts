import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { mkdir,writeFile,rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OfficeStore, effortSchema } from '../core/store.js';
import { ArtifactService, MAX_TOTAL } from './artifacts.js';
import { createRunPackageCodec } from './run-package.js';
import { EvidenceService } from './evidence.js';
import { promotable, scheduleStage, STAGE_FUNCTIONS_REQUIRED } from './research-controller.js';
import { STAGE_DELIVERY } from '../shared/run-package.js';
import { migrateRolesToFunctions, resolveFunctions } from './context-policy.js';
import { stat, readFile } from 'node:fs/promises';
import { reconstructUsage } from './local-usage.js';
import { parseWorkLogs } from './work-logs.js';
import { workspaceDirectory, recoverInterruptedRestore, prepareRestore, discardCandidate, commitRestore } from './recovery.js';
import { resolveSelection, prepareInputSnapshot, reconstructSnapshot, verifySnapshotForTransfer } from './locations.js';
import { AssignmentController } from './controller.js';
import { PipelineService } from './pipeline.js';
import { HoldoutCustody } from './holdout.js';
import { OutputService } from './outputs.js';
import { TerminalHandoffAdapter } from './handoff.js';
import { LocalMailboxAdapter } from './local-session.js';
import { LocalWorktreeMailboxAdapter } from './local-worktree-session.js';
import { WORKTREES_DIR } from './local-worktree-repo.js';
import { LocalSessionRouter } from './local-session-router.js';
import { PtyCloudAdapter, transportModuleStatus } from './pty.js';
import { probeCloudTransport } from './probe.js';
import { currentConnection } from '../shared/readiness.js';
import { assertTransportProbeAllowed } from '../shared/transport.js';
import { realpathSync, existsSync, statSync } from 'node:fs';
import {calibration,compareMethods,lineageAncestry} from '../core/monitoring';
/** One place decides what a usable project root is, so dialogs and saved allowlists agree. */
function resolveSelectionRoot(root:string):string{
 if(!path.isAbsolute(root)||!existsSync(root)||!statSync(root).isDirectory())throw new Error('Choose the project folder first.');
 return realpathSync(root);
}

import { Subscriptions, providerSchema, subscriptionEnvironment } from './subscriptions.js';
let subscriptions:Subscriptions;
let win:BrowserWindow|null=null;
let store:OfficeStore;
let artifacts:ArtifactService;
let evidence:EvidenceService;
let transferBusy=false;
/** Bumped every time the workspace database is replaced. Results from an older epoch are discarded. */
let storeEpoch=0;
/** Request actions currently in flight. A workspace replacement may not begin while any are open. */
let openRequestActions=0;
/** Includes async account/metadata handlers that can commit after awaiting an official tool. */
let activeWorkspaceCalls=0;
/** Set for the whole restore lifecycle, from candidate preparation to commit. */
let workspaceLocked=false;
let controller:AssignmentController;
let pipeline:PipelineService;
let custody:HoldoutCustody;
let dispatchBusy=false;
const html=path.join(__dirname,'../renderer/index.html');
const expectedURL=pathToFileURL(html).href;
const id=z.string().uuid();
const importSchema=z.object({projectId:id,experimentId:id.nullable(),kind:z.enum(['REFERENCE','RESULT'])}).strict();
const selectedRoot=process.env.QRO_USER_DATA_DIR;
if(selectedRoot){app.setPath('userData',path.resolve(selectedRoot));}
// One stable application identity so the taskbar groups dev and packaged windows under the
// same icon rather than falling back to the Electron binary's generic one.
app.setAppUserModelId('Quant Research Office');
const hasLock=app.requestSingleInstanceLock();
if(!hasLock) app.quit();
else {
 app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
 app.whenReady().then(start).catch(error=>{
  // A schema-replay failure almost always means this build is older than the one that wrote the
  // workspace — the strict event schemas fail closed on values they do not know. Say that plainly
  // instead of dumping the raw validation issues.
  const detail=error instanceof z.ZodError
   ?'The stored workspace does not match this build’s record schema — most often because it was written by a newer version of Quant Research Office. Open it with the newer build, or restore a verified backup.\n\nYour files have not been reset.'
   :`${error instanceof Error?error.message:'Unknown startup error'}\n\nYour files have not been reset. Keep the data folder and use a compatible build or a verified backup.`;
  dialog.showErrorBox('Workspace could not be opened',detail);app.quit();});
 app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',()=>{subscriptions?.close();if(store)store.close();});
}
async function start(){
 const root=app.getPath('userData');await mkdir(root,{recursive:true});await recoverInterruptedRestore(root);const workspace=workspaceDirectory(root);await mkdir(workspace,{recursive:true});store=new OfficeStore(path.join(workspace,'workspace.sqlite'),{includeHistoryInResults:false});artifacts=new ArtifactService(store,workspace);evidence=new EvidenceService(store,workspace);
 subscriptions=new Subscriptions(path.join(root,'connections'),url=>shell.openExternal(url));
 // The interim transport is the labeled handoff. Automatic dispatch stays gated on verified evidence.
 controller=buildController();
 // Custody lives outside the workspace tree so no backup or restore can reach it. This build has no
 // isolated evaluator, which the capability states honestly and which keeps S8 reservations refused.
 custody=buildCustody(root,workspace);
 pipeline=buildPipeline();
 // Interrupted work is reconciled before the window opens; a crash never resubmits or invents an outcome.
 try{await controller.reconcile();}catch{}
 session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
  // No renderer network or live content. Future provider transport belongs in guarded main-process adapters.
  callback({cancel:!details.url.startsWith('file:') && !details.url.startsWith('devtools:') && !details.url.startsWith('data:')});
 });
  // The .ico keeps window and taskbar pinned to the same artwork the packager embeds in the exe;
 // the .png remains for platforms without multi-size ico support.
 const appIcon=path.join(__dirname,process.platform==='win32'?'../assets/icon.ico':'../assets/icon.png');
 win=new BrowserWindow({width:1440,height:1000,minWidth:1050,minHeight:720,title:'Quant Research Office',backgroundColor:'#101414',show:false,autoHideMenuBar:true,icon:appIcon,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged}});
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Office',submenu:[{label:'Quit',role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',event=>event.preventDefault());
 win.webContents.on('will-attach-webview',event=>event.preventDefault());
 win.on('close',event=>{if(transferBusy){event.preventDefault();void dialog.showMessageBox(win!,{type:'info',message:'A file transfer is still being finalized.',detail:'Please wait for the transfer to finish before closing the office.'});}});
 win.on('closed',()=>{win=null;});
 register();await win.loadFile(html);win.show();
}
function register(){
 const handle=(channel:string,fn:(value:unknown)=>unknown|Promise<unknown>)=>ipcMain.handle(channel,async(event,value)=>{
  let admitted=false;
  try {
   if(!win || event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || event.senderFrame.url!==expectedURL) throw new Error('Request is not from the trusted desktop window.');
   if(workspaceLocked)throw new Error('The workspace is being restored. Wait for restoration to finish.');
   // Restore itself owns the lock. Every other handler, including account observations and reads,
   // holds admission until its asynchronous continuation has finished using this workspace.
   if(channel!=='office:restore'){activeWorkspaceCalls++;admitted=true;}
   const result=await fn(value);
   const publicResult=result&&typeof result==='object'&&'schemaVersion' in result&&'projects' in result
     ?OfficeStore.publicState(result as import('../shared/types').AppState)
     :result&&typeof result==='object'&&'state' in result&&result.state&&typeof result.state==='object'&&'schemaVersion' in result.state&&'projects' in result.state?{...result,state:OfficeStore.publicState((result as {state:import('../shared/types').AppState}).state)}:result;
   return {ok:true,value:publicResult};
  } catch(error){return {ok:false,error:error instanceof z.ZodError?'Invalid desktop request. Check the selected project and values.':error instanceof Error?error.message:'The request failed.'};}
  finally{if(admitted)activeWorkspaceCalls--;}
 });
const changed=()=>win?.webContents.send('office:changed');
 handle('office:claude-local-usage',async value=>{const chooseFolder=z.boolean().parse(value);return transfer(async()=>{let folder=path.join(process.env.USERPROFILE||app.getPath('home'),'.claude','projects');if(chooseFolder){const result=await dialog.showOpenDialog(win!,{title:'Select Claude transcript folder for local token counting',properties:['openDirectory']});if(result.canceled||!result.filePaths[0])return null;folder=result.filePaths[0];}return reconstructUsage(folder);});});
 handle('office:agent-effort',async value=>{const input=z.object({agentId:id,effort:effortSchema,expectedEffort:effortSchema}).strict().parse(value);if(transferBusy)throw new Error('Wait for the file operation to finish.');const agent=store.snapshot({history:false}).agents.find(a=>a.id===input.agentId);if(!agent)throw new Error('Agent not found.');if(agent.removedAt)throw new Error('Restore this agent before editing');
  const connection=agent.provider==='openai'&&input.effort!=='default'?await subscriptions.status('openai'):undefined;
  if(connection&&(!connection.connected||connection.account!==agent.account))throw new Error('Sign in to this agent’s subscription account before validating a non-default effort.');
  subscriptions.validateEffort(agent.provider,agent.model,input.effort,connection);if(transferBusy)throw new Error('Wait for the file operation to finish.');const state=store.setAgentEffort(agent.id,input.effort,input.expectedEffort);win?.webContents.send('office:changed');return state;
 });
 handle('office:agent-model',async value=>{const input=z.object({agentId:id,model:z.string().trim().min(1).max(160),expectedModel:z.string().trim().min(1).max(160)}).strict().parse(value);if(transferBusy)throw new Error('Wait for the file operation to finish.');const agent=store.snapshot({history:false}).agents.find(a=>a.id===input.agentId);if(!agent)throw new Error('Agent not found.');if(agent.removedAt)throw new Error('Restore this agent before editing');
  if(agent.provider==='openai'){const connection=await subscriptions.status('openai');if(!connection.connected||connection.account!==agent.account)throw new Error('Sign in to this agent’s subscription account before changing its model.');if(!connection.models.some(m=>m.id===input.model))throw new Error('The selected model is not in your available Codex catalog. Refresh models and select again.');}
  if(transferBusy)throw new Error('Wait for the file operation to finish.');const state=store.setAgentModel(agent.id,input.model,input.expectedModel);win?.webContents.send('office:changed');return state;
 });
 handle('office:work-logs',value=>{if(value!==undefined)throw new Error('Unexpected data');return store.workLogs();});
 handle('office:work-log-import',async value=>{const agentId=id.parse(value);return transfer(async()=>{if(!store.snapshot({history:false}).agents.some(a=>a.id===agentId))throw new Error('Agent not found.');const selection=await dialog.showOpenDialog(win!,{title:'Import visible conversation or work logs for this agent',properties:['openFile'],filters:[{name:'JSON Lines transcripts',extensions:['jsonl']}]});if(selection.canceled||!selection.filePaths[0])return {count:0,skipped:0,message:'Import canceled.'};const file=selection.filePaths[0];if((await stat(file)).size>16*1024*1024)throw new Error('Import a log no larger than 16 MiB.');const parsed=parseWorkLogs(await readFile(file),agentId,new Set(store.snapshot({history:false}).agents.map(a=>a.id)));const count=store.importWorkLogs(parsed.entries);win?.webContents.send('office:changed');return {count,skipped:parsed.skipped,message:`Imported ${count} entries; ${parsed.skipped} non-message records skipped. Source is user-imported, not verified execution.`};});});
 handle('office:agent-connect',async value=>{const ticket=await subscriptions.connect(value);if(win){if(win.isMinimized())win.restore();win.focus();}return ticket;});
 handle('office:agent-bind',async value=>{
  const input=z.object({agentId:id,expectedRevision:z.number().int().nonnegative(),intent:z.enum(['VERIFY','CHANGE'])}).strict().parse(value);
  if(transferBusy)throw new Error('Wait for the file operation to finish.');
  const agent=store.snapshot({history:false}).agents.find(a=>a.id===input.agentId);if(!agent)throw new Error('Agent not found.');
  // The renderer names only the profile it is acting on; the observation always comes from the official tool here.
  const observation=await subscriptions.observeFor(agent.provider);
  const state=store.bindAgentConnection({...input,observation});changed();return state;
 });
 handle('office:agent-confirm',async value=>{if(transferBusy)throw new Error('Wait for the file transfer to finish.');await subscriptions.confirm(id.parse(value),(agent,observation)=>{if(transferBusy)throw new Error('Wait for the file transfer to finish.');store.confirmAgentBinding({observation,agent});});win?.webContents.send('office:changed');return store.snapshot({history:false});});
 handle('office:agent-cancel',value=>{if(value!==undefined)throw new Error('Unexpected data');subscriptions.cancel();});
 handle('office:connection-status',async value=>{const provider=providerSchema.parse(value);const {connection,observation}=await subscriptions.observe(provider);
  // Provider evidence is persisted here, in the main process. The renderer never supplies observations.
  try{store.recordAccountObservation(observation);changed();}catch(error){connection.note=`${connection.note} Durable record not saved: ${error instanceof Error?error.message:'unknown error'}`.trim();}
  return connection;});
 handle('office:provider-login',async value=>{const provider=providerSchema.parse(value);await subscriptions.signIn(provider);
  // A completed sign-in is immediately re-observed and recorded like any account check.
  const {connection,observation}=await subscriptions.observe(provider);
  try{store.recordAccountObservation(observation);changed();}catch(error){connection.note=`${connection.note} Durable record not saved: ${error instanceof Error?error.message:'unknown error'}`.trim();}
  return connection;});
 handle('office:provider-tool',async value=>{const provider=providerSchema.parse(value);const result=await dialog.showOpenDialog(win!,{title:'Locate the official '+(provider==='openai'?'codex.exe':'claude.exe'),properties:['openFile'],filters:[{name:'Provider executable',extensions:['exe']}]});if(!result.canceled&&result.filePaths[0])subscriptions.select(provider,result.filePaths[0]);});
 handle('office:provider-usage',value=>shell.openExternal(providerSchema.parse(value)==='claude'?'https://claude.ai/settings/usage':'https://chatgpt.com/codex/settings/usage'));
 
 const noInput=(value:unknown)=>{if(value!==undefined)throw new Error('Unexpected request data.');};
 handle('office:project-folder',async value=>{noInput(value);const result=await dialog.showOpenDialog(win!,{title:'Project folder on this device',properties:['openDirectory']});return result.canceled?null:result.filePaths[0]??null;});
 handle('office:project-open-folder',async value=>{const project=store.snapshot({history:false}).projects.find(p=>p.id===id.parse(value));if(!project?.localFolder)throw new Error('Folder not selected. Edit the project to choose one.');if(!(await stat(project.localFolder)).isDirectory())throw new Error('Project folder is missing. Relink it in project settings.');const error=await shell.openPath(project.localFolder);if(error)throw new Error(error);});
 handle('office:choose-input-files',async value=>{
  const root=z.string().min(1).max(32000).parse(value);
  const real=resolveSelectionRoot(root);
  return transfer(async()=>{
   const result=await dialog.showOpenDialog(win!,{title:'Choose files to share with this request',defaultPath:real,properties:['openFile','multiSelections']});
   if(result.canceled)return [];
   if(result.filePaths.length>200)throw new Error('Select up to 200 files at a time.');
   // The selection is validated here, in the main process, before it can become a saved allowlist.
   return resolveSelection(real,result.filePaths.map(file=>path.relative(real,file))).map(file=>file.relative);
  });
 });
 const assignmentInput=z.object({assignmentId:id}).strict();
 /**
  * Admission for one request action.
  *
  * Two things have to hold. A workspace replacement must not be in progress, because the database
  * this action is about to use is the one being replaced; checking a flag once at the end of the
  * restore was not enough, since an action could be admitted while the restore was still awaiting.
  * And the epoch is captured before the work and compared after, so a result computed against a
  * database that has since been swapped is discarded instead of being written back or returned.
  */
 const dispatch=async<T>(fn:()=>Promise<T>|T):Promise<T>=>{
  if(workspaceLocked)throw new Error('The workspace is being restored. Wait for it to finish before starting a request action.');
  if(dispatchBusy)throw new Error('Another request action is already running.');
  const epoch=storeEpoch;
  dispatchBusy=true;openRequestActions++;
  try{
   const result=await fn();
   if(epoch!==storeEpoch)throw new Error('The workspace was replaced while this action was running. Its result was discarded; reload and try again.');
   return result;
  }finally{dispatchBusy=false;openRequestActions--;}
 };
 handle('office:request-prepare',async value=>{
  const input=z.object({requestId:id,expectedRequestRevision:z.number().int().nonnegative(),agentId:id,expectedAgentRevision:z.number().int().nonnegative()}).strict().parse(value);
  return dispatch(async()=>{
   const state=store.snapshot({history:false});
   const request=state.requests?.find(item=>item.id===input.requestId);
   if(!request)throw new Error('Request not found.');
   // The frozen bytes go into the workspace object store, so a backup carries them and a restore can
   // rebuild the staging directory without ever reading the user's source folder again.
   const snapshot=await prepareInputSnapshot({store,stagingRoot:path.join(workspaceDirectory(app.getPath('userData')),'snapshots'),
    objectRoot:workspaceDirectory(app.getPath('userData')),
    projectId:request.projectId,requestId:request.id,requestRevision:request.revision,objective:request.objective});
   const result=controller.prepare({requestId:input.requestId,agentId:input.agentId,snapshotId:snapshot.id,
    expectedRequestRevision:input.expectedRequestRevision,expectedAgentRevision:input.expectedAgentRevision});
   changed();return {state:result.state,assignmentId:result.assignment.id,snapshot};
  });
 });
 handle('office:request-plan',value=>{const input=assignmentInput.parse(value);return controller.handoffPlan(input.assignmentId);});
 handle('office:request-handoff',async value=>{const input=assignmentInput.parse(value);return dispatch(async()=>{
  const state=await controller.handoff(input.assignmentId);changed();return state;});});
 handle('office:request-observe',async value=>{const input=assignmentInput.parse(value);return dispatch(async()=>{const state=await controller.observe(input.assignmentId);changed();return state;});});
 handle('office:request-cancel-job',async value=>{const input=assignmentInput.parse(value);return dispatch(async()=>{const state=await controller.cancel(input.assignmentId);changed();return state;});});
 handle('office:request-discard-preparation',async value=>{const input=assignmentInput.parse(value);return dispatch(async()=>{const state=controller.discardPreparation(input.assignmentId);changed();return state;});});
 handle('office:request-link',value=>{
  const input=z.object({assignmentId:id,externalId:z.string().trim().min(1).max(200),externalUrl:z.string().trim().max(2000)}).strict().parse(value);
  const state=controller.link(input.assignmentId,input.externalId,input.externalUrl);changed();return state;
 });
 handle('office:verify-transport',async value=>{
  const input=z.object({provider:providerSchema}).strict().parse(value);
  // R1 containment: refuse before observing the account or spawning a terminal, so no path here can
  // create a session while the probe's intent, snapshot and duplicate handling remain unrepaired.
  assertTransportProbeAllowed();
  const transport=transportModuleStatus();
  if(!transport.available)throw new Error(transport.detail);
  if(input.provider!=='claude')throw new Error('Only the Claude cloud transport can be verified.');
  return dispatch(async()=>{
   const {observation}=await subscriptions.observe(input.provider);
   const model=store.snapshot({history:false}).agents.find(agent=>agent.provider===input.provider&&!agent.removedAt)?.model
     ?? observation.models[0]?.id ?? 'opus';
   // One real session, on the user's own subscription, carrying only a generated fixture.
   const adapter=new PtyCloudAdapter({executable:()=>subscriptions.toolPath('claude'),environment:()=>subscriptionEnvironment()});
   const result=await probeCloudTransport({store,adapter,stagingRoot:path.join(workspaceDirectory(app.getPath('userData')),'probes'),model,observation});
   changed();return {...result,state:store.snapshot({history:false})};
  });
 });
 const pageLimit=z.number().int().min(1).max(500).optional();
 handle('office:history-page',value=>store.historyPage(z.object({projectId:id.nullable().optional(),limit:pageLimit,cursor:z.number().int().positive().optional()}).strict().parse(value)));
 handle('office:log-page',value=>store.logPage(z.object({agentId:id.optional(),conversationId:z.string().max(200).optional(),limit:pageLimit,cursor:z.string().max(300).optional()}).strict().parse(value)));
 handle('office:job-events',value=>{const input=z.object({jobId:id,limit:pageLimit,cursor:z.string().max(300).optional()}).strict().parse(value);return store.jobEventPage(input.jobId,input);});
 // The structured applied-report query: publicState strips jobEvents, so the applied-report UI
 // must query them rather than read the pushed snapshot (QO-LOCAL-REV F05/F06).
 handle('office:applied-reports',value=>{const input=z.object({jobId:id,limit:pageLimit}).strict().parse(value);return {entries:store.appliedReports(input.jobId,input.limit??50)};});
 handle('office:local-session-summary',value=>{const jobId=id.parse(value);const workspace=workspaceDirectory(app.getPath('userData'));
  return store.localSessionSummary(jobId,record=>path.join(workspace,record.layout==='PROJECT_WORKTREE'?path.join('local-repos',record.projectId,WORKTREES_DIR):'local-sessions',record.archiveRelativePath??record.storageRelativePath));});
 handle('office:migrate-legacy',value=>{noInput(value);if(transferBusy)throw new Error('Wait for the file operation to finish.');
  const result=store.migrateLegacyRequests();changed();return {...result,state:store.snapshot({history:false})};});
 handle('office:state',value=>{noInput(value);return store.snapshot({history:false});});
 handle('office:message-page',value=>store.messagePage(z.object({agentId:id.optional(),requestId:id.optional(),limit:pageLimit,cursor:z.string().max(300).optional()}).strict().parse(value)));
 handle('office:research-page',value=>store.researchPage(z.object({projectId:id,branchId:id.optional(),kind:z.enum(['pipeline','trials']),limit:pageLimit,cursor:z.string().max(300).optional(),query:z.string().max(200).optional()}).strict().parse(value)));
 handle('office:research-insights',value=>{
   const input=z.object({projectId:id,branchId:id}).strict().parse(value),state=store.snapshot({history:false});
   if(!state.branches?.some(b=>b.id===input.branchId&&b.projectId===input.projectId))throw new Error('Research branch is outside this project.');
   const branches=state.branches.filter(b=>b.projectId===input.projectId),ids=new Set(branches.map(b=>b.id));
   const records={...state,branches,trials:state.trials?.filter(t=>ids.has(t.branchId))},predictions=(state.predictions??[]).filter(p=>ids.has(p.branchId));
   const realised=Object.fromEntries((state.pipeline??[]).filter(r=>r.kind==='FORECAST_OUTCOME'&&ids.has(r.branchId)).map(r=>r.kind==='FORECAST_OUTCOME'?[r.predictionId,r.value]:[]));
   return {calibration:calibration(predictions,realised),methods:compareMethods(records,branches.filter(b=>b.parentBranchId===null).map(b=>({name:b.name,lineageIds:[b.lineageId]}))),
     ancestry:lineageAncestry(records,input.branchId)};
 });
 handle('office:research-export',async value=>{
   const input=z.object({branchId:id}).strict().parse(value),branch=store.snapshot({history:false}).branches?.find(b=>b.id===input.branchId);
   if(!branch)throw new Error('Research branch not found.');
   return transfer(async()=>{
     const selected=await dialog.showSaveDialog({title:'Export exact research evidence',defaultPath:'research-evidence.zip'});
     if(selected.canceled||!selected.filePath)return {canceled:true,count:0,message:'',state:store.snapshot({history:false})};
     rejectInternalDestination(selected.filePath);await artifacts.exportResearch(branch.id,selected.filePath);changed();
     return {canceled:false,count:1,message:'Research evidence exported with exact scope and verification limits.',state:store.snapshot({history:false})};
   });
 });
 handle('office:info',value=>{noInput(value);const transport=transportModuleStatus();return {version:app.getVersion(),dataDirectory:workspaceDirectory(app.getPath('userData')),platform:process.platform,packaged:app.isPackaged,transportModule:transport.available,transportDetail:transport.detail};});
 handle('office:command',value=>{if(transferBusy)throw new Error('Wait for the file operation to finish.');const state=store.execute(value);changed();return state;});
 // Evidence access is deliberately read-only and grant-checked inside the service, which is the only
 // place that resolves an object hash to bytes. The renderer never receives an object path.
 // Read-only research status, and the one write that gives a stage its people. Assignment is
 // append-only and never edits a profile, so a change of function is a dated decision on the record.
 handle('office:research-assign-function',value=>{
  if(transferBusy)throw new Error('Wait for the file operation to finish.');
  const input=z.object({projectId:id,stage:z.enum(['S0','S1','S2','S3','S4','S5','S6','S7','S8','S9','S10']),
   function:z.enum(['PRINCIPAL','CORRECTNESS_REVIEWER','ADVOCATE','SKEPTIC','CUSTODIAN','DIRECTOR']),
   agentId:id,expectedAgentRevision:z.number().int().nonnegative(),note:z.string().max(2000)}).strict().parse(value);
  const state=store.appendFunctionAssignment({id:randomUUID(),projectId:input.projectId,stage:input.stage,function:input.function,
   agentId:input.agentId,agentRevision:input.expectedAgentRevision,appendedAt:new Date().toISOString(),supersededById:null,
   origin:'EXPLICIT',note:input.note});
  changed();return state;
 });
 handle('office:research-migrate-functions',value=>{
  if(transferBusy)throw new Error('Wait for the file operation to finish.');
  const input=z.object({projectId:id,stage:z.enum(['S0','S1','S2','S3','S4','S5','S6','S7','S8','S9','S10'])}).strict().parse(value);
  const snapshot=store.snapshot({history:false});
  const appended=migrateRolesToFunctions(snapshot,{projectId:input.projectId,stage:input.stage,now:new Date().toISOString(),
   existing:(snapshot.functions??[]).filter(item=>!item.supersededById),id:randomUUID});
  let state=snapshot;for(const assignment of appended)state=store.appendFunctionAssignment(assignment);
  if(appended.length)changed();
  return {appended:appended.length,state};
 });
 handle('office:research-status',value=>{
  const input=z.object({branchId:id,subjectHash:z.string().regex(/^[a-f0-9]{64}$/),mode:z.enum(['SINGLE','GROUP','TEAM'])}).strict().parse(value);
  const state=store.snapshot({history:false});
  const branch=(state.branches??[]).find(item=>item.id===input.branchId);
  if(!branch)throw new Error('Research branch not found.');
  const functions=STAGE_FUNCTIONS_REQUIRED[branch.stage];
  const assignments=(state.functions??[]).filter(item=>!item.supersededById);
  const schedule=scheduleStage({state,records:state,assignments,branch,subjectHash:input.subjectHash,mode:input.mode,outputSchema:'research-stage-report@1'});
  const integration=store.researchStageBlocker(branch.stage),promotion=promotable(state,branch,input.subjectHash,integration);
  const delivery=STAGE_DELIVERY[branch.stage];
  const pkg=(state.pipeline??[]).filter(r=>r.kind==='RUN_PACKAGE'&&r.branchId===branch.id&&r.branchRevision===branch.revision).at(-1);
  const awaiting=pkg?.kind==='RUN_PACKAGE'&&pkg.state==='AWAITING_RETURN'?pkg:null;
  const caps=pipeline.capabilities();
  return {stage:branch.stage,outcome:branch.outcome,requiredFunctions:functions,
   functions:resolveFunctions(state,assignments,{projectId:branch.projectId,stage:branch.stage,functions}),
   tasks:schedule.tasks,scheduleBlockers:schedule.blockers.filter(b=>!b.includes('execution and advancement are blocked')).concat(integration?[integration]:[]),
   canPrepare:!integration&&branch.outcome==='IN_PROGRESS'&&!state.projects.find(p=>p.id===branch.projectId)?.archived&&(schedule.tasks.length>0||delivery!=='AGENT'),
   canPromote:promotion.allowed,promotionBlockers:promotion.reasons,
   stageDelivery:delivery,
   manual:{canExport:branch.stage==='S3'&&branch.outcome==='IN_PROGRESS'&&!awaiting&&!pkg,
    awaitingPackageId:awaiting?awaiting.packageId:null,
    exportedAt:pkg?.kind==='RUN_PACKAGE'?pkg.exportedAt:null,
    canImport:!!awaiting,
    canValidate:delivery==='OFFICE'&&branch.outcome==='IN_PROGRESS'},
   capabilities:{
    agentCommunication:{state:'READY',detail:'Labeled terminal handoff is available; programmatic observe/retrieve is not part of this build.'},
    agentToolExecution:{state:'HANDOFF_ONLY',detail:'Agent work runs through the manual terminal handoff; hosted dispatch requires the separately scoped provider route.'},
    manualExperimentHandoff:{state:caps.packageExport?'READY':'BLOCKED',detail:caps.packageExport?'Run-package export is configured.':'This build has no run-package author configured.'},
    returnValidation:{state:caps.returnValidation?'READY':'BLOCKED',detail:caps.returnValidation?'Bound-return validation is configured.':'This build has no return inspector configured.'},
    protectedEvaluation:{state:caps.independentRuntime?'READY':'NOT_CONFIGURED',detail:caps.independentRuntime?'Independent runtime is configured.':'No independent runtime or custodian is configured; stronger evidence is separately scoped.'}}};
 });
 // One stage action per call, run inside the dispatch admission so a restore cannot swap the
 // database mid-action. The renderer names the action; the service and the store re-check it.
 handle('office:pipeline',async value=>dispatch(async()=>{
  const result=await pipeline.run(value);
  if(result.assignments?.length||result.state!==store.snapshot({history:false}))changed();
  return result;
 }));
 handle('office:evidence-describe',value=>evidence.describe(value));
 handle('office:evidence-read',value=>evidence.read(value));
 handle('office:evidence-query',value=>evidence.query(value));
 handle('office:evidence-packet',value=>evidence.stagePacket(value));
 handle('office:preview',value=>artifacts.preview(id.parse(value)));
 handle('office:import',async value=>{
  const input=importSchema.parse(value);const state=store.snapshot({history:false});
  if(!state.projects.some(p=>p.id===input.projectId&&!p.archived)||input.experimentId!==null&&!state.experiments.some(e=>e.id===input.experimentId&&e.projectId===input.projectId))throw new Error('Select an active project and a matching experiment.');
  return transfer(async()=>{
   const result=await dialog.showOpenDialog(win!,{title:input.kind==='RESULT'?'Import your result files':'Attach research references',properties:['openFile','multiSelections']});
   if(result.canceled)return {canceled:true,count:0,message:'',state:store.snapshot({history:false})};
   if(result.filePaths.length>32)throw new Error('Import up to 32 files at a time.');
   let total=0;for(const file of result.filePaths){total+=(await stat(file)).size;if(total>MAX_TOTAL)throw new Error('Selection exceeds 256 MiB.');}
   let count=0;const failures:string[]=[];
   for(const file of result.filePaths){try{await artifacts.importFile(file,input.projectId,input.experimentId,input.kind);count++;}catch(error){failures.push(`${path.basename(file)}: ${error instanceof Error?error.message:'Import failed'}`);}}
   changed();return {canceled:false,count,message:`${count} file${count===1?'':'s'} stored. ${input.kind==='RESULT'?'Results stay quarantined pending an approved run and hosted verification.':'References remain unclassified until agents are configured.'}${failures.length?' Failed: '+failures.join('; '):''}`,state:store.snapshot({history:false})};
  });
 });
 handle('office:export',async value=>{const projectId=id.parse(value);const p=store.snapshot({history:false}).projects.find(p=>p.id===projectId);if(!p)throw new Error('Project not found.');return transfer(async()=>{const result=await dialog.showSaveDialog(win!,{title:'Export project planning archive',defaultPath:`${p.name.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,80)}.qro.zip`,filters:[{name:'Office planning archive',extensions:['zip']}]});if(result.canceled||!result.filePath)return {canceled:true,count:0,message:'',state:store.snapshot({history:false})};rejectInternalDestination(result.filePath);await artifacts.exportProject(projectId,result.filePath);changed();return {canceled:false,count:1,message:'Project planning archive exported. This is not an approved run package.',state:store.snapshot({history:false})};});});
 handle('office:backup',async value=>{noInput(value);return transfer(async()=>{const result=await dialog.showSaveDialog(win!,{title:'Back up office workspace',defaultPath:`quant-office-backup-${new Date().toISOString().slice(0,10)}.zip`,filters:[{name:'Workspace backup',extensions:['zip']}]});if(result.canceled||!result.filePath)return {canceled:true,count:0,message:'',state:store.snapshot({history:false})};rejectInternalDestination(result.filePath);await artifacts.backup(result.filePath);changed();return {canceled:false,count:1,message:'Workspace backup saved with database and artifact byte identities.',state:store.snapshot({history:false})};});});
 handle('office:restore',async value=>{noInput(value);return transfer(async()=>{
  const selection=await dialog.showOpenDialog(win!,{title:'Restore a workspace backup',properties:['openFile'],filters:[{name:'Office workspace backup',extensions:['zip']}]});
  if(selection.canceled||!selection.filePaths[0])return {canceled:true,count:0,message:'',state:store.snapshot({history:false})};
  // A request action in flight holds the database that is about to be replaced. This is checked
  // before any candidate is prepared, and the lock then covers the whole preparation and commit, so
  // no action can be admitted during the awaits that follow.
  if(openRequestActions>0||activeWorkspaceCalls>0)throw new Error('A workspace action is still running. Wait for it to finish before restoring a workspace.');
  const root=app.getPath('userData');
  workspaceLocked=true;
  let prepared;
  try{
   prepared=await prepareRestore(selection.filePaths[0],root);
  }catch(error){workspaceLocked=false;throw error;}
  try{
   const decision=await dialog.showMessageBox(win!,{type:'question',buttons:['Cancel','Restore workspace'],defaultId:0,cancelId:0,title:'Restore workspace',message:'Replace the current workspace with this verified backup?',detail:`${prepared.summary}\n\nYour current workspace will be retained as a recovery copy. The office will reload after restoration.`});
   if(decision.response!==1){
    // Refusing has to clean up the candidate it prepared, or a declined restore leaves bytes behind.
    await discardCandidate(prepared.candidate,root);
    return {canceled:true,count:0,message:'',state:store.snapshot({history:false})};
   }
   subscriptions.cancel();store.close();
   try{await commitRestore(root,prepared.transactionId);}
   catch(error){
    // The commit failed after the store was closed. Reopen whatever is there and clean the candidate
    // rather than leaving both a closed database and an orphaned candidate behind.
    try{await discardCandidate(prepared.candidate,root);}catch{/* the candidate may already be gone */}
    throw error;
   }
   finally{
    // Every service that held the old database is rebuilt against the new one. The controller was
    // previously left pointing at the closed store, so the next dispatch used a database that was gone.
    store=new OfficeStore(path.join(workspaceDirectory(root),'workspace.sqlite'),{includeHistoryInResults:false});
    artifacts=new ArtifactService(store,workspaceDirectory(root));evidence=new EvidenceService(store,workspaceDirectory(root));
    controller=buildController();
    // The journal survived the restore by living outside it; reconcile its view of spent allowances
    // against the reservations the restored workspace actually knows before anything new reserves.
    custody=buildCustody(root,workspaceDirectory(root));
    custody.reconcileAfterRestore((store.snapshot({history:false}).pipeline??[]).filter(r=>r.kind==='RESERVATION').map(r=>r.kind==='RESERVATION'?r.reservation.id:''));
    pipeline=buildPipeline();
    storeEpoch++;
   }
   const state=store.snapshot({history:false});setTimeout(()=>win?.webContents.reload(),100);return {canceled:false,count:1,message:'Workspace restored. Previous workspace retained in recovery.',state};
  }finally{workspaceLocked=false;}
 });});
}
function rejectInternalDestination(destination:string){const relative=path.relative(app.getPath('userData'),path.resolve(destination));if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('Save exports outside the live workspace data folder.');}
/** One place that wires the controller, so start-up and post-restore rebuild stay identical. */
function buildController():AssignmentController{
 const workspace=()=>workspaceDirectory(app.getPath('userData'));
 const outputs=new OutputService(store,workspace());
 const handoff=new TerminalHandoffAdapter({executable:()=>subscriptions.toolPath('claude')});
 const flat=new LocalMailboxAdapter(()=>path.join(workspace(),'local-sessions'));
 const tree=new LocalWorktreeMailboxAdapter(()=>path.join(workspace(),'local-repos'));
 // LOCAL_MAILBOX resolves through the persisted binding router: the layout each job's record
 // declares decides which adapter owns it, and pre-binding jobs take the named legacy rule —
 // never registration-order luck (QO-LOCAL-REV §5.3).
 const mailbox=new LocalSessionRouter(jobId=>store.localSessionForJob(jobId),{FLAT_PACKET:flat,PROJECT_WORKTREE:tree});
 return new AssignmentController(store,handoff,undefined,
  // Verification is scoped to the staging root this office owns, so a snapshot pointing anywhere
  // else is refused rather than verified in place.
  snapshot=>verifySnapshotForTransfer(snapshot,'git',path.join(workspace(),'snapshots')),
  // The fresh account check lives inside the controller, so every launch path runs it and no future
  // caller can reach one that skipped it. Committing it here makes it a durable fact, not a reading.
  async provider=>{const {observation}=await subscriptions.observe(provider);store.recordAccountObservation(observation);},
  // Staging is disposable and a restore does not carry it. Rebuilding from the workspace's own
  // stored bytes is what makes prepared work survive a restore; the source folder is never reread.
  async snapshot=>{
   const rebuilt=await reconstructSnapshot({snapshot,objectRoot:workspace(),stagingRoot:path.join(workspace(),'snapshots')});
   if(rebuilt.problems.length)throw new Error(`The prepared inputs could not be rebuilt: ${rebuilt.problems[0]} Prepare the request again.`);
   return rebuilt.stagingPath;
  },undefined,outputs.storeBytes,outputs.prepare,
  // Hosted work uses the labeled terminal handoff; local work uses the mailbox transport. Routes
  // and agents resolve only to the adapter that actually owns them — a miss fails closed, never a
  // silent fallback across environments.
  ref=>{
   if(ref.route)return ref.route===handoff.route?handoff:ref.route===mailbox.route?mailbox:undefined;
   if(ref.agent)return ref.agent.execution==='HOSTED_SETUP_REQUIRED'?handoff:ref.agent.execution==='LOCAL'?mailbox:undefined;
   return undefined;
  });
}
async function transfer<T>(fn:()=>Promise<T>):Promise<T>{if(transferBusy)throw new Error('Another file dialog or transfer is already active.');transferBusy=true;try{return await fn();}finally{transferBusy=false;}}
/**
 * Custody outside the workspace tree, with a capability that says only what this build can do.
 *
 * Sealed storage is a real directory the separation check verifies is unreachable from the
 * workspace, its backups and its evidence index. There is no isolated evaluator in this build, and
 * claiming otherwise would turn every S8 answer into a claim about software that does not exist.
 */
function buildCustody(root:string,workspace:string):HoldoutCustody{
 const paths={sealedRoot:path.join(root,'custody','sealed'),journalFile:path.join(root,'custody','exposure-journal.jsonl')};
 const separation=HoldoutCustody.separationBlocker(paths,workspace);
 return new HoldoutCustody(paths,{sealedStorageSupported:!separation,isolatedEvaluatorSupported:false,
  detail:separation??'No isolated evaluator is configured in this build.'},null);
}
/** The research pipeline acts on the live store, controller and evidence layer — rebuilt together after a restore. */
function buildPipeline():PipelineService{
 const workspace=workspaceDirectory(app.getPath('userData'));
 return new PipelineService(store,controller,custody,
  input=>prepareInputSnapshot({store,stagingRoot:path.join(workspace,'snapshots'),objectRoot:workspace,
   projectId:input.projectId,requestId:input.requestId,requestRevision:input.requestRevision,objective:input.objective}),
  hash=>evidence.bytes(hash),()=>new Date().toISOString(),null,{
    selectHoldout:async()=>{
      const selected=await dialog.showOpenDialog({title:'Register holdout in separate custody',properties:['openFile']});
      if(selected.canceled)return null;
      const file=selected.filePaths[0],metadata=await stat(file);
      if(!metadata.isFile()||metadata.size>64*1024*1024)throw new Error('Holdout import must be a file no larger than 64 MiB.');
      return readFile(file);
    },
    exportHoldout:async bytes=>{
      const selected=await dialog.showSaveDialog({title:'Export exposed holdout — user custody',defaultPath:'holdout-user-custody.bin'});
      if(selected.canceled||!selected.filePath)return;
      rejectInternalDestination(selected.filePath);
      await writeFile(selected.filePath,bytes,{flag:'wx',flush:true});
    },
    writeObject:async bytes=>{
      const sha256=createHash('sha256').update(bytes).digest('hex'),file=path.join(workspace,'objects',sha256.slice(0,2),sha256);
      await mkdir(path.dirname(file),{recursive:true});
      if(!existsSync(file)){
        const temporary=file+'.'+randomUUID()+'.pending';
        await writeFile(temporary,bytes,{flag:'wx',flush:true});await rename(temporary,file);
      }else if(createHash('sha256').update(await readFile(file)).digest('hex')!==sha256)throw new Error('Stored report object integrity failure.');
      return {sha256,bytes:bytes.length};
    },
    // The user takes the exported package to Colab by hand; this only writes it somewhere they can.
    exportPackage:async(bytes,packageId)=>{
      const selected=await dialog.showSaveDialog({title:'Export run package for your manual Colab run',defaultPath:`run-package-${packageId.slice(0,8)}.zip`});
      if(selected.canceled||!selected.filePath)return null;
      rejectInternalDestination(selected.filePath);
      await writeFile(selected.filePath,bytes,{flag:'wx',flush:true});
      return selected.filePath;
    },
  },(()=>{const codec=createRunPackageCodec({templatesDir:path.join(app.getAppPath(),'research-templates')});return {build:codec,inspect:codec};})());
}
