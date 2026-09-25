import React from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Box, LockKeyhole } from 'lucide-react';
import type { AppState, Experiment, FileActionResult, Project } from '../shared/types';
import { Empty, label } from './components';
import './office.css';

const date = (d: string) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ArtifactsPage({state,project,projectId,experiment,busy,files,setBusy,setPreview,onError}:{
 state:AppState; project:Project|undefined; projectId:string; experiment:Experiment|undefined; busy:boolean;
 files:(action:()=>Promise<FileActionResult>)=>void;
 setBusy:(busy:boolean)=>void;
 setPreview:(preview:{name:string;text:string;truncated:boolean;binary:boolean})=>void;
 onError:(e:unknown)=>void;
}){
 const scopedArtifacts=state.artifacts.filter(a=>a.projectId===projectId&&(!experiment||a.experimentId===experiment.id));
 return <>
  <div className="section-toolbar artifact-toolbar"><span>{scopedArtifacts.length} files stored</span><div className="button-row"><button className="secondary" disabled={busy||project?.archived} onClick={()=>void files(()=>window.office.importFiles({projectId,experimentId:experiment?.id||null,kind:'REFERENCE'}))}><ArrowDownToLine size={15}/>Import references</button><button className="secondary" disabled={busy||project?.archived} onClick={()=>void files(()=>window.office.importFiles({projectId,experimentId:experiment?.id||null,kind:'RESULT'}))}><ArrowDownToLine size={15}/>Import my results</button><button className="primary" disabled={busy} onClick={()=>void files(()=>window.office.exportProject(projectId))}><ArrowUpFromLine size={15}/>Export project</button></div></div>
  <div className="inline-note"><LockKeyhole size={16}/><span>Files are stored as evidence. Imported results await provider verification. Finalized ML code runs manually in your own Colab session; this app never connects to it.</span></div>
  {!scopedArtifacts.length?<Empty icon={Box} title="A cabinet for your evidence" description="Import reference code, datasets, or results you produced yourself. Nothing you import is executed by this app."/>:<div className="table-wrap"><table><thead><tr><th>Artifact</th><th>Type / state</th><th>Integrity</th><th>Added</th><th/></tr></thead><tbody>{scopedArtifacts.filter(a=>!experiment||a.experimentId===experiment.id).map(a=><tr key={a.id}><td><strong>{a.name}</strong><small>{a.size.toLocaleString()} bytes · {a.mediaType}</small></td><td><span className="quiet-badge small">{label(a.kind)}</span><small>{label(a.status)} · {label(a.classification)}</small></td><td><code title={a.sha256}>{a.sha256.slice(0,12)}…</code></td><td>{date(a.createdAt)}</td><td><button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{setPreview({name:a.name,...await window.office.previewArtifact(a.id)});}catch(e){onError(e);}finally{setBusy(false);}}}>Preview</button></td></tr>)}</tbody></table></div>}
  <p className="footnote">Project export includes the current local record and stored files. It does not certify code as approved.</p>
 </>;
}
