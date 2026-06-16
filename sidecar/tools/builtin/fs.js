/* sidecar/tools/builtin/fs.js — the CABINET capability: fs.read / fs.write / fs.list,
   jailed to <root>/<agentId>/. The path guard is the security spine: every model- or
   user-supplied path is resolved and PROVEN to stay inside the agent's workspace before any
   I/O. Node-only (node:path + node:fs/promises injected for testability). Matches the
   notebook.js / web.js tool shape.

   makeFsTools({ fsp, pathMod, root, limits }) -> { writeTool, readTool, listTool, register(reg) }
     fsp     : node:fs/promises (injectable)
     pathMod : node:path        (injectable)
     root    : absolute path to .../workspaces
     limits  : { writeBytes=1<<20, readReturn=200_000 } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).fs = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function safeAgentId(id) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id || '')) throw new Error('bad agentId');
    return id;
  }
  // require an explicit agentId: silently defaulting every un-attributed call to a shared 'agent' bucket
  // would merge two agents' workspaces — the exact silent cross-agent data loss the project forbids.
  function reqAgentId(ctx) {
    const aid = ctx && ctx.agentId;
    if (!aid) throw new Error('fs tool requires ctx.agentId — refusing to fall back to a shared workspace');
    return aid;
  }
  function kb(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function emitDeliverable(ctx, aid, pathStr) {
    if (!ctx || typeof ctx.emit !== 'function') return;
    const d = { id: 'file_' + String(pathStr).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'file', title: String(pathStr) };
    if (ctx.room) d.room = ctx.room;
    ctx.emit('deliverable', d);
  }

  function makeFsTools(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root;
    if (!fsp || !P || !ROOT) throw new Error('fs.js requires { fsp, pathMod, root }');
    const WRITE_BYTES = (deps.limits && deps.limits.writeBytes) || (1 << 20);
    const READ_RETURN = (deps.limits && deps.limits.readReturn) || 200000;

    async function workspaceRoot(agentId) {
      const dir = P.join(ROOT, safeAgentId(agentId));   // safeAgentId rejects a missing/invalid id — no shared default bucket
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    }
    // realpath the deepest EXISTING ancestor of `abs` (the target itself may not exist yet, e.g. a fresh write),
    // then re-append the not-yet-created tail, so a symlink/junction anywhere up the chain resolves to its real target.
    async function realCanonical(abs) {
      const tail = [];
      let cur = abs;
      for (;;) {
        try { const real = await fsp.realpath(cur); return tail.length ? P.join(real, ...tail.reverse()) : real; }
        catch (e) {
          if (!(e && e.code === 'ENOENT')) return abs;     // permission/other: fall back to the lexical path (already prefix-checked)
          const parent = P.dirname(cur);
          if (parent === cur) return abs;                  // reached the filesystem root without resolving anything
          tail.push(P.basename(cur)); cur = parent;
        }
      }
    }
    // Resolve a relative path and PROVE it stays inside the agent's workspace — lexically AND, when realpath is
    // available, after canonicalising symlinks (a pre-existing link inside the jail must not point outside it).
    async function resolveInside(agentId, rel) {
      rel = String(rel == null ? '' : rel);
      if (P.isAbsolute(rel) || /(^|[\\/])\.\.([\\/]|$)/.test(rel) || /^[A-Za-z]:/.test(rel) || rel.indexOf('\0') >= 0)
        throw new Error('illegal path: ' + rel);
      const base = await workspaceRoot(agentId);
      const abs = P.resolve(base, rel || '.');
      if (abs !== base && abs.indexOf(base + P.sep) !== 0) throw new Error('path escapes workspace');
      if (typeof fsp.realpath === 'function') {
        let realBase; try { realBase = await fsp.realpath(base); } catch (_) { realBase = base; }
        const realAbs = await realCanonical(abs);
        if (realAbs !== realBase && realAbs.indexOf(realBase + P.sep) !== 0) throw new Error('path escapes workspace (symlink)');
      }
      return { base, abs };
    }

    const writeTool = {
      name: 'fs.write', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Write a UTF-8 text file into your workspace. This is where your deliverables (reports, notes, code) are saved.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = reqAgentId(ctx);
        const { abs } = await resolveInside(aid, args.path);
        const data = Buffer.from(String(args.content), 'utf8');
        if (data.length > WRITE_BYTES) throw new Error('file too large (' + data.length + ' > ' + WRITE_BYTES + ' bytes)');
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, data);
        emitDeliverable(ctx, aid, args.path);
        return { content: 'Wrote ' + args.path + ' (' + data.length + ' bytes).', summary: 'wrote ' + args.path + ' (' + kb(data.length) + ')' };
      }
    };

    const readTool = {
      name: 'fs.read', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 10000,
      description: 'Read a UTF-8 text file from your workspace.',
      schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      run: async (args, ctx) => {
        const { abs } = await resolveInside(reqAgentId(ctx), args.path);
        let txt;
        try { txt = await fsp.readFile(abs, 'utf8'); }
        catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); throw e; }
        const out = txt.length > READ_RETURN ? txt.slice(0, READ_RETURN) + '\n…[truncated]' : txt;
        return { content: out, summary: kb(Buffer.byteLength(txt)) + ' read' };
      }
    };

    // recursive directory walk -> relative paths (dirs end with '/'), bounded so a huge tree can't flood the prompt
    async function walk(absDir, prefix, out, limit) {
      if (out.length >= limit) return;
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
      for (const ent of entries) {
        if (out.length >= limit) { out.push('…[truncated]'); return; }
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        if (ent.isDirectory()) { out.push(rel + '/'); await walk(P.join(absDir, ent.name), rel, out, limit); }
        else out.push(rel);
      }
    }

    const listTool = {
      name: 'fs.list', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 8000,
      description: 'List files in your workspace. Pass { "recursive": true } to see the whole tree (directories end with "/"); optional "path" lists one subdirectory.',
      schema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
      run: async (args, ctx) => {
        const { abs } = await resolveInside(reqAgentId(ctx), (args && args.path) || '.');
        if (args && args.recursive) {
          const out = []; await walk(abs, '', out, 500);
          return { content: out.length ? out.join('\n') : '(empty)', summary: out.length + ' entr' + (out.length === 1 ? 'y' : 'ies') };
        }
        let names;
        try { names = await fsp.readdir(abs); }
        catch (e) { if (e && e.code === 'ENOENT') return { content: '(empty)', summary: '0 files' }; throw e; }
        return { content: names.length ? names.join('\n') : '(empty)', summary: names.length + ' file(s)' };
      }
    };

    const appendTool = {
      name: 'fs.append', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Append UTF-8 text to a workspace file (creates it if missing) WITHOUT rewriting what is already there. Use this to add to a file you are building up.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = reqAgentId(ctx);
        const { abs } = await resolveInside(aid, args.path);
        let existing = '';
        try { existing = await fsp.readFile(abs, 'utf8'); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
        const combined = existing + String(args.content);
        const bytes = Buffer.byteLength(combined, 'utf8');
        if (bytes > WRITE_BYTES) throw new Error('file too large after append (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, Buffer.from(combined, 'utf8'));
        emitDeliverable(ctx, aid, args.path);
        const added = Buffer.byteLength(String(args.content), 'utf8');
        return { content: 'Appended to ' + args.path + ' (+' + added + ' bytes, now ' + bytes + ').', summary: 'appended ' + args.path + ' (+' + kb(added) + ')' };
      }
    };

    const editTool = {
      name: 'fs.edit', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Edit a workspace file by exact text replacement: every occurrence of "find" becomes "replace". Errors if "find" is absent — read the file first so your "find" matches exactly.',
      schema: { type: 'object', required: ['path', 'find', 'replace'], properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = reqAgentId(ctx);
        const { abs } = await resolveInside(aid, args.path);
        let txt;
        try { txt = await fsp.readFile(abs, 'utf8'); }
        catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); throw e; }
        const find = String(args.find);
        if (!find) throw new Error('"find" must be a non-empty string');
        if (txt.indexOf(find) < 0) throw new Error('"find" text not found in ' + args.path + ' — read the file and match it exactly');
        const count = txt.split(find).length - 1;
        const next = txt.split(find).join(String(args.replace));
        const bytes = Buffer.byteLength(next, 'utf8');
        if (bytes > WRITE_BYTES) throw new Error('file too large after edit (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        await fsp.writeFile(abs, Buffer.from(next, 'utf8'));
        emitDeliverable(ctx, aid, args.path);
        return { content: 'Edited ' + args.path + ' (' + count + ' replacement' + (count === 1 ? '' : 's') + ').', summary: 'edited ' + args.path + ' (' + count + 'x)' };
      }
    };

    return {
      writeTool, readTool, listTool, appendTool, editTool,
      _internals: { resolveInside, workspaceRoot, safeAgentId, walk },
      register(reg) { [writeTool, readTool, listTool, appendTool, editTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeFsTools };
});
