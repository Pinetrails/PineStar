/* sidecar/capability/capsummary.js -- summarizeCapabilities: a SHORT, truthful "what you can and
   can't do right now" note appended to the agent's system prompt, derived from the SAME resolved
   grant set the tool gate enforces (resolveTools). Purpose: stop the agent VERBALLY over-promising
   capabilities it lacks, while also preventing the opposite failure: hiding real built-ins the run
   host actually granted.

   Interactive surface only: that is where the floor is real and the Commander can place objects.
   Autonomous/headless runs keep the full default office and have no placement UI, so they get no note. */

'use strict';

// capId -> plain-English power + the object/role that grants it. Order = display order.
// Static capIds come from CAP_REGISTRY. MCP connector tools are dynamic and therefore detected from
// resolved.tools below.
const CAPS = [
  { id: 'orchestrator', have: 'delegate to crew, spawn subagents, summon specialists, and create routines', object: 'the lead ORCHESTRATOR role' },
  { id: 'web', have: 'search/fetch the web and use the controlled browser', object: 'a DISH' },
  { id: 'cabinet', have: 'read and write files', object: 'a CABINET' },
  { id: 'workbench', have: 'run shell commands, verify code, and control the desktop computer', object: 'a WORKBENCH' },
  { id: 'memory', have: 'keep long-term memory, task plans, reusable skills, and recall conversation history', object: 'a NOTEBOOK' },
  { id: 'studio', have: 'generate and analyze images', object: 'a STUDIO' },
  { id: 'jukebox', have: 'search and control Spotify', object: 'a JUKEBOX' }
];

// The powers a Commander most often assumes an agent has -> highest over-promise risk -> nag if absent.
const CORE = ['web', 'cabinet', 'workbench'];

function summarizeCapabilities(resolved, opts) {
  opts = opts || {};
  if (opts.surface && opts.surface !== 'interactive') return ''; // autonomous keeps the full office; no placement UI

  const present = new Set(((resolved && resolved.grants) || []).map((g) => g && g.capId).filter(Boolean));
  const toolNames = Array.isArray(resolved && resolved.tools) ? resolved.tools : [];
  const hasConnectorTools = toolNames.some((t) => /^mcp__/.test(String(t || '')));
  const have = CAPS.filter((c) => present.has(c.id));
  const lackCore = CAPS.filter((c) => CORE.indexOf(c.id) !== -1 && !present.has(c.id));

  const havePhrases = have.map((c) => c.have);
  if (hasConnectorTools) havePhrases.push('use live MCP connector tools listed above');
  const haveStr = havePhrases.length ? havePhrases.join(', ') : 'think and reply (no tools are placed yet)';

  let note = '\n<capabilities_ground_truth>\n' +
    'These are your REAL powers this run, decided by the objects placed on your station floor and host-granted station roles -- not aspirational. ' +
    'This block is AUTHORITATIVE: if anything earlier in your instructions implies you always have web or file access, ignore it -- what follows is what you ACTUALLY have right now:\n' +
    '- You CAN: ' + haveStr + '.\n';
  if (lackCore.length) {
    note += '- You do NOT have: ' + lackCore.map((c) => c.have).join(', ') + '.\n' +
      'If the Commander asks for something you lack, do NOT claim, promise, or pretend to do it. Say plainly you can\'t yet, ' +
      'and name the object to place to grant it: ' +
      lackCore.map((c) => c.have + ' -> place ' + c.object).join('; ') + '. ' +
      'You can always think and reply; that needs nothing.\n';
  }
  note += '</capabilities_ground_truth>';
  return note;
}

module.exports = { summarizeCapabilities };
