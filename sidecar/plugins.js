/* sidecar/plugins.js — SCOPED PLUGINS: packaged, shareable JS that rides the hook spine.

   Shell hooks (sidecar/shellhooks.js) cover "run my script when X happens" and stop there — a hook cannot
   hold state between events, cannot ship as one installable unit, and pays a process spawn every single tool
   call. A plugin is the same idea packaged: a folder someone can publish, install, and enable, whose code
   lives in-process and can keep state across the events it subscribes to.

   SCOPED means SCOPED SURFACE, NOT SCOPED PRIVILEGE — and the difference is worth stating plainly rather than
   implied by a word. The only thing this loader HANDS a plugin is `on(event, handler)` against the hook spine:
   no registry, no station internals, no capability set, no provider keys. But it is ordinary in-process
   JavaScript, so nothing stops it requiring whatever Node exposes. Real isolation would need a worker or a VM
   boundary and a serialized bridge; this deliberately does not pretend to have one. What protects the station
   is the same thing that protects it from shell hooks: the code is INSTALLED BY the Commander, every plugin is
   inert until explicitly allowed, and the allowlist is keyed to the code's own hash so a silent edit re-asks.

   The reference harness loads its Python plugins BEFORE its shell hooks so plugin decisions win ties on a
   blocking event. That ordering is reproduced by the host (index.js loads plugins first), and it matters:
   the hook spine reports the FIRST block's reason, so load order decides who gets to explain a refusal.

   A plugin folder:
     <plugins>/<id>/plugin.json   { "name": "...", "version": "1.0.0", "description": "...", "main": "index.js" }
     <plugins>/<id>/index.js      module.exports = { register(api) { api.on('pre_tool_call', fn) } }

   makePluginLoader({ fsp, pathMod, dir, allowFile, requireModule, hash, guard?, clock?, onError })
     -> { discover, load, allow, listPending, _internals } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).plugins = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PLUGINS = 32;
  const MAX_SOURCE_BYTES = 2 << 20;    // a plugin we cannot even hash is a plugin we cannot gate

  const idOk = (s) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(s || ''));

  function makePluginLoader(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, dir = deps.dir;
    const requireModule = deps.requireModule;
    const hash = deps.hash;
    if (!fsp || !P || !dir || typeof requireModule !== 'function' || typeof hash !== 'function') {
      throw new Error('plugins requires { fsp, pathMod, dir, requireModule, hash }');
    }
    const guard = (deps.guard && typeof deps.guard.scanText === 'function') ? deps.guard : null;
    const onError = (typeof deps.onError === 'function') ? deps.onError : (() => {});
    const allowFile = deps.allowFile;

    const readJson = async (f, fb) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { return fb; } };

    /* discover() -> { plugins, errors }
       A plugin is identified by its folder; a broken one is REPORTED and skipped rather than aborting the
       scan, because one bad plugin must not disable the others. */
    async function discover() {
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (_) { return { plugins: [], errors: [] }; }     // no plugins dir is the ordinary case, not an error
      const plugins = [], errors = [];
      const dirs = entries.filter(e => e && typeof e.isDirectory === 'function' && e.isDirectory()).slice(0, MAX_PLUGINS);
      for (const e of dirs) {
        const id = e.name;
        if (!idOk(id)) { errors.push('skipped plugin folder with an unusable name: ' + id); continue; }
        const base = P.join(dir, id);
        const manifest = await readJson(P.join(base, 'plugin.json'), null);
        if (!manifest) { errors.push(id + ': no readable plugin.json'); continue; }
        const main = String(manifest.main || 'index.js');
        if (main.indexOf('..') >= 0 || P.isAbsolute(main)) { errors.push(id + ': `main` must be a path inside the plugin folder'); continue; }
        const mainPath = P.join(base, main);
        let source = '';
        try { source = await fsp.readFile(mainPath, 'utf8'); }
        catch (_) { errors.push(id + ': cannot read ' + main); continue; }
        if (source.length > MAX_SOURCE_BYTES) { errors.push(id + ': ' + main + ' is too large to gate safely'); continue; }
        // The DIGEST IS OF THE CODE, not of the folder name or the manifest: approval must not survive an
        // edit to the thing that actually runs. Changing one character re-asks, exactly like a shell hook.
        const digest = hash(source);
        const findings = guard ? (guard.scanText(main, source) || null) : null;
        plugins.push({
          id, dir: base, main: mainPath, digest,
          name: String(manifest.name || id),
          version: String(manifest.version || '0'),
          description: String(manifest.description || ''),
          findings
        });
      }
      if (entries.length > MAX_PLUGINS) errors.push('only the first ' + MAX_PLUGINS + ' plugin folders are considered');
      return { plugins, errors };
    }

    const allowedMap = async () => (await readJson(allowFile, {})) || {};
    async function allow(id, digest) {
      const cur = await allowedMap();
      cur[String(id)] = { digest: String(digest), allowedAt: deps.clock ? deps.clock.now() : 0 };
      try { await fsp.writeFile(allowFile, JSON.stringify(cur, null, 2), 'utf8'); return true; }
      catch (e) { onError({ plugin: id, error: (e && e.message) || String(e) }); return false; }
    }
    // UN-APPROVE — the other half of the gate. Dropping the entry is enough: load() only registers a plugin
    // whose digest is in the allowlist, so a revoke plus a re-load leaves it installed but inert.
    async function revoke(id) {
      const cur = await allowedMap();
      if (!(String(id) in cur)) return false;
      delete cur[String(id)];
      try { await fsp.writeFile(allowFile, JSON.stringify(cur, null, 2), 'utf8'); return true; }
      catch (e) { onError({ plugin: id, error: (e && e.message) || String(e) }); return false; }
    }
    async function listPending() {
      const [{ plugins }, allowed] = [await discover(), await allowedMap()];
      return plugins.filter(p => !(allowed[p.id] && allowed[p.id].digest === p.digest));
    }

    /* load(hookSpine, { accept }) -> { loaded, pending, errors }
       The plugin's `register(api)` is called with a surface that is ONLY the hook spine. Anything it throws
       during registration costs that plugin and nothing else — a station must still boot with a broken
       plugin installed, or one bad third-party folder becomes an un-startable app. */
    async function load(hookSpine, opts) {
      opts = opts || {};
      const { plugins, errors } = await discover();
      const allowed = await allowedMap();
      const loaded = [], pending = [];
      for (const p of plugins) {
        const ok = allowed[p.id] && allowed[p.id].digest === p.digest;
        if (!ok) {
          if (!opts.accept) { pending.push(p); continue; }
          await allow(p.id, p.digest);
        }
        let mod;
        try { mod = requireModule(p.main); }
        catch (e) { errors.push(p.id + ': failed to load — ' + ((e && e.message) || e)); continue; }
        const register = mod && (typeof mod.register === 'function' ? mod.register : (typeof mod === 'function' ? mod : null));
        if (!register) { errors.push(p.id + ': exports no register(api) function'); continue; }
        let subscribed = 0;
        // THE ENTIRE SURFACE. `on` is a thin wrapper so a plugin cannot reach the spine object itself and
        // clear() everyone else's handlers, and so every handler is attributed to its plugin by name in
        // telemetry and in a block reason.
        const api = {
          name: p.name,
          version: p.version,
          on(event, fn, meta) {
            const off = hookSpine.register(event, fn, { name: p.id, timeoutMs: meta && meta.timeoutMs });
            subscribed++;
            return off;
          }
        };
        try { register(api); }
        catch (e) { errors.push(p.id + ': register() threw — ' + ((e && e.message) || e)); continue; }
        loaded.push(Object.assign({}, p, { subscribed }));
      }
      return { loaded, pending, errors };
    }

    return { discover, load, allow, revoke, listPending, _internals: { idOk } };
  }

  return { makePluginLoader, _internals: { idOk } };
});
