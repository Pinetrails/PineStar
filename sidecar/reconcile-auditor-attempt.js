'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const {makeRoleRegistry}=require('./role-registry.js'), {SEEDS}=require('../shared/pine-star-roles.js');
const {makeObjectiveStore}=require('./objective-store.js'), {writeFileDurable}=require('./durable-write.js');
const {reconcile}=require('./auditor-attempt-reconciliation.js');
const root=path.resolve(String(process.env.STARNET_WORKSPACES||'')); if(!process.env.STARNET_WORKSPACES||!path.isAbsolute(root)) throw new Error('explicit absolute STARNET_WORKSPACES required');
const receipt=JSON.parse(fs.readFileSync(path.join(root,'pine-star.auditor-measurement-receipt.json'),'utf8'));
const objectiveStore=makeObjectiveStore({fs,path,workspaces:root,writeDurable:writeFileDurable,registry:makeRoleRegistry(SEEDS),now:()=>Date.now(),newId:()=>crypto.randomUUID()});
const runIds=new Set(); const runsFile=path.join(root,'runs.jsonl'); if(fs.existsSync(runsFile)) for(const line of fs.readFileSync(runsFile,'utf8').split(/\r?\n/)){try{const x=JSON.parse(line);if(x&&x.runId)runIds.add(x.runId);}catch(_){}}
reconcile({receipt,objectiveStore,hasRun:id=>runIds.has(id),now:()=>Date.now()}).then(rows=>console.log(JSON.stringify(rows.map(x=>({id:x.id,status:x.status,settlementReason:x.settlementReason})),null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
