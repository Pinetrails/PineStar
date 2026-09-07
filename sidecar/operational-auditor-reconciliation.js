'use strict';
const PLAN_ID='auditor-matched-local-operational-envelope-v1';
const PLAN_DIGEST='a536bf0b3d6a1506548e83eb57a78536776552dc96a9ef93dd3cea1680b1a832';
const OBJECTIVE_ID='objective:f8215977-26a2-4a72-a6d6-32b416523fbf';
const RUN_ID='d00b954c-9024-431b-b736-47c1ff79be14';
const RECEIPT_FILE='pine-star.auditor-operational-envelope-v1-receipt.json';
const ATTRIBUTION_TERMS=Object.freeze([PLAN_ID,RECEIPT_FILE,OBJECTIVE_ID,RUN_ID,'sidecar/index.js','sidecar\\index.js','PINE_STAR_AUTHORIZED_AUDITOR_OPERATIONAL_DIGEST']);
function attributableProcesses(processes){return (Array.isArray(processes)?processes:[]).filter(p=>{const line=String(p&&p.commandLine||'');return ATTRIBUTION_TERMS.some(term=>line.includes(term));});}
async function reconcile(deps){
  const d=deps||{},receipt=d.receipt,objective=d.objectiveStore&&d.objectiveStore.get(OBJECTIVE_ID);
  if(!receipt||receipt.planId!==PLAN_ID||receipt.planDigest!==PLAN_DIGEST||!['attempted','failed'].includes(receipt.state))throw new Error('exact consumed operational-envelope receipt required');
  if(!objective||objective.admittedRunId!==RUN_ID||objective.runtimeConfigurationId!=='operations-auditor.ollama-llama3.1-8b.v1')throw new Error('exact stranded challenger objective required');
  const attributed=attributableProcesses(d.processes);
  if(attributed.length)throw new Error('live process is attributable to stranded measurement: '+attributed.map(x=>x.pid).join(','));
  if(d.hasRun(RUN_ID))throw new Error('interrupted reconciliation refuses an existing run row');
  if(d.hasMeasurement(RUN_ID))throw new Error('interrupted reconciliation refuses an existing measurement row');
  if(d.hasEvidence(RUN_ID))throw new Error('interrupted reconciliation refuses existing evidence');
  if(receipt.state==='failed'){
    if(objective.status!=='failed'||!receipt.recovery||receipt.recovery.objectiveId!==OBJECTIVE_ID||receipt.recovery.runId!==RUN_ID)throw new Error('prior recovery state is not exact');
    return {objective,receipt,idempotent:true};
  }
  let settled=objective;
  if(objective.status==='in_progress')settled=await d.objectiveStore.recordLifecycle(OBJECTIVE_ID,{state:'failed',runId:RUN_ID,at:d.now(),reason:'Interrupted by terminated host session; inference outcome and usage cannot be proven.',evidenceRefs:['receipt:pine-star.auditor-operational-envelope-v1-receipt.json','change:PS-2026-070','process:not-running','run:not-recorded','measurement:not-recorded'],resultSummary:'Claimed one-shot slot consumed and failed. No run or measurement was fabricated; model processing and token usage remain UNKNOWN.'});
  else if(objective.status!=='failed')throw new Error('stranded objective is not reconcilable');
  const next=Object.assign({},receipt,{state:'failed',failedAt:d.now(),planClosed:true,planOutcome:'incomplete',consumedSlots:4,settledMeasuredFailures:3,interruptedConsumedSlots:1,neverLaunchedSlots:2,remainingSlotsUsable:false,totalExternalCostUsd:0,evaluationStatus:'not_created_incomplete_evidence',candidateStatus:'not_created',recovery:{changeId:'PS-2026-070',objectiveId:OBJECTIVE_ID,runId:RUN_ID,outcome:'interrupted_failed',processRunning:false,normalRunRecorded:false,measurementRecorded:false,evidenceRecorded:false,inferenceOutcome:'UNKNOWN',tokenUsage:'UNKNOWN',slotConsumed:true,remainingSlotsLaunched:false,reason:'Host session terminated before durable run settlement; the claimed slot cannot be retried.'}});
  d.writeReceipt(next);return {objective:settled,receipt:next};
}
module.exports={PLAN_ID,PLAN_DIGEST,OBJECTIVE_ID,RUN_ID,RECEIPT_FILE,ATTRIBUTION_TERMS,attributableProcesses,reconcile};
