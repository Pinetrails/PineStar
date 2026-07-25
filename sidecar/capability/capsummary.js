/* sidecar/capability/capsummary.js -- summarizeCapabilities: a SHORT, truthful "what you can and
   can't do right now" note appended to the agent's system prompt, derived from the SAME resolved
   grant set the tool gate enforces (resolveTools + enforceRunAuthority). Purpose: stop the agent
   VERBALLY over-promising capabilities it lacks, while also preventing the opposite failure: hiding
   real built-ins the run host actually granted.

   BOTH surfaces get a note, for different reasons:
   - INTERACTIVE: the floor is real, so a missing power is actionable -- name the object to place.
   - AUTONOMOUS/headless (cron, night shift, delegated workers, chat channels): there is no placement
     UI and no Commander watching, and enforceRunAuthority additionally strips shell/verify, live MCP
     connector tools, and Spotify on this surface REGARDLESS of what is placed. Sending no note at all
     left those runs believing they had powers the gate had already removed -- the agent then promised
     work it could not do and blamed the failure on the user's credentials. So the autonomous note
     states the same ground truth minus the (meaningless) placement advice, and tells the agent to
     report the blocker instead of pretending.

   A capId is NOT sufficient evidence of its headline power: a capId can outlive its own flagship tool
   (an autonomous run keeps workbench's background-shell and browser-test tools while shell.exec and
   verify.run are stripped). So when the caller supplies the resolved tool list -- production always
   does -- presence is confirmed against the capability's PROBE tool, not merely its capId. */

'use strict';

// capId -> plain-English power + the object/role that grants it. Order = display order.
// `probe` is the capability's HEADLINE tool: the one whose survival actually justifies the prose.
// Static capIds + probes come from CAP_REGISTRY. MCP connector tools are dynamic and therefore
// detected from resolved.tools below.
const CAPS = [
  { id: 'orchestrator', probe: 'team.dispatch',   have: 'delegate to crew, spawn subagents, summon specialists, and create routines', object: 'the lead ORCHESTRATOR role' },
  { id: 'web',          probe: 'web_search',      have: 'search/fetch the web and use the controlled browser', object: 'a DISH' },
  { id: 'cabinet',      probe: 'fs.read',         have: 'read and write files', object: 'a CABINET' },
  // NOT "control the desktop computer": computer.use/desktop.open carry no capability grant at all and are
  // stripped unconditionally by enforceSyntheticOnly, so claiming desktop control here was a standing lie.
  { id: 'workbench',    probe: 'shell.exec',      have: 'run shell commands and verify code', object: 'a WORKBENCH' },
  { id: 'memory',       probe: 'notebook.write',  have: 'keep long-term memory, task plans, reusable skills, and recall conversation history', object: 'a NOTEBOOK' },
  { id: 'studio',       probe: 'image_generate',  have: 'generate and analyze images', object: 'a STUDIO' },
  { id: 'jukebox',      probe: 'spotify_play',    have: 'search and control Spotify', object: 'a JUKEBOX' }
];

// The powers a Commander most often assumes an agent has -> highest over-promise risk -> nag if absent.
const CORE = ['web', 'cabinet', 'workbench'];

function summarizeCapabilities(resolved, opts) {
  opts = opts || {};
  const interactive = !opts.surface || opts.surface === 'interactive';

  const capIds = new Set(((resolved && resolved.grants) || []).map((g) => g && g.capId).filter(Boolean));
  const toolNames = Array.isArray(resolved && resolved.tools) ? resolved.tools : [];
  // Only trust the tool list as evidence when the caller actually supplied one; a grants-only caller
  // (older callers and unit fixtures) still resolves by capId alone.
  const byTool = toolNames.length > 0;
  const holds = (c) => capIds.has(c.id) && (!byTool || toolNames.indexOf(c.probe) !== -1);

  const hasConnectorTools = toolNames.some((t) => /^mcp__/.test(String(t || '')));
  const have = CAPS.filter(holds);
  const lackCore = CAPS.filter((c) => CORE.indexOf(c.id) !== -1 && !holds(c));

  const havePhrases = have.map((c) => c.have);
  if (hasConnectorTools) havePhrases.push('use live MCP connector tools listed above');
  const haveStr = havePhrases.length
    ? havePhrases.join(', ')
    : (interactive ? 'think and reply (no tools are placed yet)' : 'think and reply (no tools are available on this run)');

  let note = '\n<capabilities_ground_truth>\n' +
    'These are your REAL powers this run, decided by the objects placed on your station floor and host-granted station roles -- not aspirational. ' +
    'This block is AUTHORITATIVE: if anything earlier in your instructions implies you always have web or file access, ignore it -- what follows is what you ACTUALLY have right now:\n' +
    '- You CAN: ' + haveStr + '.\n';

  if (lackCore.length) {
    note += '- You do NOT have: ' + lackCore.map((c) => c.have).join(', ') + '.\n';
    if (interactive) {
      note += 'If the Commander asks for something you lack, do NOT claim, promise, or pretend to do it. Say plainly you can\'t yet, ' +
        'and name the object to place to grant it: ' +
        lackCore.map((c) => c.have + ' -> place ' + c.object).join('; ') + '. ' +
        'You can always think and reply; that needs nothing.\n';
    } else {
      note += 'This is an UNATTENDED run: no Commander is watching, so shell/terminal, desktop control and live connector tools ' +
        'are unavailable on this surface by design -- they require a watched session to approve. Placing objects cannot change that here. ' +
        'Do NOT claim, promise, or pretend to do what you lack, and do NOT blame missing credentials for a power you were never granted. ' +
        'Do everything you genuinely can, then state plainly what you could not do and why, so the Commander can finish it in a watched session.\n';
    }
  }

  note += '</capabilities_ground_truth>';
  return note;
}

module.exports = { summarizeCapabilities };
