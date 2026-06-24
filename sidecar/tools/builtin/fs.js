/* sidecar/tools/builtin/fs.js — the CABINET capability: fs.read / fs.write / fs.list /
   fs.append / fs.edit / fs.search, jailed to <root>/<agentId>/. The path guard is the
   security spine: every model- or user-supplied path is resolved and PROVEN to stay inside
   the agent's workspace before any I/O. Node-only (node:path + node:fs/promises injected for
   testability). Matches the notebook.js / web.js tool shape.

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

  // G5.2 fs.patch deps: the V4A parser + the fuzzy matcher (G5.1). Loaded the same UMD way as
  // image.js loads fs.js — require in Node, fall back to the global SK namespace in a browser
  // (fs.js never runs in a browser today, but keep the UMD shape consistent / fail-soft).
  let parseV4APatch = null, fuzzyFindAndReplace = null;
  if (typeof require === 'function') {
    try { parseV4APatch = require('./patchparse.js').parseV4APatch; } catch (_) {}
    try { fuzzyFindAndReplace = require('./fuzzymatch.js').fuzzyFindAndReplace; } catch (_) {}
  }
  if (!parseV4APatch && typeof globalThis !== 'undefined' && globalThis.SK && globalThis.SK.tools && globalThis.SK.tools.builtin) {
    const b = globalThis.SK.tools.builtin;
    if (b.patchparse) parseV4APatch = b.patchparse.parseV4APatch;
    if (b.fuzzymatch) fuzzyFindAndReplace = b.fuzzymatch.fuzzyFindAndReplace;
  }

  function safeAgentId(id) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id || '')) throw new Error('bad agentId');
    return id;
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
    const redact = deps.redact || ((s) => s);   // §5.6: scrub secrets out of any surfaced search line (optional, default identity)

    async function workspaceRoot(agentId) {
      const dir = P.join(ROOT, safeAgentId(agentId || 'agent'));
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    }
    // Resolve a relative path and PROVE it stays inside the agent's workspace.
    async function resolveInside(agentId, rel) {
      rel = String(rel == null ? '' : rel);
      if (P.isAbsolute(rel) || /(^|[\\/])\.\.([\\/]|$)/.test(rel) || /^[A-Za-z]:/.test(rel) || rel.indexOf('\0') >= 0)
        throw new Error('illegal path: ' + rel);
      const base = await workspaceRoot(agentId);
      const abs = P.resolve(base, rel || '.');
      if (abs !== base && abs.indexOf(base + P.sep) !== 0) throw new Error('path escapes workspace');
      return { base, abs };
    }

    const writeTool = {
      name: 'fs.write', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Write a UTF-8 text file into your workspace. This is where your deliverables (reports, notes, code) are saved.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
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
        const { abs } = await resolveInside((ctx && ctx.agentId) || 'agent', args.path);
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
        const { abs } = await resolveInside((ctx && ctx.agentId) || 'agent', (args && args.path) || '.');
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
        const aid = (ctx && ctx.agentId) || 'agent';
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
        const aid = (ctx && ctx.agentId) || 'agent';
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

    // fs.search — a ripgrep-grade content/file search over the agent's workspace, in PURE Node (no `rg`
    // dependency, so it runs on a clean machine — our "bundle Node, no system deps" rule). Mirrors the
    // polished behaviour of a grep+find+ls replacement: target 'content' (grep) | 'files' (find/ls by glob,
    // newest-first); output_mode 'content'|'files_only'|'count'; file_glob filter; context lines; limit/offset
    // paging with an actionable next-offset hint; path-grouped ("densified") output above a few matches.
    // Jailed + bounded like every fs.* tool: skips hidden entries (rg default) + node_modules, oversized +
    // binary files, caps files scanned; redacts secrets out of every surfaced line (§5.6).
    const SEARCH_MAX_FILE_BYTES = 512 * 1024, SEARCH_MAX_FILES = 4000, SEARCH_LINE_CHARS = 500, SEARCH_DENSIFY_MIN = 5;

    // glob -> RegExp over a whole string. `*` = any run except '/', `**` = any run, `?` = one non-'/'.
    function globToRe(glob, ic) {
      const g = String(glob); let re = '';
      for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; } }
        else if (c === '?') { re += '[^/]'; }
        else if ('\\^$.|+()[]{}'.indexOf(c) >= 0) { re += '\\' + c; }
        else { re += c; }
      }
      return new RegExp('^' + re + '$', ic ? 'i' : '');
    }
    // recursive file walk -> acc of { rel, abs, mtimeMs }; rel is workspace-root-relative (feeds fs.read).
    // Skips hidden entries + node_modules; never leaves the jailed base; bounded by SEARCH_MAX_FILES.
    async function collectFiles(absDir, prefix, acc, stats) {
      if (stats.files >= SEARCH_MAX_FILES) { stats.truncated = true; return; }
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (stats.files >= SEARCH_MAX_FILES) { stats.truncated = true; return; }
        if (ent.name.charAt(0) === '.') continue;                 // hidden (matches ripgrep's default)
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        const abs = P.join(absDir, ent.name);
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') await collectFiles(abs, rel, acc, stats); continue; }
        let st; try { st = await fsp.stat(abs); } catch (e) { continue; }
        stats.files++; acc.push({ rel, abs, mtimeMs: st.mtimeMs || 0 });
      }
    }
    function searchHint(truncated, offset, limit, total) {
      return truncated ? ('\n\n[truncated — ' + total + '+ results shown so far; pass offset=' + (offset + limit) + ' for the next page, or narrow with file_glob / a more specific query]') : '';
    }
    function clipLine(s) { s = redact(String(s == null ? '' : s)).replace(/\s+$/, ''); return s.length > SEARCH_LINE_CHARS ? s.slice(0, SEARCH_LINE_CHARS) + '…' : s; }

    const searchTool = {
      name: 'fs.search', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 20000,
      description: 'Search your workspace — use this instead of grep/find/ls. Two modes via "target":\n• target:"content" (default) — find TEXT inside files. Substring by default; { "regex": true } treats "query" as a regex, { "ignoreCase": true } ignores case. "file_glob" limits which files are searched (e.g. "*.md"); "context" adds N lines around each hit; "output_mode" is "content" (matching lines, default), "files_only" (just the file paths), or "count" (matches per file).\n• target:"files" — find FILES by glob ("query" like "*.md" or "report"); newest first.\nResults are paths relative to your workspace (ready for fs.read). Use "limit"/"offset" to page; a truncation hint tells you the next offset.',
      schema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' },
        target: { type: 'string', enum: ['content', 'files'] },
        path: { type: 'string' }, file_glob: { type: 'string' },
        output_mode: { type: 'string', enum: ['content', 'files_only', 'count'] },
        context: { type: 'number' }, regex: { type: 'boolean' }, ignoreCase: { type: 'boolean' },
        limit: { type: 'number' }, offset: { type: 'number' }
      } },
      run: async (args, ctx) => {
        args = args || {};
        const q = String(args.query != null ? args.query : '');
        if (!q) throw new Error('"query" must be a non-empty string');
        const { base, abs } = await resolveInside((ctx && ctx.agentId) || 'agent', args.path || '.');
        const startPrefix = P.relative(base, abs).split(P.sep).join('/');     // '' when searching from the root
        const ic = !!args.ignoreCase;
        const limit = Math.max(1, Math.min(1000, Number(args.limit) || 50));
        const offset = Math.max(0, Number(args.offset) || 0);
        const target = ({ grep: 'content', find: 'files' })[args.target] || args.target || 'content';

        const all = [], stats = { files: 0, truncated: false };
        await collectFiles(abs, startPrefix, all, stats);

        // ---- target 'files': glob over names, newest first ----
        if (target === 'files') {
          const hasSlash = q.indexOf('/') >= 0;
          const re = globToRe((!hasSlash && q.charAt(0) !== '*') ? ('*' + q) : q, ic);   // bare name -> suffix match (rg --files -g *name)
          const hits = all.filter(f => re.test(hasSlash ? f.rel : f.rel.split('/').pop()));
          hits.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));   // newest first; path tiebreak = determinism
          const total = hits.length, page = hits.slice(offset, offset + limit);
          if (!page.length) return { content: '(no files matching ' + q + ')', summary: '0 files' };
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(f => f.rel).join('\n') + searchHint(truncated, offset, limit, total),
                   summary: total + ' file' + (total === 1 ? '' : 's') + ' matched' + (truncated ? ' (showing ' + page.length + ')' : '') };
        }

        // ---- target 'content': grep ----
        let matcher;
        if (args.regex) {
          let re; try { re = new RegExp(q, ic ? 'i' : ''); } catch (e) { throw new Error('invalid regex: ' + ((e && e.message) || e)); }
          matcher = (line) => re.test(line);
        } else if (ic) { const n = q.toLowerCase(); matcher = (line) => line.toLowerCase().indexOf(n) >= 0; }
        else { matcher = (line) => line.indexOf(q) >= 0; }

        let globRe = null;
        if (args.file_glob) { let fg = String(args.file_glob); if (fg.indexOf('/') < 0 && fg.charAt(0) !== '*') fg = '*' + fg; globRe = globToRe(fg, ic); }
        const candidates = all.filter(f => !globRe || globRe.test(f.rel.split('/').pop()))
          .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));   // path order = deterministic, rg-like grouping

        const fileHits = [];   // { rel, idxs:[lineIdx…], lines:[…] }
        let totalMatches = 0;
        for (const f of candidates) {
          let buf; try { buf = await fsp.readFile(f.abs); } catch (e) { continue; }
          if (buf.length > SEARCH_MAX_FILE_BYTES || buf.indexOf(0) >= 0) continue;   // skip oversized / binary
          const lines = buf.toString('utf8').split(/\r?\n/), idxs = [];
          for (let i = 0; i < lines.length; i++) if (matcher(lines[i])) idxs.push(i);
          if (idxs.length) { fileHits.push({ rel: f.rel, idxs, lines }); totalMatches += idxs.length; }
        }

        const omode = args.output_mode || 'content';
        if (omode === 'count') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')', summary: '0 matches' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel + ': ' + h.idxs.length).join('\n') + searchHint(truncated, offset, limit, total),
                   summary: totalMatches + ' match' + (totalMatches === 1 ? '' : 'es') + ' across ' + total + ' file(s)' };
        }
        if (omode === 'files_only') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')', summary: '0 files' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel).join('\n') + searchHint(truncated, offset, limit, total),
                   summary: total + ' file' + (total === 1 ? '' : 's') + ' with matches' };
        }

        // content (default): page on the flat match list (file-ordered), render with optional context
        const flat = [];
        for (let fi = 0; fi < fileHits.length; fi++) for (const idx of fileHits[fi].idxs) flat.push({ fi, idx });
        const total = flat.length;
        if (!total) return { content: '(no matches for ' + q + ')', summary: '0 matches in ' + stats.files + ' file(s) scanned' };
        const pageRefs = flat.slice(offset, offset + limit);
        const truncated = stats.truncated || total > offset + limit;
        const cx = Math.max(0, Math.min(10, Number(args.context) || 0));

        let body;
        if (pageRefs.length < SEARCH_DENSIFY_MIN && cx === 0) {
          // few matches, no context: flat "path:line: text" rows (path on each line is convenient when small)
          body = pageRefs.map(r => { const h = fileHits[r.fi]; return h.rel + ':' + (r.idx + 1) + ': ' + clipLine(h.lines[r.idx]); }).join('\n');
        } else {
          // densified: file path once, then "  <line>: match" / "  <line>- context" rows ('--' marks a gap)
          const lines = [];
          let gi = 0;
          while (gi < pageRefs.length) {
            const fi = pageRefs[gi].fi, h = fileHits[fi], here = [];
            while (gi < pageRefs.length && pageRefs[gi].fi === fi) { here.push(pageRefs[gi].idx); gi++; }
            const matchSet = new Set(here), show = new Set();
            for (const i of here) for (let k = Math.max(0, i - cx); k <= Math.min(h.lines.length - 1, i + cx); k++) show.add(k);
            const ordered = Array.from(show).sort((a, b) => a - b);
            lines.push(h.rel);
            let prev = -1;
            for (const k of ordered) {
              if (prev >= 0 && k > prev + 1) lines.push('  --');
              lines.push('  ' + (k + 1) + (matchSet.has(k) ? ': ' : '- ') + clipLine(h.lines[k]));
              prev = k;
            }
          }
          body = lines.join('\n');
        }
        return { content: body + searchHint(truncated, offset, limit, total),
                 summary: total + ' match' + (total === 1 ? '' : 'es') + ' in ' + fileHits.length + ' file(s)' + (truncated ? ' (showing ' + pageRefs.length + ')' : '') };
      }
    };

    // ── fs.patch (G5.2) — the V4A multi-hunk patch tool ──────────────────────────────────────
    // A NEW tool ALONGSIDE fs.edit (fs.edit's {path,find,replace} schema + "replace every
    // occurrence" semantics are load-bearing for existing callers/tests — NOT overloaded).
    // Applies a Hermes-style V4A patch (multi-op, multi-hunk) with three invariants:
    //   1. JAIL — every op's target path AND a MOVE's dst path goes through resolveInside BEFORE
    //      any I/O. A ../escape / absolute / drive-letter / NUL path is rejected before touching
    //      disk (reuses the ONE jail helper; never weakened).
    //   2. TWO-PHASE — PHASE-1 validates ALL ops/hunks in order against an in-memory SIMULATED
    //      buffer (reading current contents, applying each hunk via the fuzzy matcher) with NO
    //      writes; if any op fails to match, the whole patch aborts and NOTHING is written.
    //   3. BUFFER-THEN-FLUSH ATOMIC — PHASE-2 computes every final buffer, enforces WRITE_BYTES,
    //      and buffers ALL file results; only after EVERY step succeeds does it flush to disk. An
    //      error before the first write leaves every file byte-identical (all-or-nothing). The one
    //      honest caveat: a MULTI-FILE flush has no cross-file fsync transaction, so a crash
    //      mid-flush is a theoretical partial-write window (acceptable for a workspace jail;
    //      single-file patches are fully atomic). No git recovery (Hermes leans on git; we don't).
    function patchHunkBlocks(hunk) {
      // old block = context + removed lines (what must be present); new block = context + added.
      const oldLines = [], newLines = [];
      for (const ln of hunk.lines) {
        if (ln.prefix === ' ') { oldLines.push(ln.content); newLines.push(ln.content); }
        else if (ln.prefix === '-') { oldLines.push(ln.content); }
        else if (ln.prefix === '+') { newLines.push(ln.content); }
      }
      return { oldBlock: oldLines.join('\n'), newBlock: newLines.join('\n') };
    }
    // Apply ALL hunks of an UPDATE op to an in-memory buffer, in order. Pure (no I/O). Throws a
    // clear Error on the first hunk that can't be matched (caller turns this into a phase-1 abort).
    function applyHunks(filePath, buf, hunks) {
      let cur = buf;
      for (let h = 0; h < hunks.length; h++) {
        const { oldBlock, newBlock } = patchHunkBlocks(hunks[h]);
        if (oldBlock === '' && newBlock === '') continue;             // empty hunk — nothing to do
        if (oldBlock === '') {                                        // pure-insert hunk has no anchor
          throw new Error('hunk ' + (h + 1) + ' in ' + filePath + ' has no context/removed lines to anchor the edit');
        }
        const r = fuzzyFindAndReplace(cur, oldBlock, newBlock, false);
        if (r.error || r.count === 0) {
          throw new Error('hunk ' + (h + 1) + ' in ' + filePath + ' did not match: ' + (r.error || 'no match'));
        }
        cur = r.content;
      }
      return cur;
    }

    const patchTool = {
      name: 'fs.patch', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 15000,
      description: 'Apply a multi-hunk V4A patch across one or more workspace files in a single all-or-nothing operation. The patch is "*** Begin Patch" / "*** End Patch" wrapping "*** Update/Add/Delete/Move File:" sections; each Update hunk uses " " (context), "-" (remove), "+" (add) line prefixes. Every hunk is validated first — if ANY hunk fails to match, NOTHING is written and the files are left untouched. Use this for coordinated edits; use fs.edit for a single exact find/replace.',
      schema: { type: 'object', required: ['patch'], properties: { patch: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        if (typeof parseV4APatch !== 'function' || typeof fuzzyFindAndReplace !== 'function') throw new Error('fs.patch is unavailable (patch parser/matcher not loaded)');
        const patchText = String((args && args.patch) != null ? args.patch : '');

        // ── PARSE (pure; never throws) ──────────────────────────────────────────────────────
        const parsed = parseV4APatch(patchText);
        if (parsed.error) throw new Error(parsed.error);
        if (!parsed.ops.length) throw new Error('patch contains no file operations');

        // ── PHASE 1: JAIL + VALIDATE every op in order against an in-memory simulated buffer.
        // NO writes. resolveInside (the jail) runs FIRST for every path (and the MOVE dst), so an
        // escape is rejected before any disk read. Each planned result is buffered for phase 2.
        const flushPlan = [];   // [{ kind:'write'|'delete'|'move', abs, data?, fromAbs?, fromRel?, rel }]
        const touchedAbs = new Set();   // every absolute target a step writes/deletes/moves-out — fail
                                        // closed on a same-file collision (two ops on one path would
                                        // race to last-write-wins and silently drop the earlier edit).
        const claim = (abs, rel) => { if (touchedAbs.has(abs)) throw new Error('patch touches the same path twice: ' + rel + ' — combine the hunks into one op'); touchedAbs.add(abs); };
        for (const op of parsed.ops) {
          if (op.operation === 'add') {
            const { abs } = await resolveInside(aid, op.filePath);                      // JAIL
            claim(abs, op.filePath);
            const newBlock = patchHunkBlocks(op.hunks[0] || { lines: [] }).newBlock;
            const text = op.hunks.length ? newBlock : '';
            flushPlan.push({ kind: 'write', abs, rel: op.filePath, data: Buffer.from(text, 'utf8') });
          } else if (op.operation === 'delete') {
            const { abs } = await resolveInside(aid, op.filePath);                      // JAIL
            claim(abs, op.filePath);
            // confirm it exists so a no-op delete is a clear validation error (fail closed)
            try { await fsp.stat(abs); } catch (e) { throw new Error('cannot delete (no such file): ' + op.filePath); }
            flushPlan.push({ kind: 'delete', abs, rel: op.filePath });
          } else if (op.operation === 'move') {
            const { abs: fromAbs } = await resolveInside(aid, op.filePath);             // JAIL (src)
            const { abs: toAbs } = await resolveInside(aid, op.newPath);                // JAIL (dst) — BEFORE any I/O
            claim(fromAbs, op.filePath); claim(toAbs, op.newPath);
            let content;
            try { content = await fsp.readFile(fromAbs, 'utf8'); } catch (e) { throw new Error('cannot move (no such file): ' + op.filePath); }
            // a move may also carry hunks (rename + edit). Apply them to the moved content.
            if (op.hunks && op.hunks.length) content = applyHunks(op.filePath, content, op.hunks);
            flushPlan.push({ kind: 'move', abs: toAbs, rel: op.newPath, fromAbs, fromRel: op.filePath, data: Buffer.from(content, 'utf8') });
          } else { // update
            const { abs } = await resolveInside(aid, op.filePath);                      // JAIL
            claim(abs, op.filePath);
            let buf;
            try { buf = await fsp.readFile(abs, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + op.filePath); throw e; }
            const next = applyHunks(op.filePath, buf, op.hunks);                         // throws -> abort, nothing written
            flushPlan.push({ kind: 'write', abs, rel: op.filePath, data: Buffer.from(next, 'utf8') });
          }
        }

        // ── PHASE 2: enforce WRITE_BYTES on every buffered result, THEN flush. Any cap failure
        // aborts BEFORE the first write — the byte-cap check is a separate pass over the whole plan
        // so an oversize file later in the patch can't slip in after earlier files were written.
        for (const step of flushPlan) {
          if (step.data && step.data.length > WRITE_BYTES) throw new Error('file too large (' + step.rel + ': ' + step.data.length + ' > ' + WRITE_BYTES + ' bytes)');
        }
        // flush (buffered results only reach disk here). Single-file patches are fully atomic;
        // multi-file is the documented partial-write window (no cross-file transaction).
        let writes = 0, deletes = 0, moves = 0;
        for (const step of flushPlan) {
          if (step.kind === 'delete') { try { await fsp.unlink(step.abs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; } deletes++; }
          else if (step.kind === 'move') {
            await fsp.mkdir(P.dirname(step.abs), { recursive: true });
            await fsp.writeFile(step.abs, step.data);
            if (step.fromAbs !== step.abs) { try { await fsp.unlink(step.fromAbs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; } }
            emitDeliverable(ctx, aid, step.rel);
            moves++;
          } else { // write (update or add)
            await fsp.mkdir(P.dirname(step.abs), { recursive: true });
            await fsp.writeFile(step.abs, step.data);
            emitDeliverable(ctx, aid, step.rel);
            writes++;
          }
        }
        const parts = [];
        if (writes) parts.push(writes + ' file' + (writes === 1 ? '' : 's') + ' written');
        if (moves) parts.push(moves + ' moved');
        if (deletes) parts.push(deletes + ' deleted');
        const touched = flushPlan.map(s => s.rel).join(', ');
        return { content: 'Applied patch: ' + (parts.join(', ') || 'no changes') + ' (' + touched + ').', summary: 'patched ' + flushPlan.length + ' op(s)' };
      }
    };

    return {
      writeTool, readTool, listTool, appendTool, editTool, searchTool, patchTool,
      _internals: { resolveInside, workspaceRoot, safeAgentId, walk, collectFiles, globToRe, parsePatch: parseV4APatch, fuzzyFind: fuzzyFindAndReplace },
      register(reg) { [writeTool, readTool, listTool, appendTool, editTool, searchTool, patchTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeFsTools };
});
