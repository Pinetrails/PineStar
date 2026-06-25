/* sidecar/tools/builtin/skills.js - agent-owned skill package tools.

   Public names stay backward compatible:
     skill.write - create/edit SKILL.md, patch it, manage support files, archive
     skill.list  - metadata/search only
     skill.view  - load SKILL.md or one support file on demand */
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
      description: 'Save or update a reusable SKILL package: SKILL.md plus optional references/, templates/, scripts/, and assets/. Use for repeatable procedures, not durable facts. Modes: upsert/replace writes SKILL.md; patch appends to SKILL.md; write_file/remove_file manage support files; archive hides a skill.',
      schema: {
        type: 'object', required: ['name'],
        properties: {
          name: { type: 'string', description: 'short skill title, e.g. "Deploy the site"' },
          summary: { type: 'string', description: 'one line: what this skill does and when to use it' },
          body: { type: 'string', description: 'SKILL.md body for upsert/replace, or patch text for patch mode' },
          mode: { type: 'string', enum: ['upsert', 'replace', 'patch', 'write_file', 'remove_file', 'archive'] },
          path: { type: 'string', description: 'support path, e.g. references/api.md, templates/checklist.md, scripts/verify.sh, assets/example.json' },
          content: { type: 'string', description: 'file content for write_file, or patch text when body is omitted' },
          archived: { type: 'boolean', description: 'false unarchives when mode=archive; omitted archives' }
        }
      },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        args = args || {};
        const aid = (ctx && ctx.agentId) || 'agent';
        const mode = args.mode || 'upsert';
        let r;
        if (mode === 'patch') r = store.patch({ agentId: aid, name: args.name, summary: args.summary, patch: args.body || args.content });
        else if (mode === 'write_file') r = store.writeFile({ agentId: aid, name: args.name, summary: args.summary, path: args.path, content: args.content });
        else if (mode === 'remove_file') r = store.removeFile({ agentId: aid, name: args.name, path: args.path });
        else if (mode === 'archive') r = store.archive({ agentId: aid, name: args.name, archived: args.archived });
        else {
          if (args.body == null) return { content: 'Could not save the skill: SKILL.md body is required for ' + mode + '.', summary: 'not saved' };
          r = store.write({ agentId: aid, name: args.name, summary: args.summary, body: args.body });
        }
        if (!r.ok) return { content: 'Could not save the skill: ' + r.error, summary: 'not saved' };
        if (ctx && typeof ctx.emit === 'function') { try { ctx.emit('deliverable', { id: r.skill.id, agentId: aid, kind: 'skill', title: r.skill.name }); } catch (_) {} }
        if (mode === 'archive') return { content: (r.skill.archived ? 'Archived' : 'Unarchived') + ' skill "' + r.skill.name + '".', summary: r.skill.archived ? 'archived' : 'unarchived' };
        if (mode === 'write_file') return { content: 'Updated file "' + args.path + '" in skill "' + r.skill.name + '".', summary: 'file written' };
        if (mode === 'remove_file') return { content: 'Removed file "' + args.path + '" from skill "' + r.skill.name + '".', summary: 'file removed' };
        return { content: (r.edited ? 'Updated' : 'Saved') + ' skill "' + r.skill.name + '". Reload it anytime with skill.view.', summary: r.edited ? 'edited' : 'saved' };
      }
    };

    const listTool = {
      name: 'skill.list', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'List or search saved skills. Returns names, summaries, archive state, and file names only; load SKILL.md or support files with skill.view.',
      schema: { type: 'object', properties: { query: { type: 'string' }, includeArchived: { type: 'boolean' } } },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        args = args || {};
        const aid = (ctx && ctx.agentId) || 'agent';
        const list = args.query ? store.search(aid, args.query, { limit: 8 }) : store.list(aid, { includeArchived: !!args.includeArchived });
        if (!list.length) return { content: 'No skills saved yet. Save one with skill.write when you work out a repeatable procedure.', summary: '0 skills' };
        return { content: list.map(s => '- ' + s.name + (s.summary ? ' - ' + s.summary : '') + (s.archived ? ' [archived]' : '')).join('\n'), summary: list.length + ' skill(s)' };
      }
    };

    const viewTool = {
      name: 'skill.view', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Load SKILL.md for one saved skill, or load a support file by path.',
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, path: { type: 'string' } } },
      run: (args, ctx) => {
        if (!store) return { content: 'The skill library is unavailable.', summary: 'unavailable' };
        const v = store.view((ctx && ctx.agentId) || 'agent', args && args.name, args && args.path);
        if (!v) return { content: 'No skill named "' + (args && args.name) + '". Use skill.list to see what you have.', summary: 'not found' };
        if (v.file) return { content: '# ' + v.file.path + '\n\n' + v.file.content, summary: 'loaded ' + v.file.path };
        const files = Object.keys(v.files || {}).filter(p => p !== 'SKILL.md').sort();
        return { content: '# ' + v.name + (v.summary ? '\n' + v.summary : '') + '\n\n' + v.body + (files.length ? '\n\nFiles:\n' + files.map(p => '- ' + p).join('\n') : ''), summary: 'loaded ' + v.name };
      }
    };

    return {
      writeTool, listTool, viewTool,
      register(reg) { reg.register(writeTool); reg.register(listTool); reg.register(viewTool); return reg; }
    };
  }

  return { makeSkillTools };
});
