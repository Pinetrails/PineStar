/* node test/class-loadouts.test.js — Class Loadouts S1 (the spine).

   A class = model tier + reasoning effort + skill package + standard-issue KIT, applied at summon and honored
   backend-side. Two halves, matching kitout.test.js's discipline:
     1. GROUNDED-CATALOG unit tests (real assertions on pure modules): the shared catalog is well-formed and
        HONEST — every kit objectType is a real CAP_REGISTRY key, every skill slug is a real bundled recipe, and
        every skill's `requires` is satisfied by its class's kit (Law 4: grounded classes only).
     2. UNIT tests for the wiring the backend depends on: catalog.compose(agentSkills) is an ADD-only union that
        respects the budget with the package first; the sidecar roster passes skills/effort through.
     3. SOURCE-LEVEL invariants for the browser-only summon path (app.js / build.js are IIFEs over live DOM, so —
        like kitout.test.js — we lock the honesty-critical wiring by reading the source). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const shared = require('../shared/specialties.js');
const S = require('../frontend/app/specialties.js');
const catalog = require('../sidecar/skills/catalog.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

/* ---------- 1. GROUNDED CATALOG: kit + skills are REAL and honestly backed ---------- */
const CAP_TYPES = new Set(Object.keys(CAP_REGISTRY));
// the real bundled skill library (same loader the sidecar uses)
const LIB = catalog.loadDir(path.join(__dirname, '../sidecar/skills/library'), fs, path);
const SLUGS = new Map(LIB.map(s => [s.slug, s]));
A.ok(LIB.length >= 5, 'the bundled skill library loaded (' + LIB.length + ' recipes)');

const builtins = S.builtins();
A.ok(builtins.length >= 11, 'the class catalog ships every class (>= 11), got ' + builtins.length);

for (const b of builtins) {
  // every class has a loadout, and the loadout fields have the right shapes
  A.ok(Array.isArray(b.kit), b.id + ' has a kit array');
  A.ok(Array.isArray(b.skills), b.id + ' has a skills array');
  A.ok(b.reasoningEffort === null || ['high', 'medium', 'low'].indexOf(b.reasoningEffort) >= 0, b.id + ' effort is a known level or null: ' + b.reasoningEffort);
  A.throws(() => { b.kit.push('x'); }, b.id + ' kit is frozen (catalog immutable)');

  // Law 1/4: every kit objectType is a REAL CAP_REGISTRY key (never an invented prop)
  for (const t of b.kit) A.ok(CAP_TYPES.has(t), b.id + ' kit objectType is a real CAP_REGISTRY type: ' + t);

  // every skill slug is a REAL bundled recipe, and its requires ⊆ this class's kit (grounded — a class can
  // actually run the skill it ships). computer/connector are compute/dynamic, not skill requirements, so a
  // skill never requires them; every requires entry must be present in the kit.
  const kitSet = new Set(b.kit);
  for (const slug of b.skills) {
    const skill = SLUGS.get(slug);
    A.ok(!!skill, b.id + ' skill slug is a real library recipe: ' + slug);
    if (skill) for (const req of (skill.requires || [])) {
      A.ok(kitSet.has(req), b.id + ' skill "' + slug + '" requires "' + req + '" which its kit provides');
    }
  }
}

/* ---------- 2a. compose(agentSkills): ADD-only union, budget-ordered ---------- */
// a tiny synthetic library so the assertions don't depend on the real recipes' bodies/requires.
const SK = [
  { slug: 'globalon', name: 'GlobalOn', description: '', category: 'A', requires: [], default: true, body: 'G' },
  { slug: 'pkg', name: 'Pkg', description: '', category: 'A', requires: ['cabinet'], default: false, body: 'P' },
  { slug: 'gated', name: 'Gated', description: '', category: 'A', requires: ['workbench'], default: false, body: 'X' },
  { slug: 'off', name: 'Off', description: '', category: 'A', requires: [], default: false, body: 'O' }
];
// baseline: only the default-on skill composes
A.ok(catalog.compose(SK, { placedTypes: ['cabinet', 'workbench'] }).indexOf('GlobalOn') >= 0, 'a default-on skill composes');
A.eq(catalog.compose(SK, { placedTypes: ['cabinet', 'workbench'] }).indexOf('Pkg'), -1, 'a default-off skill does NOT compose without a package/override');

// per-agent package ENABLES pkg (ADD-only) — available because cabinet is placed
const withPkg = catalog.compose(SK, { placedTypes: ['cabinet', 'workbench'], agentSkills: ['pkg'] });
A.ok(withPkg.indexOf('Pkg') >= 0, 'agentSkills enables a package skill for THIS agent');
A.ok(withPkg.indexOf('GlobalOn') >= 0, 'agentSkills is ADD-only — the globally-on skill is still present');

// ADD-only: a per-agent enable can NEVER disable a globally-enabled skill (there is no agent-side "off")
const cantDisable = catalog.compose(SK, { placedTypes: ['cabinet'], overrides: { globalon: true }, agentSkills: ['off'] });
A.ok(cantDisable.indexOf('GlobalOn') >= 0, 'a per-agent package cannot disable a globally-enabled skill');

// still availability-gated: pkg requires cabinet — absent, the package can't force it in
A.eq(catalog.compose(SK, { placedTypes: [], agentSkills: ['pkg'] }).indexOf('Pkg'), -1, 'agentSkills is still gated by placedTypes (object=capability)');

// budget ordering: under a tight budget, the class PACKAGE composes before a global extra
const bigLib = [
  { slug: 'g1', name: 'G1', description: '', category: 'A', requires: [], default: true, body: 'x'.repeat(200) },
  { slug: 'p1', name: 'P1', description: '', category: 'A', requires: [], default: false, body: 'y'.repeat(200) }
];
const tight = catalog.compose(bigLib, { placedTypes: [], agentSkills: ['p1'], budget: 260 });
A.ok(tight.indexOf('P1') >= 0, 'under a tight budget the agent package composes first (P1 kept)');
A.eq(tight.indexOf('G1'), -1, 'the global extra (G1) is the one truncated, not the class package');

/* ---------- 2b. sidecar roster passthrough (source-level: additive fields carried + persisted) ---------- */
const idx = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const repl = idx.slice(idx.indexOf('function replaceAgentRoster('), idx.indexOf('function loadAgentRoster('));
A.ok(/skills:\s*Array\.isArray\(a && a\.skills\)/.test(repl), 'replaceAgentRoster passes through per-agent skills[]');
A.ok(/reasoningEffort:\s*\(a && a\.reasoningEffort\)/.test(repl), 'replaceAgentRoster passes through reasoningEffort');
const save = idx.slice(idx.indexOf('function saveAgentRoster('), idx.indexOf('function saveAgentRoster(') + 600);
A.ok(/skills:\s*Array\.isArray\(a\.skills\)/.test(save), 'saveAgentRoster persists skills (old rosters without it still load)');
// injection site passes the roster record's skills as agentSkills; effort precedence adds the roster fallback
A.ok(/agentSkills:\s*agentSkills/.test(idx), 'the skill-injection site passes the running agent\'s package as agentSkills');
A.ok(/rosterIdent && rosterIdent\.reasoningEffort/.test(idx), 'reasoning-effort precedence falls back to the roster record');

/* ---------- 3. SOURCE-LEVEL: the browser summon path applies the loadout honestly ---------- */
const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const build = fs.readFileSync(path.join(__dirname, '../frontend/app/build.js'), 'utf8');

// summonAgent applies the loadout onto the record + requisitions the kit
A.ok(/applyLoadout\(a, spec\)/.test(app), 'summon applies the class loadout (applyLoadout)');
A.ok(/requisitionKit\(a, spec\)/.test(app), 'summon requisitions the class kit');
// applyLoadout resolves the tier via the seam, sets effort + per-agent skills
const loadoutSeg = app.slice(app.indexOf('function applyLoadout('), app.indexOf('function requisitionKit('));
A.ok(/resolveTierModel\(/.test(loadoutSeg), 'applyLoadout resolves the model tier through the seam');
A.ok(/a\.reasoningEffort\s*=\s*spec\.reasoningEffort/.test(loadoutSeg), 'applyLoadout sets the applied reasoning effort');
A.ok(/a\.skills\s*=\s*out/.test(loadoutSeg), 'applyLoadout records the per-agent skill package');

// requisitionKit degrades gracefully (collects skipped, never throws) and goes through Build.requisitionForAgent
const kitSeg = app.slice(app.indexOf('function requisitionKit('), app.indexOf('function requisitionKit(') + 1400);
A.ok(/Build\.requisitionForAgent/.test(kitSeg), 'the kit is placed via Build.requisitionForAgent (the real path)');
A.ok(/skipped\.push/.test(kitSeg), 'requisitionKit collects what did not fit (graceful degrade, no crash)');
A.ok(/try\s*\{[\s\S]*?catch/.test(kitSeg), 'requisitionKit wraps each placement so one failure never breaks summon');

// pushRoster + serialize carry the additive fields to the backend + to disk
A.ok(/skills:\s*Array\.isArray\(a\.skills\)\s*\?\s*a\.skills\s*:\s*\[\][\s\S]{0,80}reasoningEffort:\s*a\.reasoningEffort/.test(app),
  'pushRoster sends per-agent skills + reasoningEffort to /api/roster');

// build.requisitionForAgent is the REAL validated placement path, room-scoped, idempotent, non-throwing
A.ok(/function requisitionForAgent\(/.test(build), 'Build.requisitionForAgent exists');
const rfa = build.slice(build.indexOf('function requisitionForAgent('), build.indexOf('const api = {', build.indexOf('function requisitionForAgent(')));
A.ok(/findPlaceableTileInRoom\(/.test(rfa), 'requisitionForAgent places at a VALIDATED tile scoped to the agent room');
A.ok(/st\.addProp\(/.test(rfa), 'requisitionForAgent goes through the real station.addProp (object=capability stays honest)');
A.ok(/no-room/.test(rfa), 'requisitionForAgent degrades honestly when the agent has no workstation yet');
A.ok(/already/.test(rfa), 'requisitionForAgent is idempotent — it never stacks a cap already in the room');
A.ok(/requisitionForAgent\s*[},]/.test(build.slice(build.indexOf('const api = {'))), 'requisitionForAgent is exported on the Build api');

// the room-scoped tile finder respects the room boundary (roomAt match)
A.ok(/function findPlaceableTileInRoom\([\s\S]*?roomAt\(tx, ty\) === room\.id/.test(build), 'findPlaceableTileInRoom stays inside the agent room');

/* ---------- team.summon class list is composed from the shared catalog (no hardcoded prose) ---------- */
const orch = fs.readFileSync(path.join(__dirname, '../sidecar/tools/builtin/orchestration.js'), 'utf8');
A.ok(/deps\.classes[\s\S]{0,120}\.map\(c => c && c\.id\)/.test(orch), 'team.summon SPEC_IDS is composed from the injected shared catalog');
A.ok(/SPECIALIST_CLASSES\s*=\s*\(sharedSpecialties\.BUILTINS/.test(idx), 'the sidecar composes the class list from the shared catalog');
A.ok(/classes:\s*SPECIALIST_CLASSES/.test(idx), 'the shared class list is injected into the orchestration tools');

A.report('class-loadouts');
