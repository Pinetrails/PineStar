'use strict';
const RULES = [
  { re: /\b(coordinate|orchestrate|multi[- ]step|across teams|decompose)\b/i, caps: ['coordinate'] },
  { re: /\b(open[- ]source|github|repository|library|package)\b/i, caps: ['discover_open_source', 'research', 'recommend'] },
  { re: /\b(audit|review|inspect|compliance)\b/i, caps: ['audit', 'verify'] },
  { re: /\b(debug|bug|fix|implement|code|software)\b/i, caps: ['code', 'test'] },
  { re: /\b(research|investigate|compare|source|summari[sz]e)\b/i, caps: ['research', 'verify'] }
];
function classifyObjective(input) {
  const row = input && typeof input === 'object' ? input : {}, explicit = Array.isArray(row.requiredCapabilities) ? row.requiredCapabilities.map(String).filter(Boolean) : [];
  const haystack = String(row.title || '') + '\n' + String(row.description || '');
  let capabilities = [...new Set(explicit)];
  if (!capabilities.length) for (const rule of RULES) if (rule.re.test(haystack)) { capabilities = rule.caps.slice(); break; }
  return Object.assign({}, row, { requiredCapabilities: capabilities,
    priority: ['low', 'normal', 'high', 'urgent'].includes(row.priority) ? row.priority : 'normal',
    classification: { method: explicit.length ? 'declared' : 'deterministic-v1', matched: capabilities.length > 0 } });
}
module.exports = { classifyObjective, RULES };
