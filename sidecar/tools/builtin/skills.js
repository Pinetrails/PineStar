/* sidecar/tools/builtin/skills.js - runtime skill library tools.

   skill.list and skill.view provide progressive disclosure. skill.manage is
   the Hermes-style lifecycle surface. skill.write remains as a compatibility
   wrapper for simple create/update flows.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).skills = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fileLabel(files) {
    return files && files.length ? ('; files: ' + files.map(f => f.path).join(', ')) : '';
  }
  function emitSkill(ctx, skill) {
    if (ctx && typeof ctx.emit === 'function' && skill) {
      try { ctx.emit('deliverable', { id: skill.id, agentId: skill.agentId || ((ctx && ctx.agentId) || 'agent'), kind: 'skill', title: skill.name }); } catch (_) {}
    }
  }

  function makeSkillTools(deps) {
    const store = deps && deps.store;

    const writeTool = {
      name: 'skill.write', capability: 'memory', scope: 'write', requiresConsent: false,
      description: 'Save or update a reusable SKILL: a named, multi-step procedure you can reload later. Use skill.manage for patch/archive/support-file lifecycle work.',
      schema: {
        type: 'object', required: ['name', 'body'],
        properties: {
          name: { type: 'string', description: 'a short title, e.g. "Deploy the site"' },
          summary: { type: 'string', description: 'one line: what this skill does and when to use it' },
          body: { type: 'string', description: 'the full multi-step procedure' },
          category: { type: 'string' }
        }
      },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const aid = (ctx && ctx.agentId) || 'agent';
        const r = store.write({
          agentId: aid, name: args && args.name, summary: args && args.summary, body: args && args.body,
          category: args && args.category, createdBy: 'agent', sourceRunId: ctx && ctx.runId
        });
        if (!r.ok) return { content: 'Could not save the skill: ' + r.error, summary: 'not saved' };
        emitSkill(ctx, r.skill);
        return { content: (r.edited ? 'Updated' : 'Saved') + ' skill "' + r.skill.name + '". Reload it anytime with skill.view.', summary: r.edited ? 'edited' : 'saved' };
      }
    };

    const manageTool = {
      name: 'skill.manage', capability: 'memory', scope: 'write', requiresConsent: false,
      description: 'Create, edit, patch, archive, restore, pin, or attach support files for saved skills. Prefer patching or updating an existing skill before creating a duplicate.',
      schema: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['create', 'edit', 'patch', 'archive', 'delete', 'restore', 'pin', 'unpin', 'write_file', 'remove_file'] },
          target: { type: 'string', description: 'existing skill name or id for all non-create actions' },
          id: { type: 'string' },
          name: { type: 'string', description: 'skill name for create, or lookup fallback for existing actions' },
          summary: { type: 'string' },
          body: { type: 'string' },
          category: { type: 'string' },
          requires: { type: 'array', items: { type: 'string' } },
          find: { type: 'string', description: 'text to find when action=patch' },
          replace: { type: 'string', description: 'replacement text when action=patch' },
          path: { type: 'string', description: 'support file path under references/, templates/, scripts/, or assets/' },
          content: { type: 'string', description: 'support file content when action=write_file' },
          pinned: { type: 'boolean' }
        }
      },
      run: (args, ctx) => {
        if (!store || typeof store.manage !== 'function') return { content: 'The skill manager is unavailable.', summary: 'unavailable' };
        const aid = (ctx && ctx.agentId) || 'agent';
        const r = store.manage(Object.assign({}, args || {}, { agentId: aid, createdBy: 'agent', sourceRunId: ctx && ctx.runId }));
        if (!r.ok) return { content: 'Could not manage the skill: ' + r.error, summary: 'not saved' };
        emitSkill(ctx, r.skill);
        const action = r.action || (args && args.action) || 'updated';
        const path = r.path ? (' (' + r.path + ')') : '';
        return { content: 'Skill "' + r.skill.name + '" ' + action.replace(/_/g, ' ') + ' complete' + path + '.', summary: action };
      }
    };

    const listTool = {
      name: 'skill.list', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'List your saved skills: names, one-line summaries, state, and usage only. Load the full procedure with skill.view before using it.',
      schema: { type: 'object', properties: { includeArchived: { type: 'boolean' } } },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const list = store.list((ctx && ctx.agentId) || 'agent', { includeArchived: !!(args && args.includeArchived) });
        if (!list.length) return { content: 'No skills saved yet. Save one with skill.manage after you work out a repeatable procedure.', summary: '0 skills' };
        return {
          content: list.map(s => '- ' + s.name + (s.summary ? ' -- ' + s.summary : '') + ' [' + (s.state || 'active') + ', used ' + (s.useCount || 0) + 'x' + fileLabel(s.files) + ']').join('\n'),
          summary: list.length + ' skill(s)'
        };
      }
    };

    const viewTool = {
      name: 'skill.view', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Load the full step-by-step body of one saved skill by name or id. Call this whenever a saved skill may apply.',
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const v = store.view((ctx && ctx.agentId) || 'agent', args && args.name);
        if (!v) return { content: 'No skill named "' + (args && args.name) + '". Use skill.list to see what you have.', summary: 'not found' };
        const files = v.files && v.files.length
          ? '\n\nSupport files:\n' + v.files.map(f => '- ' + f.path + (f.content ? '\n' + f.content : '')).join('\n')
          : '';
        return { content: '# ' + v.name + (v.summary ? '\n' + v.summary : '') + '\n\n' + v.body + files, summary: 'loaded ' + v.name };
      }
    };

    return {
      writeTool, manageTool, listTool, viewTool,
      register(reg) { reg.register(writeTool); reg.register(manageTool); reg.register(listTool); reg.register(viewTool); return reg; }
    };
  }

  return { makeSkillTools };
});
