import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OfficeStore} from '../src/core/store';

const data=await mkdtemp(path.join(tmpdir(),'qro-revision-desktop-'));
await mkdir(path.join(data,'workspace'));
const store=new OfficeStore(path.join(data,'workspace','workspace.sqlite'));
const now=new Date().toISOString();
for(const name of ['Alice — long researcher name with several words','Ben','Archived fixture'])store.addAgent({id:randomUUID(),name,team:'Fixture team',role:'WORKER',provider:'openai',model:'fixture-unverified',instructions:'Fixture only',account:'fixture@example.test',createdAt:now,connectionVerifiedAt:now,execution:'HOSTED_SETUP_REQUIRED'});
store.execute({type:'agent.remove',idempotencyKey:randomUUID(),agentId:store.snapshot().agents[2].id,removed:true});
store.execute({type:'project.create',idempotencyKey:randomUUID(),name:'Fixture project',mandate:'No live work',budgetCents:0});store.close();
const {ELECTRON_RUN_AS_NODE:_runAsNode,...launchEnvironment}=process.env;
const application=await electron.launch({args:process.env.QRO_EXECUTABLE?[]:[process.cwd()],...(process.env.QRO_EXECUTABLE?{executablePath:process.env.QRO_EXECUTABLE}:{}),env:{...launchEnvironment,QRO_USER_DATA_DIR:data}});
const checks:string[]=[];
try{
 const page=await application.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.getByRole('heading',{name:'The office',exact:true}).waitFor();
 for(const scale of [1,1.25,1.5,2]){
  await application.evaluate(({BrowserWindow},scale)=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1050,720);w.webContents.setZoomFactor(scale);},scale);
  await page.waitForFunction(()=>document.fonts.status==='loaded');
  const labels=await page.locator('.station-label').evaluateAll(labels=>labels.map(label=>{const name=label.querySelector('strong')!.getBoundingClientRect(),status=label.querySelector('span')!.getBoundingClientRect();return {nameBottom:name.bottom,statusTop:status.top};}));
  assert.equal(await page.evaluate(()=>document.body.scrollWidth<=window.innerWidth),true);assert.equal(labels.length,2);assert.ok(labels.every(l=>l.nameBottom<=l.statusTop));assert.equal(await page.locator('.office-person').count(),2);
  await page.locator('.station-label').first().scrollIntoViewIfNeeded();await page.locator('.office-person').first().focus();assert.equal(await page.locator('.office-person').first().evaluate(e=>document.activeElement===e),true);
  await page.locator('.station-label').first().scrollIntoViewIfNeeded();
  const capture=await application.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));await writeFile(path.join('test-output',`revision-office-${scale*100}.png`),Buffer.from(capture,'base64'));checks.push(`Labels and keyboard focus at ${scale*100}% zoom, minimum window`);
 }
 await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1440,1000);w.webContents.setZoomFactor(1);});
 await page.getByRole('button',{name:'Agents',exact:true}).click();assert.equal(await page.locator('.project-card').count(),2);
 await page.getByLabel('Membership').selectOption('archived');assert.equal(await page.locator('.project-card').count(),1);await page.getByRole('button',{name:'Profile & logs'}).click();assert.equal(await page.getByLabel('Agent effort level').isDisabled(),true);await page.getByRole('button',{name:'Close dialog'}).click();
 checks.push('Active/Archived roster filters and read-only archived effort');
 const project=(await page.evaluate(()=>window.office.getState())).projects[0];await page.getByLabel('Current project',{exact:true}).selectOption(project.id);await page.getByRole('button',{name:/^Tasks/}).first().click();await page.getByRole('button',{name:'New request',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'New request'});await dialog.getByLabel('Request name').fill('Explain with Alice');await dialog.getByLabel('Objective',{exact:true}).fill('Explain a notebook');const agent=(await page.evaluate(()=>window.office.getState())).agents[0];await dialog.getByLabel('Responsible agent').selectOption(agent.id);await dialog.getByRole('button',{name:'Save draft'}).click();await dialog.waitFor({state:'hidden'});
 let state=await page.evaluate(()=>window.office.getState());assert.equal(state.experiments.length,0);assert.equal(state.requests![0].leadAgentId,agent.id);
 await page.getByRole('button',{name:'Start request',exact:true}).click();await page.getByText(/No subscription cloud transport/).waitFor();assert.equal(await page.locator('.nav-item').filter({hasText:'Tasks'}).locator('b').innerText(),'1');
 await page.getByRole('button',{name:'Cancel request',exact:true}).click();await page.getByLabel('Show requests').selectOption('canceled');assert.equal(await page.locator('.task-card').count(),1);state=await page.evaluate(()=>window.office.getState());assert.equal(state.requests![0].status,'CANCELED');checks.push('Single Worker question draft/start blocker/cancel and canonical count');
 assert.deepEqual(errors,[]);await writeFile('test-output/revision-desktop-report.json',JSON.stringify({status:'PASS',timestamp:new Date().toISOString(),packaged:!!process.env.QRO_EXECUTABLE,fixtureOnly:true,checks,pageErrors:errors},null,2));console.log('Revision desktop checks passed.');
}finally{await application.close();}
