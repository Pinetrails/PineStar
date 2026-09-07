'use strict'; const fs=require('fs'),path=require('path'),{writeFileDurable}=require('./durable-write.js'),M=require('./authorized-auditor-measurement.js');
const root=path.resolve(String(process.env.STARNET_WORKSPACES||''));if(!process.env.STARNET_WORKSPACES||!path.isAbsolute(root))throw new Error('explicit absolute STARNET_WORKSPACES required');
const file=path.join(root,'pine-star.auditor-measurement-replacement-v1-receipt.json'),row=JSON.parse(fs.readFileSync(file,'utf8'));
if(row.planId!==M.PLAN.planId||row.planDigest!==M.PLAN_DIGEST||row.state!=='completed'||!row.result||!row.evaluationReportId)throw new Error('exact completed replacement receipt required');
writeFileDurable({fs,path},file,JSON.stringify(Object.assign({},row,M.receiptProvenance()),null,2));console.log(JSON.stringify({planId:row.planId,state:row.state,provenance:M.receiptProvenance()},null,2));
