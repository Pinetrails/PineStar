'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),childProcess=require('child_process');
const {makeRoleRegistry}=require('./role-registry.js'),{SEEDS}=require('../shared/pine-star-roles.js');
const {makeObjectiveStore}=require('./objective-store.js'),{writeFileDurable}=require('./durable-write.js');
const R=require('./operational-auditor-reconciliation.js');
const root=path.resolve(String(process.env.STARNET_WORKSPACES||''));
if(!process.env.STARNET_WORKSPACES||!path.isAbsolute(root))throw new Error('explicit absolute STARNET_WORKSPACES required');
const receiptFile=path.join(root,R.RECEIPT_FILE),receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
function inspectProcesses(){
  const raw=childProcess.execFileSync('wmic',['process','where',"name='node.exe' or name='ollama.exe'",'get','ProcessId,ExecutablePath,CommandLine','/format:list'],{encoding:'utf8',windowsHide:true});
  return raw.split(/(?:\r?\n){2,}/).map(block=>{const row={};for(const line of block.split(/\r?\n/)){const i=line.indexOf('=');if(i>0)row[line.slice(0,i).trim()]=line.slice(i+1).trim();}return {commandLine:row.CommandLine||'',executablePath:row.ExecutablePath||'',pid:row.ProcessId||''};}).filter(row=>row.pid&&Number(row.pid)!==process.pid);
}
const processes=inspectProcesses(),attributed=R.attributableProcesses(processes);
if(attributed.length)throw new Error('refusing reconciliation: live process matches exact measurement identity: '+JSON.stringify(attributed));
const objectiveStore=makeObjectiveStore({fs,path,workspaces:root,writeDurable:writeFileDurable,registry:makeRoleRegistry(SEEDS),now:()=>Date.now(),newId:()=>crypto.randomUUID()});
const runsFile=path.join(root,'runs.jsonl'),runIds=new Set();if(fs.existsSync(runsFile))for(const line of fs.readFileSync(runsFile,'utf8').split(/\r?\n/)){try{const x=JSON.parse(line);if(x&&x.runId)runIds.add(x.runId);}catch(_){}}
const measurementsFile=path.join(root,'pine-star.matched-measurements.json'),measurements=fs.existsSync(measurementsFile)?JSON.parse(fs.readFileSync(measurementsFile,'utf8')):[];
const evidenceDir=path.join(root,'matched-measurements',R.PLAN_ID),evidenceNames=fs.existsSync(evidenceDir)?fs.readdirSync(evidenceDir):[];
R.reconcile({receipt,objectiveStore,processes,hasRun:id=>runIds.has(id),hasMeasurement:id=>measurements.some(x=>x&&x.runId===id),hasEvidence:id=>evidenceNames.some(name=>name.includes(id)),now:()=>Date.now(),writeReceipt:next=>writeFileDurable({fs,path},receiptFile,JSON.stringify(next,null,2))}).then(out=>console.log(JSON.stringify({objectiveId:out.objective.id,status:out.objective.status,receiptState:out.receipt.state,idempotent:!!out.idempotent,recovery:out.receipt.recovery},null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
