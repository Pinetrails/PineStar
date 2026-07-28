/* sidecar/skills/package.js - filesystem-backed runtime skill packages.

   StarNet's append-only JSONL skill log remains the durable event stream.
   This module mirrors the latest skill state into inspectable package dirs:

     <root>/<agentId>/<skillId>/SKILL.md
     <root>/<agentId>/<skillId>/references|templates|scripts|assets/...

   It is dependency-injected for tests and sidecar containment.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillPackage = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUPPORT_DIRS = ['references', 'templates', 'scripts', 'assets'];
  function str(v) { return v == null ? '' : String(v); }
  function escYaml(v) { return JSON.stringify(str(v)); }
  function arr(v) { return Array.isArray(v) ? v.map(x => str(x)).filter(Boolean) : []; }
  function safeSegment(v) {
    return str(v).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
  }
  function supportPath(raw) {
    let p = str(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
    if (!p || /^[A-Za-z]:/.test(p) || p.indexOf('..') >= 0 || /[\x00-\x1F]/.test(p)) return null;
    const root = p.split('/')[0];
    if (SUPPORT_DIRS.indexOf(root) < 0 || p === root) return null;
    return p;
  }
  function frontmatter(skill) {
    const lines = [
      '---',
      'name: ' + escYaml(skill.name || skill.id || 'Skill'),
      'description: ' + escYaml(skill.description || skill.summary || ''),
      'category: ' + escYaml(skill.category || 'General'),
      'state: ' + escYaml(skill.state || 'active'),
      'created_by: ' + escYaml(skill.createdBy || 'agent'),
      'source_run_id: ' + escYaml(skill.sourceRunId || ''),
      'pinned: ' + (!!skill.pinned ? 'true' : 'false')
    ];
    // Consolidation lineage: an archived package says which live skill absorbed it, so the merge is
    // readable on disk and not just in the JSONL log.
    if (skill.absorbedInto) lines.push('absorbed_into: ' + escYaml(skill.absorbedInto));
    const platforms = arr(skill.platforms);
    const requires = arr(skill.requires);
    if (platforms.length) lines.push('platforms: [' + platforms.map(escYaml).join(', ') + ']');
    if (requires.length) lines.push('requires: [' + requires.map(escYaml).join(', ') + ']');
    lines.push('---');
    return lines.join('\n');
  }
  function renderSkillMd(skill) {
    const setup = str(skill.setup).trim();
    const body = str(skill.body).trim();
    const files = Array.isArray(skill.files) ? skill.files : [];
    const pointers = files.length
      ? '\n\n## Support Files\n' + files.map(f => '- `' + str(f.path) + '`').join('\n')
      : '';
    return frontmatter(skill) + '\n\n' + (setup ? '## Setup\n' + setup + '\n\n' : '') + body + pointers + '\n';
  }
  function parseFrontmatter(text) {
    const t = str(text);
    const m = t.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: t };
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!mm) continue;
      let v = mm[2].trim();
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (v[0] === '[' && v[v.length - 1] === ']') v = v.slice(1, -1).split(',').map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
      else v = v.replace(/^"|"$/g, '');
      meta[mm[1]] = v;
    }
    return { meta, body: m[2].trim() };
  }

  function makePackageStore(opts) {
    opts = opts || {};
    const fs = opts.fs;
    const path = opts.pathMod;
    const root = opts.root;
    if (!fs || !path || !root) {
      return { writePackage() {}, hydrate(skill) { return skill; }, packageDir() { return ''; }, renderSkillMd, parseFrontmatter };
    }
    function packageDir(skill) {
      return path.join(root, safeSegment(skill.agentId || 'agent'), safeSegment(skill.id || skill.name || 'skill'));
    }
    function archiveDir(skill) {
      return path.join(root, '.archive', safeSegment(skill.agentId || 'agent'), safeSegment(skill.id || skill.name || 'skill'));
    }
    function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
    /* PATH REDIRECT GUARD. supportPath() already refuses `..`, absolute paths, drive letters and
       control bytes, so the STRING can't escape — but a SYMLINK can: if `skill-packages/agent/x`
       or a `references` dir inside it is a link, a "contained" relative write lands wherever the
       link points. String validation cannot see that; only resolving can. Resolve the deepest
       existing ancestor, re-attach the rest, and require the result to sit under the real root. */
    function realOf(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
    function insideRoot(target) {
      const rootReal = realOf(root) || path.resolve(root);
      let probe = path.resolve(target);
      const rest = [];
      for (;;) {
        const real = realOf(probe);
        if (real) {
          const full = rest.length ? path.join(real, rest.join(path.sep)) : real;
          const rel = path.relative(rootReal, full);
          return !!rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
        }
        const parent = path.dirname(probe);
        if (parent === probe) return false;    // walked past the filesystem root without finding anything real
        rest.unshift(path.basename(probe));
        probe = parent;
      }
    }
    function writeText(file, text) {
      // Check BEFORE mkdir: creating the directory chain first would materialize the escape path.
      if (!insideRoot(file)) throw new Error('skill package path escapes the package root: ' + file);
      ensureDir(path.dirname(file));
      if (!insideRoot(file)) throw new Error('skill package path escapes the package root: ' + file);
      fs.writeFileSync(file, text, 'utf8');
    }
    function projectedFiles(skill) {
      const files = Array.isArray(skill.files) ? skill.files : [];
      return files.map(f => ({ path: supportPath(f.path), content: str(f.content), updatedAt: f.updatedAt || 0 })).filter(f => f.path);
    }
    function writePackage(skill) {
      ensureDir(root);   // so insideRoot() can realpath the root itself — a root that does not exist yet would otherwise compare an unresolved path against resolved ones (fail-closed on any symlinked save dir)
      const dir = skill.state === 'archived' ? archiveDir(skill) : packageDir(skill);
      const visible = packageDir(skill);
      if (skill.state === 'archived' && visible !== dir) {
        try { if (fs.existsSync(visible)) fs.rmSync(visible, { recursive: true, force: true }); } catch (_) {}
      }
      ensureDir(dir);
      const s = Object.assign({}, skill, { files: projectedFiles(skill) });
      writeText(path.join(dir, 'SKILL.md'), renderSkillMd(s));
      for (const f of s.files) writeText(path.join(dir, f.path), f.content);
      return dir;
    }
    function readSupportFiles(dir) {
      const out = [];
      for (const sd of SUPPORT_DIRS) {
        const base = path.join(dir, sd);
        if (!fs.existsSync(base)) continue;
        const stack = [base];
        while (stack.length) {
          const cur = stack.pop();
          let entries = [];
          try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
          for (const ent of entries) {
            const full = path.join(cur, ent.name);
            // A symlink inside the package is skipped, never followed: hydrate() feeds these bytes
            // straight into skill.view, so following a link would let anything on disk be read out
            // as this skill's "support file".
            if (ent.isSymbolicLink()) continue;
            if (ent.isDirectory()) stack.push(full);
            else if (ent.isFile()) {
              const rel = path.relative(dir, full).replace(/\\/g, '/');
              const p = supportPath(rel);
              if (!p) continue;
              let content = '';
              try { content = fs.readFileSync(full, 'utf8'); } catch (_) {}
              out.push({ path: p, content, updatedAt: 0, bytes: content.length });
            }
          }
        }
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    }
    function hydrate(skill) {
      if (!skill) return skill;
      const dir = skill.state === 'archived' ? archiveDir(skill) : packageDir(skill);
      const md = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(md)) return skill;
      if (!insideRoot(md)) return skill;   // same law as the write side: a redirected package is not this skill's package
      let parsed = null;
      try { parsed = parseFrontmatter(fs.readFileSync(md, 'utf8')); } catch (_) {}
      const files = readSupportFiles(dir);
      const out = Object.assign({}, skill);
      if (parsed) {
        out.description = parsed.meta.description || out.description || out.summary || '';
        out.platforms = Array.isArray(parsed.meta.platforms) ? parsed.meta.platforms : (out.platforms || []);
        out.body = parsed.body || out.body || '';
      }
      out.files = files.length ? files : (out.files || []);
      out.packagePath = dir;
      return out;
    }
    return { writePackage, hydrate, packageDir, archiveDir, renderSkillMd, parseFrontmatter, supportPath };
  }

  return { makePackageStore, renderSkillMd, parseFrontmatter, supportPath, safeSegment, SUPPORT_DIRS };
});
