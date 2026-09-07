'use strict';
// PS-2026-071: prospective, mechanically explicit Auditor contract. It cannot execute models or alter v1 evidence.
const CONTRACT = Object.freeze({ version: 'auditor-json-audit-v2', tasks: Object.freeze({
  'objective-store-audit-v2': Object.freeze({ inputShape: 'top-level JSON array', recordCount: 'top-level array length' }),
  'shared-report-audit-v2': Object.freeze({ inputShape: 'top-level JSON array', recordCount: 'top-level array length' }),
  'runtime-roster-audit-v2': Object.freeze({ inputShape: 'JSON object with an agents array', recordCount: '$.agents array length' })
}) });

function expected(taskId, bytes, champion) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch (_) { return { validJson: false, recordCount: 0, issueCount: 1, evidenceRefs: ['$:invalid-json'] }; }
  const refs = [];
  if (taskId === 'objective-store-audit-v2') {
    const rows = Array.isArray(data) ? data : [];
    if (!Array.isArray(data)) refs.push('$:expected-array');
    rows.forEach((row, i) => {
      if (!row || row.schema !== 'pine-star.objective.v1' || !row.id || !row.status) refs.push('$[' + i + ']:schema-state');
      if (row && row.status === 'completed' && !(Array.isArray(row.completionEvidenceRefs) && row.completionEvidenceRefs.length)) refs.push('$[' + i + ']:missing-completion-evidence');
    });
    return { validJson: true, recordCount: rows.length, issueCount: refs.length, evidenceRefs: refs };
  }
  if (taskId === 'shared-report-audit-v2') {
    const rows = Array.isArray(data) ? data : [];
    if (!Array.isArray(data)) refs.push('$:expected-array');
    rows.forEach((row, i) => {
      if (!row || !row.id || !row.type) refs.push('$[' + i + ']:schema');
      (Array.isArray(row && row.sourceRefs) ? row.sourceRefs : []).forEach((ref, j) => {
        if (!String(ref || '').trim() || String(ref).length > 500) refs.push('$[' + i + '].sourceRefs[' + j + ']:invalid');
      });
    });
    return { validJson: true, recordCount: rows.length, issueCount: refs.length, evidenceRefs: refs };
  }
  if (taskId !== 'runtime-roster-audit-v2') throw new Error('unknown Auditor v2 task');
  const agents = Array.isArray(data && data.agents) ? data.agents : [];
  const audit = Array.isArray(data && data.configurationAudit) ? data.configurationAudit : [];
  if (!data || !Array.isArray(data.agents)) refs.push('$.agents:expected-array');
  const agent = agents.find((row) => row && Array.isArray(row.systemRoleIds) && row.systemRoleIds.includes('operations.auditor'));
  if (!agent || !champion || agent.configurationId !== champion.configurationId || agent.provider !== champion.provider || agent.model !== champion.model) refs.push('$.agents:champion-binding');
  const last = audit[audit.length - 1];
  const snap = last && Array.isArray(last.configurations) && last.configurations.find((row) => row.agentId === (agent && agent.agentId));
  if (!snap || snap.configurationId !== (agent && agent.configurationId) || snap.provider !== (agent && agent.provider) || snap.model !== (agent && agent.model)) refs.push('$.configurationAudit:inconsistent');
  return { validJson: true, recordCount: agents.length, issueCount: refs.length, evidenceRefs: refs };
}

function instruction(taskId, inputHash, champion) {
  const task = CONTRACT.tasks[taskId];
  if (!task) throw new Error('unknown Auditor v2 task');
  const rules = ['Contract: ' + CONTRACT.version + '.', 'Task: ' + taskId + '.', 'Input SHA-256: ' + inputHash + '.', 'Input shape: ' + task.inputShape + '.', 'recordCount means ' + task.recordCount + '.', 'issueCount must equal evidenceRefs.length. evidenceRefs contains only exact issue markers defined below, in input order.', 'Return exactly one raw JSON object and no prose or Markdown fences.', 'Use exactly these keys and types: {"validJson":boolean,"recordCount":nonnegative integer,"issueCount":nonnegative integer,"evidenceRefs":string[]}.', 'Invalid JSON result: {"validJson":false,"recordCount":0,"issueCount":1,"evidenceRefs":["$:invalid-json"]}.'];
  if (taskId === 'objective-store-audit-v2') rules.push('Issues: $:expected-array when the top level is not an array; $[i]:schema-state when row i lacks schema pine-star.objective.v1, id, or status; $[i]:missing-completion-evidence when a completed row lacks a nonempty completionEvidenceRefs array.');
  if (taskId === 'shared-report-audit-v2') rules.push('Issues: $:expected-array when the top level is not an array; $[i]:schema when row i lacks id or type; $[i].sourceRefs[j]:invalid when a present sourceRefs entry is blank or longer than 500 characters.');
  if (taskId === 'runtime-roster-audit-v2') rules.push('Expected champion: ' + champion.configurationId + ' / ' + champion.provider + ' / ' + champion.model + '. Issues: $.agents:expected-array when agents is not an array; $.agents:champion-binding when the operations.auditor row is absent or does not exactly match that champion; $.configurationAudit:inconsistent when the last audit snapshot lacks that agent or disagrees with its configurationId, provider, or model.');
  rules.push('Inspect only the supplied snapshot. Do not use tools, network, or external actions.');
  return rules.join('\n');
}

function parseModel(text) {
  try {
    const value = JSON.parse(String(text || '').trim());
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
    if (JSON.stringify(keys) !== JSON.stringify(['evidenceRefs', 'issueCount', 'recordCount', 'validJson'])) return null;
    if (typeof value.validJson !== 'boolean' || !Number.isInteger(value.recordCount) || value.recordCount < 0 || !Number.isInteger(value.issueCount) || value.issueCount < 0 || !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every((ref) => typeof ref === 'string') || value.issueCount !== value.evidenceRefs.length) return null;
    return value;
  } catch (_) { return null; }
}
module.exports = { CONTRACT, expected, instruction, parseModel };
