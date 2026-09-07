'use strict';
const IDS=Object.freeze(['objective:f9d75688-61ea-4244-bd9b-84b686f72efc','objective:698daf43-26b1-45b6-a683-677b6416c949']);
const ORIGINAL_DIGEST='38958d16b0b1c610b6a67af63faa2d135d0e6eb21e35eca7aca893fc7dec6b93';
async function reconcile(deps){ const d=deps||{}, receipt=d.receipt;
  if(!receipt||receipt.planDigest!==ORIGINAL_DIGEST||!['attempted','failed'].includes(receipt.state)) throw new Error('consumed original attempt receipt required');
  const rows=[]; for(const id of IDS){ const objective=d.objectiveStore.get(id); if(!objective) throw new Error('authorized stranded objective missing');
    if(objective.status==='failed'){rows.push(objective);continue;} if(objective.status!=='in_progress') throw new Error('stranded objective is not reconcilable');
    if(d.hasRun(objective.admittedRunId)) throw new Error('pre-inference reconciliation refuses an existing run row');
    rows.push(await d.objectiveStore.recordLifecycle(id,{state:'failed',runId:objective.admittedRunId,at:d.now(),reason:'Pre-inference runner integration failure: emit is not a function; inference never began.',evidenceRefs:['receipt:pine-star.auditor-measurement-receipt.json','change:PS-2026-066','inference:not-started'],resultSummary:'Infrastructure failure before inference; no run, usage, token, cost, or measurement record exists.'}));
  } return rows;
}
module.exports={IDS,ORIGINAL_DIGEST,reconcile};
