/* sidecar/tools/builtin/skills.js — the agent's reusable SKILL library tools (H4.2).

   Hermes ships skills_list / skill_view / skill_manage so the agent creates, lists, views (progressive
   disclosure), and edits named multi-step procedure documents at runtime. StarNet had only a memory KIND. These
   tools expose the skillstore.js artifact: skill.write (create/edit), skill.list (metadata only — name+summary),
   skill.view (full body on demand). Joins the NOTEBOOK (memory) capability — granted by the placed NOTEBOOK
   object alongside notebook.* + recall_conversation, so durable memory + the skill library appear together.

     makeSkillTools({ store }) -> { writeTool, listTool, viewTool, register(registry) }
   ctx supplies agentId at call time; skills are per-agent. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).skills = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeSkillTools(deps) {
    const store = deps && deps.store;

    const writeTool = {
      name: 'skill.write', capability: 'memory', scope: 'write', requiresConsent: false,
      description: 'Save (or update) a reusable SKILL — a named, multi-step procedure you can reload later: how to do '
        + 'a recurring task end-to-end. Use this for repeatable PROCEDURES (notebook is for durable facts). Writing '
        + 'the same name again edits it in place. Keep the summary one line; put the steps in the body.',
      schema: {
        type: 'object', required: ['name', 'body'],
        properties: {
          name: { type: 'string', description: 'a short title, e.g. "Deploy the site"' },
          summary: { type: 'string', description: 'one line: what this skill does + when to use it' },
          body: { type: 'string', description: 'the full multi-step procedure' }
        }
      },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const aid = (ctx && ctx.agentId) || 'agent';
        const r = store.write({ agentId: aid, name: args && args.name, summary: args && args.summary, body: args && args.body });
        if (!r.ok) return { content: 'Could not save the skill: ' + r.error, summary: 'not saved' };
        if (ctx && typeof ctx.emit === 'function') { try { ctx.emit('deliverable', { id: r.skill.id, agentId: aid, kind: 'skill', title: r.skill.name }); } catch (_) {} }
        return { content: (r.edited ? 'Updated' : 'Saved') + ' skill "' + r.skill.name + '". Reload it anytime with skill.view.', summary: r.edited ? 'edited' : 'saved' };
      }
    };

    const listTool = {
      name: 'skill.list', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'List your saved skills — names + one-line summaries only (load a full procedure with skill.view). '
        + 'Check here before doing a recurring task: you may already have a skill for it.',
      schema: { type: 'object', properties: {} },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const list = store.list((ctx && ctx.agentId) || 'agent');
        if (!list.length) return { content: 'No skills saved yet. Save one with skill.write when you work out a repeatable procedure.', summary: '0 skills' };
        return { content: list.map(s => '• ' + s.name + (s.summary ? ' — ' + s.summary : '')).join('\n'), summary: list.length + ' skill(s)' };
      }
    };

    const viewTool = {
      name: 'skill.view', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Load the full step-by-step body of one of your saved skills by its name (from skill.list).',
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const v = store.view((ctx && ctx.agentId) || 'agent', args && args.name);
        if (!v) return { content: 'No skill named "' + (args && args.name) + '". Use skill.list to see what you have.', summary: 'not found' };
        return { content: '# ' + v.name + (v.summary ? '\n' + v.summary : '') + '\n\n' + v.body, summary: 'loaded ' + v.name };
      }
    };

    return {
      writeTool, listTool, viewTool,
      register(reg) { reg.register(writeTool); reg.register(listTool); reg.register(viewTool); return reg; }
    };
  }

  return { makeSkillTools };
});
