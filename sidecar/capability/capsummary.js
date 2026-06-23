/* sidecar/capability/capsummary.js — summarizeCapabilities: a SHORT, truthful "what you can and
   can't do right now" note appended to the agent's system prompt, derived from the SAME resolved
   grant set the tool gate enforces (resolveTools). Purpose: stop the agent VERBALLY over-promising
   capabilities it lacks — observed live, an agent with no DISH placed still said "i'll send the
   researcher out" to do web research it had no tool for, then would hit capdenied. This changes only
   what the agent honestly TELLS the Commander (and names the object to place to gain a missing power),
   never what it CAN do. Pure, emits nothing, node-testable.

   Interactive surface only: that is where the floor is real and the Commander can place objects.
   Autonomous/headless runs keep the full default office and have no placement UI, so they get no note. */

// capId -> plain-English power + the object that grants it. Order = display order. Matches CAP_REGISTRY
// (registry.js) and the frontend CAP_LABEL (worldmodel.js) so the prop, the power, and this note all agree.
// NOTE: only capIds that carry a STATIC registry grant appear in resolved.grants and can be detected here
// (web/cabinet/workbench/memory/studio). The 'connector' object grants DYNAMIC, server-named tools that union
// straight into resolved.tools (never resolved.grants) — the model already sees those in its tool schema, so
// there is no over-promising risk and they are intentionally not summarized here.
const CAPS = [
  { id: 'web',       have: 'search and fetch the web', object: 'a DISH' },
  { id: 'cabinet',   have: 'read and write files',     object: 'a CABINET' },
  { id: 'workbench', have: 'run shell commands',       object: 'a WORKBENCH' },
  { id: 'memory',    have: 'keep long-term memory',    object: 'a NOTEBOOK' },
  { id: 'studio',    have: 'generate and analyze images', object: 'a STUDIO' },
];
// the powers a Commander most often assumes an agent has → highest over-promise risk → nag if absent.
const CORE = ['web', 'cabinet', 'workbench'];

function summarizeCapabilities(resolved, opts) {
  opts = opts || {};
  if (opts.surface && opts.surface !== 'interactive') return '';   // autonomous keeps the full office; no placement UI
  const present = new Set(((resolved && resolved.grants) || []).map((g) => g && g.capId).filter(Boolean));
  const have = CAPS.filter((c) => present.has(c.id));
  const lackCore = CAPS.filter((c) => CORE.indexOf(c.id) !== -1 && !present.has(c.id));

  const haveStr = have.length ? have.map((c) => c.have).join(', ') : 'think and reply (no tools are placed yet)';
  let note = '\n<capabilities_ground_truth>\n' +
    'These are your REAL powers this run, decided by the objects placed on your station floor — not aspirational. ' +
    'This block is AUTHORITATIVE: if anything earlier in your instructions implies you always have web or file access, ignore it — what follows is what you ACTUALLY have right now:\n' +
    '- You CAN: ' + haveStr + '.\n';
  if (lackCore.length) {
    note += '- You do NOT have: ' + lackCore.map((c) => c.have).join(', ') + '.\n' +
      'If the Commander asks for something you lack, do NOT claim, promise, or pretend to do it. Say plainly you can\'t yet, ' +
      'and name the object to place to grant it: ' +
      lackCore.map((c) => c.have + ' → place ' + c.object).join('; ') + '. ' +
      'You can always think and reply; that needs nothing.\n';
  }
  note += '</capabilities_ground_truth>';
  return note;
}

module.exports = { summarizeCapabilities };
